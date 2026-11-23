import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Info, Loader2, RefreshCw } from 'lucide-react';
import { CourtSelectionPanel } from '../components/CourtSelectionPanel';
import { InteractiveCourtMap } from '../components/InteractiveCourtMap';
import { FACILITY_INFO } from '../config/facility';
import {
  formatEndTime,
  SIMULATED_TIME_SLOTS,
  SimulatedSlotOutcome,
} from '../data/mockStage2Availability';
import {
  addDaysToManilaDate,
  getInitialManilaSchedule,
  getManilaTodayDateString,
  isPastManilaDate,
  isPastManilaSlot,
} from '../lib/manilaTime';
import {
  AvailabilityCourtItem,
  AvailabilityDiagnosticError,
  AvailabilityDiagnosticKind,
  fetchIntervalAvailability,
  subscribeToAvailabilityRealtime,
} from '../services/bookingApi';
import { CourtStatus } from '../types/booking';

const MAX_ADVANCE_DAYS = 30;

function mapApiStatusToEnum(
  status: AvailabilityCourtItem['status'],
): Exclude<CourtStatus, CourtStatus.SELECTED> {
  switch (status) {
    case 'booked':
      return CourtStatus.BOOKED;
    case 'held':
      return CourtStatus.HELD;
    case 'maintenance':
      return CourtStatus.MAINTENANCE;
    default:
      return CourtStatus.AVAILABLE;
  }
}

function getDiagnosticTitle(kind: AvailabilityDiagnosticKind): string {
  switch (kind) {
    case 'missing_credentials':
      return 'Missing Supabase Credentials (Simulated Stage 2 Preview)';
    case 'invalid_credentials':
      return 'Invalid or Incomplete Supabase Credentials';
    case 'undeployed_functions':
      return 'Supabase Edge Functions Not Deployed';
    case 'database_schema_error':
      return 'Database Schema / Migrations Not Applied';
    case 'network_error':
      return 'Live Connection / Network Failure';
  }
}

