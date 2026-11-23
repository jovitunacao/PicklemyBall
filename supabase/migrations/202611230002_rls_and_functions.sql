-- Pick My Ball – Astoria Regency
-- Stage 3 Migration 0002: Row Level Security Policies & Transactional RPC Functions
-- Hardens SECURITY DEFINER functions with explicit search_path and restricted EXECUTE grants.

BEGIN;

-- ---------------------------------------------------------------------------
-- Enable Row Level Security on all tables
-- ---------------------------------------------------------------------------
ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE courts ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_map_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_audit_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Staff Authorization Helpers (SECURITY DEFINER + pinned search_path)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_active_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM staff_profiles sp
    WHERE sp.id = auth.uid()
      AND sp.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION has_staff_role(allowed_roles staff_role[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM staff_profiles sp
    WHERE sp.id = auth.uid()
      AND sp.is_active = true
      AND sp.role = ANY(allowed_roles)
  );
$$;

REVOKE ALL ON FUNCTION is_active_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION has_staff_role(staff_role[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_active_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION has_staff_role(staff_role[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Public Read Policies (Non-sensitive facility/court metadata only)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public read active facilities" ON facilities;
CREATE POLICY "Public read active facilities" ON facilities
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "Public read facility settings" ON facility_settings;
CREATE POLICY "Public read facility settings" ON facility_settings
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Public read courts" ON courts;
CREATE POLICY "Public read courts" ON courts
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Public read court map regions" ON court_map_regions;
CREATE POLICY "Public read court map regions" ON court_map_regions
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Public read operating hours" ON operating_hours;
CREATE POLICY "Public read operating hours" ON operating_hours
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Public read active pricing rules" ON pricing_rules;
CREATE POLICY "Public read active pricing rules" ON pricing_rules
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "Public read active maintenance windows" ON court_maintenance;
CREATE POLICY "Public read active maintenance windows" ON court_maintenance
  FOR SELECT TO anon, authenticated
  USING (is_active = true);

-- ---------------------------------------------------------------------------
-- Staff Admin Write & Operational Read Policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers update facility settings" ON facility_settings;
CREATE POLICY "Managers update facility settings" ON facility_settings
  FOR ALL TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]))
  WITH CHECK (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Managers manage courts" ON courts;
CREATE POLICY "Managers manage courts" ON courts
  FOR ALL TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]))
  WITH CHECK (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Managers manage operating hours" ON operating_hours;
CREATE POLICY "Managers manage operating hours" ON operating_hours
  FOR ALL TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]))
  WITH CHECK (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Managers manage pricing rules" ON pricing_rules;
CREATE POLICY "Managers manage pricing rules" ON pricing_rules
  FOR ALL TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]))
  WITH CHECK (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Managers manage court maintenance" ON court_maintenance;
CREATE POLICY "Managers manage court maintenance" ON court_maintenance
  FOR ALL TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]))
  WITH CHECK (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Staff read customers" ON customers;
CREATE POLICY "Staff read customers" ON customers
  FOR SELECT TO authenticated
  USING (is_active_staff());

DROP POLICY IF EXISTS "Staff read reservations" ON reservations;
CREATE POLICY "Staff read reservations" ON reservations
  FOR SELECT TO authenticated
  USING (is_active_staff());

DROP POLICY IF EXISTS "Staff read holds" ON reservation_holds;
CREATE POLICY "Staff read holds" ON reservation_holds
  FOR SELECT TO authenticated
  USING (is_active_staff());

DROP POLICY IF EXISTS "Managers read payment intents" ON payment_intents;
CREATE POLICY "Managers read payment intents" ON payment_intents
  FOR SELECT TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Managers read audit logs" ON booking_audit_logs;
CREATE POLICY "Managers read audit logs" ON booking_audit_logs
  FOR SELECT TO authenticated
  USING (has_staff_role(ARRAY['super_admin', 'manager']::staff_role[]));

DROP POLICY IF EXISTS "Staff read own profile or super admin reads all" ON staff_profiles;
CREATE POLICY "Staff read own profile or super admin reads all" ON staff_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR has_staff_role(ARRAY['super_admin']::staff_role[]));

