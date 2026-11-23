import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock,
  CreditCard,
  Lock,
  LogOut,
  Plus,
  QrCode,
  RefreshCw,
  Shield,
  Tag,
  Users,
  Wrench,
} from 'lucide-react';
import { FACILITY_INFO, SITE_ROUTES } from '../config/facility';
import { STAGE5_HITPAY_PLAN } from '../lib/hitpayPlan';
import {
  getManilaTodayDateString,
  manilaDateTimeToUtcIso,
  utcIsoToManilaDateAndTime,
} from '../lib/manilaTime';
import { parseQrCheckInInput } from '../lib/qrCheckIn';
import { diagnoseBrowserSupabaseConfig } from '../lib/supabaseClient';
import {
  canPerformStaffAction,
  getCurrentStaffSession,
  signInStaffWithPassword,
  signOutStaff,
  STAFF_ROLE_LABELS,
  StaffSessionContext,
  superAdminListStaffProfiles,
  superAdminUpdateStaffProfile,
} from '../services/adminAuth';
import {
  adminCancelReservationRequest,
  adminCreateMaintenanceBlockRequest,
  adminCreatePricingRuleRequest,
  adminCreateWalkInBooking,
  adminDeactivateMaintenanceBlockRequest,
  adminFetchAuditLogs,
  adminFetchMaintenanceBlocks,
  adminFetchOperatingHours,
  adminFetchPricingConfig,
  adminFetchReservations,
  adminRevokeQrCheckIn,
  adminUpdatePricingRequest,
  adminUpsertOperatingHourRequest,
  adminVerifyQrCheckIn,
  CreateGuestHoldResponse,
  formatCentavosPhp,
  QrCheckInVerifyResponse,
} from '../services/bookingApi';
import { sanitizePricingRuleDisplayName } from '../services/facilityConfigApi';
import type {
  OperatingHourRow,
  PricingRuleRow,
  StaffProfileRow,
  StaffRoleDb,
} from '../types/database';

type AdminTab =
  | 'reservations'
  | 'walk-in'
  | 'check-in'
  | 'pricing'
  | 'operating-hours'
  | 'maintenance'
  | 'audit-logs'
  | 'staff';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface AdminReservationItem {
  id: string;
  booking_reference: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  total_amount_centavos: number;
  status: string;
  source: string;
  special_requests?: string | null;
  cancellation_reason?: string | null;
  courts?: { court_number: number; name: string } | null;
  customers?: { full_name: string } | null;
}

interface AdminCourtRateRow {
  id: string;
  court_number: number;
  name: string;
  base_hourly_rate_centavos: number;
  status: string;
}

interface AdminMaintenanceRow {
  id: string;
  court_id: string;
  start_at: string;
  end_at: string;
  reason: string;
  is_active: boolean;
  courts?: { court_number: number; name: string } | null;
}

interface AdminAuditLogRow {
  id: string;
  reservation_id: string | null;
  actor_type: string;
  actor_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

function resolveTabFromPath(pathname: string): AdminTab {
  if (pathname === '/admin/dashboard' || pathname.startsWith('/admin/dashboard/')) {
    return 'reservations';
  }
  if (pathname.startsWith('/admin/walk-in')) return 'walk-in';
  if (pathname.startsWith('/admin/check-in')) return 'check-in';
  if (pathname.startsWith('/admin/pricing')) return 'pricing';
  if (pathname.startsWith('/admin/operating-hours')) return 'operating-hours';
  if (pathname.startsWith('/admin/maintenance')) return 'maintenance';
  if (pathname.startsWith('/admin/audit-logs')) return 'audit-logs';
  if (pathname.startsWith('/admin/staff')) return 'staff';
  return 'reservations';
}

function tabToPath(tab: AdminTab): string {
  return tab === 'reservations' ? '/admin' : `/admin/${tab}`;
}

export const AdminLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [checkingSession, setCheckingSession] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browserDiag = useMemo(() => diagnoseBrowserSupabaseConfig(), []);