export const BookCourtPage: React.FC = () => {
  const initialSchedule = useMemo(() => getInitialManilaSchedule(), []);
  const todayManila = useMemo(() => getManilaTodayDateString(), []);
  const maxDateManila = useMemo(
    () => addDaysToManilaDate(todayManila, MAX_ADVANCE_DAYS),
    [todayManila],
  );

  const [selectedDate, setSelectedDate] = useState(initialSchedule.date);
  const [startTime, setStartTime] = useState(initialSchedule.startTime);
  const [durationHours, setDurationHours] = useState(1);

  const [selectedCourtNumber, setSelectedCourtNumber] = useState<number | null>(null);
  const [inspectedConflictCourtNumber, setInspectedConflictCourtNumber] = useState<number | null>(
    null,
  );

  const [availabilitySource, setAvailabilitySource] = useState<
    'supabase_live' | 'simulated_stage2_fallback' | null
  >(null);
  const [courtStatuses, setCourtStatuses] = useState<Record<number, SimulatedSlotOutcome>>({});
  const [loadingAvailability, setLoadingAvailability] = useState(true);
  const [availabilityDiagnostic, setAvailabilityDiagnostic] = useState<{
    kind: AvailabilityDiagnosticKind;
    message: string;
  } | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  // Fetch availability with stale-request cancellation (AbortController)
  useEffect(() => {
    const controller = new AbortController();
    setLoadingAvailability(true);
    setAvailabilityDiagnostic(null);

    fetchIntervalAvailability(
      {
        date: selectedDate,
        startTime,
        durationMinutes: durationHours * 60,
      },
      controller.signal,
    )
      .then((res) => {
        setAvailabilitySource(res.source);
        if (res.source === 'simulated_stage2_fallback') {
          setAvailabilityDiagnostic({
            kind: 'missing_credentials',
            message:
              'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not configured yet. Showing Stage 2 simulated availability only; live guest holds require Supabase.',
          });
        } else {
          setAvailabilityDiagnostic(null);
        }

        const map: Record<number, SimulatedSlotOutcome> = {};
        for (const item of res.courts) {
          map[item.courtNumber] = {
            courtNumber: item.courtNumber,
            status: mapApiStatusToEnum(item.status),
            reason: item.reason,
          };
        }
        setCourtStatuses(map);

        // Revalidate currently active court against fresh server response
        setSelectedCourtNumber((prevSelected) => {
          if (prevSelected === null) return null;
          if (map[prevSelected]?.status === CourtStatus.AVAILABLE) return prevSelected;
          setInspectedConflictCourtNumber(prevSelected);
          return null;
        });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Never silently fall back to simulated availability when a configured connection fails
        setAvailabilitySource(null);
        setCourtStatuses({});
        setSelectedCourtNumber(null);
        setInspectedConflictCourtNumber(null);

        if (err instanceof AvailabilityDiagnosticError) {
          setAvailabilityDiagnostic({ kind: err.kind, message: err.message });
        } else {
          setAvailabilityDiagnostic({
            kind: 'network_error',
            message: err instanceof Error ? err.message : 'Unable to check court availability.',
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingAvailability(false);
        }
      });

    return () => controller.abort();
  }, [selectedDate, startTime, durationHours, refreshTick]);

  // Automatic 30s refresh + Supabase Realtime listener
  useEffect(() => {
    const unsubscribe = subscribeToAvailabilityRealtime(triggerRefresh);
    const intervalId = window.setInterval(triggerRefresh, 30_000);
    return () => {
      unsubscribe();
      window.clearInterval(intervalId);
    };
  }, [triggerRefresh]);

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

  const handleDateChange = (nextDate: string) => {
    if (!nextDate) return;
    if (isPastManilaDate(nextDate)) {
      setScheduleNotice('Past dates are not bookable in Asia/Manila time.');
      return;
    }
    if (nextDate > maxDateManila) {
      setScheduleNotice(`Bookings are limited to ${MAX_ADVANCE_DAYS} days in advance.`);
      return;
    }
    setScheduleNotice(null);
    setSelectedDate(nextDate);
    // If switching to today and selected startTime has passed, bump to next open slot
    if (nextDate === todayManila && isPastManilaSlot(nextDate, startTime)) {
      const nextOpen = SIMULATED_TIME_SLOTS.find((s) => !isPastManilaSlot(nextDate, s));
      if (nextOpen) setStartTime(nextOpen);
    }
  };

  const handleStartTimeChange = (nextStart: string) => {
    if (isPastManilaSlot(selectedDate, nextStart)) {
      setScheduleNotice('Cannot select a start time that has already passed.');
      return;
    }
    setScheduleNotice(null);
    setStartTime(nextStart);
  };

  const handleSelectCourt = (courtNumber: number) => {
    const outcome = courtStatuses[courtNumber];
    if (!outcome) return;
    if (outcome.status === CourtStatus.AVAILABLE) {
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
  };

  const activeCourtNumber = selectedCourtNumber ?? inspectedConflictCourtNumber;
  const activeOutcome = activeCourtNumber !== null ? courtStatuses[activeCourtNumber] ?? null : null;

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
            <button
              type="button"
              onClick={triggerRefresh}
              disabled={loadingAvailability}
              className="inline-flex items-center gap-1 text-navy-700 hover:text-navy-950 font-semibold ml-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingAvailability ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
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
              min={todayManila}
              max={maxDateManila}
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
              {SIMULATED_TIME_SLOTS.map((slot) => {
                const isPast = isPastManilaSlot(selectedDate, slot);
                return (
                  <option key={slot} value={slot} disabled={isPast}>
                    {slot} PHT{isPast ? ' (Past)' : ''}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label htmlFor="book-dur" className="block text-xs font-medium text-slate-600 mb-1">
              3. Duration ({startTime}–{formatEndTime(startTime, durationHours)})
            </label>
            <select
              id="book-dur"
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 bg-white text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-navy-700"
            >
              <option value={1}>1 Hour</option>
              <option value={2}>2 Hours</option>
              <option value={3}>3 Hours</option>
            </select>
          </div>
        </div>
      </div>

      {/* Schedule Input Validation Notice */}
      {scheduleNotice && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-amber-950">
          <span>{scheduleNotice}</span>
          <button
            type="button"
            onClick={() => setScheduleNotice(null)}
            className="font-semibold underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Availability Source Banner or Categorized Diagnostic Alert */}
      {availabilityDiagnostic ? (
        availabilityDiagnostic.kind === 'missing_credentials' ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50/80 px-4 py-3 flex items-start gap-3 text-xs text-amber-950">
            <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <p>
              <span className="font-bold">{getDiagnosticTitle('missing_credentials')}:</span>{' '}
              {availabilityDiagnostic.message}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 flex items-center justify-between gap-3 text-xs text-red-950">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-bold">{getDiagnosticTitle(availabilityDiagnostic.kind)}</p>
                <p>{availabilityDiagnostic.message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={triggerRefresh}
              className="min-h-[36px] px-3 rounded-md bg-red-700 text-white font-semibold hover:bg-red-800 shrink-0"
            >
              Retry
            </button>
          </div>
        )
      ) : null}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 relative">
          {loadingAvailability && Object.keys(courtStatuses).length === 0 && (
            <div className="flex items-center justify-center py-12 text-sm text-slate-600 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Checking court availability...</span>
            </div>
          )}
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
            availabilitySource={availabilitySource}
            selectedDate={selectedDate}
            startTime={startTime}
            durationHours={durationHours}
            isSelectedForBooking={selectedCourtNumber !== null}
            onChangeStartTime={handleStartTimeChange}
            onChangeDuration={setDurationHours}
            onRefreshAvailability={triggerRefresh}
            onClosePanel={handleClosePanel}
          />
        </div>
      </div>
    </div>
  );
};
