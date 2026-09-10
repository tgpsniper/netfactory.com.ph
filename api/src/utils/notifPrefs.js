// ============================================================
// NETFACTORY — Notification Preferences Utility
// Reads per-subscriber notification preferences from DB.
// Used to gate notification sends based on user settings.
// ============================================================

'use strict';

/**
 * Fetch notification preferences for a subscriber.
 * Returns safe defaults (all enabled except promos) if no record exists.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} subscriberId
 * @returns {Promise<{ emailBilling: boolean, smsPayment: boolean, outageAlerts: boolean, promos: boolean }>}
 */
async function getPrefs(prisma, subscriberId) {
  try {
    const prefs = await prisma.subscriber_notification_prefs.findUnique({
      where: { subscriber_id: subscriberId },
    });
    return {
      emailBilling: prefs?.email_billing  ?? true,
      smsPayment:   prefs?.sms_payment    ?? true,
      outageAlerts: prefs?.outage_alerts  ?? true,
      promos:       prefs?.promos         ?? false,
    };
  } catch {
    // On any DB error, default to sending all critical notifications
    return { emailBilling: true, smsPayment: true, outageAlerts: true, promos: false };
  }
}

module.exports = { getPrefs };
