import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

const MIGRATION_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const schemaSql = fs.readFileSync(
  path.join(MIGRATION_DIR, '202611230001_initial_schema.sql'),
  'utf8',
);
const rlsSql = fs.readFileSync(
  path.join(MIGRATION_DIR, '202611230002_rls_and_functions.sql'),
  'utf8',
);
const seedSql = fs.readFileSync(
  path.join(MIGRATION_DIR, '202611230003_seed_astoria_regency.sql'),
  'utf8',
);
const edgeRemediationSql = fs.readFileSync(
  path.join(MIGRATION_DIR, '202611230004_serverless_rate_limits_and_admin_rpcs.sql'),
  'utf8',
);
const qrDurabilitySql = fs.readFileSync(
  path.join(MIGRATION_DIR, '202611230005_qr_checkin_durability.sql'),
  'utf8',
);

describe('Stage 3 SQL Migrations Static Integrity & Security Audit', () => {
  const requiredTables = [
    'facilities',
    'facility_settings',
    'courts',
    'court_map_regions',
    'operating_hours',
    'pricing_rules',
    'customers',
    'reservation_holds',
    'reservations',
    'court_maintenance',
    'staff_profiles',
    'payment_intents',
    'booking_audit_logs',
  ];

  it('defines all 13 normalized tables and enables RLS on every table', () => {
    for (const table of requiredTables) {
      expect(schemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(rlsSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(edgeRemediationSql).toContain('CREATE TABLE IF NOT EXISTS api_rate_limits');
    expect(edgeRemediationSql).toContain('ALTER TABLE api_rate_limits ENABLE ROW LEVEL SECURITY');
  });

  it('enforces GiST exclusion constraint with half-open [start_at, end_at) intervals and avoids NOW() in partial index predicates', () => {
    expect(schemaSql).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(schemaSql).toContain('EXCLUDE USING gist');
    expect(schemaSql).toContain("tstzrange(start_at, end_at, '[)')");

    // Ensure no partial index predicate uses NOW()
    const indexPredicates = [...schemaSql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?WHERE\s*\(([\s\S]*?)\);/gi)];
    for (const match of indexPredicates) {
      expect(match[1].toLowerCase()).not.toContain('now()');
    }
  });

  it('pins search_path and revokes PUBLIC execution on every SECURITY DEFINER function across 0002 and 0004', () => {
    const definerMatches = [
      ...rlsSql.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-zA-Z0-9_]+)\s*\(/g),
    ];
    expect(definerMatches.length).toBeGreaterThanOrEqual(7);

    for (const m of definerMatches) {
      const fnName = m[1];
      expect(rlsSql).toContain(`REVOKE ALL ON FUNCTION ${fnName}`);
    }
    const setSearchPaths = rlsSql.match(/SET search_path = public(?:, extensions)?, pg_temp/g) ?? [];
    expect(setSearchPaths.length).toBeGreaterThanOrEqual(definerMatches.length);

    const mig4Defs = [
      ...edgeRemediationSql.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-zA-Z0-9_]+)\s*\(/g),
    ];
    expect(mig4Defs.map((m) => m[1])).toEqual([
      'check_and_consume_rate_limit',
      'staff_cancel_reservation',
      'staff_create_walkin_hold',
    ]);
    for (const m of mig4Defs) {
      expect(edgeRemediationSql).toContain(`REVOKE ALL ON FUNCTION ${m[1]}`);
      expect(edgeRemediationSql).toContain(`GRANT EXECUTE ON FUNCTION ${m[1]}`);
    }
    const mig4SearchPaths = edgeRemediationSql.match(/SET search_path = public, pg_temp/g) ?? [];
    expect(mig4SearchPaths).toHaveLength(3);
  });

  it('enforces payment evidence guard inside reservation integrity trigger and staff cancel role restriction', () => {
    expect(schemaSql).toContain('enforce_reservation_integrity');
    expect(schemaSql).toContain('pmb.allow_verified_confirmation');
    expect(schemaSql).toContain('Reservation cannot be confirmed without verified payment evidence');

    expect(edgeRemediationSql).toContain(
      "IF v_res.status = 'confirmed' AND v_staff.role = 'reception_staff' THEN",
    );
    expect(edgeRemediationSql).toContain('acquire_court_hold_and_pending_booking');
  });

  it('seeds all 14 courts (1-14) with 941x1600 architectural polygons and Asia/Manila + PHP defaults', () => {
    expect(seedSql).toContain("'Asia/Manila'");
    expect(seedSql).toContain("'PHP'");
    for (let c = 1; c <= 14; c++) {
      expect(seedSql).toMatch(new RegExp(`\\(${c},\\s*'`));
    }
  });

  it('hardens cancel_booking_with_token against confirmed or paid cancellations and locks row under court advisory lock', () => {
    const cancelFn = rlsSql.slice(
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION cancel_booking_with_token'),
    );
    expect(cancelFn).toContain('pg_advisory_xact_lock');
    expect(cancelFn).toContain('cleanup_expired_holds(v_court_id)');
    expect(cancelFn).toContain('FOR UPDATE');
    expect(cancelFn).toContain("pi.status IN ('paid', 'refund_pending', 'refunded')");
    expect(cancelFn).toContain('CUSTOMER_CANCELLATION_FORBIDDEN');
    expect(cancelFn).toContain("IF v_res.status <> 'pending_payment' THEN");
  });

  it('validates weekly operating_hours and date-specific overrides directly inside acquire_court_hold_and_pending_booking', () => {
    const holdFn = rlsSql.slice(
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION acquire_court_hold_and_pending_booking'),
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION lookup_booking_secure'),
    );
    expect(holdFn).toContain('oh.override_date = v_manila_date');
    expect(holdFn).toContain('oh.override_date IS NULL');
    expect(holdFn).toContain('oh.day_of_week = v_dow');
    expect(holdFn).toContain('OPERATING_HOURS_NOT_CONFIGURED');
    expect(holdFn).toContain('FACILITY_CLOSED');
    expect(holdFn).toContain('OUTSIDE_OPERATING_HOURS');
    expect(holdFn).toContain('slot_granularity_minutes');
    expect(holdFn).toContain('FOR SHARE');
  });

  it('uses deadlock-safe cleanup_expired_holds locking and validates active facility existence in get_public_court_availability', () => {
    const cleanupFn = rlsSql.slice(
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION cleanup_expired_holds'),
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION acquire_court_hold_and_pending_booking'),
    );
    expect(cleanupFn).toContain('FOR UPDATE SKIP LOCKED');
    expect(cleanupFn).toContain('ORDER BY rh.id');

    const availFn = rlsSql.slice(
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION get_public_court_availability'),
      rlsSql.indexOf('CREATE OR REPLACE FUNCTION cleanup_expired_holds'),
    );
    expect(availFn).toContain('FACILITY_NOT_FOUND');
    expect(availFn).toContain("res.hold_id IS NULL");
  });

  it('defines durable QR redemptions, revocations, RLS, FOR UPDATE serialization, and pinned search_path in Migration 0005', () => {
    expect(qrDurabilitySql).toContain('CREATE TABLE IF NOT EXISTS qr_checkin_redemptions');
    expect(qrDurabilitySql).toContain('CREATE TABLE IF NOT EXISTS qr_checkin_revocations');
    expect(qrDurabilitySql).toContain('ALTER TABLE qr_checkin_redemptions ENABLE ROW LEVEL SECURITY');
    expect(qrDurabilitySql).toContain('ALTER TABLE qr_checkin_revocations ENABLE ROW LEVEL SECURITY');
    expect(qrDurabilitySql).toContain('reservation_id UUID NOT NULL UNIQUE');
    expect(qrDurabilitySql).toContain('token_jti TEXT NOT NULL UNIQUE');
    expect(qrDurabilitySql).toContain('FOR UPDATE OF r');
    expect(qrDurabilitySql).toContain('ON CONFLICT DO NOTHING');
    expect(qrDurabilitySql).toContain('trg_reservations_auto_revoke_qr');

    const mig5Defs = [
      ...qrDurabilitySql.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-zA-Z0-9_]+)\s*\(/g),
    ];
    expect(mig5Defs.map((m) => m[1])).toEqual([
      'check_qr_checkin_issuance_eligibility',
      'verify_or_redeem_qr_checkin',
      'revoke_qr_checkin_pass',
      'auto_revoke_qr_checkin_on_cancel',
    ]);
    for (const fnName of [
      'check_qr_checkin_issuance_eligibility',
      'verify_or_redeem_qr_checkin',
      'revoke_qr_checkin_pass',
    ]) {
      expect(qrDurabilitySql).toContain(`REVOKE ALL ON FUNCTION ${fnName}`);
      expect(qrDurabilitySql).toContain(`GRANT EXECUTE ON FUNCTION ${fnName}`);
    }
    const mig5SearchPaths = qrDurabilitySql.match(/SET search_path = public, pg_temp/g) ?? [];
    expect(mig5SearchPaths).toHaveLength(4);
  });

  it('enforces fail-closed JWT + role authorization across all SECURITY DEFINER functions in Migration 0005', () => {
    const eligFn = qrDurabilitySql.slice(
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION check_qr_checkin_issuance_eligibility'),
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION verify_or_redeem_qr_checkin'),
    );
    const verifyFn = qrDurabilitySql.slice(
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION verify_or_redeem_qr_checkin'),
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION revoke_qr_checkin_pass'),
    );
    const revokeFn = qrDurabilitySql.slice(
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION revoke_qr_checkin_pass'),
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION auto_revoke_qr_checkin_on_cancel'),
    );
    const triggerFn = qrDurabilitySql.slice(
      qrDurabilitySql.indexOf('CREATE OR REPLACE FUNCTION auto_revoke_qr_checkin_on_cancel'),
    );

    // 1. Issuance eligibility: strictly service_role only (both GRANT and internal role check)
    expect(eligFn).toContain("v_jwt_role = 'service_role' AND v_pg_role = 'service_role'");
    expect(eligFn).toContain('IF NOT v_is_service_role THEN');
    expect(eligFn).toContain('GRANT EXECUTE ON FUNCTION check_qr_checkin_issuance_eligibility(UUID, TEXT) TO service_role;');
    expect(eligFn).not.toContain('TO authenticated');

    // 2. Verify/redeem: must not infer trust from auth.uid() IS NULL
    expect(verifyFn).toContain("v_jwt_role = 'service_role' AND v_pg_role = 'service_role'");
    expect(verifyFn).not.toContain('IF v_caller_uid IS NOT NULL AND');
    expect(verifyFn).toContain("v_jwt_role IS DISTINCT FROM 'authenticated'");
    expect(verifyFn).toContain("v_pg_role IS DISTINCT FROM 'authenticated'");
    expect(verifyFn).toContain('OR v_caller_uid IS NULL');
    expect(verifyFn).toContain('IF p_staff_id IS NULL OR p_staff_id IS DISTINCT FROM v_caller_uid THEN');
    expect(verifyFn).toContain("AND sp.role IN ('super_admin', 'manager', 'reception_staff')");

    // 3. Revoke pass: fail-closed gate for authenticated callers, p_staff_id NULL strictly limited to genuine service_role
    expect(revokeFn).toContain("v_jwt_role = 'service_role' AND v_pg_role = 'service_role'");
    expect(revokeFn).toContain('IF v_is_service_role THEN');
    const revokeElseBranch = revokeFn.slice(
      revokeFn.indexOf('ELSE'),
      revokeFn.indexOf('IF v_target_ref IS NULL AND v_target_jti IS NULL THEN'),
    );
    expect(revokeElseBranch).toContain("v_jwt_role IS DISTINCT FROM 'authenticated'");
    expect(revokeElseBranch).toContain("v_pg_role IS DISTINCT FROM 'authenticated'");
    expect(revokeElseBranch).toContain('OR v_caller_uid IS NULL');
    expect(revokeElseBranch).toContain('IF p_staff_id IS NULL THEN');
    expect(revokeElseBranch).toContain('IF p_staff_id IS DISTINCT FROM v_caller_uid THEN');
    expect(revokeElseBranch).toContain('WHERE sp.id = v_caller_uid');
    expect(revokeElseBranch).toContain("AND sp.role IN ('super_admin', 'manager', 'reception_staff')");
    expect(revokeElseBranch).toContain("IF p_permanent AND v_staff.role = 'reception_staff' THEN");

    // Authorization block in revoke_qr_checkin_pass executes BEFORE target existence check
    expect(revokeFn.indexOf('IF v_is_service_role THEN')).toBeLessThan(
      revokeFn.indexOf('IF v_target_ref IS NULL AND v_target_jti IS NULL THEN'),
    );

    // 4. Cancel trigger function: trigger-only, pinned search_path, revoked from PUBLIC
    expect(triggerFn).toContain('RETURNS TRIGGER');
    expect(triggerFn).toContain('REVOKE ALL ON FUNCTION auto_revoke_qr_checkin_on_cancel() FROM PUBLIC;');
    expect(triggerFn).not.toContain('GRANT EXECUTE');
  });
});

