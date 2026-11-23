import { getSupabaseBrowserClient } from '../lib/supabaseClient';
import type {
  CourtRow,
  FacilitySettingsRow,
  OperatingHourRow,
  PricingRuleRow,
} from '../types/database';

export interface PublicFacilityScheduleAndRates {
  source: 'supabase_live' | 'unconfigured';
  courts: Array<
    Pick<
      CourtRow,
      'id' | 'court_number' | 'name' | 'zone' | 'surface_type' | 'status' | 'base_hourly_rate_centavos'
    >
  >;
  pricingRules: PricingRuleRow[];
  operatingHours: OperatingHourRow[];
  facilitySettings: FacilitySettingsRow | null;
  hasInitialSeededRateLabels: boolean;
}

const DEFAULT_FACILITY_ID = '11111111-1111-4111-8111-111111111101';

/**
 * Strips legacy seed "(Dev Default)" suffix from rule display titles without mutating database state.
 */
export function sanitizePricingRuleDisplayName(name: string): string {
  return name.replace(/\s*\(Dev Default\)\s*/gi, '').trim() || name;
}

export async function fetchPublicFacilityScheduleAndRates(): Promise<PublicFacilityScheduleAndRates> {
  const client = getSupabaseBrowserClient();
  if (!client) {
    return {
      source: 'unconfigured',
      courts: [],
      pricingRules: [],
      operatingHours: [],
      facilitySettings: null,
      hasInitialSeededRateLabels: false,
    };
  }

  const [courtsRes, rulesRes, hoursRes, settingsRes] = await Promise.all([
    client
      .from('courts')
      .select('id, court_number, name, zone, surface_type, status, base_hourly_rate_centavos')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .order('court_number', { ascending: true }),
    client
      .from('pricing_rules')
      .select('*')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .eq('is_active', true)
      .order('priority', { ascending: false }),
    client
      .from('operating_hours')
      .select('*')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .order('day_of_week', { ascending: true, nullsFirst: false }),
    client
      .from('facility_settings')
      .select('*')
      .eq('facility_id', DEFAULT_FACILITY_ID)
      .maybeSingle(),
  ]);

  if (courtsRes.error) {
    throw new Error(courtsRes.error.message || 'Unable to load courts configuration from Supabase.');
  }
  if (rulesRes.error) {
    throw new Error(rulesRes.error.message || 'Unable to load pricing rules from Supabase.');
  }
  if (hoursRes.error) {
    throw new Error(hoursRes.error.message || 'Unable to load operating hours from Supabase.');
  }

  const pricingRules = (rulesRes.data ?? []) as PricingRuleRow[];
  const hasInitialSeededRateLabels =
    pricingRules.length === 0 || pricingRules.some((rule) => /dev default/i.test(rule.name));

  return {
    source: 'supabase_live',
    courts: (courtsRes.data ?? []) as PublicFacilityScheduleAndRates['courts'],
    pricingRules,
    operatingHours: (hoursRes.data ?? []) as OperatingHourRow[],
    facilitySettings: (settingsRes.data as FacilitySettingsRow | null) ?? null,
    hasInitialSeededRateLabels,
  };
}
