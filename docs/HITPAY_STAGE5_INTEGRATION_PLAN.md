# Pick My Ball – Astoria Regency: Stage 5 HitPay Payment Integration Plan

**Status:** Planning & Contract Specification Complete (`paymentGatewayEnabled: false`)  
**Scope:** Philippine Peso (`PHP`) checkout & verified webhook settlement for `Pick My Ball – Astoria Regency`  
**Important Safeguard:** Live charges and production HitPay credentials are **not** activated or requested in this phase. This architecture builds directly on the already-provisioned `payment_intents` table and `enforce_reservation_integrity()` PostgreSQL trigger from Migrations `0001`–`0004`.

---

## 1. End-to-End Checkout & Confirmation State Machine

1. **Guest / Walk-In Hold Creation (Already Live)**
   - `guest-holds` or `admin-reservations` (`action: 'walk_in'`) atomically creates:
     - `reservation_holds` (`status = 'active'`, `expires_at = now() + 10 min`)
     - `reservations` (`status = 'pending_payment'`, immutable financial snapshot in centavos)
     - `payment_intents` (`provider = 'hitpay'`, `currency = 'PHP'`, `amount_centavos = total_amount_centavos`, `status = 'created'`)
2. **Checkout Initiation (Planned Edge Function: `payment-create-checkout`)**
   - Input: `{ bookingReference, ownershipToken }` (client never sends totals, prices, or confirmation flags).
   - Server checks:
     - Constant-time token verification against `reservation_holds.ownership_token_hash` or `reservations.lookup_token_hash`.
     - Verify `reservations.status = 'pending_payment'` and `reservation_holds.status = 'active'` with `expires_at > now()`.
     - Compute decimal PHP string from integer centavos (`formatCentavosToHitPayAmount`, e.g. `35000` -> `"350.00"`).
   - Calls HitPay `POST https://api.hit-pay.com/v1/payment-requests` (or sandbox `api.sandbox.hit-pay.com` when `HITPAY_ENV=sandbox`) with:
     - `amount`, `currency: "PHP"`, `reference_number: bookingReference`, `email`, `name`
     - `payment_methods`: `["gcash", "maya", "qrph", "card", "grabpay"]`
     - `webhook`: `https://kcfvpdkyfcgnvbbuywvl.supabase.co/functions/v1/payment-webhook-hitpay`
     - `redirect_url`: `https://<app-origin>/confirmation/${bookingReference}`
   - Stores HitPay `id` -> `payment_intents.provider_reference`, `url` -> `payment_intents.checkout_url`, `status = 'pending'`.
3. **Authoritative Webhook Settlement (Planned Edge Function: `payment-webhook-hitpay`)**
   - Validates `hmac` / `X-Signature` using `HITPAY_SALT` (sorted keys concatenation + HMAC-SHA256 constant-time equality). Rejects invalid signatures with `401` + audit log entry.
   - Verifies:
     - `currency === 'PHP'`
     - `Math.round(Number(amount) * 100) === reservation.total_amount_centavos` (or `depositRequiredCentavos` if deposits enabled)
     - Idempotency: if `payment_intents` already has `status = 'paid'` and `verified_at IS NOT NULL`, return `200 OK` immediately without duplicate side effects.
   - Executes PostgreSQL `SECURITY DEFINER` confirmation RPC inside `pg_advisory_xact_lock(hashtext('pmb_court_' || court_id))`:
     - **Case A (Hold still active or interval still uncontested):**
       - `UPDATE payment_intents SET status = 'paid', verified_at = now(), metadata = metadata || webhook_payload`
       - `UPDATE reservation_holds SET status = 'converted'`
       - `SET LOCAL pmb.allow_verified_confirmation = 'true'`
       - `UPDATE reservations SET status = 'confirmed'` (satisfies `enforce_reservation_integrity()`)
       - Dispatches transactional confirmation receipt email + unlocks QR check-in pass (`qrCheckInEligible: true`).
     - **Case B (Hold expired AND another player already reserved the court):**
       - Transitions `reservations.status` to `'payment_review_required'` (never silently double-books the court!) and logs `payment_late_conflict_review` for manager resolution/refund.

---

## 2. Cancellation & Refund Policy Mapping (Pending Business Sign-Off Before Activation)

- `pending_payment` (unpaid hold): Customer cancellation allowed online via `cancel_booking_with_token` (already live).
- `confirmed` (paid reservation): Currently locked to `manager` / `super_admin` (`staff_cancel_reservation`) until Astoria Regency finalizes refund cut-off rules (e.g., full refund vs credit voucher >= 24h prior, rainout rescheduling).
- `payment_review_required`: Manager issues refund via HitPay Refunds API (`/v1/refund`) and updates `payment_intents.status = 'refunded'`.

---

## 3. Approval Checklist Required Before Stage 5 Activation

Do **not** activate live charges until the owner confirms:
1. HitPay account environment target (`sandbox` verification first vs `production`).
2. Approved payment methods to display (`GCash`, `Maya`, `QRPh`, `Credit/Debit Card`, `GrabPay`).
3. Final deposit percentage (`100%` full prepayment vs partial `%` deposit in `facility_settings`).
4. Customer cancellation / rainout refund policy window.
5. Injection of server-only Supabase Edge Function secrets (`HITPAY_API_KEY`, `HITPAY_SALT`, `HITPAY_ENV`) — never prefixed with `VITE_`.
