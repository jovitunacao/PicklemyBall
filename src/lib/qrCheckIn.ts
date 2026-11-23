import QRCode from 'qrcode';
import type { PaymentIntentStatusDb, ReservationStatusDb } from '../types/database';

export const QR_CHECKIN_TOKEN_PREFIX = 'chk_v1.';

export interface QrCheckInPassInput {
  checkInToken: string;
}

export interface ParsedQrCheckIn {
  checkInToken: string | null;
  rejectedLegacyFormat: boolean;
}

export function isQrCheckInEligible(
  reservationStatus: ReservationStatusDb,
  paymentStatus: PaymentIntentStatusDb,
): boolean {
  return reservationStatus === 'confirmed' && paymentStatus === 'paid';
}

export function isDedicatedCheckInToken(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith(QR_CHECKIN_TOKEN_PREFIX) &&
    /^chk_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)
  );
}

/**
 * Generates an opaque, PII-free QR check-in URI using ONLY a dedicated
 * server-generated check-in token (chk_v1.*). Never embeds a booking lookup token.
 */
export function buildQrCheckInPayload(input: QrCheckInPassInput): string {
  const token = input.checkInToken.trim();
  if (!isDedicatedCheckInToken(token)) {
    throw new Error(
      'INVALID_CHECKIN_TOKEN: QR payload requires a dedicated server-issued chk_v1 check-in token.',
    );
  }
  const qs = new URLSearchParams({ t: token });
  return `pmb://astoria-regency/checkin?${qs.toString()}`;
}

/**
 * Parses either a scanned `pmb://astoria-regency/checkin?t=chk_v1...` QR URI
 * or a raw `chk_v1.*` server-issued check-in token. Rejects legacy `?token=` formats.
 */
export function parseQrCheckInInput(raw: string): ParsedQrCheckIn {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { checkInToken: null, rejectedLegacyFormat: false };
  }

  try {
    if (trimmed.startsWith('pmb://') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsed = new URL(trimmed);
      const tParam = parsed.searchParams.get('t')?.trim() ?? null;
      const legacyTokenParam = parsed.searchParams.get('token')?.trim() ?? null;

      if (legacyTokenParam && !tParam) {
        return { checkInToken: null, rejectedLegacyFormat: true };
      }

      if (tParam && isDedicatedCheckInToken(tParam)) {
        return { checkInToken: tParam, rejectedLegacyFormat: false };
      }
      return { checkInToken: null, rejectedLegacyFormat: false };
    }
  } catch {
    // Fall through to raw check-in token validation
  }

  if (isDedicatedCheckInToken(trimmed)) {
    return { checkInToken: trimmed, rejectedLegacyFormat: false };
  }

  return { checkInToken: null, rejectedLegacyFormat: false };
}

export async function generateQrPassSvg(payload: string): Promise<string> {
  const parsed = parseQrCheckInInput(payload);
  if (!parsed.checkInToken) {
    throw new Error(
      'INVALID_QR_CHECKIN_PAYLOAD: Refusing to render QR SVG without a dedicated server-issued check-in token.',
    );
  }
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
