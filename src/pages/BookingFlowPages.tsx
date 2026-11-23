import React, { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock, Copy, Lock, QrCode, Search } from 'lucide-react';
import { FACILITY_INFO, SITE_ROUTES } from '../config/facility';
import { utcIsoToManilaDateAndTime } from '../lib/manilaTime';
import {
  BookingLookupResponse,
  cancelBookingWithToken,
  CreateGuestHoldResponse,
  formatCentavosPhp,
  lookupBookingWithToken,
} from '../services/bookingApi';

export const AvailabilityPage: React.FC = () => (
  <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-6">
    <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
      Stage 4 Live Engine
    </p>
    <h1 className="font-display text-4xl font-bold text-navy-950">Court Availability</h1>
    <p className="text-sm sm:text-base text-slate-600 max-w-2xl leading-relaxed">
      Inspect real-time court availability across all 14 courts on the official Astoria Regency
      architectural site layout using half-open time intervals (
      <code className="font-mono text-xs">[start_at, end_at)</code>) in Asia/Manila time.
    </p>
    <Link
      to={SITE_ROUTES.book}
      className="inline-flex items-center justify-center min-h-[44px] px-6 py-2.5 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 transition-colors"
    >
      Open 14-Court Floor Plan
    </Link>
  </div>
);

export const LookupPage: React.FC = () => {
  const [reference, setReference] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingLookupResponse | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCancelNotice(null);
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
      setBooking({ ...booking, reservation_status: 'cancelled' });
      setCancelNotice('Reservation cancelled and court slot released.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel reservation.');
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
          <span className="font-mono font-semibold text-navy-900">PMB-20261123-A4K9</span>) and
          the secure access token issued at reservation hold creation.
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
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
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
              <p className="text-xs text-slate-500">Payment Status</p>
              <p className="font-mono font-semibold uppercase text-slate-800">
                {booking.payment_status}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Server-Verified Amount</p>
              <p className="font-mono font-bold text-navy-950 tabular-nums">
                {formatCentavosPhp(booking.total_amount_centavos)}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700 flex items-start gap-2.5">
            <QrCode className="w-4 h-4 text-navy-800 shrink-0 mt-0.5" />
            <span>{booking.qrCheckInNote}</span>
          </div>

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
                your secure access token on the Lookup page to view details.
              </>
            ) : (
              'Create a booking hold on the floor plan or look up an existing booking using your reference and access token.'
            )}
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link
              to={SITE_ROUTES.lookup}
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
            Needed alongside <span className="font-mono">{hold.bookingReference}</span> to look up
            or cancel this reservation.
          </p>
        </div>

        {/* Stage 5 Payment & QR Notice */}
        <div className="rounded-lg border border-slate-200 bg-navy-950 text-white p-4 text-xs space-y-2">
          <p className="font-bold text-lime-400">Stage 5 Payment Gateway Pending</p>
          <p className="text-slate-300 leading-relaxed">
            Payment checkout (HitPay) and QR check-in pass issuance are intentionally disabled in
            Stage 4 until Stage 5 payment verification is enabled. Unpaid holds cannot generate a
            valid check-in QR pass.
          </p>
        </div>
      </div>
    </div>
  );
};

export const AdminLoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(
      'Staff authentication connects via Supabase Auth + staff_profiles RBAC in Stage 6 (API foundation ready in /api/admin/*).',
    );
  };

  return (
    <div className="max-w-md mx-auto px-4 py-14 lg:py-20">
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-navy-700 uppercase">
            <Lock className="w-3.5 h-3.5" />
            <span>Staff Portal</span>
          </div>
          <h1 className="font-display text-3xl font-bold text-navy-950">Administrator Login</h1>
          <p className="text-xs text-slate-600">
            Authorized Astoria Regency staff only (Super Admin · Manager · Reception Staff)
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="staff-email" className="block text-sm font-medium text-slate-700 mb-1">
              Staff Email
            </label>
            <input
              id="staff-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="staff@pickmyball.ph"
              className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>
          <div>
            <label htmlFor="staff-pass" className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              id="staff-pass"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>
          <button
            type="submit"
            className="w-full min-h-[44px] rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 transition-colors"
          >
            Sign In
          </button>
        </form>

        {notice && (
          <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
            {notice}
          </p>
        )}

        <div className="pt-2 border-t border-slate-100 text-center">
          <Link to={SITE_ROUTES.adminDashboard} className="text-xs font-medium text-navy-700 hover:underline">
            Preview Stage 6 Dashboard Route
          </Link>
        </div>
      </div>
    </div>
  );
};

export const AdminDashboardPlaceholderPage: React.FC = () => (
  <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-6">
    <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
      Stage 6 Target · RBAC Protected
    </p>
    <h1 className="font-display text-4xl font-bold text-navy-950">Administrator Dashboard</h1>
    <p className="text-sm sm:text-base text-slate-600 max-w-2xl leading-relaxed">
      Backend RBAC endpoints (<code className="font-mono text-xs">/api/admin/*</code>) and
      PostgreSQL Row Level Security policies are in place from Stages 3–4. The full visual admin
      UI will launch in Stage 6.
    </p>
    <Link
      to={SITE_ROUTES.home}
      className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 transition-colors"
    >
      Return to Public Homepage
    </Link>
  </div>
);
