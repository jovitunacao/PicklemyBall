-- Pick My Ball – Astoria Regency
-- Stage 3 Migration 0003: Facility, 14 Courts, Architectural Map Regions, Hours & Dev Pricing Seed
-- All pricing rules below are development defaults and remain editable via Admin Settings.

BEGIN;

-- 1. Standalone Single-Location Facility
INSERT INTO facilities (id, slug, name, address, city, country, timezone, currency, is_active)
VALUES (
  '11111111-1111-4111-8111-111111111101',
  'astoria-regency',
  'Pick My Ball – Astoria Regency',
  'Astoria Regency, Pasonanca Park',
  'Zamboanga City',
  'Philippines',
  'Asia/Manila',
  'PHP',
  true
)
ON CONFLICT (slug) DO NOTHING;

-- 2. Facility Settings (10-minute default hold, 30-day advance limit)
INSERT INTO facility_settings (
  facility_id,
  hold_duration_minutes,
  max_advance_booking_days,
  min_booking_duration_minutes,
  max_booking_duration_minutes,
  slot_granularity_minutes,
  allow_guest_checkout,
  deposit_enabled,
  deposit_percent
)
VALUES (
  '11111111-1111-4111-8111-111111111101',
  10,
  30,
  60,
  180,
  60,
  true,
  false,
  100
)
ON CONFLICT (facility_id) DO NOTHING;

-- 3. Default Daily Operating Hours (06:00 – 22:00 Asia/Manila)
INSERT INTO operating_hours (facility_id, day_of_week, open_time, close_time, is_closed)
SELECT
  '11111111-1111-4111-8111-111111111101',
  dow,
  '06:00:00'::TIME,
  '22:00:00'::TIME,
  false
FROM generate_series(0, 6) AS dow
ON CONFLICT DO NOTHING;

-- 4. Seed All 14 Pickleball Courts + Exact 941x1600 Architectural Regions
WITH seed_courts(court_number, zone, orientation, x1, y1, x2, y2) AS (
  VALUES
    -- West Wing (Horizontal)
    (1,  'left_1_4',    'landscape', 187, 234,  318, 313),
    (2,  'left_1_4',    'landscape', 187, 368,  318, 445),
    (3,  'left_1_4',    'landscape', 187, 499,  318, 577),
    (4,  'left_1_4',    'landscape', 187, 632,  318, 710),
    -- Upper & Mid-Right 2x3 Block (Vertical)
    (5,  'right_5_10',  'portrait',  406, 236,  474, 372),
    (6,  'right_5_10',  'portrait',  509, 236,  578, 372),
    (7,  'right_5_10',  'portrait',  406, 438,  474, 575),
    (8,  'right_5_10',  'portrait',  509, 438,  578, 575),
    (9,  'right_5_10',  'portrait',  406, 638,  474, 776),
    (10, 'right_5_10',  'portrait',  509, 638,  578, 776),
    -- Lower Clubhouse 2x2 Block (Vertical)
    (11, 'lower_11_14', 'portrait',  337, 872,  426, 1007),
    (12, 'lower_11_14', 'portrait',  471, 872,  561, 1007),
    (13, 'lower_11_14', 'portrait',  337, 1070, 426, 1206),
    (14, 'lower_11_14', 'portrait',  471, 1070, 561, 1206)
),
inserted_courts AS (
  INSERT INTO courts (
    facility_id, court_number, name, zone, orientation,
    surface_type, is_covered, status, display_order, base_hourly_rate_centavos
  )
  SELECT
    '11111111-1111-4111-8111-111111111101',
    sc.court_number,
    'Court ' || sc.court_number,
    sc.zone,
    sc.orientation,
    'Tournament Acrylic',
    false,
    'active'::court_operational_status,
    sc.court_number,
    35000 -- ₱350.00 development default (editable in Admin)
  FROM seed_courts sc
  ON CONFLICT (facility_id, court_number) DO UPDATE
    SET zone = EXCLUDED.zone,
        orientation = EXCLUDED.orientation
  RETURNING id, court_number
)
INSERT INTO court_map_regions (court_id, viewbox_width, viewbox_height, polygon_points, label_anchor)
SELECT
  ic.id,
  941,
  1600,
  jsonb_build_array(
    jsonb_build_object('x', sc.x1, 'y', sc.y1),
    jsonb_build_object('x', sc.x2, 'y', sc.y1),
    jsonb_build_object('x', sc.x2, 'y', sc.y2),
    jsonb_build_object('x', sc.x1, 'y', sc.y2)
  ),
  jsonb_build_object('x', round((sc.x1 + sc.x2) / 2.0), 'y', round((sc.y1 + sc.y2) / 2.0))
FROM inserted_courts ic
JOIN seed_courts sc ON sc.court_number = ic.court_number
ON CONFLICT (court_id) DO UPDATE
  SET polygon_points = EXCLUDED.polygon_points,
      label_anchor = EXCLUDED.label_anchor;

-- 5. Development-Default Pricing Rules (integer centavos)
INSERT INTO pricing_rules (facility_id, name, rule_type, day_scope, start_time, end_time, rate_centavos, priority, is_active)
SELECT * FROM (
  VALUES
    ('11111111-1111-4111-8111-111111111101'::uuid, 'Weekday Daytime (Dev Default)', 'standard', 'weekday', '06:00:00'::time, '17:00:00'::time, 35000, 10, true),
    ('11111111-1111-4111-8111-111111111101'::uuid, 'Weekday Peak Evening (Dev Default)', 'peak', 'weekday', '17:00:00'::time, '21:00:00'::time, 45000, 20, true),
    ('11111111-1111-4111-8111-111111111101'::uuid, 'Weekday Late Evening (Dev Default)', 'standard', 'weekday', '21:00:00'::time, '22:00:00'::time, 35000, 10, true),
    ('11111111-1111-4111-8111-111111111101'::uuid, 'Weekend Daytime (Dev Default)', 'weekend', 'weekend', '06:00:00'::time, '17:00:00'::time, 40000, 15, true),
    ('11111111-1111-4111-8111-111111111101'::uuid, 'Weekend Peak Evening (Dev Default)', 'peak', 'weekend', '17:00:00'::time, '21:00:00'::time, 50000, 25, true),
    ('11111111-1111-4111-8111-111111111101'::uuid, 'Weekend Late Evening (Dev Default)', 'weekend', 'weekend', '21:00:00'::time, '22:00:00'::time, 40000, 15, true)
) AS v(facility_id, name, rule_type, day_scope, start_time, end_time, rate_centavos, priority, is_active)
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_rules pr WHERE pr.facility_id = v.facility_id AND pr.name = v.name
);

COMMIT;
