import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server';
import { diagnoseServerSupabaseConfig } from '../../server/supabaseAdmin';
import { hashSecretToken as nodeHashSecretToken } from '../../server/bookingUtils';
import { diagnoseBrowserSupabaseConfig } from '../lib/supabaseClient';
import { resolveEdgeFunctionsBaseUrl } from '../services/bookingApi';
import {
  evaluateCors,
  handleCorsPreflightOrReject,
  parseAllowedOrigins,
} from '../../supabase/functions/_shared/cors';
import { calculateEdgePricingQuote } from '../../supabase/functions/_shared/pricing';
import {
  extractClientIp,
  enforceDistributedRateLimit,
} from '../../supabase/functions/_shared/rateLimit';
import {
  assertValidReservationStatusTransition,
  generateOpaqueToken,
  hashSecretToken as webHashSecretToken,
  timingSafeTokenMatches,
} from '../../supabase/functions/_shared/security';
import {
  AdminCancelReservationSchema,
  AdminCreateMaintenanceSchema,
  AdminCreatePricingRuleSchema,
  AdminPatchPricingSchema,
  AdminUpsertOperatingHourSchema,
} from '../../supabase/functions/_shared/validation';

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

describe('Supabase Edge Functions Structure & Serverless Readiness', () => {
  const expectedFunctions = [
    'availability',
    'pricing-quote',
    'guest-holds',
    'booking-lookup',
    'booking-cancel',
    'admin-reservations',
    'admin-maintenance',
    'admin-pricing',
    'admin-operating-hours',
    'admin-audit-logs',
  ];

  it('contains all 10 Edge Function entrypoints plus _shared modules and deno.json', () => {
    const fnRoot = path.resolve(process.cwd(), 'supabase/functions');
    expect(fs.existsSync(path.join(fnRoot, 'deno.json'))).toBe(true);

    for (const fnName of expectedFunctions) {
      const entry = path.join(fnRoot, fnName, 'index.ts');
      expect(fs.existsSync(entry)).toBe(true);
      const source = fs.readFileSync(entry, 'utf8');
      expect(source).toContain('Deno.serve');
      expect(source).toContain('handleCorsPreflightOrReject');
    }

    // Frontend never references SUPABASE_SERVICE_ROLE_KEY
    const srcFiles = fs.readdirSync(path.join(process.cwd(), 'src'), { recursive: true }) as string[];
    for (const relPath of srcFiles) {
      if (relPath.startsWith('tests')) continue;
      const fullPath = path.join(process.cwd(), 'src', relPath);
      if (fs.statSync(fullPath).isFile()) {
        const text = fs.readFileSync(fullPath, 'utf8');
        expect(text).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      }
    }
  });

  it('includes Cloudflare Pages SPA _redirects rule', () => {
    const redirectsPath = path.resolve(process.cwd(), 'public/_redirects');
    expect(fs.existsSync(redirectsPath)).toBe(true);
    expect(fs.readFileSync(redirectsPath, 'utf8')).toContain('/* /index.html 200');
  });
});

describe('Edge CORS Allowlist Security', () => {
  it('ignores wildcard "*" and strips trailing slashes from ALLOWED_ORIGINS', () => {
    const origins = parseAllowedOrigins('https://pickmyball.pages.dev/, *, https://booking.pickmyball.ph');
    expect(origins).toEqual([
      'https://pickmyball.pages.dev',
      'https://booking.pickmyball.ph',
    ]);
    expect(origins).not.toContain('*');
  });

  it('allows listed Cloudflare Pages origins and rejects unlisted origins with 403', () => {
    const allowedReq = new Request('https://example.supabase.co/functions/v1/availability', {
      method: 'OPTIONS',
      headers: { Origin: 'https://pickmyball.pages.dev' },
    });
    const allowedEval = evaluateCors(allowedReq, 'https://pickmyball.pages.dev');
    expect(allowedEval.allowed).toBe(true);
    expect(allowedEval.headers['Access-Control-Allow-Origin']).toBe('https://pickmyball.pages.dev');
    expect(allowedEval.headers['Access-Control-Allow-Credentials']).toBe('true');

    const { preflightOrErrorResponse } = handleCorsPreflightOrReject(
      allowedReq,
      'https://pickmyball.pages.dev',
    );
    expect(preflightOrErrorResponse?.status).toBe(204);

    const evilReq = new Request('https://example.supabase.co/functions/v1/admin-pricing', {
      method: 'GET',
      headers: { Origin: 'https://evil-phishing.example.com' },
    });
    const evilEval = evaluateCors(evilReq, 'https://pickmyball.pages.dev');
    expect(evilEval.allowed).toBe(false);
    expect(evilEval.headers['Access-Control-Allow-Origin']).toBeUndefined();

    const rejected = handleCorsPreflightOrReject(evilReq, 'https://pickmyball.pages.dev');
    expect(rejected.preflightOrErrorResponse?.status).toBe(403);
  });

  it('enforces ALLOWED_ORIGINS rejection on Express regression API too', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://unauthorized-origin.example.com' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CORS_ORIGIN_FORBIDDEN');
  });
});

