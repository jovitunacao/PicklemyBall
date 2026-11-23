import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Calendar, Lock, QrCode, Search } from 'lucide-react';
import { COURT_STATUS_LEGEND, FACILITY_INFO, SITE_ROUTES } from '../config/facility';

export const BookCourtPage: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState('2026-11-23');
  const [startTime, setStartTime] = useState('08:00');
  const [durationHours, setDurationHours] = useState(1);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-14 space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
            Stage 1 Route Shell · Stage 2 Target
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-navy-950 mt-1">
            Book a Pickleball Court
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Interactive 14-court SVG floor plan will mount here once Stage 1 is approved and the
            official site layout image is provided.
          </p>
        </div>

        {/* Date / Start Time / Duration Filter Preview */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="book-date" className="block text-xs font-medium text-slate-600 mb-1">
              Play Date ({FACILITY_INFO.timezone})
            </label>
            <input
              id="book-date"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="book-time" className="block text-xs font-medium text-slate-600 mb-1">
              Start Time
            </label>
            <select
              id="book-time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums"
            >
              {['06:00', '07:00', '08:00', '09:00', '16:00', '17:00', '18:00', '19:00', '20:00'].map(
                (t) => (
                  <option key={t} value={t}>
                    {t} PHT
                  </option>
                ),
              )}
            </select>
          </div>
          <div>
            <label htmlFor="book-dur" className="block text-xs font-medium text-slate-600 mb-1">
              Duration
            </label>
            <select
              id="book-dur"
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm tabular-nums"
            >
              <option value={1}>1 Hour</option>
              <option value={2}>2 Hours</option>
              <option value={3}>3 Hours</option>
            </select>
          </div>
        </div>
      </div>

      {/* Stage 2 Floor Plan Mount Target */}
      <div className="bg-white border border-slate-200 rounded-xl p-8 sm:p-12 text-center space-y-4">
        <Calendar className="w-10 h-10 text-navy-800 mx-auto" />
        <h2 className="font-display text-2xl sm:text-3xl font-bold text-navy-950">
          Architectural 14-Court Map Ready for Stage 2
        </h2>
        <p className="text-sm text-slate-600 max-w-xl mx-auto leading-relaxed">
          Per development rules, Stage 1 establishes the application foundation and awaits your
          approval before proceeding to Stage 2. In Stage 2, the uploaded Astoria Regency floor
          plan (941 × 1600, Scale 1:250) will mount here with all 14 calibrated SVG court polygons
          (Courts 1–4 horizontal; Courts 5–10 & 11–14 vertical), pinch-to-zoom, and mobile
          bottom-sheet court selection.
        </p>

        <div className="pt-4 flex flex-wrap items-center justify-center gap-4 text-xs text-slate-600">
          {COURT_STATUS_LEGEND.map((status) => (
            <span key={status.status} className="inline-flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-xs border ${status.swatchClass}`} />
              <span className="font-medium">{status.label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export const AvailabilityPage: React.FC = () => (
  <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-6">
    <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
      Stage 1 Foundation · Live Data in Stage 3–4
    </p>
    <h1 className="font-display text-4xl font-bold text-navy-950">Court Availability</h1>
    <p className="text-sm sm:text-base text-slate-600 max-w-2xl leading-relaxed">
      Real-time court availability across all 14 courts will query PostgreSQL half-open time
      intervals (<code className="font-mono text-xs">[start_at, end_at)</code>) via Supabase in
      Stages 3 and 4. No availability data is hardcoded.
    </p>
    <Link
      to={SITE_ROUTES.book}
      className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 transition-colors"
    >
      Go to Booking Workspace
    </Link>
  </div>
);

export const LookupPage: React.FC = () => {
  const [reference, setReference] = useState('');
  const [searchedRef, setSearchedRef] = useState<string | null>(null);

  const handleLookup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reference.trim()) return;
    setSearchedRef(reference.trim().toUpperCase());
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          Reservation Retrieval
        </p>
        <h1 className="font-display text-4xl font-bold text-navy-950">Booking Lookup</h1>
        <p className="text-sm text-slate-600">
          Enter your human-readable booking reference (for example,{' '}
          <span className="font-mono font-semibold text-navy-900">PMB-20261123-XXXX</span>) to
          view status and QR check-in details.
        </p>
      </div>

      <form onSubmit={handleLookup} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <label htmlFor="lookup-ref" className="block text-sm font-medium text-slate-700 mb-1">
            Booking Reference
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="lookup-ref"
              type="text"
              required
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="PMB-20261123-A4K9"
              className="flex-1 min-h-[44px] px-3.5 rounded-lg border border-slate-300 font-mono text-sm uppercase focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-6 rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 transition-colors whitespace-nowrap"
            >
              <Search className="w-4 h-4" />
              <span>Find Booking</span>
            </button>
          </div>
        </div>

        {searchedRef && (
          <div className="pt-4 border-t border-slate-100 text-sm text-slate-600">
            Lookup for <span className="font-mono font-semibold text-navy-950">{searchedRef}</span>{' '}
            will query verified PostgreSQL records once Supabase backend functions are connected in
            Stage 3–4.
          </div>
        )}
      </form>
    </div>
  );
};

export const ConfirmationPage: React.FC = () => {
  const { reference } = useParams<{ reference?: string }>();
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-4">
        <QrCode className="w-12 h-12 text-navy-800 mx-auto" />
        <h1 className="font-display text-3xl font-bold text-navy-950">
          Booking Confirmation Route
        </h1>
        <p className="text-sm text-slate-600">
          {reference ? (
            <>
              Reference: <span className="font-mono font-semibold">{reference}</span>.
            </>
          ) : (
            'Confirmed reservations will display official Pick My Ball branding, verified payment receipt, and an opaque QR check-in pass here in Stage 5 & Stage 7.'
          )}
        </p>
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
      'Supabase Auth staff login (Super Admin, Manager, Reception Staff) connects in Stage 3 & Stage 6.',
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
      In Stage 6, this workspace will be protected by Supabase Auth + Row Level Security for Super
      Admin, Manager, and Reception Staff—featuring live 14-court visual occupancy, walk-in
      booking creation, maintenance blocks, PHP rate settings, QR scanner check-in, and HitPay
      reconciliation reports.
    </p>
    <Link
      to={SITE_ROUTES.home}
      className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 transition-colors"
    >
      Return to Public Homepage
    </Link>
  </div>
);
