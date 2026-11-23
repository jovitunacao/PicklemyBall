import { CourtStatus, CourtZone } from '../types/booking';

export const FACILITY_INFO = {
  brandName: 'PICK MY BALL',
  branchName: 'Astoria Regency',
  fullTitle: 'Pick My Ball – Astoria Regency',
  streetAddress: 'Astoria Regency, Pasonanca Park',
  city: 'Zamboanga City',
  country: 'Philippines',
  timezone: 'Asia/Manila',
  currency: 'PHP',
  currencySymbol: '₱',
  totalCourts: 14,
  parkingSlots: 18,
  defaultOperatingHours: '06:00 – 22:00 PHT',
  contactEmail: 'reservations@pickmyball.ph',
  contactPhone: '+63 62 991 0000',
  logoImagePath: '/assets/aistudio/IMG_9413_8eae4d57.jpeg',
  floorPlanImagePath: '/assets/aistudio/IMG_9414_7b770970.jpeg',
  heroImagePath: '/src/assets/images/hero_pickleball_club_1795411342081.jpg',
} as const;

export const COURT_ZONE_SUMMARY: Array<{
  zone: CourtZone;
  label: string;
  range: string;
  count: number;
  description: string;
}> = [
  {
    zone: 'left_1_4',
    label: 'West Wing (Horizontal Courts)',
    range: 'Courts 1 – 4',
    count: 4,
    description:
      'Four horizontally oriented courts stacked along the western perimeter between the upper parking area and the 6.00m drop-off driveway.',
  },
  {
    zone: 'right_5_10',
    label: 'Upper & Mid-Right Block (Vertical Courts)',
    range: 'Courts 5 – 10',
    count: 6,
    description:
      'Six vertically oriented courts arranged in a 2×3 grid (5–6, 7–8, 9–10) beside the 5.75m driveway and upper-right parking slots.',
  },
  {
    zone: 'lower_11_14',
    label: 'Lower Clubhouse Block (Vertical Courts)',
    range: 'Courts 11 – 14',
    count: 4,
    description:
      'Four vertically oriented courts in a 2×2 grid (11–12, 13–14) positioned directly above the Lobby, Reception, Restrooms, and Spectator Rest Area.',
  },
];

export interface CourtStatusVisual {
  status: CourtStatus;
  label: string;
  colorName: string;
  swatchClass: string;
  badgeTextClass: string;
  description: string;
}

export const COURT_STATUS_LEGEND: CourtStatusVisual[] = [
  {
    status: CourtStatus.AVAILABLE,
    label: 'Available',
    colorName: 'Blue',
    swatchClass: 'bg-blue-600/80 border-blue-700',
    badgeTextClass: 'text-blue-700',
    description: 'Open for your selected date, start time, and duration.',
  },
  {
    status: CourtStatus.BOOKED,
    label: 'Booked',
    colorName: 'Red',
    swatchClass: 'bg-red-600/80 border-red-700',
    badgeTextClass: 'text-red-700',
    description: 'Reserved or occupied during the requested interval.',
  },
  {
    status: CourtStatus.SELECTED,
    label: 'Selected',
    colorName: 'Green',
    swatchClass: 'bg-green-600/85 border-green-700',
    badgeTextClass: 'text-green-700',
    description: 'Currently highlighted for your reservation checkout.',
  },
  {
    status: CourtStatus.HELD,
    label: 'Checkout Hold',
    colorName: 'Yellow',
    swatchClass: 'bg-yellow-400/85 border-yellow-600',
    badgeTextClass: 'text-amber-700',
    description: 'Temporarily held while another player completes payment.',
  },
  {
    status: CourtStatus.MAINTENANCE,
    label: 'Unavailable',
    colorName: 'Gray',
    swatchClass: 'bg-slate-500/80 border-slate-600',
    badgeTextClass: 'text-slate-600',
    description: 'Closed for resurfacing, net service, or facility maintenance.',
  },
];

export const SITE_ROUTES = {
  home: '/',
  book: '/book',
  availability: '/availability',
  rates: '/rates',
  about: '/about',
  contact: '/contact',
  confirmation: '/confirmation',
  lookup: '/lookup',
  privacy: '/privacy',
  terms: '/terms',
  adminLogin: '/admin/login',
  adminDashboard: '/admin',
} as const;
