import QRCode from 'qrcode';
import type { PaymentIntentStatusDb, ReservationStatusDb } from '../types/database';

export interface QrCheckInPassInput {
  bookingReference: string;
  lookupToken: string;
  courtNumber: number;
}

export interface ParsedQrCheckIn {
  bookingReference: string | null;
  lookupToken: string | null;
  courtNumber: number | null;
}

const BOOKING_REF_REGEX = /PMB-[0-9]{8}-[A-Z0-9]{4,8}/i;

export function isQrCheckInEligible(
  reservationStatus: ReservationStatusDb,
  paymentStatus: PaymentIntentStatusDb,
): boolean {
  return reservationStatus === 'confirmed' && paymentStatus === 'paid';
}

/**
 * Generates an opaque, PII-free check-in URI for confirmed reservations.
 * Never embeds customer phone, email, or payment card information.
 */
export function buildQrCheckInPayload(input: QrCheckInPassInput): string {
  const ref = input.bookingReference.trim().toUpperCase();
  const token = input.lookupToken.trim();
  const qs = new URLSearchParams({
    ref,
    token,
    court: String(input.courtNumber),
  });
  return `pmb://astoria-regency/checkin?${qs.toString()}`;
}

/**
 * Parses either a scanned `pmb://astoria-regency/checkin?...` QR payload,
 * a web lookup URL, or a direct typed `PMB-YYYYMMDD-XXXX` booking reference.
 */
export function parseQrCheckInInput(raw: string): ParsedQrCheckIn {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { bookingReference: null, lookupToken: null, courtNumber: null };
  }

  try {
    if (trimmed.startsWith('pmb://') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsed = new URL(trimmed);
      const refParam = parsed.searchParams.get('ref')?.trim().toUpperCase() ?? null;
      const tokenParam = parsed.searchParams.get('token')?.trim() ?? null;
      const courtRaw = parsed.searchParams.get('court');
      const courtNum = courtRaw && /^\d+$/.test(courtRaw) ? Number(courtRaw) : null;
      const validRef = refParam && BOOKING_REF_REGEX.test(refParam) ? refParam : null;
      return {
        bookingReference: validRef,
        lookupToken: tokenParam || null,
        courtNumber: courtNum,
      };
    }
  } catch {
    // Fall through to plain reference extraction
  }

  const refMatch = trimmed.match(BOOKING_REF_REGEX);
  return {
    bookingReference: refMatch ? refMatch[0].toUpperCase() : null,
    lookupToken: null,
    courtNumber: null,
  };
}

export async function generateQrPassSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 220,
    color: {
      dark: '#061326',
      light: '#ffffff',
    },
  });
}
