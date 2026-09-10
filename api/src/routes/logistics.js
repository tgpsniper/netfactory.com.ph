const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');

// ============================================================
// LOGISTICS API ROUTES
// ============================================================

// ── DASHBOARD STATS ─────────────────────────────────────────
router.get('/dashboard', adminAuth(), async (req, res) => {
  try {
    const [
      totalProducts, activeProducts,
      totalStock, lowStock,
      totalPOs, pendingPOs,
      totalVendors, activeVendors,
      recentTxns, categoryStats, poStats
    ] = await Promise.all([
      req.prisma.products.count(),
      req.prisma.products.count({ where: { is_active: true } }),
      req.prisma.inventory_stock.aggregate({ _sum: { quantity: true } }),
      req.prisma.$queryRaw`SELECT COUNT(*) as cnt FROM inventory_stock s JOIN products p ON s.product_id=p.id WHERE s.quantity <= p.min_stock AND p.min_stock > 0`,
      req.prisma.purchase_orders.count(),
      req.prisma.purchase_orders.count({ where: { status: { in: ['draft','ordered','partial'] } } }),
      req.prisma.vendors.count(),
      req.prisma.vendors.count({ where: { is_active: true } }),
      req.prisma.inventory_transactions.findMany({ take: 10, orderBy: { created_at: 'desc' }, include: { product: { select: { name: true, sku: true } }, creator: { select: { full_name: true } } } }),
      req.prisma.$queryRaw`SELECT c.name, COUNT(p.id)::int as product_count, COALESCE(SUM(s.quantity),0)::int as total_stock FROM product_categories c LEFT JOIN products p ON p.category_id=c.id LEFT JOIN inventory_stock s ON s.product_id=p.id GROUP BY c.id, c.name ORDER BY c.sort_order`,
      req.prisma.$queryRaw`SELECT status, COUNT(*)::int as cnt, COALESCE(SUM(total_amount),0)::numeric as total FROM purchase_orders GROUP BY status`,
    ]);
    res.json({
      products: { total: totalProducts, active: activeProducts },
      stock: { total: totalStock._sum.quantity || 0, lowStock: Number(lowStock[0]?.cnt || 0) },
      purchaseOrders: { total: totalPOs, pending: pendingPOs, byStatus: poStats },
      vendors: { total: totalVendors, active: activeVendors },
      recentTransactions: recentTxns,
      categoryStats,
    });
  } catch (err) {
    console.error('Logistics dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── PRODUCT CATEGORIES ──────────────────────────────────────
router.get('/categories', adminAuth(), async (req, res) => {
  try {
    const cats = await req.prisma.product_categories.findMany({
      orderBy: { sort_order: 'asc' },
      include: { _count: { select: { products: true } } }
    });
    res.json({ categories: cats });
  } catch (err) { res.status(500).json({ error: 'Failed to load categories' }); }
});

router.post('/categories', adminAuth(), async (req, res) => {
  try {
    const { name, description, sortOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const cat = await req.prisma.product_categories.create({
      data: { name: name.toUpperCase(), description, sort_order: sortOrder || 0 }
    });
    res.status(201).json({ message: 'Category created', category: cat });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Category already exists' });
    res.status(500).json({ error: 'Failed to create category' });
  }
});

router.put('/categories/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, sortOrder, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.toUpperCase();
    if (description !== undefined) data.description = description;
    if (sortOrder !== undefined) data.sort_order = sortOrder;
    if (isActive !== undefined) data.is_active = isActive;
    const cat = await req.prisma.product_categories.update({ where: { id }, data });
    res.json({ message: 'Category updated', category: cat });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Category name already exists' });
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// ── PRODUCTS ────────────────────────────────────────────────
router.get('/products', adminAuth(), async (req, res) => {
  try {
    const { category, vendor, search, active } = req.query;
    const where = {};
    if (category) where.category_id = parseInt(category);
    if (vendor) where.vendor_id = parseInt(vendor);
    if (active === 'true') where.is_active = true;
    if (active === 'false') where.is_active = false;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    const products = await req.prisma.products.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        category: { select: { name: true } },
        vendor: { select: { name: true } },
        stock: { select: { quantity: true, location: true } },
        _count: { select: { onu_devices: true } },
      },
    });
    res.json({ products });
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

router.post('/products', adminAuth(), async (req, res) => {
  try {
    const { name, sku, categoryId, vendorId, description, unit, unitPrice, isSerialized, minStock } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name required' });
    const product = await req.prisma.products.create({
      data: {
        name: name.toUpperCase(),
        sku: sku ? sku.toUpperCase() : null,
        category_id: categoryId ? parseInt(categoryId) : null,
        vendor_id: vendorId ? parseInt(vendorId) : null,
        description: description ? description.toUpperCase() : null,
        unit: unit || 'pcs',
        unit_price: unitPrice ? parseFloat(unitPrice) : 0,
        is_serialized: isSerialized || false,
        min_stock: minStock ? parseInt(minStock) : 0,
      },
    });
    if (!isSerialized) {
      await req.prisma.inventory_stock.create({
        data: { product_id: product.id, quantity: 0 }
      });
    }
    res.status(201).json({ message: 'Product created', product });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'SKU already exists' });
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/products/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, sku, categoryId, vendorId, description, unit, unitPrice, isSerialized, minStock, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.toUpperCase();
    if (sku !== undefined) data.sku = sku ? sku.toUpperCase() : null;
    if (categoryId !== undefined) data.category_id = categoryId ? parseInt(categoryId) : null;
    if (vendorId !== undefined) data.vendor_id = vendorId ? parseInt(vendorId) : null;
    if (description !== undefined) data.description = description ? description.toUpperCase() : null;
    if (unit !== undefined) data.unit = unit;
    if (unitPrice !== undefined) data.unit_price = parseFloat(unitPrice);
    if (isSerialized !== undefined) data.is_serialized = isSerialized;
    if (minStock !== undefined) data.min_stock = parseInt(minStock);
    if (isActive !== undefined) data.is_active = isActive;
    data.updated_at = new Date();
    const product = await req.prisma.products.update({ where: { id }, data });
    res.json({ message: 'Product updated', product });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'SKU already exists' });
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.get('/products/:id', adminAuth(), async (req, res) => {
  try {
    const product = await req.prisma.products.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        category: true,
        vendor: true,
        stock: true,
        onu_devices: { take: 20, orderBy: { created_at: 'desc' }, include: { subscriber: { select: { first_name: true, last_name: true, account_number: true } } } },
        po_items: { take: 20, include: { purchase_order: { select: { po_number: true, status: true, order_date: true } } } },
      },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (err) { res.status(500).json({ error: 'Failed to load product' }); }
});

// ── VENDORS ─────────────────────────────────────────────────
router.get('/vendors', adminAuth(), async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const vendors = await req.prisma.vendors.findMany({
      where: includeInactive ? {} : { is_active: true },
      orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { products: true, onu_devices: true, purchase_orders: true } } },
    });
    res.json({ vendors });
  } catch (err) { res.status(500).json({ error: 'Failed to load vendors' }); }
});

router.post('/vendors', adminAuth(), async (req, res) => {
  try {
    const { name, contact, phone, phone2, phone3, email, address, municipality, city, province, postalCode, terms, website, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Vendor name required' });
    const vendor = await req.prisma.vendors.create({
      data: { name: name.toUpperCase(), contact: contact ? contact.toUpperCase() : null, phone, phone2, phone3, email: email ? email.toLowerCase() : null, address: address ? address.toUpperCase() : null, municipality: municipality ? municipality.toUpperCase() : null, city: city ? city.toUpperCase() : null, province: province ? province.toUpperCase() : null, postal_code: postalCode || null, terms, website: website ? website.toLowerCase() : null, notes: notes ? notes.toUpperCase() : null }
    });
    res.status(201).json({ message: 'Vendor created', vendor });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Vendor name already exists' });
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

router.put('/vendors/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, contact, phone, phone2, phone3, email, address, municipality, city, province, postalCode, terms, website, notes, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.toUpperCase();
    if (contact !== undefined) data.contact = contact ? contact.toUpperCase() : null;
    if (phone !== undefined) data.phone = phone;
    if (phone2 !== undefined) data.phone2 = phone2;
    if (phone3 !== undefined) data.phone3 = phone3;
    if (email !== undefined) data.email = email ? email.toLowerCase() : null;
    if (address !== undefined) data.address = address ? address.toUpperCase() : null;
    if (municipality !== undefined) data.municipality = municipality ? municipality.toUpperCase() : null;
    if (city !== undefined) data.city = city ? city.toUpperCase() : null;
    if (province !== undefined) data.province = province ? province.toUpperCase() : null;
    if (postalCode !== undefined) data.postal_code = postalCode || null;
    if (terms !== undefined) data.terms = terms;
    if (website !== undefined) data.website = website ? website.toLowerCase() : null;
    if (notes !== undefined) data.notes = notes ? notes.toUpperCase() : null;
    if (isActive !== undefined) data.is_active = isActive;
    const vendor = await req.prisma.vendors.update({ where: { id }, data });
    res.json({ message: 'Vendor updated', vendor });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Vendor name already exists' });
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

// ════════════════════════════════════════════════════════════
// PURCHASE ORDERS — UPGRADED
// ════════════════════════════════════════════════════════════

// ── LIST POs ────────────────────────────────────────────────
router.get('/purchase-orders', adminAuth(), async (req, res) => {
  try {
    const { status, vendor } = req.query;
    const where = {};
    if (status) where.status = status;
    if (vendor) where.vendor_id = parseInt(vendor);
    const pos = await req.prisma.purchase_orders.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        vendor: { select: { name: true } },
        creator: { select: { full_name: true } },
        _count: { select: { items: true } },
      },
    });
    res.json({ purchaseOrders: pos });
  } catch (err) { res.status(500).json({ error: 'Failed to load purchase orders' }); }
});

// ── GET SINGLE PO (full detail) ─────────────────────────────
router.get('/purchase-orders/:id', adminAuth(), async (req, res) => {
  try {
    const po = await req.prisma.purchase_orders.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        vendor: true,
        creator: { select: { full_name: true } },
        approver: { select: { full_name: true } },
        items: {
          include: { product: { select: { id: true, name: true, sku: true, unit: true, is_serialized: true } } },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: 'Failed to load purchase order' }); }
});

// ── CREATE PO (with shipping/handling/discount) ─────────────
router.post('/purchase-orders', adminAuth(), async (req, res) => {
  try {
    const { vendorId, orderDate, expectedDate, notes, items, shippingFee, handlingFee, discount } = req.body;
    if (!vendorId) return res.status(400).json({ error: 'Vendor required' });
    if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

    const seq = await req.prisma.$queryRaw`SELECT nextval('po_number_seq')::int as num`;
    const now = new Date();
    const poNum = 'PO-' + now.toISOString().slice(2, 4) + now.toISOString().slice(5, 7) + String(seq[0].num).padStart(4, '0');

    let subtotal = 0;
    items.forEach(i => { subtotal += (parseInt(i.quantity) || 1) * (parseFloat(i.unitPrice) || 0); });

    const ship = parseFloat(shippingFee) || 0;
    const handle = parseFloat(handlingFee) || 0;
    const disc = parseFloat(discount) || 0;
    const totalAmount = subtotal + ship + handle - disc;

    const po = await req.prisma.purchase_orders.create({
      data: {
        po_number: poNum,
        vendor_id: parseInt(vendorId),
        status: 'draft',
        order_date: orderDate ? new Date(orderDate) : now,
        expected_date: expectedDate ? new Date(expectedDate) : null,
        subtotal,
        shipping_fee: ship,
        handling_fee: handle,
        discount: disc,
        tax_amount: 0,
        total_amount: totalAmount,
        notes: notes ? notes.toUpperCase() : null,
        created_by: req.adminId,
        items: {
          create: items.map(i => ({
            product_id: parseInt(i.productId),
            quantity: parseInt(i.quantity) || 1,
            unit_price: parseFloat(i.unitPrice) || 0,
            notes: i.notes ? i.notes.toUpperCase() : null,
          })),
        },
      },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        vendor: { select: { name: true } },
      },
    });
    res.status(201).json({ message: 'Purchase order created', purchaseOrder: po });
  } catch (err) {
    console.error('Create PO error:', err);
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
});

// ── EDIT PO (header + items + fees) ─────────────────────────
// Only allowed for draft or ordered status
router.put('/purchase-orders/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const po = await req.prisma.purchase_orders.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['draft', 'ordered'].includes(po.status)) {
      return res.status(400).json({ error: 'Cannot edit a PO that is partially received, fully received, or cancelled' });
    }

    const { vendorId, orderDate, expectedDate, notes, shippingFee, handlingFee, discount, items } = req.body;

    // ── Update header fields ──
    const headerData = { updated_at: new Date() };
    if (vendorId !== undefined) headerData.vendor_id = parseInt(vendorId);
    if (orderDate !== undefined) headerData.order_date = orderDate ? new Date(orderDate) : null;
    if (expectedDate !== undefined) headerData.expected_date = expectedDate ? new Date(expectedDate) : null;
    if (notes !== undefined) headerData.notes = notes ? notes.toUpperCase() : null;
    if (shippingFee !== undefined) headerData.shipping_fee = parseFloat(shippingFee) || 0;
    if (handlingFee !== undefined) headerData.handling_fee = parseFloat(handlingFee) || 0;
    if (discount !== undefined) headerData.discount = parseFloat(discount) || 0;

    // ── Update items if provided ──
    if (items && Array.isArray(items)) {
      // Strategy: delete all existing items, recreate
      // (Only safe because PO is draft/ordered — no received items yet)
      const hasReceived = po.items.some(i => i.received_qty > 0);
      if (hasReceived) {
        return res.status(400).json({ error: 'Cannot replace items — some have already been received. Edit quantities individually or add new items.' });
      }

      // Delete existing items
      await req.prisma.po_items.deleteMany({ where: { po_id: id } });

      // Create new items
      let subtotal = 0;
      for (const i of items) {
        const qty = parseInt(i.quantity) || 1;
        const price = parseFloat(i.unitPrice) || 0;
        subtotal += qty * price;
        await req.prisma.po_items.create({
          data: {
            po_id: id,
            product_id: parseInt(i.productId),
            quantity: qty,
            unit_price: price,
            notes: i.notes ? i.notes.toUpperCase() : null,
          },
        });
      }
      headerData.subtotal = subtotal;
    }

    // Recalculate total
    const finalSubtotal = headerData.subtotal !== undefined ? headerData.subtotal : parseFloat(po.subtotal);
    const finalShip = headerData.shipping_fee !== undefined ? headerData.shipping_fee : parseFloat(po.shipping_fee || 0);
    const finalHandle = headerData.handling_fee !== undefined ? headerData.handling_fee : parseFloat(po.handling_fee || 0);
    const finalDisc = headerData.discount !== undefined ? headerData.discount : parseFloat(po.discount || 0);
    headerData.total_amount = finalSubtotal + finalShip + finalHandle - finalDisc;

    const updated = await req.prisma.purchase_orders.update({
      where: { id },
      data: headerData,
      include: {
        items: { include: { product: { select: { name: true, sku: true, unit: true, is_serialized: true } } }, orderBy: { id: 'asc' } },
        vendor: { select: { name: true } },
        creator: { select: { full_name: true } },
      },
    });

    res.json({ message: 'Purchase order updated', purchaseOrder: updated });
  } catch (err) {
    console.error('Edit PO error:', err);
    res.status(500).json({ error: 'Failed to update purchase order' });
  }
});

