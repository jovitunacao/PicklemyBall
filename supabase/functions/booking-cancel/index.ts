import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { classifyDbSchemaError } from '../_shared/facilitySchedule.ts';
import { enforceDistributedRateLimit } from '../_shared/rateLimit.ts';
import { errorResponse, hashSecretToken, jsonResponse } from '../_shared/security.ts';
import { getEnv, getServiceSupabaseClient } from '../_shared/supabase.ts';
import { CancelBookingSchema } from '../_shared/validation.ts';

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

  const rate = await enforceDistributedRateLimit(admin, req, 'booking-cancel', {
    windowSeconds: 60,
    maxRequests: 20,
  });
  const headersWithRate = {
    ...corsHeaders,
    'X-RateLimit-Remaining': String(rate.remaining),
  };
  if (!rate.allowed) {
    return errorResponse(
      429,
      'RATE_LIMIT_EXCEEDED',
      'Too many cancellation requests. Please wait briefly before retrying.',
      { ...headersWithRate, 'Retry-After': String(rate.retryAfterSeconds) },
    );
  }

  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = CancelBookingSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ??
          'A valid booking reference and access token are required to cancel.',
        headersWithRate,
      );
    }

    const tokenHash = await hashSecretToken(parsed.data.token);
    const { data, error } = await admin.rpc('cancel_booking_with_token', {
      p_booking_reference: parsed.data.bookingReference,
      p_token_hash: tokenHash,
      p_reason: parsed.data.reason ?? 'Cancelled by customer',
    });

    if (error) {
      if (classifyDbSchemaError(error)) {
        return errorResponse(
          500,
          'DATABASE_SCHEMA_ERROR',
          'Required Pick My Ball database tables or functions are missing. Run migrations 0001–0004.',
          headersWithRate,
        );
      }
      const msg = error.message || '';
      if (msg.includes('CUSTOMER_CANCELLATION_FORBIDDEN')) {
        return errorResponse(
          403,
          'CUSTOMER_CANCELLATION_FORBIDDEN',
          'Confirmed or paid reservations cannot be cancelled online. Please contact Pick My Ball reception staff.',
          headersWithRate,
        );
      }
      return errorResponse(
        500,
        'CANCEL_FAILED',
        'Unable to cancel reservation.',
        headersWithRate,
      );
    }

    if (!data) {
      return errorResponse(
        403,
        'INVALID_TOKEN_OR_TERMINAL_STATE',
        'Invalid access token or reservation is already cancelled/expired.',
        headersWithRate,
      );
    }

    return jsonResponse(200, { cancelled: true }, headersWithRate);
  } catch {
    return errorResponse(
      500,
      'CANCEL_INTERNAL_ERROR',
      'Unexpected error while cancelling reservation.',
      headersWithRate,
    );
  }
});
