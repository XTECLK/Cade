// The web app the Cade Worker writes each group's executive summaries in its
// Google Doc through (see src/google.js): one standalone script, in no doc,
// serving every group. It runs as whoever deployed it, so they must be able to
// edit each group's doc.
//
// Each request is { secret, action, … }. `secret` must match SECRET, defined
// in Secret.gs next to this file, which `npm run google:create` makes along
// with the Worker's GOOGLE_SECRET. The actions:
//   doc.write     { docId, tab, key, blocks }      → { url }, a section of the
//                                                    doc's tab (Doc.gs)
//   doc.read      { docId, tab, key }              → { elements }, a section
//                                                    as it now reads
//   doc.create    { title }                        → { id }, a new doc
// New docs are for `npm run group`, and are yours.

const ACTIONS = {
  "doc.write": (body) => ({ url: write(body.docId, body.tab, body.key, body.blocks) }),
  "doc.read": (body) => ({ elements: read(body.docId, body.tab, body.key) }),
  "doc.create": (body) => ({ id: createDoc(body.title) }),
};

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (typeof SECRET === "undefined" || !SECRET || body.secret !== SECRET) {
    return reply({ ok: false, error: "unauthorized" });
  }
  const action = ACTIONS[body.action];
  if (!action) return reply({ ok: false, error: `unknown action ${body.action}` });
  // Two updates for the same doc can arrive at once.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return reply({ ok: true, ...action(body) });
  } catch (error) {
    // Such as a file that's gone, or that whoever deployed this can't edit.
    return reply({ ok: false, error: String(error && error.message ? error.message : error) });
  } finally {
    lock.releaseLock();
  }
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Run once in the Apps Script editor after creating the script, to approve
// its access to your docs; the web app can't ask for it
// itself.
function authorize() {
  Logger.log(`Authorized as ${Session.getEffectiveUser().getEmail()}.`);
}

// Anyone with the link can view a file made here (editing stays with the account).
function shareToViewers(fileId) {
  DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
}
