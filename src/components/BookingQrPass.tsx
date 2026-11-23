import React, { useEffect, useState } from 'react';
import { AlertCircle, Download, Loader2, Lock, QrCode, RefreshCw, ShieldCheck } from 'lucide-react';
import { utcIsoToManilaDateAndTime } from '../lib/manilaTime';
import { generateQrPassSvg, parseQrCheckInInput } from '../lib/qrCheckIn';
import { issueQrCheckInPass, type IssuedQrCheckInResponse } from '../services/bookingApi';

interface BookingQrPassProps {
  bookingReference: string;
  /**
   * Used strictly to authorize POST /api/qr-checkin/issue over HTTPS so the server
   * issues a dedicated, signed single-use chk_v1 check-in token. Never embedded in QR/SVG.
   */
  authorizationLookupToken?: string;
  courtNumber: number;
  eligible: boolean;
  note: string;
}

export const BookingQrPass: React.FC<BookingQrPassProps> = ({
  bookingReference,
  authorizationLookupToken,
  courtNumber,
  eligible,
  note,
}) => {
  const [issuedPass, setIssuedPass] = useState<IssuedQrCheckInResponse | null>(null);
  const [svgDataUrl, setSvgDataUrl] = useState<string | null>(null);
  const [svgRaw, setSvgRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let active = true;
    const authToken = authorizationLookupToken?.trim();

    if (!eligible || !authToken) {
      setIssuedPass(null);
      setSvgDataUrl(null);
      setSvgRaw(null);
      setIssueError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setIssueError(null);

    issueQrCheckInPass({
      bookingReference,
      lookupToken: authToken,
    })
      .then(async (issued) => {
        if (!active) return;
        const parsed = parseQrCheckInInput(issued.qrPayload);
        if (!parsed.checkInToken) {
          throw new Error('Server returned an unexpected QR check-in payload format.');
        }
        const svg = await generateQrPassSvg(issued.qrPayload);
        if (!active) return;
        setIssuedPass(issued);
        setSvgRaw(svg);
        setSvgDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch((err) => {
        if (!active) return;
        setIssuedPass(null);
        setSvgRaw(null);
        setSvgDataUrl(null);
        setIssueError(
          err instanceof Error
            ? err.message
            : 'Unable to issue signed reception QR check-in pass.',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [eligible, bookingReference, authorizationLookupToken, refreshNonce]);

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
          signed single-use QR pass unlocks automatically here and on Booking Lookup.
        </p>
      </div>
    );
  }

  const expiryManila = issuedPass ? utcIsoToManilaDateAndTime(issuedPass.expiresAtIso) : null;

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

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-green-900 py-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Issuing dedicated server-signed QR check-in pass...</span>
        </div>
      ) : issueError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <span>{issueError}</span>
          </div>
          {authorizationLookupToken && (
            <button
              type="button"
              onClick={() => setRefreshNonce((n) => n + 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-300 bg-white font-semibold hover:bg-red-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Issuing Pass</span>
            </button>
          )}
        </div>
      ) : svgDataUrl && issuedPass ? (
        <div className="flex flex-col sm:flex-row items-center gap-5">
          <div className="bg-white p-3 rounded-lg border border-green-200 shrink-0">
            <img
              src={svgDataUrl}
              alt={`Signed QR Check-In Pass for ${bookingReference}`}
              className="w-40 h-40 block"
            />
          </div>
          <div className="space-y-3 text-xs text-green-950">
            <p className="leading-relaxed">
              Present this server-signed, single-use QR pass to Astoria Regency Reception upon
              arrival. Your private booking lookup token is never embedded in the QR code.
            </p>
            <div className="font-mono text-[11px] text-green-900/90 space-y-0.5 tabular-nums">
              <p>Pass ID: {issuedPass.jti.slice(0, 12)}…</p>
              {expiryManila && (
                <p>
                  Valid Until: {expiryManila.date} · {expiryManila.time} PHT
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleDownloadSvg}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-4 py-2 rounded-lg bg-navy-950 text-white font-semibold hover:bg-navy-800 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download QR Pass (SVG)</span>
              </button>
              <button
                type="button"
                onClick={() => setRefreshNonce((n) => n + 1)}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 rounded-lg border border-green-400 bg-white text-green-950 font-semibold hover:bg-green-50 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Refresh Pass</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-green-900">
          <QrCode className="w-4 h-4" />
          <span>Pass confirmed for check-in; verify on Booking Lookup to issue your QR pass.</span>
        </div>
      )}
    </div>
  );
};
