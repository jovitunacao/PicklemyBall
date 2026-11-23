-- Pick My Ball – Astoria Regency
-- Stage 3/4 Migration 0004: Serverless Distributed Rate Limiting & Staff Admin RPCs
-- Designed to be additive and idempotent on top of 0001–0003. Do NOT drop/truncate objects.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Serverless Distributed Rate-Limiting Table (Service-Role Only via RPC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE api_rate_limits ENABLE ROW LEVEL SECURITY;
-- Zero anon/authenticated policies: inaccessible directly from client SDKs.

CREATE OR REPLACE FUNCTION check_and_consume_rate_limit(
  p_bucket_key TEXT,
  p_window_seconds INTEGER DEFAULT 60,
  p_max_requests INTEGER DEFAULT 40
)
RETURNS TABLE (
  allowed BOOLEAN,
  remaining INTEGER,
  retry_after_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_row api_rate_limits%ROWTYPE;
  v_elapsed_sec INTEGER;
BEGIN
  IF p_window_seconds <= 0 OR p_max_requests <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_CONFIG';
  END IF;

  INSERT INTO api_rate_limits (bucket_key, window_started_at, request_count, updated_at)
  VALUES (p_bucket_key, v_now, 1, v_now)
  ON CONFLICT (bucket_key) DO UPDATE
    SET
      request_count = CASE
        WHEN api_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now
          THEN 1
        ELSE api_rate_limits.request_count + 1
      END,
      window_started_at = CASE
        WHEN api_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now
          THEN v_now
        ELSE api_rate_limits.window_started_at
      END,
      updated_at = v_now
  RETURNING * INTO v_row;

  IF v_row.request_count > p_max_requests THEN
    v_elapsed_sec := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_row.window_started_at))::INTEGER);
    RETURN QUERY SELECT
      false,
      0,
      GREATEST(1, p_window_seconds - v_elapsed_sec);
  ELSE
    RETURN QUERY SELECT
      true,
      GREATEST(0, p_max_requests - v_row.request_count),
      0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION check_and_consume_rate_limit(TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_and_consume_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Staff Reservation Cancellation RPC (Preserves State Machine & Audit Trail)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION staff_cancel_reservation(
  p_staff_id UUID,
  p_booking_reference TEXT,
  p_reason TEXT DEFAULT 'Cancelled by facility staff'
)
RETURNS TABLE (
  reservation_id UUID,
  booking_reference TEXT,
  previous_status reservation_status,
  new_status reservation_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_staff staff_profiles%ROWTYPE;
  v_res reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_staff
  FROM staff_profiles sp
  WHERE sp.id = p_staff_id
    AND sp.is_active = true;

  IF NOT FOUND OR v_staff.role NOT IN ('super_admin', 'manager', 'reception_staff') THEN
    RAISE EXCEPTION 'FORBIDDEN: Caller is not an authorized active staff member';
  END IF;

  SELECT * INTO v_res
  FROM reservations r
  WHERE upper(trim(r.booking_reference)) = upper(trim(p_booking_reference))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Reservation % was not found', p_booking_reference;
  END IF;

  IF v_res.status IN ('cancelled', 'expired', 'completed') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION: Reservation is already in terminal state %', v_res.status;
  END IF;

  -- Confirmed reservations with paid intents can only be cancelled by manager or super_admin
  IF v_res.status = 'confirmed' AND v_staff.role = 'reception_staff' THEN
    RAISE EXCEPTION 'FORBIDDEN: Reception staff cannot cancel confirmed bookings';
  END IF;

  UPDATE reservations
  SET status = 'cancelled',
      cancelled_at = now(),
      cancellation_reason = COALESCE(NULLIF(trim(p_reason), ''), 'Cancelled by facility staff')
  WHERE id = v_res.id;

  IF v_res.hold_id IS NOT NULL THEN
    UPDATE reservation_holds
    SET status = 'released'
    WHERE id = v_res.hold_id
      AND status = 'active';
  END IF;

  INSERT INTO booking_audit_logs (
    facility_id, reservation_id, hold_id, actor_type, actor_id, event_type, payload
  )
  VALUES (
    v_res.facility_id, v_res.id, v_res.hold_id, 'staff', p_staff_id,
    'staff_reservation_cancelled',
    jsonb_build_object(
      'booking_reference', v_res.booking_reference,
      'previous_status', v_res.status,
      'staff_role', v_staff.role,
      'reason', p_reason
    )
  );

  RETURN QUERY SELECT v_res.id, v_res.booking_reference, v_res.status, 'cancelled'::reservation_status;
END;
$$;

REVOKE ALL ON FUNCTION staff_cancel_reservation(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_cancel_reservation(UUID, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Staff Walk-In Hold RPC (Same Concurrency Lock; Never Bypasses Stage 5 Payment)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION staff_create_walkin_hold(
  p_staff_id UUID,
  p_facility_id UUID,
  p_court_number INTEGER,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_customer_name TEXT,
  p_customer_mobile TEXT,
  p_customer_email TEXT,
  p_special_requests TEXT,
  p_hourly_rate_centavos INTEGER,
  p_total_centavos INTEGER,
  p_pricing_snapshot JSONB,
  p_ownership_token_hash TEXT,
  p_lookup_token_hash TEXT
)
RETURNS TABLE (
  hold_id UUID,
  reservation_id UUID,
  booking_reference TEXT,
  expires_at TIMESTAMPTZ,
  status reservation_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_staff staff_profiles%ROWTYPE;
  v_result RECORD;
BEGIN
  SELECT * INTO v_staff
  FROM staff_profiles sp
  WHERE sp.id = p_staff_id
    AND sp.is_active = true;

  IF NOT FOUND OR v_staff.role NOT IN ('super_admin', 'manager', 'reception_staff') THEN
    RAISE EXCEPTION 'FORBIDDEN: Caller is not an authorized active staff member';
  END IF;

  SELECT * INTO v_result
  FROM acquire_court_hold_and_pending_booking(
    p_facility_id,
    p_court_number,
    p_start_at,
    p_end_at,
    p_customer_name,
    p_customer_mobile,
    p_customer_email,
    p_special_requests,
    'walkin-' || p_staff_id::text,
    p_hourly_rate_centavos,
    p_total_centavos,
    p_pricing_snapshot,
    p_ownership_token_hash,
    p_lookup_token_hash
  );

  UPDATE reservations
  SET source = 'walk_in',
      created_by_staff_id = p_staff_id
  WHERE id = v_result.reservation_id;

  INSERT INTO booking_audit_logs (
    facility_id, reservation_id, hold_id, actor_type, actor_id, event_type, payload
  )
  VALUES (
    p_facility_id, v_result.reservation_id, v_result.hold_id, 'staff', p_staff_id,
    'staff_walkin_hold_created',
    jsonb_build_object('booking_reference', v_result.booking_reference, 'staff_role', v_staff.role)
  );

  RETURN QUERY SELECT v_result.hold_id, v_result.reservation_id, v_result.booking_reference, v_result.expires_at, v_result.status;
END;
$$;

REVOKE ALL ON FUNCTION staff_create_walkin_hold(
  UUID, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_create_walkin_hold(
  UUID, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, JSONB, TEXT, TEXT
) TO service_role;

COMMIT;
