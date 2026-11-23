import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StaffProfileRow, StaffRoleDb } from '../src/types/database.ts';

export const DEFAULT_FACILITY_ID = '11111111-1111-4111-8111-111111111101';

let adminClient: SupabaseClient | null = null;

export function isSupabaseServerConfigured(): boolean {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return Boolean(url && serviceKey);
}

/**
 * Server-only Supabase administrative client using SUPABASE_SERVICE_ROLE_KEY.
 * Must NEVER be imported by client-side React code.
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    return null;
  }
  if (!adminClient) {
    adminClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return adminClient;
}

export interface VerifiedStaffContext {
  userId: string;
  profile: StaffProfileRow;
}

/**
 * Verifies an Authorization: Bearer <jwt> token via Supabase Auth and ensures
 * the caller has an active staff_profiles row matching allowedRoles.
 */
export async function verifyStaffAuthorization(
  authorizationHeader: string | undefined,
  allowedRoles: StaffRoleDb[],
): Promise<
  | { ok: true; staff: VerifiedStaffContext }
  | { ok: false; statusCode: number; error: string }
> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      statusCode: 503,
      error: 'SUPABASE_NOT_CONFIGURED: Server Supabase credentials are not configured.',
    };
  }

  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      statusCode: 401,
      error: 'UNAUTHORIZED: Missing Bearer access token.',
    };
  }

  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      error: 'UNAUTHORIZED: Empty Bearer access token.',
    };
  }

  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData?.user) {
    return {
      ok: false,
      statusCode: 401,
      error: 'UNAUTHORIZED: Invalid or expired Supabase staff token.',
    };
  }

  const { data: profile, error: profileError } = await admin
    .from('staff_profiles')
    .select('*')
    .eq('id', userData.user.id)
    .eq('is_active', true)
    .maybeSingle<StaffProfileRow>();

  if (profileError || !profile) {
    return {
      ok: false,
      statusCode: 403,
      error: 'FORBIDDEN: Authenticated user is not an active staff member.',
    };
  }

  if (!allowedRoles.includes(profile.role)) {
    return {
      ok: false,
      statusCode: 403,
      error: `FORBIDDEN: Role '${profile.role}' lacks permission for this action.`,
    };
  }

  return {
    ok: true,
    staff: {
      userId: userData.user.id,
      profile,
    },
  };
}
