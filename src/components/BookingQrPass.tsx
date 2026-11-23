import React, { useEffect, useState } from 'react';
import { Download, Lock, QrCode, ShieldCheck } from 'lucide-react';
import { buildQrCheckInPayload, generateQrPassSvg } from '../lib/qrCheckIn';

interface BookingQrPassProps {
  bookingReference: string;
  lookupToken?: string;
  courtNumber: number;
  eligible: boolean;
  note: string;
}

export const BookingQrPass: React.FC<BookingQrPassProps> = ({
  bookingReference,
  lookupToken,
  courtNumber,
  eligible,
  note,
}) => {
  const [svgDataUrl, setSvgDataUrl] = useState<string | null>(null);
  const [svgRaw, setSvgRaw] = useState<string | null>(null);

  const payload =
    eligible && lookupToken
      ? buildQrCheckInPayload({
          bookingReference,
          lookupToken,
          courtNumber,
        })
      : null;

  useEffect(() => {
    let active = true;
    if (!payload) {
      setSvgDataUrl(null);
      setSvgRaw(null);
      return;
    }

    generateQrPassSvg(payload)
      .then((svg) => {
        if (!active) return;
        setSvgRaw(svg);
        setSvgDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (active) {
          setSvgRaw(null);
          setSvgDataUrl(null);
        }
      });

    return () => {
      active = false;
    };
  }, [payload]);

  const handleDownloadSvg = () => {
    if (!svgRaw) return;
    const blob = new Blob([svgRaw], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${bookingReference}-checkin-qr.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!eligible) {
    return (
      <div className="rounded-xl border border-slate-200 bg-navy-950 text-white p-4 space-y-2 text-xs">
        <div className="flex items-center gap-2 font-bold text-lime-400">
          <Lock className="w-4 h-4 shrink-0" />
          <span>Reception QR Check-In Pass Locked</span>
        </div>
        <p className="text-slate-300 leading-relaxed">{note}</p>
        <p className="text-slate-400">
          Online checkout (HitPay) remains inactive until approved. Once payment is verified and
          reservation status moves to <span className="font-mono text-white">CONFIRMED</span>, your
          scannable QR pass unlocks automatically here and on Booking Lookup.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-green-300 bg-green-50/70 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold text-green-950">
          <ShieldCheck className="w-4 h-4 text-green-700" />
          <span>Reception QR Check-In Pass</span>
        </div>
        <span className="font-mono text-xs font-semibold text-green-900 tabular-nums">
          Court {courtNumber} · {bookingReference}
        </span>
      </div>

      {svgDataUrl ? (
        <div className="flex flex-col sm:flex-row items-center gap-5">
          <div className="bg-white p-3 rounded-lg border border-green-200 shrink-0">
            <img
              src={svgDataUrl}
              alt={`QR Check-In Pass for ${bookingReference}`}
              className="w-40 h-40 block"
            />
          </div>
          <div className="space-y-3 text-xs text-green-950">
            <p className="leading-relaxed">
              Present this QR code to the Astoria Regency Lobby Reception desk upon arrival. Only
              your opaque reservation reference and verification token are encoded—no phone number
              or email address is exposed in the QR code.
            </p>
            <button
              type="button"
              onClick={handleDownloadSvg}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-4 py-2 rounded-lg bg-navy-950 text-white font-semibold hover:bg-navy-800 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download QR Pass (SVG)</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-green-900">
          <QrCode className="w-4 h-4" />
          <span>Pass confirmed for check-in; open via Booking Lookup with your token to render QR.</span>
        </div>
      )}
    </div>
  );
};
