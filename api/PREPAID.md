# Prepaid billing

Built 2026-09-15. Postpaid is untouched and still the default for every existing plan.

## The model

Postpaid asks *"is an invoice overdue past grace?"*. Prepaid asks *"has the paid-for date
arrived?"*. Those are different triggers, so prepaid carries its own candidate query, its
own enable flag, its own job and its own `trigger_source`. What it does **not** carry is
its own cutoff code — restricting and restoring both go through `restriction.js`, so there
is exactly one implementation of "put this customer behind the walled garden".

Decisions taken up front, because they set the schema:

| Question | Answer | Consequence |
|---|---|---|
| Does a top-up create an invoice? | **Yes** | Reuses Xendit checkout, the webhook, A/R, SOA, PDF + thermal receipts and treasury deposits unchanged. `payments.invoice_id` is `NOT NULL` with an FK, so the alternative meant reworking all of it. |
| What does payment buy? | **Days** | `expires_at` extends by `plans.validity_period`. No daily accrual job, no re-rating on plan change, no drift. Mirrors the hotspot vouchers already running here. |
| One cutoff flag or two? | **Two** | `prepaid_auto_expire_enabled` is separate from `billing_auto_restrict_enabled`, so prepaid can enforce from day one while postpaid stays in dry run against its 135 subscribers. |

## Schema

Additive only, applied as SQL — `subscribers` carries GENERATED columns and the
account-number trigger that are absent from `schema.prisma`.
**`prisma generate` only. `prisma db push` would drop them.**

```
subscribers.expires_at      timestamptz   NULL = postpaid / no expiry
invoices.prepaid_days       integer       NULL = ordinary invoice; >0 = buys this many days
prepaid_topups              table         what each payment bought, with before/after expiry
```

`prepaid_topups` has a **partial unique index on `invoice_id`**. That is the idempotency
guard: Xendit re-delivers callbacks, and without it a retry hands out a second 30 days free.

Settings, all seeded: `prepaid_auto_expire_enabled` (false), `prepaid_expiry_grace_hours`
(0), `prepaid_max_per_run` (25).

## Expiry arithmetic

Expiry lands at **23:59:59.999 Manila on the final day**, not at the clock time of purchase
— a customer who loads at 11pm should not lose that day. Extension runs from
`GREATEST(expires_at, now())`, so topping up early never confiscates unused days. Because
an already-rounded expiry stays rounded when whole days are added, this rounds once on the
first top-up and never drifts.

The bump is a single `UPDATE` computed in Postgres, not read-modify-write in Node: a Xendit
retry racing a counter payment would otherwise both read the same starting expiry and one
extension would be lost.

Amounts buy whole multiples of the plan period. ₱100 against a ₱299/30d plan is **rejected**,
not rounded down to nothing.

## Cadence, and why it differs from postpaid

- **Postpaid** cuts once a day at a fixed hour. Cutting someone off over an unpaid invoice
  is a judgement call with a phone call attached.
- **Prepaid** cuts every 15 minutes. Expiry is not a judgement call — the customer bought
  until a date and it has passed. A daily run would gift a free day to everyone expiring
  just after it, and if the expiry date means nothing then neither does paying to extend it.

Restore runs every tick as a backstop; `prepaid.grant()` already lifts the cutoff the moment
money lands.

## Where prepaid had to be kept out of postpaid logic

Four places would have misfired, each found by asking "what does this query think a prepaid
account is?":

1. **`restrictionCandidates`** now excludes `prepaid_days IS NOT NULL`. An abandoned checkout
   leaves a pending invoice dated today; counted as debt it would age past the 15-day grace
   and cut off a prepaid customer for non-payment while they still held weeks of paid service.
2. **`restoreIfSettled`** refuses an expired prepaid account. "No overdue invoice" does not
   mean "paid up" when the model carries no debt — settling an old installation fee would
   otherwise hand back service nobody bought.
3. **`generate-invoices.js`** skips prepaid plans. A monthly invoice would post a debt they
   do not owe and feed them straight into fault 1.
4. **`balance-reconcile`** ignores prepaid invoices, so an abandoned top-up does not show the
   customer a balance.

## Paths in

| Entry | Route | Notes |
|---|---|---|
| Counter (cash/GCash) | `POST /api/admin/prepaid/topup/:id` | Writes invoice + payment already settled. |
| Online, admin-issued | `POST /api/admin/prepaid/checkout/:id` | Mints a pending invoice; existing checkout takes it from there. |
| Portal self-service | `GET`/`POST /api/portal/prepaid[/topup]` | Mints the invoice, client sends it through the existing `/invoices/:id/pay`. |
| Walled garden | `POST /api/restricted/pay` | Mints or reuses the renewal invoice. Accepts `periods` (1–12), never an invoice id. |
| Goodwill days | `POST /api/admin/prepaid/adjust/:id` | Amount 0, reason required, on the record. |

There is exactly **one** place that talks to Xendit, and none of the above is it. Each mints
an invoice and hands it to the proven checkout.

`/api/admin/prepaid/*` uses the shared `adminAuth` middleware — not the lighter copy some
sibling route files carry, which never checks `decoded.type` (so a subscriber's portal token,
signed with the same secret, passes it) and still accepts `?token=`. These endpoints take
money and switch service on and off.

## Before selling a prepaid plan

1. Create the plan with Billing = Prepaid and a validity period. The API refuses a prepaid
   plan without one — it would sell time with no end, `isPrepaidPlan()` would reject it, and
   the expiry job would never touch its subscribers: prepaid in the CRM, postpaid on the wire.
2. Leave `prepaid_auto_expire_enabled` **false** and watch the dry-run lines in
   `pm2 logs isp-api | grep prepaid-expiry` for a few days.
3. Confirm the walled garden renders the renewal face: `/restricted/?demo=prepaid`.
4. Then set it true.

## Still open

- **Port 8081 is not forwarded at the edge**, so the captive redirect stays disabled on all
  15 routers. An expired prepaid customer reaches the portal by typing the address but gets
  no automatic "sign in to network" prompt. Tolerable for postpaid, where cutoffs are rare;
  at prepaid volume, where expiry is routine, every one of those is a support call.
  Enable with `/ip/firewall/nat enable [find comment="nf-garden captive redirect"]` once forwarded.
- **Source preservation is unproven** — no restricted customer has loaded the portal yet.
  Check: `grep -hE "^100\.6[0-9]\." /var/log/nginx/*access*.log`
- No prepaid dashboard page in the CRM yet. `GET /api/admin/prepaid/expiring?within=3` returns
  the morning work list; nothing renders it.
- Expiry reminders (SMS/email at T-3 days) are not built.