// ── ADD ITEM TO EXISTING PO ─────────────────────────────────
router.post('/purchase-orders/:id/items', adminAuth(), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const po = await req.prisma.purchase_orders.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (!['draft', 'ordered'].includes(po.status)) {
      return res.status(400).json({ error: 'Cannot add items to this PO' });
    }

    const { productId, quantity, unitPrice, notes } = req.body;
    if (!productId) return res.status(400).json({ error: 'Product required' });

    const qty = parseInt(quantity) || 1;
    const price = parseFloat(unitPrice) || 0;
    const lineTotal = qty * price;

    const item = await req.prisma.po_items.create({
      data: {
        po_id: poId,
        product_id: parseInt(productId),
        quantity: qty,
        unit_price: price,
        notes: notes ? notes.toUpperCase() : null,
      },
      include: { product: { select: { name: true, sku: true } } },
    });

    // Recalculate totals
    const newSubtotal = parseFloat(po.subtotal) + lineTotal;
    const totalAmount = newSubtotal + parseFloat(po.shipping_fee || 0) + parseFloat(po.handling_fee || 0) - parseFloat(po.discount || 0);
    await req.prisma.purchase_orders.update({
      where: { id: poId },
      data: { subtotal: newSubtotal, total_amount: totalAmount, updated_at: new Date() },
    });

    res.status(201).json({ message: 'Item added', item });
  } catch (err) {
    console.error('Add PO item error:', err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// ── REMOVE ITEM FROM PO ─────────────────────────────────────
router.delete('/purchase-orders/:id/items/:itemId', adminAuth(), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);

    const po = await req.prisma.purchase_orders.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (!['draft', 'ordered'].includes(po.status)) {
      return res.status(400).json({ error: 'Cannot remove items from this PO' });
    }

    const item = await req.prisma.po_items.findUnique({ where: { id: itemId } });
    if (!item || item.po_id !== poId) return res.status(404).json({ error: 'Item not found' });
    if (item.received_qty > 0) return res.status(400).json({ error: 'Cannot remove — items already received' });

    await req.prisma.po_items.delete({ where: { id: itemId } });

    // Recalculate totals
    const lineTotal = item.quantity * parseFloat(item.unit_price);
    const newSubtotal = parseFloat(po.subtotal) - lineTotal;
    const totalAmount = newSubtotal + parseFloat(po.shipping_fee || 0) + parseFloat(po.handling_fee || 0) - parseFloat(po.discount || 0);
    await req.prisma.purchase_orders.update({
      where: { id: poId },
      data: { subtotal: Math.max(0, newSubtotal), total_amount: Math.max(0, totalAmount), updated_at: new Date() },
    });

    res.json({ message: 'Item removed' });
  } catch (err) {
    console.error('Remove PO item error:', err);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// ── DELETE PO (draft/cancelled only, superadmin) ────────────
router.delete('/purchase-orders/:id', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (req.admin.role !== 'superadmin') return res.status(403).json({ error: 'Only superadmin can delete purchase orders' });

    const po = await req.prisma.purchase_orders.findUnique({ where: { id }, include: { items: true } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['draft', 'cancelled'].includes(po.status)) {
      return res.status(400).json({ error: 'Only draft or cancelled POs can be deleted' });
    }
    // Check if any items have been received
    const hasReceived = po.items.some(i => i.received_qty > 0);
    if (hasReceived) return res.status(400).json({ error: 'Cannot delete PO with received items' });

    await req.prisma.purchase_orders.delete({ where: { id } });
    res.json({ message: 'Purchase order deleted' });
  } catch (err) {
    console.error('Delete PO error:', err);
    res.status(500).json({ error: 'Failed to delete purchase order' });
  }
});

// ── UPDATE PO STATUS ────────────────────────────────────────
router.put('/purchase-orders/:id/status', adminAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    const validStatuses = ['draft', 'ordered', 'partial', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const data = { status, updated_at: new Date() };
    if (status === 'ordered') data.order_date = new Date();
    if (status === 'received') { data.received_date = new Date(); data.approved_by = req.adminId; }

    const po = await req.prisma.purchase_orders.update({ where: { id }, data });
    res.json({ message: 'Status updated', purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: 'Failed to update status' }); }
});

