// ═══════════════════════════════════════════════════════════════
// OSP (Outside Plant) Routes — Work Orders, Installation Tracking
// Mount: app.use('/api/admin/osp', require('./routes/osp'))
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const fs = require('fs');
const path = require('path');

// ── Helper: Generate work order number ──
async function generateWONumber(prisma) {
  const today = new Date();
  const prefix = 'WO' + String(today.getFullYear()).slice(-2) + String(today.getMonth() + 1).padStart(2, '0');
  const [result] = await prisma.$queryRaw`
    SELECT COUNT(*)::int as count FROM work_orders WHERE order_number LIKE ${prefix + '%'}
  `;
  const seq = (result.count || 0) + 1;
  return prefix + String(seq).padStart(4, '0');
}

// ── Default checklist templates ──
const CHECKLIST_TEMPLATES = {
  installation: [
    { group: 'pre_install', name: 'Verify subscriber address and access', order: 1 },
    { group: 'pre_install', name: 'Check fiber availability at location', order: 2 },
    { group: 'pre_install', name: 'Take before photo of installation site', order: 3 },
    { group: 'cabling', name: 'Run fiber cable from NAP to premises', order: 4 },
    { group: 'cabling', name: 'Install fiber rosette / wall plate', order: 5 },
    { group: 'cabling', name: 'Terminate fiber and splice', order: 6 },
    { group: 'equipment', name: 'Install ONT/ONU device', order: 7 },
    { group: 'equipment', name: 'Install WiFi router', order: 8 },
    { group: 'equipment', name: 'Record ONT serial number', order: 9 },
    { group: 'equipment', name: 'Record router serial / MAC address', order: 10 },
    { group: 'testing', name: 'Test optical power level (dBm)', order: 11 },
    { group: 'testing', name: 'Run speed test and verify plan speed', order: 12 },
    { group: 'testing', name: 'Test WiFi connectivity on customer device', order: 13 },
    { group: 'completion', name: 'Take after photo of installed equipment', order: 14 },
    { group: 'completion', name: 'Brief customer on router usage and support', order: 15 },
    { group: 'completion', name: 'Obtain customer signature', order: 16 },
  ],
  survey: [
    { group: 'site_check', name: 'Verify subscriber address', order: 1 },
    { group: 'site_check', name: 'Check line of sight and access route', order: 2 },
    { group: 'site_check', name: 'Identify nearest NAP/splitter', order: 3 },
    { group: 'site_check', name: 'Measure cable distance estimate', order: 4 },
    { group: 'site_check', name: 'Take site photos', order: 5 },
    { group: 'assessment', name: 'Assess installation feasibility', order: 6 },
    { group: 'assessment', name: 'Note any obstacles or special requirements', order: 7 },
  ],
  repair: [
    { group: 'diagnosis', name: 'Verify reported issue with customer', order: 1 },
    { group: 'diagnosis', name: 'Check ONT status and lights', order: 2 },
    { group: 'diagnosis', name: 'Test optical power level', order: 3 },
    { group: 'diagnosis', name: 'Check fiber cable for damage', order: 4 },
    { group: 'fix', name: 'Perform repair/replacement', order: 5 },
    { group: 'fix', name: 'Test connectivity after repair', order: 6 },
    { group: 'fix', name: 'Run speed test', order: 7 },
    { group: 'completion', name: 'Take photo of repaired equipment', order: 8 },
    { group: 'completion', name: 'Confirm with customer issue is resolved', order: 9 },
  ]
};

