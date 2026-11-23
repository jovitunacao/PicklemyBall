export enum CourtStatus {
  AVAILABLE = 'available',
  BOOKED = 'booked',
  SELECTED = 'selected',
  MAINTENANCE = 'maintenance',
  HELD = 'held',
}

export enum StaffRole {
  SUPER_ADMIN = 'super_admin',
  MANAGER = 'manager',
  RECEPTION_STAFF = 'reception_staff',
}

export enum BookingStatus {
  PENDING_HOLD = 'pending_hold',
  CONFIRMED = 'confirmed',
  CHECKED_IN = 'checked_in',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  NEEDS_RECONCILIATION = 'needs_reconciliation',
}

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  REFUND_PENDING = 'refund_pending',
  REFUNDED = 'refunded',
  CASH_RECEIVED = 'cash_received',
}

export type CourtZone = 'left_1_4' | 'right_5_10' | 'lower_11_14';

export interface CourtPolygonPoint {
  x: number;
  y: number;
}

export interface CourtMapRegion {
  courtId: string;
  courtNumber: number;
  zone: CourtZone;
  /** Normalized SVG viewBox polygon coordinates matching the architectural site plan */
  points: CourtPolygonPoint[];
  labelAnchor: CourtPolygonPoint;
  orientation: 'portrait' | 'landscape';
}

export interface Court {
  id: string;
  courtNumber: number;
  name: string;
  zone: CourtZone;
  surfaceType: string;
  isCovered: boolean;
  isActive: boolean;
  hourlyRatePhp: number;
}

export interface PricingRule {
  id: string;
  name: string;
  dayType: 'weekday' | 'weekend' | 'all';
  startTime: string;
  endTime: string;
  rateMultiplierOrOverridePhp: number;
  isOverride: boolean;
  isActive: boolean;
}

export interface Reservation {
  id: string;
  bookingReference: string;
  courtId: string;
  courtNumber: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  specialRequests?: string;
  bookingDate: string; // YYYY-MM-DD in Asia/Manila
  startTime: string;   // HH:mm (24h)
  endTime: string;     // HH:mm (24h)
  durationMinutes: number;
  hourlyRateSnapshotPhp: number;
  totalAmountPhp: number;
  paymentStatus: PaymentStatus;
  bookingStatus: BookingStatus;
  verificationToken: string;
  createdAt: string;
}
