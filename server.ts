import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sendBookingConfirmationEmail } from './server/emailService.ts';
import {
  issueServerQrCheckInToken,
  revokeQrCheckInTokens,
  verifyAndConsumeQrCheckInToken,
} from './server/qrCheckInService.ts';
import {
  adminCancelReservation,
  adminCreateMaintenanceBlock,
  adminCreatePricingRule,
  adminCreateWalkInHold,
  adminDeactivateMaintenanceBlock,
  adminGetOperatingHours,
  adminGetPricing,
  adminListAuditLogs,
  adminListReservations,
  adminPatchPricing,
  adminUpsertOperatingHour,
  AvailabilityQuerySchema,
  CancelBookingSchema,
  cancelBookingSecurely,
  CreateGuestHoldSchema,
  createGuestHoldAndPendingBooking,
  getAvailabilityForInterval,
  getCourtHourlySchedule,
  getPricingQuoteForCourt,
  LookupBookingSchema,
  lookupBookingSecurely,
} from './server/bookingService.ts';
import { SlidingWindowRateLimiter } from './server/bookingUtils.ts';
import {
  diagnoseServerSupabaseConfig,
  getSupabaseAdminClient,
  isSupabaseServerConfigured,
  verifyStaffAuthorization,
} from './server/supabaseAdmin.ts';
import { isValidDateString } from './src/lib/manilaTime.ts';
import {
  isOriginAllowed,
  parseAllowedOrigins,
} from './supabase/functions/_shared/cors.ts';
import {
  AdminCreateMaintenanceSchema,
  AdminCreatePricingRuleSchema,
  AdminPatchPricingSchema,
  AdminUpsertOperatingHourSchema,
} from './supabase/functions/_shared/validation.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const rateLimiter = new SlidingWindowRateLimiter(
  Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  Number(process.env.RATE_LIMIT_MAX_REQUESTS || 40),
);

async function publicRateLimit(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const admin = getSupabaseAdminClient();
  const windowSeconds = Math.max(1, Math.round(Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000) / 1000));
  const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 40);

  if (admin) {
    const { data, error } = await admin.rpc('check_and_consume_rate_limit', {
      p_bucket_key: `${req.path}:${clientIp}`,
      p_window_seconds: windowSeconds,
      p_max_requests: maxRequests,
    });
    if (!error && data) {
      const row = Array.isArray(data) ? data[0] : data;
      res.setHeader('X-RateLimit-Remaining', String(row.remaining ?? 0));
      if (!row.allowed) {
        res.setHeader('Retry-After', String(row.retry_after_seconds ?? 1));
        res.status(429).json({
          code: 'RATE_LIMIT_EXCEEDED',
          error: 'Too many requests. Please wait briefly before retrying.',
        });
        return;
      }
      next();
      return;
    }
  }

  const result = rateLimiter.consume(`${clientIp}:${req.path}`);
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      error: 'Too many requests. Please wait briefly before retrying.',
    });
    return;
  }
  next();
}

export interface CreateAppOptions {
  serveStaticDir?: string;
}

