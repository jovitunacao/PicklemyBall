import React, { useCallback, useRef, useState } from 'react';
import { List, Map as MapIcon, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import {
  COURT_MAP_REGIONS,
  FLOOR_PLAN_DIMENSIONS,
  getZoneLabel,
  pointsToSvgString,
} from '../config/courtMapRegions';
import { COURT_STATUS_LEGEND, FACILITY_INFO } from '../config/facility';
import { SimulatedSlotOutcome } from '../data/mockStage2Availability';
import { CourtMapRegion, CourtStatus } from '../types/booking';

interface InteractiveCourtMapProps {
  courtStatuses: Record<number, SimulatedSlotOutcome>;
  selectedCourtNumber: number | null;
  inspectedConflictCourtNumber: number | null;
  onSelectCourt: (courtNumber: number) => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 3;

interface StatusStyle {
  fill: string;
  hoverFill: string;
  stroke: string;
  shortTag: string;
  badgeBg: string;
}

const STATUS_STYLE_MAP: Record<CourtStatus, StatusStyle> = {
  [CourtStatus.AVAILABLE]: {
    fill: 'rgba(37, 99, 235, 0.32)',
    hoverFill: 'rgba(37, 99, 235, 0.50)',
    stroke: '#1d4ed8',
    shortTag: 'OPEN',
    badgeBg: 'rgba(15, 23, 42, 0.78)',
  },
  [CourtStatus.BOOKED]: {
    fill: 'rgba(220, 38, 38, 0.46)',
    hoverFill: 'rgba(220, 38, 38, 0.56)',
    stroke: '#b91c1c',
    shortTag: 'BOOKED',
    badgeBg: 'rgba(127, 29, 29, 0.90)',
  },
  [CourtStatus.SELECTED]: {
    fill: 'rgba(22, 163, 74, 0.52)',
    hoverFill: 'rgba(22, 163, 74, 0.58)',
    stroke: '#15803d',
    shortTag: 'SELECTED',
    badgeBg: 'rgba(20, 83, 45, 0.94)',
  },
  [CourtStatus.HELD]: {
    fill: 'rgba(234, 179, 8, 0.48)',
    hoverFill: 'rgba(234, 179, 8, 0.58)',
    stroke: '#a16207',
    shortTag: 'HELD',
    badgeBg: 'rgba(113, 63, 18, 0.90)',
  },
  [CourtStatus.MAINTENANCE]: {
    fill: 'rgba(100, 116, 139, 0.58)',
    hoverFill: 'rgba(100, 116, 139, 0.68)',
    stroke: '#475569',
    shortTag: 'CLOSED',
    badgeBg: 'rgba(30, 41, 59, 0.90)',
  },
};

export const InteractiveCourtMap: React.FC<InteractiveCourtMapProps> = ({
  courtStatuses,
  selectedCourtNumber,
  inspectedConflictCourtNumber,
  onSelectCourt,
}) => {
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [hoveredCourt, setHoveredCourt] = useState<number | null>(null);
  const [imageError, setImageError] = useState(false);

  // Zoom & Pan state (applied identically to the shared parent container of <img> + <svg>)
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  }>({ active: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });

  const pinchRef = useRef<{
    active: boolean;
    initialDist: number;
    initialScale: number;
  }>({ active: false, initialDist: 0, initialScale: 1 });

  const clampTranslate = useCallback(
    (nx: number, ny: number, targetScale: number) => {
      if (targetScale <= 1 || !viewportRef.current) {
        return { x: 0, y: 0 };
      }
      const rect = viewportRef.current.getBoundingClientRect();
      const maxOffsetX = ((targetScale - 1) * rect.width) / 2;
      const maxOffsetY = ((targetScale - 1) * rect.height) / 2;
      return {
        x: Math.max(-maxOffsetX, Math.min(maxOffsetX, nx)),
        y: Math.max(-maxOffsetY, Math.min(maxOffsetY, ny)),
      };
    },
    [],
  );

  const handleZoomBy = (delta: number) => {
    setScale((prev) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number((prev + delta).toFixed(2))));
      setTranslate((curr) => clampTranslate(curr.x, curr.y, next));
      return next;
    });
  };

  const handleResetView = () => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  };

  // Mouse / Single-Pointer Pan when zoomed in
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return; // Touch handled via touch handlers for 2-finger pinch support
    if (scale <= 1) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: translate.x,
      origY: translate.y,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active || e.pointerType === 'touch') return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      dragRef.current.moved = true;
    }
    setTranslate(clampTranslate(dragRef.current.origX + dx, dragRef.current.origY + dy, scale));
  };

  const handlePointerUp = () => {
    dragRef.current.active = false;
  };

  // Touch Pinch-to-Zoom + Pan
  const getTouchDistance = (touches: React.TouchList): number => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      pinchRef.current = {
        active: true,
        initialDist: getTouchDistance(e.touches),
        initialScale: scale,
      };
      dragRef.current.active = false;
    } else if (e.touches.length === 1 && scale > 1) {
      dragRef.current = {
        active: true,
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        origX: translate.x,
        origY: translate.y,
        moved: false,
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchRef.current.active) {
      const dist = getTouchDistance(e.touches);
      const ratio = dist / Math.max(1, pinchRef.current.initialDist);
      const nextScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, Number((pinchRef.current.initialScale * ratio).toFixed(2))),
      );
      setScale(nextScale);
      setTranslate((curr) => clampTranslate(curr.x, curr.y, nextScale));
    } else if (e.touches.length === 1 && dragRef.current.active && scale > 1) {
      const dx = e.touches[0].clientX - dragRef.current.startX;
      const dy = e.touches[0].clientY - dragRef.current.startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        dragRef.current.moved = true;
      }
      setTranslate(clampTranslate(dragRef.current.origX + dx, dragRef.current.origY + dy, scale));
    }
  };

  const handleTouchEnd = () => {
    pinchRef.current.active = false;
    dragRef.current.active = false;
  };

  const resolveEffectiveStatus = (courtNumber: number): CourtStatus => {
    if (selectedCourtNumber === courtNumber) {
      return CourtStatus.SELECTED;
    }
    return courtStatuses[courtNumber]?.status ?? CourtStatus.AVAILABLE;
  };

  const handlePolygonClick = (courtNumber: number) => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    onSelectCourt(courtNumber);
  };

  const handlePolygonKeyDown = (e: React.KeyboardEvent<SVGPolygonElement>, courtNumber: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectCourt(courtNumber);
    }
  };

  const groupedRegions: Array<{
    zone: CourtMapRegion['zone'];
    title: string;
    courts: CourtMapRegion[];
  }> = [
    {
      zone: 'left_1_4',
      title: getZoneLabel('left_1_4'),
      courts: COURT_MAP_REGIONS.filter((c) => c.zone === 'left_1_4'),
    },
    {
      zone: 'right_5_10',
      title: getZoneLabel('right_5_10'),
      courts: COURT_MAP_REGIONS.filter((c) => c.zone === 'right_5_10'),
    },
    {
      zone: 'lower_11_14',
      title: getZoneLabel('lower_11_14'),
      courts: COURT_MAP_REGIONS.filter((c) => c.zone === 'lower_11_14'),
    },
  ];

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Map Toolbar */}
      <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        {/* View Mode Switcher (Map vs Accessible Text List) */}
        <div
          role="tablist"
          aria-label="Court selection view mode"
          className="inline-flex items-center gap-1 p-1 bg-slate-200/75 rounded-lg"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'map'}
            onClick={() => setViewMode('map')}
            className={`inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              viewMode === 'map'
                ? 'bg-white text-navy-950 shadow-xs'
                : 'text-slate-600 hover:text-navy-950'
            }`}
          >
            <MapIcon className="w-3.5 h-3.5" />
            <span>Architectural Map</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'list'}
            onClick={() => setViewMode('list')}
            className={`inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              viewMode === 'list'
                ? 'bg-white text-navy-950 shadow-xs'
                : 'text-slate-600 hover:text-navy-950'
            }`}
          >
            <List className="w-3.5 h-3.5" />
            <span>Court List (14)</span>
          </button>
        </div>

        {/* Zoom Controls (only shown in Map view) */}
        {viewMode === 'map' && (
          <div className="flex items-center gap-1.5">
            <span className="hidden sm:inline font-mono text-xs text-slate-500 tabular-nums mr-1">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => handleZoomBy(-0.35)}
              disabled={scale <= MIN_SCALE}
              aria-label="Zoom out floor plan"
              className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => handleZoomBy(0.35)}
              disabled={scale >= MAX_SCALE}
              aria-label="Zoom in floor plan"
              className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            {scale > 1 && (
              <button
                type="button"
                onClick={handleResetView}
                aria-label="Reset floor plan zoom"
                className="min-h-[40px] px-2.5 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main Canvas Area */}
      {viewMode === 'map' ? (
        <div className="p-3 sm:p-5 bg-slate-100/60">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>Tap any court on the Astoria Regency floor plan to inspect or reserve.</span>
            <span className="font-mono text-[11px] text-slate-500">
              Pinch or use +/- to zoom · Drag to pan when zoomed
            </span>
          </div>

          {/* Viewport Container */}
          <div
            ref={viewportRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{ touchAction: scale > 1 ? 'none' : 'pan-y' }}
            className={`relative w-full max-w-[680px] mx-auto overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xs select-none ${
              scale > 1 ? 'cursor-grab active:cursor-grabbing' : ''
            }`}
          >
            {/* Synchronized Transform Wrapper: <img> and <svg> transform together */}
            <div
              className="relative w-full origin-center transition-transform duration-100 ease-out"
              style={{
                aspectRatio: `${FLOOR_PLAN_DIMENSIONS.width} / ${FLOOR_PLAN_DIMENSIONS.height}`,
                transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${scale})`,
              }}
            >
              {!imageError ? (
                <img
                  src={FACILITY_INFO.floorPlanImagePath}
                  alt="Official Pick My Ball – Astoria Regency architectural floor plan showing Courts 1–14, parking, driveways, drop-off, and clubhouse"
                  draggable={false}
                  onError={() => setImageError(true)}
                  className="block w-full h-full object-contain pointer-events-none"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-slate-100 text-sm text-slate-600 p-8 text-center">
                  Architectural floor plan image failed to load. Use the Court List view above to
                  select a court.
                </div>
              )}

              {/* Exact 941x1600 SVG Court Polygon Layer */}
              <svg
                viewBox={`0 0 ${FLOOR_PLAN_DIMENSIONS.width} ${FLOOR_PLAN_DIMENSIONS.height}`}
                preserveAspectRatio="xMidYMid meet"
                className="absolute inset-0 w-full h-full"
                role="group"
                aria-label="Interactive map of 14 pickleball courts"
              >
                {COURT_MAP_REGIONS.map((region) => {
                  const status = resolveEffectiveStatus(region.courtNumber);
                  const style = STATUS_STYLE_MAP[status];
                  const isHovered = hoveredCourt === region.courtNumber;
                  const isInspectedConflict = inspectedConflictCourtNumber === region.courtNumber;
                  const isSelected = selectedCourtNumber === region.courtNumber;
                  const outcome = courtStatuses[region.courtNumber];

                  return (
                    <g key={region.courtId}>
                      {/* Highlight outer frame for active selection or inspected conflict */}
                      {(isSelected || isInspectedConflict) && (
                        <polygon
                          points={pointsToSvgString(region.points)}
                          fill="none"
                          stroke={isSelected ? '#a3e635' : '#0f172a'}
                          strokeWidth={isSelected ? 7 : 5}
                          strokeLinejoin="round"
                          pointerEvents="none"
                        />
                      )}

                      <polygon
                        points={pointsToSvgString(region.points)}
                        fill={isHovered ? style.hoverFill : style.fill}
                        stroke={style.stroke}
                        strokeWidth={isHovered || isSelected ? 3.5 : 2}
                        strokeLinejoin="round"
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        aria-label={`Court ${region.courtNumber}, ${region.orientation}, ${
                          outcome?.reason ?? status
                        }`}
                        onClick={() => handlePolygonClick(region.courtNumber)}
                        onKeyDown={(e) => handlePolygonKeyDown(e, region.courtNumber)}
                        onMouseEnter={() => setHoveredCourt(region.courtNumber)}
                        onMouseLeave={() => setHoveredCourt(null)}
                        className="cursor-pointer transition-colors duration-150 focus:outline-none focus-visible:stroke-[5]"
                      />

                      {/* Compact non-hue-only status pill inside court center */}
                      <g pointerEvents="none">
                        <rect
                          x={region.labelAnchor.x - 29}
                          y={region.labelAnchor.y - 11}
                          width={58}
                          height={22}
                          rx={4}
                          fill={style.badgeBg}
                        />
                        <text
                          x={region.labelAnchor.x}
                          y={region.labelAnchor.y + 4}
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="10"
                          fontWeight="700"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {style.shortTag}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      ) : (
        /* Accessible Text-Based Court List Fallback */
        <div className="p-4 sm:p-6 space-y-6">
          <p className="text-sm text-slate-600">
            Select any available court below. All 14 courts match the Astoria Regency architectural
            zones and simulated interval availability.
          </p>
          {groupedRegions.map((group) => (
            <div key={group.zone} className="space-y-3">
              <h3 className="text-xs font-semibold tracking-wider text-navy-700 uppercase">
                {group.title}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {group.courts.map((court) => {
                  const status = resolveEffectiveStatus(court.courtNumber);
                  const outcome = courtStatuses[court.courtNumber];
                  const legend = COURT_STATUS_LEGEND.find((l) => l.status === status);
                  const isSelected = status === CourtStatus.SELECTED;

                  return (
                    <button
                      key={court.courtId}
                      type="button"
                      onClick={() => onSelectCourt(court.courtNumber)}
                      className={`min-h-[56px] w-full px-4 py-3 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors ${
                        isSelected
                          ? 'bg-green-50 border-green-600 ring-2 ring-green-600/20'
                          : 'bg-white border-slate-200 hover:border-navy-700'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-sm text-navy-950">
                          Court {court.courtNumber}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {court.orientation === 'landscape' ? 'Horizontal' : 'Vertical'} ·{' '}
                          {outcome?.reason.replace(' (simulated).', '')}
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-bold shrink-0 ${
                          legend?.badgeTextClass ?? 'text-slate-700'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`w-3 h-3 rounded-xs border ${legend?.swatchClass ?? ''}`}
                        />
                        <span>{legend?.label ?? status}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Persistent Legend Strip */}
      <div className="px-4 sm:px-5 py-3 bg-white border-t border-slate-200 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-700">
        {COURT_STATUS_LEGEND.map((item) => (
          <div key={item.status} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`w-3.5 h-3.5 rounded-xs border ${item.swatchClass}`}
            />
            <span className="font-semibold">{item.label}</span>
            <span className="text-slate-400">({item.colorName})</span>
          </div>
        ))}
      </div>
    </div>
  );
};