  useEffect(() => {
    let mounted = true;
    getCurrentStaffSession()
      .then((session) => {
        if (mounted && session) {
          navigate(SITE_ROUTES.adminDashboard, { replace: true });
        }
      })
      .finally(() => {
        if (mounted) setCheckingSession(false);
      });
    return () => {
      mounted = false;
    };
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signInStaffWithPassword(email, password);
      navigate(SITE_ROUTES.adminDashboard, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to authenticate staff account.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 py-14 lg:py-20">
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-navy-700 uppercase">
            <Lock className="w-3.5 h-3.5" />
            <span>Staff Portal · Astoria Regency</span>
          </div>
          <h1 className="font-display text-3xl font-bold text-navy-950">Administrator Login</h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            Sign in with your Supabase Auth staff account (Super Admin · Manager · Reception Staff).
          </p>
        </div>

        {!browserDiag.configured && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 space-y-1">
            <p className="font-bold">Supabase Browser Credentials Missing in Preview</p>
            <p>{browserDiag.message}</p>
          </div>
        )}

        {checkingSession ? (
          <p className="text-xs text-slate-500 py-4">Checking active staff session...</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="staff-email" className="block text-sm font-medium text-slate-700 mb-1">
                Staff Email
              </label>
              <input
                id="staff-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="manager@pickmyball.ph"
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
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full min-h-[44px] px-3.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-navy-700"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !browserDiag.configured}
              className="w-full min-h-[44px] rounded-lg bg-navy-950 text-white text-sm font-semibold hover:bg-navy-800 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Verifying Staff Role...' : 'Sign In'}
            </button>
          </form>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1.5">
          <p className="font-semibold text-slate-700">Role Access Summary</p>
          <p>Super Admin: Full facility, pricing, hours, logs, and staff role assignment.</p>
          <p>Manager: Reservations, pricing rates, operating hours, maintenance, audit logs.</p>
          <p>Reception Staff: Reservations lookup, walk-in holds, QR check-in verification.</p>
        </div>
      </div>
    </div>
  );
};

export const AdminDashboardPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = resolveTabFromPath(location.pathname);

  const [session, setSession] = useState<StaffSessionContext | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Data states
  const [dateFilter, setDateFilter] = useState(getManilaTodayDateString());
  const [statusFilter, setStatusFilter] = useState('');
  const [reservations, setReservations] = useState<AdminReservationItem[]>([]);
  const [loadingReservations, setLoadingReservations] = useState(false);

  const [courts, setCourts] = useState<AdminCourtRateRow[]>([]);
  const [pricingRules, setPricingRules] = useState<PricingRuleRow[]>([]);
  const [operatingHours, setOperatingHours] = useState<OperatingHourRow[]>([]);
  const [maintenanceBlocks, setMaintenanceBlocks] = useState<AdminMaintenanceRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogRow[]>([]);
  const [staffProfiles, setStaffProfiles] = useState<StaffProfileRow[]>([]);

  // Court rate input map (PHP string for crisp editing, saved in centavos)
  const [rateDraftPhp, setRateDraftPhp] = useState<Record<number, string>>({});

  // New pricing rule form
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleType, setNewRuleType] = useState<'standard' | 'weekend' | 'peak' | 'promo'>('standard');
  const [newRuleDayScope, setNewRuleDayScope] = useState<'all' | 'weekday' | 'weekend'>('weekday');
  const [newRuleStart, setNewRuleStart] = useState('06:00');
  const [newRuleEnd, setNewRuleEnd] = useState('17:00');
  const [newRuleRatePhp, setNewRuleRatePhp] = useState('');
  const [newRuleDiscountPct, setNewRuleDiscountPct] = useState('0');
  const [newRulePriority, setNewRulePriority] = useState('10');

  // Operating hour form
  const [editDayOfWeek, setEditDayOfWeek] = useState<string>('1');
  const [overrideDate, setOverrideDate] = useState('');
  const [openTimeInput, setOpenTimeInput] = useState('06:00');
  const [closeTimeInput, setCloseTimeInput] = useState('22:00');
  const [isClosedInput, setIsClosedInput] = useState(false);
  const [hoursNotesInput, setHoursNotesInput] = useState('');

  // Maintenance form
  const [maintCourt, setMaintCourt] = useState('1');
  const [maintDate, setMaintDate] = useState(getManilaTodayDateString());
  const [maintStartTime, setMaintStartTime] = useState('06:00');
  const [maintEndTime, setMaintEndTime] = useState('08:00');
  const [maintReason, setMaintReason] = useState('');

  // Walk-in form
  const [walkInCourt, setWalkInCourt] = useState('1');
  const [walkInDate, setWalkInDate] = useState(getManilaTodayDateString());
  const [walkInTime, setWalkInTime] = useState('08:00');
  const [walkInDuration, setWalkInDuration] = useState('60');
  const [walkInName, setWalkInName] = useState('');
  const [walkInMobile, setWalkInMobile] = useState('');
  const [walkInEmail, setWalkInEmail] = useState('');
  const [walkInResult, setWalkInResult] = useState<CreateGuestHoldResponse | null>(null);

  // Server-signed QR Check-In verifier & revoker
  const [qrScanInput, setQrScanInput] = useState('');
  const [qrConsumeOnVerify, setQrConsumeOnVerify] = useState(true);
  const [qrVerifying, setQrVerifying] = useState(false);
  const [qrVerifyResult, setQrVerifyResult] = useState<{
    eligible: boolean;
    message: string;
    details?: QrCheckInVerifyResponse;
  } | null>(null);
  const [revokeTargetInput, setRevokeTargetInput] = useState('');
  const [revokeReasonInput, setRevokeReasonInput] = useState('');
  const [revokePermanent, setRevokePermanent] = useState(false);
  const [revokingQr, setRevokingQr] = useState(false);

  useEffect(() => {
    let active = true;
    getCurrentStaffSession()
      .then((sess) => {
        if (!active) return;
        if (!sess) {
          navigate(SITE_ROUTES.adminLogin, { replace: true });
          return;
        }
        setSession(sess);
      })
      .finally(() => {
        if (active) setLoadingSession(false);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  const role: StaffRoleDb | null = session?.profile.role ?? null;

  const loadReservations = useCallback(async () => {
    if (!session) return;
    setLoadingReservations(true);
    setGlobalError(null);
    try {
      const res = await adminFetchReservations(session.accessToken, {
        date: dateFilter || undefined,
        status: statusFilter || undefined,
      });
      setReservations((res.reservations ?? []) as AdminReservationItem[]);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to fetch reservations.');
    } finally {
      setLoadingReservations(false);
    }
  }, [session, dateFilter, statusFilter]);

  const loadPricing = useCallback(async () => {
    if (!session || !canPerformStaffAction(session.profile.role, 'managePricing')) return;
    setGlobalError(null);
    try {
      const res = await adminFetchPricingConfig(session.accessToken);
      const courtRows = (res.courts ?? []) as AdminCourtRateRow[];
      setCourts(courtRows);
      setPricingRules((res.pricingRules ?? []) as PricingRuleRow[]);
      const drafts: Record<number, string> = {};
      for (const c of courtRows) {
        drafts[c.court_number] = (c.base_hourly_rate_centavos / 100).toFixed(2);
      }
      setRateDraftPhp(drafts);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to fetch pricing configuration.');
    }
  }, [session]);

  const loadOperatingHours = useCallback(async () => {
    if (!session || !canPerformStaffAction(session.profile.role, 'manageOperatingHours')) return;
    setGlobalError(null);
    try {
      const res = await adminFetchOperatingHours(session.accessToken);
      setOperatingHours((res.operatingHours ?? []) as OperatingHourRow[]);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to load operating hours.');
    }
  }, [session]);

  const loadMaintenance = useCallback(async () => {
    if (!session) return;
    setGlobalError(null);
    try {
      const res = await adminFetchMaintenanceBlocks(session.accessToken);
      setMaintenanceBlocks((res.maintenanceBlocks ?? []) as AdminMaintenanceRow[]);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to load maintenance blocks.');
    }
  }, [session]);

  const loadAuditLogs = useCallback(async () => {
    if (!session || !canPerformStaffAction(session.profile.role, 'viewAuditLogs')) return;
    setGlobalError(null);
    try {
      const res = await adminFetchAuditLogs(session.accessToken, { limit: 60 });
      setAuditLogs((res.auditLogs ?? []) as AdminAuditLogRow[]);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to load audit logs.');
    }
  }, [session]);

  const loadStaff = useCallback(async () => {
    if (!session || !canPerformStaffAction(session.profile.role, 'manageStaffProfiles')) return;
    setGlobalError(null);
    try {
      const rows = await superAdminListStaffProfiles();
      setStaffProfiles(rows);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to load staff profiles.');
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    if (activeTab === 'reservations' || activeTab === 'check-in') loadReservations();
    if (activeTab === 'pricing') loadPricing();
    if (activeTab === 'operating-hours') loadOperatingHours();
    if (activeTab === 'maintenance') loadMaintenance();
    if (activeTab === 'audit-logs') loadAuditLogs();
    if (activeTab === 'staff') loadStaff();
  }, [
    session,
    activeTab,
    loadReservations,
    loadPricing,
    loadOperatingHours,
    loadMaintenance,
    loadAuditLogs,
    loadStaff,
  ]);

  const handleSignOut = async () => {
    await signOutStaff();
    navigate(SITE_ROUTES.adminLogin, { replace: true });
  };

  const handleCancelReservation = async (row: AdminReservationItem) => {
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);
    if (row.status === 'confirmed' && !canPerformStaffAction(session.profile.role, 'cancelConfirmedReservation')) {
      setGlobalError('Manager or Super Admin permission is required to cancel confirmed reservations.');
      return;
    }
    try {
      await adminCancelReservationRequest(session.accessToken, {
        bookingReference: row.booking_reference,
        reason: `Cancelled by ${STAFF_ROLE_LABELS[session.profile.role]} (${session.profile.full_name})`,
      });
      setActionFeedback(`Cancelled reservation ${row.booking_reference}.`);
      loadReservations();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to cancel reservation.');
    }
  };

  const handleSaveCourtRate = async (courtNumber: number) => {
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);
    const parsedPhp = Number(rateDraftPhp[courtNumber]);
    if (!Number.isFinite(parsedPhp) || parsedPhp < 10) {
      setGlobalError('Enter a valid hourly rate of at least ₱10.00.');
      return;
    }
    const centavos = Math.round(parsedPhp * 100);
    try {
      await adminUpdatePricingRequest(session.accessToken, {
        target: 'court_base_rate',
        courtNumber,
        baseHourlyRateCentavos: centavos,
      });
      setActionFeedback(`Updated Court ${courtNumber} base rate to ${formatCentavosPhp(centavos)}/hr.`);
      loadPricing();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to save court rate.');
    }
  };

  const handleTogglePricingRule = async (rule: PricingRuleRow) => {
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);
    try {
      await adminUpdatePricingRequest(session.accessToken, {
        target: 'pricing_rule',
        ruleId: rule.id,
        isActive: !rule.is_active,
      });
      setActionFeedback(
        `${sanitizePricingRuleDisplayName(rule.name)} is now ${!rule.is_active ? 'active' : 'inactive'}.`,
      );
      loadPricing();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to update pricing rule.');
    }
  };

  const handleRenameRuleFromLegacy = async (rule: PricingRuleRow) => {
    if (!session) return;
    const cleanName = sanitizePricingRuleDisplayName(rule.name);
    if (cleanName === rule.name) return;
    try {
      await adminUpdatePricingRequest(session.accessToken, {
        target: 'pricing_rule',
        ruleId: rule.id,
        name: cleanName,
      });
      setActionFeedback(`Renamed rule to "${cleanName}".`);
      loadPricing();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to rename pricing rule.');
    }
  };

  const handleCreatePricingRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);

    const rateCentavos =
      newRuleType !== 'promo' && newRuleRatePhp.trim()
        ? Math.round(Number(newRuleRatePhp) * 100)
        : null;

    try {
      await adminCreatePricingRuleRequest(session.accessToken, {
        name: newRuleName.trim(),
        ruleType: newRuleType,
        dayScope: newRuleDayScope,
        startTime: newRuleStart || null,
        endTime: newRuleEnd || null,
        rateCentavos,
        discountPercent: Number(newRuleDiscountPct) || 0,
        priority: Number(newRulePriority) || 10,
        isActive: true,
      });
      setNewRuleName('');
      setNewRuleRatePhp('');
      setActionFeedback('Created new facility pricing rule.');
      loadPricing();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to create pricing rule.');
    }
  };

  const handleSaveOperatingHour = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);

