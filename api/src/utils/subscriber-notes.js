// ============================================================
// subscriber-notes.js — staff remarks, one row per stage
// ============================================================
// Every lifecycle step a subscriber passes through — application, survey, approval,
// scheduling, installer assignment, activation — can carry a remark from whoever
// performed it. Before this, remarks were appended as free text into
// subscribers.notes: a single column, string-concatenated in the browser and written
// back with the whole subscriber record. Two staff saving at once silently overwrote
// each other, and nothing recorded who wrote a line or when.
//
// subscribers.notes IS STILL WRITTEN. The CRM parses that blob for the installation
// date (parseScheduleInfo) and the decline reason, so dropping it would break the
// subscriber panel. Each remark therefore lands in two places: a row here, which is
// the record, and a one-line summary there, which is the compatibility shim.
//
// Never throws. A remark failing to save must not fail the stage transition it
// describes — losing the note is bad, losing the activation is worse.

const STAGES = [
  'application',   // the applicant first reaches the system
  'survey',        // site survey performed
  'approval',      // application approved
  'decline',       // application declined
  'schedule',      // installation scheduled
  'reschedule',    // installation moved
  'installer',     // installer / ONU assigned
  'activation',    // service switched on, first invoice raised
  'general',       // anything else staff want on the record
];

// What the one-line summary in subscribers.notes is prefixed with. Matches the
// existing shape the CRM already writes and parses, so old and new lines read alike.
const STAGE_LABEL = {
  application: 'APPLICATION',
  survey: 'SURVEY',
  approval: 'APPROVED',
  decline: 'DECLINED',
  schedule: 'INSTALLATION SCHEDULED',
  reschedule: 'RESCHEDULED',
  installer: 'INSTALLER ASSIGNED',
  activation: 'ACTIVATED',
  general: 'NOTE',
};

const MAX_REMARK = 4000;

function isStage(s) { return STAGES.includes(String(s)); }

// adminAuth attaches req.admin. req.adminUser is undefined everywhere it appears in
// this codebase and silently degrades to 'Admin', which is how every survey note ever
// written ended up unattributed — so resolve the name in exactly one place.
function adminName(req) {
  const a = req && req.admin;
  if (!a) return 'Admin';
  return a.full_name || a.username || a.email || 'Admin';
}

async function add(prisma, subscriberId, stage, remark, author) {
  try {
    const text = String(remark == null ? '' : remark).trim();
    if (!text) return null;                       // an empty box is not a remark
    if (!isStage(stage)) stage = 'general';
    const sid = Number(subscriberId);
    if (!Number.isInteger(sid)) return null;
    return await prisma.subscriber_notes.create({
      data: {
        subscriber_id: sid,
        stage,
        remark: text.slice(0, MAX_REMARK),
        author: String(author || 'Admin').slice(0, 100),
      },
    });
  } catch (err) {
    console.error('[subscriber-notes] could not save a ' + stage + ' remark for ' +
                  subscriberId + ': ' + err.message);
    return null;
  }
}

async function list(prisma, subscriberId) {
  const sid = Number(subscriberId);
  if (!Number.isInteger(sid)) return [];
  return prisma.subscriber_notes.findMany({
    where: { subscriber_id: sid },
    orderBy: { created_at: 'desc' },
  });
}

// The compatibility line for subscribers.notes. Returns the notes blob with the
// summary appended, or the blob untouched when there is no remark to add.
function appendSummary(existingNotes, stage, remark, author, when) {
  const text = String(remark == null ? '' : remark).trim();
  if (!text) return existingNotes || '';
  const d = (when instanceof Date ? when : new Date())
    .toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  const line = (STAGE_LABEL[stage] || 'NOTE') + ': ' + text + ' (by ' + (author || 'Admin') + ', ' + d + ')';
  return existingNotes ? existingNotes + '\n' + line : line;
}

module.exports = { add, list, appendSummary, adminName, isStage, STAGES, STAGE_LABEL, MAX_REMARK };
