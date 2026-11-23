import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentIntentStatusDb, ReservationStatusDb } from '../src/types/database.ts';
import { DEFAULT_FACILITY_ID } from './supabaseAdmin.ts';

export const QR_CHECKIN_TOKEN_PREFIX = 'chk_v1.';
const GRACE_WINDOW_SECONDS = 60 * 60; // Valid up to 60 minutes past scheduled slot end
const MIN_SECRET_LENGTH = 32;
const MIN_SECRET_DISTINCT_CHARS = 10;

const WEAK_PLACEHOLDER_PATTERNS = [
  /my_?qr_?checkin_?secret/i,
  /changeme/i,
  /placeholder/i,
  /example/i,
  /^(secret|password|default|test|dev|dummy)/i,
  /12345678/,
];

// Used strictly inside test runners when no explicit secret is supplied in unit tests.
const TEST_ONLY_EPHEMERAL_SECRET = crypto.randomBytes(32).toString('base64url');

export interface CheckInTokenClaims {
  v: 1;
  typ: 'pmb_qr_checkin';
  jti: string;
  ref: string;
  court: number;
  iat: number;
  exp: number;
}

export interface IssueQrCheckInInput {
  bookingReference: string;
  courtNumber: number;
  startAtIso: string;
  endAtIso: string;
  reservationStatus: ReservationStatusDb;
  paymentStatus: PaymentIntentStatusDb;
  adminClient?: SupabaseClient | null;
  durabilityStore?: QrCheckInDurabilityStore | null;
  secretOverride?: string;
  allowTestEphemeralFallback?: boolean;
  nowMs?: number;
}

export interface VerifiedCheckInOutput {
  valid: boolean;
  consumed: boolean;
  bookingReference: string;
  courtNumber: number;
  customerName: string | null;
  reservationStatus: ReservationStatusDb | 'confirmed';
  startAtIso: string | null;
  endAtIso: string | null;
  tokenJti: string;
  expiresAtIso: string;
  checkedInAtIso: string | null;
  message: string;
}

export type QrServiceResult<T> =
  | { ok: true; statusCode: number; data: T }
  | { ok: false; statusCode: number; code: string; error: string };

export interface QrSecretValidationOptions {
  secretOverride?: string;
  allowTestEphemeralFallback?: boolean;
}

export function isTestRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

export function validateQrCheckInSecret(
  options?: QrSecretValidationOptions,
): QrServiceResult<{ key: Buffer; isPersistent: boolean }> {
  const raw =
    options?.secretOverride !== undefined
      ? options.secretOverride
      : process.env.QR_CHECKIN_SECRET;
  const trimmed = raw?.trim() ?? '';

  if (!trimmed) {
    const canUseTestFallback =
      options?.allowTestEphemeralFallback !== undefined
        ? options.allowTestEphemeralFallback && isTestRuntime()
        : isTestRuntime();

    if (canUseTestFallback) {
      const key = crypto
        .createHash('sha256')
        .update('pmb-qr-checkin-test-v1:', 'utf8')
        .update(TEST_ONLY_EPHEMERAL_SECRET, 'utf8')
        .digest();
      return { ok: true, statusCode: 200, data: { key, isPersistent: false } };
    }

    return {
      ok: false,
      statusCode: 503,
      code: 'QR_CHECKIN_SECRET_MISSING',
      error:
        'QR_CHECKIN_SECRET must be set to a persistent strong secret (>= 32 characters) in production; ephemeral fallback keys are disabled outside tests.',
    };
  }

  if (trimmed.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      statusCode: 503,
      code: 'QR_CHECKIN_SECRET_WEAK',
      error: `QR_CHECKIN_SECRET must be at least ${MIN_SECRET_LENGTH} characters long.`,
    };
  }

  for (const pattern of WEAK_PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        statusCode: 503,
        code: 'QR_CHECKIN_SECRET_WEAK',
        error:
          'QR_CHECKIN_SECRET uses a weak or placeholder value. Generate a high-entropy secret (e.g. openssl rand -base64 32).',
      };
    }
  }

  const distinctChars = new Set(trimmed).size;
  if (distinctChars < MIN_SECRET_DISTINCT_CHARS) {
    return {
      ok: false,
      statusCode: 503,
      code: 'QR_CHECKIN_SECRET_WEAK',
      error:
        'QR_CHECKIN_SECRET lacks sufficient character diversity. Generate a random high-entropy secret (e.g. openssl rand -base64 32).',
    };
  }

  const key = crypto
    .createHash('sha256')
    .update('pmb-qr-checkin-v1:', 'utf8')
    .update(trimmed, 'utf8')
    .digest();

  return { ok: true, statusCode: 200, data: { key, isPersistent: true } };
}