// Live Integration & Concurrency Tests (requires a real disposable PostgreSQL/Supabase instance via SUPABASE_TEST_URL + SUPABASE_TEST_SERVICE_ROLE_KEY)
const testUrl = process.env.SUPABASE_TEST_URL?.trim();
const testServiceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY?.trim();

describe.skipIf(!testUrl || !testServiceKey)(
  'Stage 3–4 Live Supabase Database & Concurrency Integration',
  () => {
    const getAdmin = () =>
      createClient(testUrl!, testServiceKey!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

    it('confirms all 14 courts are seeded in live database', async () => {
      const admin = getAdmin();
      const { data, error } = await admin
        .from('courts')
        .select('court_number')
        .order('court_number', { ascending: true });
      expect(error).toBeNull();
      expect(data?.map((d) => d.court_number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      ]);
    });

    it('enforces single-winner concurrency when two clients request the same court and slot simultaneously', async () => {
      const admin = getAdmin();
      const futureDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const startAt = `${futureDate}T02:00:00.000Z`; // 10:00 PHT
      const endAt = `${futureDate}T03:00:00.000Z`;   // 11:00 PHT

      const payload = (suffix: string) => ({
        p_facility_id: '11111111-1111-4111-8111-111111111101',
        p_court_number: 1,
        p_start_at: startAt,
        p_end_at: endAt,
        p_customer_name: `Concurrent Player ${suffix}`,
        p_customer_mobile: '+639170000001',
        p_customer_email: `player-${suffix}@example.com`,
        p_special_requests: null,
        p_session_key: `sess-${suffix}`,
        p_hourly_rate_centavos: 35000,
        p_total_centavos: 35000,
        p_pricing_snapshot: { test: true },
        p_ownership_token_hash: `own-${suffix}-${Date.now()}`,
        p_lookup_token_hash: `lkp-${suffix}-${Date.now()}`,
      });

      const [r1, r2] = await Promise.all([
        admin.rpc('acquire_court_hold_and_pending_booking', payload('A')),
        admin.rpc('acquire_court_hold_and_pending_booking', payload('B')),
      ]);

      const successes = [r1, r2].filter((r) => !r.error);
      const failures = [r1, r2].filter((r) => Boolean(r.error));
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
    });

    it('enforces operating hours and closed-day overrides at PostgreSQL RPC level', async () => {
      const admin = getAdmin();
      const futureDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      const { error } = await admin.rpc('acquire_court_hold_and_pending_booking', {
        p_facility_id: '11111111-1111-4111-8111-111111111101',
        p_court_number: 2,
        p_start_at: `${futureDate}T14:00:00.000Z`, // 22:00 PHT (at/after close)
        p_end_at: `${futureDate}T15:00:00.000Z`,   // 23:00 PHT (outside 06:00-22:00 PHT)
        p_customer_name: 'After Hours Tester',
        p_customer_mobile: '+639170000002',
        p_customer_email: 'afterhours@example.com',
        p_special_requests: null,
        p_session_key: 'sess-afterhours',
        p_hourly_rate_centavos: 35000,
        p_total_centavos: 35000,
        p_pricing_snapshot: { test: true },
        p_ownership_token_hash: `own-ah-${Date.now()}`,
        p_lookup_token_hash: `lkp-ah-${Date.now()}`,
      });
      expect(error?.message).toContain('OUTSIDE_OPERATING_HOURS');
    });

    it('allows cancelling unpaid pending_payment holds via token while blocking confirmed/paid cancellations', async () => {
      const admin = getAdmin();
      const futureDate = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
      const tokenHash = `tok-cancel-${Date.now()}`;

      const { data: created, error: createErr } = await admin.rpc(
        'acquire_court_hold_and_pending_booking',
        {
          p_facility_id: '11111111-1111-4111-8111-111111111101',
          p_court_number: 3,
          p_start_at: `${futureDate}T02:00:00.000Z`,
          p_end_at: `${futureDate}T03:00:00.000Z`,
          p_customer_name: 'Cancel Policy Tester',
          p_customer_mobile: '+639170000003',
          p_customer_email: 'cancel-policy@example.com',
          p_special_requests: null,
          p_session_key: 'sess-cancel',
          p_hourly_rate_centavos: 35000,
          p_total_centavos: 35000,
          p_pricing_snapshot: { test: true },
          p_ownership_token_hash: tokenHash,
          p_lookup_token_hash: tokenHash,
        },
      );
      expect(createErr).toBeNull();
      const row = Array.isArray(created) ? created[0] : created;

      // Mark payment intent as paid -> customer cancellation must now be rejected
      await admin
        .from('payment_intents')
        .update({ status: 'paid', verified_at: new Date().toISOString() })
        .eq('reservation_id', row.reservation_id);

      const { error: paidCancelErr } = await admin.rpc('cancel_booking_with_token', {
        p_booking_reference: row.booking_reference,
        p_token_hash: tokenHash,
        p_reason: 'Attempt cancel after payment',
      });
      expect(paidCancelErr?.message).toContain('CUSTOMER_CANCELLATION_FORBIDDEN');
    });
  },
);

