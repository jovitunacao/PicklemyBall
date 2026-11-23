-- Pick My Ball – Astoria Regency
-- Stage 3 Migration 0001: Core Normalized Schema, Constraints & Exclusion Locks
-- Timezone: Asia/Manila | Currency: PHP (integer centavos)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Enum Types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE staff_role AS ENUM ('super_admin', 'manager', 'reception_staff');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE court_operational_status AS ENUM ('active', 'maintenance', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reservation_status AS ENUM (
    'pending_payment',
    'confirmed',
    'cancelled',
    'expired',
    'completed',
    'payment_review_required'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reservation_source AS ENUM ('online_guest', 'online_member', 'walk_in');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hold_status AS ENUM ('active', 'converted', 'released', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_intent_status AS ENUM (
    'created',
    'pending',
    'paid',
    'failed',
    'expired',
    'cancelled',
    'refund_pending',
    'refunded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 1. facilities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Philippines',
  timezone TEXT NOT NULL DEFAULT 'Asia/Manila',
  currency TEXT NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. facility_settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facility_settings (
  facility_id UUID PRIMARY KEY REFERENCES facilities(id) ON DELETE CASCADE,
  hold_duration_minutes INTEGER NOT NULL DEFAULT 10 CHECK (hold_duration_minutes BETWEEN 3 AND 60),
  max_advance_booking_days INTEGER NOT NULL DEFAULT 30 CHECK (max_advance_booking_days BETWEEN 1 AND 365),
  min_booking_duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (min_booking_duration_minutes >= 30 AND min_booking_duration_minutes % 30 = 0),
  max_booking_duration_minutes INTEGER NOT NULL DEFAULT 180 CHECK (max_booking_duration_minutes >= min_booking_duration_minutes AND max_booking_duration_minutes % 30 = 0),
  slot_granularity_minutes INTEGER NOT NULL DEFAULT 60 CHECK (slot_granularity_minutes IN (30, 60)),
  allow_guest_checkout BOOLEAN NOT NULL DEFAULT true,
  deposit_enabled BOOLEAN NOT NULL DEFAULT false,
  deposit_percent SMALLINT NOT NULL DEFAULT 100 CHECK (deposit_percent BETWEEN 10 AND 100),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. courts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  court_number INTEGER NOT NULL CHECK (court_number BETWEEN 1 AND 14),
  name TEXT NOT NULL,
  zone TEXT NOT NULL CHECK (zone IN ('left_1_4', 'right_5_10', 'lower_11_14')),
  orientation TEXT NOT NULL CHECK (orientation IN ('landscape', 'portrait')),
  surface_type TEXT NOT NULL DEFAULT 'Tournament Acrylic',
  is_covered BOOLEAN NOT NULL DEFAULT false,
  status court_operational_status NOT NULL DEFAULT 'active',
  display_order INTEGER NOT NULL CHECK (display_order > 0),
  base_hourly_rate_centavos INTEGER NOT NULL CHECK (base_hourly_rate_centavos >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (facility_id, court_number),
  UNIQUE (facility_id, display_order)
);

-- ---------------------------------------------------------------------------
-- 4. court_map_regions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_map_regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id UUID NOT NULL UNIQUE REFERENCES courts(id) ON DELETE CASCADE,
  viewbox_width INTEGER NOT NULL DEFAULT 941 CHECK (viewbox_width > 0),
  viewbox_height INTEGER NOT NULL DEFAULT 1600 CHECK (viewbox_height > 0),
  polygon_points JSONB NOT NULL,
  label_anchor JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 5. operating_hours
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operating_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  override_date DATE,
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_closed = true OR close_time > open_time),
  CHECK (
    (day_of_week IS NOT NULL AND override_date IS NULL)
    OR (day_of_week IS NULL AND override_date IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operating_hours_dow
  ON operating_hours (facility_id, day_of_week)
  WHERE day_of_week IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operating_hours_override
  ON operating_hours (facility_id, override_date)
  WHERE override_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. pricing_rules (integer centavos; no client-trusted totals)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  court_id UUID REFERENCES courts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('standard', 'weekend', 'peak', 'promo')),
  day_scope TEXT NOT NULL DEFAULT 'all' CHECK (day_scope IN ('all', 'weekday', 'weekend')),
  start_time TIME,
  end_time TIME,
  rate_centavos INTEGER CHECK (rate_centavos IS NULL OR rate_centavos >= 0),
  discount_percent SMALLINT NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  priority INTEGER NOT NULL DEFAULT 10,
  is_active BOOLEAN NOT NULL DEFAULT true,
  valid_from DATE,
  valid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (start_time IS NULL AND end_time IS NULL)
    OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  ),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_pricing_rules_lookup
  ON pricing_rules (facility_id, is_active, priority DESC);

-- ---------------------------------------------------------------------------
-- 7. customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) >= 2),
  mobile_number TEXT NOT NULL CHECK (char_length(trim(mobile_number)) >= 7),
  email TEXT NOT NULL CHECK (position('@' IN email) > 1),
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (lower(email));
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);

-- ---------------------------------------------------------------------------
-- 8. reservation_holds
--    Expiration is checked transactionally + via pg_advisory_xact_lock,
--    avoiding non-immutable NOW() in partial index predicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservation_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  court_id UUID NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  session_key TEXT NOT NULL,
  ownership_token_hash TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  time_slot TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  expires_at TIMESTAMPTZ NOT NULL,
  status hold_status NOT NULL DEFAULT 'active',
  quoted_hourly_rate_centavos INTEGER NOT NULL CHECK (quoted_hourly_rate_centavos >= 0),
  quoted_total_centavos INTEGER NOT NULL CHECK (quoted_total_centavos >= 0),
  pricing_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_reservation_holds_court_active
  ON reservation_holds (court_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_reservation_holds_gist
  ON reservation_holds USING gist (court_id, time_slot);

-- ---------------------------------------------------------------------------
-- 9. reservations (GiST exclusion prevents overlapping active/confirmed slots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_reference TEXT NOT NULL UNIQUE CHECK (booking_reference ~ '^PMB-[0-9]{8}-[A-Z0-9]{4,8}$'),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  court_id UUID NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  hold_id UUID UNIQUE REFERENCES reservation_holds(id) ON DELETE SET NULL,
  lookup_token_hash TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  time_slot TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 30 = 0),
  hourly_rate_snapshot_centavos INTEGER NOT NULL CHECK (hourly_rate_snapshot_centavos >= 0),
  total_amount_centavos INTEGER NOT NULL CHECK (total_amount_centavos >= 0),
  pricing_snapshot JSONB NOT NULL,
  status reservation_status NOT NULL DEFAULT 'pending_payment',
  source reservation_source NOT NULL DEFAULT 'online_guest',
  special_requests TEXT,
  created_by_staff_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CONSTRAINT excl_reservations_no_overlap EXCLUDE USING gist (
    court_id WITH =,
    time_slot WITH &&
  ) WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'payment_review_required'))
);