describe('Edge Web Crypto, State Machine, Distributed Rate Limiting & Validation', () => {
  it('hashes tokens via Web Crypto SHA-256 identically to Node crypto and verifies in constant time', async () => {
    const token = generateOpaqueToken(24);
    expect(token.length).toBeGreaterThanOrEqual(32);

    const webHash = await webHashSecretToken(token);
    const nodeHash = nodeHashSecretToken(token);
    expect(webHash).toBe(nodeHash);
    expect(await timingSafeTokenMatches(token, webHash)).toBe(true);
    expect(await timingSafeTokenMatches(`${token}-tampered`, webHash)).toBe(false);
  });

  it('prevents unverified payment confirmation inside Edge security guard', () => {
    expect(() =>
      assertValidReservationStatusTransition('pending_payment', 'confirmed', {
        hasVerifiedPaymentEvidence: false,
      }),
    ).toThrow(/PAYMENT_VERIFICATION_REQUIRED/);
  });

  it('matches pricing engine centavo totals cleanly', () => {
    const quote = calculateEdgePricingQuote({
      courtNumber: 3,
      courtId: 'court-3',
      baseHourlyRateCentavos: 35000,
      dateStr: '2026-11-28', // Saturday
      startTime: '17:00',
      durationMinutes: 120,
      rules: [
        {
          id: 'wknd-peak',
          facility_id: 'f1',
          court_id: null,
          name: 'Weekend Peak',
          rule_type: 'peak',
          day_scope: 'weekend',
          start_time: '17:00:00',
          end_time: '21:00:00',
          rate_centavos: 50000,
          discount_percent: 0,
          priority: 25,
          is_active: true,
          valid_from: null,
          valid_until: null,
        },
      ],
    });
    expect(quote.totalAmountCentavos).toBe(100000);
    expect(quote.effectiveHourlyRateCentavos).toBe(50000);
  });

  it('validates admin pricing, operating hours, maintenance, and cancellation schemas strictly', () => {
    expect(
      AdminUpsertOperatingHourSchema.safeParse({
        dayOfWeek: 1,
        openTime: '22:00',
        closeTime: '06:00',
        isClosed: false,
      }).success,
    ).toBe(false);

    expect(
      AdminUpsertOperatingHourSchema.safeParse({
        overrideDate: '2026-12-25',
        openTime: '06:00',
        closeTime: '22:00',
        isClosed: true,
        notes: 'Christmas Day Holiday Closure',
      }).success,
    ).toBe(true);

    expect(
      AdminCreateMaintenanceSchema.safeParse({
        courtNumber: 2,
        startAtIso: '2026-11-28T10:00:00.000Z',
        endAtIso: '2026-11-28T09:00:00.000Z',
        reason: 'Invalid backwards interval',
      }).success,
    ).toBe(false);

    expect(
      AdminCreatePricingRuleSchema.safeParse({
        name: 'Early Bird Promo',
        ruleType: 'promo',
        dayScope: 'weekday',
        startTime: '06:00',
        endTime: '09:00',
        discountPercent: 15,
      }).success,
    ).toBe(true);

    expect(
      AdminPatchPricingSchema.safeParse({
        target: 'court_base_rate',
        courtNumber: 1,
        baseHourlyRateCentavos: 38000,
      }).success,
    ).toBe(true);

    expect(
      AdminCancelReservationSchema.safeParse({
        bookingReference: 'PMB-20261125-A4K9',
        reason: 'Weather rainout refund policy',
      }).success,
    ).toBe(true);
  });

  it('calls PostgreSQL check_and_consume_rate_limit RPC with extracted client IP', async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const fakeAdmin = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return { data: [{ allowed: false, remaining: 0, retry_after_seconds: 42 }], error: null };
      },
    };
    const req = new Request('https://example.supabase.co/functions/v1/guest-holds', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.19' },
    });
    expect(extractClientIp(req)).toBe('203.0.113.19');

    const result = await enforceDistributedRateLimit(fakeAdmin as never, req, 'guest-holds', {
      windowSeconds: 60,
      maxRequests: 25,
    });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(42);
    expect(rpcCalls[0]).toEqual({
      fn: 'check_and_consume_rate_limit',
      args: {
        p_bucket_key: 'guest-holds:203.0.113.19',
        p_window_seconds: 60,
        p_max_requests: 25,
      },
    });
  });

  it('resolves Edge Functions base URL cleanly and rejects dashboard or incomplete URLs', () => {
    expect(
      diagnoseBrowserSupabaseConfig({
        VITE_SUPABASE_URL: 'https://supabase.com/dashboard/project/exampleproject',
        VITE_SUPABASE_ANON_KEY: 'sb_publishable_valid_key_format_12345',
      }).state,
    ).toBe('invalid_url');

    expect(
      diagnoseBrowserSupabaseConfig({
        VITE_SUPABASE_URL: 'https://astoriatestproj.supabase.co',
      }).state,
    ).toBe('incomplete');

    expect(
      diagnoseBrowserSupabaseConfig({
        VITE_SUPABASE_URL: 'https://astoriatestproj.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'sb_publishable_valid_key_format_12345',
      }).state,
    ).toBe('ready');

    expect(
      resolveEdgeFunctionsBaseUrl({
        VITE_EDGE_FUNCTIONS_URL: 'https://custom-edge.pickmyball.ph/',
        VITE_SUPABASE_URL: 'https://abc.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'sb_publishable_valid_key_format_12345',
      }),
    ).toBe('https://custom-edge.pickmyball.ph');

    expect(
      resolveEdgeFunctionsBaseUrl({
        VITE_SUPABASE_URL: 'https://abc.supabase.co/',
        VITE_SUPABASE_ANON_KEY: 'sb_publishable_valid_key_format_12345',
      }),
    ).toBe('https://abc.supabase.co/functions/v1');

    expect(resolveEdgeFunctionsBaseUrl({})).toBeNull();
  });

  it('never silently falls back to simulated availability when server credentials are invalid or incomplete', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const prevAnon = process.env.SUPABASE_ANON_KEY;

    try {
      process.env.SUPABASE_URL = 'https://supabase.com/dashboard/project/example';
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expect(diagnoseServerSupabaseConfig().state).toBe('invalid_url');

      const resInvalid = await fetch(
        `${baseUrl}/api/availability?date=2026-11-28&startTime=08:00&durationMinutes=60`,
      );
      expect(resInvalid.status).toBe(503);
      const invalidBody = await resInvalid.json();
      expect(invalidBody.code).toBe('INVALID_CREDENTIALS');

      process.env.SUPABASE_URL = 'https://example.supabase.co';
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expect(diagnoseServerSupabaseConfig().state).toBe('incomplete');

      const resIncomplete = await fetch(
        `${baseUrl}/api/availability?date=2026-11-28&startTime=08:00&durationMinutes=60`,
      );
      expect(resIncomplete.status).toBe(503);
      const incompleteBody = await resIncomplete.json();
      expect(incompleteBody.code).toBe('INCOMPLETE_CREDENTIALS');
    } finally {
      if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
      else delete process.env.SUPABASE_URL;
      if (prevService !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
      else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (prevAnon !== undefined) process.env.SUPABASE_ANON_KEY = prevAnon;
      else delete process.env.SUPABASE_ANON_KEY;
    }
  });

  it('protects newly added Express parity admin endpoints against unauthenticated access', async () => {
    const endpoints: Array<{ method: string; path: string }> = [
      { method: 'POST', path: '/api/admin/reservations/PMB-20261125-A4K9/cancel' },
      { method: 'GET', path: '/api/admin/pricing' },
      { method: 'POST', path: '/api/admin/pricing' },
      { method: 'PATCH', path: '/api/admin/pricing' },
      { method: 'GET', path: '/api/admin/operating-hours' },
      { method: 'PUT', path: '/api/admin/operating-hours' },
      { method: 'GET', path: '/api/admin/audit-logs' },
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, { method: ep.method });
      expect([401, 503]).toContain(res.status);
    }
  });
});

