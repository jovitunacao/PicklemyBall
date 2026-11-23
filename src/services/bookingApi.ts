import {
  type BrowserEnvLike,
  diagnoseBrowserSupabaseConfig,
  getSupabaseBrowserClient,
} from '../lib/supabaseClient';
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

export type AvailabilityDiagnosticKind =
  | 'missing_credentials'
  | 'invalid_credentials'
  | 'undeployed_functions'
  | 'database_schema_error'
  | 'network_error';

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

export class AvailabilityDiagnosticError extends ApiError {
  readonly kind: AvailabilityDiagnosticKind;

  constructor(
    kind: AvailabilityDiagnosticKind,
    message: string,
    status: number = 0,
    code: string = 'AVAILABILITY_DIAGNOSTIC',
  ) {
    super(message, status, code);
    this.name = 'AvailabilityDiagnosticError';
    this.kind = kind;
  }
}

export function resolveEdgeFunctionsBaseUrl(env?: BrowserEnvLike): string | null {
  const diag = diagnoseBrowserSupabaseConfig(env);
  if (!diag.configured) {
    return null;
  }
  const source = env ?? import.meta.env;
  const explicit = source.VITE_EDGE_FUNCTIONS_URL?.trim().replace(/\/+$/, '');
  if (explicit) {
    return explicit;
  }
  const supabaseUrl = source.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '');
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1`;
  }
  return null;
}

function assertValidEdgeTargetOrThrow(env?: BrowserEnvLike): string | null {
  const diag = diagnoseBrowserSupabaseConfig(env);
  if (diag.state === 'missing') {
    return null;
  }
  if (!diag.configured) {
    throw new AvailabilityDiagnosticError(
      'invalid_credentials',
      diag.message,
      400,
      diag.state === 'invalid_url' ? 'INVALID_CREDENTIALS' : 'INCOMPLETE_CREDENTIALS',
    );
  }
  return resolveEdgeFunctionsBaseUrl(env);
}

function buildPublicHeaders(includeJsonContentType: boolean = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (anonKey) {
    headers['apikey'] = anonKey;
    // Legacy anon JWTs carry 3 dot-separated segments starting with eyJ.
    // Newer sb_publishable_ keys use apikey cleanly without failing Edge JWT parsing.
    if (anonKey.startsWith('eyJ')) {
      headers['Authorization'] = `Bearer ${anonKey}`;
    }
  }
  return headers;
}

function buildStaffHeaders(
  staffAccessToken: string,
  includeJsonContentType: boolean = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${staffAccessToken}`,
  };
  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (anonKey) {
    headers['apikey'] = anonKey;
  }
  return headers;
}

function classifyFailureFromHttp(
  status: number,
  code: string,
  errorMessage: string,
  isEdgeCall: boolean,
): AvailabilityDiagnosticError {
  if (
    code === 'DATABASE_SCHEMA_ERROR' ||
    /migrations 0001|tables or functions are missing|schema cache|does not exist/i.test(errorMessage)
  ) {
    return new AvailabilityDiagnosticError(
      'database_schema_error',
      errorMessage || 'Database schema migrations (0001–0004) have not been applied yet.',
      status,
      code || 'DATABASE_SCHEMA_ERROR',
    );
  }

  if (code === 'DATABASE_AVAILABILITY_ERROR') {
    return new AvailabilityDiagnosticError(
      'database_schema_error',
      errorMessage || 'Database availability query failed.',
      status,
      code,
    );
  }

  if (code === 'CORS_ORIGIN_FORBIDDEN') {
    return new AvailabilityDiagnosticError(
      'network_error',
      'CORS blocked the browser request. Add this app origin to the ALLOWED_ORIGINS secret on your Supabase Edge Functions.',
      status,
      code,
    );
  }

  if (
    isEdgeCall &&
    (status === 404 ||
      code === 'NOT_FOUND' ||
      /requested function was not found|function not found/i.test(errorMessage))
  ) {
    return new AvailabilityDiagnosticError(
      'undeployed_functions',
      'Supabase Edge Functions are not deployed on your project yet (HTTP 404). Deploy supabase/functions/* before enabling live booking.',
      status,
      code || 'EDGE_FUNCTION_NOT_DEPLOYED',
    );
  }

  if (
    status === 401 ||
    status === 403 ||
    code === 'INVALID_CREDENTIALS' ||
    code === 'INCOMPLETE_CREDENTIALS' ||
    code === 'SUPABASE_NOT_CONFIGURED' ||
    /invalid api key|invalid jwt|apikey/i.test(errorMessage)
  ) {
    return new AvailabilityDiagnosticError(
      'invalid_credentials',
      errorMessage || 'Supabase credentials were rejected or are incomplete.',
      status,
      code || 'INVALID_CREDENTIALS',
    );
  }

  return new AvailabilityDiagnosticError(
    'network_error',
    errorMessage || `Live availability request failed (${status}).`,
    status,
    code || 'API_ERROR',
  );
}

