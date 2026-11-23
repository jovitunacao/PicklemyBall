export const MANILA_TIMEZONE = 'Asia/Manila';
export const OPERATING_OPEN_HOUR = 6;
export const OPERATING_CLOSE_HOUR = 22;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: MANILA_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function getManilaTodayDateString(now: Date = new Date()): string {
  return dateFormatter.format(now);
}

export function addDaysToManilaDate(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }
  const utcMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  const dt = new Date(utcMs);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDateString(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

export function isValidTimeString(timeStr: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh >= 0 && hh <= 23 && (mm === 0 || mm === 30);
}

export function isPastManilaDate(dateStr: string, now: Date = new Date()): boolean {
  if (!isValidDateString(dateStr)) return true;
  return dateStr < getManilaTodayDateString(now);
}

export function isBeyondAdvanceBookingLimit(
  dateStr: string,
  maxAdvanceDays: number,
  now: Date = new Date(),
): boolean {
  if (!isValidDateString(dateStr)) return true;
  const maxDate = addDaysToManilaDate(getManilaTodayDateString(now), maxAdvanceDays);
  return dateStr > maxDate;
}

export function manilaDateTimeToUtcIso(dateStr: string, timeStr: string): string {
  if (!isValidDateString(dateStr)) {
    throw new Error(`Invalid Manila date: ${dateStr}`);
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(timeStr)) {
    throw new Error(`Invalid Manila time: ${timeStr}`);
  }
  const normalizedTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  const parsed = new Date(`${dateStr}T${normalizedTime}+08:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unable to parse Manila timestamp: ${dateStr} ${timeStr}`);
  }
  return parsed.toISOString();
}

export function utcIsoToManilaDateAndTime(isoStr: string): { date: string; time: string } {
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO timestamp: ${isoStr}`);
  }
  const date = dateFormatter.format(dt);
  const rawTime = timeFormatter.format(dt);
  const time = rawTime.startsWith('24:') ? `00:${rawTime.slice(3)}` : rawTime;
  return { date, time };
}

export function isPastManilaSlot(
  dateStr: string,
  startTime: string,
  now: Date = new Date(),
): boolean {
  if (!isValidDateString(dateStr) || !isValidTimeString(startTime)) return true;
  const slotUtcMs = Date.parse(manilaDateTimeToUtcIso(dateStr, startTime));
  return slotUtcMs <= now.getTime();
}

export function getManilaDayOfWeek(dateStr: string): number {
  const dt = new Date(`${dateStr}T12:00:00+08:00`);
  return dt.getUTCDay();
}

export function isManilaWeekend(dateStr: string): boolean {
  const dow = getManilaDayOfWeek(dateStr);
  return dow === 0 || dow === 6;
}

export function addMinutesToTime(startTime: string, durationMinutes: number): string {
  const [hh, mm] = startTime.split(':').map(Number);
  const total = hh * 60 + mm + durationMinutes;
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export function parseTimeToMinutes(timeStr: string): number {
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh * 60 + (mm || 0);
}
