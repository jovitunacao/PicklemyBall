import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { validateScheduleAgainstFacility } from '../_shared/facilitySchedule.ts';
import {
  isPastManilaDate,
  isPastManilaSlot,
  isValidDateString,
  manilaDateTimeToUtcIso,
  OPERATING_CLOSE_HOUR,
  OPERATING_OPEN_HOUR,
} from '../_shared/manilaTime.ts';
import { enforceDistributedRateLimit } from '../_shared/rateLimit.ts';
import { errorResponse, jsonResponse } from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  getServiceSupabaseClient,
} from '../_shared/supabase.ts';
import {
  AvailabilityQuerySchema,
  CourtScheduleQuerySchema,
} from '../_shared/validation.ts';

interface PublicAvailabilityRow {
  court_id: string;
  court_number: number;
  status: 'available' | 'booked' | 'held' | 'maintenance';
  reason: string;
}

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'GET, OPTIONS',
  );
  if (preflightOrErrorResponse) {
    return preflightOrErrorResponse;
  }

  if (req.method !== 'GET') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.', corsHeaders);
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

  const rate = await enforceDistributedRateLimit(admin, req, 'availability', {
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
      'Too many availability requests. Please wait briefly before retrying.',
      { ...headersWithRate, 'Retry-After': String(rate.retryAfterSeconds) },
    );
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'interval';

  try {
    if (mode === 'court_schedule') {
      const parsed = CourtScheduleQuerySchema.safeParse({
        courtNumber: url.searchParams.get('courtNumber'),
        date: url.searchParams.get('date'),
      });
      if (!parsed.success) {
        return errorResponse(
          400,
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Invalid court schedule parameters.',
          headersWithRate,
        );
      }

      const { courtNumber, date } = parsed.data;
      if (!isValidDateString(date) || isPastManilaDate(date)) {
        return errorResponse(
          400,
          'PAST_DATE_REJECTED',
          'Cannot inspect past dates.',
          headersWithRate,
        );
      }

      await admin.rpc('cleanup_expired_holds', { p_court_id: null });

      const hours: number[] = [];
      for (let h = OPERATING_OPEN_HOUR; h < OPERATING_CLOSE_HOUR; h++) {
        hours.push(h);
      }

      const slots = await Promise.all(
        hours.map(async (h) => {
          const startTime = `${String(h).padStart(2, '0')}:00`;
          const endTime = `${String(h + 1).padStart(2, '0')}:00`;
          const isPast = isPastManilaSlot(date, startTime);
          if (isPast) {
            return {
              startTime,
              endTime,
              status: 'maintenance' as const,
              isPast: true,
            };
          }

          const { data } = await admin.rpc('get_public_court_availability', {
            p_facility_id: DEFAULT_FACILITY_ID,
            p_start_at: manilaDateTimeToUtcIso(date, startTime),
            p_end_at: manilaDateTimeToUtcIso(date, endTime),
          });
          const row = ((data ?? []) as PublicAvailabilityRow[]).find(
            (r) => r.court_number === courtNumber,
          );
          return {
            startTime,
            endTime,
            status: row?.status ?? ('available' as const),
            isPast: false,
          };
        }),
      );

      return jsonResponse(
        200,
        {
          source: 'supabase_live',
          slots,
        },
        headersWithRate,
      );
    }

    const parsed = AvailabilityQuerySchema.safeParse({
      date: url.searchParams.get('date'),
      startTime: url.searchParams.get('startTime'),
      durationMinutes: url.searchParams.get('durationMinutes'),
    });
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid availability parameters.',
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

    await admin.rpc('cleanup_expired_holds', { p_court_id: null });

    const { data, error } = await admin.rpc('get_public_court_availability', {
      p_facility_id: DEFAULT_FACILITY_ID,
      p_start_at: scheduleCheck.startAtIso,
      p_end_at: scheduleCheck.endAtIso,
    });

    if (error) {
      const errMsg = `${error.code ?? ''} ${error.message ?? ''}`;
      if (
        error.code === '42883' ||
        error.code === '42P01' ||
        error.code === 'PGRST202' ||
        /does not exist|could not find the function|schema cache/i.test(errMsg)
      ) {
        return errorResponse(
          500,
          'DATABASE_SCHEMA_ERROR',
          'Required Pick My Ball database tables or functions are missing. Run migrations 0001–0004.',
          headersWithRate,
        );
      }
      return errorResponse(
        502,
        'DATABASE_AVAILABILITY_ERROR',
        'Unable to retrieve live court availability from Supabase.',
        headersWithRate,
      );
    }

    const rows = (data ?? []) as PublicAvailabilityRow[];
    return jsonResponse(
      200,
      {
        source: 'supabase_live',
        supabaseConfigured: true,
        date: parsed.data.date,
        startTime: parsed.data.startTime,
        endTime: scheduleCheck.endTime,
        durationMinutes: parsed.data.durationMinutes,
        courts: rows.map((r) => ({
          courtNumber: r.court_number,
          status: r.status,
          reason: r.reason,
        })),
      },
      headersWithRate,
    );
  } catch {
    return errorResponse(
      500,
      'AVAILABILITY_INTERNAL_ERROR',
      'Unexpected error while retrieving court availability.',
      headersWithRate,
    );
  }
});
