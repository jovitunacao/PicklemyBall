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
  issueServerQrCheckInToken,
  resetQrCheckInStoreForTests,
  revokeQrCheckInTokens,
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

  it('strictly unlocks QR passes only for confirmed + paid bookings', () => {
    expect(isQrCheckInEligible('confirmed', 'paid')).toBe(true);
    expect(isQrCheckInEligible('pending_payment', 'created')).toBe(false);
    expect(isQrCheckInEligible('pending_payment', 'pending')).toBe(false);
    expect(isQrCheckInEligible('cancelled', 'paid')).toBe(false);
    expect(isQrCheckInEligible('expired', 'expired')).toBe(false);
    expect(isQrCheckInEligible('payment_review_required', 'paid')).toBe(false);

    const unpaidIssue = issueServerQrCheckInToken({
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
    const issued = issueServerQrCheckInToken({
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
    const issued = issueServerQrCheckInToken({
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
    const issued2 = issueServerQrCheckInToken({
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
