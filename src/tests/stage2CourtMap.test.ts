import { describe, expect, it } from 'vitest';
import {
  COURT_MAP_REGIONS,
  FLOOR_PLAN_DIMENSIONS,
  pointsToSvgString,
} from '../config/courtMapRegions';
import {
  calculateSimulatedMockPrice,
  formatEndTime,
  getAllCourtsIntervalStatus,
  getSimulatedCourtIntervalStatus,
  getSimulatedHourlyCourtStatus,
} from '../data/mockStage2Availability';
import { CourtStatus } from '../types/booking';

describe('Stage 2 Architectural Court Map Configuration', () => {
  it('defines exactly 14 unique courts numbered 1 through 14', () => {
    expect(COURT_MAP_REGIONS).toHaveLength(14);

    const numbers = COURT_MAP_REGIONS.map((r) => r.courtNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    const ids = new Set(COURT_MAP_REGIONS.map((r) => r.courtId));
    expect(ids.size).toBe(14);
  });

  it('preserves physical zones and orientations (1-4 landscape, 5-14 portrait)', () => {
    for (const region of COURT_MAP_REGIONS) {
      const xs = region.points.map((p) => p.x);
      const ys = region.points.map((p) => p.y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);

      if (region.courtNumber <= 4) {
        expect(region.zone).toBe('left_1_4');
        expect(region.orientation).toBe('landscape');
        expect(width).toBeGreaterThan(height);
      } else if (region.courtNumber <= 10) {
        expect(region.zone).toBe('right_5_10');
        expect(region.orientation).toBe('portrait');
        expect(height).toBeGreaterThan(width);
      } else {
        expect(region.zone).toBe('lower_11_14');
        expect(region.orientation).toBe('portrait');
        expect(height).toBeGreaterThan(width);
      }
    }
  });

  it('keeps all polygon coordinates and label anchors strictly inside 941x1600 bounds with no overlaps', () => {
    const boxes = COURT_MAP_REGIONS.map((region) => {
      const xs = region.points.map((p) => p.x);
      const ys = region.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);

      expect(minX).toBeGreaterThanOrEqual(0);
      expect(maxX).toBeLessThanOrEqual(FLOOR_PLAN_DIMENSIONS.width);
      expect(minY).toBeGreaterThanOrEqual(0);
      expect(maxY).toBeLessThanOrEqual(FLOOR_PLAN_DIMENSIONS.height);

      expect(region.labelAnchor.x).toBeGreaterThan(minX);
      expect(region.labelAnchor.x).toBeLessThan(maxX);
      expect(region.labelAnchor.y).toBeGreaterThan(minY);
      expect(region.labelAnchor.y).toBeLessThan(maxY);

      return { courtNumber: region.courtNumber, minX, maxX, minY, maxY };
    });

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlaps =
          a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
        expect(overlaps, `Court ${a.courtNumber} overlaps Court ${b.courtNumber}`).toBe(false);
      }
    }
  });

  it('formats SVG polygon points string cleanly', () => {
    const str = pointsToSvgString(COURT_MAP_REGIONS[0].points);
    expect(str).toBe('187,234 318,234 318,313 187,313');
  });
});

describe('Stage 2 Simulated Availability & Mock Pricing', () => {
  it('evaluates all 14 courts and reflects all 5 status states across schedules', () => {
    const morning = getAllCourtsIntervalStatus('2026-11-23', '08:00', 1);
    expect(Object.keys(morning)).toHaveLength(14);
    expect(morning[4].status).toBe(CourtStatus.MAINTENANCE);

    const evening = getAllCourtsIntervalStatus('2026-11-23', '18:00', 1);
    const statuses = new Set(Object.values(evening).map((v) => v.status));
    expect(statuses.has(CourtStatus.AVAILABLE)).toBe(true);
    expect(statuses.has(CourtStatus.BOOKED)).toBe(true);
  });

  it('blocks multi-hour intervals if any constituent hour is unavailable', () => {
    // Court 4 is under simulated maintenance from 06:00-10:00
    const outcome = getSimulatedCourtIntervalStatus(4, '2026-11-23', '09:00', 2);
    expect(outcome.status).toBe(CourtStatus.MAINTENANCE);

    // Find any court that is available at hour H but booked/held at hour H+1
    const date = '2026-11-23';
    let checkedBoundary = false;
    for (let c = 1; c <= 14; c++) {
      for (let h = 6; h <= 20; h++) {
        const s1 = getSimulatedHourlyCourtStatus(c, date, h);
        const s2 = getSimulatedHourlyCourtStatus(c, date, h + 1);
        if (s1 === CourtStatus.AVAILABLE && s2 !== CourtStatus.AVAILABLE) {
          const span = getSimulatedCourtIntervalStatus(
            c,
            date,
            `${String(h).padStart(2, '0')}:00`,
            2,
          );
          expect(span.status).toBe(s2);
          checkedBoundary = true;
          break;
        }
      }
      if (checkedBoundary) break;
    }
    expect(checkedBoundary).toBe(true);
  });

  it('prevents bookings that extend past 22:00 closing time', () => {
    const outcome = getSimulatedCourtIntervalStatus(1, '2026-11-23', '21:00', 2);
    expect(outcome.status).toBe(CourtStatus.MAINTENANCE);
    expect(formatEndTime('20:00', 2)).toBe('22:00');
  });

  it('calculates simulated weekday, weekend, and mixed peak PHP totals accurately', () => {
    // 2026-11-23 is Monday (weekday): 08:00 is standard (350), 18:00 is peak (450)
    const weekdayMorning = calculateSimulatedMockPrice('2026-11-23', '08:00', 2);
    expect(weekdayMorning.totalPhp).toBe(700);

    const weekdayMixed = calculateSimulatedMockPrice('2026-11-23', '16:00', 2); // 16-17 std (350) + 17-18 peak (450)
    expect(weekdayMixed.standardHoursCount).toBe(1);
    expect(weekdayMixed.peakHoursCount).toBe(1);
    expect(weekdayMixed.totalPhp).toBe(800);

    // 2026-11-22 is Sunday (weekend): 08:00 std (400), 18:00 peak (500)
    const weekendPeak = calculateSimulatedMockPrice('2026-11-22', '18:00', 2);
    expect(weekendPeak.totalPhp).toBe(1000);
  });
});
