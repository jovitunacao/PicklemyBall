import { z } from 'zod';
import {
  DEFAULT_FACILITY_ID,
  getSupabaseAdminClient,
  type VerifiedStaffContext,
} from './supabaseAdmin.ts';
import {
  calculateServerPricingQuote,
  type ServerPricingQuote,
} from './pricingEngine.ts';
import {
  generateOpaqueToken,
  hashSecretToken,
} from './bookingUtils.ts';
import {
  getAllCourtsIntervalStatus,
  getSimulatedDayScheduleForCourt,
} from '../src/data/mockStage2Availability.ts';
import {
  getManilaDayOfWeek,
  isBeyondAdvanceBookingLimit,
  isPastManilaDate,
  isPastManilaSlot,
  isValidDateString,
  isValidTimeString,
  manilaDateTimeToUtcIso,
  OPERATING_CLOSE_HOUR,
  OPERATING_OPEN_HOUR,
} from '../src/lib/manilaTime.ts';
import type {
  CourtRow,
  FacilitySettingsRow,
  OperatingHourRow,
  PricingRuleRow,
  PublicAvailabilityRow,
  SecureLookupResult,
} from '../src/types/database.ts';

export const AvailabilityQuerySchema = z.object({
  date: z.string().refine(isValidDateString, 'Invalid YYYY-MM-DD date'),
  startTime: z.string().refine(isValidTimeString, 'Invalid HH:mm start time'),
  durationMinutes: z.coerce.number().int().min(30).max(360),
});

export const CreateGuestHoldSchema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(14),
  date: z.string().refine(isValidDateString, 'Invalid YYYY-MM-DD date'),
  startTime: z.string().refine(isValidTimeString, 'Invalid HH:mm start time'),
  durationMinutes: z.coerce.number().int().min(60).max(180),
  customerName: z.string().trim().min(2, 'Full name is required').max(120),
  customerMobile: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid mobile number'),
  customerEmail: z.string().trim().email('Enter a valid email address').max(160),
  specialRequests: z.string().trim().max(400).optional(),
  sessionKey: z.string().trim().min(8).max(120).optional(),
});

export const LookupBookingSchema = z.object({
  bookingReference: z
    .string()
    .trim()
    .regex(/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/i, 'Invalid booking reference format'),
  lookupToken: z.string().trim().min(8, 'Access token is required').max(200),
});

export const CancelBookingSchema = z.object({
  token: z.string().trim().min(8).max(200),
  reason: z.string().trim().max(240).optional(),
});

export interface ServiceResult<T> {
  ok: boolean;
  statusCode: number;
  data?: T;
  error?: string;
  code?: string;
}

