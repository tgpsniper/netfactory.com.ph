// ============================================================
// channels/index.js — channel adapter registry
// ============================================================
// Each adapter exports at least { type, send, test }. Facebook and
// Viber additionally export verify*/parseInbound for their webhooks.
// Resolve by channel type: channels.get('gmail').send(...)
// ============================================================

const gmail = require('./gmail');
const viber = require('./viber');
const facebook = require('./facebook');

const byType = { gmail, viber, facebook };

module.exports = {
  byType,
  get(type) { return byType[type] || null; },
  types: Object.keys(byType),
};