// ── RECEIVE BULK (non-serialized items) ─────────────────────
router.post('/purchase-orders/:id/receive', adminAuth(), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { items } = req.body; // [{ poItemId, receivedQty }]
    if (!items || items.length === 0) return res.status(400).json({ error: 'Items required' });

    const po = await req.prisma.purchase_orders.findUnique({
      where: { id: poId },
      include: { items: { include: { product: true } } },
    });
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive items for a cancelled PO' });

    const results = [];

    for (const item of items) {
      const poItem = po.items.find(i => i.id === item.poItemId);
      if (!poItem) { results.push({ poItemId: item.poItemId, error: 'Item not found' }); continue; }
      if (poItem.product.is_serialized) { results.push({ poItemId: item.poItemId, error: 'Serialized items must be received individually via /receive-serial' }); continue; }

      const qtyToReceive = parseInt(item.receivedQty) || 0;
      if (qtyToReceive <= 0) continue;

      const newReceivedQty = poItem.received_qty + qtyToReceive;
      if (newReceivedQty > poItem.quantity) {
        results.push({ poItemId: item.poItemId, error: `Cannot receive ${qtyToReceive} — would exceed ordered qty of ${poItem.quantity} (already received ${poItem.received_qty})` });
        continue;
      }

      // Update po_item received count
      await req.prisma.po_items.update({
        where: { id: item.poItemId },
        data: { received_qty: newReceivedQty },
      });

      // Update inventory stock
      const existing = await req.prisma.inventory_stock.findFirst({ where: { product_id: poItem.product_id } });
      if (existing) {
        await req.prisma.inventory_stock.update({
          where: { id: existing.id },
          data: { quantity: { increment: qtyToReceive }, updated_at: new Date() },
        });
      } else {
        await req.prisma.inventory_stock.create({
          data: { product_id: poItem.product_id, quantity: qtyToReceive },
        });
      }

      // Log transaction
      await req.prisma.inventory_transactions.create({
        data: {
          product_id: poItem.product_id,
          type: 'received',
          quantity: qtyToReceive,
          reference_type: 'purchase_order',
          reference_id: poId,
          notes: `RECEIVED ${qtyToReceive} FROM PO ${po.po_number}`,
          created_by: req.adminId,
        },
      });

      results.push({ poItemId: item.poItemId, received: qtyToReceive, totalReceived: newReceivedQty, ok: true });
    }

    // Auto-update PO status
    await _updatePOStatus(req.prisma, poId, req.adminId);

    res.json({ message: 'Items received', results });
  } catch (err) {
    console.error('Receive PO error:', err);
    res.status(500).json({ error: 'Failed to receive items' });
  }
});