function addMinutesToTime(startTime: string, durationMinutes: number): string {
  const [hh, mm] = startTime.split(':').map(Number);
  const total = hh * 60 + mm + durationMinutes;
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

function parseMinutes(timeStr: string): number {
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh * 60 + (mm || 0);
}

// Development-default pricing rules mirror migration 0003 when DB is unconfigured
const DEV_FALLBACK_PRICING_RULES: PricingRuleRow[] = [
  {
    id: 'dev-weekday-day',
    facility_id: DEFAULT_FACILITY_ID,
    court_id: null,
    name: 'Weekday Daytime (Dev Default)',
    rule_type: 'standard',
    day_scope: 'weekday',
    start_time: '06:00:00',
    end_time: '17:00:00',
    rate_centavos: 35000,
    discount_percent: 0,
    priority: 10,
    is_active: true,
    valid_from: null,
    valid_until: null,
  },
  {
    id: 'dev-weekday-peak',
    facility_id: DEFAULT_FACILITY_ID,
    court_id: null,
    name: 'Weekday Peak Evening (Dev Default)',
    rule_type: 'peak',
    day_scope: 'weekday',
    start_time: '17:00:00',
    end_time: '21:00:00',
    rate_centavos: 45000,
    discount_percent: 0,
    priority: 20,
    is_active: true,
    valid_from: null,
    valid_until: null,
  },
  {
    id: 'dev-weekday-late',
    facility_id: DEFAULT_FACILITY_ID,
    court_id: null,
    name: 'Weekday Late Evening (Dev Default)',
    rule_type: 'standard',
    day_scope: 'weekday',
    start_time: '21:00:00',
    end_time: '22:00:00',
    rate_centavos: 35000,
    discount_percent: 0,
    priority: 10,
    is_active: true,
    valid_from: null,
    valid_until: null,
  },
  {
    id: 'dev-weekend-day',
    facility_id: DEFAULT_FACILITY_ID,
    court_id: null,
    name: 'Weekend Daytime (Dev Default)',
    rule_type: 'weekend',
    day_scope: 'weekend',
    start_time: '06:00:00',
    end_time: '17:00:00',
    rate_centavos: 40000,
    discount_percent: 0,
    priority: 15,
    is_active: true,
    valid_from: null,
    valid_until: null,
  },
  {
    id: 'dev-weekend-peak',
    facility_id: DEFAULT_FACILITY_ID,
    court_id: null,
    name: 'Weekend Peak Evening (Dev Default)',
    rule_type: 'peak',
    day_scope: 'weekend',
    start_time: '17:00:00',
    end_time: '21:00:00',
    rate_centavos: 50000,
    discount_percent: 0,
    priority: 25,
    is_active: true,
    valid_from: null,
    valid_until: null,
  },
  {
    id: 'dev-weekend-late',
    facility_id: DEFAULT_FACILITY_ID,
    court_id: null,
    name: 'Weekend Late Evening (Dev Default)',
    rule_type: 'weekend',
    day_scope: 'weekend',
    start_time: '21:00:00',
    end_time: '22:00:00',
    rate_centavos: 40000,
    discount_percent: 0,
    priority: 15,
    is_active: true,
    valid_from: null,
    valid_until: null,
  },
];

async function validateScheduleAgainstFacility(
  dateStr: string,
  startTime: string,
  durationMinutes: number,
  now: Date = new Date(),
): Promise<
  | {
      ok: true;
      startAtIso: string;
      endAtIso: string;
      endTime: string;
      settings: FacilitySettingsRow;
    }
  | { ok: false; statusCode: number; code: string; error: string }
> {
  if (isPastManilaDate(dateStr, now)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'PAST_DATE_REJECTED',
      error: 'Bookings cannot be made for past dates in Asia/Manila time.',
    };
  }

  if (isPastManilaSlot(dateStr, startTime, now)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'PAST_TIME_REJECTED',
      error: 'Selected start time has already passed in Asia/Manila time.',
    };
  }

  const admin = getSupabaseAdminClient();
  let settings: FacilitySettingsRow = {
    facility_id: DEFAULT_FACILITY_ID,
    hold_duration_minutes: 10,
    max_advance_booking_days: 30,
    min_booking_duration_minutes: 60,
    max_booking_duration_minutes: 180,
    slot_granularity_minutes: 60,
    allow_guest_checkout: true,
    deposit_enabled: false,
    deposit_percent: 100,
    updated_by: null,
    updated_at: now.toISOString(),
  };

  let openMin = OPERATING_OPEN_HOUR * 60;
  let closeMin = OPERATING_CLOSE_HOUR * 60;
  let isClosedDay = false;

  if (admin) {
    const { data: dbSettings } = await admin
      .from('facility_settings')
      .select('*')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .maybeSingle<FacilitySettingsRow>();
    if (dbSettings) {
      settings = dbSettings;
    }

    const dow = getManilaDayOfWeek(dateStr);
    const { data: hoursRows } = await admin
      .from('operating_hours')
      .select('*')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .or(`override_date.eq.${dateStr},day_of_week.eq.${dow}`);

    const typedRows = (hoursRows ?? []) as OperatingHourRow[];
    const overrideRow = typedRows.find((r) => r.override_date === dateStr);
    const weeklyRow = typedRows.find((r) => r.day_of_week === dow);
    const activeHours = overrideRow ?? weeklyRow;
    if (activeHours) {
      isClosedDay = activeHours.is_closed;
      openMin = parseMinutes(activeHours.open_time);
      closeMin = parseMinutes(activeHours.close_time);
    }
  }

  if (isClosedDay) {
    return {
      ok: false,
      statusCode: 400,
      code: 'FACILITY_CLOSED',
      error: `The facility is closed on ${dateStr}.`,
    };
  }

  if (isBeyondAdvanceBookingLimit(dateStr, settings.max_advance_booking_days, now)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'ADVANCE_LIMIT_EXCEEDED',
      error: `Bookings can only be scheduled up to ${settings.max_advance_booking_days} days in advance.`,
    };
  }

  if (
    durationMinutes < settings.min_booking_duration_minutes ||
    durationMinutes > settings.max_booking_duration_minutes ||
    durationMinutes % settings.slot_granularity_minutes !== 0
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_DURATION',
      error: `Duration must be between ${settings.min_booking_duration_minutes} and ${settings.max_booking_duration_minutes} minutes.`,
    };
  }

  const startMin = parseMinutes(startTime);
  const endMin = startMin + durationMinutes;
  if (startMin < openMin || endMin > closeMin) {
    return {
      ok: false,
      statusCode: 400,
      code: 'OUTSIDE_OPERATING_HOURS',
      error: 'Requested interval falls outside Astoria Regency operating hours.',
    };
  }

  const endTime = addMinutesToTime(startTime, durationMinutes);
  const startAtIso = manilaDateTimeToUtcIso(dateStr, startTime);
  const endAtIso = manilaDateTimeToUtcIso(dateStr, endTime);

  return {
    ok: true,
    startAtIso,
    endAtIso,
    endTime,
    settings,
  };
}

