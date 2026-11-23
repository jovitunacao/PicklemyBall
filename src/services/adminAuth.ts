import { getSupabaseBrowserClient } from '../lib/supabaseClient';
import type { StaffProfileRow, StaffRoleDb } from '../types/database';

export type StaffAction =
  | 'viewReservations'
  | 'createWalkInHold'
  | 'cancelPendingReservation'
  | 'cancelConfirmedReservation'
  | 'viewMaintenance'
  | 'manageMaintenance'
  | 'managePricing'
  | 'manageOperatingHours'
  | 'viewAuditLogs'
  | 'verifyQrCheckIn'
  | 'manageStaffProfiles';

export const STAFF_ROLE_LABELS: Record<StaffRoleDb, string> = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  reception_staff: 'Reception Staff',
};

export const ADMIN_ROLE_PERMISSIONS: Record<StaffRoleDb, ReadonlySet<StaffAction>> = {
  reception_staff: new Set<StaffAction>([
    'viewReservations',
    'createWalkInHold',
    'cancelPendingReservation',
    'viewMaintenance',
    'verifyQrCheckIn',
  ]),
  manager: new Set<StaffAction>([
    'viewReservations',
    'createWalkInHold',
    'cancelPendingReservation',
    'cancelConfirmedReservation',
    'viewMaintenance',
    'manageMaintenance',
    'managePricing',
    'manageOperatingHours',
    'viewAuditLogs',
    'verifyQrCheckIn',
  ]),
  super_admin: new Set<StaffAction>([
    'viewReservations',
    'createWalkInHold',
    'cancelPendingReservation',
    'cancelConfirmedReservation',
    'viewMaintenance',
    'manageMaintenance',
    'managePricing',
    'manageOperatingHours',
    'viewAuditLogs',
    'verifyQrCheckIn',
    'manageStaffProfiles',
  ]),
};

export function canPerformStaffAction(role: StaffRoleDb, action: StaffAction): boolean {
  return ADMIN_ROLE_PERMISSIONS[role]?.has(action) ?? false;
}

export interface StaffSessionContext {
  accessToken: string;
  userId: string;
  profile: StaffProfileRow;
}

export async function signInStaffWithPassword(
  email: string,
  password: string,
): Promise<StaffSessionContext> {
  const client = getSupabaseBrowserClient();
  if (!client) {
    throw new Error(
      'Supabase browser credentials (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are not configured in this preview environment.',
    );
  }

  const { data: authData, error: authErr } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (authErr || !authData.session || !authData.user) {
    throw new Error(authErr?.message || 'Invalid staff email or password.');
  }

  const { data: profile, error: profileErr } = await client
    .from('staff_profiles')
    .select('id, facility_id, full_name, email, role, is_active, created_at, updated_at')
    .eq('id', authData.user.id)
    .maybeSingle<StaffProfileRow>();

  if (profileErr || !profile || !profile.is_active) {
    await client.auth.signOut();
    throw new Error(
      'Your Supabase user account is not linked to an active Astoria Regency staff_profiles record.',
    );
  }

  return {
    accessToken: authData.session.access_token,
    userId: authData.user.id,
    profile,
  };
}

export async function getCurrentStaffSession(): Promise<StaffSessionContext | null> {
  const client = getSupabaseBrowserClient();
  if (!client) return null;

  const { data: sessionData, error: sessionErr } = await client.auth.getSession();
  if (sessionErr || !sessionData.session?.user) {
    return null;
  }

  const { data: profile, error: profileErr } = await client
    .from('staff_profiles')
    .select('id, facility_id, full_name, email, role, is_active, created_at, updated_at')
    .eq('id', sessionData.session.user.id)
    .eq('is_active', true)
    .maybeSingle<StaffProfileRow>();

  if (profileErr || !profile) {
    return null;
  }

  return {
    accessToken: sessionData.session.access_token,
    userId: sessionData.session.user.id,
    profile,
  };
}

export async function signOutStaff(): Promise<void> {
  const client = getSupabaseBrowserClient();
  if (!client) return;
  await client.auth.signOut();
}

export async function superAdminListStaffProfiles(): Promise<StaffProfileRow[]> {
  const client = getSupabaseBrowserClient();
  if (!client) {
    throw new Error('Supabase client is not configured.');
  }

  const { data, error } = await client
    .from('staff_profiles')
    .select('id, facility_id, full_name, email, role, is_active, created_at, updated_at')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message || 'Unable to load staff profiles.');
  }
  return (data ?? []) as StaffProfileRow[];
}

export async function superAdminUpdateStaffProfile(
  staffId: string,
  updates: { role?: StaffRoleDb; is_active?: boolean; full_name?: string },
): Promise<StaffProfileRow> {
  const client = getSupabaseBrowserClient();
  if (!client) {
    throw new Error('Supabase client is not configured.');
  }

  const { data, error } = await client
    .from('staff_profiles')
    .update(updates)
    .eq('id', staffId)
    .select('id, facility_id, full_name, email, role, is_active, created_at, updated_at')
    .single<StaffProfileRow>();

  if (error || !data) {
    throw new Error(error?.message || 'Unable to update staff profile.');
  }
  return data;
}
