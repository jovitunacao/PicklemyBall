const TEXT_ENCODER = new TextEncoder();

export type ReservationStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'completed'
  | 'payment_review_required';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Generates an opaque, cryptographically random token using Web Crypto (Deno + Node portable).
 */
export function generateOpaqueToken(byteLength: number = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * SHA-256 hex digest matching PostgreSQL's encode(digest(..., 'sha256'), 'hex').
 */
export async function hashSecretToken(rawToken: string): Promise<string> {
  const data = TEXT_ENCODER.encode(rawToken.trim());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Constant-time equality check over hex strings to prevent timing side-channels.
 */
export function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aHex.length; i++) {
    diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  }
  return diff === 0;
}

export async function timingSafeTokenMatches(
  rawToken: string,
  expectedHash: string,
): Promise<boolean> {
  const actualHash = await hashSecretToken(rawToken);
  return constantTimeEqualHex(actualHash, expectedHash.toLowerCase());
}

const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  pending_payment: ['confirmed', 'cancelled', 'expired', 'payment_review_required'],
  confirmed: ['completed', 'cancelled'],
  payment_review_required: ['confirmed', 'cancelled'],
  cancelled: [],
  expired: [],
  completed: [],
};

/**
 * Enforces Stage 4/5 reservation state machine transitions.
 * Never permits moving into 'confirmed' without verified payment evidence (Stage 5).
 */
export function assertValidReservationStatusTransition(
  currentStatus: ReservationStatus,
  nextStatus: ReservationStatus,
  options: { hasVerifiedPaymentEvidence: boolean } = { hasVerifiedPaymentEvidence: false },
): void {
  if (currentStatus === nextStatus) return;

  const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(
      `INVALID_STATUS_TRANSITION: Cannot move reservation from '${currentStatus}' to '${nextStatus}'.`,
    );
  }

  if (nextStatus === 'confirmed' && !options.hasVerifiedPaymentEvidence) {
    throw new Error(
      'PAYMENT_VERIFICATION_REQUIRED: Reservation cannot become confirmed without verified payment evidence (Stage 5).',
    );
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function errorResponse(
  status: number,
  code: string,
  error: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(status, { code, error }, extraHeaders);
}
