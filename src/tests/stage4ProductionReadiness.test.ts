import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server';
import { buildConfirmationEmailContent, sendBookingConfirmationEmail } from '../../server/emailService';
import { calculateServerPricingQuote } from '../../server/pricingEngine';
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

describe('QR Check-In Pass Eligibility, PII-Free Payload & SVG Rendering', () => {
  it('strictly unlocks QR passes only for confirmed + paid bookings', () => {
    expect(isQrCheckInEligible('confirmed', 'paid')).toBe(true);
    expect(isQrCheckInEligible('pending_payment', 'created')).toBe(false);
    expect(isQrCheckInEligible('pending_payment', 'pending')).toBe(false);
    expect(isQrCheckInEligible('cancelled', 'paid')).toBe(false);
    expect(isQrCheckInEligible('expired', 'expired')).toBe(false);
    expect(isQrCheckInEligible('payment_review_required', 'paid')).toBe(false);
  });

  it('builds PII-free check-in URIs, parses scanned payloads, and generates valid SVG markup', async () => {
    const uri = buildQrCheckInPayload({
      bookingReference: 'PMB-20261128-AB12',
      lookupToken: 'opaque-token-secret-xyz',
      courtNumber: 7,
    });
    expect(uri).toBe(
      'pmb://astoria-regency/checkin?ref=PMB-20261128-AB12&token=opaque-token-secret-xyz&court=7',
    );
    expect(uri).not.toContain('@');

    expect(parseQrCheckInInput(uri)).toEqual({
      bookingReference: 'PMB-20261128-AB12',
      lookupToken: 'opaque-token-secret-xyz',
      courtNumber: 7,
    });

    expect(parseQrCheckInInput('pmb-20261128-ab12')).toEqual({
      bookingReference: 'PMB-20261128-AB12',
      lookupToken: null,
      courtNumber: null,
    });

    const svg = await generateQrPassSvg(uri);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
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
