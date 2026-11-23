import { handleCorsPreflightOrReject } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/security.ts';
import {
  DEFAULT_FACILITY_ID,
  getEnv,
  verifyStaffJwt,
} from '../_shared/supabase.ts';
import {
  AdminCreatePricingRuleSchema,
  AdminPatchPricingSchema,
} from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const { preflightOrErrorResponse, corsHeaders } = handleCorsPreflightOrReject(
    req,
    getEnv('ALLOWED_ORIGINS'),
    'GET, POST, PATCH, OPTIONS',
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
      const [{ data: courts, error: courtsErr }, { data: rules, error: rulesErr }] =
        await Promise.all([
          admin
            .from('courts')
            .select('id, court_number, name, base_hourly_rate_centavos, status')
            .eq('facility_id', facilityId)
            .order('court_number', { ascending: true }),
          admin
            .from('pricing_rules')
            .select('*')
            .eq('facility_id', facilityId)
            .order('priority', { ascending: false }),
        ]);

      if (courtsErr || rulesErr) {
        return errorResponse(500, 'PRICING_QUERY_ERROR', 'Failed to retrieve pricing configuration.', corsHeaders);
      }

      return jsonResponse(
        200,
        {
          currency: 'PHP',
          courts: courts ?? [],
          pricingRules: rules ?? [],
        },
        corsHeaders,
      );
    }

    if (req.method === 'POST') {
      const rawBody = await req.json().catch(() => null);
      const parsed = AdminCreatePricingRuleSchema.safeParse(rawBody);
      if (!parsed.success) {
        return errorResponse(
          400,
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Invalid pricing rule payload.',
          corsHeaders,
        );
      }

      let courtId: string | null = null;
      if (parsed.data.courtNumber) {
        const { data: court } = await admin
          .from('courts')
          .select('id')
          .eq('facility_id', facilityId)
          .eq('court_number', parsed.data.courtNumber)
          .maybeSingle<{ id: string }>();
        if (!court) {
          return errorResponse(404, 'COURT_NOT_FOUND', `Court ${parsed.data.courtNumber} not found.`, corsHeaders);
        }
        courtId = court.id;
      }

      const { data, error } = await admin
        .from('pricing_rules')
        .insert({
          facility_id: facilityId,
          court_id: courtId,
          name: parsed.data.name,
          rule_type: parsed.data.ruleType,
          day_scope: parsed.data.dayScope,
          start_time: parsed.data.startTime ?? null,
          end_time: parsed.data.endTime ?? null,
          rate_centavos: parsed.data.rateCentavos ?? null,
          discount_percent: parsed.data.discountPercent,
          priority: parsed.data.priority,
          is_active: parsed.data.isActive,
          valid_from: parsed.data.validFrom ?? null,
          valid_until: parsed.data.validUntil ?? null,
        })
        .select('*')
        .single();

      if (error || !data) {
        return errorResponse(500, 'PRICING_INSERT_ERROR', 'Unable to create pricing rule.', corsHeaders);
      }

      await admin.from('booking_audit_logs').insert({
        facility_id: facilityId,
        actor_type: 'staff',
        actor_id: staff.userId,
        event_type: 'pricing_rule_created',
        payload: { ruleId: data.id, name: parsed.data.name, ruleType: parsed.data.ruleType },
      });

      return jsonResponse(201, { pricingRule: data }, corsHeaders);
    }

    if (req.method === 'PATCH') {
      const rawBody = await req.json().catch(() => null);
      const parsed = AdminPatchPricingSchema.safeParse(rawBody);
      if (!parsed.success) {
        return errorResponse(
          400,
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Invalid pricing update payload.',
          corsHeaders,
        );
      }

      if (parsed.data.target === 'court_base_rate') {
        const { data, error } = await admin
          .from('courts')
          .update({ base_hourly_rate_centavos: parsed.data.baseHourlyRateCentavos })
          .eq('facility_id', facilityId)
          .eq('court_number', parsed.data.courtNumber)
          .select('id, court_number, base_hourly_rate_centavos')
          .maybeSingle();

        if (error || !data) {
          return errorResponse(404, 'COURT_NOT_FOUND', 'Court not found for rate update.', corsHeaders);
        }

        await admin.from('booking_audit_logs').insert({
          facility_id: facilityId,
          actor_type: 'staff',
          actor_id: staff.userId,
          event_type: 'court_base_rate_updated',
          payload: {
            courtNumber: parsed.data.courtNumber,
            baseHourlyRateCentavos: parsed.data.baseHourlyRateCentavos,
          },
        });

        return jsonResponse(200, { court: data }, corsHeaders);
      }

      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.rateCentavos !== undefined) updates.rate_centavos = parsed.data.rateCentavos;
      if (parsed.data.discountPercent !== undefined) updates.discount_percent = parsed.data.discountPercent;
      if (parsed.data.priority !== undefined) updates.priority = parsed.data.priority;
      if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;

      const { data, error } = await admin
        .from('pricing_rules')
        .update(updates)
        .eq('facility_id', facilityId)
        .eq('id', parsed.data.ruleId)
        .select('*')
        .maybeSingle();

      if (error || !data) {
        return errorResponse(404, 'PRICING_RULE_NOT_FOUND', 'Pricing rule not found.', corsHeaders);
      }

      await admin.from('booking_audit_logs').insert({
        facility_id: facilityId,
        actor_type: 'staff',
        actor_id: staff.userId,
        event_type: 'pricing_rule_updated',
        payload: { ruleId: parsed.data.ruleId, updates },
      });

      return jsonResponse(200, { pricingRule: data }, corsHeaders);
    }

    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET, POST, and PATCH are supported.', corsHeaders);
  } catch {
    return errorResponse(500, 'ADMIN_PRICING_ERROR', 'Unexpected error managing pricing.', corsHeaders);
  }
});
