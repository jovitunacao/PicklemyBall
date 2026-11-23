import { CourtMapRegion, CourtPolygonPoint } from '../types/booking';

/**
 * Exact natural pixel dimensions of the official Astoria Regency floor plan
 * (public/assets/aistudio/IMG_9414_7b770970.jpeg, Scale 1:250).
 */
export const FLOOR_PLAN_DIMENSIONS = {
  width: 941,
  height: 1600,
} as const;

function rectPoints(x1: number, y1: number, x2: number, y2: number): CourtPolygonPoint[] {
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

function centerPoint(x1: number, y1: number, x2: number, y2: number): CourtPolygonPoint {
  return {
    x: Math.round((x1 + x2) / 2),
    y: Math.round((y1 + y2) / 2),
  };
}

/**
 * Pixel-calibrated SVG polygon regions for all 14 blue pickleball courts
 * in IMG_9414_7b770970.jpeg (viewBox 0 0 941 1600).
 *
 * - Courts 1–4: West Wing, horizontal/landscape orientation
 * - Courts 5–10: Upper & Mid-Right 2×3 block, vertical/portrait orientation
 * - Courts 11–14: Lower Clubhouse 2×2 block, vertical/portrait orientation
 */
export const COURT_MAP_REGIONS: CourtMapRegion[] = [
  // West Wing (Courts 1–4, landscape)
  {
    courtId: 'court-01',
    courtNumber: 1,
    zone: 'left_1_4',
    orientation: 'landscape',
    points: rectPoints(187, 234, 318, 313),
    labelAnchor: centerPoint(187, 234, 318, 313),
  },
  {
    courtId: 'court-02',
    courtNumber: 2,
    zone: 'left_1_4',
    orientation: 'landscape',
    points: rectPoints(187, 368, 318, 445),
    labelAnchor: centerPoint(187, 368, 318, 445),
  },
  {
    courtId: 'court-03',
    courtNumber: 3,
    zone: 'left_1_4',
    orientation: 'landscape',
    points: rectPoints(187, 499, 318, 577),
    labelAnchor: centerPoint(187, 499, 318, 577),
  },
  {
    courtId: 'court-04',
    courtNumber: 4,
    zone: 'left_1_4',
    orientation: 'landscape',
    points: rectPoints(187, 632, 318, 710),
    labelAnchor: centerPoint(187, 632, 318, 710),
  },

  // Upper & Mid-Right Block (Courts 5–10, portrait 2×3)
  {
    courtId: 'court-05',
    courtNumber: 5,
    zone: 'right_5_10',
    orientation: 'portrait',
    points: rectPoints(406, 236, 474, 372),
    labelAnchor: centerPoint(406, 236, 474, 372),
  },
  {
    courtId: 'court-06',
    courtNumber: 6,
    zone: 'right_5_10',
    orientation: 'portrait',
    points: rectPoints(509, 236, 578, 372),
    labelAnchor: centerPoint(509, 236, 578, 372),
  },
  {
    courtId: 'court-07',
    courtNumber: 7,
    zone: 'right_5_10',
    orientation: 'portrait',
    points: rectPoints(406, 438, 474, 575),
    labelAnchor: centerPoint(406, 438, 474, 575),
  },
  {
    courtId: 'court-08',
    courtNumber: 8,
    zone: 'right_5_10',
    orientation: 'portrait',
    points: rectPoints(509, 438, 578, 575),
    labelAnchor: centerPoint(509, 438, 578, 575),
  },
  {
    courtId: 'court-09',
    courtNumber: 9,
    zone: 'right_5_10',
    orientation: 'portrait',
    points: rectPoints(406, 638, 474, 776),
    labelAnchor: centerPoint(406, 638, 474, 776),
  },
  {
    courtId: 'court-10',
    courtNumber: 10,
    zone: 'right_5_10',
    orientation: 'portrait',
    points: rectPoints(509, 638, 578, 776),
    labelAnchor: centerPoint(509, 638, 578, 776),
  },

  // Lower Clubhouse Block (Courts 11–14, portrait 2×2)
  {
    courtId: 'court-11',
    courtNumber: 11,
    zone: 'lower_11_14',
    orientation: 'portrait',
    points: rectPoints(337, 872, 426, 1007),
    labelAnchor: centerPoint(337, 872, 426, 1007),
  },
  {
    courtId: 'court-12',
    courtNumber: 12,
    zone: 'lower_11_14',
    orientation: 'portrait',
    points: rectPoints(471, 872, 561, 1007),
    labelAnchor: centerPoint(471, 872, 561, 1007),
  },
  {
    courtId: 'court-13',
    courtNumber: 13,
    zone: 'lower_11_14',
    orientation: 'portrait',
    points: rectPoints(337, 1070, 426, 1206),
    labelAnchor: centerPoint(337, 1070, 426, 1206),
  },
  {
    courtId: 'court-14',
    courtNumber: 14,
    zone: 'lower_11_14',
    orientation: 'portrait',
    points: rectPoints(471, 1070, 561, 1206),
    labelAnchor: centerPoint(471, 1070, 561, 1206),
  },
];

export function pointsToSvgString(points: CourtPolygonPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

export function getZoneLabel(zone: CourtMapRegion['zone']): string {
  switch (zone) {
    case 'left_1_4':
      return 'West Wing (Courts 1–4)';
    case 'right_5_10':
      return 'Upper & Mid-Right Block (Courts 5–10)';
    case 'lower_11_14':
      return 'Lower Clubhouse Block (Courts 11–14)';
  }
}
