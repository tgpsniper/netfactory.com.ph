/**
 * Netfactory - Database Seed Script
 * Creates sample subscribers with portal login credentials
 *
 * Run: node src/utils/seed.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function seed() {
  console.log('🌱 Seeding sample data...\n');

  // Check if barangays exist, if not create some
  const brgyCount = await prisma.barangays.count();
  if (brgyCount === 0) {
    console.log('Creating barangays...');
    const munis = await prisma.municipalities.findMany();
    const balanga = munis.find(m => m.name === 'Balanga City');
    const pilar = munis.find(m => m.name === 'Pilar');

    if (balanga) {
      const balangaBrgys = ['Poblacion', 'Cataning', 'Tenejero', 'Cupang Proper', 'Ibayo', 'Talisay', 'Tuyo', 'Bagumbayan', 'Sibacan', 'Tortugas'];
      for (const name of balangaBrgys) {
        await prisma.barangays.create({ data: { municipality_id: balanga.id, name } });
      }
    }
    if (pilar) {
      const pilarBrgys = ['Poblacion', 'Bagumbayan', 'Ala-uli', 'Balut', 'Liyang', 'Pantingan', 'Wawa'];
      for (const name of pilarBrgys) {
        await prisma.barangays.create({ data: { municipality_id: pilar.id, name } });
      }
    }
    console.log('✅ Barangays created\n');
  }

  // Get lookup data
  const municipalities = await prisma.municipalities.findMany({ include: { barangays: true } });
  const plans = await prisma.plans.findMany({ orderBy: { sort_order: 'asc' } });
  const balanga = municipalities.find(m => m.name === 'Balanga City');
  const pilar = municipalities.find(m => m.name === 'Pilar');

  // Sample subscribers
  const sampleSubscribers = [
    { fn: 'Juan', ln: 'Dela Cruz', email: 'juan@email.com', phone: '0917-111-2222', addr: '123 Rizal St', brgy: 'Poblacion', muni: balanga, plan: 3, status: 'active', lat: 14.6766, lng: 120.5362 },
    { fn: 'Maria', ln: 'Santos', email: 'maria@email.com', phone: '0918-222-3333', addr: '456 Mabini St', brgy: 'Cataning', muni: balanga, plan: 4, status: 'active', lat: 14.6810, lng: 120.5420 },
    { fn: 'Pedro', ln: 'Reyes', email: 'pedro@email.com', phone: '0919-333-4444', addr: '789 Bonifacio Ave', brgy: 'Tenejero', muni: balanga, plan: 2, status: 'suspended', lat: 14.6690, lng: 120.5480 },
    { fn: 'Ana', ln: 'Garcia', email: 'ana@email.com', phone: '0920-444-5555', addr: '321 Luna St', brgy: 'Bagumbayan', muni: pilar, plan: 5, status: 'active', lat: 14.6590, lng: 120.5650 },
    { fn: 'Jose', ln: 'Lopez', email: 'jose@email.com', phone: '0921-555-6666', addr: '654 Aguinaldo Rd', brgy: 'Cupang Proper', muni: balanga, plan: 1, status: 'pending', lat: 14.6720, lng: 120.5310 },
    { fn: 'Carmen', ln: 'Mendoza', email: 'carmen@email.com', phone: '0922-666-7777', addr: '987 Quezon Blvd', brgy: 'Poblacion', muni: pilar, plan: 6, status: 'active', lat: 14.6555, lng: 120.5580 },
    { fn: 'Roberto', ln: 'Villanueva', email: 'roberto@email.com', phone: '0923-777-8888', addr: '147 Magsaysay Dr', brgy: 'Ibayo', muni: balanga, plan: 3, status: 'active', lat: 14.6850, lng: 120.5290 },
    { fn: 'Elena', ln: 'Ramos', email: 'elena@email.com', phone: '0924-888-9999', addr: '258 Roxas St', brgy: 'Talisay', muni: balanga, plan: 2, status: 'disconnected', lat: 14.6745, lng: 120.5510 },
  ];

  console.log('Creating subscribers...');
  const defaultPasswordHash = await bcrypt.hash('demo123', 12);

  for (const s of sampleSubscribers) {
    // Check if already exists
    const existing = await prisma.subscribers.findUnique({ where: { email: s.email } });
    if (existing) {
      console.log(`  ⏭ ${s.fn} ${s.ln} already exists`);
      continue;
    }

    const brgy = s.muni?.barangays.find(b => b.name === s.brgy);
    const plan = plans[s.plan - 1];

    const sub = await prisma.subscribers.create({
      data: {
        account_number: '',
        first_name: s.fn,
        last_name: s.ln,
        email: s.email,
        phone: s.phone,
        address: s.addr,
        barangay_id: brgy?.id || null,
        municipality_id: s.muni?.id || null,
        plan_id: plan?.id || null,
        status: s.status,
        latitude: s.lat,
        longitude: s.lng,
        installed_at: s.status !== 'pending' ? new Date('2025-06-15') : null,
        next_bill_date: new Date('2026-03-15'),
        balance: s.status === 'suspended' ? 2598 : s.status === 'disconnected' ? 3897 : 0
      }
    });

    // Refetch for auto-generated account number
    const created = await prisma.subscribers.findUnique({ where: { id: sub.id } });

    // Create portal auth (password: demo123)
    if (s.status !== 'pending') {
      await prisma.subscriber_auth.create({
        data: { subscriber_id: created.id, password_hash: defaultPasswordHash }
      });
    }

    console.log(`  ✅ ${created.account_number} - ${s.fn} ${s.ln} (${s.status})`);
  }

  // Create sample invoices
  console.log('\nCreating sample invoices...');
  const allSubs = await prisma.subscribers.findMany({
    where: { status: { in: ['active', 'suspended'] } },
    include: { plan: true }
  });

  let invSeq = await prisma.invoices.count();
  const months = ['February 2026', 'January 2026'];
  const dueDates = ['2026-02-15', '2026-01-15'];

  for (const sub of allSubs) {
    if (!sub.plan) continue;
    for (let m = 0; m < months.length; m++) {
      const existingInv = await prisma.invoices.findFirst({
        where: { subscriber_id: sub.id, billing_period: months[m] }
      });
      if (existingInv) continue;

      invSeq++;
      const invNumber = `INV-2026-${String(invSeq).padStart(4, '0')}`;
      const isPaid = m === 1 || (m === 0 && sub.status === 'active' && Math.random() > 0.4);

      await prisma.invoices.create({
        data: {
          subscriber_id: sub.id,
          invoice_number: invNumber,
          amount: sub.plan.price,
          billing_period: months[m],
          due_date: new Date(dueDates[m]),
          status: isPaid ? 'paid' : sub.status === 'suspended' ? 'overdue' : 'pending'
        }
      });
    }
  }
  console.log('✅ Invoices created');

  // Create sample payments for paid invoices
  console.log('\nCreating sample payments...');
  const paidInvoices = await prisma.invoices.findMany({
    where: { status: 'paid' },
    include: { subscriber: true }
  });

  const methods = ['GCash', 'Maya', 'Bank Transfer', '7-Eleven', 'Xendit'];
  for (const inv of paidInvoices) {
    const existingPayment = await prisma.payments.findFirst({ where: { invoice_id: inv.id } });
    if (existingPayment) continue;

    await prisma.payments.create({
      data: {
        invoice_id: inv.id,
        subscriber_id: inv.subscriber_id,
        amount: inv.amount,
        method: methods[Math.floor(Math.random() * methods.length)],
        reference_number: `REF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'success',
        paid_at: new Date(new Date(inv.due_date).getTime() - Math.random() * 5 * 86400000)
      }
    });
  }
  console.log('✅ Payments created');

  // Create sample tickets
  console.log('\nCreating sample tickets...');
  const ticketData = [
    { subEmail: 'juan@email.com', cat: 'connectivity', pri: 'high', stat: 'open', subj: 'Intermittent connection since morning', desc: 'Internet keeps dropping every 15-30 minutes since 7 AM.' },
    { subEmail: 'pedro@email.com', cat: 'billing', pri: 'medium', stat: 'in_progress', subj: 'Request to waive late fee', desc: 'Requesting waiver of late payment fee due to hospitalization.' },
    { subEmail: 'jose@email.com', cat: 'installation', pri: 'low', stat: 'open', subj: 'Schedule site survey', desc: 'New subscriber application - needs site survey for fiber drop.' },
    { subEmail: 'maria@email.com', cat: 'connectivity', pri: 'critical', stat: 'open', subj: 'Total loss of connection - no light on ONT', desc: 'ONT has no light. Already tried restarting. No internet since last night.' },
    { subEmail: 'roberto@email.com', cat: 'general', pri: 'low', stat: 'resolved', subj: 'Request to upgrade plan', desc: 'Want to upgrade from STANDARD to PREMIUM.' },
    { subEmail: 'ana@email.com', cat: 'connectivity', pri: 'medium', stat: 'resolved', subj: 'Slow speed during peak hours', desc: 'Speeds drop to around 50 Mbps during evenings (7-10 PM).' },
  ];

  let tkSeq = await prisma.tickets.count();
  for (const tk of ticketData) {
    const sub = await prisma.subscribers.findUnique({ where: { email: tk.subEmail } });
    if (!sub) continue;

    const existingTk = await prisma.tickets.findFirst({
      where: { subscriber_id: sub.id, subject: tk.subj }
    });
    if (existingTk) continue;

    tkSeq++;
    const ticket = await prisma.tickets.create({
      data: {
        subscriber_id: sub.id,
        ticket_number: `TK-2026-${String(tkSeq).padStart(4, '0')}`,
        category: tk.cat,
        priority: tk.pri,
        status: tk.stat,
        subject: tk.subj,
        description: tk.desc,
        resolved_at: tk.stat === 'resolved' ? new Date() : null
      }
    });

    await prisma.ticket_updates.create({
      data: { ticket_id: ticket.id, message: 'Ticket created', created_by: 'System' }
    });

    if (tk.stat !== 'open') {
      await prisma.ticket_updates.create({
        data: { ticket_id: ticket.id, message: tk.stat === 'resolved' ? 'Issue resolved' : 'Under review', created_by: 'Support' }
      });
    }
  }
  console.log('✅ Tickets created');

  // Create sample usage data (30 days for active subscribers)
  console.log('\nCreating usage data (30 days)...');
  const activeSubs = await prisma.subscribers.findMany({
    where: { status: 'active' },
    include: { plan: true }
  });

  for (const sub of activeSubs) {
    const existingUsage = await prisma.usage_data.count({ where: { subscriber_id: sub.id } });
    if (existingUsage > 0) continue;

    const speedFactor = sub.plan ? sub.plan.speed_mbps / 200 : 1;
    for (let d = 29; d >= 0; d--) {
      const date = new Date();
      date.setDate(date.getDate() - d);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const base = isWeekend ? 8 : 5;

      await prisma.usage_data.create({
        data: {
          subscriber_id: sub.id,
          usage_date: date,
          download_gb: Math.round((base + Math.random() * 6) * speedFactor * 100) / 100,
          upload_gb: Math.round((1 + Math.random() * 3) * speedFactor * 100) / 100,
          peak_download_mbps: Math.round(sub.plan ? sub.plan.speed_mbps * (0.7 + Math.random() * 0.3) : 50),
          peak_upload_mbps: Math.round(sub.plan ? sub.plan.speed_mbps * (0.5 + Math.random() * 0.3) : 25),
          session_count: Math.floor(3 + Math.random() * 8)
        }
      });
    }
    console.log(`  ✅ ${sub.account_number} - 30 days of usage`);
  }

  console.log('\n========================================');
  console.log('🎉 Seed complete!');
  console.log('========================================');
  console.log('\nPortal login credentials (all passwords: demo123):');
  const seededSubs = await prisma.subscribers.findMany({
    where: { auth: { isNot: null } },
    select: { account_number: true, first_name: true, last_name: true, status: true }
  });
  seededSubs.forEach(s => {
    console.log(`  ${s.account_number} - ${s.first_name} ${s.last_name} (${s.status})`);
  });
  console.log('\nCRM admin login:');
  console.log('  Username: admin');
  console.log('  Password: changeme123');
}

seed()
  .catch(err => { console.error('Seed error:', err); })
  .finally(() => prisma.$disconnect());
