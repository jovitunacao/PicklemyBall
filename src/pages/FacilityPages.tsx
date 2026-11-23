import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Mail, MapPin, Phone, CheckCircle2, Settings, AlertCircle } from 'lucide-react';
import { COURT_ZONE_SUMMARY, FACILITY_INFO, SITE_ROUTES } from '../config/facility';
import { formatCentavosPhp } from '../services/bookingApi';
import {
  fetchPublicFacilityScheduleAndRates,
  PublicFacilityScheduleAndRates,
  sanitizePricingRuleDisplayName,
} from '../services/facilityConfigApi';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const RatesPage: React.FC = () => {
  const [catalog, setCatalog] = useState<PublicFacilityScheduleAndRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchPublicFacilityScheduleAndRates()
      .then((res) => {
        if (active) setCatalog(res);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load rates and hours.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const weeklyHours = (catalog?.operatingHours ?? []).filter((h) => h.day_of_week !== null);
  const dateOverrides = (catalog?.operatingHours ?? []).filter((h) => Boolean(h.override_date));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-10">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 pb-8">
        <div className="space-y-3">
          <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
            Rates & Schedule · {FACILITY_INFO.timezone}
          </p>
          <h1 className="font-display text-4xl sm:text-5xl font-bold text-navy-950 tracking-tight">
            Court Rates & Operating Hours
          </h1>
          <p className="text-base text-slate-600 max-w-2xl">
            Court rates and operating hours are managed in PostgreSQL and calculated on the server
            before reservation checkout. Management sets final production rates directly in the
            Administrator Dashboard.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <Link
            to="/admin/pricing"
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2 rounded-lg border border-slate-300 bg-white text-navy-950 text-xs font-semibold hover:bg-slate-50 whitespace-nowrap"
          >
            <Settings className="w-4 h-4" />
            <span>Configure Rates in Admin</span>
          </Link>
          <Link
            to={SITE_ROUTES.book}
            className="inline-flex items-center justify-center min-h-[44px] px-5 py-2 rounded-lg bg-lime-400 text-navy-950 text-xs font-bold hover:bg-lime-300 whitespace-nowrap"
          >
            Book a Court
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-900 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {catalog?.hasInitialSeededRateLabels && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950 space-y-1.5">
          <p className="font-bold">Rate & Operating Hours Configuration Guide for Management</p>
          <p className="leading-relaxed">
            The database currently contains initial seeded placeholder schedule rules. To enter
            your official Astoria Regency PHP hourly rates and operating hours, sign in at{' '}
            <Link to={SITE_ROUTES.adminLogin} className="font-semibold underline">
              /admin/login
            </Link>{' '}
            with a Manager or Super Admin account, then open{' '}
            <Link to="/admin/pricing" className="font-semibold underline">
              Pricing &amp; Rates (/admin/pricing)
            </Link>{' '}
            and{' '}
            <Link to="/admin/operating-hours" className="font-semibold underline">
              Operating Hours (/admin/operating-hours)
            </Link>
            .
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Operating Schedule */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-2 text-navy-800 font-semibold text-sm">
            <Clock className="w-4 h-4" />
            <span>Weekly Operating Hours (PHT)</span>
          </div>

          {loading ? (
            <p className="text-xs text-slate-500">Loading facility operating hours...</p>
          ) : weeklyHours.length > 0 ? (
            <div className="divide-y divide-slate-100 text-xs">
              {weeklyHours.map((row) => (
                <div key={row.id} className="py-2.5 flex items-center justify-between gap-4">
                  <span className="font-semibold text-navy-950">
                    {DAY_NAMES[row.day_of_week ?? 0]}
                  </span>
                  <span className="font-mono tabular-nums text-slate-700">
                    {row.is_closed
                      ? 'Closed'
                      : `${row.open_time.slice(0, 5)} – ${row.close_time.slice(0, 5)} PHT`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="font-mono text-sm text-slate-700 tabular-nums">
              {FACILITY_INFO.defaultOperatingHours} (configurable via /admin/operating-hours)
            </p>
          )}

          {dateOverrides.length > 0 && (
            <div className="pt-3 border-t border-slate-100 space-y-2 text-xs">
              <p className="font-semibold text-navy-950">Holiday & Date Overrides</p>
              {dateOverrides.map((ov) => (
                <div key={ov.id} className="flex items-center justify-between text-slate-600">
                  <span className="font-mono">{ov.override_date}</span>
                  <span className="font-mono tabular-nums">
                    {ov.is_closed
                      ? 'Closed'
                      : `${ov.open_time.slice(0, 5)}–${ov.close_time.slice(0, 5)} PHT`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 text-xs text-slate-500">
            Update weekly hours or special holiday closures in{' '}
            <Link to="/admin/operating-hours" className="text-navy-800 font-semibold underline">
              /admin/operating-hours
            </Link>
            .
          </div>
        </div>

        {/* Live Pricing Rules & Courts */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-2xl font-bold text-navy-950">
                Active PHP Pricing Schedule
              </h2>
              <p className="text-xs text-slate-600">
                Calculated per hour block on the server in integer centavos (PHP).
              </p>
            </div>
            <span className="font-mono text-xs font-semibold text-navy-800">
              {catalog?.source === 'supabase_live' ? 'Live Database Schedule' : 'Awaiting Connection'}
            </span>
          </div>

          {loading ? (
            <p className="text-xs text-slate-500">Loading active pricing schedule...</p>
          ) : catalog && catalog.pricingRules.length > 0 ? (
            <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
              {catalog.pricingRules.map((rule) => (
                <div key={rule.id} className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-bold text-navy-950">
                      {sanitizePricingRuleDisplayName(rule.name)}
                    </p>
                    <p className="text-slate-500 font-mono tabular-nums">
                      {rule.day_scope === 'all' ? 'All Days' : rule.day_scope} ·{' '}
                      {rule.start_time && rule.end_time
                        ? `${rule.start_time.slice(0, 5)}–${rule.end_time.slice(0, 5)} PHT`
                        : 'All Operating Hours'}
                    </p>
                  </div>
                  <div className="font-mono text-sm font-bold text-navy-950 tabular-nums">
                    {rule.rate_centavos !== null
                      ? `${formatCentavosPhp(rule.rate_centavos)} / hr`
                      : `${rule.discount_percent}% Off`}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
              Configure final PHP rates in{' '}
              <Link to="/admin/pricing" className="font-semibold text-navy-900 underline">
                /admin/pricing
              </Link>
              .
            </div>
          )}

          {catalog && catalog.courts.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold text-slate-700">
                Base Court Rates (Courts 1–14)
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {catalog.courts.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-lg border border-slate-200 px-3 py-2 flex items-center justify-between"
                  >
                    <span className="font-semibold text-navy-950">C{c.court_number}</span>
                    <span className="font-mono text-slate-700 tabular-nums">
                      {formatCentavosPhp(c.base_hourly_rate_centavos)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const AboutPage: React.FC = () => {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-10">
      <div className="space-y-3 border-b border-slate-200 pb-8">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          About the Facility
        </p>
        <h1 className="font-display text-4xl sm:text-5xl font-bold text-navy-950 tracking-tight">
          {FACILITY_INFO.fullTitle}
        </h1>
        <p className="text-base text-slate-600 max-w-2xl">
          Located inside {FACILITY_INFO.streetAddress}, {FACILITY_INFO.city}, Pick My Ball brings 14
          dedicated pickleball courts together with easy vehicular access, reception check-in, and
          player amenities.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {COURT_ZONE_SUMMARY.map((zone) => (
          <div key={zone.zone} className="bg-white border border-slate-200 rounded-xl p-6 space-y-2">
            <div className="font-mono text-xs font-semibold text-navy-700 tabular-nums">
              {zone.range}
            </div>
            <h2 className="font-display text-2xl font-bold text-navy-950">{zone.label}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{zone.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ContactPage: React.FC = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;
    setSubmitted(true);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-10">
      <div className="space-y-3 border-b border-slate-200 pb-8">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          Location & Inquiries
        </p>
        <h1 className="font-display text-4xl sm:text-5xl font-bold text-navy-950 tracking-tight">
          Contact & Location
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-navy-800 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-bold text-navy-950">Facility Address</h2>
                <p className="text-sm text-slate-600 mt-1">
                  {FACILITY_INFO.streetAddress}
                  <br />
                  {FACILITY_INFO.city}, {FACILITY_INFO.country}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-5 h-5 text-navy-800 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-bold text-navy-950">Reception Desk</h2>
                <p className="text-sm text-slate-600 mt-1 tabular-nums">
                  {FACILITY_INFO.contactPhone}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-navy-800 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-bold text-navy-950">Email</h2>
                <p className="text-sm text-slate-600 mt-1">{FACILITY_INFO.contactEmail}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            {submitted ? (
              <div className="py-8 text-center space-y-3">
                <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto" />
                <h2 className="font-display text-2xl font-bold text-navy-950">
                  Inquiry Recorded
                </h2>
                <p className="text-sm text-slate-600 max-w-md mx-auto">
                  Thank you, {name}. Your inquiry has been noted. For immediate assistance, contact{' '}
                  {FACILITY_INFO.contactEmail} or call {FACILITY_INFO.contactPhone}.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSubmitted(false);
                    setName('');
                    setEmail('');
                    setMessage('');
                  }}
                  className="min-h-[44px] px-5 py-2 rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 transition-colors"
                >
                  Send Another Message
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <h2 className="font-display text-2xl font-bold text-navy-950">
                  Send a Facility Inquiry
                </h2>
                <div>
                  <label htmlFor="contact-name" className="block text-sm font-medium text-slate-700 mb-1">
                    Full Name
                  </label>
                  <input
                    id="contact-name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Juan Dela Cruz"
                    className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
                  />
                </div>
                <div>
                  <label htmlFor="contact-email" className="block text-sm font-medium text-slate-700 mb-1">
                    Email Address
                  </label>
                  <input
                    id="contact-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="player@example.com"
                    className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
                  />
                </div>
                <div>
                  <label htmlFor="contact-msg" className="block text-sm font-medium text-slate-700 mb-1">
                    Message
                  </label>
                  <textarea
                    id="contact-msg"
                    rows={4}
                    required
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Tournament inquiry, private group session, or court feedback..."
                    className="w-full p-3.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-[44px] px-6 py-2.5 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 transition-colors"
                >
                  Submit Inquiry
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const PrivacyPolicyPage: React.FC = () => (
  <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-6">
    <h1 className="font-display text-4xl font-bold text-navy-950">Privacy Policy</h1>
    <p className="text-sm text-slate-600 leading-relaxed">
      Pick My Ball – Astoria Regency collects only the reservation details needed to manage court
      bookings, process authorized payments, send email receipts, and verify check-in at reception
      in accordance with the Philippine Data Privacy Act of 2012 (Republic Act No. 10173).
    </p>
    <p className="text-sm text-slate-600 leading-relaxed">
      QR check-in passes contain only an opaque, non-guessable verification token and never expose
      raw phone numbers, email addresses, or payment card details.
    </p>
  </div>
);

export const TermsPolicyPage: React.FC = () => (
  <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-6">
    <h1 className="font-display text-4xl font-bold text-navy-950">
      Terms and Cancellation Policy
    </h1>
    <p className="text-sm text-slate-600 leading-relaxed">
      Court reservations are confirmed only after server-verified payment completion or authorized
      reception walk-in recording. Unpaid checkout holds expire automatically to keep courts open
      for other players.
    </p>
    <p className="text-sm text-slate-600 leading-relaxed">
      Pending unpaid checkout holds may be cancelled directly on Booking Lookup using your private
      access token. Specific cut-off windows, rescheduling rules, rain-delay policies, and refund
      eligibility for paid confirmed reservations are governed by facility management policy.
    </p>
  </div>
);
