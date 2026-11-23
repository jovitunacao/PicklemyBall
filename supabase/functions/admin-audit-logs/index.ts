import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  verifyStaffJwt,
} from '../_shared/supabase.ts';

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'GET, OPTIONS',
  );
  if (preflightOrErrorResponse) {
    return preflightOrErrorResponse;
  }

  if (req.method !== 'GET') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.', corsHeaders);
  }

  const auth = await verifyStaffJwt(req, ['super_admin', 'manager']);
  if (!auth.ok) {
    return errorResponse(auth.statusCode, auth.code, auth.error, corsHeaders);
  }

  const { admin, staff } = auth;
  const facilityId = staff.profile.facility_id || DEFAULT_FACILITY_ID;
  const url = new URL(req.url);

  try {
    const reservationId = url.searchParams.get('reservationId');
    const eventType = url.searchParams.get('eventType');
    const rawLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
      : 50;

    let query = admin
      .from('booking_audit_logs')
      .select('id, reservation_id, hold_id, actor_type, actor_id, event_type, payload, created_at')
      .eq('facility_id', facilityId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (reservationId) {
      query = query.eq('reservation_id', reservationId);
    }
    if (eventType) {
      query = query.eq('event_type', eventType);
    }

    const { data, error } = await query;
    if (error) {
      return errorResponse(500, 'AUDIT_QUERY_ERROR', 'Failed to load audit logs.', corsHeaders);
    }

    return jsonResponse(200, { auditLogs: data ?? [] }, corsHeaders);
  } catch {
    return errorResponse(500, 'AUDIT_INTERNAL_ERROR', 'Unexpected error loading audit logs.', corsHeaders);
  }
});
