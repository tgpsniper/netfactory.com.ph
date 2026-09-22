const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { recordArPayment, recordApPayment } = require('../utils/receipts');

// BigInt serialization for Prisma raw queries (COUNT/SUM return BigInt)
const serializeResult = (rows) => {
    return JSON.parse(JSON.stringify(rows, (key, value) => {
        if (typeof value === 'bigint') return Number(value);
        if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Decimal') return Number(value);
        return value;
    }));
};
// Prisma helper - wraps $queryRawUnsafe to return { rows } like pg
const dbQuery = async (prisma, sql, params = []) => {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return { rows: serializeResult(rows) };
};
const dbExecute = async (prisma, sql, params = []) => {
    await prisma.$executeRawUnsafe(sql, ...params);
};

// ============================================================
// MIDDLEWARE - Audit Logger
// ============================================================
const auditLog = async (prisma, tableName, recordId, action, oldValues, newValues, performedBy, ip) => {
    try {
        await dbExecute(prisma,
            `INSERT INTO accounting_audit_log (table_name, record_id, action, old_values, new_values, performed_by, ip_address)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
            [tableName, recordId, action, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, performedBy || 'system', ip]
        );
    } catch (err) {
        console.error('Audit log error:', err.message);
    }
};

// ============================================================
// DASHBOARD STATS
// ============================================================
router.get('/dashboard', adminAuth(), async (req, res) => {
    try {
        const stats = {};

        // AR Summary
        const arResult = await dbQuery(req.prisma,`
            SELECT 
                COUNT(*) FILTER (WHERE status IN ('pending','partial','overdue')) AS ar_open_count,
                COALESCE(SUM(total_amount - amount_paid) FILTER (WHERE status IN ('pending','partial','overdue')), 0) AS ar_open_balance,
                COUNT(*) FILTER (WHERE status = 'overdue') AS ar_overdue_count,
                COALESCE(SUM(total_amount - amount_paid) FILTER (WHERE status = 'overdue'), 0) AS ar_overdue_balance
            FROM accounts_receivable
        `);
        stats.ar = arResult.rows[0];

        // AP Summary
        const apResult = await dbQuery(req.prisma,`
            SELECT 
                COUNT(*) FILTER (WHERE status IN ('pending','partial','overdue')) AS ap_open_count,
                COALESCE(SUM(total_amount - amount_paid) FILTER (WHERE status IN ('pending','partial','overdue')), 0) AS ap_open_balance,
                COUNT(*) FILTER (WHERE status = 'overdue') AS ap_overdue_count,
                COALESCE(SUM(total_amount - amount_paid) FILTER (WHERE status = 'overdue'), 0) AS ap_overdue_balance
            FROM accounts_payable
        `);
        stats.ap = apResult.rows[0];

        // Employee counts
        const empResult = await dbQuery(req.prisma,`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'active') AS active_employees,
                COUNT(*) AS total_employees
            FROM employees
        `);
        stats.employees = empResult.rows[0];

        // Latest payroll
        const payrollResult = await dbQuery(req.prisma,`
            SELECT id, period_start, period_end, status, total_gross, total_net
            FROM payroll_periods ORDER BY created_at DESC LIMIT 1
        `);
        stats.latest_payroll = payrollResult.rows[0] || null;

        // Monthly revenue (current month)
        const revenueResult = await dbQuery(req.prisma,`
            SELECT COALESCE(SUM(amount), 0) AS monthly_collections
            FROM ar_payments
            WHERE EXTRACT(MONTH FROM payment_date) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(YEAR FROM payment_date) = EXTRACT(YEAR FROM CURRENT_DATE)
        `);
        stats.monthly_collections = revenueResult.rows[0].monthly_collections;

        // Monthly expenses (current month)
        const expenseResult = await dbQuery(req.prisma,`
            SELECT COALESCE(SUM(amount), 0) AS monthly_payments
            FROM ap_payments
            WHERE EXTRACT(MONTH FROM payment_date) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(YEAR FROM payment_date) = EXTRACT(YEAR FROM CURRENT_DATE)
        `);
        stats.monthly_payments = expenseResult.rows[0].monthly_payments;

        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// DEPARTMENTS
// ============================================================
router.get('/departments', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,'SELECT * FROM departments ORDER BY name');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/departments', adminAuth(), async (req, res) => {
    try {
        const { name, description } = req.body;
        const result = await dbQuery(req.prisma,
            'INSERT INTO departments (name, description) VALUES ($1, $2) RETURNING *',
            [name, description]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// EMPLOYEES
// ============================================================
router.get('/employees', adminAuth(), async (req, res) => {
    try {
        const { status, department_id, search } = req.query;
        let query = `
            SELECT e.*, d.name AS department_name 
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND e.status = $${params.length}`;
        }
        if (department_id) {
            params.push(parseInt(department_id));
            query += ` AND e.department_id = $${params.length}`;
        }
        if (search) {
            params.push(`%${search}%`);
            query += ` AND (e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length} OR e.employee_id ILIKE $${params.length})`;
        }

        query += ' ORDER BY e.last_name, e.first_name';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/employees/:id', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,`
            SELECT e.*, d.name AS department_name 
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE e.id = $1
        `, [parseInt(req.params.id)]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Employee not found' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/employees', adminAuth(), async (req, res) => {
    try {
        const {
            first_name, last_name, middle_name, email, phone, address,
            date_of_birth, gender, civil_status, department_id, position,
            hire_date, employment_type, salary_type, salary_rate,
            sss_number, philhealth_number, pagibig_number, tin_number,
            bank_name, bank_account_number,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
            notes
        } = req.body;

        const result = await dbQuery(req.prisma,`
            INSERT INTO employees (
                first_name, last_name, middle_name, email, phone, address,
                date_of_birth, gender, civil_status, department_id, position,
                hire_date, employment_type, salary_type, salary_rate,
                sss_number, philhealth_number, pagibig_number, tin_number,
                bank_name, bank_account_number,
                emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
                notes
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10::int,$11,$12::date,$13,$14,$15::numeric,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
            RETURNING *
        `, [first_name, last_name, middle_name, email, phone, address,
            date_of_birth, gender, civil_status, department_id, position,
            hire_date, employment_type || 'regular', salary_type, salary_rate || 0,
            sss_number, philhealth_number, pagibig_number, tin_number,
            bank_name, bank_account_number,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
            notes]);

        await auditLog(req.prisma, 'employees', result.rows[0].id, 'create', null, result.rows[0], req.body.performed_by, req.ip);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/employees/:id', adminAuth(), async (req, res) => {
    try {
        const fields = req.body;
        const setClauses = [];
        const values = [];
        let idx = 1;

        const allowedFields = [
            'first_name','last_name','middle_name','email','phone','address',
            'date_of_birth','gender','civil_status','department_id','position',
            'hire_date','employment_type','salary_type','salary_rate',
            'sss_number','philhealth_number','pagibig_number','tin_number',
            'bank_name','bank_account_number',
            'emergency_contact_name','emergency_contact_phone','emergency_contact_relation',
            'status','termination_date','notes'
        ];

        const dateFields = ['date_of_birth','hire_date','termination_date'];
        const intFields = ['department_id'];
        const numFields = ['salary_rate'];

        for (const [key, value] of Object.entries(fields)) {
            if (allowedFields.includes(key)) {
                const cast = dateFields.includes(key) ? '::date' : intFields.includes(key) ? '::int' : numFields.includes(key) ? '::numeric' : '';
                setClauses.push(`${key} = $${idx}${cast}`);
                values.push(value);
                idx++;
            }
        }

        if (setClauses.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

        setClauses.push(`updated_at = NOW()`);
        values.push(parseInt(req.params.id));

        const result = await dbQuery(req.prisma,
            `UPDATE employees SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Employee not found' });
        await auditLog(req.prisma, 'employees', req.params.id, 'update', null, fields, fields.performed_by, req.ip);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/accounting/employees/:id (superadmin only)
router.delete('/employees/:id', adminAuth(), async (req, res) => {
    try {
        if (req.admin.role !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'Only superadmin can delete employees' });
        }
        const id = parseInt(req.params.id);
        const emp = await dbQuery(req.prisma, 'SELECT id, employee_id, first_name, last_name FROM employees WHERE id = $1', [id]);
        if (emp.rows.length === 0) return res.status(404).json({ success: false, error: 'Employee not found' });
        await dbQuery(req.prisma, 'DELETE FROM employees WHERE id = $1', [id]);
        await auditLog(req.prisma, 'employees', id, 'delete', emp.rows[0], null, req.admin.id, req.ip);
        res.json({ success: true, message: 'Employee deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// TIME & ATTENDANCE
// ============================================================
router.get('/attendance', adminAuth(), async (req, res) => {
    try {
        const { employee_id, date_from, date_to, status } = req.query;
        let query = `
            SELECT ta.*, e.employee_id AS emp_code, e.first_name, e.last_name,
                   e.first_name || ' ' || e.last_name AS employee_name
            FROM time_attendance ta
            JOIN employees e ON ta.employee_id = e.id
            WHERE 1=1
        `;
        const params = [];

        if (employee_id) {
            params.push(employee_id);
            query += ` AND ta.employee_id = $${params.length}`;
        }
        if (date_from) {
            params.push(date_from);
            query += ` AND ta.attendance_date >= $${params.length}`;
        }
        if (date_to) {
            params.push(date_to);
            query += ` AND ta.attendance_date <= $${params.length}`;
        }
        if (status) {
            params.push(status);
            query += ` AND ta.status = $${params.length}`;
        }

        query += ' ORDER BY ta.attendance_date DESC, e.last_name';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/attendance', adminAuth(), async (req, res) => {
    try {
        const { employee_id, attendance_date, time_in, time_out, break_minutes, status, leave_type, notes } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO time_attendance (employee_id, attendance_date, time_in, time_out, break_minutes, status, leave_type, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (employee_id, attendance_date) 
            DO UPDATE SET time_in = EXCLUDED.time_in, time_out = EXCLUDED.time_out, 
                         break_minutes = EXCLUDED.break_minutes, status = EXCLUDED.status,
                         leave_type = EXCLUDED.leave_type, notes = EXCLUDED.notes
            RETURNING *
        `, [employee_id, attendance_date, time_in, time_out, break_minutes || 60, status || 'present', leave_type, notes]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Bulk attendance entry (for a full day)
router.post('/attendance/bulk', adminAuth(), async (req, res) => {
    try {
        const { date, entries } = req.body; // entries: [{ employee_id, time_in, time_out, status, ... }]
        const results = [];

        for (const entry of entries) {
            const result = await dbQuery(req.prisma,`
                INSERT INTO time_attendance (employee_id, attendance_date, time_in, time_out, break_minutes, status, leave_type, notes)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (employee_id, attendance_date) 
                DO UPDATE SET time_in = EXCLUDED.time_in, time_out = EXCLUDED.time_out,
                             break_minutes = EXCLUDED.break_minutes, status = EXCLUDED.status,
                             leave_type = EXCLUDED.leave_type, notes = EXCLUDED.notes
                RETURNING *
            `, [entry.employee_id, date, entry.time_in, entry.time_out, entry.break_minutes || 60, entry.status || 'present', entry.leave_type, entry.notes]);
            results.push(result.rows[0]);
        }

        res.json({ success: true, data: results, count: results.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Attendance summary for a period
router.get('/attendance/summary', adminAuth(), async (req, res) => {
    try {
        const { date_from, date_to } = req.query;
        const result = await dbQuery(req.prisma,`
            SELECT 
                e.id AS employee_id, e.employee_id AS emp_code,
                e.first_name || ' ' || e.last_name AS employee_name,
                e.position, d.name AS department,
                COUNT(*) FILTER (WHERE ta.status = 'present') AS days_present,
                COUNT(*) FILTER (WHERE ta.status = 'late') AS days_late,
                COUNT(*) FILTER (WHERE ta.status = 'absent') AS days_absent,
                COUNT(*) FILTER (WHERE ta.status = 'half_day') AS days_half,
                COUNT(*) FILTER (WHERE ta.status = 'leave') AS days_leave,
                COALESCE(SUM(ta.hours_worked), 0) AS total_hours,
                COALESCE(SUM(ta.overtime_hours), 0) AS total_overtime,
                COALESCE(SUM(ta.late_minutes), 0) AS total_late_minutes
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN time_attendance ta ON e.id = ta.employee_id
                AND ta.attendance_date BETWEEN $1 AND $2
            WHERE e.status = 'active'
            GROUP BY e.id, e.employee_id, e.first_name, e.last_name, e.position, d.name
            ORDER BY e.last_name
        `, [date_from, date_to]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// PAYROLL
// ============================================================

// List payroll periods
router.get('/payroll/periods', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,'SELECT * FROM payroll_periods ORDER BY period_start DESC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get payroll period with items
router.get('/payroll/periods/:id', adminAuth(), async (req, res) => {
    try {
        const period = await dbQuery(req.prisma,'SELECT * FROM payroll_periods WHERE id = $1', [parseInt(req.params.id)]);
        if (period.rows.length === 0) return res.status(404).json({ success: false, error: 'Period not found' });

        const items = await dbQuery(req.prisma,`
            SELECT pi.*, e.employee_id AS emp_code, e.first_name, e.last_name,
                   e.first_name || ' ' || e.last_name AS employee_name,
                   e.position, d.name AS department
            FROM payroll_items pi
            JOIN employees e ON pi.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE pi.payroll_period_id = $1
            ORDER BY e.last_name
        `, [parseInt(req.params.id)]);

        res.json({ success: true, data: { period: period.rows[0], items: items.rows } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create payroll period
router.post('/payroll/periods', adminAuth(), async (req, res) => {
    try {
        const { period_start, period_end, pay_date, period_type, notes, created_by } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO payroll_periods (period_start, period_end, pay_date, period_type, notes, created_by)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [period_start, period_end, pay_date, period_type || 'semi_monthly', notes, created_by]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Generate payroll for all active employees
router.post('/payroll/generate/:periodId', adminAuth(), async (req, res) => {
    try {
        const periodId = parseInt(req.params.periodId);
        const period = await dbQuery(req.prisma,'SELECT * FROM payroll_periods WHERE id = $1', [periodId]);
        if (period.rows.length === 0) return res.status(404).json({ success: false, error: 'Period not found' });

        const p = period.rows[0];
        const employees = await dbQuery(req.prisma,'SELECT * FROM employees WHERE status = $1', ['active']);
        const results = [];

        for (const emp of employees.rows) {
            // Get attendance for this period
            const attendance = await dbQuery(req.prisma,`
                SELECT 
                    COUNT(*) FILTER (WHERE status IN ('present','late')) AS days_present,
                    COALESCE(SUM(hours_worked), 0) AS total_hours,
                    COALESCE(SUM(overtime_hours), 0) AS overtime_hours,
                    COUNT(*) FILTER (WHERE status = 'half_day') AS half_days
                FROM time_attendance
                WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3
            `, [emp.id, p.period_start, p.period_end]);

            const att = attendance.rows[0];
            const daysWorked = parseFloat(att.days_present) + (parseFloat(att.half_days) * 0.5);
            const overtimeHrs = parseFloat(att.overtime_hours);

            // Calculate basic pay
            let basicPay = 0;
            if (emp.salary_type === 'monthly') {
                basicPay = parseFloat(emp.salary_rate) / 2; // Semi-monthly
            } else if (emp.salary_type === 'daily') {
                basicPay = parseFloat(emp.salary_rate) * daysWorked;
            } else {
                basicPay = parseFloat(emp.salary_rate) * parseFloat(att.total_hours);
            }

            // Overtime (1.25x daily rate / 8)
            const hourlyRate = parseFloat(emp.daily_rate) / 8;
            const overtimePay = overtimeHrs * hourlyRate * 1.25;

            const grossPay = basicPay + overtimePay;

            // Philippine statutory deductions (simplified - 2024/2025 tables)
            const monthlyGross = emp.salary_type === 'monthly' ? parseFloat(emp.salary_rate) : grossPay * 2;

            // SSS (simplified bracket)
            let sssEE = 0, sssER = 0;
            if (monthlyGross <= 4250) { sssEE = 180; sssER = 390; }
            else if (monthlyGross <= 24750) { sssEE = Math.round(monthlyGross * 0.045 / 10) * 10; sssER = Math.round(monthlyGross * 0.095 / 10) * 10; }
            else { sssEE = 1125; sssER = 2362.50; }
            sssEE = sssEE / 2; sssER = sssER / 2; // Semi-monthly

            // PhilHealth (5% total, split 50/50)
            let phEE = Math.min(Math.max(monthlyGross * 0.025, 500), 5000) / 2;
            let phER = phEE;

            // Pag-IBIG
            let piEE = Math.min(monthlyGross * 0.02, 200) / 2;
            let piER = Math.min(monthlyGross * 0.02, 200) / 2;

            // Withholding Tax (simplified)
            const taxableIncome = monthlyGross - (sssEE * 2) - (phEE * 2) - (piEE * 2);
            let withholdingTax = 0;
            if (taxableIncome > 66667) withholdingTax = 15833.33 + (taxableIncome - 66667) * 0.35;
            else if (taxableIncome > 33333) withholdingTax = 5833.33 + (taxableIncome - 33333) * 0.30;
            else if (taxableIncome > 20833) withholdingTax = 1875 + (taxableIncome - 20833) * 0.25;
            else if (taxableIncome > 20833) withholdingTax = (taxableIncome - 20833) * 0.15;
            withholdingTax = withholdingTax / 2; // Semi-monthly

            // Employee loans/advances
            const loans = await dbQuery(req.prisma,`
                SELECT loan_type, monthly_deduction FROM employee_loans
                WHERE employee_id = $1 AND status = 'active'
            `, [emp.id]);

            let sssLoan = 0, pagibigLoan = 0, cashAdvance = 0;
            for (const loan of loans.rows) {
                const ded = parseFloat(loan.monthly_deduction) / 2;
                if (loan.loan_type === 'sss_loan') sssLoan = ded;
                else if (loan.loan_type === 'pagibig_loan') pagibigLoan = ded;
                else if (loan.loan_type === 'cash_advance' || loan.loan_type === 'company_loan') cashAdvance += ded;
            }

            const totalDeductions = sssEE + phEE + piEE + withholdingTax + sssLoan + pagibigLoan + cashAdvance;
            const netPay = grossPay - totalDeductions;

            const item = await dbQuery(req.prisma,`
                INSERT INTO payroll_items (
                    payroll_period_id, employee_id, days_worked, hours_worked, overtime_hours,
                    basic_pay, overtime_pay, gross_pay,
                    sss_ee, sss_er, philhealth_ee, philhealth_er, pagibig_ee, pagibig_er,
                    withholding_tax, sss_loan, pagibig_loan, cash_advance,
                    total_deductions, net_pay
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                ON CONFLICT (payroll_period_id, employee_id)
                DO UPDATE SET days_worked = EXCLUDED.days_worked, hours_worked = EXCLUDED.hours_worked,
                    overtime_hours = EXCLUDED.overtime_hours, basic_pay = EXCLUDED.basic_pay,
                    overtime_pay = EXCLUDED.overtime_pay, gross_pay = EXCLUDED.gross_pay,
                    sss_ee = EXCLUDED.sss_ee, sss_er = EXCLUDED.sss_er,
                    philhealth_ee = EXCLUDED.philhealth_ee, philhealth_er = EXCLUDED.philhealth_er,
                    pagibig_ee = EXCLUDED.pagibig_ee, pagibig_er = EXCLUDED.pagibig_er,
                    withholding_tax = EXCLUDED.withholding_tax, sss_loan = EXCLUDED.sss_loan,
                    pagibig_loan = EXCLUDED.pagibig_loan, cash_advance = EXCLUDED.cash_advance,
                    total_deductions = EXCLUDED.total_deductions, net_pay = EXCLUDED.net_pay
                RETURNING *
            `, [periodId, emp.id, daysWorked, parseFloat(att.total_hours), overtimeHrs,
                basicPay.toFixed(2), overtimePay.toFixed(2), grossPay.toFixed(2),
                sssEE.toFixed(2), sssER.toFixed(2), phEE.toFixed(2), phER.toFixed(2),
                piEE.toFixed(2), piER.toFixed(2), withholdingTax.toFixed(2),
                sssLoan.toFixed(2), pagibigLoan.toFixed(2), cashAdvance.toFixed(2),
                totalDeductions.toFixed(2), netPay.toFixed(2)]);

            results.push(item.rows[0]);
        }

        // Update period totals
        await dbQuery(req.prisma,`
            UPDATE payroll_periods SET 
                total_gross = (SELECT COALESCE(SUM(gross_pay), 0) FROM payroll_items WHERE payroll_period_id = $1),
                total_deductions = (SELECT COALESCE(SUM(total_deductions), 0) FROM payroll_items WHERE payroll_period_id = $1),
                total_net = (SELECT COALESCE(SUM(net_pay), 0) FROM payroll_items WHERE payroll_period_id = $1),
                status = 'processing', updated_at = NOW()
            WHERE id = $1
        `, [periodId]);

        res.json({ success: true, data: results, count: results.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Approve payroll
router.put('/payroll/periods/:id/approve', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,`
            UPDATE payroll_periods SET status = 'approved', approved_by = $2, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' RETURNING *
        `, [parseInt(req.params.id), req.body.approved_by || 'admin']);

        if (result.rows.length === 0) return res.status(400).json({ success: false, error: 'Cannot approve. Period must be in processing status.' });

        await dbQuery(req.prisma,`UPDATE payroll_items SET status = 'approved' WHERE payroll_period_id = $1`, [parseInt(req.params.id)]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Mark payroll as paid
router.put('/payroll/periods/:id/pay', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,`
            UPDATE payroll_periods SET status = 'paid', updated_at = NOW()
            WHERE id = $1 AND status = 'approved' RETURNING *
        `, [parseInt(req.params.id)]);

        if (result.rows.length === 0) return res.status(400).json({ success: false, error: 'Cannot pay. Period must be approved.' });

        await dbQuery(req.prisma,`UPDATE payroll_items SET status = 'paid' WHERE payroll_period_id = $1`, [parseInt(req.params.id)]);

        // Update loan balances
        const items = await dbQuery(req.prisma,'SELECT * FROM payroll_items WHERE payroll_period_id = $1', [parseInt(req.params.id)]);
        for (const item of items.rows) {
            if (parseFloat(item.sss_loan) > 0) {
                await dbQuery(req.prisma,`UPDATE employee_loans SET total_paid = total_paid + $1 WHERE employee_id = $2 AND loan_type = 'sss_loan' AND status = 'active'`, [item.sss_loan, item.employee_id]);
            }
            if (parseFloat(item.pagibig_loan) > 0) {
                await dbQuery(req.prisma,`UPDATE employee_loans SET total_paid = total_paid + $1 WHERE employee_id = $2 AND loan_type = 'pagibig_loan' AND status = 'active'`, [item.pagibig_loan, item.employee_id]);
            }
            if (parseFloat(item.cash_advance) > 0) {
                await dbQuery(req.prisma,`UPDATE employee_loans SET total_paid = total_paid + $1 WHERE employee_id = $2 AND loan_type IN ('cash_advance','company_loan') AND status = 'active'`, [item.cash_advance, item.employee_id]);
            }
        }

        // Auto-close fully paid loans
        await dbQuery(req.prisma,`UPDATE employee_loans SET status = 'fully_paid' WHERE total_paid >= principal_amount AND status = 'active'`);

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// EMPLOYEE LOANS
// ============================================================
router.get('/loans', adminAuth(), async (req, res) => {
    try {
        const { employee_id, status } = req.query;
        let query = `
            SELECT el.*, e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name
            FROM employee_loans el
            JOIN employees e ON el.employee_id = e.id WHERE 1=1
        `;
        const params = [];
        if (employee_id) { params.push(employee_id); query += ` AND el.employee_id = $${params.length}`; }
        if (status) { params.push(status); query += ` AND el.status = $${params.length}`; }
        query += ' ORDER BY el.created_at DESC';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/loans', adminAuth(), async (req, res) => {
    try {
        const { employee_id, loan_type, principal_amount, monthly_deduction, start_date, notes } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO employee_loans (employee_id, loan_type, principal_amount, monthly_deduction, start_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [employee_id, loan_type, principal_amount, monthly_deduction, start_date, notes]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// VENDORS
// ============================================================
router.get('/vendors', adminAuth(), async (req, res) => {
    try {
        const { status, search } = req.query;
        let query = 'SELECT *, name as vendor_name, contact as contact_person, terms as payment_terms FROM vendors WHERE 1=1';
        const params = [];
        if (status) { params.push(status === "active"); query += ` AND is_active = $${params.length}`; }
        if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR vendor_code ILIKE $${params.length})`; }
        query += ' ORDER BY name';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/vendors', adminAuth(), async (req, res) => {
    try {
        const { vendor_name, contact_person, email, phone, address, city, municipality, province, postal_code, tin_number, payment_terms, category, bank_name, bank_account_number, notes } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO vendors (name, contact, email, phone, address, city, municipality, province, postal_code, tin_number, terms, category, bank_name, bank_account_number, notes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *, name as vendor_name, contact as contact_person, terms as payment_terms
        `, [vendor_name, contact_person, email, phone, address, city||null, municipality||null, province||null, postal_code||null, tin_number, payment_terms || 30, category, bank_name, bank_account_number, notes]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/vendors/:id', adminAuth(), async (req, res) => {
    try {
        const fields = req.body;
        const fieldMap = { vendor_name:'name', contact_person:'contact', payment_terms:'terms' };
        const setClauses = [];
        const values = [];
        let idx = 1;
        const allowed = ['name','contact','email','phone','address','city','municipality','province','postal_code','tin_number','terms','category','bank_name','bank_account_number','is_active','notes'];
        for (const [key, val] of Object.entries(fields)) {
            const dbKey = fieldMap[key] || key;
            if (allowed.includes(dbKey)) { setClauses.push(`${dbKey} = $${idx}`); values.push(val); idx++; }
        }
        if (setClauses.length === 0) return res.status(400).json({ success: false, error: 'No valid fields' });
        setClauses.push('updated_at = NOW()');
        values.push(parseInt(req.params.id));
        const result = await dbQuery(req.prisma,`UPDATE vendors SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *, name as vendor_name, contact as contact_person, terms as payment_terms`, values);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/accounting/vendors/:id (superadmin only)
router.delete('/vendors/:id', adminAuth(), async (req, res) => {
    try {
        if (req.admin.role !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'Only superadmin can delete vendors' });
        }
        const id = parseInt(req.params.id);
        const vendor = await dbQuery(req.prisma, 'SELECT id, name FROM vendors WHERE id = $1', [id]);
        if (vendor.rows.length === 0) return res.status(404).json({ success: false, error: 'Vendor not found' });
        await dbQuery(req.prisma, 'DELETE FROM vendors WHERE id = $1', [id]);
        await auditLog(req.prisma, 'vendors', id, 'delete', vendor.rows[0], null, req.admin.id, req.ip);
        res.json({ success: true, message: 'Vendor deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ACCOUNTS RECEIVABLE
// ============================================================
router.get('/receivables', adminAuth(), async (req, res) => {
    try {
        const { status, search, date_from, date_to } = req.query;
        let query = 'SELECT ar.*, COALESCE(s.credit_balance, 0) AS subscriber_credit, s.account_number AS subscriber_account FROM accounts_receivable ar LEFT JOIN subscribers s ON s.id = ar.subscriber_id WHERE 1=1';
        const params = [];
        if (status) { params.push(status); query += ` AND ar.status = $${params.length}`; }
        if (search) { params.push(`%${search}%`); query += ` AND (customer_name ILIKE $${params.length} OR invoice_number ILIKE $${params.length})`; }
        if (date_from) { params.push(date_from); query += ` AND invoice_date >= $${params.length}::date`; }
        if (date_to) { params.push(date_to); query += ` AND invoice_date <= $${params.length}::date`; }
        query += ' ORDER BY invoice_date DESC';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/receivables/:id', adminAuth(), async (req, res) => {
    try {
        const ar = await dbQuery(req.prisma,'SELECT ar.*, COALESCE(s.credit_balance, 0) AS subscriber_credit, s.account_number AS subscriber_account FROM accounts_receivable ar LEFT JOIN subscribers s ON s.id = ar.subscriber_id WHERE ar.id = $1', [parseInt(req.params.id)]);
        if (ar.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });
        const payments = await dbQuery(req.prisma,'SELECT * FROM ar_payments WHERE ar_id = $1 ORDER BY payment_date', [parseInt(req.params.id)]);
        // Get credit history if subscriber linked
        let creditHistory = [];
        if (ar.rows[0].subscriber_id) {
            const credits = await dbQuery(req.prisma,'SELECT sc.*, i.invoice_number AS applied_to_invoice FROM subscriber_credits sc LEFT JOIN invoices i ON i.id = sc.applied_invoice_id WHERE sc.subscriber_id = $1 ORDER BY sc.created_at DESC LIMIT 20', [ar.rows[0].subscriber_id]);
            creditHistory = credits.rows;
        }
        res.json({ success: true, data: { invoice: ar.rows[0], payments: payments.rows, creditHistory } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/receivables', adminAuth(), async (req, res) => {
    try {
        const { customer_name, customer_address, subscriber_id, invoice_date, due_date, subtotal, tax_amount, total_amount, category, description, notes, created_by } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO accounts_receivable (customer_name, customer_address, subscriber_id, invoice_date, due_date, subtotal, tax_amount, total_amount, category, description, notes, created_by)
            VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12) RETURNING *
        `, [customer_name, customer_address, subscriber_id, invoice_date || new Date(), due_date, subtotal || 0, tax_amount || 0, total_amount, category || 'subscription', description, notes, created_by]);
        const ar = result.rows[0];
        await auditLog(req.prisma, 'accounts_receivable', ar.id, 'create', null, ar, created_by, req.ip);

        // If linked to a subscriber, also create a CRM invoice so it appears on their account
        if (subscriber_id) {
            try {
                const subscriber = await req.prisma.subscribers.findUnique({ where: { id: parseInt(subscriber_id) } });
                if (subscriber) {
                    const yy = String(new Date().getFullYear()).slice(-2);
                    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
                    const prefix = `INV-${yy}${mm}`;
                    const maxInv = await req.prisma.$queryRaw`
                        SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 8) AS INTEGER)), 0) + 1 AS next_num
                        FROM invoices WHERE invoice_number ~ ${'^INV-[0-9]+$'}
                    `;
                    const crmInvNumber = `${prefix}${String(maxInv[0].next_num).padStart(5, '0')}`;
                    const invAmount = parseFloat(total_amount) || parseFloat(subtotal) || 0;
                    await req.prisma.invoices.create({
                        data: {
                            subscriber_id: parseInt(subscriber_id),
                            invoice_number: crmInvNumber,
                            amount: invAmount,
                            billing_period: category || 'other',
                            due_date: new Date(due_date),
                            status: 'pending',
                            notes: [`AR Ref: ${ar.invoice_number}`, description].filter(Boolean).join('\n') || null,
                        }
                    });
                    await req.prisma.subscribers.update({
                        where: { id: parseInt(subscriber_id) },
                        data: { balance: { increment: invAmount } }
                    });
                }
            } catch (crmErr) {
                console.error('[AR] Failed to sync CRM invoice:', crmErr.message);
                // Non-fatal — AR record already created
            }
        }

        res.json({ success: true, data: ar });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Record AR Payment
router.post('/receivables/:id/pay', adminAuth(), async (req, res) => {
    try {
        const { amount, payment_method, reference_number, payment_date, notes, received_by } = req.body;

        const receipt = await recordArPayment(req.prisma, {
            arId: parseInt(req.params.id),
            amount,
            method: payment_method || 'cash',
            referenceNumber: reference_number,
            notes,
            receivedBy: received_by,
            paymentDate: payment_date || null,
        });
        const result = await dbQuery(req.prisma, 'SELECT * FROM ar_payments WHERE id = $1', [receipt.id]);

        // Fetch updated invoice
        const updated = await dbQuery(req.prisma,'SELECT * FROM accounts_receivable WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true, data: { payment: result.rows[0], invoice: updated.rows[0] } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// AR Aging report
router.get('/receivables/reports/aging', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,'SELECT * FROM vw_ar_aging ORDER BY due_date');
        const summary = await dbQuery(req.prisma,`
            SELECT aging_bracket, COUNT(*) AS count, SUM(balance) AS total
            FROM vw_ar_aging GROUP BY aging_bracket
            ORDER BY CASE aging_bracket 
                WHEN 'Current' THEN 1 WHEN '1-30 Days' THEN 2 
                WHEN '31-60 Days' THEN 3 WHEN '61-90 Days' THEN 4 ELSE 5 END
        `);
        res.json({ success: true, data: { details: result.rows, summary: summary.rows } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ACCOUNTS PAYABLE
// ============================================================
router.get('/payables', adminAuth(), async (req, res) => {
    try {
        const { status, vendor_id, search, date_from, date_to } = req.query;
        let query = 'SELECT * FROM accounts_payable WHERE 1=1';
        const params = [];
        if (status) { params.push(status); query += ` AND status = $${params.length}`; }
        if (vendor_id) { params.push(vendor_id); query += ` AND vendor_id = $${params.length}`; }
        if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR bill_number ILIKE $${params.length})`; }
        if (date_from) { params.push(date_from); query += ` AND bill_date >= $${params.length}::date`; }
        if (date_to) { params.push(date_to); query += ` AND bill_date <= $${params.length}::date`; }
        query += ' ORDER BY bill_date DESC';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── PO-sourced Payables: list approved POs with partial/complete delivery ──
router.get('/payables/from-po', adminAuth(), async (req, res) => {
    try {
        const pos = await req.prisma.purchase_orders.findMany({
            where: { status: { in: ['partial', 'received'] } },
            orderBy: { created_at: 'desc' },
            include: {
                vendor: { select: { id: true, name: true } },
                items: {
                    include: { product: { select: { name: true, sku: true, unit: true } } },
                    orderBy: { id: 'asc' }
                }
            }
        });
        const existingBills = await dbQuery(req.prisma, 'SELECT po_id, id, bill_number, status FROM accounts_payable WHERE po_id IS NOT NULL');
        const billMap = {};
        existingBills.rows.forEach(b => { billMap[b.po_id] = b; });

        const data = pos.map(po => ({
            id: po.id,
            po_number: po.po_number,
            status: po.status,
            vendor_id: po.vendor_id,
            vendor_name: po.vendor?.name || '',
            order_date: po.order_date,
            expected_date: po.expected_date,
            received_date: po.received_date,
            subtotal: Number(po.subtotal),
            tax_amount: Number(po.tax_amount),
            total_amount: Number(po.total_amount),
            shipping_fee: Number(po.shipping_fee || 0),
            handling_fee: Number(po.handling_fee || 0),
            discount: Number(po.discount || 0),
            items: po.items.map(it => ({
                id: it.id,
                product_name: it.product?.name || '',
                sku: it.product?.sku || '',
                unit: it.product?.unit || 'pcs',
                quantity: it.quantity,
                received_qty: it.received_qty,
                unit_price: Number(it.unit_price),
                line_total: it.quantity * Number(it.unit_price)
            })),
            existing_bill: billMap[po.id] || null
        }));
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Create bill from PO ──
router.post('/payables/from-po', adminAuth(), async (req, res) => {
    try {
        const { po_id, due_date, notes, created_by } = req.body;
        if (!po_id) return res.status(400).json({ success: false, error: 'PO ID required' });

        const existing = await dbQuery(req.prisma, 'SELECT id, bill_number FROM accounts_payable WHERE po_id = $1', [po_id]);
        if (existing.rows.length > 0) return res.status(400).json({ success: false, error: `Bill ${existing.rows[0].bill_number} already exists for this PO` });

        const po = await req.prisma.purchase_orders.findUnique({
            where: { id: parseInt(po_id) },
            include: { vendor: { select: { id: true, name: true, terms: true } } }
        });
        if (!po) return res.status(404).json({ success: false, error: 'PO not found' });
        if (!['partial', 'received'].includes(po.status)) return res.status(400).json({ success: false, error: 'PO must have partial or complete delivery' });

        const billDate = new Date();
        let dueDate = due_date ? new Date(due_date) : null;
        if (!dueDate) {
            const terms = po.vendor?.terms || 30;
            dueDate = new Date(billDate);
            dueDate.setDate(dueDate.getDate() + terms);
        }

        const result = await dbQuery(req.prisma, `
            INSERT INTO accounts_payable (vendor_id, vendor_name, bill_date, due_date, subtotal, tax_amount, total_amount, category, description, notes, created_by, po_id)
            VALUES ($1::int, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12::int) RETURNING *
        `, [
            po.vendor_id, po.vendor?.name || '', billDate, dueDate,
            Number(po.subtotal), Number(po.tax_amount), Number(po.total_amount),
            'equipment', `Bill from ${po.po_number}`, notes || null,
            created_by || 'admin', po.id
        ]);

        await auditLog(req.prisma, 'accounts_payable', result.rows[0].id, 'create', null, result.rows[0], created_by || 'admin', req.ip);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// AP Aging report
router.get('/payables/reports/aging', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,'SELECT * FROM vw_ap_aging ORDER BY due_date');
        const summary = await dbQuery(req.prisma,`
            SELECT aging_bracket, COUNT(*) AS count, SUM(balance) AS total
            FROM vw_ap_aging GROUP BY aging_bracket
            ORDER BY CASE aging_bracket
                WHEN 'Current' THEN 1 WHEN '1-30 Days' THEN 2
                WHEN '31-60 Days' THEN 3 WHEN '61-90 Days' THEN 4 ELSE 5 END
        `);
        res.json({ success: true, data: { details: result.rows, summary: summary.rows } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/payables/:id', adminAuth(), async (req, res) => {
    try {
        const ap = await dbQuery(req.prisma,'SELECT * FROM accounts_payable WHERE id = $1', [parseInt(req.params.id)]);
        if (ap.rows.length === 0) return res.status(404).json({ success: false, error: 'Bill not found' });
        const payments = await dbQuery(req.prisma,'SELECT * FROM ap_payments WHERE ap_id = $1 ORDER BY payment_date', [parseInt(req.params.id)]);
        // If linked to a PO, include PO line items
        let poItems = [];
        let poNumber = null;
        const bill = ap.rows[0];
        if (bill.po_id) {
            const po = await req.prisma.purchase_orders.findUnique({
                where: { id: bill.po_id },
                include: { items: { include: { product: { select: { name: true, sku: true, unit: true } } }, orderBy: { id: 'asc' } } }
            });
            if (po) {
                poNumber = po.po_number;
                poItems = po.items.map(it => ({
                    product_name: it.product?.name || '',
                    sku: it.product?.sku || '',
                    unit: it.product?.unit || 'pcs',
                    quantity: it.quantity,
                    received_qty: it.received_qty,
                    unit_price: Number(it.unit_price),
                    line_total: it.quantity * Number(it.unit_price)
                }));
            }
        }
        res.json({ success: true, data: { bill, payments: payments.rows, po_number: poNumber, po_items: poItems } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/payables', adminAuth(), async (req, res) => {
    try {
        const { vendor_id, vendor_name, bill_date, due_date, subtotal, tax_amount, total_amount, category, description, notes, created_by } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO accounts_payable (vendor_id, vendor_name, bill_date, due_date, subtotal, tax_amount, total_amount, category, description, notes, created_by)
            VALUES ($1::int,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [vendor_id, vendor_name, bill_date || new Date(), due_date, subtotal || 0, tax_amount || 0, total_amount, category, description, notes, created_by]);
        await auditLog(req.prisma, 'accounts_payable', result.rows[0].id, 'create', null, result.rows[0], created_by, req.ip);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Record AP Payment
router.post('/payables/:id/pay', adminAuth(), async (req, res) => {
    try {
        const { amount, payment_method, reference_number, check_number, payment_date, notes, paid_by } = req.body;
        const receipt = await recordApPayment(req.prisma, {
            apId: parseInt(req.params.id),
            amount,
            method: payment_method || 'bank_transfer',
            referenceNumber: reference_number,
            checkNumber: check_number,
            notes,
            paidBy: paid_by,
            paymentDate: payment_date || null,
        });
        const result = await dbQuery(req.prisma, 'SELECT * FROM ap_payments WHERE id = $1', [receipt.id]);

        const updated = await dbQuery(req.prisma,'SELECT * FROM accounts_payable WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ success: true, data: { payment: result.rows[0], bill: updated.rows[0] } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// CHART OF ACCOUNTS
// ============================================================
router.get('/accounts', adminAuth(), async (req, res) => {
    try {
        const { type, active } = req.query;
        let query = 'SELECT * FROM chart_of_accounts WHERE 1=1';
        const params = [];
        if (type) { params.push(type); query += ` AND account_type = $${params.length}`; }
        if (active !== undefined) { params.push(active === 'true'); query += ` AND is_active = $${params.length}`; }
        query += ' ORDER BY account_code';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/accounts', adminAuth(), async (req, res) => {
    try {
        const { account_code, account_name, account_type, parent_id, description } = req.body;
        const result = await dbQuery(req.prisma,`
            INSERT INTO chart_of_accounts (account_code, account_name, account_type, parent_id, description)
            VALUES ($1, $2, $3, $4, $5) RETURNING *
        `, [account_code, account_name, account_type, parent_id, description]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// JOURNAL ENTRIES
// ============================================================
router.get('/journal', adminAuth(), async (req, res) => {
    try {
        const { status, date_from, date_to, source } = req.query;
        let query = 'SELECT * FROM journal_entries WHERE 1=1';
        const params = [];
        if (status) { params.push(status); query += ` AND status = $${params.length}`; }
        if (date_from) { params.push(date_from); query += ` AND entry_date >= $${params.length}`; }
        if (date_to) { params.push(date_to); query += ` AND entry_date <= $${params.length}`; }
        if (source) { params.push(source); query += ` AND source = $${params.length}`; }
        query += ' ORDER BY entry_date DESC, id DESC';
        const result = await dbQuery(req.prisma,query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/journal/:id', adminAuth(), async (req, res) => {
    try {
        const entry = await dbQuery(req.prisma,'SELECT * FROM journal_entries WHERE id = $1', [parseInt(req.params.id)]);
        if (entry.rows.length === 0) return res.status(404).json({ success: false, error: 'Entry not found' });
        const lines = await dbQuery(req.prisma,`
            SELECT jel.*, coa.account_code, coa.account_name
            FROM journal_entry_lines jel
            JOIN chart_of_accounts coa ON jel.account_id = coa.id
            WHERE jel.journal_entry_id = $1
            ORDER BY jel.id
        `, [parseInt(req.params.id)]);
        res.json({ success: true, data: { entry: entry.rows[0], lines: lines.rows } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/journal', adminAuth(), async (req, res) => {
    try {
        const { entry_date, description, reference, source, lines, created_by, prepared_by, reviewed_by, approved_by } = req.body;
        // Validate debits = credits
        const totalDebit = lines.reduce((sum, l) => sum + parseFloat(l.debit || 0), 0);
        const totalCredit = lines.reduce((sum, l) => sum + parseFloat(l.credit || 0), 0);
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            return res.status(400).json({ success: false, error: `Debits (${totalDebit.toFixed(2)}) must equal Credits (${totalCredit.toFixed(2)})` });
        }

        const entry = await dbQuery(req.prisma,`
            INSERT INTO journal_entries (entry_date, description, reference, source, total_debit, total_credit, created_by, prepared_by, reviewed_by, approved_by)
            VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
        `, [entry_date || new Date(), description, reference, source || 'manual', totalDebit, totalCredit, created_by, prepared_by || created_by || null, reviewed_by || null, approved_by || null]);

        for (const line of lines) {
            await dbQuery(req.prisma,`
                INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, ref_no, vendor, address, tin, category)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [entry.rows[0].id, line.account_id, line.debit || 0, line.credit || 0, line.description || null, line.ref_no || null, line.vendor || null, line.address || null, line.tin || null, line.category || null]);
        }

        res.json({ success: true, data: entry.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Post journal entry
router.put('/journal/:id/post', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,`
            UPDATE journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW()
            WHERE id = $1 AND status = 'draft' RETURNING *
        `, [parseInt(req.params.id), req.body.posted_by || 'admin']);
        if (result.rows.length === 0) return res.status(400).json({ success: false, error: 'Entry must be in draft status to post' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Void journal entry
router.put('/journal/:id/void', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,`
            UPDATE journal_entries SET status = 'void' WHERE id = $1 RETURNING *
        `, [parseInt(req.params.id)]);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// REPORTS
// ============================================================

// Trial Balance
router.get('/reports/trial-balance', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,'SELECT * FROM vw_trial_balance');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Income Statement
router.get('/reports/income-statement', adminAuth(), async (req, res) => {
    try {
        const { date_from, date_to } = req.query;
        let dateFilter = '';
        const params = [];
        if (date_from && date_to) {
            params.push(date_from, date_to);
            dateFilter = 'AND je.entry_date BETWEEN $1 AND $2';
        }

        const result = await dbQuery(req.prisma,`
            SELECT 
                coa.account_code, coa.account_name, coa.account_type,
                COALESCE(SUM(jel.debit), 0) AS total_debit,
                COALESCE(SUM(jel.credit), 0) AS total_credit,
                CASE 
                    WHEN coa.account_type = 'revenue' THEN COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0)
                    ELSE COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)
                END AS net_amount
            FROM chart_of_accounts coa
            LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
            LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.status = 'posted' ${dateFilter}
            WHERE coa.account_type IN ('revenue', 'expense') AND coa.is_active = TRUE
            GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type
            HAVING COALESCE(SUM(jel.debit), 0) > 0 OR COALESCE(SUM(jel.credit), 0) > 0
            ORDER BY coa.account_code
        `, params);

        const revenue = result.rows.filter(r => r.account_type === 'revenue');
        const expenses = result.rows.filter(r => r.account_type === 'expense');
        const totalRevenue = revenue.reduce((sum, r) => sum + parseFloat(r.net_amount), 0);
        const totalExpenses = expenses.reduce((sum, r) => sum + parseFloat(r.net_amount), 0);

        res.json({
            success: true,
            data: { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Balance Sheet
router.get('/reports/balance-sheet', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma,`
            SELECT 
                coa.account_code, coa.account_name, coa.account_type,
                CASE 
                    WHEN coa.account_type IN ('asset','expense') THEN COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)
                    ELSE COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0)
                END AS balance
            FROM chart_of_accounts coa
            LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
            LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.status = 'posted'
            WHERE coa.account_type IN ('asset', 'liability', 'equity') AND coa.is_active = TRUE
            GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type
            ORDER BY coa.account_code
        `);

        const assets = result.rows.filter(r => r.account_type === 'asset');
        const liabilities = result.rows.filter(r => r.account_type === 'liability');
        const equity = result.rows.filter(r => r.account_type === 'equity');

        res.json({
            success: true,
            data: {
                assets, liabilities, equity,
                totalAssets: assets.reduce((s, r) => s + parseFloat(r.balance), 0),
                totalLiabilities: liabilities.reduce((s, r) => s + parseFloat(r.balance), 0),
                totalEquity: equity.reduce((s, r) => s + parseFloat(r.balance), 0)
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Mark overdue (can be called via cron or manually)
router.post('/run-overdue-check', adminAuth(), async (req, res) => {
    try {
        await dbQuery(req.prisma,'SELECT mark_overdue_invoices()');
        res.json({ success: true, message: 'Overdue check completed' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ============================================================
// SUBSCRIBER CREDITS (from Accounting)
// ============================================================

// GET /api/accounting/credits/summary — All subscribers with credit
router.get('/credits/summary', adminAuth(), async (req, res) => {
    try {
        const result = await dbQuery(req.prisma, `
            SELECT s.id, s.account_number, s.first_name, s.last_name, s.email,
                   COALESCE(s.credit_balance, 0) AS credit_balance,
                   (SELECT COUNT(*) FROM subscriber_credits WHERE subscriber_id = s.id) AS credit_entries
            FROM subscribers s
            WHERE COALESCE(s.credit_balance, 0) > 0
            ORDER BY s.credit_balance DESC
        `);
        res.json({ success: true, data: result.rows.map(r => ({ ...r, credit_balance: parseFloat(r.credit_balance), name: (r.first_name + ' ' + r.last_name).trim() })) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/accounting/credits/:subscriberId — Credit history
router.get('/credits/:subscriberId', adminAuth(), async (req, res) => {
    try {
        const sid = parseInt(req.params.subscriberId);
        const sub = await dbQuery(req.prisma, 'SELECT id, account_number, first_name, last_name, COALESCE(credit_balance, 0) AS credit_balance FROM subscribers WHERE id = $1', [sid]);
        if (sub.rows.length === 0) return res.status(404).json({ success: false, error: 'Subscriber not found' });
        const credits = await dbQuery(req.prisma, `
            SELECT sc.*, p.reference_number AS payment_ref, p.method AS payment_method, i.invoice_number AS applied_to_invoice
            FROM subscriber_credits sc
            LEFT JOIN payments p ON p.id = sc.source_payment_id
            LEFT JOIN invoices i ON i.id = sc.applied_invoice_id
            WHERE sc.subscriber_id = $1 ORDER BY sc.created_at DESC
        `, [sid]);
        const s = sub.rows[0];
        res.json({ success: true, data: { subscriberId: s.id, accountNumber: s.account_number, name: (s.first_name + ' ' + s.last_name).trim(), creditBalance: parseFloat(s.credit_balance), history: credits.rows } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/accounting/credits/apply-to-ar — Apply subscriber credit to an AR entry
router.post('/credits/apply-to-ar', adminAuth(), async (req, res) => {
    try {
        const { arId, amount } = req.body;
        if (!arId) return res.status(400).json({ success: false, error: 'arId required' });

        // Get AR entry
        const arRes = await dbQuery(req.prisma, 'SELECT * FROM accounts_receivable WHERE id = $1', [parseInt(arId)]);
        if (arRes.rows.length === 0) return res.status(404).json({ success: false, error: 'AR entry not found' });
        const ar = arRes.rows[0];

        if (!ar.subscriber_id) return res.status(400).json({ success: false, error: 'AR entry has no linked subscriber' });
        if (ar.status === 'paid') return res.status(400).json({ success: false, error: 'AR entry already paid' });

        // Get subscriber credit
        const subRes = await dbQuery(req.prisma, 'SELECT id, COALESCE(credit_balance, 0) AS credit_balance FROM subscribers WHERE id = $1', [ar.subscriber_id]);
        const currentCredit = parseFloat(subRes.rows[0].credit_balance);
        if (currentCredit <= 0) return res.status(400).json({ success: false, error: 'No credit available for this subscriber' });

        const arBalance = parseFloat(ar.balance);
        let creditToApply = amount ? Math.min(parseFloat(amount), currentCredit, arBalance) : Math.min(currentCredit, arBalance);
        if (creditToApply <= 0) return res.status(400).json({ success: false, error: 'Invalid credit amount' });

        // 1. Record AR payment
        await recordArPayment(req.prisma, {
            arId: parseInt(arId),
            amount: creditToApply,
            method: 'credit',
            referenceNumber: 'CREDIT-' + ar.invoice_number,
            notes: 'Credit applied from subscriber balance',
            receivedBy: 'accounting',
        });

        // 2. If AR has linked billing invoice, also record in payments table and update invoice
        if (ar.billing_invoice_id) {
            const inv = await dbQuery(req.prisma, 'SELECT * FROM invoices WHERE id = $1', [ar.billing_invoice_id]);
            if (inv.rows.length > 0) {
                const invoice = inv.rows[0];
                // Get total paid on this invoice
                const paidRes = await dbQuery(req.prisma, 'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = $1 AND status = $2', [invoice.id, 'success']);
                const prevPaid = parseFloat(paidRes.rows[0].total);
                const totalAfter = prevPaid + creditToApply;
                const newInvStatus = totalAfter >= parseFloat(invoice.amount) ? 'paid' : 'partial';

                // Record payment
                await dbQuery(req.prisma, `
                    INSERT INTO payments (invoice_id, subscriber_id, amount, method, reference_number, status, paid_at)
                    VALUES ($1, $2, $3, 'credit', $4, 'success', NOW())
                `, [invoice.id, ar.subscriber_id, creditToApply, 'CREDIT-' + invoice.invoice_number]);

                // Update invoice status
                await dbQuery(req.prisma, 'UPDATE invoices SET status = $1 WHERE id = $2', [newInvStatus, invoice.id]);

                // Decrease subscriber balance (outstanding)
                await dbQuery(req.prisma, 'UPDATE subscribers SET balance = balance - $1 WHERE id = $2', [creditToApply, ar.subscriber_id]);
            }
        }

        // 3. Deduct from subscriber credit_balance — atomic, returns authoritative post-update balance
        const credUpd = await dbQuery(req.prisma, 'UPDATE subscribers SET credit_balance = ROUND(GREATEST(COALESCE(credit_balance, 0) - $1::numeric, 0), 2) WHERE id = $2 RETURNING credit_balance', [creditToApply, ar.subscriber_id]);
        const newCreditBal = Number(credUpd.rows[0].credit_balance);

        // 4. Record in subscriber_credits ledger
        const invId = ar.billing_invoice_id || null;
        await dbQuery(req.prisma, `
            INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, applied_invoice_id, notes, created_by)
            VALUES ($1, 'applied', $2, $3, $4, $5, 'accounting')
        `, [ar.subscriber_id, -creditToApply, newCreditBal, invId, 'Applied to AR ' + ar.invoice_number + ' from accounting']);

        // 5. Fetch updated AR
        const updated = await dbQuery(req.prisma, 'SELECT * FROM accounts_receivable WHERE id = $1', [parseInt(arId)]);

        res.json({
            success: true,
            message: 'Credit of ₱' + creditToApply.toLocaleString() + ' applied to ' + ar.invoice_number,
            data: {
                creditApplied: creditToApply,
                previousCredit: currentCredit,
                newCreditBalance: newCreditBal,
                arStatus: updated.rows[0].status,
                arBalance: parseFloat(updated.rows[0].balance)
            }
        });
    } catch (err) {
        console.error('Credit apply to AR error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/accounting/credits/adjust — Manual credit adjustment from accounting
router.post('/credits/adjust', adminAuth(), async (req, res) => {
    try {
        const { subscriberId, amount, notes } = req.body;
        if (!subscriberId || !amount || amount === 0) return res.status(400).json({ success: false, error: 'subscriberId and non-zero amount required' });

        const subRes = await dbQuery(req.prisma, 'SELECT id, COALESCE(credit_balance, 0) AS credit_balance FROM subscribers WHERE id = $1', [parseInt(subscriberId)]);
        if (subRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Subscriber not found' });

        const currentCredit = parseFloat(subRes.rows[0].credit_balance);
        const adjustAmount = parseFloat(amount);
        if (adjustAmount < 0 && Math.abs(adjustAmount) > currentCredit) {
            return res.status(400).json({ success: false, error: 'Cannot deduct more than available credit (' + currentCredit + ')' });
        }

        const type = adjustAmount > 0 ? 'manual_add' : 'manual_deduct';

        // Atomic adjust (never below zero); returns authoritative post-update balance
        const adjUpd = await dbQuery(req.prisma, 'UPDATE subscribers SET credit_balance = ROUND(GREATEST(COALESCE(credit_balance, 0) + $1::numeric, 0), 2) WHERE id = $2 RETURNING credit_balance', [adjustAmount, parseInt(subscriberId)]);
        const newBalance = Number(adjUpd.rows[0].credit_balance);
        await dbQuery(req.prisma, `
            INSERT INTO subscriber_credits (subscriber_id, type, amount, running_balance, notes, created_by)
            VALUES ($1, $2, $3, $4, $5, 'accounting')
        `, [parseInt(subscriberId), type, adjustAmount, newBalance, notes || (type === 'manual_add' ? 'Manual credit added from accounting' : 'Manual credit deducted from accounting')]);

        res.json({ success: true, message: 'Credit adjusted', data: { previousBalance: currentCredit, adjustment: adjustAmount, newBalance } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