function encodeBase64UrlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function signSegmentWithKey(unsignedToken: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(unsignedToken, 'utf8').digest('base64url');
}

// ---------------------------------------------------------------------------
// Durable Storage Abstraction (PostgreSQL RPCs in Production; Atomic Mutex in Tests)
// ---------------------------------------------------------------------------
export interface QrCheckInDurabilityStore {
  checkIssuanceEligibility(params: {
    facilityId: string;
    bookingReference: string;
    nowMs: number;
  }): Promise<QrServiceResult<{ eligible: true }>>;

  verifyOrRedeem(params: {
    facilityId: string;
    bookingReference: string;
    courtNumber: number;
    tokenJti: string;
    issuedAtEpoch: number;
    expiresAtIso: string;
    consume: boolean;
    staffUserId: string;
    nowMs: number;
  }): Promise<QrServiceResult<VerifiedCheckInOutput>>;

  revoke(params: {
    facilityId: string;
    bookingReference: string | null;
    tokenJti: string | null;
    reason: string;
    permanent: boolean;
    revokedBeforeEpoch: number;
    staffUserId: string | null;
    nowMs: number;
  }): Promise<
    QrServiceResult<{
      revoked: boolean;
      bookingReference: string | null;
      tokenJti: string | null;
      revokedAtIso: string;
    }>
  >;
}

function isMissingMigrationError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01') {
    return true;
  }
  const msg = error.message ?? '';
  return /could not find the function|function .* does not exist|relation "qr_checkin_/i.test(msg);
}

interface CheckEligibilityRpcRow {
  eligible: boolean;
  code: string;
  error_message: string | null;
}

interface VerifyOrRedeemRpcRow {
  ok: boolean;
  status_code: number;
  code: string;
  error_message: string | null;
  consumed: boolean;
  booking_reference: string;
  court_number: number;
  customer_name: string | null;
  reservation_status: ReservationStatusDb | null;
  start_at: string | null;
  end_at: string | null;
  checked_in_at: string | null;
}

interface RevokePassRpcRow {
  ok: boolean;
  status_code: number;
  code: string;
  error_message: string | null;
  booking_reference: string | null;
  token_jti: string | null;
  revoked_at: string;
}

