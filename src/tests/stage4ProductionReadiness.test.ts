import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server';
import { buildConfirmationEmailContent, sendBookingConfirmationEmail } from '../../server/emailService';
import { calculateServerPricingQuote } from '../../server/pricingEngine';
import {
  createInMemoryAtomicTestStore,
  createQrCheckInManager,
  createSupabaseQrDurabilityStore,
  issueServerQrCheckInToken,
  resetQrCheckInStoreForTests,
  revokeQrCheckInTokens,
  validateQrCheckInSecret,
  verifyAndConsumeQrCheckInToken,
  verifySignedCheckInClaims,
} from '../../server/qrCheckInService';
import {
  buildHitPayHmacSourceString,
  formatCentavosToHitPayAmount,
  STAGE5_HITPAY_PLAN,
  verifyHitPayWebhookHmac,
} from '../lib/hitpayPlan';
import {
  buildQrCheckInPayload,
  generateQrPassSvg,
  isQrCheckInEligible,
  parseQrCheckInInput,
} from '../lib/qrCheckIn';
import { canPerformStaffAction, type StaffAction } from '../services/adminAuth';
import { sanitizePricingRuleDisplayName } from '../services/facilityConfigApi';
import type { PricingRuleRow } from '../types/database';

let tmpDistDir: string;
let prodServer: http.Server;
let prodBaseUrl: string;