async function parseJsonResponse<T>(res: Response, isEdgeCall: boolean = false): Promise<T> {
  const contentType = res.headers.get('content-type') ?? '';
  const rawText = await res.text().catch(() => '');

  let payload: Record<string, unknown> = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      if (isEdgeCall) {
        throw new AvailabilityDiagnosticError(
          'invalid_credentials',
          'Configured Supabase endpoint returned HTML/non-JSON instead of an Edge Function JSON response. Verify VITE_SUPABASE_URL points to https://<project-ref>.supabase.co.',
          res.status,
          'NON_JSON_EDGE_RESPONSE',
        );
      }
      throw new AvailabilityDiagnosticError(
        'network_error',
        `Unexpected non-JSON response (${res.status}) from backend.`,
        res.status,
        'NON_JSON_RESPONSE',
      );
    }
  }

  if (!res.ok) {
    const code = typeof payload?.code === 'string' ? payload.code : 'API_ERROR';
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.message === 'string'
          ? payload.message
          : `Request failed (${res.status})`;

    // Pass validation errors (400) and conflict errors (409) directly as ApiError
    if (res.status === 400 || res.status === 409) {
      throw new ApiError(message, res.status, code);
    }

    throw classifyFailureFromHttp(res.status, code, message, isEdgeCall);
  }

  return payload as T;
}

async function executeFetch(
  input: string,
  init: RequestInit,
  isEdgeCall: boolean,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new AvailabilityDiagnosticError(
      'network_error',
      isEdgeCall
        ? 'Network or CORS failure connecting to Supabase Edge Functions. Check connectivity, VITE_SUPABASE_URL, Edge deployment, and ALLOWED_ORIGINS.'
        : 'Network error communicating with the local backend server.',
      0,
      'NETWORK_FAILURE',
    );
  }
}

export async function fetchIntervalAvailability(
  params: { date: string; startTime: string; durationMinutes: number },
  signal?: AbortSignal,
): Promise<AvailabilityResponse> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const qs = new URLSearchParams({
    date: params.date,
    startTime: params.startTime,
    durationMinutes: String(params.durationMinutes),
  });

  if (edgeBase) {
    const res = await executeFetch(
      `${edgeBase}/availability?${qs.toString()}`,
      { headers: buildPublicHeaders(false), signal },
      true,
    );
    const data = await parseJsonResponse<AvailabilityResponse>(res, true);
    if (!Array.isArray(data?.courts)) {
      throw new AvailabilityDiagnosticError(
        'undeployed_functions',
        'Edge Function response did not include court availability data.',
        res.status,
        'INVALID_AVAILABILITY_PAYLOAD',
      );
    }
    return data;
  }

  const res = await executeFetch(`/api/availability?${qs.toString()}`, { signal }, false);
  const data = await parseJsonResponse<AvailabilityResponse>(res, false);
  if (!Array.isArray(data?.courts)) {
    throw new AvailabilityDiagnosticError(
      'network_error',
      'Local availability endpoint returned an invalid response payload.',
      res.status,
      'INVALID_AVAILABILITY_PAYLOAD',
    );
  }
  return data;
}

export async function fetchCourtSchedule(
  params: { courtNumber: number; date: string },
  signal?: AbortSignal,
): Promise<{
  source: 'supabase_live' | 'simulated_stage2_fallback';
  slots: CourtScheduleSlot[];
}> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  if (edgeBase) {
    const qs = new URLSearchParams({
      mode: 'court_schedule',
      courtNumber: String(params.courtNumber),
      date: params.date,
    });
    const res = await executeFetch(
      `${edgeBase}/availability?${qs.toString()}`,
      { headers: buildPublicHeaders(false), signal },
      true,
    );
    return parseJsonResponse(res, true);
  }

  const qs = new URLSearchParams({ date: params.date });
  const res = await executeFetch(
    `/api/courts/${params.courtNumber}/schedule?${qs.toString()}`,
    { signal },
    false,
  );
  return parseJsonResponse(res, false);
}

export async function fetchServerPricingQuote(
  params: { courtNumber: number; date: string; startTime: string; durationMinutes: number },
  signal?: AbortSignal,
): Promise<PricingQuoteResponse> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const endpoint = edgeBase ? `${edgeBase}/pricing-quote` : '/api/pricing/quote';
  const res = await executeFetch(
    endpoint,
    {
      method: 'POST',
      headers: buildPublicHeaders(true),
      body: JSON.stringify(params),
      signal,
    },
    Boolean(edgeBase),
  );
  return parseJsonResponse<PricingQuoteResponse>(res, Boolean(edgeBase));
}

export async function submitGuestBookingHold(
  payload: CreateGuestHoldPayload,
): Promise<CreateGuestHoldResponse> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const endpoint = edgeBase ? `${edgeBase}/guest-holds` : '/api/holds';
  const res = await executeFetch(
    endpoint,
    {
      method: 'POST',
      headers: buildPublicHeaders(true),
      body: JSON.stringify(payload),
    },
    Boolean(edgeBase),
  );
  return parseJsonResponse<CreateGuestHoldResponse>(res, Boolean(edgeBase));
}