CREATE INDEX IF NOT EXISTS idx_reservations_facility_start
  ON reservations (facility_id, start_at);

CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations (status);

CREATE INDEX IF NOT EXISTS idx_reservations_customer
  ON reservations (customer_id);

-- ---------------------------------------------------------------------------
-- 10. court_maintenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  court_id UUID NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  time_slot TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) >= 3),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_court_maintenance_gist
  ON court_maintenance USING gist (court_id, time_slot)
  WHERE (is_active = true);

-- ---------------------------------------------------------------------------
-- 11. staff_profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role staff_role NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 12. payment_intents (provider-neutral foundation for Stage 5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'hitpay',
  provider_reference TEXT UNIQUE,
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos >= 0),
  currency TEXT NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
  status payment_intent_status NOT NULL DEFAULT 'created',
  checkout_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_reservation
  ON payment_intents (reservation_id);

-- ---------------------------------------------------------------------------
-- 13. booking_audit_logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  hold_id UUID REFERENCES reservation_holds(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'guest', 'staff', 'webhook')),
  actor_id UUID,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_audit_logs_res
  ON booking_audit_logs (reservation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at + Reservation State Machine + Financial Snapshot Lock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'facilities',
    'facility_settings',
    'courts',
    'court_map_regions',
    'operating_hours',
    'pricing_rules',
    'customers',
    'reservation_holds',
    'reservations',
    'court_maintenance',
    'staff_profiles',
    'payment_intents'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;', tbl, tbl);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', tbl, tbl);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION enforce_reservation_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_verified_payment BOOLEAN := false;
BEGIN
  -- Prevent mutating financial snapshots after reservation creation
  IF TG_OP = 'UPDATE' THEN
    IF NEW.hourly_rate_snapshot_centavos IS DISTINCT FROM OLD.hourly_rate_snapshot_centavos
       OR NEW.total_amount_centavos IS DISTINCT FROM OLD.total_amount_centavos
       OR NEW.booking_reference IS DISTINCT FROM OLD.booking_reference
    THEN
      RAISE EXCEPTION 'Financial snapshot and booking reference are immutable once created';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      -- Terminal states cannot reopen
      IF OLD.status IN ('cancelled', 'expired', 'completed') THEN
        RAISE EXCEPTION 'Invalid reservation status transition from terminal state % to %', OLD.status, NEW.status;
      END IF;

      -- Allowed edges
      IF OLD.status = 'pending_payment' AND NEW.status NOT IN ('confirmed', 'cancelled', 'expired', 'payment_review_required') THEN
        RAISE EXCEPTION 'Invalid transition from pending_payment to %', NEW.status;
      END IF;

      IF OLD.status = 'confirmed' AND NEW.status NOT IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from confirmed to %', NEW.status;
      END IF;

      IF OLD.status = 'payment_review_required' AND NEW.status NOT IN ('confirmed', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from payment_review_required to %', NEW.status;
      END IF;

      -- Stage 4 / Stage 5 safeguard: confirmation requires verified payment evidence
      -- (or authorized Stage 5 webhook/walk-in session context + paid intent)
      IF NEW.status = 'confirmed' THEN
        SELECT EXISTS (
          SELECT 1
          FROM payment_intents pi
          WHERE pi.reservation_id = NEW.id
            AND pi.status = 'paid'
            AND pi.verified_at IS NOT NULL
        ) INTO v_has_verified_payment;

        IF current_setting('pmb.allow_verified_confirmation', true) IS DISTINCT FROM 'true'
           OR NOT v_has_verified_payment
        THEN
          RAISE EXCEPTION 'Reservation cannot be confirmed without verified payment evidence';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reservations_integrity ON reservations;
CREATE TRIGGER trg_reservations_integrity
  BEFORE UPDATE ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_reservation_integrity();

COMMIT;