// ── RECEIVE SINGLE SERIALIZED ITEM ──────────────────────────
// Receives one unit at a time with serial number + MAC address
// Creates onu_inventory record with status 'in_stock'
// vendor_id from PO already references the unified vendors table (same as CRM ONU page)
router.post('/purchase-orders/:id/receive-serial', adminAuth(), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { poItemId, serialNumber, macAddress } = req.body;

    if (!poItemId) return res.status(400).json({ error: 'PO item ID required' });
    if (!serialNumber && !macAddress) return res.status(400).json({ error: 'Serial number or MAC address required' });

    const po = await req.prisma.purchase_orders.findUnique({
      where: { id: poId },
      include: { items: { include: { product: true } }, vendor: true },
    });
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive items for a cancelled PO' });

    const poItem = po.items.find(i => i.id === parseInt(poItemId));
    if (!poItem) return res.status(404).json({ error: 'PO item not found' });
    if (!poItem.product.is_serialized) return res.status(400).json({ error: 'This item is not serialized — use bulk receive instead' });

    // Check if already fully received
    if (poItem.received_qty >= poItem.quantity) {
      return res.status(400).json({ error: `All ${poItem.quantity} units already received for this item` });
    }

    // Validate MAC uniqueness if provided
    const cleanMac = macAddress ? macAddress.trim().toUpperCase() : '';
    const cleanSerial = serialNumber ? serialNumber.trim().toUpperCase() : '';

    if (cleanMac) {
      const existingMac = await req.prisma.onu_inventory.findFirst({ where: { mac_address: cleanMac } });
      if (existingMac) return res.status(409).json({ error: `MAC address ${cleanMac} already exists in inventory` });
    }
    if (cleanSerial) {
      const existingSerial = await req.prisma.onu_inventory.findFirst({ where: { serial_number: cleanSerial } });
      if (existingSerial) return res.status(409).json({ error: `Serial number ${cleanSerial} already exists in inventory` });
    }

    // Create ONU inventory record — vendor_id references unified vendors table (shared with CRM)
    const onu = await req.prisma.onu_inventory.create({
      data: {
        mac_address: cleanMac || `PENDING-${Date.now()}`,
        serial_number: cleanSerial || null,
        model: poItem.product.name,
        vendor_id: po.vendor_id,
        product_id: poItem.product_id,
        status: 'in_stock',
        purchase_date: new Date(),
        purchase_price: poItem.unit_price,
        notes: `Received from ${po.po_number}`,
      },
    });

    // Update po_item received count + received_serials log
    const existingSerials = poItem.received_serials || [];
    existingSerials.push({
      serial: cleanSerial,
      mac: cleanMac,
      onuId: onu.id,
      receivedAt: new Date().toISOString(),
      receivedBy: req.adminId,
    });

    await req.prisma.po_items.update({
      where: { id: poItem.id },
      data: {
        received_qty: poItem.received_qty + 1,
        received_serials: existingSerials,
      },
    });

    // Log inventory transaction
    await req.prisma.inventory_transactions.create({
      data: {
        product_id: poItem.product_id,
        type: 'received',
        quantity: 1,
        reference_type: 'purchase_order',
        reference_id: poId,
        notes: `SERIAL RECEIVED: ${cleanSerial || cleanMac} FROM PO ${po.po_number}`,
        created_by: req.adminId,
      },
    });

    // Auto-update PO status
    const statusInfo = await _updatePOStatus(req.prisma, poId, req.adminId);

    const remaining = poItem.quantity - (poItem.received_qty + 1);
    res.json({
      message: `Serial unit received (${poItem.received_qty + 1}/${poItem.quantity})`,
      onu,
      remaining,
      poStatus: statusInfo.status,
      totalReceivedForItem: poItem.received_qty + 1,
    });
  } catch (err) {
    console.error('Receive serial error:', err);
    if (err.code === 'P2002') return res.status(409).json({ error: 'Duplicate MAC address or serial number' });
    res.status(500).json({ error: 'Failed to receive serialized item' });
  }
});