export function createSupabaseQrDurabilityStore(
  client: SupabaseClient,
): QrCheckInDurabilityStore {
  return {
    async checkIssuanceEligibility(params) {
      const { data, error } = await client.rpc('check_qr_checkin_issuance_eligibility', {
        p_facility_id: params.facilityId,
        p_booking_reference: params.bookingReference,
      });

      if (error) {
        if (isMissingMigrationError(error)) {
          return {
            ok: false,
            statusCode: 503,
            code: 'QR_CHECKIN_MIGRATION_REQUIRED',
            error:
              'Migration 202611230005_qr_checkin_durability.sql must be applied in Supabase for durable QR check-in.',
          };
        }
        return {
          ok: false,
          statusCode: 502,
          code: 'QR_CHECKIN_STORE_ERROR',
          error: 'Unable to verify reservation QR eligibility in Supabase.',
        };
      }

      const row = (Array.isArray(data) ? data[0] : data) as CheckEligibilityRpcRow | null;
      if (!row) {
        return {
          ok: false,
          statusCode: 502,
          code: 'QR_CHECKIN_STORE_ERROR',
          error: 'Empty response from QR issuance eligibility check.',
        };
      }

      if (!row.eligible) {
        const statusCode =
          row.code === 'BOOKING_NOT_FOUND'
            ? 404
            : row.code === 'CHECKIN_ALREADY_REDEEMED'
              ? 409
              : 403;
        return {
          ok: false,
          statusCode,
          code: row.code,
          error: row.error_message ?? 'Booking is not eligible for QR check-in pass issuance.',
        };
      }

      return { ok: true, statusCode: 200, data: { eligible: true } };
    },

    async verifyOrRedeem(params) {
      const { data, error } = await client.rpc('verify_or_redeem_qr_checkin', {
        p_facility_id: params.facilityId,
        p_booking_reference: params.bookingReference,
        p_court_number: params.courtNumber,
        p_token_jti: params.tokenJti,
        p_issued_at_epoch: params.issuedAtEpoch,
        p_expires_at: params.expiresAtIso,
        p_consume: params.consume,
        p_staff_id: params.staffUserId,
      });

      if (error) {
        if (isMissingMigrationError(error)) {
          return {
            ok: false,
            statusCode: 503,
            code: 'QR_CHECKIN_MIGRATION_REQUIRED',
            error:
              'Atomic QR check-in requires migration 202611230005_qr_checkin_durability.sql to be applied on Supabase.',
          };
        }
        return {
          ok: false,
          statusCode: 502,
          code: 'QR_CHECKIN_STORE_ERROR',
          error: error.message || 'Unable to execute atomic QR check-in RPC in Supabase.',
        };
      }

      const row = (Array.isArray(data) ? data[0] : data) as VerifyOrRedeemRpcRow | null;
      if (!row) {
        return {
          ok: false,
          statusCode: 502,
          code: 'QR_CHECKIN_STORE_ERROR',
          error: 'Empty response from verify_or_redeem_qr_checkin RPC.',
        };
      }

      if (!row.ok) {
        return {
          ok: false,
          statusCode: row.status_code || 400,
          code: row.code || 'QR_CHECKIN_REJECTED',
          error: row.error_message ?? 'QR check-in verification failed.',
        };
      }

      return {
        ok: true,
        statusCode: 200,
        data: {
          valid: true,
          consumed: Boolean(row.consumed),
          bookingReference: row.booking_reference,
          courtNumber: row.court_number,
          customerName: row.customer_name,
          reservationStatus: row.reservation_status ?? 'confirmed',
          startAtIso: row.start_at,
          endAtIso: row.end_at,
          tokenJti: params.tokenJti,
          expiresAtIso: params.expiresAtIso,
          checkedInAtIso: row.checked_in_at,
          message: row.consumed
            ? `Check-in confirmed and pass redeemed for Court ${row.court_number} (${row.booking_reference}).`
            : `QR pass verified (valid until ${params.expiresAtIso}).`,
        },
      };
    },

    async revoke(params) {
      const { data, error } = await client.rpc('revoke_qr_checkin_pass', {
        p_facility_id: params.facilityId,
        p_booking_reference: params.bookingReference,
        p_token_jti: params.tokenJti,
        p_reason: params.reason,
        p_permanent: params.permanent,
        p_revoked_before_epoch: params.revokedBeforeEpoch,
        p_staff_id: params.staffUserId,
      });

      if (error) {
        if (isMissingMigrationError(error)) {
          return {
            ok: false,
            statusCode: 503,
            code: 'QR_CHECKIN_MIGRATION_REQUIRED',
            error:
              'Durable QR revocation requires migration 202611230005_qr_checkin_durability.sql to be applied on Supabase.',
          };
        }
        return {
          ok: false,
          statusCode: 502,
          code: 'QR_CHECKIN_STORE_ERROR',
          error: error.message || 'Unable to execute durable QR revocation RPC in Supabase.',
        };
      }

      const row = (Array.isArray(data) ? data[0] : data) as RevokePassRpcRow | null;
      if (!row) {
        return {
          ok: false,
          statusCode: 502,
          code: 'QR_CHECKIN_STORE_ERROR',
          error: 'Empty response from revoke_qr_checkin_pass RPC.',
        };
      }

      if (!row.ok) {
        return {
          ok: false,
          statusCode: row.status_code || 400,
          code: row.code || 'REVOCATION_FAILED',
          error: row.error_message ?? 'Unable to revoke QR pass.',
        };
      }

      return {
        ok: true,
        statusCode: 200,
        data: {
          revoked: true,
          bookingReference: row.booking_reference,
          tokenJti: row.token_jti,
          revokedAtIso: row.revoked_at,
        },
      };
    },
  };
}

export interface AtomicTestReservationRecord {
  bookingReference: string;
  courtNumber: number;
  customerName: string;
  status: ReservationStatusDb;
  paymentStatus: PaymentIntentStatusDb;
  startAtIso: string;
  endAtIso: string;
}

