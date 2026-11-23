import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { enforceDistributedRateLimit } from '../_shared/rateLimit.ts';
import { errorResponse, hashSecretToken, jsonResponse } from '../_shared/security.ts';
import { getEnv, getServiceSupabaseClient } from '../_shared/supabase.ts';
import { LookupBookingSchema } from '../_shared/validation.ts';

interface SecureLookupRow {
  booking_reference: string;
  court_number: number;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  total_amount_centavos: number;
  reservation_status:
    | 'pending_payment'
    | 'confirmed'
    | 'cancelled'
    | 'expired'
    | 'completed'
    | 'payment_review_required';
  payment_status:
    | 'created'
    | 'pending'
    | 'paid'
    | 'failed'
    | 'expired'
    | 'cancelled'
    | 'refund_pending'
    | 'refunded';
  hold_expires_at: string | null;
  customer_name: string;
}

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
      'Supabase is not configured in this environment yet.',
      corsHeaders,
    );
  }

  const rate = await enforceDistributedRateLimit(admin, req, 'booking-lookup', {
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
      'Too many lookup attempts. Please wait briefly before retrying.',
      { ...headersWithRate, 'Retry-After': String(rate.retryAfterSeconds) },
    );
  }

  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = LookupBookingSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Booking reference and access token are required.',
        headersWithRate,
      );
    }

    const tokenHash = await hashSecretToken(parsed.data.lookupToken);
    const { data, error } = await admin.rpc('lookup_booking_secure', {
      p_booking_reference: parsed.data.bookingReference,
      p_lookup_token_hash: tokenHash,
    });

    if (error) {
      return errorResponse(
        500,
        'LOOKUP_ERROR',
        'Failed to look up reservation.',
        headersWithRate,
      );
    }

    const row = (Array.isArray(data) ? data[0] : data) as SecureLookupRow | undefined;
    if (!row) {
      return errorResponse(
        404,
        'BOOKING_NOT_FOUND_OR_UNAUTHORIZED',
        'No reservation matched that booking reference and access token.',
        headersWithRate,
      );
    }

    const qrEligible =
      row.reservation_status === 'confirmed' && row.payment_status === 'paid';

    return jsonResponse(
      200,
      {
        ...row,
        qrCheckInEligible: qrEligible,
        qrCheckInNote: qrEligible
          ? 'Verified booking ready for check-in.'
          : 'QR check-in passes are withheld for unpaid or unconfirmed reservations (Stage 5).',
      },
      headersWithRate,
    );
  } catch {
    return errorResponse(
      500,
      'LOOKUP_INTERNAL_ERROR',
      'Unexpected error while retrieving reservation.',
      headersWithRate,
    );
  }
});
