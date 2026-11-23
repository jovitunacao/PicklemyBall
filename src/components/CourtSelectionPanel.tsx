import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  Loader2,
  X,
} from 'lucide-react';
import { COURT_MAP_REGIONS, getZoneLabel } from '../config/courtMapRegions';
import { COURT_STATUS_LEGEND, FACILITY_INFO, SITE_ROUTES } from '../config/facility';
import { formatEndTime, SimulatedSlotOutcome } from '../data/mockStage2Availability';
import { isPastManilaSlot } from '../lib/manilaTime';
import {
  ApiError,
  CourtScheduleSlot,
  fetchCourtSchedule,
  fetchServerPricingQuote,
  formatCentavosPhp,
  PricingQuoteResponse,
  submitGuestBookingHold,
} from '../services/bookingApi';
import { CourtStatus } from '../types/booking';

interface CourtSelectionPanelProps {
  courtNumber: number | null;
  courtOutcome: SimulatedSlotOutcome | null;
  availabilitySource: 'supabase_live' | 'simulated_stage2_fallback' | null;
  selectedDate: string;
  startTime: string;
  durationHours: number;
  isSelectedForBooking: boolean;
  onChangeStartTime: (nextTime: string) => void;
  onChangeDuration: (hours: number) => void;
  onRefreshAvailability: () => void;
  onClosePanel: () => void;
}