export function createInMemoryAtomicTestStore(
  initialReservations?: AtomicTestReservationRecord[],
): QrCheckInDurabilityStore & {
  upsertReservation(record: AtomicTestReservationRecord): void;
  getRedemptionCount(bookingReference: string): number;
  clear(): void;
} {
  const reservations = new Map<string, AtomicTestReservationRecord>();
  const redeemedByRef = new Map<string, { jti: string; checkedInAtIso: string; staffUserId: string }>();
  const redeemedByJti = new Map<string, string>();
  const revokedJtis = new Map<string, { reason: string; revokedAtIso: string }>();
  const bookingRevocations = new Map<
    string,
    Array<{ permanent: boolean; revokedBeforeEpoch: number; reason: string; revokedAtIso: string }>
  >();

  // Per-booking promise chain simulating PostgreSQL SELECT ... FOR UPDATE OF reservations serialization
  const lockQueues = new Map<string, Promise<unknown>>();
  async function withLock<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const prev = lockQueues.get(key) ?? Promise.resolve();
    const run = prev.then(
      () => task(),
      () => task(),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    lockQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (lockQueues.get(key) === tail) {
        lockQueues.delete(key);
      }
    }
  }

  for (const r of initialReservations ?? []) {
    reservations.set(r.bookingReference.toUpperCase(), r);
  }

  return {
    upsertReservation(record) {
      reservations.set(record.bookingReference.toUpperCase(), record);
    },
    getRedemptionCount(bookingReference) {
      return redeemedByRef.has(bookingReference.toUpperCase()) ? 1 : 0;
    },
    clear() {
      reservations.clear();
      redeemedByRef.clear();
      redeemedByJti.clear();
      revokedJtis.clear();
      bookingRevocations.clear();
      lockQueues.clear();
    },

    async checkIssuanceEligibility(params) {
      const ref = params.bookingReference.trim().toUpperCase();
      return withLock(ref, () => {
        const resRecord = reservations.get(ref);
        if (resRecord && (resRecord.status !== 'confirmed' || resRecord.paymentStatus !== 'paid')) {
          return {
            ok: false,
            statusCode: 403,
            code: 'QR_NOT_ELIGIBLE',
            error:
              'Check-in QR passes are issued only after verified payment confirmation (confirmed + paid).',
          };
        }

        if (redeemedByRef.has(ref)) {
          return {
            ok: false,
            statusCode: 409,
            code: 'CHECKIN_ALREADY_REDEEMED',
            error: `Booking ${ref} has already been checked in at reception.`,
          };
        }

        const revList = bookingRevocations.get(ref) ?? [];
        const permanentRev = revList.find((r) => r.permanent);
        if (permanentRev) {
          return {
            ok: false,
            statusCode: 403,
            code: 'CHECKIN_TOKEN_REVOKED',
            error: `Check-in privileges for ${ref} have been revoked (${permanentRev.reason}).`,
          };
        }

        return { ok: true, statusCode: 200, data: { eligible: true } };
      });
    },

    async verifyOrRedeem(params) {
      const ref = params.bookingReference.trim().toUpperCase();
      return withLock(ref, async () => {
        // Yield a microtask so concurrent Promise.all test callers race genuinely across awaits
        await Promise.resolve();

        const resRecord = reservations.get(ref);
        if (resRecord) {
          if (resRecord.status !== 'confirmed') {
            return {
              ok: false,
              statusCode: 403,
              code: 'RESERVATION_NOT_CONFIRMED',
              error: `Check-in denied: reservation ${ref} has status "${resRecord.status}". Only confirmed reservations can check in.`,
            };
          }
          if (resRecord.courtNumber !== params.courtNumber) {
            return {
              ok: false,
              statusCode: 409,
              code: 'COURT_MISMATCH',
              error: `Check-in denied: token is for Court ${params.courtNumber}, but reservation is assigned to Court ${resRecord.courtNumber}.`,
            };
          }
        }

        if (params.nowMs > Date.parse(params.expiresAtIso)) {
          return {
            ok: false,
            statusCode: 410,
            code: 'CHECKIN_TOKEN_EXPIRED',
            error: 'This check-in QR token has expired.',
          };
        }

        const jtiRev = revokedJtis.get(params.tokenJti);
        if (jtiRev) {
          return {
            ok: false,
            statusCode: 403,
            code: 'CHECKIN_TOKEN_REVOKED',
            error: `This QR check-in token has been revoked (${jtiRev.reason}).`,
          };
        }

        const revList = bookingRevocations.get(ref) ?? [];
        const matchingRev = revList.find(
          (r) => r.permanent || params.issuedAtEpoch <= r.revokedBeforeEpoch,
        );
        if (matchingRev) {
          return {
            ok: false,
            statusCode: 403,
            code: 'CHECKIN_TOKEN_REVOKED',
            error: `Check-in tokens for ${ref} have been revoked (${matchingRev.reason}).`,
          };
        }

        const existingRedemption = redeemedByRef.get(ref);
        if (existingRedemption || redeemedByJti.has(params.tokenJti)) {
          return {
            ok: false,
            statusCode: 409,
            code: 'CHECKIN_ALREADY_REDEEMED',
            error: `Reservation ${ref} was already checked in at ${existingRedemption?.checkedInAtIso ?? 'earlier'}.`,
          };
        }

        const nowIso = new Date(params.nowMs).toISOString();
        if (params.consume) {
          redeemedByRef.set(ref, {
            jti: params.tokenJti,
            checkedInAtIso: nowIso,
            staffUserId: params.staffUserId,
          });
          redeemedByJti.set(params.tokenJti, ref);
        }

        return {
          ok: true,
          statusCode: 200,
          data: {
            valid: true,
            consumed: params.consume,
            bookingReference: ref,
            courtNumber: resRecord?.courtNumber ?? params.courtNumber,
            customerName: resRecord?.customerName ?? null,
            reservationStatus: resRecord?.status ?? 'confirmed',
            startAtIso: resRecord?.startAtIso ?? null,
            endAtIso: resRecord?.endAtIso ?? null,
            tokenJti: params.tokenJti,
            expiresAtIso: params.expiresAtIso,
            checkedInAtIso: params.consume ? nowIso : null,
            message: params.consume
              ? `Check-in confirmed and pass redeemed for Court ${params.courtNumber} (${ref}).`
              : `QR pass verified (valid until ${params.expiresAtIso}).`,
          },
        };
      });
    },

    async revoke(params) {
      const ref = params.bookingReference?.trim().toUpperCase() || null;
      const lockKey = ref ?? params.tokenJti ?? 'global-revoke';
      return withLock(lockKey, () => {
        const nowIso = new Date(params.nowMs).toISOString();
        if (params.tokenJti) {
          revokedJtis.set(params.tokenJti, { reason: params.reason, revokedAtIso: nowIso });
        }
        if (ref) {
          const list = bookingRevocations.get(ref) ?? [];
          list.push({
            permanent: params.permanent,
            revokedBeforeEpoch: params.revokedBeforeEpoch,
            reason: params.reason,
            revokedAtIso: nowIso,
          });
          bookingRevocations.set(ref, list);
        }
        return {
          ok: true,
          statusCode: 200,
          data: {
            revoked: true,
            bookingReference: ref,
            tokenJti: params.tokenJti,
            revokedAtIso: nowIso,
          },
        };
      });
    },
  };
}

