export type StaffRoleDb = 'super_admin' | 'manager' | 'reception_staff';

export type CourtOperationalStatusDb = 'active' | 'maintenance' | 'closed';

export type ReservationStatusDb =
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'completed'
  | 'payment_review_required';

export type ReservationSourceDb = 'online_guest' | 'online_member' | 'walk_in';

export type HoldStatusDb = 'active' | 'converted' | 'released' | 'expired';

export type PaymentIntentStatusDb =
  | 'created'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'refund_pending'
  | 'refunded';

export interface FacilityRow {
  id: string;
  slug: string;
  name: string;
  address: string;
  city: string;
  country: string;
  timezone: string;
  currency: 'PHP';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FacilitySettingsRow {
  facility_id: string;
  hold_duration_minutes: number;
  max_advance_booking_days: number;
  min_booking_duration_minutes: number;
  max_booking_duration_minutes: number;
  slot_granularity_minutes: number;
  allow_guest_checkout: boolean;
  deposit_enabled: boolean;
  deposit_percent: number;
  updated_by: string | null;
  updated_at: string;
}

export interface CourtRow {
  id: string;
  facility_id: string;
  court_number: number;
  name: string;
  zone: 'left_1_4' | 'right_5_10' | 'lower_11_14';
  orientation: 'landscape' | 'portrait';
  surface_type: string;
  is_covered: boolean;
  status: CourtOperationalStatusDb;
  display_order: number;
  base_hourly_rate_centavos: number;
  created_at: string;
  updated_at: string;
}

export interface PricingRuleRow {
  id: string;
  facility_id: string;
  court_id: string | null;
  name: string;
  rule_type: 'standard' | 'weekend' | 'peak' | 'promo';
  day_scope: 'all' | 'weekday' | 'weekend';
  start_time: string | null;
  end_time: string | null;
  rate_centavos: number | null;
  discount_percent: number;
  priority: number;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
}

export interface OperatingHourRow {
  id: string;
  facility_id: string;
  day_of_week: number | null;
  override_date: string | null;
  open_time: string;
  close_time: string;
  is_closed: boolean;
  notes: string | null;
}

export interface StaffProfileRow {
  id: string;
  facility_id: string;
  full_name: string;
  email: string;
  role: StaffRoleDb;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PublicAvailabilityRow {
  court_id: string;
  court_number: number;
  status: 'available' | 'booked' | 'held' | 'maintenance';
  reason: string;
}

export interface SecureLookupResult {
  booking_reference: string;
  court_number: number;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  total_amount_centavos: number;
  reservation_status: ReservationStatusDb;
  payment_status: PaymentIntentStatusDb;
  hold_expires_at: string | null;
  customer_name: string;
}
