// ============================================================
// utils/company.js — Single Source of Truth for Company Info
// ============================================================
// All routes, email templates, and PDF generation use this.
// Company data is read live from the system_settings DB table.
// To rebrand: update system_settings via the CRM Settings page.
//
// Usage:
//   const { getCompany } = require('../utils/company');
//   const co = await getCompany(req.prisma);
//   // co.name, co.domain, co.portalUrl, co.email, etc.
// ============================================================

async function getCompany(prisma) {
  try {
    const rows = await prisma.system_settings.findMany();
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });

    const rawDomain = (s.company_website || 'netfactory.com.ph')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');

    return {
      name:           s.company_name         || 'Netfactory',
      shortName:      s.company_short_name   || 'NF',
      tagline:        s.company_tagline      || 'Network',
      subtitle:       s.company_subtitle     || 'AND DATA SOLUTION',
      tin:            s.company_tin          || '',
      vatLabel:       s.company_vat_label    || 'Non-VAT TIN',
      brc:            s.company_brc          || '',
      address1:       s.company_address1     || 'Paliqui Colgante',
      address2:       s.company_address2     || '',
      city:           s.company_city         || 'Apalit, Pampanga',
      address:        s.company_address      || 'Paliqui Colgante, Apalit, Pampanga',
      email:          s.company_email        || '',
      supportEmail:   s.support_email        || s.company_email || '',
      phone:          s.company_phone        || '',
      domain:         rawDomain,
      website:        'www.' + rawDomain,
      portalUrl:      `https://${rawDomain}/portal/`,
      crmUrl:         `https://${rawDomain}/crm`,
      bankName:       s.bank_name            || '',
      bankAcctNumber: s.bank_account_number  || '',
      bankAcctName:   s.bank_account_name    || '',
      taxRate:        parseFloat(s.default_tax_rate  || '0.03'),
      taxLabel:       s.default_tax_label    || 'DTI 3% PT',
    };
  } catch (err) {
    console.error('[company.js] Failed to load company settings from DB:', err.message);
    // Safe fallback — matches netfactory.com.ph production domain
    // Only used if DB is unreachable; keep in sync with system_settings
    return {
      name:           'Netfactory',
      shortName:      'NF',
      tagline:        '.network',
      subtitle:       'AND DATA SOLUTION',
      tin:            '',
      vatLabel:       'Non-VAT TIN',
      brc:            '',
      address1:       'Paliqui Colgante',
      address2:       '',
      city:           'Apalit, Pampanga',
      address:        'Sitio Paliqui, Barangay Colgante, Apalit, Pampanga',
      email:          'info@netfactory.com.ph',
      supportEmail:   'support@netfactory.com.ph',
      phone:          '',
      domain:         'netfactory.com.ph',
      website:        'www.netfactory.com.ph',
      portalUrl:      'https://netfactory.com.ph/portal/',
      crmUrl:         'https://netfactory.com.ph/crm',
      bankName:       '',
      bankAcctNumber: '',
      bankAcctName:   'Netfactory',
      taxRate:        0.03,
      taxLabel:       'DTI 3% PT',
    };
  }
}

module.exports = { getCompany };