let defaultTestDurabilityStore = createInMemoryAtomicTestStore();

export function resetQrCheckInStoreForTests(): void {
  defaultTestDurabilityStore.clear();
  defaultTestDurabilityStore = createInMemoryAtomicTestStore();
}

function resolveDurabilityStore(params: {
  durabilityStore?: QrCheckInDurabilityStore | null;
  adminClient?: SupabaseClient | null;
  dbClient?: SupabaseClient | null;
  requireDurableStore?: boolean;
}): QrServiceResult<QrCheckInDurabilityStore> {
  if (params.durabilityStore) {
    return { ok: true, statusCode: 200, data: params.durabilityStore };
  }

  const supabaseClient = params.adminClient ?? params.dbClient ?? null;
  if (supabaseClient) {
    return { ok: true, statusCode: 200, data: createSupabaseQrDurabilityStore(supabaseClient) };
  }

  if (!params.requireDurableStore && isTestRuntime()) {
    return { ok: true, statusCode: 200, data: defaultTestDurabilityStore };
  }

  return {
    ok: false,
    statusCode: 503,
    code: 'DURABLE_STORE_UNAVAILABLE',
    error:
      'Durable Supabase PostgreSQL connection is required for production QR check-in verification, redemption, and revocation.',
  };
}

// ---------------------------------------------------------------------------
// QR Input Extraction & Core Token Issue / Verify / Revoke Operations
// ---------------------------------------------------------------------------
export function extractCheckInTokenFromQrInput(rawInput: string): {
  checkInToken: string | null;
  rejectedLegacyLookupFormat: boolean;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { checkInToken: null, rejectedLegacyLookupFormat: false };
  }

  if (trimmed.startsWith('pmb://') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const dedicatedToken = parsed.searchParams.get('t')?.trim() ?? null;
      const legacyLookupParam = parsed.searchParams.get('token')?.trim() ?? null;

      if (legacyLookupParam && !dedicatedToken) {
        return { checkInToken: null, rejectedLegacyLookupFormat: true };
      }

      if (dedicatedToken && dedicatedToken.startsWith(QR_CHECKIN_TOKEN_PREFIX)) {
        return { checkInToken: dedicatedToken, rejectedLegacyLookupFormat: false };
      }
      return { checkInToken: null, rejectedLegacyLookupFormat: false };
    } catch {
      return { checkInToken: null, rejectedLegacyLookupFormat: false };
    }
  }

  if (trimmed.startsWith(QR_CHECKIN_TOKEN_PREFIX)) {
    return { checkInToken: trimmed, rejectedLegacyLookupFormat: false };
  }

  return { checkInToken: null, rejectedLegacyLookupFormat: false };
}