beforeAll(async () => {
  tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmb-spa-dist-'));
  fs.writeFileSync(
    path.join(tmpDistDir, 'index.html'),
    '<!doctype html><html><head><title>Pick My Ball SPA</title></head><body><div id="root"></div></body></html>',
    'utf8',
  );

  const app = createApp({ serveStaticDir: tmpDistDir });
  await new Promise<void>((resolve) => {
    prodServer = app.listen(0, '127.0.0.1', () => {
      const addr = prodServer.address();
      if (addr && typeof addr === 'object') {
        prodBaseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    prodServer.close((err) => (err ? reject(err) : resolve()));
  });
  fs.rmSync(tmpDistDir, { recursive: true, force: true });
});

describe('Production SPA Routing Fallback & Cloudflare _redirects', () => {
  const spaRoutes = [
    '/',
    '/book',
    '/availability',
    '/rates',
    '/lookup',
    '/admin',
    '/admin/dashboard',
    '/admin/login',
    '/admin/pricing',
    '/admin/operating-hours',
    '/admin/check-in',
  ];

  it('serves index.html HTTP 200 on direct GET requests across all SPA routes (no Cannot GET /...)', async () => {
    for (const route of spaRoutes) {
      const res = await fetch(`${prodBaseUrl}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('Pick My Ball SPA');
    }
  });

  it('returns JSON 404 for unknown /api/* paths and text 404 for missing file extensions', async () => {
    const apiRes = await fetch(`${prodBaseUrl}/api/non-existent-endpoint`);
    expect(apiRes.status).toBe(404);
    const apiJson = await apiRes.json();
    expect(apiJson.code).toBe('API_NOT_FOUND');

    const assetRes = await fetch(`${prodBaseUrl}/assets/non-existent-chunk.js`);
    expect(assetRes.status).toBe(404);
  });
});

describe('Configurable Production Rates (No Hardcoded Dev Default Labels)', () => {
  it('marks quotes as production-configured when custom facility rules exist and strips legacy suffixes cleanly', () => {
    expect(sanitizePricingRuleDisplayName('Weekday Standard (Dev Default)')).toBe('Weekday Standard');
    expect(sanitizePricingRuleDisplayName('Weekend Peak Rate')).toBe('Weekend Peak Rate');

    const customRules: PricingRuleRow[] = [
      {
        id: 'prod-1',
        facility_id: 'f1',
        court_id: null,
        name: 'Morning Member Standard',
        rule_type: 'standard',
        day_scope: 'all',
        start_time: '06:00:00',
        end_time: '17:00:00',
        rate_centavos: 40000,
        discount_percent: 0,
        priority: 10,
        is_active: true,
        valid_from: null,
        valid_until: null,
      },
    ];

    const customQuote = calculateServerPricingQuote({
      courtNumber: 1,
      courtId: 'c1',
      baseHourlyRateCentavos: 40000,
      dateStr: '2026-11-26',
      startTime: '08:00',
      durationMinutes: 60,
      rules: customRules,
    });
    expect(customQuote.isDevelopmentDefaultRates).toBe(false);
    expect(customQuote.totalAmountCentavos).toBe(40000);

    const emptyQuote = calculateServerPricingQuote({
      courtNumber: 1,
      courtId: 'c1',
      baseHourlyRateCentavos: 35000,
      dateStr: '2026-11-26',
      startTime: '08:00',
      durationMinutes: 60,
      rules: [],
    });
    expect(emptyQuote.isDevelopmentDefaultRates).toBe(true);
  });
});

describe('Staff Role-Based Access Control (Super Admin, Manager, Reception Staff)', () => {
  const allActions: StaffAction[] = [
    'viewReservations',
    'createWalkInHold',
    'cancelPendingReservation',
    'cancelConfirmedReservation',
    'viewMaintenance',
    'manageMaintenance',
    'managePricing',
    'manageOperatingHours',
    'viewAuditLogs',
    'verifyQrCheckIn',
    'manageStaffProfiles',
  ];

  it('restricts reception_staff to front-desk actions while granting manager operational controls and super_admin full control', () => {
    expect(canPerformStaffAction('reception_staff', 'viewReservations')).toBe(true);
    expect(canPerformStaffAction('reception_staff', 'createWalkInHold')).toBe(true);
    expect(canPerformStaffAction('reception_staff', 'verifyQrCheckIn')).toBe(true);
    expect(canPerformStaffAction('reception_staff', 'cancelConfirmedReservation')).toBe(false);
    expect(canPerformStaffAction('reception_staff', 'managePricing')).toBe(false);
    expect(canPerformStaffAction('reception_staff', 'manageOperatingHours')).toBe(false);
    expect(canPerformStaffAction('reception_staff', 'manageStaffProfiles')).toBe(false);

    expect(canPerformStaffAction('manager', 'managePricing')).toBe(true);
    expect(canPerformStaffAction('manager', 'manageOperatingHours')).toBe(true);
    expect(canPerformStaffAction('manager', 'cancelConfirmedReservation')).toBe(true);
    expect(canPerformStaffAction('manager', 'viewAuditLogs')).toBe(true);
    expect(canPerformStaffAction('manager', 'manageStaffProfiles')).toBe(false);

    for (const action of allActions) {
      expect(canPerformStaffAction('super_admin', action)).toBe(true);
    }
  });
});

describe('QR Check-In Pass Eligibility, Server-Signed Token Isolation & SVG Rendering', () => {
  beforeEach(() => {
    resetQrCheckInStoreForTests();
  });

  it('strictly unlocks QR passes only for confirmed + paid bookings', async () => {
    expect(isQrCheckInEligible('confirmed', 'paid')).toBe(true);
    expect(isQrCheckInEligible('pending_payment', 'created')).toBe(false);
    expect(isQrCheckInEligible('pending_payment', 'pending')).toBe(false);
    expect(isQrCheckInEligible('cancelled', 'paid')).toBe(false);
    expect(isQrCheckInEligible('expired', 'expired')).toBe(false);
    expect(isQrCheckInEligible('payment_review_required', 'paid')).toBe(false);

    const unpaidIssue = await issueServerQrCheckInToken({
      bookingReference: 'PMB-20261128-AB12',
      courtNumber: 7,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T01:00:00.000Z',
      reservationStatus: 'pending_payment',
      paymentStatus: 'created',
      nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
    });
    expect(unpaidIssue.ok).toBe(false);
    if (!unpaidIssue.ok) {
      expect(unpaidIssue.statusCode).toBe(403);
      expect(unpaidIssue.code).toBe('QR_NOT_ELIGIBLE');
    }
  });

  it('never embeds lookupToken in generated QR payloads, decoded claims, or SVG markup', async () => {
    const privateLookupToken = 'PRIVATE_LOOKUP_SECRET_DO_NOT_EMBED_9482a1f7';

    // Client-side payload builder & SVG generator must refuse raw lookup tokens or legacy URIs
    expect(() => buildQrCheckInPayload({ checkInToken: privateLookupToken })).toThrow(
      /INVALID_CHECKIN_TOKEN/,
    );
    await expect(
      generateQrPassSvg(
        `pmb://astoria-regency/checkin?ref=PMB-20261128-AB12&token=${privateLookupToken}&court=7`,
      ),
    ).rejects.toThrow(/INVALID_QR_CHECKIN_PAYLOAD/);

    // Server issues a dedicated signed chk_v1 check-in token (with zero reference to lookupToken)
    const nowMs = Date.parse('2026-11-28T00:15:00.000Z');
    const issued = await issueServerQrCheckInToken({
      bookingReference: 'PMB-20261128-AB12',
      courtNumber: 7,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T01:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const { checkInToken, qrPayload } = issued.data;
    expect(checkInToken.startsWith('chk_v1.')).toBe(true);
    expect(qrPayload).toBe(buildQrCheckInPayload({ checkInToken }));

    // Assert lookupToken NEVER appears in checkInToken, qrPayload, decoded claims, or SVG XML
    expect(checkInToken).not.toContain(privateLookupToken);
    expect(qrPayload).not.toContain(privateLookupToken);
    expect(qrPayload).not.toContain('token=');
    expect(qrPayload).not.toContain('@');

    const claimsPart = checkInToken.split('.')[1];
    const decodedClaimsRaw = Buffer.from(claimsPart, 'base64url').toString('utf8');
    expect(decodedClaimsRaw).not.toContain(privateLookupToken);
    const decodedClaims = JSON.parse(decodedClaimsRaw);
    expect(decodedClaims).toMatchObject({
      v: 1,
      typ: 'pmb_qr_checkin',
      ref: 'PMB-20261128-AB12',
      court: 7,
    });
    expect(decodedClaims).not.toHaveProperty('lookupToken');

    // Client parser rejects legacy ?token= URIs and extracts dedicated chk_v1 tokens
    expect(
      parseQrCheckInInput(
        `pmb://astoria-regency/checkin?ref=PMB-20261128-AB12&token=${privateLookupToken}`,
      ),
    ).toEqual({
      checkInToken: null,
      rejectedLegacyFormat: true,
    });
    expect(parseQrCheckInInput(qrPayload)).toEqual({
      checkInToken,
      rejectedLegacyFormat: false,
    });

    const svg = await generateQrPassSvg(qrPayload);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain(privateLookupToken);
  });

  it('enforces HMAC signatures, expiry, single-use redemption, revocation, and staff auth', async () => {
    const issuedAt = Date.parse('2026-11-28T00:05:00.000Z');
    const endAt = '2026-11-28T01:00:00.000Z'; // Grace expires at 02:00:00Z
    const issued = await issueServerQrCheckInToken({
      bookingReference: 'PMB-20261128-ZX99',
      courtNumber: 3,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: endAt,
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs: issuedAt,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    // Tampered token signature must be rejected (401)
    const parts = issued.data.checkInToken.split('.');
    const forgedSig = `${parts[2].slice(0, -2)}AA`;
    const tamperedToken = `${parts[0]}.${parts[1]}.${forgedSig}`;
    const tamperRes = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: tamperedToken,
      staffUserId: 'staff-1',
      nowMs: issuedAt + 1000,
    });
    expect(tamperRes.ok).toBe(false);
    if (!tamperRes.ok) {
      expect(tamperRes.statusCode).toBe(401);
      expect(tamperRes.code).toBe('INVALID_CHECKIN_SIGNATURE');
    }

    // Legacy ?token= QR format must be rejected by server verifier (400)
    const legacyRes = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: 'pmb://astoria-regency/checkin?ref=PMB-20261128-ZX99&token=secret123',
      staffUserId: 'staff-1',
      nowMs: issuedAt + 1000,
    });
    expect(legacyRes.ok).toBe(false);
    if (!legacyRes.ok) {
      expect(legacyRes.statusCode).toBe(400);
      expect(legacyRes.code).toBe('UNSUPPORTED_LEGACY_QR_FORMAT');
    }

    // Expired token (after slot end + 60m grace window) must be rejected (410)
    const expiredRes = verifySignedCheckInClaims(
      issued.data.checkInToken,
      Date.parse('2026-11-28T02:05:00.000Z'),
    );
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.statusCode).toBe(410);
      expect(expiredRes.code).toBe('CHECKIN_TOKEN_EXPIRED');
    }

    // Non-consuming verification preview succeeds, followed by single-use check-in redemption
    const previewRes = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: issued.data.qrPayload,
      consume: false,
      staffUserId: 'staff-1',
      nowMs: issuedAt + 5000,
    });
    expect(previewRes.ok).toBe(true);
    if (previewRes.ok) {
      expect(previewRes.data.consumed).toBe(false);
    }

    const redeemRes = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: issued.data.qrPayload,
      consume: true,
      staffUserId: 'staff-1',
      nowMs: issuedAt + 10_000,
    });
    expect(redeemRes.ok).toBe(true);
    if (redeemRes.ok) {
      expect(redeemRes.data.consumed).toBe(true);
      expect(redeemRes.data.bookingReference).toBe('PMB-20261128-ZX99');
    }

    // Replay / second scan must be blocked (409)
    const replayRes = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: issued.data.qrPayload,
      consume: true,
      staffUserId: 'staff-1',
      nowMs: issuedAt + 15_000,
    });
    expect(replayRes.ok).toBe(false);
    if (!replayRes.ok) {
      expect(replayRes.statusCode).toBe(409);
      expect(replayRes.code).toBe('CHECKIN_ALREADY_REDEEMED');
    }

    // Separate booking token revoked by staff must be blocked (403)
    const issued2 = await issueServerQrCheckInToken({
      bookingReference: 'PMB-20261128-RV01',
      courtNumber: 9,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: endAt,
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs: issuedAt,
    });
    expect(issued2.ok).toBe(true);
    if (!issued2.ok) return;

    const revRes = await revokeQrCheckInTokens({
      qrPayloadOrToken: issued2.data.qrPayload,
      reason: 'guest_reported_compromised_screenshot',
      permanent: true,
      staffUserId: 'manager-1',
      nowMs: issuedAt + 2000,
    });
    expect(revRes.ok).toBe(true);

    const postRevokeVerify = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: issued2.data.qrPayload,
      staffUserId: 'staff-1',
      nowMs: issuedAt + 3000,
    });
    expect(postRevokeVerify.ok).toBe(false);
    if (!postRevokeVerify.ok) {
      expect(postRevokeVerify.statusCode).toBe(403);
      expect(postRevokeVerify.code).toBe('CHECKIN_TOKEN_REVOKED');
    }

    // Unauthenticated requests to staff check-in endpoints must fail closed (401)
    const unauthVerify = await fetch(`${prodBaseUrl}/api/admin/check-in/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrPayloadOrToken: issued.data.qrPayload }),
    });
    expect(unauthVerify.status).toBe(401);

    const unauthRevoke = await fetch(`${prodBaseUrl}/api/admin/check-in/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingReference: 'PMB-20261128-RV01', reason: 'test' }),
    });
    expect(unauthRevoke.status).toBe(401);
  });

  it('requires a persistent, strong QR_CHECKIN_SECRET outside tests and rejects weak or missing secrets with zero fallback', async () => {
    const missingNonTest = validateQrCheckInSecret({
      secretOverride: '',
      allowTestEphemeralFallback: false,
    });
    expect(missingNonTest.ok).toBe(false);
    if (!missingNonTest.ok) {
      expect(missingNonTest.statusCode).toBe(503);
      expect(missingNonTest.code).toBe('QR_CHECKIN_SECRET_MISSING');
    }

    const shortSecret = validateQrCheckInSecret({
      secretOverride: 'short-secret-under-32-chars',
      allowTestEphemeralFallback: false,
    });
    expect(shortSecret.ok).toBe(false);
    if (!shortSecret.ok) {
      expect(shortSecret.statusCode).toBe(503);
      expect(shortSecret.code).toBe('QR_CHECKIN_SECRET_WEAK');
    }

    const placeholderSecret = validateQrCheckInSecret({
      secretOverride: 'MY_QR_CHECKIN_SECRET_PLACEHOLDER_1234567890',
      allowTestEphemeralFallback: false,
    });
    expect(placeholderSecret.ok).toBe(false);
    if (!placeholderSecret.ok) {
      expect(placeholderSecret.code).toBe('QR_CHECKIN_SECRET_WEAK');
    }

    const lowEntropySecret = validateQrCheckInSecret({
      secretOverride: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      allowTestEphemeralFallback: false,
    });
    expect(lowEntropySecret.ok).toBe(false);
    if (!lowEntropySecret.ok) {
      expect(lowEntropySecret.code).toBe('QR_CHECKIN_SECRET_WEAK');
    }

    // Refuses issuance & verification when non-test secret is absent
    const prodInstanceMissingSecret = createQrCheckInManager({
      secretOverride: '',
      allowTestEphemeralFallback: false,
      requireDurableStore: true,
    });
    const deniedIssue = await prodInstanceMissingSecret.issue({
      bookingReference: 'PMB-20261128-N0K1',
      courtNumber: 2,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T01:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
    });
    expect(deniedIssue.ok).toBe(false);
    if (!deniedIssue.ok) {
      expect(deniedIssue.statusCode).toBe(503);
      expect(deniedIssue.code).toBe('QR_CHECKIN_SECRET_MISSING');
    }

    // Fails closed if durable Supabase client/store is missing outside test fallback
    const strongSecret = 'pK9xR2vQ7mZ4wL8nB3cT6yF1jH5dG0sA_9eW2qU7i';
    const prodInstanceMissingDb = createQrCheckInManager({
      secretOverride: strongSecret,
      allowTestEphemeralFallback: false,
      durabilityStore: null,
      requireDurableStore: true,
    });
    const issued = await prodInstanceMissingDb.issue({
      bookingReference: 'PMB-20261128-N0D8',
      courtNumber: 2,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T01:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const verifyNoDb = await prodInstanceMissingDb.verifyOrRedeem({
      qrPayloadOrToken: issued.data.qrPayload,
      staffUserId: 'staff-1',
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(verifyNoDb.ok).toBe(false);
    if (!verifyNoDb.ok) {
      expect(verifyNoDb.statusCode).toBe(503);
      expect(verifyNoDb.code).toBe('DURABLE_STORE_UNAVAILABLE');
    }
  });

  it('survives restarts & multi-instance Cloud Run scaling, serializes concurrent redemptions, and propagates revocations', async () => {
    const persistentSecret = 'X7nP4qK9vR2mL8wB5cT1yF6jH3dG0sA_4zW9eU2i';
    const otherSecret = 'M3bV8cZ5xN1kJ7hG4fD9sA2pO6iU0yT_8rE3wQ5z';
    const nowMs = Date.parse('2026-11-28T00:15:00.000Z');

    const sharedDbStore = createInMemoryAtomicTestStore([
      {
        bookingReference: 'PMB-20261128-RACE',
        courtNumber: 5,
        customerName: 'Multi Instance Player',
        status: 'confirmed',
        paymentStatus: 'paid',
        startAtIso: '2026-11-28T00:00:00.000Z',
        endAtIso: '2026-11-28T02:00:00.000Z',
      },
      {
        bookingReference: 'PMB-20261128-REVK',
        courtNumber: 6,
        customerName: 'Revoked Player',
        status: 'confirmed',
        paymentStatus: 'paid',
        startAtIso: '2026-11-28T00:00:00.000Z',
        endAtIso: '2026-11-28T02:00:00.000Z',
      },
    ]);

    // Cloud Run Instance A issues QR pass, then disappears (process restart / different replica)
    const instanceA = createQrCheckInManager({
      secretOverride: persistentSecret,
      allowTestEphemeralFallback: false,
      durabilityStore: sharedDbStore,
      requireDurableStore: true,
    });
    const issuedRace = await instanceA.issue({
      bookingReference: 'PMB-20261128-RACE',
      courtNumber: 5,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T02:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs,
    });
    expect(issuedRace.ok).toBe(true);
    if (!issuedRace.ok) return;

    // Fresh Instance B & Instance C (no shared local memory, only shared secret + shared durable DB)
    const instanceB = createQrCheckInManager({
      secretOverride: persistentSecret,
      allowTestEphemeralFallback: false,
      durabilityStore: sharedDbStore,
      requireDurableStore: true,
    });
    const instanceWithWrongSecret = createQrCheckInManager({
      secretOverride: otherSecret,
      allowTestEphemeralFallback: false,
      durabilityStore: sharedDbStore,
      requireDurableStore: true,
    });

    // Wrong persistent secret must fail signature verification
    const mismatchRes = await instanceWithWrongSecret.verifyOrRedeem({
      qrPayloadOrToken: issuedRace.data.qrPayload,
      staffUserId: 'staff-c',
      nowMs: nowMs + 1000,
    });
    expect(mismatchRes.ok).toBe(false);
    if (!mismatchRes.ok) {
      expect(mismatchRes.statusCode).toBe(401);
      expect(mismatchRes.code).toBe('INVALID_CHECKIN_SIGNATURE');
    }

    // 12 concurrent redemption requests fired simultaneously across Instance A and Instance B
    const concurrentAttempts = Array.from({ length: 12 }, (_, idx) => {
      const targetInstance = idx % 2 === 0 ? instanceA : instanceB;
      return targetInstance.verifyOrRedeem({
        qrPayloadOrToken: issuedRace.data.qrPayload,
        consume: true,
        staffUserId: `staff-${idx}`,
        nowMs: nowMs + 2000 + idx,
      });
    });

    const results = await Promise.all(concurrentAttempts);
    const winners = results.filter((r) => r.ok && r.data.consumed);
    const conflicts = results.filter((r) => !r.ok && r.code === 'CHECKIN_ALREADY_REDEEMED');

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(11);
    expect(sharedDbStore.getRedemptionCount('PMB-20261128-RACE')).toBe(1);

    // Instance B also blocks issuing a new pass after Instance A/B already redeemed the booking
    const postRedeemIssue = await instanceB.issue({
      bookingReference: 'PMB-20261128-RACE',
      courtNumber: 5,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T02:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs: nowMs + 5000,
    });
    expect(postRedeemIssue.ok).toBe(false);
    if (!postRedeemIssue.ok) {
      expect(postRedeemIssue.statusCode).toBe(409);
      expect(postRedeemIssue.code).toBe('CHECKIN_ALREADY_REDEEMED');
    }

    // Durable revocation propagated across Cloud Run instances
    const issuedRevk = await instanceA.issue({
      bookingReference: 'PMB-20261128-REVK',
      courtNumber: 6,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T02:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs,
    });
    expect(issuedRevk.ok).toBe(true);
    if (!issuedRevk.ok) return;

    const revOnA = await instanceA.revoke({
      bookingReference: 'PMB-20261128-REVK',
      reason: 'cancelled_by_manager',
      permanent: true,
      staffUserId: 'manager-1',
      nowMs: nowMs + 1000,
    });
    expect(revOnA.ok).toBe(true);

    const scanOnB = await instanceB.verifyOrRedeem({
      qrPayloadOrToken: issuedRevk.data.qrPayload,
      consume: true,
      staffUserId: 'staff-b',
      nowMs: nowMs + 2000,
    });
    expect(scanOnB.ok).toBe(false);
    if (!scanOnB.ok) {
      expect(scanOnB.statusCode).toBe(403);
      expect(scanOnB.code).toBe('CHECKIN_TOKEN_REVOKED');
    }

    const reissueOnB = await instanceB.issue({
      bookingReference: 'PMB-20261128-REVK',
      courtNumber: 6,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T02:00:00.000Z',
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
      nowMs: nowMs + 3000,
    });
    expect(reissueOnB.ok).toBe(false);
    if (!reissueOnB.ok) {
      expect(reissueOnB.statusCode).toBe(403);
      expect(reissueOnB.code).toBe('CHECKIN_TOKEN_REVOKED');
    }
  });

  it('calls PostgreSQL RPCs in SupabaseQrDurabilityStore and fails closed cleanly if Migration 0005 is not applied yet', async () => {
    const missingRpcClient = {
      rpc: async () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.verify_or_redeem_qr_checkin' },
      }),
    } as unknown as Parameters<typeof createSupabaseQrDurabilityStore>[0];

    const missingStore = createSupabaseQrDurabilityStore(missingRpcClient);
    const verifyMissing = await missingStore.verifyOrRedeem({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-SQL5',
      courtNumber: 1,
      tokenJti: 'jti-1234567890',
      issuedAtEpoch: 1795824000,
      expiresAtIso: '2026-11-28T02:00:00.000Z',
      consume: true,
      staffUserId: 'staff-uuid',
      nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
    });
    expect(verifyMissing.ok).toBe(false);
    if (!verifyMissing.ok) {
      expect(verifyMissing.statusCode).toBe(503);
      expect(verifyMissing.code).toBe('QR_CHECKIN_MIGRATION_REQUIRED');
    }

    const recordedCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const okRpcClient = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        recordedCalls.push({ fn, args });
        if (fn === 'verify_or_redeem_qr_checkin') {
          return {
            data: [
              {
                ok: true,
                status_code: 200,
                code: 'OK',
                error_message: null,
                consumed: true,
                booking_reference: 'PMB-20261128-SQL5',
                court_number: 4,
                customer_name: 'Ana Reyes',
                reservation_status: 'confirmed',
                start_at: '2026-11-28T00:00:00.000Z',
                end_at: '2026-11-28T01:00:00.000Z',
                checked_in_at: '2026-11-28T00:15:00.000Z',
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      },
    } as unknown as Parameters<typeof createSupabaseQrDurabilityStore>[0];

    const supabaseStore = createSupabaseQrDurabilityStore(okRpcClient);
    const rpcRes = await supabaseStore.verifyOrRedeem({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-SQL5',
      courtNumber: 4,
      tokenJti: 'jti-1234567890',
      issuedAtEpoch: 1795824000,
      expiresAtIso: '2026-11-28T02:00:00.000Z',
      consume: true,
      staffUserId: 'staff-uuid',
      nowMs: Date.parse('2026-11-28T00:15:00.000Z'),
    });

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].fn).toBe('verify_or_redeem_qr_checkin');
    expect(rpcRes.ok).toBe(true);
    if (rpcRes.ok) {
      expect(rpcRes.data.consumed).toBe(true);
      expect(rpcRes.data.customerName).toBe('Ana Reyes');
      expect(rpcRes.data.courtNumber).toBe(4);
    }
  });

  it('enforces fail-closed auth on revoke_qr_checkin_pass & verify_or_redeem_qr_checkin while preserving service_role system revocation', async () => {
    interface SimSession {
      pgRole: 'authenticated' | 'service_role' | 'anon';
      jwtRole: 'authenticated' | 'service_role' | 'anon';
      authUid: string | null;
    }

    const staffDir = new Map<
      string,
      { id: string; role: 'super_admin' | 'manager' | 'reception_staff'; isActive: boolean }
    >([
      ['11111111-1111-4111-8111-000000000001', { id: '11111111-1111-4111-8111-000000000001', role: 'super_admin', isActive: true }],
      ['11111111-1111-4111-8111-000000000002', { id: '11111111-1111-4111-8111-000000000002', role: 'manager', isActive: true }],
      ['11111111-1111-4111-8111-000000000003', { id: '11111111-1111-4111-8111-000000000003', role: 'reception_staff', isActive: true }],
    ]);
    const nonStaffUid = '22222222-2222-4222-8222-000000000099';
    const revokedRecords: Array<{ bookingRef: string | null; jti: string | null; permanent: boolean; staffId: string | null }> = [];

    // Simulates the exact PostgreSQL SECURITY DEFINER caller gate implemented in Migration 0005
    function createSimulatedRpcClient(session: SimSession) {
      const isServiceRole =
        session.jwtRole === 'service_role' && session.pgRole === 'service_role';

      return {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          if (fn === 'revoke_qr_checkin_pass') {
            const pStaffId = (args.p_staff_id ?? null) as string | null;
            const pPermanent = Boolean(args.p_permanent);
            const pRef = (args.p_booking_reference ?? null) as string | null;
            const pJti = (args.p_token_jti ?? null) as string | null;

            if (isServiceRole) {
              if (pStaffId !== null) {
                const st = staffDir.get(pStaffId);
                if (!st || !st.isActive) {
                  return {
                    data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'Staff ID is not an active staff member.' }],
                    error: null,
                  };
                }
                if (pPermanent && st.role === 'reception_staff') {
                  return {
                    data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'Manager or Super Admin role is required to permanently revoke check-in privileges.' }],
                    error: null,
                  };
                }
              }
            } else {
              if (
                session.jwtRole !== 'authenticated' ||
                session.pgRole !== 'authenticated' ||
                session.authUid === null
              ) {
                return {
                  data: [{ ok: false, status_code: 401, code: 'UNAUTHORIZED', error_message: 'Authenticated staff session or service_role authority is required.' }],
                  error: null,
                };
              }
              if (pStaffId === null) {
                return {
                  data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'p_staff_id is required for authenticated callers and cannot be omitted or NULL.' }],
                  error: null,
                };
              }
              if (pStaffId !== session.authUid) {
                return {
                  data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'Caller identity does not match p_staff_id.' }],
                  error: null,
                };
              }
              const st = staffDir.get(session.authUid);
              if (!st || !st.isActive) {
                return {
                  data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'Authenticated user is not an active staff member.' }],
                  error: null,
                };
              }
              if (pPermanent && st.role === 'reception_staff') {
                return {
                  data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'Manager or Super Admin role is required to permanently revoke check-in privileges.' }],
                  error: null,
                };
              }
            }

            revokedRecords.push({
              bookingRef: pRef,
              jti: pJti,
              permanent: pPermanent,
              staffId: pStaffId,
            });
            return {
              data: [
                {
                  ok: true,
                  status_code: 200,
                  code: 'OK',
                  error_message: null,
                  booking_reference: pRef,
                  token_jti: pJti,
                  revoked_at: '2026-11-28T00:20:00.000Z',
                },
              ],
              error: null,
            };
          }

          if (fn === 'verify_or_redeem_qr_checkin') {
            const pStaffId = (args.p_staff_id ?? null) as string | null;
            if (isServiceRole) {
              if (pStaffId === null) {
                return {
                  data: [{ ok: false, status_code: 401, code: 'UNAUTHORIZED', error_message: 'Staff user ID is required.' }],
                  error: null,
                };
              }
            } else {
              if (
                session.jwtRole !== 'authenticated' ||
                session.pgRole !== 'authenticated' ||
                session.authUid === null
              ) {
                return {
                  data: [{ ok: false, status_code: 401, code: 'UNAUTHORIZED', error_message: 'Authenticated staff session or service_role authority is required.' }],
                  error: null,
                };
              }
              if (pStaffId === null || pStaffId !== session.authUid) {
                return {
                  data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'p_staff_id must be non-null and match caller auth.uid().' }],
                  error: null,
                };
              }
            }
            const st = staffDir.get(pStaffId);
            if (!st || !st.isActive) {
              return {
                data: [{ ok: false, status_code: 403, code: 'FORBIDDEN', error_message: 'Authenticated user is not an active staff member.' }],
                error: null,
              };
            }
            return {
              data: [
                {
                  ok: true,
                  status_code: 200,
                  code: 'OK',
                  error_message: null,
                  consumed: Boolean(args.p_consume),
                  booking_reference: args.p_booking_reference,
                  court_number: args.p_court_number,
                  customer_name: 'Ana Reyes',
                  reservation_status: 'confirmed',
                  start_at: '2026-11-28T00:00:00.000Z',
                  end_at: '2026-11-28T01:00:00.000Z',
                  checked_in_at: '2026-11-28T00:15:00.000Z',
                },
              ],
              error: null,
            };
          }

          return { data: null, error: { message: 'Unknown RPC' } };
        },
      } as unknown as Parameters<typeof createSupabaseQrDurabilityStore>[0];
    }

    // 1. Authenticated non-staff caller omitting / passing NULL p_staff_id MUST be rejected (403 FORBIDDEN)
    const nonStaffStore = createSupabaseQrDurabilityStore(
      createSimulatedRpcClient({ pgRole: 'authenticated', jwtRole: 'authenticated', authUid: nonStaffUid }),
    );
    const nonStaffNullRevoke = await nonStaffStore.revoke({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-TEST',
      tokenJti: null,
      reason: 'unauthorized attempt with null p_staff_id',
      permanent: false,
      revokedBeforeEpoch: 1795824000,
      staffUserId: null,
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(nonStaffNullRevoke.ok).toBe(false);
    if (!nonStaffNullRevoke.ok) {
      expect(nonStaffNullRevoke.statusCode).toBe(403);
      expect(nonStaffNullRevoke.code).toBe('FORBIDDEN');
    }

    // 2. Authenticated non-staff spoofing a manager UUID MUST be rejected (403 FORBIDDEN) on both revoke & redeem
    const managerUid = '11111111-1111-4111-8111-000000000002';
    const spoofedRevoke = await nonStaffStore.revoke({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-TEST',
      tokenJti: null,
      reason: 'spoofed manager uuid',
      permanent: true,
      revokedBeforeEpoch: 1795824000,
      staffUserId: managerUid,
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(spoofedRevoke.ok).toBe(false);
    if (!spoofedRevoke.ok) {
      expect(spoofedRevoke.statusCode).toBe(403);
      expect(spoofedRevoke.code).toBe('FORBIDDEN');
    }

    const spoofedRedeem = await nonStaffStore.verifyOrRedeem({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-TEST',
      courtNumber: 1,
      tokenJti: 'jti-1234567890',
      issuedAtEpoch: 1795823000,
      expiresAtIso: '2026-11-28T02:00:00.000Z',
      consume: true,
      staffUserId: managerUid,
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(spoofedRedeem.ok).toBe(false);
    if (!spoofedRedeem.ok) {
      expect(spoofedRedeem.statusCode).toBe(403);
      expect(spoofedRedeem.code).toBe('FORBIDDEN');
    }

    // 3. auth.uid() = NULL under authenticated role (or forged JWT claim without pg service_role) is NEVER trusted
    const nullUidStore = createSupabaseQrDurabilityStore(
      createSimulatedRpcClient({ pgRole: 'authenticated', jwtRole: 'service_role', authUid: null }),
    );
    const nullUidRevoke = await nullUidStore.revoke({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-TEST',
      tokenJti: null,
      reason: 'forged claim without pg service_role',
      permanent: true,
      revokedBeforeEpoch: 1795824000,
      staffUserId: null,
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(nullUidRevoke.ok).toBe(false);
    if (!nullUidRevoke.ok) {
      expect(nullUidRevoke.statusCode).toBe(401);
      expect(nullUidRevoke.code).toBe('UNAUTHORIZED');
    }

    const nullUidRedeem = await nullUidStore.verifyOrRedeem({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-TEST',
      courtNumber: 1,
      tokenJti: 'jti-1234567890',
      issuedAtEpoch: 1795823000,
      expiresAtIso: '2026-11-28T02:00:00.000Z',
      consume: true,
      staffUserId: managerUid,
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(nullUidRedeem.ok).toBe(false);
    if (!nullUidRedeem.ok) {
      expect(nullUidRedeem.statusCode).toBe(401);
      expect(nullUidRedeem.code).toBe('UNAUTHORIZED');
    }

    // 4. Authenticated reception_staff with matching p_staff_id cannot permanently revoke (403)
    const receptionUid = '11111111-1111-4111-8111-000000000003';
    const receptionStore = createSupabaseQrDurabilityStore(
      createSimulatedRpcClient({ pgRole: 'authenticated', jwtRole: 'authenticated', authUid: receptionUid }),
    );
    const receptionPerm = await receptionStore.revoke({
      facilityId: '11111111-1111-4111-8111-111111111101',
      bookingReference: 'PMB-20261128-TEST',
      tokenJti: null,
      reason: 'attempt permanent revoke by reception',
      permanent: true,
      revokedBeforeEpoch: 1795824000,
      staffUserId: receptionUid,
      nowMs: Date.parse('2026-11-28T00:20:00.000Z'),
    });
    expect(receptionPerm.ok).toBe(false);
    if (!receptionPerm.ok) {
      expect(receptionPerm.statusCode).toBe(403);
      expect(receptionPerm.code).toBe('FORBIDDEN');
    }
    expect(revokedRecords).toHaveLength(0);

    // 5. Genuine service_role system cancellation with p_staff_id = null and p_permanent = true succeeds
    const serviceRoleClient = createSimulatedRpcClient({
      pgRole: 'service_role',
      jwtRole: 'service_role',
      authUid: null,
    });
    const systemCancelRevoke = await revokeQrCheckInTokens({
      bookingReference: 'PMB-20261128-SYSC',
      reason: 'reservation_cancelled',
      permanent: true,
      adminClient: serviceRoleClient,
      nowMs: Date.parse('2026-11-28T00:25:00.000Z'),
    });
    expect(systemCancelRevoke.ok).toBe(true);
    expect(revokedRecords).toEqual([
      {
        bookingRef: 'PMB-20261128-SYSC',
        jti: null,
        permanent: true,
        staffId: null,
      },
    ]);
  });
});

describe('Transactional Email Confirmation Builder & Delivery Guardrails', () => {
  it('escapes HTML safely in email body, distinguishes pending hold vs confirmed pass, and reports missing RESEND_API_KEY honestly', async () => {
    const pendingEmail = buildConfirmationEmailContent({
      bookingReference: 'PMB-20261128-TEST',
      customerName: 'Maria <script>alert(1)</script>',
      recipientEmail: 'player@example.invalid',
      courtNumber: 4,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T01:00:00.000Z',
      durationMinutes: 60,
      totalAmountCentavos: 45000,
      reservationStatus: 'pending_payment',
      paymentStatus: 'unpaid',
      holdExpiresAtIso: '2026-11-28T00:10:00.000Z',
    });

    expect(pendingEmail.html).not.toContain('<script>alert(1)</script>');
    expect(pendingEmail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(pendingEmail.subject).toContain('Temporary Hold');
    expect(pendingEmail.html).toContain('08:00');
    expect(pendingEmail.html).toContain('450.00');

    const confirmedEmail = buildConfirmationEmailContent({
      bookingReference: 'PMB-20261128-PAID',
      customerName: 'Juan Dela Cruz',
      recipientEmail: 'player@example.invalid',
      courtNumber: 4,
      startAtIso: '2026-11-28T00:00:00.000Z',
      endAtIso: '2026-11-28T01:00:00.000Z',
      durationMinutes: 60,
      totalAmountCentavos: 45000,
      reservationStatus: 'confirmed',
      paymentStatus: 'paid',
    });
    expect(confirmedEmail.subject).toContain('Confirmed Court 4');
    expect(confirmedEmail.html).toContain('Reception QR Check-In Eligible');

    const sendRes = await sendBookingConfirmationEmail(
      {
        bookingReference: 'PMB-20261128-PAID',
        customerName: 'Juan Dela Cruz',
        recipientEmail: 'player@example.invalid',
        courtNumber: 4,
        startAtIso: '2026-11-28T00:00:00.000Z',
        endAtIso: '2026-11-28T01:00:00.000Z',
        durationMinutes: 60,
        totalAmountCentavos: 45000,
        reservationStatus: 'confirmed',
        paymentStatus: 'paid',
      },
      {},
    );
    expect(sendRes.configured).toBe(false);
    expect(sendRes.delivered).toBe(false);
    expect(sendRes.provider).toBe('none');

    const badEmailRes = await fetch(`${prodBaseUrl}/api/bookings/confirmation-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookingReference: 'PMB-20261128-PAID',
        lookupToken: 'short',
        recipientEmail: 'not-an-email',
      }),
    });
    expect(badEmailRes.status).toBe(400);
  });
});

describe('HitPay Stage 5 Planning Guardrails & HMAC Signature Verification', () => {
  it('keeps paymentGatewayEnabled strictly false and verifies HitPay webhook HMAC-SHA256 signatures accurately', async () => {
    expect(STAGE5_HITPAY_PLAN.paymentGatewayEnabled).toBe(false);
    expect(STAGE5_HITPAY_PLAN.currency).toBe('PHP');
    expect(formatCentavosToHitPayAmount(35000)).toBe('350.00');
    expect(formatCentavosToHitPayAmount(50)).toBe('0.50');

    const salt = 'hitpay-test-salt-not-live';
    const webhookPayload = {
      payment_id: 'hp-pay-12345',
      payment_request_id: 'hp-req-999',
      amount: '450.00',
      currency: 'PHP',
      status: 'completed',
      reference_number: 'PMB-20261128-TEST',
    };

    const sourceStr = buildHitPayHmacSourceString(webhookPayload);
    const expectedHmac = crypto.createHmac('sha256', salt).update(sourceStr).digest('hex');

    expect(await verifyHitPayWebhookHmac(webhookPayload, expectedHmac, salt)).toBe(true);
    expect(
      await verifyHitPayWebhookHmac({ ...webhookPayload, amount: '1.00' }, expectedHmac, salt),
    ).toBe(false);
    expect(await verifyHitPayWebhookHmac(webhookPayload, '0'.repeat(64), salt)).toBe(false);
  });
});
