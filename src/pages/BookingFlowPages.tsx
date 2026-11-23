import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Loader2,
  Mail,
  QrCode,
  RefreshCw,
  Search,
} from 'lucide-react';
import { BookingQrPass } from '../components/BookingQrPass';
import { COURT_MAP_REGIONS } from '../config/courtMapRegions';
import { formatEndTime, SIMULATED_TIME_SLOTS } from '../data/mockStage2Availability';
import { COURT_ZONE_SUMMARY, FACILITY_INFO, SITE_ROUTES } from '../config/facility';
import { STAGE5_HITPAY_PLAN } from '../lib/hitpayPlan';
import {
  addDaysToManilaDate,
  getInitialManilaSchedule,
  getManilaTodayDateString,
  isPastManilaDate,
  isPastManilaSlot,
  utcIsoToManilaDateAndTime,
} from '../lib/manilaTime';
import {
  AvailabilityCourtItem,
  AvailabilityDiagnosticError,
  BookingLookupResponse,
  cancelBookingWithToken,
  ConfirmationEmailResult,
  CreateGuestHoldResponse,
  fetchIntervalAvailability,
  formatCentavosPhp,
  lookupBookingWithToken,
  requestBookingConfirmationEmail,
  subscribeToAvailabilityRealtime,
} from '../services/bookingApi';

const MAX_ADVANCE_DAYS = 30;

function statusBadgeStyle(status: AvailabilityCourtItem['status']): {
  label: string;
  classes: string;
} {
  switch (status) {
    case 'available':
      return {
        label: 'Available',
        classes: 'border-blue-200 bg-blue-50 text-blue-800',
      };
    case 'held':
      return {
        label: 'Hold Active',
        classes: 'border-amber-300 bg-amber-50 text-amber-900',
      };
    case 'booked':
      return {
        label: 'Booked',
        classes: 'border-red-200 bg-red-50 text-red-800',
      };
    case 'maintenance':
      return {
        label: 'Maintenance',
        classes: 'border-slate-300 bg-slate-100 text-slate-700',
      };
  }
}