describe('Frontend Availability Diagnostic Classification (No Silent Fallback)', () => {
  it('distinguishes database schema errors, static HTML fallback missing creds, and network failures without returning simulated data', async () => {
    const {
      AvailabilityDiagnosticError,
      fetchIntervalAvailability,
      adminCreateWalkInBooking,
      adminFetchMaintenanceBlocks,
      adminCreateMaintenanceBlockRequest,
      adminDeactivateMaintenanceBlockRequest,
      adminCreatePricingRuleRequest,
      adminUpdatePricingRequest,
      adminUpsertOperatingHourRequest,
    } = await import('../services/bookingApi');
    const { classifyDbSchemaError } = await import(
      '../../supabase/functions/_shared/facilitySchedule'
    );

    expect(classifyDbSchemaError({ code: '42883', message: 'function does not exist' })).toBe(true);
    expect(classifyDbSchemaError({ code: 'PGRST202', message: 'schema cache miss' })).toBe(true);
    expect(classifyDbSchemaError({ code: '23505', message: 'duplicate key' })).toBe(false);

    expect(typeof adminCreateWalkInBooking).toBe('function');
    expect(typeof adminFetchMaintenanceBlocks).toBe('function');
    expect(typeof adminCreateMaintenanceBlockRequest).toBe('function');
    expect(typeof adminDeactivateMaintenanceBlockRequest).toBe('function');
    expect(typeof adminCreatePricingRuleRequest).toBe('function');
    expect(typeof adminUpdatePricingRequest).toBe('function');
    expect(typeof adminUpsertOperatingHourRequest).toBe('function');

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            code: 'DATABASE_SCHEMA_ERROR',
            error: 'Required Pick My Ball database tables or functions are missing.',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );

      await expect(
        fetchIntervalAvailability({
          date: '2026-11-28',
          startTime: '08:00',
          durationMinutes: 60,
        }),
      ).rejects.toMatchObject({
        name: 'AvailabilityDiagnosticError',
        kind: 'database_schema_error',
      });

      globalThis.fetch = async () =>
        new Response('<!doctype html><html><body>SPA</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });

      await expect(
        fetchIntervalAvailability({
          date: '2026-11-28',
          startTime: '08:00',
          durationMinutes: 60,
        }),
      ).rejects.toMatchObject({
        name: 'AvailabilityDiagnosticError',
        kind: 'missing_credentials',
      });

      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };

      await expect(
        fetchIntervalAvailability({
          date: '2026-11-28',
          startTime: '08:00',
          durationMinutes: 60,
        }),
      ).rejects.toMatchObject({
        name: 'AvailabilityDiagnosticError',
        kind: 'network_error',
      });

      const err = new AvailabilityDiagnosticError(
        'undeployed_functions',
        'Function not found',
        404,
      );
      expect(err.kind).toBe('undeployed_functions');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('allows same-origin Express requests matching Host while keeping cross-origin blocked', async () => {
    const sameOriginRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: baseUrl },
    });
    expect(sameOriginRes.status).toBe(200);
    expect(sameOriginRes.headers.get('access-control-allow-origin')).toBe(baseUrl);
  });
});