// ── GET RECEIVED SERIALS FOR A PO ITEM ──────────────────────
router.get('/purchase-orders/:id/items/:itemId/serials', adminAuth(), async (req, res) => {
  try {
    const poItem = await req.prisma.po_items.findUnique({
      where: { id: parseInt(req.params.itemId) },
      include: { product: { select: { name: true, sku: true } } },
    });
    if (!poItem) return res.status(404).json({ error: 'PO item not found' });

    // Also fetch the actual ONU records for these serials
    const serials = poItem.received_serials || [];
    const onuIds = serials.map(s => s.onuId).filter(Boolean);
    const onus = onuIds.length > 0
      ? await req.prisma.onu_inventory.findMany({
          where: { id: { in: onuIds } },
          select: { id: true, mac_address: true, serial_number: true, status: true, subscriber_id: true },
        })
      : [];

    res.json({
      item: { id: poItem.id, productName: poItem.product.name, quantity: poItem.quantity, receivedQty: poItem.received_qty },
      serials,
      onus,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to load serials' }); }
});

// ── HELPER: Auto-update PO status based on received items ───
async function _updatePOStatus(prisma, poId, adminId) {
  const updatedPO = await prisma.purchase_orders.findUnique({
    where: { id: poId },
    include: { items: true },
  });

  const allReceived = updatedPO.items.length > 0 && updatedPO.items.every(i => i.received_qty >= i.quantity);
  const someReceived = updatedPO.items.some(i => i.received_qty > 0);

  let newStatus = updatedPO.status;
  if (allReceived) newStatus = 'received';
  else if (someReceived && updatedPO.status !== 'cancelled') newStatus = 'partial';

  if (newStatus !== updatedPO.status) {
    const data = { status: newStatus, updated_at: new Date() };
    if (newStatus === 'received') {
      data.received_date = new Date();
      data.approved_by = adminId;
    }
    await prisma.purchase_orders.update({ where: { id: poId }, data });
  }

  return { status: newStatus, allReceived, someReceived };
}

// ── DUPLICATE PO ────────────────────────────────────────────
router.post('/purchase-orders/:id/duplicate', adminAuth(), async (req, res) => {
  try {
    const origPO = await req.prisma.purchase_orders.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { items: true },
    });
    if (!origPO) return res.status(404).json({ error: 'PO not found' });

    const seq = await req.prisma.$queryRaw`SELECT nextval('po_number_seq')::int as num`;
    const now = new Date();
    const poNum = 'PO-' + now.toISOString().slice(2, 4) + now.toISOString().slice(5, 7) + String(seq[0].num).padStart(4, '0');

    const newPO = await req.prisma.purchase_orders.create({
      data: {
        po_number: poNum,
        vendor_id: origPO.vendor_id,
        status: 'draft',
        order_date: now,
        expected_date: null,
        subtotal: origPO.subtotal,
        shipping_fee: origPO.shipping_fee || 0,
        handling_fee: origPO.handling_fee || 0,
        discount: origPO.discount || 0,
        tax_amount: 0,
        total_amount: origPO.total_amount,
        notes: origPO.notes ? `DUPLICATED FROM ${origPO.po_number}. ${origPO.notes}` : `DUPLICATED FROM ${origPO.po_number}`,
        created_by: req.adminId,
        items: {
          create: origPO.items.map(i => ({
            product_id: i.product_id,
            quantity: i.quantity,
            unit_price: parseFloat(i.unit_price),
            notes: i.notes,
          })),
        },
      },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        vendor: { select: { name: true } },
      },
    });

    res.status(201).json({ message: `PO duplicated as ${poNum}`, purchaseOrder: newPO });
  } catch (err) {
    console.error('Duplicate PO error:', err);
    res.status(500).json({ error: 'Failed to duplicate PO' });
  }
});