export async function getAvailabilityForInterval(params: {
  date: string;
  startTime: string;
  durationMinutes: number;
}): Promise<
  ServiceResult<{
    source: 'supabase_live' | 'simulated_stage2_fallback';
    supabaseConfigured: boolean;
    date: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    courts: Array<{
      courtNumber: number;
      status: 'available' | 'booked' | 'held' | 'maintenance';
      reason: string;
    }>;
  }>
> {
  const scheduleCheck = await validateScheduleAgainstFacility(
    params.date,
    params.startTime,
    params.durationMinutes,
  );
  if (!scheduleCheck.ok) {
    return {
      ok: false,
      statusCode: scheduleCheck.statusCode,
      code: scheduleCheck.code,
      error: scheduleCheck.error,
    };
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    // Return explicitly labeled Stage 2 simulated preview when Supabase credentials are not configured yet
    const durationHours = Math.round(params.durationMinutes / 60);
    const sim = getAllCourtsIntervalStatus(params.date, params.startTime, durationHours);
    return {
      ok: true,
      statusCode: 200,
      data: {
        source: 'simulated_stage2_fallback',
        supabaseConfigured: false,
        date: params.date,
        startTime: params.startTime,
        endTime: scheduleCheck.endTime,
        durationMinutes: params.durationMinutes,
        courts: Object.values(sim).map((c) => ({
          courtNumber: c.courtNumber,
          status: c.status,
          reason: c.reason,
        })),
      },
    };
  }

  // Expire any stale holds opportunistically before reading availability
  await admin.rpc('cleanup_expired_holds', { p_court_id: null });

  const { data, error } = await admin.rpc('get_public_court_availability', {
    p_facility_id: DEFAULT_FACILITY_ID,
    p_start_at: scheduleCheck.startAtIso,
    p_end_at: scheduleCheck.endAtIso,
  });

  if (error) {
    return {
      ok: false,
      statusCode: 502,
      code: 'DATABASE_AVAILABILITY_ERROR',
      error: 'Unable to retrieve live court availability from Supabase.',
    };
  }

  const rows = (data ?? []) as PublicAvailabilityRow[];
  return {
    ok: true,
    statusCode: 200,
    data: {
      source: 'supabase_live',
      supabaseConfigured: true,
      date: params.date,
      startTime: params.startTime,
      endTime: scheduleCheck.endTime,
      durationMinutes: params.durationMinutes,
      courts: rows.map((r) => ({
        courtNumber: r.court_number,
        status: r.status,
        reason: r.reason,
      })),
    },
  };
}

