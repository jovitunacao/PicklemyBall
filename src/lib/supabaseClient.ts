import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

export const isSupabaseBrowserConfigured = Boolean(supabaseUrl && supabaseAnonKey);

let cachedClient: SupabaseClient | null = null;

/**
 * Returns the browser-safe Supabase anon client, or null if VITE_SUPABASE_* env vars
 * have not yet been configured for this environment.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isSupabaseBrowserConfigured) {
    return null;
  }
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