export async function lookupBookingWithToken(params: {
  bookingReference: string;
  lookupToken: string;
}): Promise<BookingLookupResponse> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const endpoint = edgeBase ? `${edgeBase}/booking-lookup` : '/api/bookings/lookup';
  const res = await executeFetch(
    endpoint,
    {
      method: 'POST',
      headers: buildPublicHeaders(true),
      body: JSON.stringify(params),
    },
    Boolean(edgeBase),
  );
  return parseJsonResponse<BookingLookupResponse>(res, Boolean(edgeBase));
}

export async function cancelBookingWithToken(params: {
  bookingReference: string;
  token: string;
  reason?: string;
}): Promise<{ cancelled: boolean }> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  if (edgeBase) {
    const res = await executeFetch(
      `${edgeBase}/booking-cancel`,
      {
        method: 'POST',
        headers: buildPublicHeaders(true),
        body: JSON.stringify(params),
      },
      true,
    );
    return parseJsonResponse<{ cancelled: boolean }>(res, true);
  }

  const res = await executeFetch(
    `/api/bookings/${encodeURIComponent(params.bookingReference)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: params.token, reason: params.reason }),
    },
    false,
  );
  return parseJsonResponse<{ cancelled: boolean }>(res, false);
}

// ---------------------------------------------------------------------------
// Authenticated Staff / Admin Edge Function Clients (Stage 6 Ready)
// ---------------------------------------------------------------------------
export async function adminFetchReservations(
  staffAccessToken: string,
  filters?: { date?: string; status?: string },
): Promise<{ reservations: unknown[] }> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const qs = new URLSearchParams();
  if (filters?.date) qs.set('date', filters.date);
  if (filters?.status) qs.set('status', filters.status);
  const query = qs.toString() ? `?${qs.toString()}` : '';
  const url = edgeBase
    ? `${edgeBase}/admin-reservations${query}`
    : `/api/admin/reservations${query}`;
  const res = await executeFetch(
    url,
    { headers: buildStaffHeaders(staffAccessToken, false) },
    Boolean(edgeBase),
  );
  return parseJsonResponse(res, Boolean(edgeBase));
}

export async function adminCancelReservationRequest(
  staffAccessToken: string,
  params: { bookingReference: string; reason: string },
): Promise<{ cancelled: boolean }> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const url = edgeBase
    ? `${edgeBase}/admin-reservations`
    : `/api/admin/reservations/${encodeURIComponent(params.bookingReference)}/cancel`;
  const res = await executeFetch(
    url,
    {
      method: 'POST',
      headers: buildStaffHeaders(staffAccessToken, true),
      body: JSON.stringify(
        edgeBase
          ? { action: 'cancel', bookingReference: params.bookingReference, reason: params.reason }
          : { reason: params.reason },
      ),
    },
    Boolean(edgeBase),
  );
  return parseJsonResponse(res, Boolean(edgeBase));
}

export async function adminFetchPricingConfig(
  staffAccessToken: string,
): Promise<{ currency: 'PHP'; courts: unknown[]; pricingRules: unknown[] }> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const url = edgeBase ? `${edgeBase}/admin-pricing` : '/api/admin/pricing';
  const res = await executeFetch(
    url,
    { headers: buildStaffHeaders(staffAccessToken, false) },
    Boolean(edgeBase),
  );
  return parseJsonResponse(res, Boolean(edgeBase));
}

export async function adminFetchOperatingHours(
  staffAccessToken: string,
): Promise<{ timezone: 'Asia/Manila'; operatingHours: unknown[]; facilitySettings: unknown }> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const url = edgeBase
    ? `${edgeBase}/admin-operating-hours`
    : '/api/admin/operating-hours';
  const res = await executeFetch(
    url,
    { headers: buildStaffHeaders(staffAccessToken, false) },
    Boolean(edgeBase),
  );
  return parseJsonResponse(res, Boolean(edgeBase));
}

export async function adminFetchAuditLogs(
  staffAccessToken: string,
  filters?: { reservationId?: string; eventType?: string; limit?: number },
): Promise<{ auditLogs: unknown[] }> {
  const edgeBase = assertValidEdgeTargetOrThrow();
  const qs = new URLSearchParams();
  if (filters?.reservationId) qs.set('reservationId', filters.reservationId);
  if (filters?.eventType) qs.set('eventType', filters.eventType);
  if (filters?.limit) qs.set('limit', String(filters.limit));
  const query = qs.toString() ? `?${qs.toString()}` : '';
  const url = edgeBase
    ? `${edgeBase}/admin-audit-logs${query}`
    : `/api/admin/audit-logs${query}`;
  const res = await executeFetch(
    url,
    { headers: buildStaffHeaders(staffAccessToken, false) },
    Boolean(edgeBase),
  );
  return parseJsonResponse(res, Boolean(edgeBase));
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