export async function getPricingQuoteForCourt(params: {
  courtNumber: number;
  date: string;
  startTime: string;
  durationMinutes: number;
}): Promise<ServiceResult<ServerPricingQuote & { source: 'supabase_live' | 'dev_default' }>> {
  const scheduleCheck = await validateScheduleAgainstFacility(
    params.date,
    params.startTime,
    params.durationMinutes,
  );
  if (!scheduleCheck.ok) {
    return {
      ok: false,
      statusCode: scheduleCheck.statusCode,
      code: scheduleCheck.code,
      error: scheduleCheck.error,
    };
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    const quote = calculateServerPricingQuote({
      courtNumber: params.courtNumber,
      courtId: `court-${String(params.courtNumber).padStart(2, '0')}`,
      baseHourlyRateCentavos: 35000,
      dateStr: params.date,
      startTime: params.startTime,
      durationMinutes: params.durationMinutes,
      rules: DEV_FALLBACK_PRICING_RULES,
      depositEnabled: scheduleCheck.settings.deposit_enabled,
      depositPercent: scheduleCheck.settings.deposit_percent,
    });
    return {
      ok: true,
      statusCode: 200,
      data: { ...quote, source: 'dev_default' },
    };
  }

  const { data: court, error: courtErr } = await admin
    .from('courts')
    .select('*')
    .eq('facility_id', DEFAULT_FACILITY_ID)
    .eq('court_number', params.courtNumber)
    .maybeSingle<CourtRow>();

  if (courtErr || !court) {
    return {
      ok: false,
      statusCode: 404,
      code: 'COURT_NOT_FOUND',
      error: `Court ${params.courtNumber} was not found.`,
    };
  }

  const { data: rulesData } = await admin
    .from('pricing_rules')
    .select('*')
    .eq('facility_id', DEFAULT_FACILITY_ID)
    .eq('is_active', true);

  const quote = calculateServerPricingQuote({
    courtNumber: court.court_number,
    courtId: court.id,
    baseHourlyRateCentavos: court.base_hourly_rate_centavos,
    dateStr: params.date,
    startTime: params.startTime,
    durationMinutes: params.durationMinutes,
    rules: (rulesData ?? []) as PricingRuleRow[],
    depositEnabled: scheduleCheck.settings.deposit_enabled,
    depositPercent: scheduleCheck.settings.deposit_percent,
  });

  return {
    ok: true,
    statusCode: 200,
    data: { ...quote, source: 'supabase_live' },
  };
}

export async function getCourtHourlySchedule(params: {
  courtNumber: number;
  date: string;
}): Promise<
  ServiceResult<{
    source: 'supabase_live' | 'simulated_stage2_fallback';
    slots: Array<{
      startTime: string;
      endTime: string;
      status: 'available' | 'booked' | 'held' | 'maintenance';
      isPast: boolean;
    }>;
  }>
