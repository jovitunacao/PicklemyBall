import { z } from 'zod';
import { isValidDateString, isValidTimeString, parseTimeToMinutes } from './manilaTime.ts';

export const AvailabilityQuerySchema = z.object({
  date: z.string().refine(isValidDateString, 'Invalid YYYY-MM-DD date'),
  startTime: z.string().refine(isValidTimeString, 'Invalid HH:mm start time'),
  durationMinutes: z.coerce.number().int().min(30).max(360),
});

export const CourtScheduleQuerySchema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(14),
  date: z.string().refine(isValidDateString, 'Invalid YYYY-MM-DD date'),
});

export const PricingQuoteBodySchema = AvailabilityQuerySchema.extend({
  courtNumber: z.coerce.number().int().min(1).max(14),
});

export const CreateGuestHoldSchema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(14),
  date: z.string().refine(isValidDateString, 'Invalid YYYY-MM-DD date'),
  startTime: z.string().refine(isValidTimeString, 'Invalid HH:mm start time'),
  durationMinutes: z.coerce.number().int().min(60).max(180),
  customerName: z.string().trim().min(2, 'Full name is required').max(120),
  customerMobile: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid mobile number'),
  customerEmail: z.string().trim().email('Enter a valid email address').max(160),
  specialRequests: z.string().trim().max(400).optional(),
  sessionKey: z.string().trim().min(8).max(120).optional(),
});

export const LookupBookingSchema = z.object({
  bookingReference: z
    .string()
    .trim()
    .regex(/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/i, 'Invalid booking reference format'),
  lookupToken: z.string().trim().min(8, 'Access token is required').max(200),
});

export const CancelBookingSchema = z.object({
  bookingReference: z
    .string()
    .trim()
    .regex(/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/i, 'Invalid booking reference format'),
  token: z.string().trim().min(8, 'Valid ownership or lookup token is required').max(200),
  reason: z.string().trim().max(240).optional(),
});

export const AdminCancelReservationSchema = z.object({
  bookingReference: z
    .string()
    .trim()
    .regex(/^PMB-[0-9]{8}-[A-Z0-9]{4,8}$/i, 'Invalid booking reference format'),
  reason: z.string().trim().min(3, 'Cancellation reason is required').max(240),
});

export const AdminCreateMaintenanceSchema = z
  .object({
    courtNumber: z.coerce.number().int().min(1).max(14),
    startAtIso: z.string().datetime(),
    endAtIso: z.string().datetime(),
    reason: z.string().trim().min(3, 'Maintenance reason is required').max(200),
  })
  .refine((val) => Date.parse(val.endAtIso) > Date.parse(val.startAtIso), {
    message: 'endAtIso must be strictly after startAtIso.',
  });

const SqlTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Time must be HH:mm or HH:mm:ss');

export const AdminCreatePricingRuleSchema = z
  .object({
    courtNumber: z.coerce.number().int().min(1).max(14).nullable().optional(),
    name: z.string().trim().min(2).max(100),
    ruleType: z.enum(['standard', 'weekend', 'peak', 'promo']),
    dayScope: z.enum(['all', 'weekday', 'weekend']).default('all'),
    startTime: SqlTimeSchema.nullable().optional(),
    endTime: SqlTimeSchema.nullable().optional(),
    rateCentavos: z.coerce.number().int().min(0).max(10_000_000).nullable().optional(),
    discountPercent: z.coerce.number().int().min(0).max(100).default(0),
    priority: z.coerce.number().int().min(-100).max(1000).default(10),
    isActive: z.boolean().default(true),
    validFrom: z.string().refine(isValidDateString, 'Invalid validFrom date').nullable().optional(),
    validUntil: z.string().refine(isValidDateString, 'Invalid validUntil date').nullable().optional(),
  })
  .refine(
    (v) =>
      (!v.startTime && !v.endTime) ||
      Boolean(v.startTime && v.endTime && parseTimeToMinutes(v.endTime) > parseTimeToMinutes(v.startTime)),
    { message: 'Both startTime and endTime are required together, and endTime must be after startTime.' },
  )
  .refine((v) => !v.validFrom || !v.validUntil || v.validUntil >= v.validFrom, {
    message: 'validUntil must be on or after validFrom.',
  });

export const AdminPatchPricingSchema = z.union([
  z.object({
    target: z.literal('court_base_rate'),
    courtNumber: z.coerce.number().int().min(1).max(14),
    baseHourlyRateCentavos: z.coerce.number().int().min(1000).max(10_000_000),
  }),
  z.object({
    target: z.literal('pricing_rule'),
    ruleId: z.string().uuid(),
    name: z.string().trim().min(2).max(100).optional(),
    rateCentavos: z.coerce.number().int().min(0).max(10_000_000).nullable().optional(),
    discountPercent: z.coerce.number().int().min(0).max(100).optional(),
    priority: z.coerce.number().int().min(-100).max(1000).optional(),
    isActive: z.boolean().optional(),
  }),
]);

export const AdminUpsertOperatingHourSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6).nullable().optional(),
    overrideDate: z.string().refine(isValidDateString, 'Invalid overrideDate').nullable().optional(),
    openTime: SqlTimeSchema,
    closeTime: SqlTimeSchema,
    isClosed: z.boolean().default(false),
    notes: z.string().trim().max(240).nullable().optional(),
  })
  .refine(
    (v) =>
      (v.dayOfWeek !== null && v.dayOfWeek !== undefined && !v.overrideDate) ||
      ((v.dayOfWeek === null || v.dayOfWeek === undefined) && Boolean(v.overrideDate)),
    { message: 'Provide either dayOfWeek (0-6) OR overrideDate (YYYY-MM-DD), never both.' },
  )
  .refine(
    (v) => v.isClosed || parseTimeToMinutes(v.closeTime) > parseTimeToMinutes(v.openTime),
    { message: 'closeTime must be strictly after openTime when facility is open.' },
  );
