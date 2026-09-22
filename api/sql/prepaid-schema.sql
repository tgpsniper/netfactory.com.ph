-- ============================================================
-- Prepaid billing — additive schema
-- ============================================================
-- Additive only. subscribers carries GENERATED columns and the
-- account-number trigger that are absent from schema.prisma, so this
-- is applied as SQL and the client is refreshed with `prisma generate`.
-- `prisma db push` would drop them and must never be run here.
-- ============================================================

BEGIN;

-- The date service dies. NULL means "no expiry" — every postpaid account,
-- which is all 135 of them today, so this column changes nothing until a
-- plan is switched to prepaid.
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN subscribers.expires_at IS
  'Prepaid service expiry. NULL = postpaid / no expiry. Enforced by the prepaid-expiry job.';

-- Partial index: the expiry job asks "who has expired", and with prepaid a
-- minority of the base the NULLs are dead weight in a full index.
CREATE INDEX IF NOT EXISTS idx_subscribers_expires_at
  ON subscribers (expires_at) WHERE expires_at IS NOT NULL;

-- What each payment actually bought. The invoice and payment rows carry the
-- money; this carries the time, and the before/after pair makes every
-- extension auditable without replaying the whole ledger.
CREATE TABLE IF NOT EXISTS prepaid_topups (
  id              serial PRIMARY KEY,
  subscriber_id   integer NOT NULL REFERENCES subscribers(id),
  invoice_id      integer REFERENCES invoices(id),
  payment_id      integer REFERENCES payments(id),
  plan_id         integer REFERENCES plans(id),
  amount          numeric(10,2) NOT NULL,
  days            integer NOT NULL,
  expires_before  timestamptz,
  expires_after   timestamptz NOT NULL,
  source          text NOT NULL DEFAULT 'manual',
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prepaid_topups_days_positive CHECK (days > 0),
  CONSTRAINT prepaid_topups_source_known
    CHECK (source IN ('manual','portal','walled-garden','webhook','migration'))
);

CREATE INDEX IF NOT EXISTS idx_prepaid_topups_subscriber ON prepaid_topups (subscriber_id);
CREATE INDEX IF NOT EXISTS idx_prepaid_topups_created    ON prepaid_topups (created_at DESC);

-- One top-up per invoice. The Xendit webhook can be delivered more than once
-- for the same invoice, and without this a retry would silently buy a second
-- 30 days for free.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prepaid_topups_invoice
  ON prepaid_topups (invoice_id) WHERE invoice_id IS NOT NULL;

-- Separate from billing_auto_restrict_enabled on purpose: prepaid expiry has to
-- enforce from day one, while postpaid auto-restrict stays off until it has been
-- watched in dry run. One flag would arm both at once.
INSERT INTO system_settings (key, value) VALUES
  ('prepaid_auto_expire_enabled', 'false'),
  ('prepaid_expiry_grace_hours',  '0'),
  ('prepaid_max_per_run',         '25')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ── added during build ──────────────────────────────────────
-- A top-up bought online is a PENDING invoice until Xendit calls back, so the
-- webhook needs to know, at callback time, that this invoice buys service time
-- and how much. Carrying it in notes would mean parsing prose in the one code
-- path that must not guess. NULL = an ordinary invoice, which is all 211 today.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS prepaid_days integer;

COMMENT ON COLUMN invoices.prepaid_days IS
  'Days of prepaid service this invoice buys once paid. NULL = ordinary postpaid invoice.';

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_prepaid_days_positive;
ALTER TABLE invoices ADD CONSTRAINT invoices_prepaid_days_positive
  CHECK (prepaid_days IS NULL OR prepaid_days > 0);
