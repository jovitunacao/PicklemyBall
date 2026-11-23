import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { validateScheduleAgainstFacility } from '../_shared/facilitySchedule.ts';
import {
  addDaysToManilaDate,
  isValidDateString,
  manilaDateTimeToUtcIso,
} from '../_shared/manilaTime.ts';
import { calculateEdgePricingQuote, type EdgePricingRuleRow } from '../_shared/pricing.ts';
import {
  errorResponse,
  generateOpaqueToken,
  hashSecretToken,
  jsonResponse,
} from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  verifyStaffJwt,
} from '../_shared/supabase.ts';
import {
  AdminCancelReservationSchema,
  CreateGuestHoldSchema,
} from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'GET, POST, OPTIONS',
  );
  if (preflightOrErrorResponse) {
    return preflightOrErrorResponse;
  }

  const auth = await verifyStaffJwt(req, ['super_admin', 'manager', 'reception_staff']);
  if (!auth.ok) {
    return errorResponse(auth.statusCode, auth.code, auth.error, corsHeaders);
  }

  const { admin, staff } = auth;
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const dateFilter = url.searchParams.get('date');
      const statusFilter = url.searchParams.get('status');

      let query = admin
        .from('reservations')
        .select(
          'id, booking_reference, start_at, end_at, duration_minutes, hourly_rate_snapshot_centavos, total_amount_centavos, status, source, special_requests, created_at, cancelled_at, cancellation_reason, courts(court_number, name), customers(full_name)',
        )
        .eq('facility_id', staff.profile.facility_id || DEFAULT_FACILITY_ID)
        .order('start_at', { ascending: true })
        .limit(100);

      if (dateFilter && isValidDateString(dateFilter)) {
        const nextDate = addDaysToManilaDate(dateFilter, 1);
        query = query
          .gte('start_at', manilaDateTimeToUtcIso(dateFilter, '00:00'))
          .lt('start_at', manilaDateTimeToUtcIso(nextDate, '00:00'));
      }

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) {
        return errorResponse(500, 'ADMIN_QUERY_ERROR', 'Failed to list reservations.', corsHeaders);
      }

      return jsonResponse(200, { reservations: data ?? [] }, corsHeaders);
    }

    if (req.method === 'POST') {
      const rawBody = await req.json().catch(() => null);
      if (!rawBody || typeof rawBody !== 'object') {
        return errorResponse(400, 'VALIDATION_ERROR', 'JSON request body is required.', corsHeaders);
      }

      const action = (rawBody as Record<string, unknown>).action;

      if (action === 'confirm' || action === 'confirm_payment') {
        return errorResponse(
          403,
          'PAYMENT_VERIFICATION_REQUIRED',
          'Reservations cannot be confirmed without verified Stage 5 payment evidence.',
          corsHeaders,
        );
      }

      if (action === 'cancel') {
        const parsed = AdminCancelReservationSchema.safeParse(rawBody);
        if (!parsed.success) {
          return errorResponse(
            400,
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Invalid cancellation request.',
            corsHeaders,
          );
        }

        const { data, error } = await admin.rpc('staff_cancel_reservation', {
          p_staff_id: staff.userId,
          p_booking_reference: parsed.data.bookingReference,
          p_reason: parsed.data.reason,
        });

        if (error) {
          const msg = error.message || '';
          if (msg.includes('FORBIDDEN')) {
            return errorResponse(403, 'FORBIDDEN', 'Staff role cannot cancel this reservation.', corsHeaders);
          }
          if (msg.includes('NOT_FOUND')) {
            return errorResponse(404, 'BOOKING_NOT_FOUND', 'Reservation not found.', corsHeaders);
          }
          if (msg.includes('INVALID_STATUS_TRANSITION')) {
            return errorResponse(
              409,
              'INVALID_STATUS_TRANSITION',
              'Reservation is already in a terminal state.',
              corsHeaders,
            );
          }
          return errorResponse(500, 'ADMIN_CANCEL_FAILED', 'Unable to cancel reservation.', corsHeaders);
        }

        const row = Array.isArray(data) ? data[0] : data;
        return jsonResponse(200, { cancelled: true, reservation: row }, corsHeaders);
      }

      if (action === 'walk_in') {
        const parsed = CreateGuestHoldSchema.safeParse(rawBody);
        if (!parsed.success) {
          return errorResponse(
            400,
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Invalid walk-in reservation details.',
            corsHeaders,
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
            corsHeaders,
          );
        }

        const { data: court } = await admin
          .from('courts')
          .select('id, court_number, base_hourly_rate_centavos')
          .eq('facility_id', staff.profile.facility_id || DEFAULT_FACILITY_ID)
          .eq('court_number', input.courtNumber)
          .maybeSingle<{ id: string; court_number: number; base_hourly_rate_centavos: number }>();

        if (!court) {
          return errorResponse(404, 'COURT_NOT_FOUND', `Court ${input.courtNumber} was not found.`, corsHeaders);
        }

        const { data: rulesData } = await admin
          .from('pricing_rules')
          .select('*')
          .eq('facility_id', staff.profile.facility_id || DEFAULT_FACILITY_ID)
          .eq('is_active', true);

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
        const [ownershipTokenHash, lookupTokenHash] = await Promise.all([
          hashSecretToken(ownershipToken),
          hashSecretToken(lookupToken),
        ]);

        const { data, error } = await admin.rpc('staff_create_walkin_hold', {
          p_staff_id: staff.userId,
          p_facility_id: staff.profile.facility_id || DEFAULT_FACILITY_ID,
          p_court_number: input.courtNumber,
          p_start_at: scheduleCheck.startAtIso,
          p_end_at: scheduleCheck.endAtIso,
          p_customer_name: input.customerName,
          p_customer_mobile: input.customerMobile,
          p_customer_email: input.customerEmail,
          p_special_requests: input.specialRequests ?? null,
          p_hourly_rate_centavos: quote.effectiveHourlyRateCentavos,
          p_total_centavos: quote.totalAmountCentavos,
          p_pricing_snapshot: quote,
          p_ownership_token_hash: ownershipTokenHash,
          p_lookup_token_hash: lookupTokenHash,
        });

        if (error) {
          const msg = error.message || '';
          if (msg.includes('BOOKING_CONFLICT') || msg.includes('HOLD_CONFLICT')) {
            return errorResponse(409, 'HOLD_CONFLICT', 'Selected court and slot are no longer available.', corsHeaders);
          }
          if (msg.includes('COURT_MAINTENANCE') || msg.includes('COURT_UNAVAILABLE')) {
            return errorResponse(409, 'COURT_UNAVAILABLE', 'Selected court is under maintenance.', corsHeaders);
          }
          return errorResponse(500, 'WALKIN_FAILED', 'Unable to create walk-in hold.', corsHeaders);
        }

        const row = Array.isArray(data) ? data[0] : data;
        return jsonResponse(
          201,
          {
            holdId: row.hold_id,
            reservationId: row.reservation_id,
            bookingReference: row.booking_reference,
            status: row.status,
            expiresAt: row.expires_at,
            ownershipToken,
            lookupToken,
            pricing: { ...quote, source: 'supabase_live' },
            date: input.date,
            startTime: input.startTime,
            endTime: scheduleCheck.endTime,
            courtNumber: input.courtNumber,
          },
          corsHeaders,
        );
      }

      return errorResponse(
        400,
        'UNSUPPORTED_ACTION',
        'Supported actions are walk_in and cancel.',
        corsHeaders,
      );
    }

    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET and POST are supported.', corsHeaders);
  } catch {
    return errorResponse(500, 'ADMIN_RESERVATIONS_ERROR', 'Unexpected error in admin reservations.', corsHeaders);
  }
});
