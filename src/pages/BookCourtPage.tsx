import React, { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { CourtSelectionPanel } from '../components/CourtSelectionPanel';
import { InteractiveCourtMap } from '../components/InteractiveCourtMap';
import { FACILITY_INFO } from '../config/facility';
import {
  formatEndTime,
  getAllCourtsIntervalStatus,
  SIMULATED_TIME_SLOTS,
} from '../data/mockStage2Availability';
import { CourtStatus } from '../types/booking';

export const BookCourtPage: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState('2026-11-23');
  const [startTime, setStartTime] = useState('18:00');
  const [durationHours, setDurationHours] = useState(1);

  const [selectedCourtNumber, setSelectedCourtNumber] = useState<number | null>(null);
  const [inspectedConflictCourtNumber, setInspectedConflictCourtNumber] = useState<number | null>(
    null,
  );
  const [bookingPreviewOpen, setBookingPreviewOpen] = useState(false);

  const courtStatuses = useMemo(
    () => getAllCourtsIntervalStatus(selectedDate, startTime, durationHours),
    [selectedDate, startTime, durationHours],
  );

  const statusCounts = useMemo(() => {
    const counts = { available: 0, booked: 0, held: 0, maintenance: 0 };
    for (const outcome of Object.values(courtStatuses)) {
      if (outcome.status === CourtStatus.AVAILABLE) counts.available += 1;
      else if (outcome.status === CourtStatus.BOOKED) counts.booked += 1;
      else if (outcome.status === CourtStatus.HELD) counts.held += 1;
      else if (outcome.status === CourtStatus.MAINTENANCE) counts.maintenance += 1;
    }
    return counts;
  }, [courtStatuses]);

  const revalidateSelectionForInterval = (
    nextDate: string,
    nextStart: string,
    nextDuration: number,
  ) => {
    setBookingPreviewOpen(false);
    const nextStatuses = getAllCourtsIntervalStatus(nextDate, nextStart, nextDuration);
    const activeCourt = selectedCourtNumber ?? inspectedConflictCourtNumber;
    if (activeCourt === null) return;

    const outcome = nextStatuses[activeCourt];
    if (outcome?.status === CourtStatus.AVAILABLE) {
      setSelectedCourtNumber(activeCourt);
      setInspectedConflictCourtNumber(null);
    } else {
      setSelectedCourtNumber(null);
      setInspectedConflictCourtNumber(activeCourt);
    }
  };

  const handleDateChange = (nextDate: string) => {
    setSelectedDate(nextDate);
    revalidateSelectionForInterval(nextDate, startTime, durationHours);
  };

  const handleStartTimeChange = (nextStart: string) => {
    setStartTime(nextStart);
    revalidateSelectionForInterval(selectedDate, nextStart, durationHours);
  };

  const handleDurationChange = (nextDuration: number) => {
    setDurationHours(nextDuration);
    revalidateSelectionForInterval(selectedDate, startTime, nextDuration);
  };

  const handleSelectCourt = (courtNumber: number) => {
    setBookingPreviewOpen(false);
    const outcome = courtStatuses[courtNumber];
    if (outcome?.status === CourtStatus.AVAILABLE) {
      setSelectedCourtNumber(courtNumber);
      setInspectedConflictCourtNumber(null);
    } else {
      setSelectedCourtNumber(null);
      setInspectedConflictCourtNumber(courtNumber);
    }
  };

  const handleClosePanel = () => {
    setSelectedCourtNumber(null);
    setInspectedConflictCourtNumber(null);
    setBookingPreviewOpen(false);
  };

  const activeCourtNumber = selectedCourtNumber ?? inspectedConflictCourtNumber;
  const activeOutcome = activeCourtNumber !== null ? courtStatuses[activeCourtNumber] : null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12 space-y-6">
      {/* Header & Schedule Selector Bar */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 border-b border-slate-200 pb-6">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-navy-700">
            <span>{FACILITY_INFO.fullTitle}</span>
            <span aria-hidden="true">·</span>
            <span>Interactive Floor Plan</span>
          </div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-navy-950 tracking-tight">
            Book a Pickleball Court
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 tabular-nums">
            <span className="font-semibold text-blue-700">
              {statusCounts.available} Available
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-red-700">{statusCounts.booked} Booked</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-amber-700">{statusCounts.held} Held</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-slate-600">
              {statusCounts.maintenance} Closed
            </span>
          </div>
        </div>

        {/* Step 1 & 2 Controls: Date, Start Time, Duration */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 shrink-0">
          <div>
            <label htmlFor="book-date" className="block text-xs font-medium text-slate-600 mb-1">
              1. Play Date ({FACILITY_INFO.timezone})
            </label>
            <input
              id="book-date"
              type="date"
              value={selectedDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-navy-700"
            />
          </div>

          <div>
            <label htmlFor="book-time" className="block text-xs font-medium text-slate-600 mb-1">
              2. Start Time
            </label>
            <select
              id="book-time"
              value={startTime}
              onChange={(e) => handleStartTimeChange(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-navy-700"
            >
              {SIMULATED_TIME_SLOTS.map((slot) => (
                <option key={slot} value={slot}>
                  {slot} PHT
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="book-dur" className="block text-xs font-medium text-slate-600 mb-1">
              3. Duration ({startTime}–{formatEndTime(startTime, durationHours)})
            </label>
            <select
              id="book-dur"
              value={durationHours}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-navy-700"
            >
              <option value={1}>1 Hour</option>
              <option value={2}>2 Hours</option>
              <option value={3}>3 Hours</option>
            </select>
          </div>
        </div>
      </div>

      {/* Explicit Stage 2 Simulated Data Notice */}
      <div className="rounded-xl border border-amber-300 bg-amber-50/80 px-4 py-3 flex items-start gap-3 text-xs text-amber-950">
        <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
        <p>
          <span className="font-bold">Simulated Stage 2 Availability:</span> Court statuses and PHP
          estimates below are deterministic mock data for floor-plan testing. Live Supabase
          availability, hold locking, and HitPay checkout will connect in Stages 3–5.
        </p>
      </div>

      {/* Main Split Workspace: Architectural Floor Plan + Responsive Booking Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7">
          <InteractiveCourtMap
            courtStatuses={courtStatuses}
            selectedCourtNumber={selectedCourtNumber}
            inspectedConflictCourtNumber={inspectedConflictCourtNumber}
            onSelectCourt={handleSelectCourt}
          />
        </div>

        <div className="lg:col-span-5">
          <CourtSelectionPanel
            courtNumber={activeCourtNumber}
            courtOutcome={activeOutcome}
            selectedDate={selectedDate}
            startTime={startTime}
            durationHours={durationHours}
            isSelectedForBooking={selectedCourtNumber !== null}
            bookingPreviewOpen={bookingPreviewOpen}
            onChangeStartTime={handleStartTimeChange}
            onChangeDuration={handleDurationChange}
            onProceedToBooking={() => setBookingPreviewOpen(true)}
            onResetPreview={() => setBookingPreviewOpen(false)}
            onClosePanel={handleClosePanel}
          />
        </div>
      </div>
    </div>
  );
};