// ── INVENTORY STOCK ─────────────────────────────────────────
router.get('/stock', adminAuth(), async (req, res) => {
  try {
    const stock = await req.prisma.inventory_stock.findMany({
      include: {
        product: {
          include: {
            category: { select: { name: true } },
            vendor: { select: { name: true } },
          },
        },
      },
      orderBy: { product: { name: 'asc' } },
    });
    res.json({ stock });
  } catch (err) { res.status(500).json({ error: 'Failed to load stock' }); }
});

router.post('/stock/adjust', adminAuth(), async (req, res) => {
  try {
    const { productId, quantity, type, notes } = req.body;
    if (!productId || quantity === undefined) return res.status(400).json({ error: 'Product and quantity required' });

    const stock = await req.prisma.inventory_stock.findFirst({ where: { product_id: parseInt(productId) } });
    if (!stock) return res.status(404).json({ error: 'Stock record not found' });

    const newQty = type === 'set' ? parseInt(quantity) : stock.quantity + parseInt(quantity);
    await req.prisma.inventory_stock.update({
      where: { id: stock.id },
      data: { quantity: Math.max(0, newQty), updated_at: new Date() },
    });

    await req.prisma.inventory_transactions.create({
      data: {
        product_id: parseInt(productId),
        type: 'adjustment',
        quantity: parseInt(quantity),
        notes: notes ? notes.toUpperCase() : 'MANUAL ADJUSTMENT',
        created_by: req.adminId,
      },
    });

    res.json({ message: 'Stock adjusted', newQuantity: Math.max(0, newQty) });
  } catch (err) { res.status(500).json({ error: 'Failed to adjust stock' }); }
});

