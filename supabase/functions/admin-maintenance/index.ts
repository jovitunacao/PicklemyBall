import { z } from 'zod';
import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  verifyStaffJwt,
} from '../_shared/supabase.ts';
import { AdminCreateMaintenanceSchema } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'GET, POST, DELETE, OPTIONS',
  );
  if (preflightOrErrorResponse) {
    return preflightOrErrorResponse;
  }

  try {
    if (req.method === 'GET') {
      const auth = await verifyStaffJwt(req, ['super_admin', 'manager', 'reception_staff']);
      if (!auth.ok) {
        return errorResponse(auth.statusCode, auth.code, auth.error, corsHeaders);
      }

      const { admin, staff } = auth;
      const { data, error } = await admin
        .from('court_maintenance')
        .select('id, court_id, start_at, end_at, reason, is_active, created_at, courts(court_number, name)')
        .eq('facility_id', staff.profile.facility_id || DEFAULT_FACILITY_ID)
        .eq('is_active', true)
        .order('start_at', { ascending: true })
        .limit(100);

      if (error) {
        return errorResponse(500, 'MAINTENANCE_QUERY_ERROR', 'Failed to load maintenance blocks.', corsHeaders);
      }

      return jsonResponse(200, { maintenanceBlocks: data ?? [] }, corsHeaders);
    }

    // Creating or removing maintenance blocks requires manager or super_admin
    const auth = await verifyStaffJwt(req, ['super_admin', 'manager']);
    if (!auth.ok) {
      return errorResponse(auth.statusCode, auth.code, auth.error, corsHeaders);
    }
    const { admin, staff } = auth;
    const facilityId = staff.profile.facility_id || DEFAULT_FACILITY_ID;

    if (req.method === 'POST') {
      const rawBody = await req.json().catch(() => null);
      const parsed = AdminCreateMaintenanceSchema.safeParse(rawBody);
      if (!parsed.success) {
        return errorResponse(
          400,
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Invalid maintenance request.',
          corsHeaders,
        );
      }

      const { data: court } = await admin
        .from('courts')
        .select('id')
        .eq('facility_id', facilityId)
        .eq('court_number', parsed.data.courtNumber)
        .maybeSingle<{ id: string }>();

      if (!court) {
        return errorResponse(404, 'COURT_NOT_FOUND', 'Court not found.', corsHeaders);
      }

      const { data, error } = await admin
        .from('court_maintenance')
        .insert({
          facility_id: facilityId,
          court_id: court.id,
          start_at: parsed.data.startAtIso,
          end_at: parsed.data.endAtIso,
          reason: parsed.data.reason,
          is_active: true,
          created_by: staff.userId,
        })
        .select('id, court_id, start_at, end_at, reason, is_active')
        .single();

      if (error || !data) {
        return errorResponse(500, 'MAINTENANCE_INSERT_ERROR', 'Unable to block court for maintenance.', corsHeaders);
      }

      await admin.from('booking_audit_logs').insert({
        facility_id: facilityId,
        actor_type: 'staff',
        actor_id: staff.userId,
        event_type: 'court_maintenance_created',
        payload: {
          maintenanceId: data.id,
          courtNumber: parsed.data.courtNumber,
          reason: parsed.data.reason,
        },
      });

      return jsonResponse(201, data, corsHeaders);
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const idParam = url.searchParams.get('id');
      const idCheck = z.string().uuid().safeParse(idParam);
      if (!idCheck.success) {
        return errorResponse(400, 'VALIDATION_ERROR', 'Valid maintenance block UUID id query param is required.', corsHeaders);
      }

      const { data, error } = await admin
        .from('court_maintenance')
        .update({ is_active: false })
        .eq('id', idCheck.data)
        .eq('facility_id', facilityId)
        .select('id')
        .maybeSingle();

      if (error || !data) {
        return errorResponse(404, 'MAINTENANCE_NOT_FOUND', 'Maintenance block not found.', corsHeaders);
      }

      await admin.from('booking_audit_logs').insert({
        facility_id: facilityId,
        actor_type: 'staff',
        actor_id: staff.userId,
        event_type: 'court_maintenance_deactivated',
        payload: { maintenanceId: idCheck.data },
      });

      return jsonResponse(200, { deactivated: true, id: data.id }, corsHeaders);
    }

    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', corsHeaders);
  } catch {
    return errorResponse(500, 'MAINTENANCE_INTERNAL_ERROR', 'Unexpected error managing maintenance.', corsHeaders);
  }
});
