-- Pick My Ball – Astoria Regency
-- Stage 4 Security Migration 0005: Durable & Atomic QR Check-In Redemptions and Revocations
-- Purpose: Eliminates multi-instance / concurrent double-redemption races and preserves revocations
--          across Cloud Run restarts and horizontal scaling.
-- Note: Additive only; does not alter or rerun migrations 0001–0004.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. qr_checkin_redemptions (Strict Single-Use Ledger per Reservation & JTI)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qr_checkin_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  booking_reference TEXT NOT NULL,
  token_jti TEXT NOT NULL UNIQUE,
  court_number INTEGER NOT NULL CHECK (court_number BETWEEN 1 AND 14),
  redeemed_by_staff_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qr_checkin_redemptions_facility_ref
  ON qr_checkin_redemptions (facility_id, upper(booking_reference));

ALTER TABLE qr_checkin_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff read qr check-in redemptions" ON qr_checkin_redemptions;
CREATE POLICY "Staff read qr check-in redemptions" ON qr_checkin_redemptions
  FOR SELECT TO authenticated
  USING (is_active_staff());

-- ---------------------------------------------------------------------------
-- 2. qr_checkin_revocations (Durable Per-JTI & Reservation-Level Revocations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qr_checkin_revocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  reservation_id UUID REFERENCES reservations(id) ON DELETE CASCADE,
  booking_reference TEXT,
  token_jti TEXT,
  permanent BOOLEAN NOT NULL DEFAULT false,
  revoked_before_epoch BIGINT NOT NULL CHECK (revoked_before_epoch >= 0),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) >= 3),
  revoked_by_staff_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reservation_id IS NOT NULL OR token_jti IS NOT NULL OR booking_reference IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qr_checkin_revocations_jti
  ON qr_checkin_revocations (token_jti)
  WHERE token_jti IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qr_checkin_revocations_res
  ON qr_checkin_revocations (reservation_id, permanent, revoked_before_epoch DESC);

CREATE INDEX IF NOT EXISTS idx_qr_checkin_revocations_ref
  ON qr_checkin_revocations (facility_id, upper(booking_reference))
  WHERE booking_reference IS NOT NULL;

ALTER TABLE qr_checkin_revocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff read qr check-in revocations" ON qr_checkin_revocations;
CREATE POLICY "Staff read qr check-in revocations" ON qr_checkin_revocations
  FOR SELECT TO authenticated
  USING (is_active_staff());