// ════════════════════════════════════════════════════════
// GET /api/admin/osp/work-orders — List work orders
// ════════════════════════════════════════════════════════
router.get('/work-orders', adminAuth(), async (req, res) => {
  try {
    const { status, type, assigned_to, from, to, limit = 50, offset = 0 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (status) {
      if (status.includes(',')) {
        const statuses = status.split(',');
        where += ` AND wo.status IN (${statuses.map(() => `$${paramIdx++}`).join(',')})`;
        params.push(...statuses);
      } else {
        where += ` AND wo.status = $${paramIdx++}`;
        params.push(status);
      }
    }
    if (type) { where += ` AND wo.type = $${paramIdx++}`; params.push(type); }
    if (assigned_to) { where += ` AND wo.assigned_to = $${paramIdx++}`; params.push(parseInt(assigned_to)); }
    if (from) { where += ` AND wo.scheduled_date >= $${paramIdx++}`; params.push(from); }
    if (to) { where += ` AND wo.scheduled_date <= $${paramIdx++}`; params.push(to); }

    params.push(parseInt(limit), parseInt(offset));

    const workOrders = await req.prisma.$queryRawUnsafe(`
      SELECT wo.*,
        s.first_name, s.middle_name, s.last_name, s.account_number, s.address, s.phone,
        s.barangay_name, s.municipality_name, s.status as sub_status,
        p.name as plan_name, p.speed_label,
        a.full_name as assigned_name, a.username as assigned_username,
        c.full_name as creator_name,
        (SELECT COUNT(*)::int FROM work_order_tasks wot WHERE wot.work_order_id = wo.id) as total_tasks,
        (SELECT COUNT(*)::int FROM work_order_tasks wot WHERE wot.work_order_id = wo.id AND wot.is_completed = true) as completed_tasks,
        (SELECT COUNT(*)::int FROM work_order_photos wop WHERE wop.work_order_id = wo.id) as photo_count
      FROM work_orders wo
      LEFT JOIN subscribers s ON wo.subscriber_id = s.id
      LEFT JOIN plans p ON s.plan_id = p.id
      LEFT JOIN admin_users a ON wo.assigned_to = a.id
      LEFT JOIN admin_users c ON wo.created_by = c.id
      ${where}
      ORDER BY
        CASE wo.status
          WHEN 'in_progress' THEN 1
          WHEN 'assigned' THEN 2
          WHEN 'scheduled' THEN 3
          WHEN 'pending' THEN 4
          WHEN 'completed' THEN 5
          WHEN 'cancelled' THEN 6
        END,
        wo.scheduled_date ASC NULLS LAST,
        wo.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `, ...params);

    const [countResult] = await req.prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int as total FROM work_orders wo ${where}
    `, ...params.slice(0, -2));

    res.json({ workOrders, total: countResult.total });
  } catch (err) {
    console.error('OSP list error:', err);
    res.status(500).json({ error: 'Failed to fetch work orders' });
  }
});

// ════════════════════════════════════════════════════════
// GET /api/admin/osp/work-orders/:id — Get single work order with all details
// ════════════════════════════════════════════════════════
router.get('/work-orders/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [wo] = await req.prisma.$queryRaw`
      SELECT wo.*,
        s.first_name, s.middle_name, s.last_name, s.account_number, s.address, s.phone, s.email,
        s.barangay_name, s.municipality_name, s.status as sub_status,
        s.latitude as sub_lat, s.longitude as sub_lng, s.ont_serial, s.router_serial, s.mac_address,
        p.name as plan_name, p.speed_label, p.speed_mbps,
        a.full_name as assigned_name, a.username as assigned_username, a.phone as assigned_phone,
        c.full_name as creator_name
      FROM work_orders wo
      LEFT JOIN subscribers s ON wo.subscriber_id = s.id
      LEFT JOIN plans p ON s.plan_id = p.id
      LEFT JOIN admin_users a ON wo.assigned_to = a.id
      LEFT JOIN admin_users c ON wo.created_by = c.id
      WHERE wo.id = ${id}
    `;
    if (!wo) return res.status(404).json({ error: 'Work order not found' });

    const tasks = await req.prisma.$queryRaw`
      SELECT * FROM work_order_tasks WHERE work_order_id = ${id} ORDER BY sort_order ASC, id ASC
    `;
    const photos = await req.prisma.$queryRaw`
      SELECT * FROM work_order_photos WHERE work_order_id = ${id} ORDER BY created_at ASC
    `;
    const materials = await req.prisma.$queryRaw`
      SELECT * FROM work_order_materials WHERE work_order_id = ${id} ORDER BY id ASC
    `;
    const logs = await req.prisma.$queryRaw`
      SELECT * FROM work_order_logs WHERE work_order_id = ${id} ORDER BY created_at DESC
    `;
    const [signature] = await req.prisma.$queryRaw`
      SELECT * FROM work_order_signatures WHERE work_order_id = ${id}
    `;

    res.json({ workOrder: wo, tasks, photos, materials, logs, signature: signature || null });
  } catch (err) {
    console.error('OSP detail error:', err);
    res.status(500).json({ error: 'Failed to fetch work order' });
  }
});

// ════════════════════════════════════════════════════════
// POST /api/admin/osp/work-orders — Create work order
// ════════════════════════════════════════════════════════
router.post('/work-orders', adminAuth(), async (req, res) => {
  try {
    const { subscriber_id, type = 'installation', priority = 'normal', assigned_to, scheduled_date, scheduled_time, notes } = req.body;
    if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id is required' });

    const orderNumber = await generateWONumber(req.prisma);
    const who = req.adminUser?.full_name || req.adminUser?.username || 'Admin';

    const schedDateVal = scheduled_date ? new Date(scheduled_date) : null;
    const [wo] = await req.prisma.$queryRaw`
      INSERT INTO work_orders (order_number, subscriber_id, type, status, priority, assigned_to, scheduled_date, scheduled_time, notes, created_by)
      VALUES (${orderNumber}, ${parseInt(subscriber_id)}, ${type}, ${assigned_to ? 'assigned' : 'pending'}, ${priority},
        ${assigned_to ? parseInt(assigned_to) : null}, ${schedDateVal}::date, ${scheduled_time || null}, ${notes || null}, ${req.adminId})
      RETURNING *
    `;

    // Create default checklist tasks
    const template = CHECKLIST_TEMPLATES[type] || CHECKLIST_TEMPLATES.installation;
    for (const t of template) {
      await req.prisma.$queryRaw`
        INSERT INTO work_order_tasks (work_order_id, task_name, task_group, sort_order)
        VALUES (${wo.id}, ${t.name}, ${t.group}, ${t.order})
      `;
    }

    // Log creation
    await req.prisma.$queryRaw`
      INSERT INTO work_order_logs (work_order_id, action, details, performed_by)
      VALUES (${wo.id}, 'created', ${`Work order ${orderNumber} created (${type})`}, ${who})
    `;

    // Audit log
    await req.prisma.audit_log.create({
      data: { user_type: 'admin', user_id: req.adminId, action: 'work_order_created', entity_type: 'work_orders', entity_id: wo.id, details: { orderNumber, type, subscriber_id }, ip_address: req.ip }
    });

    res.json({ message: 'Work order created', workOrder: wo });
  } catch (err) {
    console.error('OSP create error:', err);
    res.status(500).json({ error: 'Failed to create work order' });
  }
});

// ════════════════════════════════════════════════════════
// PUT /api/admin/osp/work-orders/:id — Update work order
// ════════════════════════════════════════════════════════
router.put('/work-orders/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, priority, assigned_to, scheduled_date, scheduled_time, notes } = req.body;
    const who = req.adminUser?.full_name || req.adminUser?.username || 'Admin';

    const [existing] = await req.prisma.$queryRaw`SELECT * FROM work_orders WHERE id = ${id}`;
    if (!existing) return res.status(404).json({ error: 'Work order not found' });

    const setClauses = [];
    const params = [];
    const logDetails = [];
    let paramIdx = 1;

    if (status && status !== existing.status) {
      setClauses.push(`status = $${paramIdx++}`); params.push(status);
      logDetails.push(`Status: ${existing.status} → ${status}`);
      if (status === 'in_progress' && !existing.started_at) setClauses.push(`started_at = NOW()`);
      if (status === 'completed') setClauses.push(`completed_at = NOW()`);
    }
    if (priority) { setClauses.push(`priority = $${paramIdx++}`); params.push(priority); }
    if (assigned_to !== undefined) {
      setClauses.push(`assigned_to = $${paramIdx++}`); params.push(assigned_to ? parseInt(assigned_to) : null);
      if (assigned_to && existing.status === 'pending') { setClauses.push(`status = 'assigned'`); }
      logDetails.push('Installer assigned');
    }
    if (scheduled_date !== undefined) {
      setClauses.push(`scheduled_date = $${paramIdx++}::date`); params.push(scheduled_date ? new Date(scheduled_date) : null);
      logDetails.push(`Scheduled: ${scheduled_date}`);
    }
    if (scheduled_time !== undefined) { setClauses.push(`scheduled_time = $${paramIdx++}`); params.push(scheduled_time || null); }
    if (notes !== undefined) { setClauses.push(`notes = $${paramIdx++}`); params.push(notes); }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    await req.prisma.$queryRawUnsafe(`UPDATE work_orders SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, ...params);

    if (logDetails.length > 0) {
      await req.prisma.$queryRaw`
        INSERT INTO work_order_logs (work_order_id, action, details, performed_by)
        VALUES (${id}, 'updated', ${logDetails.join('; ')}, ${who})
      `;
    }

    const [updated] = await req.prisma.$queryRaw`SELECT * FROM work_orders WHERE id = ${id}`;
    res.json({ message: 'Work order updated', workOrder: updated });
  } catch (err) {
    console.error('OSP update error:', err);
    res.status(500).json({ error: 'Failed to update work order' });
  }
});

