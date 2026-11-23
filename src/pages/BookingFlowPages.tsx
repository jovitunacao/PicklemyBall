import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Lock, QrCode, Search } from 'lucide-react';
import { FACILITY_INFO, SITE_ROUTES } from '../config/facility';

export const AvailabilityPage: React.FC = () => (
  <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-6">
    <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
      Stage 2 Interactive Map · Simulated Preview
    </p>
    <h1 className="font-display text-4xl font-bold text-navy-950">Court Availability</h1>
    <p className="text-sm sm:text-base text-slate-600 max-w-2xl leading-relaxed">
      Inspect simulated availability across all 14 courts on the official Astoria Regency
      architectural site layout. Real-time PostgreSQL interval queries (
      <code className="font-mono text-xs">[start_at, end_at)</code>) via Supabase will replace the
      Stage 2 simulator in Stages 3 and 4.
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
