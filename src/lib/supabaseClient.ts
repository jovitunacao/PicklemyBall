import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type BrowserSupabaseConfigState =
  | 'ready'
  | 'missing'
  | 'invalid_url'
  | 'incomplete';

export interface BrowserSupabaseDiagnostic {
  state: BrowserSupabaseConfigState;
  configured: boolean;
  hasUrl: boolean;
  hasAnonKey: boolean;
  hasEdgeOverride: boolean;
  message: string;
}

export interface BrowserEnvLike {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_EDGE_FUNCTIONS_URL?: string;
}

function validateUrlShape(rawUrl: string): {
  valid: boolean;
  isDashboardUrl: boolean;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed || /MY_|YOUR_|your-project|<project-ref>/i.test(trimmed)) {
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
    const isSupabaseApiHost =
      parsed.hostname.endsWith('.supabase.co') || parsed.hostname.endsWith('.supabase.in');
    const isRoot = parsed.pathname === '' || parsed.pathname === '/';
    return {
      valid: (isSupabaseApiHost || isLocal) && isRoot,
      isDashboardUrl: false,
    };
  } catch {
    return { valid: false, isDashboardUrl: false };
  }
}

function validateCustomEdgeUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || /MY_|YOUR_|your-project|<project-ref>/i.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function diagnoseBrowserSupabaseConfig(
  envOverride?: BrowserEnvLike,
): BrowserSupabaseDiagnostic {
  const env = envOverride ?? import.meta.env;
  const url = env.VITE_SUPABASE_URL?.trim() ?? '';
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  const edgeUrl = env.VITE_EDGE_FUNCTIONS_URL?.trim() ?? '';

  const hasUrl = Boolean(url);
  const hasAnonKey = Boolean(anonKey);
  const hasEdgeOverride = Boolean(edgeUrl);

  if (!hasUrl && !hasAnonKey && !hasEdgeOverride) {
    return {
      state: 'missing',
      configured: false,
      hasUrl: false,
      hasAnonKey: false,
      hasEdgeOverride: false,
      message:
        'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set in this environment.',
    };
  }

  if (hasEdgeOverride && !validateCustomEdgeUrl(edgeUrl)) {
    return {
      state: 'invalid_url',
      configured: false,
      hasUrl,
      hasAnonKey,
      hasEdgeOverride,
      message:
        'VITE_EDGE_FUNCTIONS_URL is malformed. Provide a valid https:// Edge Functions base URL.',
    };
  }

  if (hasUrl) {
    const check = validateUrlShape(url);
    if (check.isDashboardUrl) {
      return {
        state: 'invalid_url',
        configured: false,
        hasUrl,
        hasAnonKey,
        hasEdgeOverride,
        message:
          'VITE_SUPABASE_URL is set to a Supabase Dashboard web URL instead of your project API URL (https://<project-ref>.supabase.co).',
      };
    }
    if (!check.valid) {
      return {
        state: 'invalid_url',
        configured: false,
        hasUrl,
        hasAnonKey,
        hasEdgeOverride,
        message:
          'VITE_SUPABASE_URL must be your project API base URL (https://<project-ref>.supabase.co).',
      };
    }
  }

  if ((!hasUrl && !hasEdgeOverride) || !hasAnonKey || /MY_|YOUR_/i.test(anonKey)) {
    return {
      state: 'incomplete',
      configured: false,
      hasUrl,
      hasAnonKey,
      hasEdgeOverride,
      message:
        'Supabase browser credentials are incomplete. Both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required.',
    };
  }

  return {
    state: 'ready',
    configured: true,
    hasUrl,
    hasAnonKey,
    hasEdgeOverride,
    message: 'Browser Supabase configuration is valid.',
  };
}

export const isSupabaseBrowserConfigured = diagnoseBrowserSupabaseConfig().configured;

let cachedClient: SupabaseClient | null = null;

/**
 * Returns the browser-safe Supabase anon client, or null if VITE_SUPABASE_* env vars
 * are missing or invalid. Never throws during app startup.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  const diag = diagnoseBrowserSupabaseConfig();
  if (!diag.configured || !diag.hasUrl || !diag.hasAnonKey) {
    return null;
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL!.trim().replace(/\/+$/, '');
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY!.trim();

  if (!cachedClient) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return cachedClient;
}
