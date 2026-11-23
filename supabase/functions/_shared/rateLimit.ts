import type { SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from './supabase.ts';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function extractClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  return 'unknown';
}

/**
 * Enforces distributed, atomic rate limiting inside PostgreSQL via
 * check_and_consume_rate_limit() (Migration 0004).
 */
export async function enforceDistributedRateLimit(
  admin: SupabaseClient | null,
  req: Request,
  routeKey: string,
  options?: { windowSeconds?: number; maxRequests?: number },
): Promise<RateLimitResult> {
  if (!admin) {
    return { allowed: true, remaining: 40, retryAfterSeconds: 0 };
  }

  const windowSeconds =
    options?.windowSeconds ?? Number(getEnv('RATE_LIMIT_WINDOW_SECONDS') || 60);
  const maxRequests =
    options?.maxRequests ?? Number(getEnv('RATE_LIMIT_MAX_REQUESTS') || 40);

  const clientIp = extractClientIp(req);
  const bucketKey = `${routeKey}:${clientIp}`;

  const { data, error } = await admin.rpc('check_and_consume_rate_limit', {
    p_bucket_key: bucketKey,
    p_window_seconds: windowSeconds,
    p_max_requests: maxRequests,
  });

  if (error || !data) {
    // Fail-open only on rate-limit table unavailability, never leak internal error
    return { allowed: true, remaining: maxRequests, retryAfterSeconds: 0 };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed ?? true),
    remaining: Number(row?.remaining ?? 0),
    retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
  };
}