-- ---------------------------------------------------------------------------
-- 3. Issuance Eligibility Guard (Blocks redeemed or permanently revoked bookings)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_qr_checkin_issuance_eligibility(
  p_facility_id UUID,
  p_booking_reference TEXT
)
RETURNS TABLE (
  eligible BOOLEAN,
  code TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res reservations%ROWTYPE;
  v_has_paid BOOLEAN := false;
BEGIN
  SELECT * INTO v_res
  FROM reservations r
  WHERE r.facility_id = p_facility_id
    AND upper(trim(r.booking_reference)) = upper(trim(p_booking_reference))
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'BOOKING_NOT_FOUND'::TEXT,
      format('No facility reservation found matching %s.', trim(p_booking_reference))::TEXT;
    RETURN;
  END IF;

  IF v_res.status <> 'confirmed' THEN
    RETURN QUERY SELECT false, 'QR_NOT_ELIGIBLE'::TEXT,
      'Check-in QR passes are issued only after reservation confirmation.'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM payment_intents pi
    WHERE pi.reservation_id = v_res.id
      AND pi.status = 'paid'
      AND pi.verified_at IS NOT NULL
  ) INTO v_has_paid;

  IF NOT v_has_paid THEN
    RETURN QUERY SELECT false, 'QR_NOT_ELIGIBLE'::TEXT,
      'Check-in QR passes require verified payment confirmation.'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM qr_checkin_redemptions qred
    WHERE qred.reservation_id = v_res.id
  ) THEN
    RETURN QUERY SELECT false, 'CHECKIN_ALREADY_REDEEMED'::TEXT,
      format('Booking %s has already been checked in at reception.', v_res.booking_reference)::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM qr_checkin_revocations qrev
    WHERE qrev.permanent = true
      AND (
        qrev.reservation_id = v_res.id
        OR upper(trim(qrev.booking_reference)) = upper(trim(v_res.booking_reference))
      )
  ) THEN
    RETURN QUERY SELECT false, 'CHECKIN_TOKEN_REVOKED'::TEXT,
      format('Check-in privileges for %s have been permanently revoked.', v_res.booking_reference)::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'OK'::TEXT, NULL::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION check_qr_checkin_issuance_eligibility(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_qr_checkin_issuance_eligibility(UUID, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Atomic Multi-Instance Verification & Single-Use Check-In Redemption RPC
--    Acquires FOR UPDATE row lock on reservations row before checking/inserting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_or_redeem_qr_checkin(
  p_facility_id UUID,
  p_booking_reference TEXT,
  p_court_number INTEGER,
  p_token_jti TEXT,
  p_issued_at_epoch BIGINT,
  p_expires_at TIMESTAMPTZ,
  p_consume BOOLEAN,
  p_staff_id UUID
)
RETURNS TABLE (
  ok BOOLEAN,
  status_code INTEGER,
  code TEXT,
  error_message TEXT,
  consumed BOOLEAN,
  booking_reference TEXT,
  court_number INTEGER,
  customer_name TEXT,
  reservation_status reservation_status,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_caller_uid UUID := auth.uid();
  v_staff staff_profiles%ROWTYPE;
  v_res reservations%ROWTYPE;
  v_assigned_court INTEGER;
  v_customer_name TEXT;
  v_has_paid BOOLEAN := false;
  v_existing_redeemed_at TIMESTAMPTZ;
  v_checked_in_at TIMESTAMPTZ := NULL;
BEGIN
  IF p_staff_id IS NULL THEN
    RETURN QUERY SELECT false, 401, 'UNAUTHORIZED'::TEXT, 'Staff user ID is required.'::TEXT,
      false, p_booking_reference, p_court_number, NULL::TEXT, NULL::reservation_status,
      NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_caller_uid IS NOT NULL AND v_caller_uid IS DISTINCT FROM p_staff_id THEN
    RETURN QUERY SELECT false, 403, 'FORBIDDEN'::TEXT, 'Caller identity does not match staff_id.'::TEXT,
      false, p_booking_reference, p_court_number, NULL::TEXT, NULL::reservation_status,
      NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO v_staff
  FROM staff_profiles sp
  WHERE sp.id = p_staff_id
    AND sp.is_active = true
    AND sp.role IN ('super_admin', 'manager', 'reception_staff');

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 403, 'FORBIDDEN'::TEXT, 'Authenticated user is not an active staff member.'::TEXT,
      false, p_booking_reference, p_court_number, NULL::TEXT, NULL::reservation_status,
      NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Acquire exclusive row lock on the target reservation to serialize all concurrent check-in/revoke calls
  SELECT r.* INTO v_res
  FROM reservations r
  WHERE r.facility_id = p_facility_id
    AND upper(trim(r.booking_reference)) = upper(trim(p_booking_reference))
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 404, 'BOOKING_NOT_FOUND'::TEXT,
      format('No facility reservation found matching %s.', trim(p_booking_reference))::TEXT,
      false, p_booking_reference, p_court_number, NULL::TEXT, NULL::reservation_status,
      NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT c.court_number, cust.full_name
  INTO v_assigned_court, v_customer_name
  FROM courts c
  JOIN customers cust ON cust.id = v_res.customer_id
  WHERE c.id = v_res.court_id;

  IF v_res.status <> 'confirmed' THEN
    RETURN QUERY SELECT false, 403, 'RESERVATION_NOT_CONFIRMED'::TEXT,
      format('Check-in denied: reservation %s has status "%s". Only confirmed reservations can check in.', v_res.booking_reference, v_res.status)::TEXT,
      false, v_res.booking_reference, COALESCE(v_assigned_court, p_court_number), v_customer_name,
      v_res.status, v_res.start_at, v_res.end_at, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM payment_intents pi
    WHERE pi.reservation_id = v_res.id
      AND pi.status = 'paid'
      AND pi.verified_at IS NOT NULL
  ) INTO v_has_paid;

  IF NOT v_has_paid THEN
    RETURN QUERY SELECT false, 403, 'QR_NOT_ELIGIBLE'::TEXT,
      format('Check-in denied: reservation %s does not have verified payment confirmation.', v_res.booking_reference)::TEXT,
      false, v_res.booking_reference, COALESCE(v_assigned_court, p_court_number), v_customer_name,
      v_res.status, v_res.start_at, v_res.end_at, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_assigned_court IS DISTINCT FROM p_court_number THEN
    RETURN QUERY SELECT false, 409, 'COURT_MISMATCH'::TEXT,
      format('Check-in denied: token is for Court %s, but reservation is assigned to Court %s.', p_court_number, v_assigned_court)::TEXT,
      false, v_res.booking_reference, v_assigned_court, v_customer_name,
      v_res.status, v_res.start_at, v_res.end_at, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_now > p_expires_at THEN
    RETURN QUERY SELECT false, 410, 'CHECKIN_TOKEN_EXPIRED'::TEXT,
      'This check-in QR token has expired.'::TEXT,
      false, v_res.booking_reference, v_assigned_court, v_customer_name,
      v_res.status, v_res.start_at, v_res.end_at, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM qr_checkin_revocations qrev
    WHERE qrev.token_jti = p_token_jti
       OR (
         (qrev.reservation_id = v_res.id OR upper(trim(qrev.booking_reference)) = upper(trim(v_res.booking_reference)))
         AND (qrev.permanent = true OR p_issued_at_epoch <= qrev.revoked_before_epoch)
       )
  ) THEN
    RETURN QUERY SELECT false, 403, 'CHECKIN_TOKEN_REVOKED'::TEXT,
      format('Check-in pass for %s has been revoked by facility staff.', v_res.booking_reference)::TEXT,
      false, v_res.booking_reference, v_assigned_court, v_customer_name,
      v_res.status, v_res.start_at, v_res.end_at, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT qred.redeemed_at INTO v_existing_redeemed_at
  FROM qr_checkin_redemptions qred
  WHERE qred.reservation_id = v_res.id
     OR qred.token_jti = p_token_jti
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT false, 409, 'CHECKIN_ALREADY_REDEEMED'::TEXT,
      format('Reservation %s was already checked in at %s.', v_res.booking_reference, v_existing_redeemed_at)::TEXT,
      false, v_res.booking_reference, v_assigned_court, v_customer_name,
      v_res.status, v_res.start_at, v_res.end_at, v_existing_redeemed_at;
    RETURN;
  END IF;

  IF p_consume THEN
    INSERT INTO qr_checkin_redemptions (
      reservation_id,
      facility_id,
      booking_reference,
      token_jti,
      court_number,
      redeemed_by_staff_id,
      redeemed_at,
      expires_at
    )
    VALUES (
      v_res.id,
      v_res.facility_id,
      v_res.booking_reference,
      p_token_jti,
      v_assigned_court,
      p_staff_id,
      v_now,
      p_expires_at
    )
    ON CONFLICT DO NOTHING
    RETURNING redeemed_at INTO v_checked_in_at;

    IF v_checked_in_at IS NULL THEN
      RETURN QUERY SELECT false, 409, 'CHECKIN_ALREADY_REDEEMED'::TEXT,
        format('Reservation %s was already checked in concurrently.', v_res.booking_reference)::TEXT,
        false, v_res.booking_reference, v_assigned_court, v_customer_name,
        v_res.status, v_res.start_at, v_res.end_at, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;

    INSERT INTO booking_audit_logs (
      facility_id, reservation_id, actor_type, actor_id, event_type, payload
    )
    VALUES (
      v_res.facility_id,
      v_res.id,
      'staff',
      p_staff_id,
      'qr_checkin_redeemed',
      jsonb_build_object(
        'booking_reference', v_res.booking_reference,
        'jti', p_token_jti,
        'court_number', v_assigned_court,
        'redeemed_at', v_checked_in_at
      )
    );
  END IF;

  RETURN QUERY SELECT
    true,
    200,
    'OK'::TEXT,
    NULL::TEXT,
    COALESCE(p_consume, false),
    v_res.booking_reference,
    v_assigned_court,
    v_customer_name,
    v_res.status,
    v_res.start_at,
    v_res.end_at,
    v_checked_in_at;
END;
$$;

REVOKE ALL ON FUNCTION verify_or_redeem_qr_checkin(UUID, TEXT, INTEGER, TEXT, BIGINT, TIMESTAMPTZ, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_or_redeem_qr_checkin(UUID, TEXT, INTEGER, TEXT, BIGINT, TIMESTAMPTZ, BOOLEAN, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Atomic Durable QR Revocation RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION revoke_qr_checkin_pass(
  p_facility_id UUID,
  p_booking_reference TEXT DEFAULT NULL,
  p_token_jti TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT 'Revoked by staff',
  p_permanent BOOLEAN DEFAULT false,
  p_revoked_before_epoch BIGINT DEFAULT NULL,
  p_staff_id UUID DEFAULT NULL
)
RETURNS TABLE (
  ok BOOLEAN,
  status_code INTEGER,
  code TEXT,
  error_message TEXT,
  booking_reference TEXT,
  token_jti TEXT,
  revoked_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_epoch BIGINT := COALESCE(p_revoked_before_epoch, FLOOR(EXTRACT(EPOCH FROM v_now))::BIGINT);
  v_caller_uid UUID := auth.uid();
  v_staff staff_profiles%ROWTYPE;
  v_res reservations%ROWTYPE;
  v_has_res BOOLEAN := false;
  v_target_ref TEXT := NULLIF(upper(trim(COALESCE(p_booking_reference, ''))), '');
  v_target_jti TEXT := NULLIF(trim(COALESCE(p_token_jti, '')), '');
  v_clean_reason TEXT := COALESCE(NULLIF(trim(COALESCE(p_reason, '')), ''), 'Revoked by facility staff');
BEGIN
  IF v_target_ref IS NULL AND v_target_jti IS NULL THEN
    RETURN QUERY SELECT false, 400, 'REVOCATION_TARGET_REQUIRED'::TEXT,
      'Provide a booking reference or check-in token JTI to revoke.'::TEXT,
      NULL::TEXT, NULL::TEXT, v_now;
    RETURN;
  END IF;

  IF p_staff_id IS NOT NULL THEN
    IF v_caller_uid IS NOT NULL AND v_caller_uid IS DISTINCT FROM p_staff_id THEN
      RETURN QUERY SELECT false, 403, 'FORBIDDEN'::TEXT, 'Caller identity does not match staff_id.'::TEXT,
        v_target_ref, v_target_jti, v_now;
      RETURN;
    END IF;

    SELECT * INTO v_staff
    FROM staff_profiles sp
    WHERE sp.id = p_staff_id
      AND sp.is_active = true
      AND sp.role IN ('super_admin', 'manager', 'reception_staff');

    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 403, 'FORBIDDEN'::TEXT, 'Authenticated user is not an active staff member.'::TEXT,
        v_target_ref, v_target_jti, v_now;
      RETURN;
    END IF;

    IF p_permanent AND v_staff.role = 'reception_staff' THEN
      RETURN QUERY SELECT false, 403, 'FORBIDDEN'::TEXT,
        'Manager or Super Admin role is required to permanently revoke check-in privileges.'::TEXT,
        v_target_ref, v_target_jti, v_now;
      RETURN;
    END IF;
  END IF;

  IF v_target_ref IS NOT NULL THEN
    SELECT r.* INTO v_res
    FROM reservations r
    WHERE r.facility_id = p_facility_id
      AND upper(trim(r.booking_reference)) = v_target_ref
    FOR UPDATE OF r;

    v_has_res := FOUND;
    IF v_has_res THEN
      v_target_ref := v_res.booking_reference;
    END IF;
  END IF;

  IF NOT v_has_res AND v_target_jti IS NULL THEN
    RETURN QUERY SELECT false, 404, 'BOOKING_NOT_FOUND'::TEXT,
      format('No facility reservation found matching %s.', COALESCE(v_target_ref, ''))::TEXT,
      v_target_ref, NULL::TEXT, v_now;
    RETURN;
  END IF;

  INSERT INTO qr_checkin_revocations (
    facility_id,
    reservation_id,
    booking_reference,
    token_jti,
    permanent,
    revoked_before_epoch,
    reason,
    revoked_by_staff_id
  )
  VALUES (
    CASE WHEN v_has_res THEN v_res.facility_id ELSE p_facility_id END,
    CASE WHEN v_has_res THEN v_res.id ELSE NULL END,
    v_target_ref,
    v_target_jti,
    COALESCE(p_permanent, false),
    v_epoch,
    v_clean_reason,
    p_staff_id
  )
  ON CONFLICT (token_jti) WHERE token_jti IS NOT NULL DO NOTHING;

  INSERT INTO booking_audit_logs (
    facility_id,
    reservation_id,
    actor_type,
    actor_id,
    event_type,
    payload
  )
  VALUES (
    CASE WHEN v_has_res THEN v_res.facility_id ELSE p_facility_id END,
    CASE WHEN v_has_res THEN v_res.id ELSE NULL END,
    CASE WHEN p_staff_id IS NOT NULL THEN 'staff' ELSE 'system' END,
    p_staff_id,
    'qr_checkin_token_revoked',
    jsonb_build_object(
      'booking_reference', v_target_ref,
      'jti', v_target_jti,
      'permanent', COALESCE(p_permanent, false),
      'revoked_before_epoch', v_epoch,
      'reason', v_clean_reason
    )
  );

  RETURN QUERY SELECT true, 200, 'OK'::TEXT, NULL::TEXT, v_target_ref, v_target_jti, v_now;
END;
$$;

REVOKE ALL ON FUNCTION revoke_qr_checkin_pass(UUID, TEXT, TEXT, TEXT, BOOLEAN, BIGINT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_qr_checkin_pass(UUID, TEXT, TEXT, TEXT, BOOLEAN, BIGINT, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Automatic Permanent QR Revocation on Any Reservation Cancellation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_revoke_qr_checkin_on_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    INSERT INTO qr_checkin_revocations (
      facility_id,
      reservation_id,
      booking_reference,
      token_jti,
      permanent,
      revoked_before_epoch,
      reason
    )
    VALUES (
      NEW.facility_id,
      NEW.id,
      NEW.booking_reference,
      NULL,
      true,
      FLOOR(EXTRACT(EPOCH FROM now()))::BIGINT,
      COALESCE(NULLIF(trim(COALESCE(NEW.cancellation_reason, '')), ''), 'reservation_cancelled')
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reservations_auto_revoke_qr ON reservations;
CREATE TRIGGER trg_reservations_auto_revoke_qr
  AFTER UPDATE OF status ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION auto_revoke_qr_checkin_on_cancel();

COMMIT;
