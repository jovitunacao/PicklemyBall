import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server';
import {
  assertValidReservationStatusTransition,
  generateOpaqueToken,
  generateUniqueBookingReference,
  hashSecretToken,
  SlidingWindowRateLimiter,
  timingSafeTokenMatches,
} from '../../server/bookingUtils';
import { calculateServerPricingQuote } from '../../server/pricingEngine';
import {
  addDaysToManilaDate,
  getManilaTodayDateString,
  intervalsOverlap,
  isBeyondAdvanceBookingLimit,
  isPastManilaDate,
  isPastManilaSlot,
  manilaDateTimeToUtcIso,
  utcIsoToManilaDateAndTime,
} from '../lib/manilaTime';
import type { PricingRuleRow } from '../types/database';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('Asia/Manila Timezone & Interval Math', () => {
  it('converts Asia/Manila local schedules accurately to UTC and back without DST drift', () => {
    const utcIso = manilaDateTimeToUtcIso('2026-11-25', '06:00');
    expect(utcIso).toBe('2026-11-24T22:00:00.000Z');

    const back = utcIsoToManilaDateAndTime(utcIso);
    expect(back).toEqual({ date: '2026-11-25', time: '06:00' });
  });

  it('rejects past dates, past slots on today, and dates beyond advance limit', () => {
    const fixedNow = new Date('2026-11-23T02:30:00.000Z'); // 10:30 PHT on 2026-11-23
    expect(getManilaTodayDateString(fixedNow)).toBe('2026-11-23');
    expect(isPastManilaDate('2026-11-22', fixedNow)).toBe(true);
    expect(isPastManilaDate('2026-11-23', fixedNow)).toBe(false);

    expect(isPastManilaSlot('2026-11-23', '10:00', fixedNow)).toBe(true);
    expect(isPastManilaSlot('2026-11-23', '11:00', fixedNow)).toBe(false);

    expect(isBeyondAdvanceBookingLimit('2026-12-24', 30, fixedNow)).toBe(true);
    expect(isBeyondAdvanceBookingLimit('2026-12-23', 30, fixedNow)).toBe(false);
  });

  it('handles half-open [start, end) intervals allowing adjacent touch without overlap', () => {
    const aStart = Date.parse(manilaDateTimeToUtcIso('2026-11-25', '08:00'));
    const aEnd = Date.parse(manilaDateTimeToUtcIso('2026-11-25', '09:00'));
    const adjStart = Date.parse(manilaDateTimeToUtcIso('2026-11-25', '09:00'));
    const adjEnd = Date.parse(manilaDateTimeToUtcIso('2026-11-25', '10:00'));

    expect(intervalsOverlap(aStart, aEnd, adjStart, adjEnd)).toBe(false);

    const overlapStart = Date.parse(manilaDateTimeToUtcIso('2026-11-25', '08:30'));
    expect(intervalsOverlap(aStart, aEnd, overlapStart, adjEnd)).toBe(true);
  });
});

describe('Server-Side Integer-Centavo Pricing Engine', () => {
  const sampleRules: PricingRuleRow[] = [
    {
      id: 'r1',
      facility_id: 'f1',
      court_id: null,
      name: 'Weekday Std',
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
      id: 'r2',
      facility_id: 'f1',
      court_id: null,
      name: 'Weekday Peak',
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
      id: 'r3',
      facility_id: 'f1',
      court_id: 'court-vip',
      name: 'VIP Court Override',
      rule_type: 'standard',
      day_scope: 'all',
      start_time: null,
      end_time: null,
      rate_centavos: 60000,
      discount_percent: 0,
      priority: 15,
      is_active: true,
      valid_from: null,
      valid_until: null,
    },
    {
      id: 'r4',
      facility_id: 'f1',
      court_id: null,
      name: 'Launch 10% Off',
      rule_type: 'promo',
      day_scope: 'all',
      start_time: '06:00:00',
      end_time: '17:00:00',
      rate_centavos: null,
      discount_percent: 10,
      priority: 50,
      is_active: true,
      valid_from: null,
      valid_until: null,
    },
  ];

  it('computes multi-hour spans, per-court precedence, promo discounts, and deposit centavos', () => {
    // 2026-11-25 is Wednesday: 16:00-18:00 = 1h standard (35000 - 10% = 31500) + 1h peak (45000)
    const quote = calculateServerPricingQuote({
      courtNumber: 1,
      courtId: 'court-01',
      baseHourlyRateCentavos: 35000,
      dateStr: '2026-11-25',
      startTime: '16:00',
      durationMinutes: 120,
      rules: sampleRules,
      depositEnabled: true,
      depositPercent: 50,
    });

    expect(quote.subtotalCentavos).toBe(80000);
    expect(quote.discountCentavos).toBe(3500);
    expect(quote.totalAmountCentavos).toBe(76500);
    expect(quote.depositRequiredCentavos).toBe(38250);

    // Per-court rule takes precedence over facility-wide rules
    const vipQuote = calculateServerPricingQuote({
      courtNumber: 5,
      courtId: 'court-vip',
      baseHourlyRateCentavos: 35000,
      dateStr: '2026-11-25',
      startTime: '18:00',
      durationMinutes: 60,
      rules: sampleRules,
    });
    expect(vipQuote.totalAmountCentavos).toBe(54000 + 6000); // 60000, promo doesn't apply at 18:00
  });
});

