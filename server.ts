import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  adminCreateMaintenanceBlock,
  adminCreateWalkInHold,
  adminListReservations,
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
import { isSupabaseServerConfigured, verifyStaffAuthorization } from './server/supabaseAdmin.ts';
import { isValidDateString } from './src/lib/manilaTime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const rateLimiter = new SlidingWindowRateLimiter(
  Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  Number(process.env.RATE_LIMIT_MAX_REQUESTS || 40),
);

function publicRateLimit(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
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

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      stage: 'stage-4',
      timezone: 'Asia/Manila',
      currency: 'PHP',
      supabaseConfigured: isSupabaseServerConfigured(),
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
    res.status(200).json(result.data);
  });

  // Explicitly block unverified client-side payment confirmation in Stage 4
  app.post('/api/bookings/:reference/confirm-payment', (_req, res) => {
    res.status(403).json({
      code: 'PAYMENT_VERIFICATION_REQUIRED',
      error:
        'Bookings cannot be confirmed without verified Stage 5 payment gateway webhook evidence.',
    });
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

  app.post('/api/admin/maintenance', async (req, res) => {
    const auth = await verifyStaffAuthorization(req.headers.authorization, [
      'super_admin',
      'manager',
    ]);
    if (!auth.ok) {
      res.status(auth.statusCode).json({ error: auth.error });
      return;
    }
    const schema = z.object({
      courtNumber: z.coerce.number().int().min(1).max(14),
      startAtIso: z.string().datetime(),
      endAtIso: z.string().datetime(),
      reason: z.string().trim().min(3).max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid maintenance request.' });
      return;
    }
    const result = await adminCreateMaintenanceBlock(auth.staff, parsed.data);
    res.status(result.statusCode).json(result.ok ? result.data : { code: result.code, error: result.error });
  });

  return app;
}

async function startServer() {
  const app = createApp();

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pick My Ball server listening on http://0.0.0.0:${PORT}`);
  });
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer();
}
