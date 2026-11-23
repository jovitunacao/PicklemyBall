import { CourtStatus } from '../types/booking';
import { COURT_MAP_REGIONS } from '../config/courtMapRegions';

/**
 * STAGE 2 SIMULATED AVAILABILITY ENGINE
 * Strictly for interactive floor-plan demonstration before Supabase integration (Stages 3–4).
 */

export const OPERATING_START_HOUR = 6;  // 06:00 PHT
export const OPERATING_END_HOUR = 22;   // 22:00 PHT (last 1h slot starts 21:00)

export const SIMULATED_TIME_SLOTS: string[] = Array.from(
  { length: OPERATING_END_HOUR - OPERATING_START_HOUR },
  (_, idx) => `${String(OPERATING_START_HOUR + idx).padStart(2, '0')}:00`,
);

export interface SimulatedSlotOutcome {
  courtNumber: number;
  status: Exclude<CourtStatus, CourtStatus.SELECTED>;
  reason: string;
}

export interface SimulatedPriceBreakdown {
  hourlyRatePhp: number;
  peakHoursCount: number;
  standardHoursCount: number;
  totalPhp: number;
  rateLabel: string;
}

export interface CourtDaySlot {
  startTime: string;
  endTime: string;
  status: Exclude<CourtStatus, CourtStatus.SELECTED>;
  hourlyRatePhp: number;
}

function parseStartHour(startTime: string): number {
  const [hh] = startTime.split(':').map(Number);
  return Number.isFinite(hh) ? hh : 8;
}

export function formatEndTime(startTime: string, durationHours: number): string {
  const startHour = parseStartHour(startTime);
  const endHour = Math.min(OPERATING_END_HOUR, startHour + durationHours);
  return `${String(endHour).padStart(2, '0')}:00`;
}

/**
 * Returns simulated status for a single 1-hour block [hour, hour + 1) on a given YYYY-MM-DD date.
 * Deterministic so tests and UI interactions remain reproducible across re-renders.
 */
export function getSimulatedHourlyCourtStatus(
  courtNumber: number,
  dateStr: string,
  hour: number,
): Exclude<CourtStatus, CourtStatus.SELECTED> {
  // Ongoing simulated maintenance on Court 4 (morning) & Court 10 (all day on odd dates)
  const dayNum = Number(dateStr.split('-')[2] || '1');
  if (courtNumber === 4 && hour >= 6 && hour < 10) {
    return CourtStatus.MAINTENANCE;
  }
  if (courtNumber === 10 && dayNum % 2 === 1 && hour >= 12 && hour < 16) {
    return CourtStatus.MAINTENANCE;
  }

  // Deterministic pseudo-hash combining date, court, and hour
  const seed = (dayNum * 31 + courtNumber * 17 + hour * 13) % 23;

  // Higher occupancy during morning (7-9) and evening peak (17-21)
  const isPeak = (hour >= 17 && hour <= 20) || (hour >= 7 && hour <= 9);

  if (isPeak) {
    if (seed <= 7) return CourtStatus.BOOKED;
    if (seed === 8 || seed === 9) return CourtStatus.HELD;
    return CourtStatus.AVAILABLE;
  }

  if (seed <= 3) return CourtStatus.BOOKED;
  if (seed === 4) return CourtStatus.HELD;
  return CourtStatus.AVAILABLE;
}

/**
 * Evaluates half-open multi-hour interval [startTime, startTime + durationHours)
 * Priority of blocking states: maintenance > booked > held > available.
 */