> {
  if (!isValidDateString(params.date) || isPastManilaDate(params.date)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'PAST_DATE_REJECTED',
      error: 'Cannot inspect past dates.',
    };
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    const simSlots = getSimulatedDayScheduleForCourt(params.courtNumber, params.date);
    return {
      ok: true,
      statusCode: 200,
      data: {
        source: 'simulated_stage2_fallback',
        slots: simSlots.map((s) => ({
          startTime: s.startTime,
          endTime: s.endTime,
          status: isPastManilaSlot(params.date, s.startTime) ? 'maintenance' : s.status,
          isPast: isPastManilaSlot(params.date, s.startTime),
        })),
      },
    };
  }

  await admin.rpc('cleanup_expired_holds', { p_court_id: null });

  const slots: Array<{
    startTime: string;
    endTime: string;
    status: 'available' | 'booked' | 'held' | 'maintenance';
    isPast: boolean;
  }> = [];

  for (let h = OPERATING_OPEN_HOUR; h < OPERATING_CLOSE_HOUR; h++) {
    const startTime = `${String(h).padStart(2, '0')}:00`;
    const endTime = `${String(h + 1).padStart(2, '0')}:00`;
    const isPast = isPastManilaSlot(params.date, startTime);
    if (isPast) {
      slots.push({ startTime, endTime, status: 'maintenance', isPast: true });
      continue;
    }

    const { data } = await admin.rpc('get_public_court_availability', {
      p_facility_id: DEFAULT_FACILITY_ID,
      p_start_at: manilaDateTimeToUtcIso(params.date, startTime),
      p_end_at: manilaDateTimeToUtcIso(params.date, endTime),
    });
    const row = ((data ?? []) as PublicAvailabilityRow[]).find(
      (r) => r.court_number === params.courtNumber,
    );
    slots.push({
      startTime,
      endTime,
      status: row?.status ?? 'available',
      isPast: false,
    });
  }

  return {
    ok: true,
    statusCode: 200,
    data: {
      source: 'supabase_live',
      slots,
    },
  };
}

export async function createGuestHoldAndPendingBooking(
  input: z.infer<typeof CreateGuestHoldSchema>,
): Promise<
  ServiceResult<{
    holdId: string;
    reservationId: string;
    bookingReference: string;
    status: 'pending_payment';
    expiresAt: string;
    ownershipToken: string;
    lookupToken: string;
    pricing: ServerPricingQuote;
    date: string;
    startTime: string;
    endTime: string;
    courtNumber: number;
  }>
> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      statusCode: 503,
      code: 'SUPABASE_NOT_CONFIGURED',
      error:
        'Live Supabase database credentials are not configured yet. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY after running Stage 3 migrations to create real reservation holds.',
    };
  }

  const scheduleCheck = await validateScheduleAgainstFacility(
    input.date,
    input.startTime,
    input.durationMinutes,
  );
  if (!scheduleCheck.ok) {
    return {
      ok: false,
      statusCode: scheduleCheck.statusCode,
      code: scheduleCheck.code,
      error: scheduleCheck.error,
    };
  }

  if (!scheduleCheck.settings.allow_guest_checkout) {
    return {
      ok: false,
      statusCode: 403,
      code: 'GUEST_CHECKOUT_DISABLED',
      error: 'Guest checkout is currently disabled by facility administration.',
    };
  }

  // Server-authoritative quote calculation (never trusts browser totals)
  const quoteRes = await getPricingQuoteForCourt({
    courtNumber: input.courtNumber,
    date: input.date,
    startTime: input.startTime,
    durationMinutes: input.durationMinutes,
  });

  if (!quoteRes.ok || !quoteRes.data) {
    return {
      ok: false,
      statusCode: quoteRes.statusCode,
      code: quoteRes.code,
      error: quoteRes.error ?? 'Failed to calculate server quote.',
    };
  }

  const ownershipToken = generateOpaqueToken(24);
  const lookupToken = generateOpaqueToken(24);
  const sessionKey = input.sessionKey ?? generateOpaqueToken(12);

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
    p_hourly_rate_centavos: quoteRes.data.effectiveHourlyRateCentavos,
    p_total_centavos: quoteRes.data.totalAmountCentavos,
    p_pricing_snapshot: quoteRes.data,
    p_ownership_token_hash: hashSecretToken(ownershipToken),
    p_lookup_token_hash: hashSecretToken(lookupToken),
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('BOOKING_CONFLICT') || msg.includes('HOLD_CONFLICT') || msg.includes('excl_reservations_no_overlap')) {
      return {
        ok: false,
        statusCode: 409,
        code: 'HOLD_CONFLICT',
        error: `Court ${input.courtNumber} was just reserved or held by another player for ${input.startTime}–${scheduleCheck.endTime}. Please pick another court or time slot.`,
      };
    }
    if (msg.includes('COURT_MAINTENANCE') || msg.includes('COURT_UNAVAILABLE')) {
      return {
        ok: false,
        statusCode: 409,
        code: 'COURT_UNAVAILABLE',
        error: `Court ${input.courtNumber} is currently closed or under maintenance.`,
      };
    }
    return {
      ok: false,
      statusCode: 500,
      code: 'HOLD_ACQUISITION_FAILED',
      error: 'Unable to acquire temporary reservation hold.',
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      ok: false,
      statusCode: 500,
      code: 'HOLD_ACQUISITION_FAILED',
      error: 'Database did not return hold confirmation.',
    };
  }

  return {
    ok: true,
    statusCode: 201,
    data: {
      holdId: row.hold_id,
      reservationId: row.reservation_id,
      bookingReference: row.booking_reference,
      status: 'pending_payment',
      expiresAt: row.expires_at,
      ownershipToken,
      lookupToken,
      pricing: quoteRes.data,
      date: input.date,
      startTime: input.startTime,
      endTime: scheduleCheck.endTime,
      courtNumber: input.courtNumber,
    },
  };
}