// ── INVENTORY TRANSACTIONS ──────────────────────────────────
router.get('/transactions', adminAuth(), async (req, res) => {
  try {
    const { product, type, limit } = req.query;
    const where = {};
    if (product) where.product_id = parseInt(product);
    if (type) where.type = type;
    const txns = await req.prisma.inventory_transactions.findMany({
      where,
      take: parseInt(limit) || 50,
      orderBy: { created_at: 'desc' },
      include: {
        product: { select: { name: true, sku: true } },
        creator: { select: { full_name: true } },
      },
    });
    res.json({ transactions: txns });
  } catch (err) { res.status(500).json({ error: 'Failed to load transactions' }); }
});

// ── PHILIPPINE ADDRESS LOOKUP ─────────────────────────────────
router.get('/address/regions', adminAuth(), async (req, res) => {
  try {
    const regions = await req.prisma.$queryRaw`
      SELECT code, name, region_name, island_group, sort_order
      FROM ph_regions ORDER BY sort_order`;
    res.json({ regions });
  } catch (err) {
    console.error('Address regions error:', err);
    res.status(500).json({ error: 'Failed to fetch regions' });
  }
});

router.get('/address/provinces', adminAuth(), async (req, res) => {
  try {
    const { region_code } = req.query;
    let provinces;
    if (region_code) {
      provinces = await req.prisma.$queryRaw`
        SELECT code, name, region_code FROM ph_provinces WHERE region_code = ${region_code} ORDER BY name`;
    } else {
      provinces = await req.prisma.$queryRaw`
        SELECT code, name, region_code FROM ph_provinces ORDER BY name`;
    }
    res.json({ provinces });
  } catch (err) {
    console.error('Address provinces error:', err);
    res.status(500).json({ error: 'Failed to fetch provinces' });
  }
});

router.get('/address/cities-municipalities', adminAuth(), async (req, res) => {
  try {
    const { province_code } = req.query;
    if (!province_code) return res.status(400).json({ error: 'province_code required' });
    const cities = await req.prisma.$queryRaw`
      SELECT code, name, province_code, is_city, zip_code
      FROM ph_cities_municipalities WHERE province_code = ${province_code} ORDER BY name`;
    res.json({ cities });
  } catch (err) {
    console.error('Address cities error:', err);
    res.status(500).json({ error: 'Failed to fetch cities/municipalities' });
  }
});

router.get('/address/barangays', adminAuth(), async (req, res) => {
  try {
    const { city_mun_code } = req.query;
    if (!city_mun_code) return res.status(400).json({ error: 'city_mun_code required' });
    const barangays = await req.prisma.$queryRaw`
      SELECT code, name, city_mun_code FROM ph_barangays WHERE city_mun_code = ${city_mun_code} ORDER BY name`;
    res.json({ barangays });
  } catch (err) {
    console.error('Address barangays error:', err);
    res.status(500).json({ error: 'Failed to fetch barangays' });
  }
});

module.exports = router;