DROP POLICY IF EXISTS "Super admin manages staff profiles" ON staff_profiles;
CREATE POLICY "Super admin manages staff profiles" ON staff_profiles
  FOR ALL TO authenticated
  USING (has_staff_role(ARRAY['super_admin']::staff_role[]))
  WITH CHECK (has_staff_role(ARRAY['super_admin']::staff_role[]));

-- Note: No direct anon INSERT/UPDATE/DELETE policies exist on customers,
-- reservations, reservation_holds, payment_intents, or booking_audit_logs.
-- Public operations route through controlled backend/RPC endpoints below.

-- ---------------------------------------------------------------------------
-- Collision-Resistant Booking Reference Generator (PMB-YYYYMMDD-XXXX)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_booking_reference(p_manila_date DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alphabet CONSTANT TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_date_part TEXT := to_char(p_manila_date, 'YYYYMMDD');
  v_suffix TEXT;
  v_candidate TEXT;
  v_bytes BYTEA;
  v_idx INTEGER;
  v_attempt INTEGER := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    v_bytes := gen_random_bytes(6);
    v_suffix := '';
    FOR i IN 0..3 LOOP
      v_idx := (get_byte(v_bytes, i) % length(v_alphabet)) + 1;
      v_suffix := v_suffix || substr(v_alphabet, v_idx, 1);
    END LOOP;
    IF v_attempt > 8 THEN
      v_suffix := v_suffix || substr(v_alphabet, (get_byte(v_bytes, 4) % length(v_alphabet)) + 1, 1);
    END IF;

    v_candidate := 'PMB-' || v_date_part || '-' || v_suffix;
    IF NOT EXISTS (SELECT 1 FROM reservations r WHERE r.booking_reference = v_candidate) THEN
      RETURN v_candidate;
    END IF;

    IF v_attempt >= 25 THEN
      RAISE EXCEPTION 'Unable to allocate unique booking reference after 25 attempts';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION generate_booking_reference(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_booking_reference(DATE) TO service_role;

-- ---------------------------------------------------------------------------
-- Public Non-PII Availability Query (returns only court status per interval)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_public_court_availability(
  p_facility_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ
)
RETURNS TABLE (
  court_id UUID,
  court_number INTEGER,
  status TEXT,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_range TSTZRANGE;
BEGIN
  IF p_end_at <= p_start_at THEN
    RAISE EXCEPTION 'End time must be after start time';
  END IF;

  v_range := tstzrange(p_start_at, p_end_at, '[)');

  RETURN QUERY
  SELECT
    c.id AS court_id,
    c.court_number,
    CASE
      WHEN c.status <> 'active' THEN 'maintenance'
      WHEN EXISTS (
        SELECT 1 FROM court_maintenance cm
        WHERE cm.court_id = c.id
          AND cm.is_active = true
          AND cm.time_slot && v_range
      ) THEN 'maintenance'
      WHEN EXISTS (
        SELECT 1 FROM reservations res
        WHERE res.court_id = c.id
          AND res.status IN ('confirmed', 'completed', 'payment_review_required')
          AND res.time_slot && v_range
      ) THEN 'booked'
      WHEN EXISTS (
        SELECT 1 FROM reservations res
        WHERE res.court_id = c.id
          AND res.status = 'pending_payment'
          AND res.time_slot && v_range
          AND (
            res.hold_id IS NULL
            OR EXISTS (
              SELECT 1 FROM reservation_holds rh
              WHERE rh.id = res.hold_id
                AND rh.status = 'active'
                AND rh.expires_at > now()
            )
          )
      ) THEN 'held'
      WHEN EXISTS (
        SELECT 1 FROM reservation_holds rh
        WHERE rh.court_id = c.id
          AND rh.status = 'active'
          AND rh.expires_at > now()
          AND rh.time_slot && v_range
      ) THEN 'held'
      ELSE 'available'
    END AS status,
    CASE
      WHEN c.status <> 'active' THEN 'Court is currently unavailable.'
      WHEN EXISTS (
        SELECT 1 FROM court_maintenance cm
        WHERE cm.court_id = c.id
          AND cm.is_active = true
          AND cm.time_slot && v_range
      ) THEN 'Scheduled facility maintenance during requested interval.'
      WHEN EXISTS (
        SELECT 1 FROM reservations res
        WHERE res.court_id = c.id
          AND res.status IN ('confirmed', 'completed', 'payment_review_required')
          AND res.time_slot && v_range
      ) THEN 'Already booked for the selected time.'
      WHEN EXISTS (
        SELECT 1 FROM reservation_holds rh
        WHERE rh.court_id = c.id
          AND rh.status = 'active'
          AND rh.expires_at > now()
          AND rh.time_slot && v_range
      ) THEN 'Temporarily held while another player completes checkout.'
      ELSE 'Available for reservation.'
    END AS reason
  FROM courts c
  WHERE c.facility_id = p_facility_id
  ORDER BY c.display_order ASC;
END;
$$;

REVOKE ALL ON FUNCTION get_public_court_availability(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_public_court_availability(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Expire Stale Holds Safely (called by cron or opportunistically in RPC)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_expired_holds(p_court_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expired_count INTEGER := 0;
BEGIN
  WITH expired_holds AS (
    UPDATE reservation_holds rh
    SET status = 'expired'
    WHERE rh.status = 'active'
      AND rh.expires_at <= now()
      AND (p_court_id IS NULL OR rh.court_id = p_court_id)
    RETURNING rh.id
  ),
  expired_reservations AS (
    UPDATE reservations r
    SET status = 'expired'
    FROM expired_holds eh
    WHERE r.hold_id = eh.id
      AND r.status = 'pending_payment'
    RETURNING r.id
  )
  SELECT count(*) INTO v_expired_count FROM expired_holds;

  RETURN v_expired_count;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_expired_holds(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_expired_holds(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Transactional Hold + Pending Reservation Acquisition (Concurrency-Safe)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION acquire_court_hold_and_pending_booking(
  p_facility_id UUID,
  p_court_number INTEGER,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_customer_name TEXT,
  p_customer_mobile TEXT,
  p_customer_email TEXT,
  p_special_requests TEXT,
  p_session_key TEXT,
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
  v_court courts%ROWTYPE;
  v_settings facility_settings%ROWTYPE;
  v_range TSTZRANGE;
  v_duration_minutes INTEGER;
  v_manila_date DATE;
  v_expires_at TIMESTAMPTZ;
  v_customer_id UUID;
  v_hold_id UUID;
  v_reservation_id UUID;
  v_booking_ref TEXT;
BEGIN
  IF p_end_at <= p_start_at THEN
    RAISE EXCEPTION 'INVALID_INTERVAL: End time must be after start time';
  END IF;

  IF p_start_at <= now() THEN
    RAISE EXCEPTION 'PAST_BOOKING_REJECTED: Cannot reserve a slot in the past';
  END IF;

  v_duration_minutes := EXTRACT(EPOCH FROM (p_end_at - p_start_at))::INTEGER / 60;
  v_range := tstzrange(p_start_at, p_end_at, '[)');
  v_manila_date := (p_start_at AT TIME ZONE 'Asia/Manila')::DATE;

  SELECT * INTO v_settings FROM facility_settings fs WHERE fs.facility_id = p_facility_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FACILITY_NOT_FOUND: Missing facility settings';
  END IF;

  IF v_duration_minutes < v_settings.min_booking_duration_minutes
     OR v_duration_minutes > v_settings.max_booking_duration_minutes
  THEN
    RAISE EXCEPTION 'INVALID_DURATION: Duration outside configured bounds';
  END IF;

  IF v_manila_date > ((now() AT TIME ZONE 'Asia/Manila')::DATE + v_settings.max_advance_booking_days) THEN
    RAISE EXCEPTION 'ADVANCE_LIMIT_EXCEEDED: Booking exceeds max advance booking window';
  END IF;

  SELECT * INTO v_court
  FROM courts c
  WHERE c.facility_id = p_facility_id
    AND c.court_number = p_court_number;

  IF NOT FOUND OR v_court.status <> 'active' THEN
    RAISE EXCEPTION 'COURT_UNAVAILABLE: Court % is not open for bookings', p_court_number;
  END IF;

  -- Serialize concurrent hold attempts on this specific court for the transaction
  PERFORM pg_advisory_xact_lock(hashtext('pmb_court_' || v_court.id::text));

  -- Clean up any expired holds on this court first (safe without NOW() partial index)
  PERFORM cleanup_expired_holds(v_court.id);

  -- 1. Check maintenance overlap
  IF EXISTS (
    SELECT 1 FROM court_maintenance cm
    WHERE cm.court_id = v_court.id
      AND cm.is_active = true
      AND cm.time_slot && v_range
  ) THEN
    RAISE EXCEPTION 'COURT_MAINTENANCE: Court % is closed for maintenance in this interval', p_court_number;
  END IF;

  -- 2. Check existing active/confirmed reservation overlap
  IF EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.court_id = v_court.id
      AND r.status IN ('pending_payment', 'confirmed', 'completed', 'payment_review_required')
      AND r.time_slot && v_range
  ) THEN
    RAISE EXCEPTION 'BOOKING_CONFLICT: Court % is already reserved or held for this interval', p_court_number;
  END IF;

  -- 3. Check unexpired standalone hold overlap
  IF EXISTS (
    SELECT 1 FROM reservation_holds rh
    WHERE rh.court_id = v_court.id
      AND rh.status = 'active'
      AND rh.expires_at > now()
      AND rh.time_slot && v_range
  ) THEN
    RAISE EXCEPTION 'HOLD_CONFLICT: Court % is currently held by another player in checkout', p_court_number;
  END IF;

  v_expires_at := now() + make_interval(mins => v_settings.hold_duration_minutes);
  v_booking_ref := generate_booking_reference(v_manila_date);

  INSERT INTO customers (full_name, mobile_number, email)
  VALUES (trim(p_customer_name), trim(p_customer_mobile), lower(trim(p_customer_email)))
  RETURNING id INTO v_customer_id;

  INSERT INTO reservation_holds (
    facility_id, court_id, customer_id, session_key, ownership_token_hash,
    start_at, end_at, expires_at, status,
    quoted_hourly_rate_centavos, quoted_total_centavos, pricing_snapshot
  )
  VALUES (
    p_facility_id, v_court.id, v_customer_id, p_session_key, p_ownership_token_hash,
    p_start_at, p_end_at, v_expires_at, 'active',
    p_hourly_rate_centavos, p_total_centavos, p_pricing_snapshot
  )
  RETURNING id INTO v_hold_id;

  INSERT INTO reservations (
    booking_reference, facility_id, court_id, customer_id, hold_id, lookup_token_hash,
    start_at, end_at, duration_minutes,
    hourly_rate_snapshot_centavos, total_amount_centavos, pricing_snapshot,
    status, source, special_requests
  )
  VALUES (
    v_booking_ref, p_facility_id, v_court.id, v_customer_id, v_hold_id, p_lookup_token_hash,
    p_start_at, p_end_at, v_duration_minutes,
    p_hourly_rate_centavos, p_total_centavos, p_pricing_snapshot,
    'pending_payment', 'online_guest', NULLIF(trim(COALESCE(p_special_requests, '')), '')
  )
  RETURNING id INTO v_reservation_id;

  INSERT INTO payment_intents (reservation_id, provider, amount_centavos, currency, status)
  VALUES (v_reservation_id, 'hitpay', p_total_centavos, 'PHP', 'created');

  INSERT INTO booking_audit_logs (facility_id, reservation_id, hold_id, actor_type, event_type, payload)
  VALUES (
    p_facility_id, v_reservation_id, v_hold_id, 'guest', 'hold_and_pending_booking_created',
    jsonb_build_object(
      'court_number', p_court_number,
      'booking_reference', v_booking_ref,
      'expires_at', v_expires_at,
      'total_centavos', p_total_centavos
    )
  );

  RETURN QUERY SELECT v_hold_id, v_reservation_id, v_booking_ref, v_expires_at, 'pending_payment'::reservation_status;
END;
$$;

REVOKE ALL ON FUNCTION acquire_court_hold_and_pending_booking(
  UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION acquire_court_hold_and_pending_booking(
  UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, JSONB, TEXT, TEXT
) TO service_role;

-- ---------------------------------------------------------------------------
-- Secure Token-Gated Booking Lookup (Never reveals PII on reference alone)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_booking_secure(
  p_booking_reference TEXT,
  p_lookup_token_hash TEXT
)
RETURNS TABLE (
  booking_reference TEXT,
  court_number INTEGER,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  total_amount_centavos INTEGER,
  reservation_status reservation_status,
  payment_status payment_intent_status,
  hold_expires_at TIMESTAMPTZ,
  customer_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM cleanup_expired_holds(NULL);

  RETURN QUERY
  SELECT
    r.booking_reference,
    c.court_number,
    r.start_at,
    r.end_at,
    r.duration_minutes,
    r.total_amount_centavos,
    r.status AS reservation_status,
    COALESCE(pi.status, 'created'::payment_intent_status) AS payment_status,
    rh.expires_at AS hold_expires_at,
    cust.full_name AS customer_name
  FROM reservations r
  JOIN courts c ON c.id = r.court_id
  JOIN customers cust ON cust.id = r.customer_id
  LEFT JOIN reservation_holds rh ON rh.id = r.hold_id
  LEFT JOIN LATERAL (
    SELECT p.status
    FROM payment_intents p
    WHERE p.reservation_id = r.id
    ORDER BY p.created_at DESC
    LIMIT 1
  ) pi ON true
  WHERE upper(trim(r.booking_reference)) = upper(trim(p_booking_reference))
    AND r.lookup_token_hash = p_lookup_token_hash
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION lookup_booking_secure(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_booking_secure(TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- Token-Authenticated Hold Release / Pending Booking Cancellation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_booking_with_token(
  p_booking_reference TEXT,
  p_token_hash TEXT,
  p_reason TEXT DEFAULT 'Cancelled by customer'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res reservations%ROWTYPE;
BEGIN
  SELECT r.* INTO v_res
  FROM reservations r
  LEFT JOIN reservation_holds rh ON rh.id = r.hold_id
  WHERE upper(trim(r.booking_reference)) = upper(trim(p_booking_reference))
    AND (r.lookup_token_hash = p_token_hash OR rh.ownership_token_hash = p_token_hash)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_res.status IN ('cancelled', 'expired', 'completed') THEN
    RETURN false;
  END IF;

  UPDATE reservations
  SET status = 'cancelled',
      cancelled_at = now(),
      cancellation_reason = COALESCE(NULLIF(trim(p_reason), ''), 'Cancelled by customer')
  WHERE id = v_res.id;

  IF v_res.hold_id IS NOT NULL THEN
    UPDATE reservation_holds
    SET status = 'released'
    WHERE id = v_res.hold_id
      AND status = 'active';
  END IF;

  INSERT INTO booking_audit_logs (facility_id, reservation_id, hold_id, actor_type, event_type, payload)
  VALUES (
    v_res.facility_id, v_res.id, v_res.hold_id, 'guest', 'reservation_cancelled',
    jsonb_build_object('reason', p_reason)
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION cancel_booking_with_token(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_booking_with_token(TEXT, TEXT, TEXT) TO service_role;

COMMIT;
