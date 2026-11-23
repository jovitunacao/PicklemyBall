import React, { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { CalendarDays, Compass, Home, MapPin, Menu, Search, X } from 'lucide-react';
import { FACILITY_INFO, SITE_ROUTES } from '../config/facility';

interface LayoutProps {
  children: React.ReactNode;
}

const DESKTOP_NAV_LINKS = [
  { label: 'Book Court', to: SITE_ROUTES.book },
  { label: 'Availability', to: SITE_ROUTES.availability },
  { label: 'Rates', to: SITE_ROUTES.rates },
  { label: 'Facility', to: SITE_ROUTES.about },
  { label: 'Lookup', to: SITE_ROUTES.lookup },
];

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  const isAdminRoute = location.pathname.startsWith('/admin');

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: Single row, 3 zones (Wordmark | 5 single-line nav links | 1 primary CTA) */}
      <header className="sticky top-0 z-40 h-14 md:h-16 bg-navy-950/95 backdrop-blur-md border-b border-navy-800/80 text-white">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <Link
            to={SITE_ROUTES.home}
            onClick={() => setMobileMenuOpen(false)}
            className="font-display text-2xl font-bold tracking-wide text-white hover:text-lime-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lime-400 rounded-sm"
          >
            {FACILITY_INFO.brandName}
          </Link>

          {/* Zone 2: Concise single-line desktop navigation links */}
          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300"
          >
            {DESKTOP_NAV_LINKS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lime-400 ${
                    isActive
                      ? 'text-lime-400 border-lime-400'
                      : 'border-transparent hover:text-white hover:border-slate-500'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Zone 3: Single Primary Action + Mobile Menu Trigger */}
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to={SITE_ROUTES.book}
              className="hidden sm:inline-flex items-center justify-center min-h-[40px] px-5 py-2 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold tracking-tight hover:bg-lime-300 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-400"
            >
              Book a Court
            </Link>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              className="md:hidden min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-slate-200 hover:text-white hover:bg-navy-800 transition-colors focus-visible:outline-2 focus-visible:outline-lime-400"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile Dropdown Navigation Drawer */}
        {mobileMenuOpen && (
          <nav
            aria-label="Mobile navigation drawer"
            className="md:hidden bg-navy-950 border-b border-navy-800 px-4 py-4 space-y-1 shadow-xl"
          >
            {[
              { label: 'Home', to: SITE_ROUTES.home },
              ...DESKTOP_NAV_LINKS,
              { label: 'Contact & Location', to: SITE_ROUTES.contact },
              { label: 'Staff Login', to: SITE_ROUTES.adminLogin },
            ].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center min-h-[44px] px-3 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-navy-800 text-lime-400'
                      : 'text-slate-200 hover:bg-navy-900 hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 pb-20 md:pb-0">{children}</main>

      {/* Quiet Footer */}
      {!isAdminRoute && (
        <footer className="bg-navy-950 text-slate-300 border-t border-navy-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-10 pb-10 border-b border-navy-800/80">
              <div className="md:col-span-5 space-y-4">
                <div className="inline-block bg-white rounded-lg p-2.5 border border-navy-800">
                  <img
                    src={FACILITY_INFO.logoImagePath}
                    alt="Pick My Ball – Astoria Regency, Pasonanca Park official logo"
                    className="h-16 w-auto object-contain"
                  />
                </div>
                <p className="text-sm text-slate-300 leading-relaxed max-w-md">
                  {FACILITY_INFO.branchName}, {FACILITY_INFO.streetAddress}, {FACILITY_INFO.city},{' '}
                  {FACILITY_INFO.country}. Fourteen dedicated pickleball courts with online booking,
                  real-time availability, and QR reception check-in.
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 tabular-nums">
                  <span>{FACILITY_INFO.defaultOperatingHours}</span>
                  <span aria-hidden="true">·</span>
                  <span>Currency: {FACILITY_INFO.currency}</span>
                  <span aria-hidden="true">·</span>
                  <span>14 Courts</span>
                </div>
              </div>

              <div className="md:col-span-3 space-y-3">
                <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
                  Reservations
                </h3>
                <ul className="space-y-2 text-sm">
                  <li>
                    <Link to={SITE_ROUTES.book} className="hover:text-lime-400 transition-colors">
                      Book a Court
                    </Link>
                  </li>
                  <li>
                    <Link to={SITE_ROUTES.availability} className="hover:text-lime-400 transition-colors">
                      Court Availability
                    </Link>
                  </li>
                  <li>
                    <Link to={SITE_ROUTES.rates} className="hover:text-lime-400 transition-colors">
                      Rates & Operating Hours
                    </Link>
                  </li>
                  <li>
                    <Link to={SITE_ROUTES.lookup} className="hover:text-lime-400 transition-colors">
                      Booking Lookup
                    </Link>
                  </li>
                </ul>
              </div>

              <div className="md:col-span-2 space-y-3">
                <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
                  Facility
                </h3>
                <ul className="space-y-2 text-sm">
                  <li>
                    <Link to={SITE_ROUTES.about} className="hover:text-lime-400 transition-colors">
                      About Astoria Regency
                    </Link>
                  </li>
                  <li>
                    <Link to={SITE_ROUTES.contact} className="hover:text-lime-400 transition-colors">
                      Contact & Location
                    </Link>
                  </li>
                  <li>
                    <Link to={SITE_ROUTES.adminLogin} className="hover:text-lime-400 transition-colors">
                      Staff Portal
                    </Link>
                  </li>
                </ul>
              </div>

              <div className="md:col-span-2 space-y-3">
                <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
                  Policies
                </h3>
                <ul className="space-y-2 text-sm">
                  <li>
                    <Link to={SITE_ROUTES.privacy} className="hover:text-lime-400 transition-colors">
                      Privacy Policy
                    </Link>
                  </li>
                  <li>
                    <Link to={SITE_ROUTES.terms} className="hover:text-lime-400 transition-colors">
                      Terms & Cancellation
                    </Link>
                  </li>
                </ul>
              </div>
            </div>

            <div className="pt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-400">
              <p>
                &copy; {new Date().getFullYear()} {FACILITY_INFO.fullTitle}. All rights reserved.
              </p>
              <p className="tabular-nums">
                Zamboanga City, Philippines · Asia/Manila (UTC+8)
              </p>
            </div>
          </div>
        </footer>
      )}

      {/* Mobile Bottom Tab Bar (Thumb Zone Anchor — kept compact at 56px height, well within 15% sticky cap) */}
      {!isAdminRoute && (
        <nav
          aria-label="Mobile quick navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-navy-950/95 backdrop-blur-md border-t border-navy-800 grid grid-cols-4 items-center px-1"
        >
          <NavLink
            to={SITE_ROUTES.home}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors ${
                isActive ? 'text-lime-400' : 'text-slate-300 hover:text-white'
              }`
            }
          >
            <Home className="w-5 h-5 mb-0.5" />
            <span>Home</span>
          </NavLink>
          <NavLink
            to={SITE_ROUTES.book}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors ${
                isActive ? 'text-lime-400' : 'text-slate-300 hover:text-white'
              }`
            }
          >
            <CalendarDays className="w-5 h-5 mb-0.5" />
            <span>Book</span>
          </NavLink>
          <NavLink
            to={SITE_ROUTES.lookup}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors ${
                isActive ? 'text-lime-400' : 'text-slate-300 hover:text-white'
              }`
            }
          >
            <Search className="w-5 h-5 mb-0.5" />
            <span>Lookup</span>
          </NavLink>
          <NavLink
            to={SITE_ROUTES.contact}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors ${
                isActive ? 'text-lime-400' : 'text-slate-300 hover:text-white'
              }`
            }
          >
            {location.pathname === SITE_ROUTES.about ? (
              <Compass className="w-5 h-5 mb-0.5" />
            ) : (
              <MapPin className="w-5 h-5 mb-0.5" />
            )}
            <span>Location</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
};
