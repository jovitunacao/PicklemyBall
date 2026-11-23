import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StaffProfileRow, StaffRoleDb } from '../src/types/database.ts';

export const DEFAULT_FACILITY_ID = '11111111-1111-4111-8111-111111111101';

let adminClient: SupabaseClient | null = null;
let cachedConfigSignature = '';

export type ServerSupabaseConfigState =
  | 'ready'
  | 'unconfigured'
  | 'invalid_url'
  | 'incomplete';

export interface ServerSupabaseDiagnostic {
  state: ServerSupabaseConfigState;
  configured: boolean;
  hasUrl: boolean;
  hasServiceRoleKey: boolean;
  hasAnonKey: boolean;
  message: string;
}

export function isValidSupabaseApiUrl(rawUrl: string): {
  valid: boolean;
  isDashboardUrl: boolean;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, isDashboardUrl: false };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, isDashboardUrl: false };
    }
    if (parsed.hostname === 'supabase.com' || parsed.hostname.endsWith('.supabase.com')) {
      return { valid: false, isDashboardUrl: true };
    }
    const isLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'host.docker.internal';
    const isSupabaseProjectApi =
      parsed.hostname.endsWith('.supabase.co') || parsed.hostname.endsWith('.supabase.in');
    const cleanRootPath = parsed.pathname === '' || parsed.pathname === '/';
    return {
      valid: (isSupabaseProjectApi || isLocal) && cleanRootPath,
      isDashboardUrl: false,
    };
  } catch {
    return { valid: false, isDashboardUrl: false };
  }
}

export function diagnoseServerSupabaseConfig(): ServerSupabaseDiagnostic {
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim() ?? '';

  const hasUrl = Boolean(url);
  const hasServiceRoleKey = Boolean(serviceKey);
  const hasAnonKey = Boolean(anonKey);

  if (!hasUrl && !hasServiceRoleKey && !hasAnonKey) {
    return {
      state: 'unconfigured',
      configured: false,
      hasUrl: false,
      hasServiceRoleKey: false,
      hasAnonKey: false,
      message: 'Server Supabase credentials are not configured.',
    };
  }

  if (hasUrl) {
    const urlCheck = isValidSupabaseApiUrl(url);
    if (urlCheck.isDashboardUrl) {
      return {
        state: 'invalid_url',
        configured: false,
        hasUrl,
        hasServiceRoleKey,
        hasAnonKey,
        message:
          'SUPABASE_URL is set to a supabase.com dashboard URL instead of the project API URL (https://<project-ref>.supabase.co).',
      };
    }
    if (!urlCheck.valid) {
      return {
        state: 'invalid_url',
        configured: false,
        hasUrl,
        hasServiceRoleKey,
        hasAnonKey,
        message:
          'SUPABASE_URL must be a valid Supabase API base URL (https://<project-ref>.supabase.co).',
      };
    }
  }

  if (!hasUrl || !hasServiceRoleKey) {
    return {
      state: 'incomplete',
      configured: false,
      hasUrl,
      hasServiceRoleKey,
      hasAnonKey,
      message:
        'Supabase configuration on the server is incomplete (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required for server-side database access).',
    };
  }

  return {
    state: 'ready',
    configured: true,
    hasUrl,
    hasServiceRoleKey,
    hasAnonKey,
    message: 'Server Supabase configuration is valid.',
  };
}

export function isSupabaseServerConfigured(): boolean {
  return diagnoseServerSupabaseConfig().configured;
}

/**
 * Server-only Supabase administrative client using SUPABASE_SERVICE_ROLE_KEY.
 * Must NEVER be imported by client-side React code.
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  const diag = diagnoseServerSupabaseConfig();
  if (!diag.configured) {
    return null;
  }
  const url = process.env.SUPABASE_URL!.trim().replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sig = `${url}|${serviceKey.length}`;
  if (!adminClient || cachedConfigSignature !== sig) {
    cachedConfigSignature = sig;
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
  const diag = diagnoseServerSupabaseConfig();
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      statusCode: 503,
      error: `${diag.state.toUpperCase()}: ${diag.message}`,
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
