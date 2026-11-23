import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Mail, MapPin, Phone, CheckCircle2 } from 'lucide-react';
import { COURT_ZONE_SUMMARY, FACILITY_INFO, SITE_ROUTES } from '../config/facility';

export const RatesPage: React.FC = () => {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-10">
      <div className="space-y-3 border-b border-slate-200 pb-8">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          Rates & Schedule · {FACILITY_INFO.timezone}
        </p>
        <h1 className="font-display text-4xl sm:text-5xl font-bold text-navy-950 tracking-tight">
          Court Rates & Operating Hours
        </h1>
        <p className="text-base text-slate-600 max-w-2xl">
          All hourly court rates, peak-hour multipliers, and weekday/weekend pricing rules are
          configured dynamically in the Administrator Dashboard and calculated authoritatively on
          the server before checkout.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-4">
          <div className="flex items-center gap-2 text-navy-800 font-semibold text-sm">
            <Clock className="w-4 h-4" />
            <span>Facility Operating Schedule</span>
          </div>
          <p className="font-display text-3xl font-bold text-navy-950 tabular-nums">
            {FACILITY_INFO.defaultOperatingHours}
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            Time slots operate in 60-minute increments (with administrator-configurable minimum and
            maximum duration limits) in Philippine Standard Time (Asia/Manila).
          </p>
          <div className="pt-4 border-t border-slate-100 text-xs text-slate-500">
            Configurable per day of week and special holidays in Stage 4 & Stage 6.
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-4">
          <div className="text-navy-800 font-semibold text-sm">
            PHP Pricing Policy (No Hardcoded Rates)
          </div>
          <p className="font-display text-3xl font-bold text-navy-950">
            Admin-Configured PHP
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            Hourly court rates, weekday vs. weekend tiers, peak evening surcharges, and promo
            discounts will be loaded from PostgreSQL pricing rules once confirmed with management.
          </p>
          <div className="pt-4 border-t border-slate-100">
            <Link
              to={SITE_ROUTES.book}
              className="inline-flex items-center justify-center min-h-[44px] px-5 py-2 rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 transition-colors"
            >
              Continue to Court Booking
            </Link>
          </div>
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
                  Thank you, {name}. Email routing via Resend will connect to reception in Stage 7.
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
      Specific cancellation cut-off windows, rescheduling rules, rain-delay policies, and refund
      eligibility will be finalized upon confirmation of facility business rules before Stage 4.
    </p>
  </div>
);
