import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import {
  classifyDbSchemaError,
  validateScheduleAgainstFacility,
} from '../_shared/facilitySchedule.ts';
import { calculateEdgePricingQuote, type EdgePricingRuleRow } from '../_shared/pricing.ts';
import { enforceDistributedRateLimit } from '../_shared/rateLimit.ts';
import { errorResponse, jsonResponse } from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  getServiceSupabaseClient,
} from '../_shared/supabase.ts';
import { PricingQuoteBodySchema } from '../_shared/validation.ts';

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
      'Supabase database credentials are not configured on the Edge Function runtime.',
      corsHeaders,
    );
  }

  const rate = await enforceDistributedRateLimit(admin, req, 'pricing-quote', {
    windowSeconds: 60,
    maxRequests: 60,
  });
  const headersWithRate = {
    ...corsHeaders,
    'X-RateLimit-Remaining': String(rate.remaining),
  };
  if (!rate.allowed) {
    return errorResponse(
      429,
      'RATE_LIMIT_EXCEEDED',
      'Too many pricing quote requests. Please wait briefly before retrying.',
      { ...headersWithRate, 'Retry-After': String(rate.retryAfterSeconds) },
    );
  }

  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = PricingQuoteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid pricing quote payload.',
        headersWithRate,
      );
    }

    const scheduleCheck = await validateScheduleAgainstFacility(
      admin,
      parsed.data.date,
      parsed.data.startTime,
      parsed.data.durationMinutes,
    );
    if (!scheduleCheck.ok) {
      return errorResponse(
        scheduleCheck.statusCode,
        scheduleCheck.code,
        scheduleCheck.error,
        headersWithRate,
      );
    }

    const { data: court, error: courtErr } = await admin
      .from('courts')
      .select('id, court_number, base_hourly_rate_centavos')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .eq('court_number', parsed.data.courtNumber)
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
        `Court ${parsed.data.courtNumber} was not found.`,
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
      dateStr: parsed.data.date,
      startTime: parsed.data.startTime,
      durationMinutes: parsed.data.durationMinutes,
      rules: (rulesData ?? []) as EdgePricingRuleRow[],
      depositEnabled: scheduleCheck.settings.deposit_enabled,
      depositPercent: scheduleCheck.settings.deposit_percent,
    });

    return jsonResponse(
      200,
      {
        ...quote,
        source: 'supabase_live',
      },
      headersWithRate,
    );
  } catch {
    return errorResponse(
      500,
      'PRICING_INTERNAL_ERROR',
      'Unexpected error while computing court pricing.',
      headersWithRate,
    );
  }
});
