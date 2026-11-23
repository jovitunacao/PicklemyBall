import type { SupabaseClient } from '@supabase/supabase-js';
import {
  addMinutesToTime,
  getManilaDayOfWeek,
  isBeyondAdvanceBookingLimit,
  isPastManilaDate,
  isPastManilaSlot,
  manilaDateTimeToUtcIso,
  OPERATING_CLOSE_HOUR,
  OPERATING_OPEN_HOUR,
  parseTimeToMinutes,
} from './manilaTime.ts';
import { DEFAULT_FACILITY_ID } from './supabase.ts';

export interface FacilitySettingsRecord {
  facility_id: string;
  hold_duration_minutes: number;
  max_advance_booking_days: number;
  min_booking_duration_minutes: number;
  max_booking_duration_minutes: number;
  slot_granularity_minutes: number;
  allow_guest_checkout: boolean;
  deposit_enabled: boolean;
  deposit_percent: number;
}

interface OperatingHourRecord {
  day_of_week: number | null;
  override_date: string | null;
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

export async function validateScheduleAgainstFacility(
  admin: SupabaseClient,
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
      settings: FacilitySettingsRecord;
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

  let settings: FacilitySettingsRecord = {
    facility_id: DEFAULT_FACILITY_ID,
    hold_duration_minutes: 10,
    max_advance_booking_days: 30,
    min_booking_duration_minutes: 60,
    max_booking_duration_minutes: 180,
    slot_granularity_minutes: 60,
    allow_guest_checkout: true,
    deposit_enabled: false,
    deposit_percent: 100,
  };

  const { data: dbSettings } = await admin
    .from('facility_settings')
    .select(
      'facility_id, hold_duration_minutes, max_advance_booking_days, min_booking_duration_minutes, max_booking_duration_minutes, slot_granularity_minutes, allow_guest_checkout, deposit_enabled, deposit_percent',
    )
    .eq('facility_id', DEFAULT_FACILITY_ID)
    .maybeSingle<FacilitySettingsRecord>();
  if (dbSettings) {
    settings = dbSettings;
  }

  let openMin = OPERATING_OPEN_HOUR * 60;
  let closeMin = OPERATING_CLOSE_HOUR * 60;
  let isClosedDay = false;

  const dow = getManilaDayOfWeek(dateStr);
  const { data: hoursRows } = await admin
    .from('operating_hours')
    .select('day_of_week, override_date, open_time, close_time, is_closed')
    .eq('facility_id', DEFAULT_FACILITY_ID)
    .or(`override_date.eq.${dateStr},day_of_week.eq.${dow}`);

  const typedRows = (hoursRows ?? []) as OperatingHourRecord[];
  const overrideRow = typedRows.find((r) => r.override_date === dateStr);
  const weeklyRow = typedRows.find((r) => r.day_of_week === dow);
  const activeHours = overrideRow ?? weeklyRow;
  if (activeHours) {
    isClosedDay = activeHours.is_closed;
    openMin = parseTimeToMinutes(activeHours.open_time);
    closeMin = parseTimeToMinutes(activeHours.close_time);
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

  const startMin = parseTimeToMinutes(startTime);
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
  return {
    ok: true,
    startAtIso: manilaDateTimeToUtcIso(dateStr, startTime),
    endAtIso: manilaDateTimeToUtcIso(dateStr, endTime),
    endTime,
    settings,
  };
}
