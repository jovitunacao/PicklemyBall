import { getSupabaseBrowserClient } from '../lib/supabaseClient';
import type { PaymentIntentStatusDb, ReservationStatusDb } from '../types/database';

export interface AvailabilityCourtItem {
  courtNumber: number;
  status: 'available' | 'booked' | 'held' | 'maintenance';
  reason: string;
}

export interface AvailabilityResponse {
  source: 'supabase_live' | 'simulated_stage2_fallback';
  supabaseConfigured: boolean;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  courts: AvailabilityCourtItem[];
}

export interface CourtScheduleSlot {
  startTime: string;
  endTime: string;
  status: 'available' | 'booked' | 'held' | 'maintenance';
  isPast: boolean;
}

export interface ServerPricingLineItem {
  hourLabel: string;
  baseRateCentavos: number;
  discountPercent: number;
  finalRateCentavos: number;
  appliedRuleName: string;
}

export interface PricingQuoteResponse {
  source: 'supabase_live' | 'dev_default';
  currency: 'PHP';
  courtNumber: number;
  dateStr: string;
  startTime: string;
  durationMinutes: number;
  effectiveHourlyRateCentavos: number;
  subtotalCentavos: number;
  discountCentavos: number;
  totalAmountCentavos: number;
  depositRequiredCentavos: number;
  depositPercent: number;
  lineItems: ServerPricingLineItem[];
  isDevelopmentDefaultRates: boolean;
}

export interface CreateGuestHoldPayload {
  courtNumber: number;
  date: string;
  startTime: string;
  durationMinutes: number;
  customerName: string;
  customerMobile: string;
  customerEmail: string;
  specialRequests?: string;
}

export interface CreateGuestHoldResponse {
  holdId: string;
  reservationId: string;
  bookingReference: string;
  status: 'pending_payment';
  expiresAt: string;
  ownershipToken: string;
  lookupToken: string;
  pricing: PricingQuoteResponse;
  date: string;
  startTime: string;
  endTime: string;
  courtNumber: number;
}

export interface BookingLookupResponse {
  booking_reference: string;
  court_number: number;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  total_amount_centavos: number;
  reservation_status: ReservationStatusDb;
  payment_status: PaymentIntentStatusDb;
  hold_expires_at: string | null;
  customer_name: string;
  qrCheckInEligible: boolean;
  qrCheckInNote: string;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string = 'API_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      payload?.error || `Request failed (${res.status})`,
      res.status,
      payload?.code || 'API_ERROR',
    );
  }
  return payload as T;
}

export async function fetchIntervalAvailability(
  params: { date: string; startTime: string; durationMinutes: number },
  signal?: AbortSignal,
): Promise<AvailabilityResponse> {
  const qs = new URLSearchParams({
    date: params.date,
    startTime: params.startTime,
    durationMinutes: String(params.durationMinutes),
  });
  const res = await fetch(`/api/availability?${qs.toString()}`, { signal });
  return parseJsonResponse<AvailabilityResponse>(res);
}

export async function fetchCourtSchedule(
  params: { courtNumber: number; date: string },
  signal?: AbortSignal,
): Promise<{
  source: 'supabase_live' | 'simulated_stage2_fallback';
  slots: CourtScheduleSlot[];
}> {
  const qs = new URLSearchParams({ date: params.date });
  const res = await fetch(`/api/courts/${params.courtNumber}/schedule?${qs.toString()}`, {
    signal,
  });
  return parseJsonResponse(res);
}

export async function fetchServerPricingQuote(
  params: { courtNumber: number; date: string; startTime: string; durationMinutes: number },
  signal?: AbortSignal,
): Promise<PricingQuoteResponse> {
  const res = await fetch('/api/pricing/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
  return parseJsonResponse<PricingQuoteResponse>(res);
}

export async function submitGuestBookingHold(
  payload: CreateGuestHoldPayload,
): Promise<CreateGuestHoldResponse> {
  const res = await fetch('/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<CreateGuestHoldResponse>(res);
}

export async function lookupBookingWithToken(params: {
  bookingReference: string;
  lookupToken: string;
}): Promise<BookingLookupResponse> {
  const res = await fetch('/api/bookings/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<BookingLookupResponse>(res);
}

export async function cancelBookingWithToken(params: {
  bookingReference: string;
  token: string;
  reason?: string;
}): Promise<{ cancelled: boolean }> {
  const res = await fetch(
    `/api/bookings/${encodeURIComponent(params.bookingReference)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: params.token, reason: params.reason }),
    },
  );
  return parseJsonResponse<{ cancelled: boolean }>(res);
}

export function formatCentavosPhp(centavos: number): string {
  return `₱${(centavos / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Subscribes to Supabase Realtime changes on reservations, holds, and maintenance
 * when browser Supabase credentials are present. Returns an unsubscribe cleanup fn.
 */
export function subscribeToAvailabilityRealtime(onChange: () => void): () => void {
  const client = getSupabaseBrowserClient();
  if (!client) {
    return () => {};
  }

  const channel = client
    .channel('pmb-availability-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservation_holds' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'court_maintenance' }, onChange)
    .subscribe();

  return () => {
    client.removeChannel(channel);
  };
}
