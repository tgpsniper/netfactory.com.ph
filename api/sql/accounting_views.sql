-- Accounting reporting views expected by src/routes/accounting.js but NOT created
-- by `prisma db push` (Prisma doesn't manage views). Recreate after any fresh
-- schema push:  psql "$DATABASE_URL" -f sql/accounting_views.sql
-- Reconstructed 2026-07-22 from the same base tables the (working) income-statement
-- endpoint uses; originals were a j2network production carryover that the install missed.

-- AR aging: open receivables bucketed by days overdue (columns due_date/balance/aging_bracket
-- are consumed by GET /api/accounting/receivables/reports/aging).
CREATE OR REPLACE VIEW vw_ar_aging AS
SELECT ar.*,
  CASE
    WHEN ar.due_date IS NULL OR CURRENT_DATE <= ar.due_date THEN 'Current'
    WHEN CURRENT_DATE - ar.due_date BETWEEN 1  AND 30 THEN '1-30 Days'
    WHEN CURRENT_DATE - ar.due_date BETWEEN 31 AND 60 THEN '31-60 Days'
    WHEN CURRENT_DATE - ar.due_date BETWEEN 61 AND 90 THEN '61-90 Days'
    ELSE 'Over 90 Days'
  END AS aging_bracket
FROM accounts_receivable ar
WHERE COALESCE(ar.balance, 0) > 0;

-- Trial balance: per active account, posted debit/credit totals + net balance.
CREATE OR REPLACE VIEW vw_trial_balance AS
SELECT
  coa.account_code,
  coa.account_name,
  coa.account_type,
  COALESCE(SUM(jel.debit),  0) AS total_debit,
  COALESCE(SUM(jel.credit), 0) AS total_credit,
  COALESCE(SUM(jel.debit),  0) - COALESCE(SUM(jel.credit), 0) AS balance
FROM chart_of_accounts coa
LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.status = 'posted'
WHERE coa.is_active = TRUE
GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type
ORDER BY coa.account_code;

-- AP aging: open payables bucketed by days overdue (mirror of vw_ar_aging).
CREATE OR REPLACE VIEW vw_ap_aging AS
SELECT ap.*,
  CASE
    WHEN ap.due_date IS NULL OR CURRENT_DATE <= ap.due_date THEN 'Current'
    WHEN CURRENT_DATE - ap.due_date BETWEEN 1  AND 30 THEN '1-30 Days'
    WHEN CURRENT_DATE - ap.due_date BETWEEN 31 AND 60 THEN '31-60 Days'
    WHEN CURRENT_DATE - ap.due_date BETWEEN 61 AND 90 THEN '61-90 Days'
    ELSE 'Over 90 Days'
  END AS aging_bracket
FROM accounts_payable ap
WHERE COALESCE(ap.balance, 0) > 0;