export function getSimulatedCourtIntervalStatus(
  courtNumber: number,
  dateStr: string,
  startTime: string,
  durationHours: number,
): SimulatedSlotOutcome {
  const startHour = parseStartHour(startTime);
  const endHour = startHour + durationHours;

  if (endHour > OPERATING_END_HOUR) {
    return {
      courtNumber,
      status: CourtStatus.MAINTENANCE,
      reason: `Exceeds ${OPERATING_END_HOUR}:00 PHT closing time for a ${durationHours}h session.`,
    };
  }

  let hasBooked = false;
  let hasHeld = false;
  let hasMaintenance = false;
  let conflictHour: number | null = null;

  for (let h = startHour; h < endHour; h++) {
    const hourStatus = getSimulatedHourlyCourtStatus(courtNumber, dateStr, h);
    if (hourStatus === CourtStatus.MAINTENANCE) {
      hasMaintenance = true;
      conflictHour ??= h;
    } else if (hourStatus === CourtStatus.BOOKED) {
      hasBooked = true;
      conflictHour ??= h;
    } else if (hourStatus === CourtStatus.HELD) {
      hasHeld = true;
      conflictHour ??= h;
    }
  }

  const conflictLabel =
    conflictHour !== null
      ? `${String(conflictHour).padStart(2, '0')}:00–${String(conflictHour + 1).padStart(2, '0')}:00`
      : '';

  if (hasMaintenance) {
    return {
      courtNumber,
      status: CourtStatus.MAINTENANCE,
      reason: `Court ${courtNumber} is closed for maintenance during ${conflictLabel} (simulated).`,
    };
  }
  if (hasBooked) {
    return {
      courtNumber,
      status: CourtStatus.BOOKED,
      reason: `Court ${courtNumber} is already booked during ${conflictLabel} (simulated).`,
    };
  }
  if (hasHeld) {
    return {
      courtNumber,
      status: CourtStatus.HELD,
      reason: `Court ${courtNumber} is temporarily held by another player in checkout during ${conflictLabel} (simulated).`,
    };
  }

  return {
    courtNumber,
    status: CourtStatus.AVAILABLE,
    reason: `Available for ${startTime}–${formatEndTime(startTime, durationHours)} PHT (simulated).`,
  };
}

export function getAllCourtsIntervalStatus(
  dateStr: string,
  startTime: string,
  durationHours: number,
): Record<number, SimulatedSlotOutcome> {
  const result: Record<number, SimulatedSlotOutcome> = {};
  for (const region of COURT_MAP_REGIONS) {
    result[region.courtNumber] = getSimulatedCourtIntervalStatus(
      region.courtNumber,
      dateStr,
      startTime,
      durationHours,
    );
  }
  return result;
}

/**
 * Simulated Stage 2 PHP rate calculation (will be replaced by PostgreSQL pricing_rules in Stage 4).
 */
export function calculateSimulatedMockPrice(
  dateStr: string,
  startTime: string,
  durationHours: number,
): SimulatedPriceBreakdown {
  const startHour = parseStartHour(startTime);
  const parsedDate = new Date(`${dateStr}T12:00:00+08:00`);
  const dayOfWeek = Number.isNaN(parsedDate.getTime()) ? 1 : parsedDate.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const baseRate = isWeekend ? 400 : 350;
  const peakRate = isWeekend ? 500 : 450;

  let peakHoursCount = 0;
  let standardHoursCount = 0;
  let totalPhp = 0;

  for (let h = startHour; h < Math.min(OPERATING_END_HOUR, startHour + durationHours); h++) {
    const isPeak = h >= 17 && h < 21;
    if (isPeak) {
      peakHoursCount += 1;
      totalPhp += peakRate;
    } else {
      standardHoursCount += 1;
      totalPhp += baseRate;
    }
  }

  const effectiveHourly =
    durationHours > 0 ? Math.round(totalPhp / durationHours) : baseRate;

  const rateLabel =
    peakHoursCount > 0 && standardHoursCount > 0
      ? 'Mixed Standard + Peak (Simulated)'
      : peakHoursCount > 0
        ? `Peak Evening Rate${isWeekend ? ' · Weekend' : ''} (Simulated)`
        : `Standard Daytime Rate${isWeekend ? ' · Weekend' : ''} (Simulated)`;

  return {
    hourlyRatePhp: effectiveHourly,
    peakHoursCount,
    standardHoursCount,
    totalPhp,
    rateLabel,
  };
}

export function getSimulatedDayScheduleForCourt(
  courtNumber: number,
  dateStr: string,
): CourtDaySlot[] {
  return SIMULATED_TIME_SLOTS.map((slotStart) => {
    const status = getSimulatedHourlyCourtStatus(
      courtNumber,
      dateStr,
      parseStartHour(slotStart),
    );
    const price = calculateSimulatedMockPrice(dateStr, slotStart, 1);
    return {
      startTime: slotStart,
      endTime: formatEndTime(slotStart, 1),
      status,
      hourlyRatePhp: price.hourlyRatePhp,
    };
  });
}

export function formatPhp(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
