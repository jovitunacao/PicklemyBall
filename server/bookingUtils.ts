import crypto from 'node:crypto';
import type { ReservationStatusDb } from '../src/types/database.ts';

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Generates an opaque, high-entropy token for hold ownership or booking lookup.
 */
export function generateOpaqueToken(byteLength: number = 24): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function hashSecretToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

export function timingSafeTokenMatches(rawToken: string, expectedHash: string): boolean {
  const actualHash = hashSecretToken(rawToken);
  const a = Buffer.from(actualHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates a collision-resistant human-readable reference: PMB-YYYYMMDD-XXXX
 * (or 5 chars on collision retry).
 */
export async function generateUniqueBookingReference(
  manilaDateStr: string,
  existsCheck: (candidate: string) => Promise<boolean> | boolean,
): Promise<string> {
  const compactDate = manilaDateStr.replace(/-/g, '');
  for (let attempt = 1; attempt <= 25; attempt++) {
    const suffixLength = attempt > 6 ? 5 : 4;
    const bytes = crypto.randomBytes(suffixLength);
    let suffix = '';
    for (let i = 0; i < suffixLength; i++) {
      suffix += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
    }
    const candidate = `PMB-${compactDate}-${suffix}`;
    const alreadyExists = await existsCheck(candidate);
    if (!alreadyExists) {
      return candidate;
    }
  }
  throw new Error('BOOKING_REF_COLLISION: Failed to generate unique booking reference.');
}

const ALLOWED_TRANSITIONS: Record<ReservationStatusDb, ReservationStatusDb[]> = {
  pending_payment: ['confirmed', 'cancelled', 'expired', 'payment_review_required'],
  confirmed: ['completed', 'cancelled'],
  payment_review_required: ['confirmed', 'cancelled'],
  cancelled: [],
  expired: [],
  completed: [],
};

/**
 * Enforces the documented Stage 4/5 reservation state machine.
 * Crucially, transitioning into 'confirmed' is REJECTED unless verifiedPaymentEvidence is true
 * (disabled in Stage 4 until Stage 5 HitPay verification).
 */
export function assertValidReservationStatusTransition(
  currentStatus: ReservationStatusDb,
  nextStatus: ReservationStatusDb,
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

/**
 * Sliding-window rate limiter for public booking & lookup endpoints.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number = 60_000, maxRequests: number = 40) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  consume(key: string, nowMs: number = Date.now()): {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  } {
    const cutoff = nowMs - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0] ?? nowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000));
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    timestamps.push(nowMs);
    this.hits.set(key, timestamps);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      retryAfterSeconds: 0,
    };
  }
}