export async function lookupBookingSecurely(
  input: z.infer<typeof LookupBookingSchema>,
): Promise<
  ServiceResult<
    SecureLookupResult & {
      qrCheckInEligible: boolean;
      qrCheckInNote: string;
    }
  >
> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      statusCode: 503,
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'Supabase is not configured in this environment yet.',
    };
  }

  const { data, error } = await admin.rpc('lookup_booking_secure', {
    p_booking_reference: input.bookingReference,
    p_lookup_token_hash: hashSecretToken(input.lookupToken),
  });

  if (error) {
    return {
      ok: false,
      statusCode: 500,
      code: 'LOOKUP_ERROR',
      error: 'Failed to look up reservation.',
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as SecureLookupResult | undefined;
  if (!row) {
    return {
      ok: false,
      statusCode: 404,
      code: 'BOOKING_NOT_FOUND_OR_UNAUTHORIZED',
      error: 'No reservation matched that booking reference and access token.',
    };
  }

  const qrEligible = row.reservation_status === 'confirmed' && row.payment_status === 'paid';
  return {
    ok: true,
    statusCode: 200,
    data: {
      ...row,
      qrCheckInEligible: qrEligible,
      qrCheckInNote: qrEligible
        ? 'Verified booking ready for check-in.'
        : 'QR check-in passes are withheld for unpaid or unconfirmed reservations (Stage 5).',
    },
  };
}

export async function cancelBookingSecurely(
  bookingReference: string,
  input: z.infer<typeof CancelBookingSchema>,
): Promise<ServiceResult<{ cancelled: boolean }>> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      statusCode: 503,
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'Supabase is not configured in this environment yet.',
    };
  }

  const { data, error } = await admin.rpc('cancel_booking_with_token', {
    p_booking_reference: bookingReference,
    p_token_hash: hashSecretToken(input.token),
    p_reason: input.reason ?? 'Cancelled by customer',
  });

  if (error) {
    return {
      ok: false,
      statusCode: 500,
      code: 'CANCEL_FAILED',
      error: 'Unable to cancel reservation.',
    };
  }

  if (!data) {
    return {
      ok: false,
      statusCode: 403,
      code: 'INVALID_TOKEN_OR_TERMINAL_STATE',
      error: 'Invalid access token or reservation is already cancelled/expired.',
    };
  }

  return {
    ok: true,
    statusCode: 200,
    data: { cancelled: true },
  };
}