export async function issueServerQrCheckInToken(
  input: IssueQrCheckInInput,
): Promise<
  QrServiceResult<{
    checkInToken: string;
    jti: string;
    bookingReference: string;
    courtNumber: number;
    issuedAtIso: string;
    expiresAtIso: string;
    qrPayload: string;
  }>
> {
  const secretCheck = validateQrCheckInSecret({
    secretOverride: input.secretOverride,
    allowTestEphemeralFallback: input.allowTestEphemeralFallback,
  });
  if (!secretCheck.ok) {
    return secretCheck;
  }

  if (input.reservationStatus !== 'confirmed' || input.paymentStatus !== 'paid') {
    return {
      ok: false,
      statusCode: 403,
      code: 'QR_NOT_ELIGIBLE',
      error:
        'Check-in QR passes are issued only after verified payment confirmation (confirmed + paid).',
    };
  }

  const ref = input.bookingReference.trim().toUpperCase();
  if (!/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/.test(ref)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_BOOKING_REFERENCE',
      error: 'Invalid booking reference format.',
    };
  }

  if (!Number.isInteger(input.courtNumber) || input.courtNumber < 1 || input.courtNumber > 14) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_COURT_NUMBER',
      error: 'Court number must be between 1 and 14.',
    };
  }

  const endMs = Date.parse(input.endAtIso);
  if (!Number.isFinite(endMs)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_RESERVATION_WINDOW',
      error: 'Reservation end timestamp is invalid.',
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const expSec = Math.floor(endMs / 1000) + GRACE_WINDOW_SECONDS;
  if (nowSec >= expSec) {
    return {
      ok: false,
      statusCode: 410,
      code: 'CHECKIN_WINDOW_EXPIRED',
      error: 'The check-in window for this reservation has already expired.',
    };
  }

  // Check durable ledger when adminClient or explicit durabilityStore is configured (or inside tests)
  if (input.durabilityStore || input.adminClient || isTestRuntime()) {
    const storeRes = resolveDurabilityStore({
      durabilityStore: input.durabilityStore,
      adminClient: input.adminClient,
      requireDurableStore: false,
    });
    if (storeRes.ok) {
      const elig = await storeRes.data.checkIssuanceEligibility({
        facilityId: DEFAULT_FACILITY_ID,
        bookingReference: ref,
        nowMs,
      });
      if (!elig.ok) {
        return elig;
      }
    }
  }

  const jti = crypto.randomBytes(16).toString('base64url');
  const claims: CheckInTokenClaims = {
    v: 1,
    typ: 'pmb_qr_checkin',
    jti,
    ref,
    court: input.courtNumber,
    iat: nowSec,
    exp: expSec,
  };

  const payloadB64 = encodeBase64UrlJson(claims);
  const unsigned = `${QR_CHECKIN_TOKEN_PREFIX}${payloadB64}`;
  const sig = signSegmentWithKey(unsigned, secretCheck.data.key);
  const checkInToken = `${unsigned}.${sig}`;

  return {
    ok: true,
    statusCode: 200,
    data: {
      checkInToken,
      jti,
      bookingReference: ref,
      courtNumber: input.courtNumber,
      issuedAtIso: new Date(nowSec * 1000).toISOString(),
      expiresAtIso: new Date(expSec * 1000).toISOString(),
      qrPayload: `pmb://astoria-regency/checkin?t=${encodeURIComponent(checkInToken)}`,
    },
  };
}