describe('Security, State Machine, Reference Generation & Rate Limiting', () => {
  it('generates collision-resistant PMB-YYYYMMDD-XXXX references and expands on collision', async () => {
    const seen = new Set<string>();
    let forcedCollisions = 0;
    const ref = await generateUniqueBookingReference('2026-11-25', (candidate) => {
      if (forcedCollisions < 8) {
        forcedCollisions += 1;
        return true; // simulate collision to verify expansion to 5-char suffix
      }
      return seen.has(candidate);
    });
    expect(ref).toMatch(/^PMB-20261125-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
  });

  it('verifies opaque token hashing in constant time', () => {
    const raw = generateOpaqueToken();
    const hash = hashSecretToken(raw);
    expect(timingSafeTokenMatches(raw, hash)).toBe(true);
    expect(timingSafeTokenMatches(`${raw}x`, hash)).toBe(false);
  });

  it('blocks reservation confirmation without verified payment evidence and enforces state machine edges', () => {
    expect(() =>
      assertValidReservationStatusTransition('pending_payment', 'confirmed', {
        hasVerifiedPaymentEvidence: false,
      }),
    ).toThrow(/PAYMENT_VERIFICATION_REQUIRED/);

    expect(() =>
      assertValidReservationStatusTransition('cancelled', 'confirmed', {
        hasVerifiedPaymentEvidence: true,
      }),
    ).toThrow(/INVALID_STATUS_TRANSITION/);

    expect(() =>
      assertValidReservationStatusTransition('pending_payment', 'cancelled'),
    ).not.toThrow();
  });

  it('enforces sliding-window rate limits cleanly', () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 2);
    expect(limiter.consume('ip1:/api/holds', 1000).allowed).toBe(true);
    expect(limiter.consume('ip1:/api/holds', 2000).allowed).toBe(true);
    const blocked = limiter.consume('ip1:/api/holds', 3000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('Stage 4 Express API Endpoints Validation & Safeguards', () => {
  it('rejects past dates and outside-operating-hours requests on /api/availability', async () => {
    const resPast = await fetch(
      `${baseUrl}/api/availability?date=2020-01-01&startTime=08:00&durationMinutes=60`,
    );
    expect(resPast.status).toBe(400);
    const pastBody = await resPast.json();
    expect(pastBody.code).toBe('PAST_DATE_REJECTED');

    const futureDate = addDaysToManilaDate(getManilaTodayDateString(), 3);
    const resHours = await fetch(
      `${baseUrl}/api/availability?date=${futureDate}&startTime=21:00&durationMinutes=120`,
    );
    expect(resHours.status).toBe(400);
    const hoursBody = await resHours.json();
    expect(hoursBody.code).toBe('OUTSIDE_OPERATING_HOURS');
  });

  it('returns 14 courts cleanly for valid future intervals without customer PII', async () => {
    const futureDate = addDaysToManilaDate(getManilaTodayDateString(), 2);
    const res = await fetch(
      `${baseUrl}/api/availability?date=${futureDate}&startTime=08:00&durationMinutes=60`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.courts).toHaveLength(14);
    expect(JSON.stringify(body)).not.toContain('@');
  });

  it('rejects payment confirmation attempts in Stage 4 with 403 PAYMENT_VERIFICATION_REQUIRED', async () => {
    const res = await fetch(`${baseUrl}/api/bookings/PMB-20261125-ABCD/confirm-payment`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('PAYMENT_VERIFICATION_REQUIRED');
  });

  it('rejects unauthenticated staff admin calls and invalid guest hold inputs', async () => {
    const adminRes = await fetch(`${baseUrl}/api/admin/reservations`);
    expect([401, 503]).toContain(adminRes.status);

    const badHold = await fetch(`${baseUrl}/api/holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courtNumber: 99,
        date: '2026-11-25',
        startTime: '08:00',
        durationMinutes: 60,
        customerName: 'A',
        customerMobile: '12',
        customerEmail: 'bad',
      }),
    });
    expect(badHold.status).toBe(400);
  });

  it('requires lookup token in addition to booking reference on /api/bookings/lookup', async () => {
    const missingToken = await fetch(`${baseUrl}/api/bookings/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingReference: 'PMB-20261125-A4K9' }),
    });
    expect(missingToken.status).toBe(400);
  });
});