// ════════════════════════════════════════════════════════
// PUT /api/admin/osp/work-orders/:id/tasks/:taskId — Toggle/update task
// ════════════════════════════════════════════════════════
router.put('/work-orders/:id/tasks/:taskId', adminAuth(), async (req, res) => {
  try {
    const woId = parseInt(req.params.id);
    const taskId = parseInt(req.params.taskId);
    const { is_completed, notes, photo } = req.body;
    const who = req.adminUser?.full_name || req.adminUser?.username || 'Admin';

    let photoPath = null;
    if (photo) {
      const dir = '/var/www/netfactory.com.ph/html/uploads/osp';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
      const ext = photo.startsWith('data:image/png') ? 'png' : 'jpg';
      const filename = `task_${woId}_${taskId}_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(dir, filename), base64Data, 'base64');
      photoPath = `/uploads/osp/${filename}`;
    }

    const setClauses = [];
    if (is_completed !== undefined) {
      setClauses.push(`is_completed = ${is_completed}`);
      if (is_completed) {
        setClauses.push(`completed_by = '${who}'`);
        setClauses.push(`completed_at = NOW()`);
      } else {
        setClauses.push(`completed_by = NULL`);
        setClauses.push(`completed_at = NULL`);
      }
    }
    if (notes !== undefined) setClauses.push(`notes = '${notes.replace(/'/g, "''")}'`);
    if (photoPath) setClauses.push(`photo_path = '${photoPath}'`);

    if (setClauses.length > 0) {
      await req.prisma.$queryRawUnsafe(`UPDATE work_order_tasks SET ${setClauses.join(', ')} WHERE id = ${taskId} AND work_order_id = ${woId}`);
    }

    const tasks = await req.prisma.$queryRaw`
      SELECT * FROM work_order_tasks WHERE work_order_id = ${woId} ORDER BY sort_order ASC, id ASC
    `;
    res.json({ message: 'Task updated', tasks });
  } catch (err) {
    console.error('OSP task update error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ════════════════════════════════════════════════════════
// POST /api/admin/osp/work-orders/:id/photos — Upload photo
// ════════════════════════════════════════════════════════
router.post('/work-orders/:id/photos', adminAuth(), async (req, res) => {
  try {
    const woId = parseInt(req.params.id);
    const { photo, photo_type = 'site', caption } = req.body;
    if (!photo) return res.status(400).json({ error: 'Photo required' });
    const who = req.adminUser?.full_name || req.adminUser?.username || 'Admin';

    const dir = '/var/www/netfactory.com.ph/html/uploads/osp';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
    const ext = photo.startsWith('data:image/png') ? 'png' : 'jpg';
    const filename = `wo_${woId}_${photo_type}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), base64Data, 'base64');
    const photoPath = `/uploads/osp/${filename}`;

    const [inserted] = await req.prisma.$queryRaw`
      INSERT INTO work_order_photos (work_order_id, photo_type, photo_path, caption, uploaded_by)
      VALUES (${woId}, ${photo_type}, ${photoPath}, ${caption || null}, ${who})
      RETURNING *
    `;

    res.json({ message: 'Photo uploaded', photo: inserted });
  } catch (err) {
    console.error('OSP photo error:', err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// ════════════════════════════════════════════════════════
// POST /api/admin/osp/work-orders/:id/materials — Add material
// ════════════════════════════════════════════════════════
router.post('/work-orders/:id/materials', adminAuth(), async (req, res) => {
  try {
    const woId = parseInt(req.params.id);
    const { item_name, quantity = 1, unit = 'pcs', notes } = req.body;
    if (!item_name) return res.status(400).json({ error: 'item_name required' });

    const [inserted] = await req.prisma.$queryRaw`
      INSERT INTO work_order_materials (work_order_id, item_name, quantity, unit, notes)
      VALUES (${woId}, ${item_name}, ${parseInt(quantity)}, ${unit}, ${notes || null})
      RETURNING *
    `;

    res.json({ message: 'Material added', material: inserted });
  } catch (err) {
    console.error('OSP material error:', err);
    res.status(500).json({ error: 'Failed to add material' });
  }
});

// ════════════════════════════════════════════════════════
// DELETE /api/admin/osp/work-orders/:id/materials/:materialId
// ════════════════════════════════════════════════════════
router.delete('/work-orders/:id/materials/:materialId', adminAuth(), async (req, res) => {
  try {
    await req.prisma.$queryRaw`
      DELETE FROM work_order_materials WHERE id = ${parseInt(req.params.materialId)} AND work_order_id = ${parseInt(req.params.id)}
    `;
    res.json({ message: 'Material removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove material' });
  }
});

// ════════════════════════════════════════════════════════
// POST /api/admin/osp/work-orders/:id/signature — Save customer signature
// ════════════════════════════════════════════════════════
router.post('/work-orders/:id/signature', adminAuth(), async (req, res) => {
  try {
    const woId = parseInt(req.params.id);
    const { signature_data, signed_by } = req.body;
    if (!signature_data) return res.status(400).json({ error: 'Signature data required' });

    // Upsert signature
    await req.prisma.$queryRaw`
      INSERT INTO work_order_signatures (work_order_id, signature_data, signed_by)
      VALUES (${woId}, ${signature_data}, ${signed_by || 'Customer'})
      ON CONFLICT (work_order_id) DO UPDATE SET signature_data = ${signature_data}, signed_by = ${signed_by || 'Customer'}, signed_at = NOW()
    `;

    res.json({ message: 'Signature saved' });
  } catch (err) {
    console.error('OSP signature error:', err);
    res.status(500).json({ error: 'Failed to save signature' });
  }
});

// ════════════════════════════════════════════════════════
// POST /api/admin/osp/work-orders/:id/complete — Complete work order + activate subscriber
// ════════════════════════════════════════════════════════
router.post('/work-orders/:id/complete', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { ont_serial, router_serial, mac_address, notes } = req.body;
    const who = req.adminUser?.full_name || req.adminUser?.username || 'Admin';

    const [wo] = await req.prisma.$queryRaw`SELECT * FROM work_orders WHERE id = ${id}`;
    if (!wo) return res.status(404).json({ error: 'Work order not found' });

    // Mark work order as completed
    await req.prisma.$queryRaw`
      UPDATE work_orders SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ${id}
    `;

    // Log
    await req.prisma.$queryRaw`
      INSERT INTO work_order_logs (work_order_id, action, details, performed_by)
      VALUES (${id}, 'completed', ${`Work order completed by ${who}${notes ? ' — ' + notes : ''}`}, ${who})
    `;

    // For installation type: update subscriber with equipment info
    if (wo.type === 'installation') {
      const subUpdate = { status: 'active', installed_at: new Date(), date_installed: new Date(), updated_at: new Date() };
      if (ont_serial) subUpdate.ont_serial = ont_serial;
      if (router_serial) subUpdate.router_serial = router_serial;
      if (mac_address) subUpdate.mac_address = mac_address;

      await req.prisma.subscribers.update({ where: { id: wo.subscriber_id }, data: subUpdate });

      await req.prisma.$queryRaw`
        INSERT INTO work_order_logs (work_order_id, action, details, performed_by)
        VALUES (${id}, 'subscriber_activated', ${`Subscriber activated — ONT: ${ont_serial || 'N/A'}, Router: ${router_serial || 'N/A'}`}, ${who})
      `;
    }

    res.json({ message: 'Work order completed' });
  } catch (err) {
    console.error('OSP complete error:', err);
    res.status(500).json({ error: 'Failed to complete work order' });
  }
});

// ════════════════════════════════════════════════════════
// GET /api/admin/osp/installers — List available installers
// ════════════════════════════════════════════════════════
router.get('/installers', adminAuth(), async (req, res) => {
  try {
    const installers = await req.prisma.admin_users.findMany({
      where: { is_active: true, role: { in: ['installer', 'osp_engineer', 'admin', 'superadmin'] } },
      select: { id: true, full_name: true, username: true, role: true, phone: true },
      orderBy: { full_name: 'asc' }
    });

    // Get active work order counts per installer
    const counts = await req.prisma.$queryRaw`
      SELECT assigned_to, COUNT(*)::int as active_count
      FROM work_orders
      WHERE status IN ('assigned', 'scheduled', 'in_progress') AND assigned_to IS NOT NULL
      GROUP BY assigned_to
    `;
    const countMap = {};
    counts.forEach(c => { countMap[c.assigned_to] = c.active_count; });

    const result = installers.map(i => ({ ...i, activeWorkOrders: countMap[i.id] || 0 }));
    res.json({ installers: result });
  } catch (err) {
    console.error('OSP installers error:', err);
    res.status(500).json({ error: 'Failed to fetch installers' });
  }
});

// ════════════════════════════════════════════════════════
// GET /api/admin/osp/stats — Dashboard stats
// ════════════════════════════════════════════════════════
router.get('/stats', adminAuth(), async (req, res) => {
  try {
    const [stats] = await req.prisma.$queryRaw`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
        COUNT(*) FILTER (WHERE status = 'assigned')::int as assigned,
        COUNT(*) FILTER (WHERE status = 'scheduled')::int as scheduled,
        COUNT(*) FILTER (WHERE status = 'in_progress')::int as in_progress,
        COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int as cancelled,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= CURRENT_DATE - INTERVAL '7 days')::int as completed_7d,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= CURRENT_DATE - INTERVAL '30 days')::int as completed_30d,
        COUNT(*) FILTER (WHERE type = 'installation')::int as installations,
        COUNT(*) FILTER (WHERE type = 'survey')::int as surveys,
        COUNT(*) FILTER (WHERE type = 'repair')::int as repairs
      FROM work_orders
    `;

    // Pending subscribers awaiting work orders
    const [pendingSubs] = await req.prisma.$queryRaw`
      SELECT COUNT(*)::int as count FROM subscribers
      WHERE status IN ('approved', 'pending')
      AND id NOT IN (SELECT subscriber_id FROM work_orders WHERE status NOT IN ('completed', 'cancelled'))
    `;

    res.json({ stats, pendingSubscribers: pendingSubs.count });
  } catch (err) {
    console.error('OSP stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ════════════════════════════════════════════════════════
// GET /api/admin/osp/schedule — Calendar view data
// ════════════════════════════════════════════════════════
router.get('/schedule', adminAuth(), async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const y = parseInt(year) || new Date().getFullYear();

    const events = await req.prisma.$queryRaw`
      SELECT wo.id, wo.order_number, wo.type, wo.status, wo.priority, wo.scheduled_date, wo.scheduled_time,
        s.first_name, s.last_name, s.account_number, s.address, s.barangay_name,
        a.full_name as assigned_name
      FROM work_orders wo
      LEFT JOIN subscribers s ON wo.subscriber_id = s.id
      LEFT JOIN admin_users a ON wo.assigned_to = a.id
      WHERE EXTRACT(MONTH FROM wo.scheduled_date) = ${m}
        AND EXTRACT(YEAR FROM wo.scheduled_date) = ${y}
        AND wo.status NOT IN ('cancelled')
      ORDER BY wo.scheduled_date ASC, wo.scheduled_time ASC
    `;

    res.json({ events, month: m, year: y });
  } catch (err) {
    console.error('OSP schedule error:', err);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

module.exports = router;
