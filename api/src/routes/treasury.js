const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');

// ---- Expense receipt/attachment upload (PDF + images), mirrors the subscriber-attachment pattern ----
const multer = require('multer');
const pathLib = require('path');
const fsLib = require('fs');
const expenseAttachDir = '/var/www/netfactory.com.ph/html/uploads/expenses';
if (!fsLib.existsSync(expenseAttachDir)) fsLib.mkdirSync(expenseAttachDir, { recursive: true });
const expenseAttachUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, expenseAttachDir),
        filename: (req, file, cb) => {
            const ext = pathLib.extname(file.originalname).toLowerCase();
            cb(null, `exp_${req.params.id}_${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
        if (allowed.includes(pathLib.extname(file.originalname).toLowerCase())) cb(null, true);
        else cb(new Error('Only PDF, JPG, PNG, and WEBP files are allowed'));
    }
});

const serializeResult = (rows) => {
    return JSON.parse(JSON.stringify(rows, (key, value) => {
        if (typeof value === 'bigint') return Number(value);
        if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Decimal') return Number(value);
        return value;
    }));
};

const dbQuery = async (prisma, sql, params = []) => {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return { rows: serializeResult(rows) };
};

const dbExecute = async (prisma, sql, params = []) => {
    await prisma.$executeRawUnsafe(sql, ...params);
};

const generateNumber = async (prisma, prefix, date) => {
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const result = await dbQuery(
        prisma,
        `SELECT COUNT(*) as count FROM (
            SELECT 1 FROM expenses WHERE expense_number LIKE $1
            UNION ALL
            SELECT 1 FROM deposits WHERE deposit_number LIKE $1
            UNION ALL
            SELECT 1 FROM fund_transfers WHERE transfer_number LIKE $1
        ) AS combined`,
        [`${prefix}-${dateStr}-%`]
    );
    const count = parseInt(result.rows[0]?.count || 0) + 1;
    return `${prefix}-${dateStr}-${String(count).padStart(4, '0')}`;
};

const getUserIdentity = (req) => {
    return req.user?.name || req.user?.email || 'system';
};

// ============================================================
// JOURNAL ENTRY VOUCHER (JEV) auto-generation from expenses
// ------------------------------------------------------------
// One posted JEV per (receipt date + fund). Debit each expense
// category's mapped COA account; credit the fund's cash account.
// Expenses are linked back via expenses.journal_entry_id so they
// are never double-vouchered.
// ============================================================
const MISC_ACCOUNT_CODE = '5600';

const accountIdByCode = async (prisma, code) => {
    const { rows } = await dbQuery(prisma, `SELECT id FROM chart_of_accounts WHERE account_code = $1 LIMIT 1`, [code]);
    return rows[0]?.id || null;
};

const generateJevForExpenses = async (prisma, expenseIds, createdBy) => {
    if (!Array.isArray(expenseIds) || !expenseIds.length) return [];

    const { rows: exps } = await dbQuery(prisma,
        `SELECT e.id, e.fund_account_id, e.amount, e.description, e.reference_number,
                e.vendor_address, e.vendor_tin,
                COALESCE(NULLIF(e.vendor_name, ''), v.name) AS vendor_name,
                COALESCE(e.receipt_date, e.created_at::date) AS edate,
                ec.name AS category_name, ec.coa_account_id,
                fa.name AS fund_name, fa.type AS fund_type
         FROM expenses e
         LEFT JOIN expense_categories ec ON e.category_id = ec.id
         LEFT JOIN fund_accounts fa ON e.fund_account_id = fa.id
         LEFT JOIN vendors v ON e.vendor_id = v.id
         WHERE e.id = ANY($1::int[]) AND e.journal_entry_id IS NULL AND e.status <> 'voided'`,
        [expenseIds]);
    if (!exps.length) return [];

    const miscAcc = await accountIdByCode(prisma, MISC_ACCOUNT_CODE);
    const cashOnHand = await accountIdByCode(prisma, '1000');
    const cashInBank = await accountIdByCode(prisma, '1010');

    // Group by date + fund (credit account depends on the fund)
    const groups = {};
    for (const e of exps) {
        const d = (e.edate instanceof Date) ? e.edate.toISOString().slice(0, 10) : String(e.edate).slice(0, 10);
        const key = d + '|' + e.fund_account_id;
        if (!groups[key]) groups[key] = { date: d, fundId: e.fund_account_id, fundName: e.fund_name, fundType: e.fund_type, items: [] };
        groups[key].items.push(e);
    }

    const created = [];
    for (const key of Object.keys(groups)) {
        const g = groups[key];
        let total = 0;
        for (const e of g.items) total += parseFloat(e.amount || 0);
        const cashAcctId = g.fundType === 'bank' ? cashInBank : cashOnHand;

        const je = await dbQuery(prisma,
            `INSERT INTO journal_entries (entry_date, description, reference, source, total_debit, total_credit, status, posted_by, posted_at, created_by)
             VALUES ($1::date, $2, $3, 'expense', $4::numeric, $4::numeric, 'posted', $5, NOW(), $5) RETURNING id, entry_number`,
            [g.date, `Operating expenses — ${g.date} (${g.fundName})`, `${g.items.length} expense(s)`, total, createdBy]);
        const jeId = je.rows[0].id;

        // One detailed debit line per expense — carries the full expense-sheet fields
        for (const e of g.items) {
            await dbExecute(prisma,
                `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, ref_no, vendor, address, tin, category)
                 VALUES ($1, $2, $3::numeric, 0, $4, $5, $6, $7, $8, $9)`,
                [jeId, e.coa_account_id || miscAcc, parseFloat(e.amount || 0), e.description || '', e.reference_number || null, e.vendor_name || null, e.vendor_address || null, e.vendor_tin || null, e.category_name || null]);
        }
        // Credit: source of funds (cash)
        await dbExecute(prisma,
            `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, category, vendor) VALUES ($1, $2, 0, $3::numeric, $4, 'Source of Funds', $5)`,
            [jeId, cashAcctId, total, `Paid from ${g.fundName}`, g.fundName]);

        await dbExecute(prisma, `UPDATE expenses SET journal_entry_id = $1 WHERE id = ANY($2::int[])`, [jeId, g.items.map(e => e.id)]);
        created.push({ id: jeId, entry_number: je.rows[0].entry_number, date: g.date, total, fund: g.fundName });
    }
    return created;
};

// ==================== FUND ACCOUNTS ====================

router.get('/funds', adminAuth(), async (req, res) => {
    try {
        const { rows } = await dbQuery(
            req.prisma,
            `SELECT
                fa.id, fa.name, fa.type, fa.bank_name, fa.account_number, fa.description,
                fa.opening_balance, fa.current_balance, fa.is_active, fa.created_by, fa.created_at, fa.updated_at,
                COALESCE(tc.transaction_count, 0) as transaction_count
            FROM fund_accounts fa
            LEFT JOIN (
                SELECT fund_account_id, COUNT(*) as transaction_count
                FROM fund_transactions
                GROUP BY fund_account_id
            ) tc ON fa.id = tc.fund_account_id
            ORDER BY fa.id ASC`
        );
        res.json({ success: true, funds: rows });
    } catch (err) {
        console.error('Error fetching funds:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/funds', adminAuth(), async (req, res) => {
    try {
        const { name, type, bankName, accountNumber, description, openingBalance } = req.body;
        const createdBy = getUserIdentity(req);
        const bal = parseFloat(openingBalance) || 0;

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_accounts
            (name, type, bank_name, account_number, description, opening_balance, current_balance, created_by)
            VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8)`,
            [name, type, bankName || null, accountNumber || null, description || null, bal, bal, createdBy]
        );

        const { rows: fundRows } = await dbQuery(
            req.prisma,
            `SELECT id, name, type, bank_name, account_number, description, opening_balance, current_balance, is_active, created_by, created_at, updated_at
            FROM fund_accounts WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
            [name]
        );
        const fund = fundRows[0];

        if (bal > 0 && fund) {
            await dbExecute(
                req.prisma,
                `INSERT INTO fund_transactions
                (fund_account_id, type, amount, running_balance, description, created_by)
                VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6)`,
                [fund.id, 'opening', bal, bal, `Opening balance for ${name}`, createdBy]
            );
        }

        res.json({ success: true, fund });
    } catch (err) {
        console.error('Error creating fund:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/funds/:id', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, type, bankName, accountNumber, description, isActive } = req.body;

        await dbExecute(
            req.prisma,
            `UPDATE fund_accounts
            SET name = $1, type = $2, bank_name = $3, account_number = $4, description = $5, is_active = $6, updated_at = NOW()
            WHERE id = $7`,
            [name, type, bankName || null, accountNumber || null, description || null, isActive !== false, id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error updating fund:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/funds/:id/transactions', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const limit = parseInt(req.query.limit) || 50;

        const { rows } = await dbQuery(
            req.prisma,
            `SELECT id, fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by, created_at
            FROM fund_transactions
            WHERE fund_account_id = $1
            ORDER BY created_at DESC
            LIMIT $2`,
            [id, limit]
        );

        res.json({ success: true, transactions: rows });
    } catch (err) {
        console.error('Error fetching transactions:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== VENDORS (for expense dropdown) ====================

router.get('/vendors', adminAuth(), async (req, res) => {
    try {
        const { rows } = await dbQuery(
            req.prisma,
            `SELECT id, name FROM vendors ORDER BY name ASC`
        );
        res.json({ success: true, vendors: rows });
    } catch (err) {
        console.error('Error fetching vendors:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== EXPENSE CATEGORIES ====================

router.get('/expense-categories', adminAuth(), async (req, res) => {
    try {
        const { rows } = await dbQuery(
            req.prisma,
            `SELECT id, name, description, parent_id, is_active, created_at
            FROM expense_categories
            ORDER BY name ASC`
        );
        res.json({ success: true, categories: rows });
    } catch (err) {
        console.error('Error fetching expense categories:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== EXPENSES ====================

router.get('/expenses', adminAuth(), async (req, res) => {
    try {
        const { status = 'all', category = '', fund = '', date_from = '', date_to = '' } = req.query;
        let whereClause = '1=1';
        const params = [];
        let paramIndex = 1;

        if (status && status !== 'all') {
            whereClause += ` AND e.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }
        if (category) {
            whereClause += ` AND e.category_id = $${paramIndex}`;
            params.push(parseInt(category));
            paramIndex++;
        }
        if (fund) {
            whereClause += ` AND e.fund_account_id = $${paramIndex}`;
            params.push(parseInt(fund));
            paramIndex++;
        }
        if (date_from) {
            whereClause += ` AND COALESCE(e.receipt_date, e.created_at::date) >= $${paramIndex}::date`;
            params.push(date_from);
            paramIndex++;
        }
        if (date_to) {
            whereClause += ` AND COALESCE(e.receipt_date, e.created_at::date) <= $${paramIndex}::date`;
            params.push(date_to);
            paramIndex++;
        }

        const { rows } = await dbQuery(
            req.prisma,
            `SELECT
                e.id, e.expense_number, e.fund_account_id, e.vendor_id, e.category_id, e.amount,
                e.description, e.reference_number, e.receipt_date, e.status, e.notes, e.approved_by,
                e.approved_at, e.created_by, e.created_at, e.updated_at,
                e.vendor_address, e.vendor_tin, e.journal_entry_id, e.attachment_url,
                fa.name as fund_name, ec.name as category_name,
                COALESCE(NULLIF(e.vendor_name, ''), v.name) as vendor_name,
                je.entry_number as jev_number
            FROM expenses e
            LEFT JOIN fund_accounts fa ON e.fund_account_id = fa.id
            LEFT JOIN expense_categories ec ON e.category_id = ec.id
            LEFT JOIN vendors v ON e.vendor_id = v.id
            LEFT JOIN journal_entries je ON e.journal_entry_id = je.id
            WHERE ${whereClause}
            ORDER BY COALESCE(e.receipt_date, e.created_at::date) DESC, e.id DESC`,
            params
        );

        const total = rows.length;
        const totalAmount = rows.reduce((sum, exp) => sum + parseFloat(exp.amount || 0), 0);
        res.json({ success: true, expenses: rows, total, totalAmount });
    } catch (err) {
        console.error('Error fetching expenses:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/expenses', adminAuth(), async (req, res) => {
    try {
        const { fundAccountId, amount, categoryId, vendorId, vendorName, vendorAddress, vendorTin, description, referenceNumber, receiptDate, notes } = req.body;
        const createdBy = getUserIdentity(req);
        const expenseNumber = await generateNumber(req.prisma, 'EXP', new Date());
        const amt = parseFloat(amount);

        await dbExecute(
            req.prisma,
            `INSERT INTO expenses
            (expense_number, fund_account_id, vendor_id, vendor_name, vendor_address, vendor_tin, category_id, amount, description, reference_number, receipt_date, status, notes, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11::date, $12, $13, $14)`,
            [expenseNumber, parseInt(fundAccountId), vendorId ? parseInt(vendorId) : null, vendorName || null, vendorAddress || null, vendorTin || null, categoryId ? parseInt(categoryId) : null, amt, description, referenceNumber || null, receiptDate || null, 'recorded', notes || null, createdBy]
        );

        const { rows: fundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [parseInt(fundAccountId)]);
        const newBalance = parseFloat(fundRows[0]?.current_balance || 0) - amt;

        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [newBalance, parseInt(fundAccountId)]);

        const { rows: expRows } = await dbQuery(req.prisma, `SELECT id FROM expenses WHERE expense_number = $1`, [expenseNumber]);

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [parseInt(fundAccountId), 'expense', -amt, newBalance, 'expense', expRows[0].id, description, createdBy]
        );

        const jev = await generateJevForExpenses(req.prisma, [expRows[0].id], createdBy);

        res.json({ success: true, expenseNumber, id: expRows[0].id, jev });
    } catch (err) {
        console.error('Error recording expense:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Upload / replace a PDF (or image) receipt attachment for an expense
router.post('/expenses/:id/attachment', adminAuth(), expenseAttachUpload.single('file'), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        const { rows } = await dbQuery(req.prisma, `SELECT attachment_url FROM expenses WHERE id = $1`, [id]);
        if (!rows.length) {
            fsLib.unlink(pathLib.join(expenseAttachDir, req.file.filename), () => {});
            return res.status(404).json({ success: false, error: 'Expense not found' });
        }
        // Remove the previous file if one was attached
        const prev = rows[0].attachment_url;
        if (prev) {
            const prevPath = `/var/www/netfactory.com.ph/html${prev}`;
            if (fsLib.existsSync(prevPath)) fsLib.unlink(prevPath, () => {});
        }
        const fileUrl = `/uploads/expenses/${req.file.filename}`;
        await dbExecute(req.prisma, `UPDATE expenses SET attachment_url = $1, updated_at = NOW() WHERE id = $2`, [fileUrl, id]);
        res.json({ success: true, url: fileUrl });
    } catch (err) {
        console.error('Error uploading expense attachment:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Remove an expense's attachment
router.delete('/expenses/:id/attachment', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { rows } = await dbQuery(req.prisma, `SELECT attachment_url FROM expenses WHERE id = $1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Expense not found' });
        const cur = rows[0].attachment_url;
        if (cur) {
            const curPath = `/var/www/netfactory.com.ph/html${cur}`;
            if (fsLib.existsSync(curPath)) fsLib.unlink(curPath, () => {});
        }
        await dbExecute(req.prisma, `UPDATE expenses SET attachment_url = NULL, updated_at = NOW() WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting expense attachment:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Bulk record expenses from a daily sheet (spreadsheet/CSV paste).
// Body: { fundAccountId, status?, rows: [{ date, vendor, address, tin, reference, category, description, amount }] }
// Category is matched by name (case-insensitive) and auto-created if missing.
router.post('/expenses/bulk', adminAuth(), async (req, res) => {
    try {
        const { fundAccountId, rows = [], status = 'recorded' } = req.body;
        const createdBy = getUserIdentity(req);
        if (!fundAccountId) return res.status(400).json({ success: false, error: 'Fund account is required' });
        if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ success: false, error: 'No rows to import' });

        const fundId = parseInt(fundAccountId);

        // Validate every row up front so the import is all-or-nothing.
        const clean = [];
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i] || {};
            const amt = parseFloat(String(r.amount).replace(/[, ₱]/g, ''));
            const desc = (r.description || '').trim();
            if (!desc) return res.status(400).json({ success: false, error: `Row ${i + 1}: description is required` });
            if (!isFinite(amt) || amt <= 0) return res.status(400).json({ success: false, error: `Row ${i + 1}: invalid amount "${r.amount}"` });
            clean.push({
                date: (r.date || '').trim() || null,
                vendor: (r.vendor || '').trim() || null,
                address: (r.address || '').trim() || null,
                tin: (r.tin || '').trim() || null,
                reference: (r.reference || '').trim() || null,
                category: (r.category || '').trim() || null,
                description: desc,
                amount: amt,
            });
        }

        // Resolve / create categories by name (cache within the request).
        const catCache = {};
        const resolveCategory = async (name) => {
            if (!name) return null;
            const key = name.toLowerCase();
            if (key in catCache) return catCache[key];
            const found = await dbQuery(req.prisma, `SELECT id FROM expense_categories WHERE LOWER(name) = $1 LIMIT 1`, [key]);
            let id = found.rows[0]?.id;
            if (!id) {
                await dbExecute(req.prisma, `INSERT INTO expense_categories (name, is_active, created_at) VALUES ($1, true, NOW())`, [name]);
                const created = await dbQuery(req.prisma, `SELECT id FROM expense_categories WHERE LOWER(name) = $1 LIMIT 1`, [key]);
                id = created.rows[0]?.id || null;
            }
            catCache[key] = id;
            return id;
        };

        // Vendor directory — fill blank TIN/address from the managed vendor list (matched by name).
        const { rows: vendorRows } = await dbQuery(req.prisma,
            `SELECT id, name, tin_number, address, city, municipality, province FROM vendors`);
        const vendorMap = {};
        for (const v of vendorRows) {
            const addr = [v.address, v.city, v.municipality, v.province].filter(s => s && String(s).trim()).join(', ');
            vendorMap[(v.name || '').trim().toLowerCase()] = { id: v.id, tin: v.tin_number || '', address: addr };
        }

        // Current fund balance — decrement sequentially so the running_balance ledger stays correct.
        const { rows: fundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [fundId]);
        if (!fundRows.length) return res.status(404).json({ success: false, error: 'Fund account not found' });
        let balance = parseFloat(fundRows[0].current_balance || 0);

        const created = [];
        const insertedIds = [];
        let totalAmount = 0;
        let enriched = 0;
        for (const r of clean) {
            const categoryId = await resolveCategory(r.category);
            // Enrich blanks from the vendor directory
            const dir = r.vendor ? vendorMap[r.vendor.trim().toLowerCase()] : null;
            let vendorId = null;
            if (dir) {
                vendorId = dir.id;
                if (!r.tin && dir.tin) { r.tin = dir.tin; enriched++; }
                if (!r.address && dir.address) { r.address = dir.address; }
            }
            const expenseNumber = await generateNumber(req.prisma, 'EXP', new Date());
            await dbExecute(
                req.prisma,
                `INSERT INTO expenses
                (expense_number, fund_account_id, vendor_id, vendor_name, vendor_address, vendor_tin, category_id, amount, description, reference_number, receipt_date, status, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11::date, $12, $13)`,
                [expenseNumber, fundId, vendorId, r.vendor, r.address, r.tin, categoryId, r.amount, r.description, r.reference, r.date, status, createdBy]
            );
            balance -= r.amount;
            totalAmount += r.amount;
            const { rows: expRows } = await dbQuery(req.prisma, `SELECT id FROM expenses WHERE expense_number = $1`, [expenseNumber]);
            await dbExecute(
                req.prisma,
                `INSERT INTO fund_transactions
                (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
                VALUES ($1, 'expense', $2::numeric, $3::numeric, 'expense', $4, $5, $6)`,
                [fundId, -r.amount, balance, expRows[0].id, r.description, createdBy]
            );
            insertedIds.push(expRows[0].id);
            created.push(expenseNumber);
        }

        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [balance, fundId]);

        const jev = await generateJevForExpenses(req.prisma, insertedIds, createdBy);

        res.json({ success: true, count: created.length, totalAmount, expenseNumbers: created, jevCount: jev.length, jev, enriched });
    } catch (err) {
        console.error('Error bulk-recording expenses:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Backfill / on-demand: generate JEVs for any expenses not yet vouchered (optionally within a date range / fund).
router.post('/jev/generate', adminAuth(), async (req, res) => {
    try {
        const { date_from = '', date_to = '', fund = '' } = req.body;
        const createdBy = getUserIdentity(req);
        let where = `journal_entry_id IS NULL AND status <> 'voided'`;
        const params = [];
        let i = 1;
        if (date_from) { where += ` AND COALESCE(receipt_date, created_at::date) >= $${i}::date`; params.push(date_from); i++; }
        if (date_to) { where += ` AND COALESCE(receipt_date, created_at::date) <= $${i}::date`; params.push(date_to); i++; }
        if (fund) { where += ` AND fund_account_id = $${i}`; params.push(parseInt(fund)); i++; }
        const { rows } = await dbQuery(req.prisma, `SELECT id FROM expenses WHERE ${where} ORDER BY COALESCE(receipt_date, created_at::date), id`, params);
        const ids = rows.map(r => r.id);
        const jev = await generateJevForExpenses(req.prisma, ids, createdBy);
        res.json({ success: true, expenses: ids.length, jevCount: jev.length, jev });
    } catch (err) {
        console.error('Error generating JEVs:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/expenses/:id/approve', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const approvedBy = getUserIdentity(req);
        await dbExecute(req.prisma, `UPDATE expenses SET status = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $3`, ['approved', approvedBy, id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error approving expense:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/expenses/:id/void', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const createdBy = getUserIdentity(req);

        const { rows: expenseRows } = await dbQuery(req.prisma, `SELECT fund_account_id, amount, description FROM expenses WHERE id = $1`, [id]);
        const expense = expenseRows[0];
        if (!expense) return res.status(404).json({ success: false, error: 'Expense not found' });

        await dbExecute(req.prisma, `UPDATE expenses SET status = $1, updated_at = NOW() WHERE id = $2`, ['voided', id]);

        const { rows: fundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [expense.fund_account_id]);
        const restoreAmount = parseFloat(expense.amount);
        const newBalance = parseFloat(fundRows[0]?.current_balance || 0) + restoreAmount;

        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [newBalance, expense.fund_account_id]);

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [expense.fund_account_id, 'void_expense', restoreAmount, newBalance, 'expense', id, `Void: ${expense.description}`, createdBy]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error voiding expense:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== DEPOSITS ====================

router.get('/deposits', adminAuth(), async (req, res) => {
    try {
        const { status = 'all', fund = '' } = req.query;
        let whereClause = '1=1';
        const params = [];
        let paramIndex = 1;

        if (status && status !== 'all') {
            whereClause += ` AND d.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }
        if (fund) {
            whereClause += ` AND d.fund_account_id = $${paramIndex}`;
            params.push(parseInt(fund));
            paramIndex++;
        }

        const { rows } = await dbQuery(
            req.prisma,
            `SELECT d.id, d.deposit_number, d.fund_account_id, d.deposit_date, d.total_amount,
                    d.slip_number, d.status, d.notes, d.confirmed_by, d.confirmed_at,
                    d.created_by, d.created_at, d.updated_at,
                    fa.name as fund_name,
                    (SELECT COUNT(*) FROM deposit_items di WHERE di.deposit_id = d.id) as item_count
            FROM deposits d
            LEFT JOIN fund_accounts fa ON d.fund_account_id = fa.id
            WHERE ${whereClause}
            ORDER BY d.created_at DESC`,
            params
        );

        res.json({ success: true, deposits: rows });
    } catch (err) {
        console.error('Error fetching deposits:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/deposits', adminAuth(), async (req, res) => {
    try {
        const { fundAccountId, depositDate, slipNumber, notes, items } = req.body;
        const createdBy = getUserIdentity(req);
        const depositNumber = await generateNumber(req.prisma, 'DEP', new Date());
        const totalAmount = items.reduce((sum, item) => sum + parseFloat(item.amount || 0), 0);

        await dbExecute(
            req.prisma,
            `INSERT INTO deposits
            (deposit_number, fund_account_id, deposit_date, total_amount, slip_number, status, notes, created_by)
            VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8)`,
            [depositNumber, parseInt(fundAccountId), depositDate, totalAmount, slipNumber || null, 'pending', notes || null, createdBy]
        );

        const { rows: depositRows } = await dbQuery(req.prisma, `SELECT id FROM deposits WHERE deposit_number = $1`, [depositNumber]);
        const depositId = depositRows[0].id;

        for (const item of items) {
            await dbExecute(
                req.prisma,
                `INSERT INTO deposit_items (deposit_id, payment_id, description, amount) VALUES ($1, $2, $3, $4::numeric)`,
                [depositId, item.paymentId ? parseInt(item.paymentId) : null, item.description || null, parseFloat(item.amount)]
            );
        }

        const { rows: fundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [parseInt(fundAccountId)]);
        const newBalance = parseFloat(fundRows[0]?.current_balance || 0) + totalAmount;

        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [newBalance, parseInt(fundAccountId)]);

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [parseInt(fundAccountId), 'deposit', totalAmount, newBalance, 'deposit', depositId, depositNumber, createdBy]
        );

        res.json({ success: true, depositNumber });
    } catch (err) {
        console.error('Error creating deposit:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/deposits/:id', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const { rows: depositRows } = await dbQuery(
            req.prisma,
            `SELECT d.id, d.deposit_number, d.fund_account_id, d.deposit_date, d.total_amount, d.slip_number,
                    d.status, d.notes, d.confirmed_by, d.confirmed_at, d.created_by, d.created_at, d.updated_at,
                    fa.name as fund_name
            FROM deposits d
            LEFT JOIN fund_accounts fa ON d.fund_account_id = fa.id
            WHERE d.id = $1`,
            [id]
        );
        const deposit = depositRows[0];
        if (!deposit) return res.status(404).json({ success: false, error: 'Deposit not found' });

        const { rows: itemRows } = await dbQuery(req.prisma, `SELECT id, deposit_id, payment_id, description, amount, created_at FROM deposit_items WHERE deposit_id = $1 ORDER BY created_at ASC`, [id]);

        res.json({ success: true, deposit: { ...deposit, items: itemRows } });
    } catch (err) {
        console.error('Error fetching deposit:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/deposits/:id/confirm', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const confirmedBy = getUserIdentity(req);
        await dbExecute(req.prisma, `UPDATE deposits SET status = $1, confirmed_by = $2, confirmed_at = NOW(), updated_at = NOW() WHERE id = $3`, ['confirmed', confirmedBy, id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error confirming deposit:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/deposits/:id/void', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const createdBy = getUserIdentity(req);

        const { rows: depositRows } = await dbQuery(req.prisma, `SELECT fund_account_id, total_amount, deposit_number FROM deposits WHERE id = $1`, [id]);
        const deposit = depositRows[0];
        if (!deposit) return res.status(404).json({ success: false, error: 'Deposit not found' });

        await dbExecute(req.prisma, `UPDATE deposits SET status = $1, updated_at = NOW() WHERE id = $2`, ['voided', id]);

        const { rows: fundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [deposit.fund_account_id]);
        const reverseAmount = parseFloat(deposit.total_amount);
        const newBalance = parseFloat(fundRows[0]?.current_balance || 0) - reverseAmount;

        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [newBalance, deposit.fund_account_id]);

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [deposit.fund_account_id, 'void_deposit', -reverseAmount, newBalance, 'deposit', id, `Void: ${deposit.deposit_number}`, createdBy]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error voiding deposit:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== UNDEPOSITED PAYMENTS ====================

router.get('/undeposited-payments', adminAuth(), async (req, res) => {
    try {
        res.json({ success: true, count: 0, total: 0 });
    } catch (err) {
        console.error('Error fetching undeposited payments:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== TRANSFERS ====================

router.get('/transfers', adminAuth(), async (req, res) => {
    try {
        const { rows } = await dbQuery(
            req.prisma,
            `SELECT
                ft.id, ft.transfer_number, ft.from_fund_id, ft.to_fund_id, ft.amount,
                ft.description, ft.reference_number, ft.status, ft.created_by, ft.created_at,
                fa1.name as from_fund_name, fa2.name as to_fund_name
            FROM fund_transfers ft
            LEFT JOIN fund_accounts fa1 ON ft.from_fund_id = fa1.id
            LEFT JOIN fund_accounts fa2 ON ft.to_fund_id = fa2.id
            ORDER BY ft.created_at DESC`
        );
        res.json({ success: true, transfers: rows });
    } catch (err) {
        console.error('Error fetching transfers:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/transfers', adminAuth(), async (req, res) => {
    try {
        const { fromFundId, toFundId, amount, referenceNumber, description } = req.body;
        const createdBy = getUserIdentity(req);
        const transferNumber = await generateNumber(req.prisma, 'TRF', new Date());
        const amt = parseFloat(amount);

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transfers
            (transfer_number, from_fund_id, to_fund_id, amount, description, reference_number, status, created_by)
            VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8)`,
            [transferNumber, parseInt(fromFundId), parseInt(toFundId), amt, description || null, referenceNumber || null, 'completed', createdBy]
        );

        const { rows: fromFundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [parseInt(fromFundId)]);
        const fromNewBalance = parseFloat(fromFundRows[0]?.current_balance || 0) - amt;
        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [fromNewBalance, parseInt(fromFundId)]);

        const { rows: toFundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [parseInt(toFundId)]);
        const toNewBalance = parseFloat(toFundRows[0]?.current_balance || 0) + amt;
        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [toNewBalance, parseInt(toFundId)]);

        const { rows: transferRows } = await dbQuery(req.prisma, `SELECT id FROM fund_transfers WHERE transfer_number = $1`, [transferNumber]);
        const transferId = transferRows[0].id;

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [parseInt(fromFundId), 'transfer_out', -amt, fromNewBalance, 'transfer', transferId, `Transfer out: ${description || transferNumber}`, createdBy]
        );

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [parseInt(toFundId), 'transfer_in', amt, toNewBalance, 'transfer', transferId, `Transfer in: ${description || transferNumber}`, createdBy]
        );

        res.json({ success: true, transferNumber });
    } catch (err) {
        console.error('Error creating transfer:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/transfers/:id/void', adminAuth(), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const createdBy = getUserIdentity(req);

        const { rows: transferRows } = await dbQuery(req.prisma, `SELECT from_fund_id, to_fund_id, amount, transfer_number FROM fund_transfers WHERE id = $1`, [id]);
        const transfer = transferRows[0];
        if (!transfer) return res.status(404).json({ success: false, error: 'Transfer not found' });

        const amt = parseFloat(transfer.amount);
        await dbExecute(req.prisma, `UPDATE fund_transfers SET status = $1 WHERE id = $2`, ['voided', id]);

        const { rows: fromFundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [transfer.from_fund_id]);
        const fromNewBalance = parseFloat(fromFundRows[0]?.current_balance || 0) + amt;
        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [fromNewBalance, transfer.from_fund_id]);

        const { rows: toFundRows } = await dbQuery(req.prisma, `SELECT current_balance FROM fund_accounts WHERE id = $1`, [transfer.to_fund_id]);
        const toNewBalance = parseFloat(toFundRows[0]?.current_balance || 0) - amt;
        await dbExecute(req.prisma, `UPDATE fund_accounts SET current_balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [toNewBalance, transfer.to_fund_id]);

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [transfer.from_fund_id, 'void_transfer', amt, fromNewBalance, 'transfer', id, `Void: ${transfer.transfer_number}`, createdBy]
        );

        await dbExecute(
            req.prisma,
            `INSERT INTO fund_transactions
            (fund_account_id, type, amount, running_balance, reference_type, reference_id, description, created_by)
            VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8)`,
            [transfer.to_fund_id, 'void_transfer', -amt, toNewBalance, 'transfer', id, `Void: ${transfer.transfer_number}`, createdBy]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error voiding transfer:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
