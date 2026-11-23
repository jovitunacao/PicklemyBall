import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Calendar, Clock, MapPin, QrCode, ShieldCheck } from 'lucide-react';
import {
  COURT_STATUS_LEGEND,
  COURT_ZONE_SUMMARY,
  FACILITY_INFO,
  SITE_ROUTES,
} from '../config/facility';

const BOOKING_STEPS = [
  {
    step: '01',
    title: 'Choose Date & Time Window',
    description:
      'Pick your play date, start time, and session duration in Asia/Manila time before viewing court occupancy.',
  },
  {
    step: '02',
    title: 'Tap Your Court on the Site Map',
    description:
      'Inspect live availability across all 14 courts on the Astoria Regency architectural floor plan and tap an open blue court.',
  },
  {
    step: '03',
    title: 'Complete Secure Checkout',
    description:
      'Lock a temporary checkout hold while completing payment via supported HitPay methods with server-verified PHP totals.',
  },
  {
    step: '04',
    title: 'Check In with Your QR Pass',
    description:
      'Receive an instant confirmation reference and non-guessable QR pass by email for rapid reception scanning.',
  },
];

const SITE_AMENITIES = [
  'Main Entrance & Exit Gates',
  '18 Parking Slots (12 Upper + 6 Side)',
  'Drop-Off Area (6.00m Driveway)',
  'Clubhouse / Pro Shop & Lobby Reception',
  'Female & Male Toilets / Changing / Utility',
  'Outdoor Spectator / Rest Area',
];

