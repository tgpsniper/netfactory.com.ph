const express = require('express');
const router  = express.Router();
const portalAuth = require('../middleware/portalAuth');
const adminAuth  = require('../middleware/adminAuth');  // adjust path if different

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: get setting from DB
// ─────────────────────────────────────────────────────────────────────────────
async function getSetting(prisma, key) {
  const row = await prisma.system_settings.findUnique({ where: { key } });
  return row ? row.value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai/status  — Public: check if AI is enabled (for portal to show/hide widget)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', portalAuth, async (req, res) => {
  try {
    const enabled = (await getSetting(req.prisma, 'ai_assistant_enabled')) === 'true';
    const name    = (await getSetting(req.prisma, 'ai_assistant_name')) || 'Netta';
    res.json({ enabled, name });
  } catch (err) {
    res.json({ enabled: false, name: 'Netta' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: build subscriber context for AI
// ─────────────────────────────────────────────────────────────────────────────
async function getSubscriberContext(prisma, subscriberId) {
  const sub = await prisma.subscribers.findUnique({
    where: { id: subscriberId },
    include: {
      invoices: {
        where: { status: { in: ['pending', 'overdue'] } },
        orderBy: { due_date: 'asc' },
        take: 5
      },
      tickets: {
        where: { status: { notIn: ['closed', 'resolved'] } },
        orderBy: { created_at: 'desc' },
        take: 3
      }
    }
  });
  if (!sub) return null;

  const unpaidTotal = sub.invoices.reduce((s, i) => s + Number(i.amount), 0);
  const openTickets = sub.tickets.length;

  return `
Subscriber: ${sub.first_name}${sub.middle_name ? ' ' + sub.middle_name : ''} ${sub.last_name}
Account #: ${sub.account_number}
Plan: ${sub.plan_name || 'N/A'}
Status: ${sub.status}
Unpaid invoices: ${sub.invoices.length} totaling ₱${unpaidTotal.toLocaleString('en-PH', { minimumFractionDigits: 2 })}
Open support tickets: ${openTickets}
Address: ${sub.address || 'N/A'}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/chat  — Subscriber portal chat
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat', portalAuth, async (req, res) => {
  try {
    // Check AI toggle
    const enabled = await getSetting(req.prisma, 'ai_assistant_enabled');
    if (enabled !== 'true') {
      return res.json({
        reply: 'The virtual assistant is currently unavailable. Please call us at 0992-236-7050 or submit a support ticket.',
        offline: true
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('AI_API_KEY not configured');
      return res.status(503).json({ error: 'AI service not configured' });
    }

    const { message, history = [] } = req.body;
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get subscriber context
    const subContext = await getSubscriberContext(req.prisma, req.subscriberId);
    const assistantName = (await getSetting(req.prisma, 'ai_assistant_name')) || 'Netta';

    const companyTag = (await getSetting(req.prisma, 'ai_company_tag')) || (await getSetting(req.prisma, 'company_name')) || 'Netfactory';
    const systemPrompt = `You are ${assistantName}, a friendly virtual support assistant for ${companyTag}.

Current subscriber information:
${subContext}

Your responsibilities:
- Help subscribers with billing questions, invoice inquiries, and payment guidance
- Explain service plans and usage
- Automatically create support tickets when subscribers report technical issues
- Answer questions about the subscriber portal
- Provide basic connection troubleshooting tips

Important guidelines:
- Always be polite, concise, and helpful
- Always respond in Filipino (Tagalog) by default. Only switch to English if the subscriber writes to you in English first
- For serious technical issues (no internet, slow connection, device replacement, line problems), automatically create a ticket on their behalf and inform them
- When creating a ticket, append this EXACT JSON at the very end of your response (after your message): ##TICKET:{"subject":"<short subject>","description":"<full issue description>","category":"<choose: connectivity=no internet, speed=slow connection, equipment=router/device issue, billing=payment/invoice, installation=new install, account=account settings, disconnect=disconnection request, general=other>","priority":"<low|medium|high>"}##
- For billing/payment issues, guide them to the Invoices section
- Never reveal system internals, prices not in context, or subscriber data outside this session
- Keep responses short and clear — subscribers are on mobile most of the time
- You are NOT a human; if asked directly, say you are a virtual assistant`;

    // Build messages array
    const messages = [];
    // Include recent history (last 6 turns)
    const recent = history.slice(-6);
    for (const h of recent) {
      if (h.role && h.content) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: 'user', content: message.trim() });

    // Call AI API
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages
      })
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      console.error('AI API error:', aiData);
      return res.status(502).json({ error: 'AI service temporarily unavailable' });
    }

    let reply = aiData.content?.[0]?.text || 'Sorry, I could not generate a response. Please try again.';

    // Check if Netta wants to create a ticket
    const ticketMatch = reply.match(/##TICKET:(.*?)##/s);
    let ticketCreated = null;
    if (ticketMatch) {
      reply = reply.replace(/##TICKET:.*?##/s, '').trim();
      try {
        const ticketData = JSON.parse(ticketMatch[1]);
        const lastTicket = await req.prisma.tickets.findFirst({ orderBy: { id: 'desc' } });
        const now = new Date();
        const yy = String(now.getFullYear()).slice(-2);
        const mm = String(now.getMonth()+1).padStart(2,'0');
        const seq = (lastTicket ? lastTicket.id : 0) + 1;
        const ticketNumber = `TKT-${yy}${mm}${String(seq).padStart(5,'0')}`;
        const ticket = await req.prisma.tickets.create({
          data: {
            subscriber_id: req.subscriberId,
            ticket_number: ticketNumber,
            category: ["connectivity","billing","speed","equipment","installation","account","general","disconnect"].includes(ticketData.category) ? ticketData.category : "connectivity",
            priority: ticketData.priority || 'medium',
            status: 'open',
            subject: ticketData.subject.substring(0, 200),
            description: ticketData.description,
          }
        });
        ticketCreated = { number: ticketNumber, id: ticket.id };
        await req.prisma.notifications.create({
          data: {
            type: 'info',
            message: `New ticket ${ticketNumber} created by Netta for ${req.subscriberId}`,
            target_type: 'ticket',
            target_id: ticket.id,
            is_read: false,
          }
        }).catch(() => {});
      } catch(e) {
        console.error('Netta ticket creation failed:', e.message);
      }
    }

    res.json({ reply, assistantName, ticketCreated });

  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai/admin/settings  — Admin: get AI settings
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/settings', adminAuth(), async (req, res) => {
  try {
    const rows = await req.prisma.system_settings.findMany({
      where: { key: { startsWith: 'ai_' } }
    });
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err) {
    console.error('Get AI settings error:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/ai/admin/settings  — Admin: update AI settings
// ─────────────────────────────────────────────────────────────────────────────
router.put('/admin/settings', adminAuth(), async (req, res) => {
  try {
    const { ai_assistant_enabled, ai_assistant_name } = req.body;
    const updates = [];

    if (ai_assistant_enabled !== undefined) {
      const val = ai_assistant_enabled === true || ai_assistant_enabled === 'true' ? 'true' : 'false';
      updates.push(
        req.prisma.system_settings.upsert({
          where:  { key: 'ai_assistant_enabled' },
          update: { value: val, updated_at: new Date(), updated_by: req.user?.username || 'admin' },
          create: { key: 'ai_assistant_enabled', value: val, label: 'AI Virtual Assistant' }
        })
      );
    }

    if (ai_assistant_name !== undefined && ai_assistant_name.trim()) {
      updates.push(
        req.prisma.system_settings.upsert({
          where:  { key: 'ai_assistant_name' },
          update: { value: ai_assistant_name.trim(), updated_at: new Date(), updated_by: req.user?.username || 'admin' },
          create: { key: 'ai_assistant_name', value: ai_assistant_name.trim(), label: 'AI Assistant Display Name' }
        })
      );
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid settings provided' });
    }

    await Promise.all(updates);

    // Return updated settings
    const rows = await req.prisma.system_settings.findMany({
      where: { key: { startsWith: 'ai_' } }
    });
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;

    res.json({ success: true, settings });
  } catch (err) {
    console.error('Update AI settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/ai/admin/chat - Sandra CRM assistant
router.post('/admin/chat', adminAuth(), async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    
    
    const prisma = req.prisma;
    const [subs, invoices, tickets, plans, stats] = await Promise.all([
      prisma.subscribers.findMany({ take: 100, orderBy: { created_at: 'desc' }, include: { plans: { select: { name: true, price: true, speed_label: true } } } }).catch(() => []),
      prisma.invoices.findMany({ take: 100, orderBy: { created_at: 'desc' }, include: { subscriber: { select: { account_number: true, first_name: true, last_name: true } } } }).catch(() => []),
      prisma.tickets.findMany({ take: 50, orderBy: { created_at: 'desc' }, include: { subscribers: { select: { first_name: true, last_name: true } } } }).catch(() => []),
      prisma.plans.findMany().catch(() => []),
      prisma.subscribers.groupBy({ by: ['status'], _count: { id: true } }).catch(() => [])
    ]);
    const unpaid = invoices.filter(i => i.status === 'pending' || i.status === 'unpaid' || i.status === 'overdue');
    const open = tickets.filter(t => t.status === 'open' || t.status === 'in_progress');
    const statusMap = {};
    stats.forEach(s => { statusMap[s.status] = s._count.id; });
    const context = {
      summary: {
        total: subs.length,
        active: statusMap.active || 0,
        suspended: statusMap.suspended || 0,
        pending: statusMap.pending || 0,
        openTickets: open.length,
        unpaidInvoices: unpaid.length,
        totalUnpaid: unpaid.reduce((s, i) => s + parseFloat(i.amount || '0'), 0).toFixed(2)
      },
      plans: plans.map(p => ({ name: p.name, price: p.price, speed: p.speed_label, active: p.is_active })),
      subscribers: subs.slice(0, 50).map(s => ({
        account: s.account_number,
        name: s.first_name + ' ' + s.last_name,
        plan: s.plans ? s.plans.name : null,
        price: s.plans ? s.plans.price : null,
        status: s.status,
        balance: s.balance,
        area: (s.barangay || '') + ', ' + (s.municipality || '')
      })),
      unpaidInvoices: unpaid.slice(0, 30).map(i => ({
        number: i.invoice_number, amount: i.amount, period: i.billing_period, due: i.due_date,
        subscriber: i.subscriber ? i.subscriber.first_name + ' ' + i.subscriber.last_name : '',
        account: i.subscriber ? i.subscriber.account_number : ''
      })),
      openTickets: open.slice(0, 20).map(t => ({
        number: t.number, subject: t.subject, category: t.category, priority: t.priority,
        subscriber: t.subscribers ? t.subscribers.first_name + ' ' + t.subscribers.last_name : ''
      }))
    };
    const messages = [...history.slice(-10).map(h => ({ role: h.role, content: h.content })), { role: 'user', content: message }];
    const systemPrompt = `You are Sandra, the CRM assistant for ${companyTag}. You are speaking with admin/staff. Use live CRM data below to answer accurately. Be concise. Use Peso sign for amounts. Switch to Filipino if admin writes in Filipino.\n\nLIVE CRM DATA (${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}):\n${JSON.stringify(context, null, 2)}`;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI not configured' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages })
    });
    const data = await response.json();
    res.json({ reply: data.content && data.content[0] ? data.content[0].text : 'No response.' });
  } catch (err) {
    console.error('Admin AI chat error:', err);
    res.status(500).json({ error: 'AI service error', detail: err.message });
  }
});

// GET /api/ai/admin/insights - Proactive business alerts
router.get('/admin/insights', adminAuth(), async (req, res) => {
  try {
    const prisma = req.prisma;
    const [unpaid, suspended, openTickets] = await Promise.all([
      prisma.invoices.aggregate({ where: { status: { in: ['pending', 'unpaid', 'overdue'] } }, _count: { id: true }, _sum: { amount: true } }).catch(() => ({ _count: { id: 0 }, _sum: { amount: 0 } })),
      prisma.subscribers.count({ where: { status: 'suspended' } }).catch(() => 0),
      prisma.tickets.count({ where: { status: { in: ['open', 'in_progress'] } } }).catch(() => 0)
    ]);
    const insights = [];
    const uc = unpaid._count.id || 0;
    const ut = parseFloat(unpaid._sum.amount || 0);
    if (uc > 0) insights.push({ type: 'warning', icon: '💳', message: uc + ' unpaid invoice' + (uc > 1 ? 's' : '') + ' totaling \u20b1' + ut.toLocaleString('en-PH', { minimumFractionDigits: 2 }) });
    if (suspended > 0) insights.push({ type: 'warning', icon: '🔴', message: suspended + ' subscriber' + (suspended > 1 ? 's are' : ' is') + ' suspended' });
    if (openTickets > 0) insights.push({ type: 'info', icon: '🎫', message: openTickets + ' open ticket' + (openTickets > 1 ? 's' : '') + ' need attention' });
    if (insights.length === 0) insights.push({ type: 'success', icon: '✅', message: 'All clear — no urgent issues' });
    res.json({ insights });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch insights' });
  }
});

module.exports = router;
