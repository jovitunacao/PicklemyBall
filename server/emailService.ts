import { utcIsoToManilaDateAndTime } from '../src/lib/manilaTime.ts';

export interface ConfirmationEmailPayload {
  bookingReference: string;
  customerName: string;
  recipientEmail: string;
  courtNumber: number;
  startAtIso: string;
  endAtIso: string;
  durationMinutes: number;
  totalAmountCentavos: number;
  reservationStatus: string;
  paymentStatus: string;
  holdExpiresAtIso?: string | null;
  lookupToken?: string;
  appBaseUrl?: string;
}

export interface RenderedEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  delivered: boolean;
  configured: boolean;
  provider: 'resend' | 'none';
  recipientEmail: string;
  subject: string;
  reason?: string;
  messageId?: string;
  preview: RenderedEmailContent;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatPhpCentavos(centavos: number): string {
  return `₱${(centavos / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function buildConfirmationEmailContent(
  input: ConfirmationEmailPayload,
): RenderedEmailContent {
  const startLocal = utcIsoToManilaDateAndTime(input.startAtIso);
  const endLocal = utcIsoToManilaDateAndTime(input.endAtIso);
  const expiryLocal = input.holdExpiresAtIso
    ? utcIsoToManilaDateAndTime(input.holdExpiresAtIso)
    : null;

  const isConfirmedPaid =
    input.reservationStatus === 'confirmed' && input.paymentStatus === 'paid';

  const statusHeadline = isConfirmedPaid
    ? 'Confirmed Reservation & Reception Check-In Pass'
    : 'Temporary Court Hold Summary (Payment Pending)';

  const subject = isConfirmedPaid
    ? `[Pick My Ball] Confirmed Court ${input.courtNumber} · ${input.bookingReference}`
    : `[Pick My Ball] Temporary Hold ${input.bookingReference} (Court ${input.courtNumber})`;

  const baseUrl = (input.appBaseUrl || 'https://pickmyball.ph').replace(/\/+$/, '');
  const lookupUrl = `${baseUrl}/lookup?ref=${encodeURIComponent(input.bookingReference)}`;

  const totalPhp = formatPhpCentavos(input.totalAmountCentavos);
  const safeName = escapeHtml(input.customerName);
  const safeRef = escapeHtml(input.bookingReference);
  const safeStatus = escapeHtml(input.reservationStatus.replace(/_/g, ' ').toUpperCase());
  const safePayment = escapeHtml(input.paymentStatus.replace(/_/g, ' ').toUpperCase());
  const safeLookupUrl = escapeHtml(lookupUrl);

  const checkInSectionHtml = isConfirmedPaid
    ? `<div style="margin:20px 0;padding:16px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;">
        <p style="margin:0 0 6px;font-weight:700;color:#14532d;">Reception QR Check-In Eligible</p>
        <p style="margin:0;font-size:13px;color:#166534;">
          Open your Booking Lookup link below with your private access token to present your scannable Astoria Regency QR pass at reception.
        </p>
      </div>`
    : `<div style="margin:20px 0;padding:16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;">
        <p style="margin:0 0 6px;font-weight:700;color:#78350f;">Temporary Hold Active — Action Required</p>
        <p style="margin:0;font-size:13px;color:#92400e;">
          This reservation hold is currently <strong>pending payment</strong>${
            expiryLocal ? ` and expires at <strong>${escapeHtml(expiryLocal.date)} ${escapeHtml(expiryLocal.time)} PHT</strong>` : ''
          }. QR check-in passes are issued only after verified payment confirmation.
        </p>
      </div>`;

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="background:#061326;color:#ffffff;padding:24px 28px;">
        <p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#a3e635;font-weight:700;">Pick My Ball – Astoria Regency</p>
        <h1 style="margin:8px 0 0;font-size:22px;line-height:1.25;">${escapeHtml(statusHeadline)}</h1>
      </div>
      <div style="padding:24px 28px;">
        <p style="margin:0 0 16px;font-size:14px;">Hello ${safeName},</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e2e8f0;">
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">Booking Reference</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:700;text-align:right;font-family:monospace;">${safeRef}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">Court</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:700;text-align:right;">Court ${input.courtNumber}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">Schedule (Asia/Manila)</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:700;text-align:right;font-family:monospace;">${escapeHtml(startLocal.date)} · ${escapeHtml(startLocal.time)}–${escapeHtml(endLocal.time)} PHT</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">Duration</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;text-align:right;">${input.durationMinutes} minutes</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">Status / Payment</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-family:monospace;">${safeStatus} / ${safePayment}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">Total (PHP)</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:700;font-size:16px;text-align:right;font-family:monospace;">${escapeHtml(totalPhp)}</td></tr>
        </table>
        ${checkInSectionHtml}
        <p style="margin:18px 0 8px;font-size:13px;color:#475569;">
          Manage or retrieve your reservation using your reference and private lookup token:
        </p>
        <p style="margin:0 0 18px;">
          <a href="${safeLookupUrl}" style="display:inline-block;padding:10px 18px;background:#061326;color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;">Open Booking Lookup</a>
        </p>
        <p style="margin:0;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:14px;">
          Astoria Regency, Pasonanca Park, Zamboanga City, Philippines · Keep your private lookup token safe; it is never re-emailed after creation if lost.
        </p>
      </div>
    </div>
  </body>
</html>`;

  const text = [
    `PICK MY BALL – ASTORIA REGENCY`,
    statusHeadline,
    ``,
    `Hello ${input.customerName},`,
    `Booking Reference: ${input.bookingReference}`,
    `Court: Court ${input.courtNumber}`,
    `Schedule (Asia/Manila): ${startLocal.date} ${startLocal.time}-${endLocal.time} PHT (${input.durationMinutes} min)`,
    `Reservation Status: ${input.reservationStatus}`,
    `Payment Status: ${input.paymentStatus}`,
    `Server-Verified Total: ${totalPhp}`,
    expiryLocal && !isConfirmedPaid
      ? `Hold Expires At: ${expiryLocal.date} ${expiryLocal.time} PHT`
      : null,
    ``,
    isConfirmedPaid
      ? `QR Check-In Eligible: Present your pass via Booking Lookup (${lookupUrl}) at reception.`
      : `Unpaid Temporary Hold: QR check-in passes are issued only after verified payment confirmation.`,
    `Location: Astoria Regency, Pasonanca Park, Zamboanga City`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return { subject, html, text };
}

export async function sendBookingConfirmationEmail(
  payload: ConfirmationEmailPayload,
  env: Record<string, string | undefined> = process.env,
): Promise<EmailSendResult> {
  const preview = buildConfirmationEmailContent(payload);
  const resendKey = env.RESEND_API_KEY?.trim();
  const fromAddress =
    env.EMAIL_FROM?.trim() || 'Pick My Ball – Astoria Regency <reservations@pickmyball.ph>';

  if (!resendKey) {
    return {
      delivered: false,
      configured: false,
      provider: 'none',
      recipientEmail: payload.recipientEmail,
      subject: preview.subject,
      reason:
        'RESEND_API_KEY is not configured in server secrets yet. Receipt preview generated cleanly without simulated delivery.',
      preview,
    };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [payload.recipientEmail],
        subject: preview.subject,
        html: preview.html,
        text: preview.text,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok) {
      return {
        delivered: false,
        configured: true,
        provider: 'resend',
        recipientEmail: payload.recipientEmail,
        subject: preview.subject,
        reason: data.message || `Resend API rejected email request (${response.status}).`,
        preview,
      };
    }

    return {
      delivered: true,
      configured: true,
      provider: 'resend',
      recipientEmail: payload.recipientEmail,
      subject: preview.subject,
      messageId: data.id,
      preview,
    };
  } catch (err) {
    return {
      delivered: false,
      configured: true,
      provider: 'resend',
      recipientEmail: payload.recipientEmail,
      subject: preview.subject,
      reason: err instanceof Error ? err.message : 'Network error sending transactional email.',
      preview,
    };
  }
}
