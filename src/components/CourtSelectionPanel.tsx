import React from 'react';
import { AlertCircle, ArrowRight, Calendar, CheckCircle2, Clock, Info, X } from 'lucide-react';
import { COURT_MAP_REGIONS, getZoneLabel } from '../config/courtMapRegions';
import { COURT_STATUS_LEGEND, FACILITY_INFO } from '../config/facility';
import {
  calculateSimulatedMockPrice,
  formatEndTime,
  formatPhp,
  getSimulatedDayScheduleForCourt,
  SimulatedSlotOutcome,
} from '../data/mockStage2Availability';
import { CourtStatus } from '../types/booking';

interface CourtSelectionPanelProps {
  courtNumber: number | null;
  courtOutcome: SimulatedSlotOutcome | null;
  selectedDate: string;
  startTime: string;
  durationHours: number;
  isSelectedForBooking: boolean;
  bookingPreviewOpen: boolean;
  onChangeStartTime: (nextTime: string) => void;
  onChangeDuration: (hours: number) => void;
  onProceedToBooking: () => void;
  onResetPreview: () => void;
  onClosePanel: () => void;
}

export const CourtSelectionPanel: React.FC<CourtSelectionPanelProps> = ({
  courtNumber,
  courtOutcome,
  selectedDate,
  startTime,
  durationHours,
  isSelectedForBooking,
  bookingPreviewOpen,
  onChangeStartTime,
  onChangeDuration,
  onProceedToBooking,
  onResetPreview,
  onClosePanel,
}) => {
  if (courtNumber === null || !courtOutcome) {
    return (
      <div className="hidden lg:block bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <p className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
          Stage 2 Court Inspector
        </p>
        <h2 className="font-display text-2xl font-bold text-navy-950">
          Select a Court on the Floor Plan
        </h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          Tap any blue court on the Astoria Regency architectural plan to view available time
          slots, simulated PHP pricing, and reservation details. Tapping a booked, held, or
          maintenance court explains the schedule conflict.
        </p>
        <div className="pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
          <p>
            Current Interval:{' '}
            <span className="font-mono font-semibold text-navy-900 tabular-nums">
              {selectedDate} · {startTime}–{formatEndTime(startTime, durationHours)} PHT
            </span>
          </p>
          <p>Stage 2 uses deterministic simulated availability until Supabase connects in Stage 3–4.</p>
        </div>
      </div>
    );
  }

  const region = COURT_MAP_REGIONS.find((c) => c.courtNumber === courtNumber);
  const zoneTitle = region ? getZoneLabel(region.zone) : 'Astoria Regency';
  const daySchedule = getSimulatedDayScheduleForCourt(courtNumber, selectedDate);
  const pricing = calculateSimulatedMockPrice(selectedDate, startTime, durationHours);
  const endTime = formatEndTime(startTime, durationHours);
  const isAvailable = courtOutcome.status === CourtStatus.AVAILABLE;
  const statusLegend = COURT_STATUS_LEGEND.find((l) => l.status === courtOutcome.status);

  const panelBody = (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-navy-700">
            <span>{zoneTitle}</span>
            <span aria-hidden="true">·</span>
            <span>Simulated Stage 2 Data</span>
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

      {/* Status Notice */}
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
              Pick an open blue slot below for Court {courtNumber}, or tap another blue court on
              the floor plan.
            </p>
          </div>
        </div>
      )}

      {/* Selected Date & Duration Controls */}
      <div className="grid grid-cols-2 gap-3 pt-1">
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

      {/* Available Time Slots for this Court on Selected Date */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-700">
            Hourly Slots for Court {courtNumber}
          </span>
          <span className="text-slate-500">Tap an open slot to switch time</span>
        </div>

        <div className="grid grid-cols-4 gap-1.5 max-h-36 overflow-y-auto pr-1">
          {daySchedule.map((slot) => {
            const isSlotSelected = slot.startTime === startTime;
            const slotOpen = slot.status === CourtStatus.AVAILABLE;

            return (
              <button
                key={slot.startTime}
                type="button"
                onClick={() => onChangeStartTime(slot.startTime)}
                className={`min-h-[38px] px-2 py-1 rounded-md font-mono text-xs font-semibold tabular-nums border transition-colors ${
                  isSlotSelected && slotOpen
                    ? 'bg-green-600 text-white border-green-700'
                    : isSlotSelected
                      ? 'bg-red-600 text-white border-red-700'
                      : slotOpen
                        ? 'bg-blue-50 text-blue-900 border-blue-200 hover:bg-blue-100'
                        : slot.status === CourtStatus.HELD
                          ? 'bg-yellow-50 text-amber-900 border-yellow-300 hover:bg-yellow-100'
                          : slot.status === CourtStatus.MAINTENANCE
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

      {/* Mock Price Breakdown */}
      <div className="border-t border-slate-200 pt-4 space-y-2 text-sm">
        <div className="flex items-center justify-between text-slate-600">
          <span>Mock Hourly Rate</span>
          <span className="font-mono font-semibold text-navy-950 tabular-nums">
            {formatPhp(pricing.hourlyRatePhp)} / hr
          </span>
        </div>
        <div className="flex items-center justify-between text-slate-600">
          <span>
            Session ({startTime}–{endTime} · {durationHours}h)
          </span>
          <span className="text-xs text-slate-500">{pricing.rateLabel}</span>
        </div>
        <div className="flex items-baseline justify-between pt-2 border-t border-slate-100">
          <span className="font-bold text-navy-950">Estimated Mock Total</span>
          <span className="font-mono text-2xl font-bold text-navy-950 tabular-nums">
            {formatPhp(pricing.totalPhp)}
          </span>
        </div>
      </div>

      {/* Primary Action */}
      {bookingPreviewOpen && isAvailable ? (
        <div className="rounded-xl bg-navy-950 text-white p-4 space-y-3 text-xs">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-lime-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-sm text-white">
                Stage 2 Selection Verified (Preview Only)
              </p>
              <p className="text-slate-300 leading-relaxed">
                Court {courtNumber} on {selectedDate} ({startTime}–{endTime} PHT,{' '}
                {formatPhp(pricing.totalPhp)}) is ready. Customer details, temporary hold creation,
                and HitPay checkout activate in Stages 4–5.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onResetPreview}
            className="w-full min-h-[40px] rounded-lg border border-navy-700 text-slate-200 hover:bg-navy-900 font-semibold transition-colors"
          >
            Change Selection
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!isAvailable}
          onClick={onProceedToBooking}
          className="w-full min-h-[48px] px-5 py-3 rounded-lg bg-lime-400 text-navy-950 text-sm font-bold hover:bg-lime-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2"
        >
          <span>
            {isAvailable ? 'Continue to Booking' : 'Select an Available (Blue) Slot'}
          </span>
          {isAvailable && <ArrowRight className="w-4 h-4" />}
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop Sticky Side Panel */}
      <aside className="hidden lg:block sticky top-20 bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        {panelBody}
      </aside>

      {/* Mobile Bottom Sheet (leaves top of viewport open so the floor plan stays visible) */}
      <div
        role="dialog"
        aria-label={`Court ${courtNumber} booking details`}
        className="lg:hidden fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-3xl border-t border-slate-200 shadow-2xl max-h-[62vh] flex flex-col"
      >
        <div className="pt-2.5 pb-1 shrink-0">
          <div className="w-10 h-1.5 bg-slate-300 rounded-full mx-auto" />
        </div>
        <div className="px-5 pb-6 pt-2 overflow-y-auto">{panelBody}</div>
      </div>
    </>
  );
};