export const CourtSelectionPanel: React.FC<CourtSelectionPanelProps> = ({
  courtNumber,
  courtOutcome,
  availabilitySource,
  selectedDate,
  startTime,
  durationHours,
  isSelectedForBooking,
  onChangeStartTime,
  onChangeDuration,
  onRefreshAvailability,
  onClosePanel,
}) => {
  const navigate = useNavigate();

  const [step, setStep] = useState<'inspect' | 'guest_form'>('inspect');
  const [daySlots, setDaySlots] = useState<CourtScheduleSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [quote, setQuote] = useState<PricingQuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Guest form state (Step 5-7)
  const [customerName, setCustomerName] = useState('');
  const [customerMobile, setCustomerMobile] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [specialRequests, setSpecialRequests] = useState('');
  const [submittingHold, setSubmittingHold] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset to inspect step when switching courts or losing availability
  useEffect(() => {
    setStep('inspect');
    setSubmitError(null);
  }, [courtNumber]);

  // Fetch court daily slots with AbortController cancellation
  useEffect(() => {
    if (courtNumber === null) {
      setDaySlots([]);
      return;
    }
    const controller = new AbortController();
    setSlotsLoading(true);

    fetchCourtSchedule({ courtNumber, date: selectedDate }, controller.signal)
      .then((res) => {
        setDaySlots(res.slots);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      })
      .finally(() => {
        if (!controller.signal.aborted) setSlotsLoading(false);
      });

    return () => controller.abort();
  }, [courtNumber, selectedDate]);

  // Fetch authoritative server-side pricing quote
  useEffect(() => {
    if (courtNumber === null) {
      setQuote(null);
      return;
    }
    const controller = new AbortController();
    setQuoteLoading(true);
    setQuoteError(null);

    fetchServerPricingQuote(
      {
        courtNumber,
        date: selectedDate,
        startTime,
        durationMinutes: durationHours * 60,
      },
      controller.signal,
    )
      .then((q) => setQuote(q))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setQuote(null);
        setQuoteError(err instanceof Error ? err.message : 'Unable to fetch server pricing quote.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuoteLoading(false);
      });

    return () => controller.abort();
  }, [courtNumber, selectedDate, startTime, durationHours]);

  if (courtNumber === null || !courtOutcome) {
    return (
      <div className="hidden lg:block bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          Court Inspector
        </p>
        <h2 className="font-display text-2xl font-bold text-navy-950">
          Select a Court on the Floor Plan
        </h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          Tap any blue court on the Astoria Regency architectural plan to view hourly slots,
          server-calculated PHP pricing, and create a temporary reservation hold without creating
          an account.
        </p>
        <div className="pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
          <p>
            Current Interval:{' '}
            <span className="font-mono font-semibold text-navy-900 tabular-nums">
              {selectedDate} · {startTime}–{formatEndTime(startTime, durationHours)} PHT
            </span>
          </p>
          <p>
            Source:{' '}
            {availabilitySource === 'supabase_live'
              ? 'Live Supabase Availability'
              : availabilitySource === 'simulated_stage2_fallback'
                ? 'Simulated Stage 2 Fallback (Missing Credentials)'
                : 'Live Connection Diagnostic Required'}
          </p>
        </div>
      </div>
    );
  }

  const region = COURT_MAP_REGIONS.find((c) => c.courtNumber === courtNumber);
  const zoneTitle = region ? getZoneLabel(region.zone) : 'Astoria Regency';
  const endTime = formatEndTime(startTime, durationHours);
  const isAvailable = courtOutcome.status === CourtStatus.AVAILABLE;
  const statusLegend = COURT_STATUS_LEGEND.find((l) => l.status === courtOutcome.status);

  const handleSubmitHold = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmittingHold(true);

    try {
      const result = await submitGuestBookingHold({
        courtNumber,
        date: selectedDate,
        startTime,
        durationMinutes: durationHours * 60,
        customerName,
        customerMobile,
        customerEmail,
        specialRequests: specialRequests.trim() || undefined,
      });

      onRefreshAvailability();
      navigate(`${SITE_ROUTES.confirmation}/${result.bookingReference}`, {
        state: {
          holdResult: result,
          customerName,
          customerEmail,
        },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onRefreshAvailability();
      }
      setSubmitError(
        err instanceof Error ? err.message : 'Unable to create temporary reservation hold.',
      );
    } finally {
      setSubmittingHold(false);
    }
  };

  const panelBody = (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-navy-700">
            <span>{zoneTitle}</span>
            <span aria-hidden="true">·</span>
            <span>
              {availabilitySource === 'supabase_live' ? 'Live Availability' : 'Simulated Map'}
            </span>
          </div>
          <h2 className="font-display text-3xl font-bold text-navy-950 mt-0.5">
            Court {courtNumber}
          </h2>
        </div>

        <button
          type="button"
          onClick={onClosePanel}
          aria-label="Close court selection panel"
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-navy-950 hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {step === 'inspect' ? (
        <>
          {/* Status Banner */}
          {isSelectedForBooking && isAvailable ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3.5 flex items-start gap-2.5 text-xs text-green-900">
              <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Highlighted Green (Selected):</span> Open for{' '}
                <span className="font-mono font-semibold tabular-nums">
                  {startTime}–{endTime} PHT
                </span>{' '}
                on {selectedDate}.
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-200 bg-red-50/70 p-3.5 flex items-start gap-2.5 text-xs text-slate-800">
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-bold text-red-900">
                  {statusLegend?.label ?? 'Unavailable'} for {startTime}–{endTime}
                </div>
                <p className="text-slate-700">{courtOutcome.reason}</p>
                <p className="text-slate-600">
                  Pick an open blue slot below for Court {courtNumber}, or tap another blue court
                  on the floor plan.
                </p>
              </div>
            </div>
          )}

          {/* Selected Date & Duration */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <Calendar className="w-3.5 h-3.5" />
                <span>Date ({FACILITY_INFO.timezone})</span>
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-navy-950 tabular-nums">
                {selectedDate}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <label
                htmlFor="panel-duration"
                className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500"
              >
                <Clock className="w-3.5 h-3.5" />
                <span>Duration</span>
              </label>
              <select
                id="panel-duration"
                value={durationHours}
                onChange={(e) => onChangeDuration(Number(e.target.value))}
                className="mt-0.5 w-full bg-transparent font-mono text-sm font-semibold text-navy-950 focus:outline-none"
              >
                <option value={1}>1 Hour</option>
                <option value={2}>2 Hours</option>
                <option value={3}>3 Hours</option>
              </select>
            </div>
          </div>

          {/* Hourly Slots Grid */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">
                Hourly Slots for Court {courtNumber}
              </span>
              {slotsLoading && (
                <span className="inline-flex items-center gap-1 text-slate-500">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Loading</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-4 gap-1.5 max-h-36 overflow-y-auto pr-1">
              {daySlots.map((slot) => {
                const isSlotSelected = slot.startTime === startTime;
                const slotPast = slot.isPast || isPastManilaSlot(selectedDate, slot.startTime);
                const slotOpen = !slotPast && slot.status === 'available';

                return (
                  <button
                    key={slot.startTime}
                    type="button"
                    disabled={slotPast}
                    onClick={() => onChangeStartTime(slot.startTime)}
                    className={`min-h-[38px] px-2 py-1 rounded-md font-mono text-xs font-semibold tabular-nums border transition-colors ${
                      slotPast
                        ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed line-through'
                        : isSlotSelected && slotOpen
                          ? 'bg-green-600 text-white border-green-700'
                          : isSlotSelected
                            ? 'bg-red-600 text-white border-red-700'
                            : slotOpen
                              ? 'bg-blue-50 text-blue-900 border-blue-200 hover:bg-blue-100'
                              : slot.status === 'held'
                                ? 'bg-yellow-50 text-amber-900 border-yellow-300 hover:bg-yellow-100'
                                : slot.status === 'maintenance'
                                  ? 'bg-slate-100 text-slate-500 border-slate-200'
                                  : 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
                    }`}
                  >
                    {slot.startTime}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Server-Calculated Price Breakdown */}
          <div className="border-t border-slate-200 pt-4 space-y-2 text-sm">
            {quoteLoading ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Calculating server-side PHP quote...</span>
              </div>
            ) : quoteError ? (
              <p className="text-xs text-red-700">{quoteError}</p>
            ) : quote ? (
              <>
                <div className="flex items-center justify-between text-slate-600">
                  <span>
                    Hourly Rate {quote.isDevelopmentDefaultRates ? '(Dev Default)' : ''}
                  </span>
                  <span className="font-mono font-semibold text-navy-950 tabular-nums">
                    {formatCentavosPhp(quote.effectiveHourlyRateCentavos)} / hr
                  </span>
                </div>
                {quote.discountCentavos > 0 && (
                  <div className="flex items-center justify-between text-green-700 text-xs">
                    <span>Promotional Discount</span>
                    <span className="font-mono font-semibold tabular-nums">
                      -{formatCentavosPhp(quote.discountCentavos)}
                    </span>
                  </div>
                )}
                <div className="flex items-baseline justify-between pt-2 border-t border-slate-100">
                  <span className="font-bold text-navy-950">Total ({startTime}–{endTime})</span>
                  <span className="font-mono text-2xl font-bold text-navy-950 tabular-nums">
                    {formatCentavosPhp(quote.totalAmountCentavos)}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <button
            type="button"
            disabled={!isAvailable || quoteLoading || !quote}
            onClick={() => {
              setSubmitError(null);
              setStep('guest_form');
            }}
            className="w-full min-h-[48px] px-5 py-3 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2"
          >
            <span>
              {isAvailable ? 'Continue to Booking' : 'Select an Available (Blue) Slot'}
            </span>
            {isAvailable && <ArrowRight className="w-4 h-4" />}
          </button>
        </>
      ) : (
        /* Step 5-7: Guest Information Form -> Acquire Temporary 10-Min Hold */
        <form onSubmit={handleSubmitHold} className="space-y-4">
          <button
            type="button"
            onClick={() => setStep('inspect')}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-navy-700 hover:text-navy-950"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Court {courtNumber} schedule</span>
          </button>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 flex items-center justify-between text-xs">
            <div>
              <p className="font-bold text-navy-950">
                Court {courtNumber} · {selectedDate}
              </p>
              <p className="font-mono text-slate-600 tabular-nums">
                {startTime}–{endTime} PHT ({durationHours}h)
              </p>
            </div>
            <div className="font-mono text-base font-bold text-navy-950 tabular-nums">
              {quote ? formatCentavosPhp(quote.totalAmountCentavos) : '—'}
            </div>
          </div>

          <div>
            <label htmlFor="guest-name" className="block text-xs font-semibold text-slate-700 mb-1">
              Full Name
            </label>
            <input
              id="guest-name"
              type="text"
              required
              minLength={2}
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Juan Dela Cruz"
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>

          <div>
            <label htmlFor="guest-mobile" className="block text-xs font-semibold text-slate-700 mb-1">
              Mobile Number
            </label>
            <input
              id="guest-mobile"
              type="tel"
              required
              value={customerMobile}
              onChange={(e) => setCustomerMobile(e.target.value)}
              placeholder="+63 917 000 0000"
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>

          <div>
            <label htmlFor="guest-email" className="block text-xs font-semibold text-slate-700 mb-1">
              Email Address
            </label>
            <input
              id="guest-email"
              type="email"
              required
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="player@example.com"
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>

          <div>
            <label htmlFor="guest-notes" className="block text-xs font-semibold text-slate-700 mb-1">
              Special Requests (Optional)
            </label>
            <input
              id="guest-notes"
              type="text"
              maxLength={400}
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              placeholder="Paddle rental inquiry, group play note..."
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>

          {submitError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submittingHold}
            className="w-full min-h-[48px] px-5 py-3 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-2"
          >
            {submittingHold ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Locking 10-Min Reservation Hold...</span>
              </>
            ) : (
              <>
                <span>Lock Temporary Hold (Pending Payment)</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          <p className="text-[11px] text-slate-500 text-center">
            Creates a temporary 10-minute pending-payment reservation hold. Online payment gateway
            connects in Stage 5.
          </p>
        </form>
      )}
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block sticky top-20 bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        {panelBody}
      </aside>

      <div
        role="dialog"
        aria-label={`Court ${courtNumber} booking details`}
        className="lg:hidden fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-3xl border-t border-slate-200 shadow-2xl max-h-[68vh] flex flex-col"
      >
        <div className="pt-2.5 pb-1 shrink-0">
          <div className="w-10 h-1.5 bg-slate-300 rounded-full mx-auto" />
        </div>
        <div className="px-5 pb-6 pt-2 overflow-y-auto">{panelBody}</div>
      </div>
    </>
  );
};