export function createApp(options?: CreateAppOptions) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', (req, res, next) => {
    const originHeader = req.headers.origin;
    const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
    if (process.env.APP_URL) {
      allowedOrigins.push(process.env.APP_URL.trim().replace(/\/+$/, ''));
    }
    const reqHost = req.headers.host;
    if (reqHost) {
      const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol || 'http';
      allowedOrigins.push(`${proto}://${reqHost}`);
      allowedOrigins.push(`https://${reqHost}`);
      allowedOrigins.push(`http://${reqHost}`);
    }
    res.setHeader('Vary', 'Origin');

    if (originHeader && !isOriginAllowed(originHeader, allowedOrigins)) {
      res.status(403).json({
        code: 'CORS_ORIGIN_FORBIDDEN',
        error: 'Origin is not in the configured ALLOWED_ORIGINS allowlist.',
      });
      return;
    }

    if (originHeader) {
      res.setHeader('Access-Control-Allow-Origin', originHeader.trim().replace(/\/+$/, ''));
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    const diag = diagnoseServerSupabaseConfig();
    res.json({
      status: 'ok',
      stage: 'stage-4',
      timezone: 'Asia/Manila',
      currency: 'PHP',
      supabaseConfigured: isSupabaseServerConfigured(),
      supabaseConfigState: diag.state,
      envPresence: {
        SUPABASE_URL: diag.hasUrl,
        SUPABASE_ANON_KEY: diag.hasAnonKey,
        SUPABASE_SERVICE_ROLE_KEY: diag.hasServiceRoleKey,
      },
      paymentGatewayEnabled: false,
    });
  });

  app.get('/api/availability', publicRateLimit, async (req, res) => {
    const parsed = AvailabilityQuerySchema.safeParse({
      date: req.query.date,
      startTime: req.query.startTime,
      durationMinutes: req.query.durationMinutes,
    });
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Invalid availability parameters.',
      });
      return;
    }

    const result = await getAvailabilityForInterval(parsed.data);
    if (!result.ok) {
      res.status(result.statusCode).json({ code: result.code, error: result.error });
      return;
    }
    res.status(200).json(result.data);
  });

  app.get('/api/courts/:courtNumber/schedule', publicRateLimit, async (req, res) => {
    const courtNumber = Number(req.params.courtNumber);
    const date = String(req.query.date ?? '');
    if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 14 || !isValidDateString(date)) {
      res.status(400).json({ code: 'VALIDATION_ERROR', error: 'Invalid court number or date.' });
      return;
    }
    const result = await getCourtHourlySchedule({ courtNumber, date });
    if (!result.ok) {
      res.status(result.statusCode).json({ code: result.code, error: result.error });
      return;
    }
    res.status(200).json(result.data);
  });

  app.post('/api/pricing/quote', publicRateLimit, async (req, res) => {
    const schema = AvailabilityQuerySchema.extend({
      courtNumber: z.coerce.number().int().min(1).max(14),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Invalid quote request.',
      });
      return;
    }
    const result = await getPricingQuoteForCourt(parsed.data);
    if (!result.ok) {
      res.status(result.statusCode).json({ code: result.code, error: result.error });
      return;
    }
    res.status(200).json(result.data);
  });

  app.post('/api/holds', publicRateLimit, async (req, res) => {
    const parsed = CreateGuestHoldSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Invalid booking details.',
      });
      return;
    }
    const result = await createGuestHoldAndPendingBooking(parsed.data);
    if (!result.ok) {
      res.status(result.statusCode).json({ code: result.code, error: result.error });
      return;
    }
    res.status(result.statusCode).json(result.data);
  });

  app.post('/api/bookings/lookup', publicRateLimit, async (req, res) => {
    const parsed = LookupBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Booking reference and access token are required.',
      });
      return;
    }
    const result = await lookupBookingSecurely(parsed.data);
    if (!result.ok) {
      res.status(result.statusCode).json({ code: result.code, error: result.error });
      return;
    }
    res.status(200).json(result.data);
  });

  app.post('/api/bookings/:reference/cancel', publicRateLimit, async (req, res) => {
    const parsed = CancelBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: 'A valid ownership or lookup token is required to cancel.',
      });
      return;
    }
    const result = await cancelBookingSecurely(req.params.reference, parsed.data);
    if (!result.ok) {
      res.status(result.statusCode).json({ code: result.code, error: result.error });
      return;
    }
    await revokeQrCheckInTokens({
      bookingReference: req.params.reference,
      reason: 'reservation_cancelled',
      permanent: true,
      adminClient: getSupabaseAdminClient(),
    });
    res.status(200).json(result.data);
  });

  // Explicitly block unverified client-side payment confirmation until verified Stage 5 webhook evidence
  app.post('/api/bookings/:reference/confirm-payment', (_req, res) => {
    res.status(403).json({
      code: 'PAYMENT_VERIFICATION_REQUIRED',
      error:
        'Bookings cannot be confirmed without verified Stage 5 payment gateway webhook evidence.',
    });
  });

  interface VerifiedLookupRecord {
    booking_reference: string;
    court_number: number;
    start_at: string;
    end_at: string;
    duration_minutes: number;
    total_amount_centavos: number;
    reservation_status: string;
    payment_status: string;
    hold_expires_at: string | null;
    customer_name: string;
  }

  async function verifyBookingOwnershipServerSide(params: {
    bookingReference: string;
    lookupToken: string;
  }): Promise<
    | { ok: true; row: VerifiedLookupRecord }
    | { ok: false; statusCode: number; code: string; error: string }
  > {
    if (isSupabaseServerConfigured()) {
      const bookingRes = await lookupBookingSecurely(params);
      if (!bookingRes.ok || !bookingRes.data) {
        return {
          ok: false,
          statusCode: bookingRes.statusCode,
          code: bookingRes.code ?? 'LOOKUP_FAILED',
          error: bookingRes.error ?? 'Reservation not found.',
        };
      }
      return { ok: true, row: bookingRes.data };
    }

    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
    if (!supabaseUrl || !anonKey) {
      return {
        ok: false,
        statusCode: 503,
        code: 'SUPABASE_NOT_CONFIGURED',
        error: 'Supabase connection is required to verify this reservation.',
      };
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        apikey: anonKey,
      };
      if (anonKey.startsWith('eyJ')) {
        headers.Authorization = `Bearer ${anonKey}`;
      }
      const edgeRes = await fetch(`${supabaseUrl}/functions/v1/booking-lookup`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      const edgePayload = (await edgeRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!edgeRes.ok) {
        return {
          ok: false,
          statusCode: edgeRes.status,
          code: typeof edgePayload.code === 'string' ? edgePayload.code : 'LOOKUP_FAILED',
          error:
            typeof edgePayload.error === 'string'
              ? edgePayload.error
              : 'Unable to verify reservation credentials.',
        };
      }
      return { ok: true, row: edgePayload as unknown as VerifiedLookupRecord };
    } catch {
      return {
        ok: false,
        statusCode: 502,
        code: 'EDGE_LOOKUP_UNREACHABLE',
        error: 'Unable to reach Supabase Edge Function to verify reservation.',
      };
    }
  }

  // Dedicated server-generated QR check-in token issuance (never embeds lookupToken)
  app.post('/api/qr-checkin/issue', publicRateLimit, async (req, res) => {
    const parsed = LookupBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Booking reference and access token are required.',
      });
      return;
    }

    const verified = await verifyBookingOwnershipServerSide({
      bookingReference: parsed.data.bookingReference,
      lookupToken: parsed.data.lookupToken,
    });
    if (!verified.ok) {
      res.status(verified.statusCode).json({ code: verified.code, error: verified.error });
      return;
    }

    const row = verified.row;
    const issued = issueServerQrCheckInToken({
      bookingReference: row.booking_reference,
      courtNumber: row.court_number,
      startAtIso: row.start_at,
      endAtIso: row.end_at,
      reservationStatus: row.reservation_status as Parameters<typeof issueServerQrCheckInToken>[0]['reservationStatus'],
      paymentStatus: row.payment_status as Parameters<typeof issueServerQrCheckInToken>[0]['paymentStatus'],
    });

    if (!issued.ok) {
      res.status(issued.statusCode).json({ code: issued.code, error: issued.error });
      return;
    }

    res.status(200).json(issued.data);
  });

  // Token-gated transactional booking email / receipt endpoint
  app.post('/api/bookings/confirmation-email', publicRateLimit, async (req, res) => {
    const schema = LookupBookingSchema.extend({
      recipientEmail: z.string().trim().email('Valid email address required').max(160),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Booking reference, lookup token, and email are required.',
      });
      return;
    }

    const verified = await verifyBookingOwnershipServerSide({
      bookingReference: parsed.data.bookingReference,
      lookupToken: parsed.data.lookupToken,
    });
    if (!verified.ok) {
      res.status(verified.statusCode).json({
        code: verified.code,
        error: verified.error,
      });
      return;
    }

    const row = verified.row;
    const reqHost = req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol || 'https';
    const appBaseUrl = process.env.APP_URL?.trim() || (reqHost ? `${proto}://${reqHost}` : 'https://pickmyball.ph');

    const result = await sendBookingConfirmationEmail({
      bookingReference: row.booking_reference,
      customerName: row.customer_name,
      recipientEmail: parsed.data.recipientEmail,
      courtNumber: row.court_number,
      startAtIso: row.start_at,
      endAtIso: row.end_at,
      durationMinutes: row.duration_minutes,
      totalAmountCentavos: row.total_amount_centavos,
      reservationStatus: row.reservation_status,
      paymentStatus: row.payment_status,
      holdExpiresAtIso: row.hold_expires_at,
      appBaseUrl,
    });

    res.status(200).json(result);
  });

  // Staff RBAC Endpoints (Stage 4.11 Backend Foundation)
  app.get('/api/admin/reservations', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
      'reception_staff',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const dateFilter = typeof req.query.date === 'string' ? req.query.date : undefined;
    const result = await adminListReservations(auth.staff, dateFilter);
    res.status(result.statusCode).json(result.ok ? { reservations: result.data } : { error: result.error });
  });

  app.post('/api/admin/walk-in', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
      'reception_staff',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const parsed = CreateGuestHoldSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid walk-in payload.' });
      return;
    }
    const result = await adminCreateWalkInHold(auth.staff, parsed.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.post('/api/admin/reservations/:reference/cancel', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
      'reception_staff',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const schema = z.object({
      reason: z.string().trim().min(3).max(240),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Cancellation reason is required.' });
      return;
    }
    const result = await adminCancelReservation(auth.staff, req.params.reference, parsed.data.reason);
    if (result.ok) {
      await revokeQrCheckInTokens({
        bookingReference: req.params.reference,
        reason: 'reservation_cancelled',
        permanent: true,
        staffUserId: auth.staff.userId,
        adminClient: auth.staff.adminClient,
      });
    }
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  // Reception / Staff QR Check-In Verification & Revocation (Strictly Staff Authenticated)
  app.post('/api/admin/check-in/verify', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
      'reception_staff',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ code: 'UNAUTHORIZED', error: auth.error });
      return;
    }

    const schema = z.object({
      qrPayloadOrToken: z.string().trim().min(10, 'Scanned QR URI or check-in token is required').max(2048),
      consume: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Valid check-in QR payload or token is required.',
      });
      return;
    }

    const result = await verifyAndConsumeQrCheckInToken({
      qrPayloadOrToken: parsed.data.qrPayloadOrToken,
      consume: parsed.data.consume,
      staffUserId: auth.staff.userId,
      dbClient: auth.staff.dbClient,
      adminClient: auth.staff.adminClient,
    });
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.post('/api/admin/check-in/revoke', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
      'reception_staff',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ code: 'UNAUTHORIZED', error: auth.error });
      return;
    }

    const schema = z.object({
      bookingReference: z.string().trim().regex(/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/i).optional(),
      qrPayloadOrToken: z.string().trim().min(10).max(2048).optional(),
      reason: z.string().trim().min(3, 'Revocation reason is required').max(240),
      permanent: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        error: parsed.error.issues[0]?.message ?? 'Provide a booking reference or token and revocation reason.',
      });
      return;
    }

    const allowPermanent = auth.staff.profile.role === 'super_admin' || auth.staff.profile.role === 'manager';
    if (parsed.data.permanent && !allowPermanent) {
      res.status(403).json({
        code: 'FORBIDDEN',
        error: 'Manager or Super Admin role is required to permanently revoke check-in privileges.',
      });
      return;
    }

    const result = await revokeQrCheckInTokens({
      bookingReference: parsed.data.bookingReference,
      qrPayloadOrToken: parsed.data.qrPayloadOrToken,
      reason: parsed.data.reason,
      permanent: Boolean(parsed.data.permanent && allowPermanent),
      staffUserId: auth.staff.userId,
      adminClient: auth.staff.adminClient,
    });
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.post('/api/admin/maintenance', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const parsed = AdminCreateMaintenanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid maintenance request.' });
      return;
    }
    const result = await adminCreateMaintenanceBlock(auth.staff, parsed.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.delete('/api/admin/maintenance/:id', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: 'Valid maintenance block UUID is required.' });
      return;
    }
    const result = await adminDeactivateMaintenanceBlock(auth.staff, idCheck.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.get('/api/admin/pricing', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const result = await adminGetPricing(auth.staff);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.post('/api/admin/pricing', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const parsed = AdminCreatePricingRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid pricing rule payload.' });
      return;
    }
    const result = await adminCreatePricingRule(auth.staff, parsed.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.patch('/api/admin/pricing', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const parsed = AdminPatchPricingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid pricing update payload.' });
      return;
    }
    const result = await adminPatchPricing(auth.staff, parsed.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.get('/api/admin/operating-hours', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const result = await adminGetOperatingHours(auth.staff);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.put('/api/admin/operating-hours', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const parsed = AdminUpsertOperatingHourSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid operating hours payload.' });
      return;
    }
    const result = await adminUpsertOperatingHour(auth.staff, parsed.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  app.get('/api/admin/audit-logs', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const result = await adminListAuditLogs(auth.staff, {
      reservationId: typeof req.query.reservationId === 'string' ? req.query.reservationId : undefined,
      eventType: typeof req.query.eventType === 'string' ? req.query.eventType : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
    });
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  // Unknown /api/* endpoints return JSON 404 instead of HTML SPA fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({
      code: 'API_NOT_FOUND',
      error: 'API endpoint not found.',
    });
  });

  if (options?.serveStaticDir) {
    const resolvedDir = path.resolve(options.serveStaticDir);
    const indexHtmlPath = path.join(resolvedDir, 'index.html');
    app.use(express.static(resolvedDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      // Do not serve SPA HTML for missing static asset paths with file extensions
      if (path.extname(req.path)) {
        res.status(404).type('text/plain').send('Asset not found');
        return;
      }
      if (!fs.existsSync(indexHtmlPath)) {
        res.status(503).type('text/plain').send('Frontend build output (dist/index.html) is not built yet.');
        return;
      }
      res.sendFile(indexHtmlPath);
    });
  }

  return app;
}

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');
  const app = createApp(isProd ? { serveStaticDir: distDir } : undefined);
  const httpServer = createHttpServer(app);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Pick My Ball server listening on http://0.0.0.0:${PORT}`);
  });
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer();
}
