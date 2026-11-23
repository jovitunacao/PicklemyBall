import type { PricingRuleRow } from '../src/types/database.ts';
import { isManilaWeekend } from '../src/lib/manilaTime.ts';

export interface HourlyPricingLineItem {
  hourLabel: string;
  baseRateCentavos: number;
  discountPercent: number;
  finalRateCentavos: number;
  appliedRuleName: string;
}

export interface ServerPricingQuote {
  currency: 'PHP';
  courtNumber: number;
  dateStr: string;
  startTime: string;
  durationMinutes: number;
  effectiveHourlyRateCentavos: number;
  subtotalCentavos: number;
  discountCentavos: number;
  totalAmountCentavos: number;
  depositRequiredCentavos: number;
  depositPercent: number;
  lineItems: HourlyPricingLineItem[];
  isDevelopmentDefaultRates: boolean;
}

function parseTimeToMinutes(timeStr: string): number {
  const [hh, mm] = timeStr.split(':').map(Number);
  return hh * 60 + (mm || 0);
}

/**
 * Authoritative server-side pricing engine working strictly in integer centavos.
 * Supports per-court overrides, weekday/weekend scopes, peak windows, multi-hour spans,
 * active promotional percentage discounts, and configurable deposits.
 */
export function calculateServerPricingQuote(params: {
  courtNumber: number;
  courtId: string;
  baseHourlyRateCentavos: number;
  dateStr: string;
  startTime: string;
  durationMinutes: number;
  rules: PricingRuleRow[];
  depositEnabled?: boolean;
  depositPercent?: number;
}): ServerPricingQuote {
  const {
    courtNumber,
    courtId,
    baseHourlyRateCentavos,
    dateStr,
    startTime,
    durationMinutes,
    rules,
    depositEnabled = false,
    depositPercent = 100,
  } = params;

  if (durationMinutes <= 0 || durationMinutes % 30 !== 0) {
    throw new Error('INVALID_DURATION: Duration must be a positive multiple of 30 minutes.');
  }

  const weekend = isManilaWeekend(dateStr);
  const startMinutes = parseTimeToMinutes(startTime);
  const stepMinutes = 60;
  const totalBlocks = durationMinutes / stepMinutes;

  // Support half-hour intervals cleanly if 30m granularity is enabled later
  const sliceMinutes = Number.isInteger(totalBlocks) ? 60 : 30;
  const sliceCount = durationMinutes / sliceMinutes;

  const activeRules = rules.filter((r) => {
    if (!r.is_active) return false;
    if (r.court_id && r.court_id !== courtId) return false;
    if (r.valid_from && dateStr < r.valid_from) return false;
    if (r.valid_until && dateStr > r.valid_until) return false;
    if (r.day_scope === 'weekday' && weekend) return false;
    if (r.day_scope === 'weekend' && !weekend) return false;
    return true;
  });

  const lineItems: HourlyPricingLineItem[] = [];
  let subtotalCentavos = 0;
  let totalAmountCentavos = 0;

  for (let i = 0; i < sliceCount; i++) {
    const sliceStartMin = startMinutes + i * sliceMinutes;
    const sliceHourStr = `${String(Math.floor(sliceStartMin / 60)).padStart(2, '0')}:${String(
      sliceStartMin % 60,
    ).padStart(2, '0')}`;
    const sliceEndMin = sliceStartMin + sliceMinutes;
    const sliceEndStr = `${String(Math.floor(sliceEndMin / 60)).padStart(2, '0')}:${String(
      sliceEndMin % 60,
    ).padStart(2, '0')}`;

    const matchingRateRules = activeRules
      .filter((r) => {
        if (r.rule_type === 'promo' || r.rate_centavos === null) return false;
        if (!r.start_time || !r.end_time) return true;
        const rStart = parseTimeToMinutes(r.start_time);
        const rEnd = parseTimeToMinutes(r.end_time);
        return sliceStartMin >= rStart && sliceStartMin < rEnd;
      })
      .sort((a, b) => {
        // Per-court rule takes precedence over facility-wide rule at equal priority
        const courtBonusA = a.court_id ? 1000 : 0;
        const courtBonusB = b.court_id ? 1000 : 0;
        return b.priority + courtBonusB - (a.priority + courtBonusA);
      });

    const chosenRateRule = matchingRateRules[0];
    const hourlyCentavos = chosenRateRule?.rate_centavos ?? baseHourlyRateCentavos;
    const baseSliceCentavos = Math.round((hourlyCentavos * sliceMinutes) / 60);

    const matchingPromo = activeRules
      .filter((r) => {
        if (r.rule_type !== 'promo' || r.discount_percent <= 0) return false;
        if (!r.start_time || !r.end_time) return true;
        const rStart = parseTimeToMinutes(r.start_time);
        const rEnd = parseTimeToMinutes(r.end_time);
        return sliceStartMin >= rStart && sliceStartMin < rEnd;
      })
      .sort((a, b) => b.priority - a.priority)[0];

    const discountPercent = matchingPromo?.discount_percent ?? 0;
    const finalSliceCentavos = Math.round(
      (baseSliceCentavos * (100 - discountPercent)) / 100,
    );

    subtotalCentavos += baseSliceCentavos;
    totalAmountCentavos += finalSliceCentavos;

    lineItems.push({
      hourLabel: `${sliceHourStr}–${sliceEndStr}`,
      baseRateCentavos: baseSliceCentavos,
      discountPercent,
      finalRateCentavos: finalSliceCentavos,
      appliedRuleName: chosenRateRule?.name ?? 'Base Court Rate',
    });
  }

  const discountCentavos = subtotalCentavos - totalAmountCentavos;
  const effectiveHourlyRateCentavos = Math.round(
    (totalAmountCentavos * 60) / durationMinutes,
  );
  const clampedDepositPct = depositEnabled
    ? Math.max(10, Math.min(100, depositPercent))
    : 100;
  const depositRequiredCentavos = Math.round(
    (totalAmountCentavos * clampedDepositPct) / 100,
  );

  const hasCustomConfiguredRules =
    rules.length > 0 && !rules.some((r) => /dev default/i.test(r.name));

  return {
    currency: 'PHP',
    courtNumber,
    dateStr,
    startTime,
    durationMinutes,
    effectiveHourlyRateCentavos,
    subtotalCentavos,
    discountCentavos,
    totalAmountCentavos,
    depositRequiredCentavos,
    depositPercent: clampedDepositPct,
    lineItems,
    isDevelopmentDefaultRates: !hasCustomConfiguredRules,
  };
}