export const HomePage: React.FC = () => {
  const [heroImgFailed, setHeroImgFailed] = useState(false);

  return (
    <div>
      {/* Hero Section: Deep Navy Architectural Canvas */}
      <section className="bg-navy-950 text-white border-b border-navy-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
            {/* Hero Left Column */}
            <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
              <div className="flex flex-wrap items-center gap-4">
                <div className="bg-white rounded-xl p-2.5 shadow-sm border border-navy-800 inline-flex items-center">
                  <img
                    src={FACILITY_INFO.logoImagePath}
                    alt="Pick My Ball – Astoria Regency, Pasonanca Park official logo"
                    className="h-16 sm:h-20 w-auto object-contain"
                  />
                </div>
                <div className="space-y-0.5 text-xs font-medium tracking-wide text-lime-400">
                  <p className="text-white font-semibold text-sm">Astoria Regency</p>
                  <p>Pasonanca Park, Zamboanga City</p>
                </div>
              </div>

              <h1
                className="font-display font-bold tracking-tight text-white leading-[0.98]"
                style={{
                  fontSize: 'clamp(2.5rem, 4.4vw, 4.25rem)',
                  textWrap: 'balance',
                }}
              >
                Fourteen Courts. One Interactive Floor Plan.
              </h1>

              <p className="text-base sm:text-lg text-slate-300 leading-relaxed max-w-xl">
                Reserve your preferred pickleball court at Pick My Ball – Astoria Regency directly
                from the official architectural layout. Instant availability checks, transparent
                PHP rates, and QR check-in without creating an account.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Link
                  to={SITE_ROUTES.book}
                  className="inline-flex items-center justify-center gap-2 min-h-[48px] px-7 py-3 rounded-lg bg-lime-400 text-navy-950 text-base font-bold hover:bg-lime-300 active:scale-[0.98] transition-all whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-400"
                >
                  <span>Book a Court</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>

                <Link
                  to={SITE_ROUTES.lookup}
                  className="inline-flex items-center justify-center min-h-[48px] px-4 py-3 text-sm font-semibold text-slate-200 hover:text-lime-400 underline underline-offset-4 decoration-slate-600 hover:decoration-lime-400 transition-colors whitespace-nowrap"
                >
                  Look Up Booking
                </Link>
              </div>

              <div className="pt-4 border-t border-navy-800/80 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <span>No account required to book</span>
                <span aria-hidden="true">·</span>
                <span>18 parking slots + drop-off</span>
                <span aria-hidden="true">·</span>
                <span>Instant email confirmation</span>
              </div>
            </div>

            {/* Hero Right Column: 16:9 Architectural Facility Image */}
            <div className="lg:col-span-6 flex">
              <div className="relative w-full min-h-[260px] lg:min-h-[420px] rounded-xl overflow-hidden border border-navy-800 bg-navy-900">
                {!heroImgFailed ? (
                  <img
                    src={FACILITY_INFO.heroImagePath}
                    alt="Pick My Ball – Astoria Regency pickleball complex surrounded by Pasonanca Park greenery"
                    referrerPolicy="no-referrer"
                    onError={() => setHeroImgFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-navy-900 via-navy-950 to-navy-800">
                    <MapPin className="w-8 h-8 text-lime-400 mb-3" />
                    <p className="font-display text-2xl font-bold text-white">
                      {FACILITY_INFO.fullTitle}
                    </p>
                    <p className="text-sm text-slate-300 mt-1">
                      14 Pickleball Courts · Pasonanca Park, Zamboanga City
                    </p>
                  </div>
                )}

                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-navy-950/95 via-navy-950/60 to-transparent p-5 sm:p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-200">
                    <span className="font-semibold text-white">
                      {FACILITY_INFO.streetAddress}, {FACILITY_INFO.city}
                    </span>
                    <span className="font-mono text-lime-400 tabular-nums">
                      Courts 1–14 · PHT (UTC+8)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Full-Width 4-Column Facility Strip */}
      <section className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
            <div className="py-6 sm:px-6 first:pl-0">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <MapPin className="w-4 h-4 text-navy-700" />
                <span>Dedicated Courts</span>
              </div>
              <p className="mt-1.5 font-display text-3xl font-bold text-navy-900 tabular-nums">
                14 Courts
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                Mapped across 3 facility zones
              </p>
            </div>

            <div className="py-6 sm:px-6">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <Clock className="w-4 h-4 text-navy-700" />
                <span>Operating Hours</span>
              </div>
              <p className="mt-1.5 font-display text-3xl font-bold text-navy-900 tabular-nums">
                06:00 – 22:00
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                Daily schedule in Asia/Manila
              </p>
            </div>

            <div className="py-6 sm:px-6">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <Calendar className="w-4 h-4 text-navy-700" />
                <span>Transparent Billing</span>
              </div>
              <p className="mt-1.5 font-display text-3xl font-bold text-navy-900 tabular-nums">
                PHP Rates
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                Server-verified before payment
              </p>
            </div>

            <div className="py-6 sm:px-6 last:pr-0">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <QrCode className="w-4 h-4 text-navy-700" />
                <span>Arrival Verification</span>
              </div>
              <p className="mt-1.5 font-display text-3xl font-bold text-navy-900">
                QR Check-In
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                Opaque token scan at reception
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How Reservation Works + Live Status Color System */}
      <section className="py-14 lg:py-20 bg-slate-50 border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
            <div className="max-w-2xl space-y-2">
              <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
                Reservation Workflow
              </p>
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-navy-950 tracking-tight">
                Reserve straight from the architectural floor plan
              </h2>
            </div>
            <Link
              to={SITE_ROUTES.rates}
              className="text-sm font-semibold text-navy-800 hover:text-navy-950 underline underline-offset-4 whitespace-nowrap"
            >
              View rates & operating hours
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {BOOKING_STEPS.map((item) => (
              <div
                key={item.step}
                className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between"
              >
                <div>
                  <span className="font-mono text-sm font-semibold text-navy-700 tabular-nums">
                    {item.step}.
                  </span>
                  <h3 className="mt-3 text-lg font-bold text-navy-950">{item.title}</h3>
                  <p className="mt-2 text-sm text-slate-600 leading-relaxed">{item.description}</p>
                </div>
              </div>
            ))}
          </div>

          {/* 5-State Court Color Legend */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-6 border-b border-slate-100">
              <div>
                <h3 className="text-lg font-bold text-navy-950">
                  Interactive Map Status Colors
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  Every court polygon renders a translucent overlay paired with an explicit status
                  label so the underlying floor plan remains legible.
                </p>
              </div>
              <Link
                to={SITE_ROUTES.book}
                className="text-sm font-semibold text-navy-800 hover:text-navy-950 whitespace-nowrap"
              >
                Preview Stage 2 Plan &rarr;
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6 pt-6">
              {COURT_STATUS_LEGEND.map((item) => (
                <div key={item.status} className="space-y-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className={`w-4 h-4 rounded-sm border ${item.swatchClass} shrink-0`}
                    />
                    <span className={`text-sm font-bold ${item.badgeTextClass}`}>
                      {item.label}
                    </span>
                    <span className="text-xs text-slate-400">({item.colorName})</span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Court Zones & Facility Overview */}
      <section className="py-14 lg:py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
            {/* Left: 3 Court Zones */}
            <div className="lg:col-span-7 space-y-6">
              <div className="space-y-2">
                <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
                  Site Architecture
                </p>
                <h2 className="font-display text-3xl sm:text-4xl font-bold text-navy-950 tracking-tight">
                  14 Courts Organized Across Three Zones
                </h2>
                <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                  Exact court positions, numbering, driveways, and surrounding facilities will align
                  1:1 to your uploaded architectural floor plan in Stage 2.
                </p>
              </div>

              <div className="divide-y divide-slate-200 border-t border-b border-slate-200">
                {COURT_ZONE_SUMMARY.map((zone) => (
                  <div
                    key={zone.zone}
                    className="py-5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 sm:gap-6"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-base font-bold text-navy-950">{zone.label}</h3>
                        <span className="font-mono text-xs font-semibold text-navy-700 tabular-nums">
                          {zone.range}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600">{zone.description}</p>
                    </div>
                    <span className="font-mono text-sm font-semibold text-slate-900 tabular-nums shrink-0">
                      {zone.count} courts
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: Facilities & Logo Asset Notice */}
            <div className="lg:col-span-5 space-y-6">
              <div className="bg-navy-950 text-white rounded-xl p-6 sm:p-8 space-y-5">
                <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-lime-400 uppercase">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Preserved Facility Features</span>
                </div>
                <h3 className="font-display text-2xl font-bold">
                  Astoria Regency Site Context
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Customers always see surrounding campus landmarks while selecting courts so
                  arrival, parking, and court orientation are unmistakable.
                </p>
                <ul className="space-y-2.5 pt-2 border-t border-navy-800 text-sm text-slate-200">
                  {SITE_AMENITIES.map((amenity) => (
                    <li key={amenity} className="flex items-center justify-between gap-3">
                      <span>{amenity}</span>
                      <span className="font-mono text-xs text-lime-400">Mapped</span>
                    </li>
                  ))}
                </ul>
                <div className="pt-2">
                  <Link
                    to={SITE_ROUTES.about}
                    className="inline-flex items-center justify-center w-full min-h-[44px] px-5 py-2.5 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 transition-colors"
                  >
                    Explore Facility Details
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
