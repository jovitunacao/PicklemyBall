import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentIntentStatusDb, ReservationStatusDb } from '../src/types/database.ts';
import { DEFAULT_FACILITY_ID } from './supabaseAdmin.ts';

export const QR_CHECKIN_TOKEN_PREFIX = 'chk_v1.';
const GRACE_WINDOW_SECONDS = 60 * 60; // Valid up to 60 minutes past scheduled slot end

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
  nowMs?: number;
}

export type QrServiceResult<T> =
  | { ok: true; statusCode: number; data: T }
  | { ok: false; statusCode: number; code: string; error: string };

interface RevokedJtiRecord {
  reason: 'staff_revoked' | 'checked_in' | 'reservation_cancelled';
  revokedAtIso: string;
  actorId?: string | null;
}

interface RevokedBookingRecord {
  revokedAtEpochSec: number;
  permanent: boolean;
  reason: string;
}

interface RedeemedRecord {
  jti: string;
  checkedInAtIso: string;
  staffUserId?: string;
}

// Per-process signing fallback if QR_CHECKIN_SECRET is not provided in environment
const runtimeEphemeralSecret = crypto.randomBytes(32);

function getQrSigningKey(): Buffer {
  const configured = process.env.QR_CHECKIN_SECRET?.trim();
  if (configured) {
    return crypto.createHash('sha256').update(configured, 'utf8').digest();
  }
  return runtimeEphemeralSecret;
}

// Server-side revocation and single-use check-in registries
const revokedJtis = new Map<string, RevokedJtiRecord>();
const revokedBookings = new Map<string, RevokedBookingRecord>();
const redeemedBookings = new Map<string, RedeemedRecord>();

export function resetQrCheckInStoreForTests(): void {
  revokedJtis.clear();
  revokedBookings.clear();
  redeemedBookings.clear();
}

function encodeBase64UrlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function signSegment(unsignedToken: string): string {
  return crypto
    .createHmac('sha256', getQrSigningKey())
    .update(unsignedToken, 'utf8')
    .digest('base64url');
}

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