export function verifySignedCheckInClaims(
  rawToken: string,
  nowMs?: number,
  secretOptions?: QrSecretValidationOptions,
): QrServiceResult<CheckInTokenClaims> {
  const secretCheck = validateQrCheckInSecret(secretOptions);
  if (!secretCheck.ok) {
    return secretCheck;
  }

  if (!rawToken.startsWith(QR_CHECKIN_TOKEN_PREFIX)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CHECKIN_TOKEN_FORMAT',
      error: 'QR code does not contain a valid server-issued Pick My Ball check-in token.',
    };
  }

  const parts = rawToken.split('.');
  if (parts.length !== 3 || parts[0] !== 'chk_v1' || !parts[1] || !parts[2]) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CHECKIN_TOKEN_FORMAT',
      error: 'Malformed check-in token structure.',
    };
  }

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expectedSig = signSegmentWithKey(unsigned, secretCheck.data.key);
  const providedBuf = Buffer.from(parts[2], 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return {
      ok: false,
      statusCode: 401,
      code: 'INVALID_CHECKIN_SIGNATURE',
      error: 'Check-in token signature verification failed. Pass may be tampered or signed by a mismatched secret.',
    };
  }

  let claims: CheckInTokenClaims;
  try {
    const parsedJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    claims = JSON.parse(parsedJson) as CheckInTokenClaims;
  } catch {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CHECKIN_CLAIMS',
      error: 'Check-in token payload could not be decoded.',
    };
  }

  if (
    !claims ||
    claims.v !== 1 ||
    claims.typ !== 'pmb_qr_checkin' ||
    typeof claims.jti !== 'string' ||
    claims.jti.length < 8 ||
    typeof claims.ref !== 'string' ||
    !/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/.test(claims.ref) ||
    !Number.isInteger(claims.court) ||
    claims.court < 1 ||
    claims.court > 14 ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CHECKIN_CLAIMS',
      error: 'Check-in token claims failed structural validation.',
    };
  }

  const nowSec = Math.floor((nowMs ?? Date.now()) / 1000);
  if (nowSec > claims.exp) {
    return {
      ok: false,
      statusCode: 410,
      code: 'CHECKIN_TOKEN_EXPIRED',
      error: 'This check-in QR token has expired.',
    };
  }

  return { ok: true, statusCode: 200, data: claims };
}

export async function verifyAndConsumeQrCheckInToken(params: {
  qrPayloadOrToken: string;
  consume?: boolean;
  staffUserId: string;
  dbClient?: SupabaseClient | null;
  adminClient?: SupabaseClient | null;
  durabilityStore?: QrCheckInDurabilityStore | null;
  requireDurableStore?: boolean;
  secretOverride?: string;
  allowTestEphemeralFallback?: boolean;
  nowMs?: number;
}): Promise<QrServiceResult<VerifiedCheckInOutput>> {
  const extracted = extractCheckInTokenFromQrInput(params.qrPayloadOrToken);
  if (extracted.rejectedLegacyLookupFormat) {
    return {
      ok: false,
      statusCode: 400,
      code: 'UNSUPPORTED_LEGACY_QR_FORMAT',
      error:
        'Rejected unsupported QR payload format. Only dedicated server-signed check-in tokens (?t=chk_v1...) are accepted.',
    };
  }

  if (!extracted.checkInToken) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_CHECKIN_TOKEN_FORMAT',
      error: 'Provide a valid Pick My Ball QR URI or chk_v1 check-in token.',
    };
  }

  const nowMs = params.nowMs ?? Date.now();
  const verified = verifySignedCheckInClaims(extracted.checkInToken, nowMs, {
    secretOverride: params.secretOverride,
    allowTestEphemeralFallback: params.allowTestEphemeralFallback,
  });
  if (!verified.ok) {
    return verified;
  }

  const storeRes = resolveDurabilityStore({
    durabilityStore: params.durabilityStore,
    adminClient: params.adminClient,
    dbClient: params.dbClient,
    requireDurableStore: params.requireDurableStore,
  });
  if (!storeRes.ok) {
    return storeRes;
  }

  const claims = verified.data;
  return storeRes.data.verifyOrRedeem({
    facilityId: DEFAULT_FACILITY_ID,
    bookingReference: claims.ref,
    courtNumber: claims.court,
    tokenJti: claims.jti,
    issuedAtEpoch: claims.iat,
    expiresAtIso: new Date(claims.exp * 1000).toISOString(),
    consume: params.consume !== false,
    staffUserId: params.staffUserId,
    nowMs,
  });
}

