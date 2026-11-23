import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_FACILITY_ID = '11111111-1111-4111-8111-111111111101';

export type StaffRole = 'super_admin' | 'manager' | 'reception_staff';

export interface StaffProfile {
  id: string;
  facility_id: string;
  full_name: string;
  email: string;
  role: StaffRole;
  is_active: boolean;
}

export interface VerifiedStaffContext {
  userId: string;
  profile: StaffProfile;
}

export function getEnv(name: string): string | undefined {
  const denoEnv = (
    globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }
  ).Deno?.env;
  if (denoEnv) {
    return denoEnv.get(name)?.trim();
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name]?.trim();
  }
  return undefined;
}

/**
 * Creates a server-only Supabase admin client using SUPABASE_SERVICE_ROLE_KEY.
 * In Supabase Edge Functions, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
 * automatically injected into the runtime environment.
 */
export function getServiceSupabaseClient(): SupabaseClient | null {
  const url = getEnv('SUPABASE_URL');
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    return null;
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Verifies Authorization: Bearer <jwt> via Supabase Auth and confirms the caller
 * holds an active staff_profiles row in one of allowedRoles.
 */
export async function verifyStaffJwt(
  req: Request,
  allowedRoles: StaffRole[],
  adminClient?: SupabaseClient | null,
): Promise<
  | { ok: true; staff: VerifiedStaffContext; admin: SupabaseClient }
  | { ok: false; statusCode: number; code: string; error: string }
> {
  const admin = adminClient ?? getServiceSupabaseClient();
  if (!admin) {
    return {
      ok: false,
      statusCode: 503,
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'Server Supabase credentials are not configured.',
    };
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      statusCode: 401,
      code: 'UNAUTHORIZED',
      error: 'Missing Bearer access token.',
    };
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      code: 'UNAUTHORIZED',
      error: 'Empty Bearer access token.',
    };
  }

  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData?.user) {
    return {
      ok: false,
      statusCode: 401,
      code: 'UNAUTHORIZED',
      error: 'Invalid or expired staff session token.',
    };
  }

  const { data: profile, error: profileError } = await admin
    .from('staff_profiles')
    .select('id, facility_id, full_name, email, role, is_active')
    .eq('id', userData.user.id)
    .eq('is_active', true)
    .maybeSingle<StaffProfile>();

  if (profileError || !profile) {
    return {
      ok: false,
      statusCode: 403,
      code: 'FORBIDDEN',
      error: 'Authenticated user is not an active facility staff member.',
    };
  }

  if (!allowedRoles.includes(profile.role)) {
    return {
      ok: false,
      statusCode: 403,
      code: 'FORBIDDEN',
      error: `Role '${profile.role}' does not have permission for this administrative action.`,
    };
  }

  return {
    ok: true,
    staff: {
      userId: userData.user.id,
      profile,
    },
    admin,
  };
}