    const payload = overrideDate.trim()
      ? {
          overrideDate: overrideDate.trim(),
          openTime: openTimeInput,
          closeTime: closeTimeInput,
          isClosed: isClosedInput,
          notes: hoursNotesInput.trim() || null,
        }
      : {
          dayOfWeek: Number(editDayOfWeek),
          openTime: openTimeInput,
          closeTime: closeTimeInput,
          isClosed: isClosedInput,
          notes: hoursNotesInput.trim() || null,
        };

    try {
      await adminUpsertOperatingHourRequest(session.accessToken, payload);
      setActionFeedback('Saved facility operating schedule in Asia/Manila time.');
      setOverrideDate('');
      setHoursNotesInput('');
      loadOperatingHours();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to update operating hours.');
    }
  };

  const handleCreateMaintenance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);
    try {
      await adminCreateMaintenanceBlockRequest(session.accessToken, {
        courtNumber: Number(maintCourt),
        startAtIso: manilaDateTimeToUtcIso(maintDate, maintStartTime),
        endAtIso: manilaDateTimeToUtcIso(maintDate, maintEndTime),
        reason: maintReason.trim(),
      });
      setMaintReason('');
      setActionFeedback(`Blocked Court ${maintCourt} for maintenance.`);
      loadMaintenance();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to create maintenance block.');
    }
  };

  const handleDeactivateMaintenance = async (id: string) => {
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);
    try {
      await adminDeactivateMaintenanceBlockRequest(session.accessToken, id);
      setActionFeedback('Maintenance block deactivated.');
      loadMaintenance();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to deactivate maintenance block.');
    }
  };

  const handleWalkInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setActionFeedback(null);
    setGlobalError(null);
    setWalkInResult(null);
    try {
      const created = await adminCreateWalkInBooking(session.accessToken, {
        courtNumber: Number(walkInCourt),
        date: walkInDate,
        startTime: walkInTime,
        durationMinutes: Number(walkInDuration),
        customerName: walkInName,
        customerMobile: walkInMobile,
        customerEmail: walkInEmail,
      });
      setWalkInResult(created);
      setActionFeedback(`Created walk-in hold ${created.bookingReference}.`);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to create walk-in booking hold.');
    }
  };

  const handleVerifyQrInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setQrVerifyResult(null);
    setGlobalError(null);
    setActionFeedback(null);

    const parsed = parseQrCheckInInput(qrScanInput);
    if (parsed.rejectedLegacyFormat) {
      setQrVerifyResult({
        eligible: false,
        message:
          'Legacy ?token= QR format is rejected. Ask the guest to reopen Booking Lookup to render a dedicated server-signed chk_v1 QR pass.',
      });
      return;
    }

    if (!parsed.checkInToken) {
      setQrVerifyResult({
        eligible: false,
        message:
          'Could not extract a valid dedicated check-in token (pmb://astoria-regency/checkin?t=chk_v1... or raw chk_v1 token).',
      });
      return;
    }

    setQrVerifying(true);
    try {
      const result = await adminVerifyQrCheckIn(session.accessToken, {
        qrPayloadOrToken: qrScanInput.trim(),
        consume: qrConsumeOnVerify,
      });
      setQrVerifyResult({
        eligible: result.valid,
        message: result.message,
        details: result,
      });
      if (result.consumed) {
        setActionFeedback(
          `Checked in ${result.bookingReference} (Court ${result.courtNumber}) and consumed QR pass.`,
        );
      }
    } catch (err) {
      setQrVerifyResult({
        eligible: false,
        message:
          err instanceof Error
            ? err.message
            : 'Unable to verify server-signed QR check-in pass.',
      });
    } finally {
      setQrVerifying(false);
    }
  };

  const handleRevokeQrPass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setGlobalError(null);
    setActionFeedback(null);

    const target = revokeTargetInput.trim();
    const isRef = /^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/i.test(target);
    setRevokingQr(true);
    try {
      const res = await adminRevokeQrCheckIn(session.accessToken, {
        bookingReference: isRef ? target.toUpperCase() : undefined,
        qrPayloadOrToken: !isRef ? target : undefined,
        reason: revokeReasonInput.trim(),
        permanent: revokePermanent,
      });
      setRevokeTargetInput('');
      setRevokeReasonInput('');
      setRevokePermanent(false);
      setActionFeedback(
        `Revoked QR check-in pass${res.tokenJti ? ` (${res.tokenJti.slice(0, 10)}…)` : ''}${res.bookingReference ? ` for ${res.bookingReference}` : ''}.`,
      );
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to revoke QR check-in pass.');
    } finally {
      setRevokingQr(false);
    }
  };

  const handleStaffRoleChange = async (staffId: string, nextRole: StaffRoleDb) => {
    setActionFeedback(null);
    setGlobalError(null);
    try {
      await superAdminUpdateStaffProfile(staffId, { role: nextRole });
      setActionFeedback(`Updated staff role to ${STAFF_ROLE_LABELS[nextRole]}.`);
      loadStaff();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unable to update staff role.');
    }
  };

  if (loadingSession || !session || !role) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-sm text-slate-600">
        Verifying Astoria Regency staff session...
      </div>
    );
  }

  const navItems: Array<{
    tab: AdminTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    visible: boolean;
  }> = [
    { tab: 'reservations', label: 'Reservations', icon: Calendar, visible: canPerformStaffAction(role, 'viewReservations') },
    { tab: 'walk-in', label: 'Walk-In Hold', icon: Plus, visible: canPerformStaffAction(role, 'createWalkInHold') },
    { tab: 'check-in', label: 'QR Check-In', icon: QrCode, visible: canPerformStaffAction(role, 'verifyQrCheckIn') },
    { tab: 'pricing', label: 'Pricing & Rates', icon: Tag, visible: canPerformStaffAction(role, 'managePricing') },
    { tab: 'operating-hours', label: 'Operating Hours', icon: Clock, visible: canPerformStaffAction(role, 'manageOperatingHours') },
    { tab: 'maintenance', label: 'Maintenance', icon: Wrench, visible: canPerformStaffAction(role, 'viewMaintenance') },
    { tab: 'audit-logs', label: 'Audit Logs', icon: ClipboardList, visible: canPerformStaffAction(role, 'viewAuditLogs') },
    { tab: 'staff', label: 'Staff & Payments', icon: Users, visible: canPerformStaffAction(role, 'manageStaffProfiles') || canPerformStaffAction(role, 'managePricing') },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Sidebar Navigation (SaaS Dashboard Reference Contract: 240–280px equivalent col-span-3) */}
        <aside className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-5 space-y-6">
          <div className="space-y-1 border-b border-slate-100 pb-4">
            <p className="text-xs font-semibold text-navy-700 uppercase tracking-wider">
              {STAFF_ROLE_LABELS[role]}
            </p>
            <p className="font-display text-2xl font-bold text-navy-950 truncate">
              {session.profile.full_name}
            </p>
            <p className="font-mono text-xs text-slate-500 truncate">{session.profile.email}</p>
          </div>

          <nav aria-label="Staff dashboard navigation" className="space-y-1">
            {navItems
              .filter((item) => item.visible)
              .map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.tab;
                return (
                  <Link
                    key={item.tab}
                    to={tabToPath(item.tab)}
                    className={`flex items-center gap-2.5 min-h-[40px] px-3 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                      isActive
                        ? 'bg-navy-950 text-white'
                        : 'text-slate-700 hover:bg-slate-100 hover:text-navy-950'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
          </nav>

          <div className="pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full min-h-[40px] px-3 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </aside>

        {/* Main Viewport */}
        <section className="lg:col-span-9 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <p className="text-xs text-slate-500">
                Admin Portal / {navItems.find((n) => n.tab === activeTab)?.label ?? 'Dashboard'}
              </p>
              <h1 className="font-display text-3xl font-bold text-navy-950">
                {FACILITY_INFO.fullTitle}
              </h1>
            </div>
            <Link
              to={SITE_ROUTES.book}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-navy-950 hover:bg-slate-50 inline-flex items-center whitespace-nowrap shrink-0"
            >
              Open Public Floor Plan
            </Link>
          </div>

          {globalError && (
            <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-950 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{globalError}</span>
            </div>
          )}

          {actionFeedback && (
            <div className="rounded-xl border border-green-300 bg-green-50 px-4 py-3 text-xs text-green-950 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0 mt-0.5" />
              <span>{actionFeedback}</span>
            </div>
          )}

          {/* TAB: RESERVATIONS */}
          {activeTab === 'reservations' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label htmlFor="adm-date" className="block text-xs font-medium text-slate-600 mb-1">
                      Play Date ({FACILITY_INFO.timezone})
                    </label>
                    <input
                      id="adm-date"
                      type="date"
                      value={dateFilter}
                      onChange={(e) => setDateFilter(e.target.value)}
                      className="min-h-[40px] px-3 rounded-lg border border-slate-300 text-xs font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor="adm-status" className="block text-xs font-medium text-slate-600 mb-1">
                      Status
                    </label>
                    <select
                      id="adm-status"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="min-h-[40px] px-3 rounded-lg border border-slate-300 text-xs"
                    >
                      <option value="">All Statuses</option>
                      <option value="pending_payment">Pending Payment</option>
                      <option value="confirmed">Confirmed</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="expired">Expired</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={loadReservations}
                    className="min-h-[40px] px-4 rounded-lg bg-navy-950 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingReservations ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2.5 pr-4 font-semibold">Reference</th>
                      <th className="py-2.5 pr-4 font-semibold">Court</th>
                      <th className="py-2.5 pr-4 font-semibold">Schedule (PHT)</th>
                      <th className="py-2.5 pr-4 font-semibold">Customer</th>
                      <th className="py-2.5 pr-4 font-semibold">Status</th>
                      <th className="py-2.5 pr-4 font-semibold text-right">Amount</th>
                      <th className="py-2.5 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reservations.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          {loadingReservations
                            ? 'Loading reservations...'
                            : 'No reservations match this date or status filter.'}
                        </td>
                      </tr>
                    ) : (
                      reservations.map((r) => {
                        const s = utcIsoToManilaDateAndTime(r.start_at);
                        const e = utcIsoToManilaDateAndTime(r.end_at);
                        const isTerminal = ['cancelled', 'expired', 'completed'].includes(r.status);
                        const canCancel =
                          !isTerminal &&
                          (r.status !== 'confirmed' ||
                            canPerformStaffAction(role, 'cancelConfirmedReservation'));

                        return (
                          <tr key={r.id} className="hover:bg-slate-50">
                            <td className="py-3 pr-4 font-mono font-bold text-navy-950 whitespace-nowrap">
                              {r.booking_reference}
                            </td>
                            <td className="py-3 pr-4 whitespace-nowrap">
                              Court {r.courts?.court_number ?? '—'}
                            </td>
                            <td className="py-3 pr-4 font-mono tabular-nums whitespace-nowrap">
                              {s.date} · {s.time}–{e.time}
                            </td>
                            <td className="py-3 pr-4">{r.customers?.full_name ?? 'Guest'}</td>
                            <td className="py-3 pr-4 font-mono uppercase">{r.status}</td>
                            <td className="py-3 pr-4 font-mono font-semibold text-right tabular-nums whitespace-nowrap">
                              {formatCentavosPhp(r.total_amount_centavos)}
                            </td>
                            <td className="py-3 text-right whitespace-nowrap">
                              {isTerminal ? (
                                <span className="text-slate-400">—</span>
                              ) : canCancel ? (
                                <button
                                  type="button"
                                  onClick={() => handleCancelReservation(r)}
                                  className="px-2.5 py-1 rounded border border-red-300 text-red-700 font-semibold hover:bg-red-50"
                                >
                                  Cancel
                                </button>
                              ) : (
                                <span className="text-slate-500">Manager Only</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB: WALK-IN */}
          {activeTab === 'walk-in' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <div>
                <h2 className="font-display text-2xl font-bold text-navy-950">
                  Reception Walk-In Reservation Hold
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  Uses the same PostgreSQL transactional hold lock and server-calculated PHP pricing.
                </p>
              </div>
              <form onSubmit={handleWalkInSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Court (1–14)</label>
                  <select
                    value={walkInCourt}
                    onChange={(e) => setWalkInCourt(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300"
                  >
                    {Array.from({ length: 14 }, (_, idx) => idx + 1).map((c) => (
                      <option key={c} value={c}>
                        Court {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Play Date</label>
                  <input
                    type="date"
                    required
                    value={walkInDate}
                    onChange={(e) => setWalkInDate(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Start Time (HH:mm)</label>
                  <input
                    type="time"
                    required
                    step={3600}
                    value={walkInTime}
                    onChange={(e) => setWalkInTime(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Duration</label>
                  <select
                    value={walkInDuration}
                    onChange={(e) => setWalkInDuration(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300"
                  >
                    <option value="60">60 minutes</option>
                    <option value="120">120 minutes</option>
                    <option value="180">180 minutes</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Player Full Name</label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    value={walkInName}
                    onChange={(e) => setWalkInName(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Mobile Number</label>
                  <input
                    type="tel"
                    required
                    value={walkInMobile}
                    onChange={(e) => setWalkInMobile(e.target.value)}
                    placeholder="+63 917 000 0000"
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-semibold text-slate-700 mb-1">Email Address</label>
                  <input
                    type="email"
                    required
                    value={walkInEmail}
                    onChange={(e) => setWalkInEmail(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-lg border border-slate-300"
                  />
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    className="min-h-[44px] px-6 rounded-lg bg-lime-400 text-navy-950 font-bold hover:bg-lime-300"
                  >
                    Acquire Walk-In Hold
                  </button>
                </div>
              </form>

              {walkInResult && (
                <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-xs space-y-1.5">
                  <p className="font-bold text-green-950">
                    Walk-In Hold Created: {walkInResult.bookingReference}
                  </p>
                  <p className="font-mono">Lookup Token: {walkInResult.lookupToken}</p>
                  <p className="font-mono tabular-nums">
                    Total: {formatCentavosPhp(walkInResult.pricing.totalAmountCentavos)} · Expires:{' '}
                    {utcIsoToManilaDateAndTime(walkInResult.expiresAt).time} PHT
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB: QR CHECK-IN */}
          {activeTab === 'check-in' && (
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                <div>
                  <h2 className="font-display text-2xl font-bold text-navy-950">
                    Reception QR Pass Verification
                  </h2>
                  <p className="text-xs text-slate-600 mt-1">
                    Scan or paste a guest&apos;s server-signed{' '}
                    <span className="font-mono">pmb://astoria-regency/checkin?t=chk_v1...</span>{' '}
                    URI (or raw <span className="font-mono">chk_v1.*</span> token). Signatures,
                    expiry, reservation confirmation, and single-use redemption are enforced on the
                    server.
                  </p>
                </div>
                <form onSubmit={handleVerifyQrInput} className="space-y-3">
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="text"
                      required
                      value={qrScanInput}
                      onChange={(e) => setQrScanInput(e.target.value)}
                      placeholder="pmb://astoria-regency/checkin?t=chk_v1...."
                      className="flex-1 min-h-[44px] px-3.5 rounded-lg border border-slate-300 font-mono text-xs"
                    />
                    <button
                      type="submit"
                      disabled={qrVerifying}
                      className="min-h-[44px] px-6 rounded-lg bg-navy-950 text-white text-xs font-semibold hover:bg-navy-800 disabled:opacity-60 whitespace-nowrap"
                    >
                      {qrVerifying
                        ? 'Verifying...'
                        : qrConsumeOnVerify
                          ? 'Verify & Check In'
                          : 'Inspect Without Redeeming'}
                    </button>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={qrConsumeOnVerify}
                      onChange={(e) => setQrConsumeOnVerify(e.target.checked)}
                    />
                    <span>Redeem single-use check-in pass immediately on valid verification</span>
                  </label>
                </form>

                {qrVerifyResult && (
                  <div
                    className={`rounded-lg border p-4 text-xs space-y-2 ${
                      qrVerifyResult.eligible
                        ? 'border-green-300 bg-green-50 text-green-950'
                        : 'border-amber-300 bg-amber-50 text-amber-950'
                    }`}
                  >
                    <p className="font-bold">{qrVerifyResult.message}</p>
                    {qrVerifyResult.details && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-black/10 font-mono tabular-nums">
                        <div>
                          <span className="text-slate-500 block">Ref</span>
                          {qrVerifyResult.details.bookingReference}
                        </div>
                        <div>
                          <span className="text-slate-500 block">Court</span>
                          Court {qrVerifyResult.details.courtNumber}
                        </div>
                        <div>
                          <span className="text-slate-500 block">Customer</span>
                          {qrVerifyResult.details.customerName ?? 'Verified Player'}
                        </div>
                        <div>
                          <span className="text-slate-500 block">Pass ID</span>
                          {qrVerifyResult.details.tokenJti.slice(0, 12)}…
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div>
                  <h3 className="font-display text-xl font-bold text-navy-950">
                    Revoke Issued QR Pass
                  </h3>
                  <p className="text-xs text-slate-600 mt-1">
                    Invalidate a previously shared QR token (<span className="font-mono">chk_v1.*</span>)
                    or revoke active passes for a booking reference (<span className="font-mono">PMB-YYYYMMDD-XXXX</span>).
                  </p>
                </div>
                <form onSubmit={handleRevokeQrPass} className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <input
                    type="text"
                    required
                    value={revokeTargetInput}
                    onChange={(e) => setRevokeTargetInput(e.target.value)}
                    placeholder="PMB-YYYYMMDD-XXXX or pmb://.../checkin?t=chk_v1..."
                    className="sm:col-span-2 min-h-[42px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                  <input
                    type="text"
                    required
                    minLength={3}
                    value={revokeReasonInput}
                    onChange={(e) => setRevokeReasonInput(e.target.value)}
                    placeholder="Revocation reason"
                    className="min-h-[42px] px-3 rounded-lg border border-slate-300"
                  />
                  {canPerformStaffAction(role, 'cancelConfirmedReservation') && (
                    <label className="sm:col-span-2 inline-flex items-center gap-2 text-slate-700">
                      <input
                        type="checkbox"
                        checked={revokePermanent}
                        onChange={(e) => setRevokePermanent(e.target.checked)}
                      />
                      <span>Permanently block future QR check-in passes for this reservation (Manager / Super Admin)</span>
                    </label>
                  )}
                  <button
                    type="submit"
                    disabled={revokingQr}
                    className="sm:col-start-3 min-h-[42px] px-4 rounded-lg border border-red-300 bg-red-50 text-red-800 font-semibold hover:bg-red-100 disabled:opacity-60"
                  >
                    {revokingQr ? 'Revoking...' : 'Revoke QR Pass'}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* TAB: PRICING & RATES */}
          {activeTab === 'pricing' && (
            <div className="space-y-6">
              {!canPerformStaffAction(role, 'managePricing') ? (
                <div className="bg-white border border-slate-200 rounded-xl p-6 text-xs text-slate-600">
                  Manager or Super Admin access is required to modify PHP court pricing.
                </div>
              ) : (
                <>
                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <div>
                      <h2 className="font-display text-2xl font-bold text-navy-950">
                        Base Hourly Court Rates (PHP)
                      </h2>
                      <p className="text-xs text-slate-600 mt-1">
                        Enter the facility hourly rate in Philippine Pesos for any of Courts 1–14.
                        Saved directly in PostgreSQL as integer centavos.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {courts.map((c) => (
                        <div
                          key={c.id}
                          className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="font-bold text-navy-950 whitespace-nowrap">
                            Court {c.court_number}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-slate-500">₱</span>
                            <input
                              type="number"
                              min={10}
                              step="0.01"
                              value={rateDraftPhp[c.court_number] ?? ''}
                              onChange={(e) =>
                                setRateDraftPhp((prev) => ({
                                  ...prev,
                                  [c.court_number]: e.target.value,
                                }))
                              }
                              aria-label={`Court ${c.court_number} hourly rate PHP`}
                              className="w-24 min-h-[34px] px-2 rounded border border-slate-300 font-mono text-right tabular-nums"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveCourtRate(c.court_number)}
                              className="min-h-[34px] px-2.5 rounded bg-navy-950 text-white font-semibold hover:bg-navy-800"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <h2 className="font-display text-2xl font-bold text-navy-950">
                      Time-Window, Weekend, Peak & Promo Rules
                    </h2>
                    <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
                      {pricingRules.map((rule) => {
                        const hasLegacyTag = /dev default/i.test(rule.name);
                        return (
                          <div
                            key={rule.id}
                            className="py-3 flex flex-wrap items-center justify-between gap-3"
                          >
                            <div className="space-y-0.5">
                              <p className="font-bold text-navy-950">
                                {sanitizePricingRuleDisplayName(rule.name)}
                              </p>
                              <p className="font-mono text-slate-500 tabular-nums">
                                {rule.rule_type} · {rule.day_scope} ·{' '}
                                {rule.start_time && rule.end_time
                                  ? `${rule.start_time.slice(0, 5)}–${rule.end_time.slice(0, 5)} PHT`
                                  : 'All hours'}{' '}
                                ·{' '}
                                {rule.rate_centavos !== null
                                  ? `${formatCentavosPhp(rule.rate_centavos)}/hr`
                                  : `${rule.discount_percent}% promo`}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {hasLegacyTag && (
                                <button
                                  type="button"
                                  onClick={() => handleRenameRuleFromLegacy(rule)}
                                  className="px-2.5 py-1 rounded border border-amber-300 bg-amber-50 text-amber-900 font-semibold"
                                >
                                  Clear Seed Label
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleTogglePricingRule(rule)}
                                className={`px-3 py-1 rounded font-semibold border ${
                                  rule.is_active
                                    ? 'border-green-300 bg-green-50 text-green-900'
                                    : 'border-slate-300 bg-slate-100 text-slate-600'
                                }`}
                              >
                                {rule.is_active ? 'Active' : 'Inactive'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <form onSubmit={handleCreatePricingRule} className="pt-2 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
                      <input
                        type="text"
                        required
                        placeholder="Rule Name (e.g. Prime Evening)"
                        value={newRuleName}
                        onChange={(e) => setNewRuleName(e.target.value)}
                        className="sm:col-span-2 min-h-[40px] px-3 rounded-lg border border-slate-300"
                      />
                      <select
                        value={newRuleType}
                        onChange={(e) =>
                          setNewRuleType(e.target.value as 'standard' | 'weekend' | 'peak' | 'promo')
                        }
                        className="min-h-[40px] px-3 rounded-lg border border-slate-300"
                      >
                        <option value="standard">Standard Rate</option>
                        <option value="weekend">Weekend Rate</option>
                        <option value="peak">Peak Surcharge</option>
                        <option value="promo">Promo Discount %</option>
                      </select>
                      <select
                        value={newRuleDayScope}
                        onChange={(e) =>
                          setNewRuleDayScope(e.target.value as 'all' | 'weekday' | 'weekend')
                        }
                        className="min-h-[40px] px-3 rounded-lg border border-slate-300"
                      >
                        <option value="all">All Days</option>
                        <option value="weekday">Weekdays</option>
                        <option value="weekend">Weekends</option>
                      </select>
                      <input
                        type="time"
                        value={newRuleStart}
                        onChange={(e) => setNewRuleStart(e.target.value)}
                        className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                      />
                      <input
                        type="time"
                        value={newRuleEnd}
                        onChange={(e) => setNewRuleEnd(e.target.value)}
                        className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                      />
                      {newRuleType === 'promo' ? (
                        <input
                          type="number"
                          min={1}
                          max={90}
                          placeholder="Discount %"
                          value={newRuleDiscountPct}
                          onChange={(e) => setNewRuleDiscountPct(e.target.value)}
                          className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                        />
                      ) : (
                        <input
                          type="number"
                          required
                          min={10}
                          step="0.01"
                          placeholder="Hourly PHP (e.g. 450)"
                          value={newRuleRatePhp}
                          onChange={(e) => setNewRuleRatePhp(e.target.value)}
                          className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                        />
                      )}
                      <input
                        type="number"
                        placeholder="Priority"
                        value={newRulePriority}
                        onChange={(e) => setNewRulePriority(e.target.value)}
                        className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                      />
                      <button
                        type="submit"
                        className="sm:col-span-4 min-h-[42px] rounded-lg bg-lime-400 text-navy-950 font-bold hover:bg-lime-300"
                      >
                        Add Pricing Rule
                      </button>
                    </form>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB: OPERATING HOURS */}
          {activeTab === 'operating-hours' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <div>
                <h2 className="font-display text-2xl font-bold text-navy-950">
                  Operating Hours & Holiday Overrides ({FACILITY_INFO.timezone})
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  Updates take effect immediately across availability checks, quotes, and PostgreSQL hold locking.
                </p>
              </div>

              <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
                {operatingHours.map((row) => (
                  <div key={row.id} className="py-2.5 flex items-center justify-between gap-4">
                    <span className="font-semibold text-navy-950">
                      {row.override_date
                        ? `Override: ${row.override_date}`
                        : DAY_NAMES[row.day_of_week ?? 0]}
                    </span>
                    <span className="font-mono tabular-nums text-slate-700">
                      {row.is_closed
                        ? 'CLOSED'
                        : `${row.open_time.slice(0, 5)} – ${row.close_time.slice(0, 5)} PHT`}
                    </span>
                  </div>
                ))}
              </div>

              {canPerformStaffAction(role, 'manageOperatingHours') && (
                <form onSubmit={handleSaveOperatingHour} className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-2">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Weekly Day</label>
                    <select
                      value={editDayOfWeek}
                      onChange={(e) => setEditDayOfWeek(e.target.value)}
                      disabled={Boolean(overrideDate.trim())}
                      className="w-full min-h-[40px] px-3 rounded-lg border border-slate-300"
                    >
                      {DAY_NAMES.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Or Holiday Override Date
                    </label>
                    <input
                      type="date"
                      value={overrideDate}
                      onChange={(e) => setOverrideDate(e.target.value)}
                      className="w-full min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                    />
                  </div>
                  <div className="flex items-end">
                    <label className="inline-flex items-center gap-2 min-h-[40px] font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={isClosedInput}
                        onChange={(e) => setIsClosedInput(e.target.checked)}
                      />
                      <span>Mark Closed All Day</span>
                    </label>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Open Time (PHT)</label>
                    <input
                      type="time"
                      required
                      value={openTimeInput}
                      onChange={(e) => setOpenTimeInput(e.target.value)}
                      className="w-full min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Close Time (PHT)</label>
                    <input
                      type="time"
                      required
                      value={closeTimeInput}
                      onChange={(e) => setCloseTimeInput(e.target.value)}
                      className="w-full min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Notes (Optional)</label>
                    <input
                      type="text"
                      value={hoursNotesInput}
                      onChange={(e) => setHoursNotesInput(e.target.value)}
                      placeholder="Tournament / holiday note"
                      className="w-full min-h-[40px] px-3 rounded-lg border border-slate-300"
                    />
                  </div>
                  <button
                    type="submit"
                    className="sm:col-span-3 min-h-[42px] rounded-lg bg-navy-950 text-white font-semibold hover:bg-navy-800"
                  >
                    Save Operating Hours
                  </button>
                </form>
              )}
            </div>
          )}

          {/* TAB: MAINTENANCE */}
          {activeTab === 'maintenance' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <h2 className="font-display text-2xl font-bold text-navy-950">
                Active Court Maintenance Blocks
              </h2>
              <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
                {maintenanceBlocks.length === 0 ? (
                  <p className="py-6 text-slate-500">No active court maintenance windows.</p>
                ) : (
                  maintenanceBlocks.map((b) => (
                    <div key={b.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-bold text-navy-950">
                          Court {b.courts?.court_number ?? '—'} · {b.reason}
                        </p>
                        <p className="font-mono text-slate-500 tabular-nums">
                          {utcIsoToManilaDateAndTime(b.start_at).date}{' '}
                          {utcIsoToManilaDateAndTime(b.start_at).time}–
                          {utcIsoToManilaDateAndTime(b.end_at).time} PHT
                        </p>
                      </div>
                      {canPerformStaffAction(role, 'manageMaintenance') && (
                        <button
                          type="button"
                          onClick={() => handleDeactivateMaintenance(b.id)}
                          className="px-3 py-1 rounded border border-red-300 text-red-700 font-semibold hover:bg-red-50"
                        >
                          Clear Block
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {canPerformStaffAction(role, 'manageMaintenance') && (
                <form onSubmit={handleCreateMaintenance} className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs pt-2">
                  <select
                    value={maintCourt}
                    onChange={(e) => setMaintCourt(e.target.value)}
                    className="min-h-[40px] px-3 rounded-lg border border-slate-300"
                  >
                    {Array.from({ length: 14 }, (_, idx) => idx + 1).map((c) => (
                      <option key={c} value={c}>
                        Court {c}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    required
                    value={maintDate}
                    onChange={(e) => setMaintDate(e.target.value)}
                    className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                  <input
                    type="time"
                    required
                    value={maintStartTime}
                    onChange={(e) => setMaintStartTime(e.target.value)}
                    className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                  <input
                    type="time"
                    required
                    value={maintEndTime}
                    onChange={(e) => setMaintEndTime(e.target.value)}
                    className="min-h-[40px] px-3 rounded-lg border border-slate-300 font-mono"
                  />
                  <input
                    type="text"
                    required
                    minLength={3}
                    placeholder="Reason (e.g. Acrylic resurfacing / Net tension check)"
                    value={maintReason}
                    onChange={(e) => setMaintReason(e.target.value)}
                    className="sm:col-span-3 min-h-[40px] px-3 rounded-lg border border-slate-300"
                  />
                  <button
                    type="submit"
                    className="min-h-[40px] px-4 rounded-lg bg-navy-950 text-white font-semibold"
                  >
                    Block Court
                  </button>
                </form>
              )}
            </div>
          )}

          {/* TAB: AUDIT LOGS */}
          {activeTab === 'audit-logs' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-2xl font-bold text-navy-950">Booking Audit Logs</h2>
                <button
                  type="button"
                  onClick={loadAuditLogs}
                  className="px-3 py-1.5 rounded border border-slate-300 text-xs font-semibold"
                >
                  Refresh
                </button>
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                {auditLogs.length === 0 ? (
                  <p className="py-6 text-slate-500">No audit log events loaded.</p>
                ) : (
                  auditLogs.map((log) => (
                    <div key={log.id} className="py-3 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-bold text-navy-950">{log.event_type}</span>
                        <span className="font-mono text-slate-500 tabular-nums">
                          {utcIsoToManilaDateAndTime(log.created_at).date}{' '}
                          {utcIsoToManilaDateAndTime(log.created_at).time} PHT · {log.actor_type}
                        </span>
                      </div>
                      <pre className="font-mono text-[11px] text-slate-600 bg-slate-50 rounded p-2 overflow-x-auto">
                        {JSON.stringify(log.payload)}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* TAB: STAFF & HITPAY READINESS */}
          {activeTab === 'staff' && (
            <div className="space-y-6">
              {canPerformStaffAction(role, 'manageStaffProfiles') && (
                <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-navy-800" />
                    <h2 className="font-display text-2xl font-bold text-navy-950">
                      Staff Profiles & RBAC Roles
                    </h2>
                  </div>
                  <div className="divide-y divide-slate-100 text-xs">
                    {staffProfiles.map((sp) => (
                      <div key={sp.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-bold text-navy-950">{sp.full_name}</p>
                          <p className="font-mono text-slate-500">{sp.email}</p>
                        </div>
                        <select
                          value={sp.role}
                          onChange={(e) => handleStaffRoleChange(sp.id, e.target.value as StaffRoleDb)}
                          className="min-h-[36px] px-3 rounded border border-slate-300 font-semibold"
                        >
                          <option value="reception_staff">Reception Staff</option>
                          <option value="manager">Manager</option>
                          <option value="super_admin">Super Admin</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3 text-xs">
                <div className="flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-navy-800" />
                  <h2 className="font-display text-2xl font-bold text-navy-950">
                    Stage 5 HitPay Payment Gateway Readiness
                  </h2>
                </div>
                <p className="text-slate-600">
                  Current status:{' '}
                  <span className="font-mono font-bold text-navy-950">
                    paymentGatewayEnabled = {String(STAGE5_HITPAY_PLAN.paymentGatewayEnabled)}
                  </span>{' '}
                  (live charges remain disabled pending management approval).
                </p>
                <div className="pt-2 border-t border-slate-100 space-y-1 text-slate-700">
                  <p className="font-semibold text-navy-950">Planned Checkout & Webhook Safeguards:</p>
                  {STAGE5_HITPAY_PLAN.securityInvariants.map((item) => (
                    <p key={item}>· {item}</p>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