// ---------------------------------------------------------------------------
// Stage 4.11: Administrator Backend Foundation (Protected by Staff RBAC)
// ---------------------------------------------------------------------------
export async function adminListReservations(
  _staff: VerifiedStaffContext,
  dateFilter?: string,
): Promise<ServiceResult<unknown[]>> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { ok: false, statusCode: 503, code: 'SUPABASE_NOT_CONFIGURED', error: 'Supabase not configured.' };
  }

  let query = admin
    .from('reservations')
    .select(
      'id, booking_reference, start_at, end_at, duration_minutes, total_amount_centavos, status, source, created_at, courts(court_number, name), customers(full_name)',
    )
    .eq('facility_id', DEFAULT_FACILITY_ID)
    .order('start_at', { ascending: true })
    .limit(100);

  if (dateFilter && isValidDateString(dateFilter)) {
    query = query
      .gte('start_at', manilaDateTimeToUtcIso(dateFilter, '00:00'))
      .lt('start_at', manilaDateTimeToUtcIso(dateFilter, '23:59'));
  }

  const { data, error } = await query;
  if (error) {
    return { ok: false, statusCode: 500, code: 'ADMIN_QUERY_ERROR', error: 'Failed to list reservations.' };
  }
  return { ok: true, statusCode: 200, data: data ?? [] };
}

export async function adminCreateMaintenanceBlock(
  staff: VerifiedStaffContext,
  params: { courtNumber: number; startAtIso: string; endAtIso: string; reason: string },
): Promise<ServiceResult<{ id: string }>> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { ok: false, statusCode: 503, code: 'SUPABASE_NOT_CONFIGURED', error: 'Supabase not configured.' };
  }

  const { data: court } = await admin
    .from('courts')
    .select('id')
    .eq('facility_id', DEFAULT_FACILITY_ID)
    .eq('court_number', params.courtNumber)
    .maybeSingle<{ id: string }>();

  if (!court) {
    return { ok: false, statusCode: 404, code: 'COURT_NOT_FOUND', error: 'Court not found.' };
  }

  const { data, error } = await admin
    .from('court_maintenance')
    .insert({
      facility_id: DEFAULT_FACILITY_ID,
      court_id: court.id,
      start_at: params.startAtIso,
      end_at: params.endAtIso,
      reason: params.reason,
      is_active: true,
      created_by: staff.userId,
    })
    .select('id')
    .single<{ id: string }>();

  if (error || !data) {
    return { ok: false, statusCode: 500, code: 'MAINTENANCE_INSERT_ERROR', error: 'Unable to block court for maintenance.' };
  }

  await admin.from('booking_audit_logs').insert({
    facility_id: DEFAULT_FACILITY_ID,
    actor_type: 'staff',
    actor_id: staff.userId,
    event_type: 'court_maintenance_created',
    payload: { courtNumber: params.courtNumber, reason: params.reason },
  });

  return { ok: true, statusCode: 201, data };
}

export async function adminCreateWalkInHold(
  staff: VerifiedStaffContext,
  input: z.infer<typeof CreateGuestHoldSchema>,
) {
  // Walk-in bookings use the exact same concurrency-safe hold acquisition & server pricing.
  // Payment confirmation (cash received vs online) remains disabled until Stage 5/6.
  const res = await createGuestHoldAndPendingBooking(input);
  if (res.ok && res.data) {
    const admin = getSupabaseAdminClient();
    await admin?.from('booking_audit_logs').insert({
      facility_id: DEFAULT_FACILITY_ID,
      reservation_id: res.data.reservationId,
      hold_id: res.data.holdId,
      actor_type: 'staff',
      actor_id: staff.userId,
      event_type: 'staff_walkin_hold_created',
      payload: { bookingReference: res.data.bookingReference, role: staff.profile.role },
    });
  }
  return res;
}
