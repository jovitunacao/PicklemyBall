import { isManilaWeekend, parseTimeToMinutes } from './manilaTime.ts';

export interface EdgePricingRuleRow {
  id: string;
  facility_id: string;
  court_id: string | null;
  name: string;
  rule_type: 'standard' | 'weekend' | 'peak' | 'promo';
  day_scope: 'all' | 'weekday' | 'weekend';
  start_time: string | null;
  end_time: string | null;
  rate_centavos: number | null;
  discount_percent: number;
  priority: number;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
}

export interface EdgeHourlyPricingLineItem {
  hourLabel: string;
  baseRateCentavos: number;
  discountPercent: number;
  finalRateCentavos: number;
  appliedRuleName: string;
}

export interface EdgePricingQuote {
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
  lineItems: EdgeHourlyPricingLineItem[];
  isDevelopmentDefaultRates: boolean;
}

export function calculateEdgePricingQuote(params: {
  courtNumber: number;
  courtId: string;
  baseHourlyRateCentavos: number;
  dateStr: string;
  startTime: string;
  durationMinutes: number;
  rules: EdgePricingRuleRow[];
  depositEnabled?: boolean;
  depositPercent?: number;
}): EdgePricingQuote {
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
  const totalBlocks = durationMinutes / 60;
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

  const lineItems: EdgeHourlyPricingLineItem[] = [];
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
  const effectiveHourlyRateCentavos = Math.round((totalAmountCentavos * 60) / durationMinutes);
  const clampedDepositPct = depositEnabled ? Math.max(10, Math.min(100, depositPercent)) : 100;
  const depositRequiredCentavos = Math.round((totalAmountCentavos * clampedDepositPct) / 100);

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
    isDevelopmentDefaultRates: true,
  };
}