export const AvailabilityPage: React.FC = () => {
  const initialSchedule = useMemo(() => getInitialManilaSchedule(), []);
  const todayManila = useMemo(() => getManilaTodayDateString(), []);
  const maxDateManila = useMemo(
    () => addDaysToManilaDate(todayManila, MAX_ADVANCE_DAYS),
    [todayManila],
  );

  const [selectedDate, setSelectedDate] = useState(initialSchedule.date);
  const [startTime, setStartTime] = useState(initialSchedule.startTime);
  const [durationHours, setDurationHours] = useState(1);
  const [courts, setCourts] = useState<AvailabilityCourtItem[]>([]);
  const [source, setSource] = useState<'supabase_live' | 'simulated_stage2_fallback' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const triggerRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchIntervalAvailability(
      {
        date: selectedDate,
        startTime,
        durationMinutes: durationHours * 60,
      },
      controller.signal,
    )
      .then((res) => {
        setSource(res.source);
        setCourts(res.courts);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setCourts([]);
        setSource(null);
        if (err instanceof AvailabilityDiagnosticError) {
          setError(err.message);
        } else {
          setError(err instanceof Error ? err.message : 'Unable to check availability.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [selectedDate, startTime, durationHours, refreshTick]);

  useEffect(() => {
    const unsubscribe = subscribeToAvailabilityRealtime(triggerRefresh);
    return () => unsubscribe();
  }, [triggerRefresh]);

  const statusMap = useMemo(() => {
    const m = new Map<number, AvailabilityCourtItem>();
    for (const c of courts) m.set(c.courtNumber, c);
    return m;
  }, [courts]);

  const counts = useMemo(() => {
    const res = { available: 0, held: 0, booked: 0, maintenance: 0 };
    for (const c of courts) res[c.status] += 1;
    return res;
  }, [courts]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-14 space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 pb-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
            14 Courts · {FACILITY_INFO.timezone}
          </p>
          <h1 className="font-display text-4xl font-bold text-navy-950 tracking-tight">
            Live Court Availability
          </h1>
          <p className="text-sm text-slate-600 max-w-2xl">
            Check real-time availability across Courts 1–14 before selecting your court on the
            Astoria Regency architectural floor plan.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 tabular-nums pt-1">
            <span className="font-semibold text-blue-700">{counts.available} Available</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-red-700">{counts.booked} Booked</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-amber-700">{counts.held} Held</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-slate-600">{counts.maintenance} Closed</span>
            {source === 'supabase_live' && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-semibold text-green-700">Live Supabase Feed</span>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 shrink-0">
          <div>
            <label htmlFor="avail-date" className="block text-xs font-medium text-slate-600 mb-1">
              Date ({FACILITY_INFO.timezone})
            </label>
            <input
              id="avail-date"
              type="date"
              min={todayManila}
              max={maxDateManila}
              value={selectedDate}
              onChange={(e) => {
                const next = e.target.value;
                if (!next || isPastManilaDate(next) || next > maxDateManila) return;
                setSelectedDate(next);
              }}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="avail-time" className="block text-xs font-medium text-slate-600 mb-1">
              Start Time
            </label>
            <select
              id="avail-time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums"
            >
              {SIMULATED_TIME_SLOTS.map((slot) => (
                <option key={slot} value={slot} disabled={isPastManilaSlot(selectedDate, slot)}>
                  {slot} PHT
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="avail-dur" className="block text-xs font-medium text-slate-600 mb-1">
              Duration ({startTime}–{formatEndTime(startTime, durationHours)})
            </label>
            <select
              id="avail-dur"
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-xs tabular-nums"
            >
              <option value={1}>1 Hour</option>
              <option value={2}>2 Hours</option>
              <option value={3}>3 Hours</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={triggerRefresh}
              disabled={loading}
              className="min-h-[44px] px-3.5 rounded-lg border border-slate-300 bg-white text-navy-950 text-xs font-semibold hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <Link
              to={SITE_ROUTES.book}
              className="min-h-[44px] px-4 rounded-lg bg-lime-400 text-navy-950 text-xs font-bold hover:bg-lime-300 inline-flex items-center justify-center whitespace-nowrap"
            >
              Book Floor Plan
            </Link>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-xs text-red-950 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading && courts.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-600 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading live 14-court availability...</span>
        </div>
      ) : (
        <div className="space-y-8">
          {COURT_ZONE_SUMMARY.map((zone) => {
            const zoneCourts = COURT_MAP_REGIONS.filter((g) => g.zone === zone.zone);
            return (
              <div key={zone.zone} className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-2xl font-bold text-navy-950">{zone.label}</h2>
                  <span className="font-mono text-xs text-slate-500">{zone.range}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {zoneCourts.map((geom) => {
                    const statusItem = statusMap.get(geom.courtNumber);
                    const style = statusItem ? statusBadgeStyle(statusItem.status) : null;
                    return (
                      <div
                        key={geom.courtNumber}
                        className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-display text-xl font-bold text-navy-950">
                            Court {geom.courtNumber}
                          </span>
                          {style ? (
                            <span
                              className={`px-2 py-0.5 rounded border text-[11px] font-semibold whitespace-nowrap ${style.classes}`}
                            >
                              {style.label}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                              Unverified
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-600 leading-relaxed min-h-[32px]">
                          {statusItem?.reason ?? 'Availability check unavailable.'}
                        </p>
                        {statusItem?.status === 'available' ? (
                          <Link
                            to={SITE_ROUTES.book}
                            className="inline-flex items-center justify-center min-h-[38px] px-3 rounded-lg bg-navy-950 text-white text-xs font-semibold hover:bg-navy-800 whitespace-nowrap"
                          >
                            Select on Floor Plan
                          </Link>
                        ) : (
                          <Link
                            to={SITE_ROUTES.book}
                            className="inline-flex items-center justify-center min-h-[38px] px-3 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium hover:bg-slate-50 whitespace-nowrap"
                          >
                            Inspect on Floor Plan
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const LookupPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [reference, setReference] = useState(() => searchParams.get('ref')?.toUpperCase() ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingLookupResponse | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  // Email delivery state
  const [emailInput, setEmailInput] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailResult, setEmailResult] = useState<ConfirmationEmailResult | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCancelNotice(null);
    setEmailResult(null);
    setEmailError(null);
    setBooking(null);
    setLoading(true);

    try {
      const result = await lookupBookingWithToken({
        bookingReference: reference.trim().toUpperCase(),
        lookupToken: accessToken.trim(),
      });
      setBooking(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to retrieve reservation.');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!booking) return;
    setError(null);
    try {
      await cancelBookingWithToken({
        bookingReference: booking.booking_reference,
        token: accessToken.trim(),
      });
      setBooking({
        ...booking,
        reservation_status: 'cancelled',
        qrCheckInEligible: false,
      });
      setCancelNotice('Pending hold cancelled and court slot released.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel reservation.');
    }
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!booking) return;
    setSendingEmail(true);
    setEmailError(null);
    setEmailResult(null);
    try {
      const res = await requestBookingConfirmationEmail({
        bookingReference: booking.booking_reference,
        lookupToken: accessToken.trim(),
        recipientEmail: emailInput.trim(),
      });
      setEmailResult(res);
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : 'Unable to send email confirmation right now.',
      );
    } finally {
      setSendingEmail(false);
    }
  };

  const startLocal = booking ? utcIsoToManilaDateAndTime(booking.start_at) : null;
  const endLocal = booking ? utcIsoToManilaDateAndTime(booking.end_at) : null;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          Token-Verified Retrieval
        </p>
        <h1 className="font-display text-4xl font-bold text-navy-950">Booking Lookup</h1>
        <p className="text-sm text-slate-600">
          Enter both your booking reference (e.g.{' '}
          <span className="font-mono font-semibold text-navy-900">PMB-20261123-A4K9</span>) and the
          secure access token issued when your reservation was created.
        </p>
      </div>

      <form onSubmit={handleLookup} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <label htmlFor="lookup-ref" className="block text-sm font-medium text-slate-700 mb-1">
            Booking Reference
          </label>
          <input
            id="lookup-ref"
            type="text"
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="PMB-20261123-A4K9"
            className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 font-mono text-sm uppercase focus:outline-none focus:ring-2 focus:ring-navy-700"
          />
        </div>

        <div>
          <label htmlFor="lookup-token" className="block text-sm font-medium text-slate-700 mb-1">
            Booking Access Token
          </label>
          <input
            id="lookup-token"
            type="password"
            required
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Paste your secure lookup token"
            className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] px-6 rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 disabled:opacity-60 transition-colors"
        >
          <Search className="w-4 h-4" />
          <span>{loading ? 'Verifying...' : 'Find Booking'}</span>
        </button>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </form>

      {booking && startLocal && endLocal && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="text-xs text-slate-500">Booking Reference</p>
              <p className="font-mono text-xl font-bold text-navy-950">
                {booking.booking_reference}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Status</p>
              <p className="font-mono text-sm font-bold uppercase text-navy-900">
                {booking.reservation_status.replace('_', ' ')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Player Name</p>
              <p className="font-bold text-navy-950">{booking.customer_name}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Court</p>
              <p className="font-bold text-navy-950">Court {booking.court_number}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Date & Time ({FACILITY_INFO.timezone})</p>
              <p className="font-mono font-semibold text-navy-950 tabular-nums">
                {startLocal.date} · {startLocal.time}–{endLocal.time}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Server-Verified Amount</p>
              <p className="font-mono font-bold text-navy-950 tabular-nums">
                {formatCentavosPhp(booking.total_amount_centavos)}
              </p>
            </div>
          </div>

          {/* QR Check-In Pass (Gated on verified paid confirmation) */}
          <BookingQrPass
            bookingReference={booking.booking_reference}
            authorizationLookupToken={booking.qrCheckInEligible ? accessToken.trim() : undefined}
            courtNumber={booking.court_number}
            eligible={booking.qrCheckInEligible}
            note={booking.qrCheckInNote}
          />

          {/* Email Receipt / Summary Trigger */}
          <form onSubmit={handleSendEmail} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-navy-950">
              <Mail className="w-4 h-4 text-navy-800" />
              <span>Email Reservation Summary & Receipt</span>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                required
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="Enter recipient email address"
                className="flex-1 min-h-[40px] px-3 rounded-lg border border-slate-300 bg-white text-xs"
              />
              <button
                type="submit"
                disabled={sendingEmail}
                className="min-h-[40px] px-4 rounded-lg bg-navy-950 text-white text-xs font-semibold hover:bg-navy-800 disabled:opacity-50 whitespace-nowrap"
              >
                {sendingEmail ? 'Generating...' : 'Send Email Receipt'}
              </button>
            </div>
            {emailError && <p className="text-xs text-red-700">{emailError}</p>}
            {emailResult && (
              <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs space-y-1.5">
                <p className="font-semibold text-navy-950">
                  {emailResult.delivered
                    ? `Email sent to ${emailResult.recipientEmail}.`
                    : emailResult.reason || 'Email delivery unavailable; text preview generated.'}
                </p>
                <p className="text-slate-500 font-mono">Subject: {emailResult.subject}</p>
                <pre className="whitespace-pre-wrap font-mono text-[11px] bg-slate-50 border border-slate-200 rounded p-2 text-slate-700">
                  {emailResult.preview.text}
                </pre>
              </div>
            )}
          </form>

          {cancelNotice && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-900">
              {cancelNotice}
            </div>
          )}

          {booking.reservation_status === 'pending_payment' && (
            <button
              type="button"
              onClick={handleCancel}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-red-300 text-red-700 text-xs font-bold hover:bg-red-50 transition-colors"
            >
              Cancel Pending Hold & Release Court
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface ConfirmationRouteState {
  holdResult?: CreateGuestHoldResponse;
  customerName?: string;
  customerEmail?: string;
}

export const ConfirmationPage: React.FC = () => {
  const { reference } = useParams<{ reference?: string }>();
  const location = useLocation();
  const state = (location.state ?? {}) as ConfirmationRouteState;
  const hold = state.holdResult;

  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    if (!hold?.expiresAt) return 0;
    return Math.max(0, Math.floor((Date.parse(hold.expiresAt) - Date.now()) / 1000));
  });
  const [copiedToken, setCopiedToken] = useState(false);

  const [emailInput, setEmailInput] = useState(state.customerEmail ?? '');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailResult, setEmailResult] = useState<ConfirmationEmailResult | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (!hold?.expiresAt) return;
    const id = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.floor((Date.parse(hold.expiresAt) - Date.now()) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [hold?.expiresAt]);

  if (!hold) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-4">
          <QrCode className="w-12 h-12 text-navy-800 mx-auto" />
          <h1 className="font-display text-3xl font-bold text-navy-950">
            Booking Confirmation
          </h1>
          <p className="text-sm text-slate-600">
            {reference ? (
              <>
                Reference <span className="font-mono font-semibold">{reference}</span> requires
                your secure access token on Booking Lookup to view details.
              </>
            ) : (
              'Create a booking hold on the floor plan or look up an existing booking using your reference and access token.'
            )}
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link
              to={
                reference
                  ? `${SITE_ROUTES.lookup}?ref=${encodeURIComponent(reference)}`
                  : SITE_ROUTES.lookup
              }
              className="min-h-[44px] px-5 py-2.5 rounded-lg bg-navy-950 text-white text-sm font-semibold inline-flex items-center"
            >
              Go to Booking Lookup
            </Link>
            <Link
              to={SITE_ROUTES.book}
              className="min-h-[44px] px-5 py-2.5 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold inline-flex items-center"
            >
              Book a Court
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const mins = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const secs = String(secondsLeft % 60).padStart(2, '0');

  const handleSendHoldSummaryEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendingEmail(true);
    setEmailError(null);
    setEmailResult(null);
    try {
      const res = await requestBookingConfirmationEmail({
        bookingReference: hold.bookingReference,
        lookupToken: hold.lookupToken,
        recipientEmail: emailInput.trim(),
      });
      setEmailResult(res);
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : 'Unable to send email confirmation right now.',
      );
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <img
            src={FACILITY_INFO.logoImagePath}
            alt="Pick My Ball – Astoria Regency official logo"
            className="h-14 w-auto object-contain"
          />
          <div className="text-right">
            <p className="text-xs font-semibold text-amber-700 uppercase">
              Pending Payment (Hold Active)
            </p>
            <p className="font-mono text-xl font-bold text-navy-950">{hold.bookingReference}</p>
          </div>
        </div>

        {/* Hold Countdown */}
        <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 text-xs text-amber-950">
            <Clock className="w-5 h-5 text-amber-700 shrink-0" />
            <div>
              <p className="font-bold">Temporary Hold Expiration</p>
              <p>Complete payment before the timer expires to keep Court {hold.courtNumber}.</p>
            </div>
          </div>
          <div className="font-mono text-2xl font-bold text-amber-950 tabular-nums shrink-0">
            {mins}:{secs}
          </div>
        </div>

        {/* Summary Grid */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-slate-500">Player Name</p>
            <p className="font-bold text-navy-950">{state.customerName || 'Guest Player'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Court</p>
            <p className="font-bold text-navy-950">Court {hold.courtNumber}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Date & Time ({FACILITY_INFO.timezone})</p>
            <p className="font-mono font-semibold text-navy-950 tabular-nums">
              {hold.date} · {hold.startTime}–{hold.endTime}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Server-Calculated Total</p>
            <p className="font-mono text-lg font-bold text-navy-950 tabular-nums">
              {formatCentavosPhp(hold.pricing.totalAmountCentavos)}
            </p>
          </div>
        </div>

        {/* One-Time Access Token Display */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-bold text-navy-950">
              Private Lookup Access Token (Save This)
            </span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(hold.lookupToken);
                setCopiedToken(true);
              }}
              className="inline-flex items-center gap-1 text-navy-700 font-semibold hover:underline"
            >
              {copiedToken ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedToken ? 'Copied' : 'Copy Token'}</span>
            </button>
          </div>
          <p className="font-mono break-all text-slate-800 bg-white border border-slate-200 rounded px-2.5 py-2">
            {hold.lookupToken}
          </p>
          <p className="text-slate-500">
            Needed alongside <span className="font-mono">{hold.bookingReference}</span> to retrieve,
            email, or cancel this hold on{' '}
            <Link
              to={`${SITE_ROUTES.lookup}?ref=${encodeURIComponent(hold.bookingReference)}`}
              className="text-navy-800 font-semibold underline"
            >
              Booking Lookup
            </Link>
            .
          </p>
        </div>

        {/* Email Hold Summary */}
        <form onSubmit={handleSendHoldSummaryEmail} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-navy-950">
            <Mail className="w-4 h-4 text-navy-800" />
            <span>Email Hold Summary</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              required
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="player@example.com"
              className="flex-1 min-h-[40px] px-3 rounded-lg border border-slate-300 bg-white text-xs"
            />
            <button
              type="submit"
              disabled={sendingEmail}
              className="min-h-[40px] px-4 rounded-lg bg-navy-950 text-white text-xs font-semibold hover:bg-navy-800 disabled:opacity-50 whitespace-nowrap"
            >
              {sendingEmail ? 'Preparing...' : 'Send Summary Email'}
            </button>
          </div>
          {emailError && <p className="text-xs text-red-700">{emailError}</p>}
          {emailResult && (
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs space-y-1.5">
              <p className="font-semibold text-navy-950">
                {emailResult.delivered
                  ? `Email sent to ${emailResult.recipientEmail}.`
                  : emailResult.reason || 'Receipt preview generated cleanly.'}
              </p>
              <pre className="whitespace-pre-wrap font-mono text-[11px] bg-slate-50 border border-slate-200 rounded p-2 text-slate-700">
                {emailResult.preview.text}
              </pre>
            </div>
          )}
        </form>

        {/* Locked QR Pass Status */}
        <BookingQrPass
          bookingReference={hold.bookingReference}
          courtNumber={hold.courtNumber}
          eligible={false}
          note="Temporary hold awaiting payment verification. QR check-in passes unlock only after verified payment confirmation."
        />

        {/* Planned HitPay Stage 5 Status */}
        <div className="rounded-xl border border-slate-200 p-4 text-xs text-slate-600 space-y-1.5">
          <div className="flex items-center gap-2 font-bold text-navy-950">
            <CreditCard className="w-4 h-4 text-navy-800" />
            <span>HitPay Online Checkout (Planned Integration — Inactive)</span>
          </div>
          <p className="leading-relaxed">
            Live payment charges ({STAGE5_HITPAY_PLAN.plannedMethods.join(', ').toUpperCase()}) are
            intentionally disabled until approved and configured with verified HitPay credentials.
          </p>
        </div>
      </div>
    </div>
  );
};
