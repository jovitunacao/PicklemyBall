export interface HitPayIntegrationPlanSummary {
  paymentGatewayEnabled: false;
  provider: 'hitpay';
  currency: 'PHP';
  plannedMethods: readonly string[];
  requiredFutureSecrets: readonly string[];
  plannedEdgeEndpoints: readonly {
    functionName: string;
    method: string;
    purpose: string;
    requiresApproval: boolean;
  }[];
  securityInvariants: readonly string[];
}

export const STAGE5_HITPAY_PLAN: HitPayIntegrationPlanSummary = {
  paymentGatewayEnabled: false,
  provider: 'hitpay',
  currency: 'PHP',
  plannedMethods: ['gcash', 'maya', 'qrph', 'card', 'grabpay'],
  requiredFutureSecrets: ['HITPAY_API_KEY', 'HITPAY_SALT', 'HITPAY_ENV'],
  plannedEdgeEndpoints: [
    {
      functionName: 'payment-create-checkout',
      method: 'POST',
      purpose:
        'Reads authoritative reservation total in centavos from PostgreSQL, calls HitPay /v1/payment-requests with reference_number = booking_reference, and returns hosted checkout_url.',
      requiresApproval: true,
    },
    {
      functionName: 'payment-webhook-hitpay',
      method: 'POST',
      purpose:
        'Verifies HitPay HMAC-SHA256 signature against sorted payload values, validates PHP amount parity, enforces idempotency on provider_reference, and executes atomic DB confirmation under pmb.allow_verified_confirmation = true.',
      requiresApproval: true,
    },
  ],
  securityInvariants: [
    'Client never sends or overrides payment amounts or triggers confirmation directly.',
    'Database trigger enforce_reservation_integrity() rejects status = confirmed unless a verified paid payment_intents row exists and transaction sets pmb.allow_verified_confirmation = true.',
    'Late webhook arrivals after 10-minute hold expiry transition cleanly to payment_review_required rather than double-booking the court.',
  ],
};

/**
 * Converts integer Philippine centavos to HitPay's 2-decimal PHP string without floating-point drift.
 */
export function formatCentavosToHitPayAmount(centavos: number): string {
  if (!Number.isInteger(centavos) || centavos < 0) {
    throw new Error('INVALID_CENTAVOS: Amount must be a non-negative integer.');
  }
  const whole = Math.floor(centavos / 100);
  const rem = String(centavos % 100).padStart(2, '0');
  return `${whole}.${rem}`;
}

/**
 * Builds HitPay webhook HMAC concatenation string by sorting keys alphabetically
 * (excluding `hmac`) and concatenating `key + value` pairs per HitPay webhook spec.
 */
export function buildHitPayHmacSourceString(payload: Record<string, string | number | boolean>): string {
  return Object.keys(payload)
    .filter((key) => key !== 'hmac')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}${String(payload[key])}`)
    .join('');
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Pure Web-Crypto HMAC-SHA256 verifier for planned HitPay webhooks (Stage 5).
 */
export async function verifyHitPayWebhookHmac(
  payload: Record<string, string | number | boolean>,
  providedHmac: string,
  salt: string,
): Promise<boolean> {
  if (!providedHmac.trim() || !salt.trim()) {
    return false;
  }
  const source = buildHitPayHmacSourceString(payload);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(source));
  const computedHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return constantTimeHexEquals(computedHex.toLowerCase(), providedHmac.trim().toLowerCase());
}
