import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  verifyStaffJwt,
} from '../_shared/supabase.ts';
import { AdminUpsertOperatingHourSchema } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'GET, PUT, OPTIONS',
  );
  if (preflightOrErrorResponse) {
    return preflightOrErrorResponse;
  }

  const auth = await verifyStaffJwt(req, ['super_admin', 'manager']);
  if (!auth.ok) {
    return errorResponse(auth.statusCode, auth.code, auth.error, corsHeaders);
  }

  const { admin, staff } = auth;
  const facilityId = staff.profile.facility_id || DEFAULT_FACILITY_ID;

  try {
    if (req.method === 'GET') {
      const [{ data: hours, error: hoursErr }, { data: settings }] = await Promise.all([
        admin
          .from('operating_hours')
          .select('*')
          .eq('facility_id', facilityId)
          .order('day_of_week', { ascending: true, nullsFirst: false }),
        admin
          .from('facility_settings')
          .select('*')
          .eq('facility_id', facilityId)
          .maybeSingle(),
      ]);

      if (hoursErr) {
        return errorResponse(500, 'HOURS_QUERY_ERROR', 'Failed to retrieve operating hours.', corsHeaders);
      }

      return jsonResponse(
        200,
        {
          timezone: 'Asia/Manila',
          operatingHours: hours ?? [],
          facilitySettings: settings ?? null,
        },
        corsHeaders,
      );
    }

    if (req.method === 'PUT') {
      const rawBody = await req.json().catch(() => null);
      const parsed = AdminUpsertOperatingHourSchema.safeParse(rawBody);
      if (!parsed.success) {
        return errorResponse(
          400,
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Invalid operating hours payload.',
          corsHeaders,
        );
      }

      const payload = parsed.data;
      const lookupQuery = admin
        .from('operating_hours')
        .select('id')
        .eq('facility_id', facilityId);

      const { data: existing } =
        payload.overrideDate
          ? await lookupQuery.eq('override_date', payload.overrideDate).maybeSingle<{ id: string }>()
          : await lookupQuery.eq('day_of_week', payload.dayOfWeek!).maybeSingle<{ id: string }>();

      const recordValues = {
        facility_id: facilityId,
        day_of_week: payload.overrideDate ? null : payload.dayOfWeek!,
        override_date: payload.overrideDate ?? null,
        open_time: payload.openTime,
        close_time: payload.closeTime,
        is_closed: payload.isClosed,
        notes: payload.notes ?? null,
      };

      const { data: savedRow, error: saveErr } = existing
        ? await admin
            .from('operating_hours')
            .update(recordValues)
            .eq('id', existing.id)
            .select('*')
            .single()
        : await admin
            .from('operating_hours')
            .insert(recordValues)
            .select('*')
            .single();

      if (saveErr || !savedRow) {
        return errorResponse(500, 'HOURS_UPDATE_ERROR', 'Unable to save operating hours.', corsHeaders);
      }

      await admin.from('booking_audit_logs').insert({
        facility_id: facilityId,
        actor_type: 'staff',
        actor_id: staff.userId,
        event_type: 'operating_hours_updated',
        payload: recordValues,
      });

      return jsonResponse(200, { operatingHour: savedRow }, corsHeaders);
    }

    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET and PUT are supported.', corsHeaders);
  } catch {
    return errorResponse(500, 'ADMIN_HOURS_ERROR', 'Unexpected error updating operating hours.', corsHeaders);
  }
});