export async function revokeQrCheckInTokens(params: {
  bookingReference?: string;
  qrPayloadOrToken?: string;
  reason: string;
  permanent?: boolean;
  staffUserId?: string | null;
  dbClient?: SupabaseClient | null;
  adminClient?: SupabaseClient | null;
  durabilityStore?: QrCheckInDurabilityStore | null;
  requireDurableStore?: boolean;
  secretOverride?: string;
  allowTestEphemeralFallback?: boolean;
  nowMs?: number;
}): Promise<
  QrServiceResult<{
    revoked: boolean;
    bookingReference: string | null;
    tokenJti: string | null;
    revokedAtIso: string;
  }>
> {
  const nowMs = params.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  let targetRef = params.bookingReference?.trim().toUpperCase() || null;
  let targetJti: string | null = null;

  if (params.qrPayloadOrToken) {
    const extracted = extractCheckInTokenFromQrInput(params.qrPayloadOrToken);
    if (extracted.rejectedLegacyLookupFormat) {
      return {
        ok: false,
        statusCode: 400,
        code: 'UNSUPPORTED_LEGACY_QR_FORMAT',
        error: 'Legacy QR format is unsupported.',
      };
    }
    if (extracted.checkInToken) {
      const verified = verifySignedCheckInClaims(extracted.checkInToken, nowMs, {
        secretOverride: params.secretOverride,
        allowTestEphemeralFallback: params.allowTestEphemeralFallback,
      });
      if (!verified.ok) {
        // Still surface secret misconfiguration cleanly or reject forged tokens
        return verified;
      }
      targetJti = verified.data.jti;
      targetRef = targetRef ?? verified.data.ref;
    }
  }

  if (!targetRef && !targetJti) {
    return {
      ok: false,
      statusCode: 400,
      code: 'REVOCATION_TARGET_REQUIRED',
      error: 'Provide a booking reference or valid check-in token to revoke.',
    };
  }

  const storeRes = resolveDurabilityStore({
    durabilityStore: params.durabilityStore,
    adminClient: params.adminClient,
    dbClient: params.dbClient,
    requireDurableStore: params.requireDurableStore,
  });
  if (!storeRes.ok) {
    return storeRes;
  }

  return storeRes.data.revoke({
    facilityId: DEFAULT_FACILITY_ID,
    bookingReference: targetRef,
    tokenJti: targetJti,
    reason: params.reason,
    permanent: Boolean(params.permanent),
    revokedBeforeEpoch: nowSec,
    staffUserId: params.staffUserId ?? null,
    nowMs,
  });
}

/**
 * Factory creating an isolated QR check-in instance with zero shared process-local
 * mutable state—used to test multi-instance Cloud Run deployments and restart recovery.
 */
export function createQrCheckInManager(config: {
  secretOverride?: string;
  allowTestEphemeralFallback?: boolean;
  durabilityStore?: QrCheckInDurabilityStore | null;
  requireDurableStore?: boolean;
}) {
  return {
    validateSecret: () =>
      validateQrCheckInSecret({
        secretOverride: config.secretOverride,
        allowTestEphemeralFallback: config.allowTestEphemeralFallback,
      }),
    issue: (input: Omit<IssueQrCheckInInput, 'secretOverride' | 'allowTestEphemeralFallback' | 'durabilityStore'>) =>
      issueServerQrCheckInToken({
        ...input,
        secretOverride: config.secretOverride,
        allowTestEphemeralFallback: config.allowTestEphemeralFallback,
        durabilityStore: config.durabilityStore,
      }),
    verifyOrRedeem: (
      params: Omit<
        Parameters<typeof verifyAndConsumeQrCheckInToken>[0],
        'secretOverride' | 'allowTestEphemeralFallback' | 'durabilityStore' | 'requireDurableStore'
      >,
    ) =>
      verifyAndConsumeQrCheckInToken({
        ...params,
        secretOverride: config.secretOverride,
        allowTestEphemeralFallback: config.allowTestEphemeralFallback,
        durabilityStore: config.durabilityStore,
        requireDurableStore: config.requireDurableStore,
      }),
    revoke: (
      params: Omit<
        Parameters<typeof revokeQrCheckInTokens>[0],
        'secretOverride' | 'allowTestEphemeralFallback' | 'durabilityStore' | 'requireDurableStore'
      >,
    ) =>
      revokeQrCheckInTokens({
        ...params,
        secretOverride: config.secretOverride,
        allowTestEphemeralFallback: config.allowTestEphemeralFallback,
        durabilityStore: config.durabilityStore,
        requireDurableStore: config.requireDurableStore,
      }),
  };
}