export function issueServerQrCheckInToken(
  input: IssueQrCheckInInput,
): QrServiceResult<{
  checkInToken: string;
  jti: string;
  bookingReference: string;
  courtNumber: number;
  issuedAtIso: string;
  expiresAtIso: string;
  qrPayload: string;
}> {
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

  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const expSec = Math.floor(endMs / 1000) + GRACE_WINDOW_SECONDS;
  if (nowSec >= expSec) {
    return {
      ok: false,
      statusCode: 410,
      code: 'CHECKIN_WINDOW_EXPIRED',
      error: 'The check-in window for this reservation has already expired.',
    };
  }

  const bookingRevocation = revokedBookings.get(ref);
  if (bookingRevocation?.permanent) {
    return {
      ok: false,
      statusCode: 403,
      code: 'CHECKIN_TOKEN_REVOKED',
      error: `Check-in privileges for ${ref} have been revoked (${bookingRevocation.reason}).`,
    };
  }

  if (redeemedBookings.has(ref)) {
    return {
      ok: false,
      statusCode: 409,
      code: 'CHECKIN_ALREADY_REDEEMED',
      error: `Booking ${ref} has already been checked in at reception.`,
    };
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
  const sig = signSegment(unsigned);
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
): QrServiceResult<CheckInTokenClaims> {
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
  const expectedSig = signSegment(unsigned);
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
      error: 'Check-in token signature verification failed. Pass may be tampered or from an expired key.',
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

  const jtiRevocation = revokedJtis.get(claims.jti);
  if (jtiRevocation) {
    if (jtiRevocation.reason === 'checked_in') {
      return {
        ok: false,
        statusCode: 409,
        code: 'CHECKIN_ALREADY_REDEEMED',
        error: `This QR check-in token was already redeemed at ${jtiRevocation.revokedAtIso}.`,
      };
    }
    return {
      ok: false,
      statusCode: 403,
      code: 'CHECKIN_TOKEN_REVOKED',
      error: `This QR check-in token has been revoked (${jtiRevocation.reason}).`,
    };
  }

  const bookingRevocation = revokedBookings.get(claims.ref);
  if (
    bookingRevocation &&
    (bookingRevocation.permanent || claims.iat <= bookingRevocation.revokedAtEpochSec)
  ) {
    return {
      ok: false,
      statusCode: 403,
      code: 'CHECKIN_TOKEN_REVOKED',
      error: `Check-in tokens for ${claims.ref} have been revoked (${bookingRevocation.reason}).`,
    };
  }

  const bookingRedeemed = redeemedBookings.get(claims.ref);
  if (bookingRedeemed) {
    return {
      ok: false,
      statusCode: 409,
      code: 'CHECKIN_ALREADY_REDEEMED',
      error: `Reservation ${claims.ref} was already checked in at ${bookingRedeemed.checkedInAtIso}.`,
    };
  }

  return { ok: true, statusCode: 200, data: claims };
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

interface ReservationDbCheckRow {
  id: string;
  facility_id: string;
  booking_reference: string;
  status: ReservationStatusDb;
  start_at: string;
  end_at: string;
  courts: { court_number: number } | { court_number: number }[] | null;
  customers: { full_name: string } | { full_name: string }[] | null;
}

export async function verifyAndConsumeQrCheckInToken(params: {
  qrPayloadOrToken: string;
  consume?: boolean;
  staffUserId: string;
  dbClient?: SupabaseClient | null;
  adminClient?: SupabaseClient | null;
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

  const verified = verifySignedCheckInClaims(extracted.checkInToken, params.nowMs);
  if (!verified.ok) {
    return verified;
  }

  const claims = verified.data;
  const consume = params.consume !== false;
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();

  let dbRow: ReservationDbCheckRow | null = null;
  const reader = params.adminClient ?? params.dbClient ?? null;

  if (reader) {
    const { data, error } = await reader
      .from('reservations')
      .select('id, facility_id, booking_reference, status, start_at, end_at, courts(court_number), customers(full_name)')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .eq('booking_reference', claims.ref)
      .maybeSingle<ReservationDbCheckRow>();

    if (error) {
      return {
        ok: false,
        statusCode: 502,
        code: 'RESERVATION_LOOKUP_ERROR',
        error: 'Unable to validate reservation status in database during check-in.',
      };
    }

    if (!data) {
      return {
        ok: false,
        statusCode: 404,
        code: 'BOOKING_NOT_FOUND',
        error: `No facility reservation found matching ${claims.ref}.`,
      };
    }

    dbRow = data;

    if (dbRow.status !== 'confirmed') {
      return {
        ok: false,
        statusCode: 403,
        code: 'RESERVATION_NOT_CONFIRMED',
        error: `Check-in denied: reservation ${claims.ref} has status "${dbRow.status}". Only confirmed reservations can check in.`,
      };
    }

    const courtObj = Array.isArray(dbRow.courts) ? dbRow.courts[0] : dbRow.courts;
    if (courtObj && courtObj.court_number !== claims.court) {
      return {
        ok: false,
        statusCode: 409,
        code: 'COURT_MISMATCH',
        error: `Check-in denied: token is for Court ${claims.court}, but reservation is assigned to Court ${courtObj.court_number}.`,
      };
    }

    // Check PostgreSQL audit log ledger for cross-instance revocations or redemptions when readable
    const { data: logs } = await reader
      .from('booking_audit_logs')
      .select('event_type, payload, created_at')
      .eq('reservation_id', dbRow.id)
      .in('event_type', ['qr_checkin_token_revoked', 'qr_checkin_redeemed'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (Array.isArray(logs)) {
      for (const entry of logs) {
        const payload = (entry.payload ?? {}) as Record<string, unknown>;
        if (entry.event_type === 'qr_checkin_redeemed') {
          return {
            ok: false,
            statusCode: 409,
            code: 'CHECKIN_ALREADY_REDEEMED',
            error: `Reservation ${claims.ref} was already checked in at ${entry.created_at}.`,
          };
        }
        if (entry.event_type === 'qr_checkin_token_revoked') {
          const revJti = typeof payload.jti === 'string' ? payload.jti : null;
          const revPermanent = payload.permanent === true;
          const revEpoch =
            typeof payload.revoked_at_epoch_sec === 'number'
              ? payload.revoked_at_epoch_sec
              : Math.floor(Date.parse(entry.created_at) / 1000);
          if (revPermanent || revJti === claims.jti || claims.iat <= revEpoch) {
            return {
              ok: false,
              statusCode: 403,
              code: 'CHECKIN_TOKEN_REVOKED',
              error: 'This QR check-in pass was revoked by facility staff.',
            };
          }
        }
      }
    }
  }

  if (consume) {
    revokedJtis.set(claims.jti, {
      reason: 'checked_in',
      revokedAtIso: nowIso,
      actorId: params.staffUserId,
    });
    redeemedBookings.set(claims.ref, {
      jti: claims.jti,
      checkedInAtIso: nowIso,
      staffUserId: params.staffUserId,
    });

    if (params.adminClient && dbRow) {
      await params.adminClient.from('booking_audit_logs').insert({
        facility_id: dbRow.facility_id,
        reservation_id: dbRow.id,
        actor_type: 'staff',
        actor_id: params.staffUserId,
        event_type: 'qr_checkin_redeemed',
        payload: {
          booking_reference: claims.ref,
          jti: claims.jti,
          court_number: claims.court,
          redeemed_at: nowIso,
        },
      });
    }
  }

  const custObj = dbRow
    ? Array.isArray(dbRow.customers)
      ? dbRow.customers[0]
      : dbRow.customers
    : null;

  return {
    ok: true,
    statusCode: 200,
    data: {
      valid: true,
      consumed: consume,
      bookingReference: claims.ref,
      courtNumber: claims.court,
      customerName: custObj?.full_name ?? null,
      reservationStatus: dbRow?.status ?? 'confirmed',
      startAtIso: dbRow?.start_at ?? null,
      endAtIso: dbRow?.end_at ?? null,
      tokenJti: claims.jti,
      expiresAtIso: new Date(claims.exp * 1000).toISOString(),
      checkedInAtIso: consume ? nowIso : null,
      message: consume
        ? `Check-in confirmed and pass redeemed for Court ${claims.court} (${claims.ref}).`
        : `QR pass verified (valid until ${new Date(claims.exp * 1000).toISOString()}).`,
    },
  };
}

export async function revokeQrCheckInTokens(params: {
  bookingReference?: string;
  qrPayloadOrToken?: string;
  reason: string;
  permanent?: boolean;
  staffUserId?: string | null;
  adminClient?: SupabaseClient | null;
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
  const nowIso = new Date(nowMs).toISOString();

  let targetRef = params.bookingReference?.trim().toUpperCase() || null;
  let targetJti: string | null = null;

  if (params.qrPayloadOrToken) {
    const extracted = extractCheckInTokenFromQrInput(params.qrPayloadOrToken);
    if (extracted.checkInToken) {
      const verified = verifySignedCheckInClaims(extracted.checkInToken, nowMs);
      if (verified.ok) {
        targetJti = verified.data.jti;
        targetRef = targetRef ?? verified.data.ref;
      }
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

  if (targetJti) {
    revokedJtis.set(targetJti, {
      reason: params.reason === 'reservation_cancelled' ? 'reservation_cancelled' : 'staff_revoked',
      revokedAtIso: nowIso,
      actorId: params.staffUserId ?? null,
    });
  }

  if (targetRef) {
    revokedBookings.set(targetRef, {
      revokedAtEpochSec: nowSec,
      permanent: Boolean(params.permanent),
      reason: params.reason,
    });
  }

  if (params.adminClient && targetRef) {
    const { data: resRow } = await params.adminClient
      .from('reservations')
      .select('id, facility_id')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .eq('booking_reference', targetRef)
      .maybeSingle<{ id: string; facility_id: string }>();

    if (resRow) {
      await params.adminClient.from('booking_audit_logs').insert({
        facility_id: resRow.facility_id,
        reservation_id: resRow.id,
        actor_type: params.staffUserId ? 'staff' : 'system',
        actor_id: params.staffUserId ?? null,
        event_type: 'qr_checkin_token_revoked',
        payload: {
          booking_reference: targetRef,
          jti: targetJti,
          permanent: Boolean(params.permanent),
          revoked_at_epoch_sec: nowSec,
          reason: params.reason,
        },
      });
    }
  }

  return {
    ok: true,
    statusCode: 200,
    data: {
      revoked: true,
      bookingReference: targetRef,
      tokenJti: targetJti,
      revokedAtIso: nowIso,
    },
  };
}
