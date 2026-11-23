import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import {
  classifyDbSchemaError,
  validateScheduleAgainstFacility,
} from '../_shared/facilitySchedule.ts';
import { calculateEdgePricingQuote, type EdgePricingRuleRow } from '../_shared/pricing.ts';
import { enforceDistributedRateLimit } from '../_shared/rateLimit.ts';
import {
  errorResponse,
  generateOpaqueToken,
  hashSecretToken,
  jsonResponse,
} from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  getServiceSupabaseClient,
} from '../_shared/supabase.ts';
import { CreateGuestHoldSchema } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'POST, OPTIONS',
  );
  if (preflightOrErrorResponse) {
    return preflightOrErrorResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported.', corsHeaders);
  }

  const admin = getServiceSupabaseClient();
  if (!admin) {
    return errorResponse(
      503,
      'SUPABASE_NOT_CONFIGURED',
      'Live Supabase database credentials are not configured on the Edge Function runtime.',
      corsHeaders,
    );
  }

  const rate = await enforceDistributedRateLimit(admin, req, 'guest-holds', {
    windowSeconds: 60,
    maxRequests: 25,
  });
  const headersWithRate = {
    ...corsHeaders,
    'X-RateLimit-Remaining': String(rate.remaining),
  };
  if (!rate.allowed) {
    return errorResponse(
      429,
      'RATE_LIMIT_EXCEEDED',
      'Too many reservation attempts. Please wait briefly before retrying.',
      { ...headersWithRate, 'Retry-After': String(rate.retryAfterSeconds) },
    );
  }

  try {
    const rawBody = await req.json().catch(() => null);

    // Stage 4 Payment Guard: explicitly refuse any client request trying to confirm payment
    if (
      rawBody &&
      typeof rawBody === 'object' &&
      ('confirmPayment' in rawBody ||
        (rawBody as Record<string, unknown>).status === 'confirmed')
    ) {
      return errorResponse(
        403,
        'PAYMENT_VERIFICATION_REQUIRED',
        'Bookings cannot be confirmed without verified Stage 5 payment gateway evidence.',
        headersWithRate,
      );
    }

    const parsed = CreateGuestHoldSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid booking details.',
        headersWithRate,
      );
    }

    const input = parsed.data;
    const scheduleCheck = await validateScheduleAgainstFacility(
      admin,
      input.date,
      input.startTime,
      input.durationMinutes,
    );
    if (!scheduleCheck.ok) {
      return errorResponse(
        scheduleCheck.statusCode,
        scheduleCheck.code,
        scheduleCheck.error,
        headersWithRate,
      );
    }

    if (!scheduleCheck.settings.allow_guest_checkout) {
      return errorResponse(
        403,
        'GUEST_CHECKOUT_DISABLED',
        'Guest checkout is currently disabled by facility administration.',
        headersWithRate,
      );
    }

    const { data: court, error: courtErr } = await admin
      .from('courts')
      .select('id, court_number, base_hourly_rate_centavos')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .eq('court_number', input.courtNumber)
      .maybeSingle<{ id: string; court_number: number; base_hourly_rate_centavos: number }>();

    if (courtErr) {
      if (classifyDbSchemaError(courtErr)) {
        return errorResponse(
          500,
          'DATABASE_SCHEMA_ERROR',
          'Required Pick My Ball courts table is missing. Run migrations 0001–0004.',
          headersWithRate,
        );
      }
      return errorResponse(502, 'COURT_QUERY_ERROR', 'Unable to query court details from Supabase.', headersWithRate);
    }

    if (!court) {
      return errorResponse(
        404,
        'COURT_NOT_FOUND',
        `Court ${input.courtNumber} was not found.`,
        headersWithRate,
      );
    }

    const { data: rulesData, error: rulesErr } = await admin
      .from('pricing_rules')
      .select('*')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .eq('is_active', true);

    if (rulesErr) {
      if (classifyDbSchemaError(rulesErr)) {
        return errorResponse(
          500,
          'DATABASE_SCHEMA_ERROR',
          'Required Pick My Ball pricing_rules table is missing. Run migrations 0001–0004.',
          headersWithRate,
        );
      }
      return errorResponse(502, 'PRICING_QUERY_ERROR', 'Unable to load server pricing rules.', headersWithRate);
    }

    const quote = calculateEdgePricingQuote({
      courtNumber: court.court_number,
      courtId: court.id,
      baseHourlyRateCentavos: court.base_hourly_rate_centavos,
      dateStr: input.date,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      rules: (rulesData ?? []) as EdgePricingRuleRow[],
      depositEnabled: scheduleCheck.settings.deposit_enabled,
      depositPercent: scheduleCheck.settings.deposit_percent,
    });

    const ownershipToken = generateOpaqueToken(24);
    const lookupToken = generateOpaqueToken(24);
    const sessionKey = input.sessionKey ?? generateOpaqueToken(12);
    const [ownershipTokenHash, lookupTokenHash] = await Promise.all([
      hashSecretToken(ownershipToken),
      hashSecretToken(lookupToken),
    ]);

    const { data, error } = await admin.rpc('acquire_court_hold_and_pending_booking', {
      p_facility_id: DEFAULT_FACILITY_ID,
      p_court_number: input.courtNumber,
      p_start_at: scheduleCheck.startAtIso,
      p_end_at: scheduleCheck.endAtIso,
      p_customer_name: input.customerName,
      p_customer_mobile: input.customerMobile,
      p_customer_email: input.customerEmail,
      p_special_requests: input.specialRequests ?? null,
      p_session_key: sessionKey,
      p_hourly_rate_centavos: quote.effectiveHourlyRateCentavos,
      p_total_centavos: quote.totalAmountCentavos,
      p_pricing_snapshot: quote,
      p_ownership_token_hash: ownershipTokenHash,
      p_lookup_token_hash: lookupTokenHash,
    });

    if (error) {
      const msg = error.message || '';
      if (
        msg.includes('BOOKING_CONFLICT') ||
        msg.includes('HOLD_CONFLICT') ||
        msg.includes('excl_reservations_no_overlap')
      ) {
        return errorResponse(
          409,
          'HOLD_CONFLICT',
          `Court ${input.courtNumber} was just reserved or held by another player for ${input.startTime}–${scheduleCheck.endTime}. Please pick another court or time slot.`,
          headersWithRate,
        );
      }
      if (msg.includes('COURT_MAINTENANCE') || msg.includes('COURT_UNAVAILABLE')) {
        return errorResponse(
          409,
          'COURT_UNAVAILABLE',
          `Court ${input.courtNumber} is currently closed or under maintenance.`,
          headersWithRate,
        );
      }
      return errorResponse(
        500,
        'HOLD_ACQUISITION_FAILED',
        'Unable to acquire temporary reservation hold.',
        headersWithRate,
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return errorResponse(
        500,
        'HOLD_ACQUISITION_FAILED',
        'Database did not return hold confirmation.',
        headersWithRate,
      );
    }

    return jsonResponse(
      201,
      {
        holdId: row.hold_id,
        reservationId: row.reservation_id,
        bookingReference: row.booking_reference,
        status: 'pending_payment',
        expiresAt: row.expires_at,
        ownershipToken,
        lookupToken,
        pricing: { ...quote, source: 'supabase_live' },
        date: input.date,
        startTime: input.startTime,
        endTime: scheduleCheck.endTime,
        courtNumber: input.courtNumber,
      },
      headersWithRate,
    );
  } catch {
    return errorResponse(
      500,
      'HOLD_INTERNAL_ERROR',
      'Unexpected error while creating reservation hold.',
      headersWithRate,
    );
  }
});