describe('Edge Fail-Closed Schedule & Missing Schema Protection', () => {
  it('fails closed when operating_hours or facility_settings queries error or return unseeded empty rows', async () => {
    const {
      classifyDbSchemaError,
      getFacilityOperatingBounds,
      validateScheduleAgainstFacility,
    } = await import('../../supabase/functions/_shared/facilitySchedule');

    expect(
      classifyDbSchemaError({
        code: 'PGRST205',
        message: "Could not find the table 'public.operating_hours' in the schema cache",
      }),
    ).toBe(true);

    const missingTableAdmin = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: null,
              error: {
                code: 'PGRST205',
                message: `Could not find the table 'public.${table}' in the schema cache`,
              },
            }),
            or: async () => ({
              data: null,
              error: {
                code: 'PGRST205',
                message: `Could not find the table 'public.${table}' in the schema cache`,
              },
            }),
          }),
        }),
      }),
    };

    const boundsErr = await getFacilityOperatingBounds(missingTableAdmin as never, '2026-11-28');
    expect(boundsErr).toMatchObject({
      ok: false,
      statusCode: 500,
      code: 'DATABASE_SCHEMA_ERROR',
    });

    const scheduleErr = await validateScheduleAgainstFacility(
      missingTableAdmin as never,
      '2026-11-28',
      '08:00',
      60,
      new Date('2026-11-23T00:00:00Z'),
    );
    expect(scheduleErr).toMatchObject({
      ok: false,
      statusCode: 500,
      code: 'DATABASE_SCHEMA_ERROR',
    });

    const unseededRowsAdmin = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data:
                table === 'facility_settings'
                  ? null
                  : { id: 'dummy' },
              error: null,
            }),
            or: async () => ({
              data: [],
              error: null,
            }),
          }),
        }),
      }),
    };

    const boundsUnseeded = await getFacilityOperatingBounds(
      unseededRowsAdmin as never,
      '2026-11-28',
    );
    expect(boundsUnseeded).toMatchObject({
      ok: false,
      statusCode: 500,
      code: 'DATABASE_SCHEMA_ERROR',
    });

    const scheduleUnseeded = await validateScheduleAgainstFacility(
      unseededRowsAdmin as never,
      '2026-11-28',
      '08:00',
      60,
      new Date('2026-11-23T00:00:00Z'),
    );
    expect(scheduleUnseeded).toMatchObject({
      ok: false,
      statusCode: 500,
      code: 'DATABASE_SCHEMA_ERROR',
    });
  });
});



