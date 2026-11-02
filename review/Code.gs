/**
 * Backend for the akashto.com review copy.
 *
 * Where this goes: a Google Sheet you own > Extensions > Apps Script.
 * Paste this whole file in place of the starter code, save, then reload the Sheet.
 * A "Site review" menu appears. Run "Set up this sheet" once.
 * Then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Reviewers never sign in. Each one gets a private link with a token.
 * Uncheck "Active" on the Reviewers tab to turn a link off.
 */

const REVIEW_URL = 'https://akashto.com/review/';
const ADMIN_URL = 'https://akashto.com/review/admin.html';

const R_SHEET = 'Reviewers';
const S_SHEET = 'Suggestions';
const SET_SHEET = 'Settings';
const R_HEAD = ['Token', 'Name', 'Active', 'Created', 'Last visit', 'Done'];
const S_HEAD = ['ID', 'Token', 'Reviewer', 'Page', 'Section', 'Block', 'Original', 'Suggested', 'Comment', 'Status', 'Created', 'Updated'];
const STATUSES = ['open', 'accepted', 'rejected'];
const MAX_TEXT = 5000;
const MAX_PER_REVIEWER = 400;

/* ---------------- Sheet menu ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Site review')
    .addItem('Set up this sheet', 'setup')
    .addSeparator()
    .addItem('Add a reviewer', 'addReviewer')
    .addItem('Show review links', 'showLinks')
    .addItem('Show dashboard link', 'showAdminLink')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  const r = ensureSheet_(ss, R_SHEET, R_HEAD);
  r.getRange(1, 1, r.getMaxRows(), 2).setNumberFormat('@');
  r.getRange(1, 4, r.getMaxRows(), 3).setNumberFormat('@');
  const s = ensureSheet_(ss, S_SHEET, S_HEAD);
  s.getRange(1, 1, s.getMaxRows(), S_HEAD.length).setNumberFormat('@');
  const set = ensureSheet_(ss, SET_SHEET, ['Setting', 'Value']);
  set.getRange(1, 1, set.getMaxRows(), 2).setNumberFormat('@');
  if (!getSetting_('adminKey')) setSetting_('adminKey', randomToken_(32));
  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 3) ss.deleteSheet(first);
  SpreadsheetApp.getUi().alert('The sheet is ready. Next, deploy it as a web app (see the setup steps).');
}

function addReviewer() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Add a reviewer', 'Name for the greeting, for example "Prof. Al-Qadi":', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const name = String(res.getResponseText() || '').trim().slice(0, 80);
  if (!name) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(R_SHEET);
  if (!sh) { ui.alert('Run "Set up this sheet" first.'); return; }
  const token = randomToken_(10);
  sh.appendRow([token, cell_(name), true, nowIso_(), '', '']);
  sh.getRange(sh.getLastRow(), 3).insertCheckboxes().setValue(true);
  showDialog_('Link for ' + escapeHtml_(name),
    '<p>Send this link to ' + escapeHtml_(name) + '. It is private to them.</p>' + linkBox_(REVIEW_URL + '?r=' + token));
}

function showLinks() {
  const sh = SpreadsheetApp.getActive().getSheetByName(R_SHEET);
  if (!sh || sh.getLastRow() < 2) { SpreadsheetApp.getUi().alert('No reviewers yet. Use "Add a reviewer".'); return; }
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  const html = rows.filter(function (r) { return r[0]; }).map(function (r) {
    const on = isActive_(r[2]);
    return '<p style="margin:14px 0 4px"><b>' + escapeHtml_(r[1]) + '</b>' + (on ? '' : ' <span style="color:#a33">(turned off)</span>') + '</p>' +
      linkBox_(REVIEW_URL + '?r=' + r[0]);
  }).join('');
  showDialog_('Review links', html);
}

function showAdminLink() {
  const key = getSetting_('adminKey');
  if (!key) { SpreadsheetApp.getUi().alert('Run "Set up this sheet" first.'); return; }
  showDialog_('Your dashboard', '<p>Only for you. Anyone with this link can accept or reject suggestions.</p>' + linkBox_(ADMIN_URL + '?k=' + key));
}

/* ---------------- Web app ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'load') return json_(load_(p.r));
    if (p.action === 'admin') return json_(admin_(p.k));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let b;
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad request' }); }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    if (b.action === 'save') return json_(save_(b));
    if (b.action === 'delete') return json_(remove_(b));
    if (b.action === 'done') return json_(done_(b));
    if (b.action === 'status') return json_(status_(b));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (err) { /* already released */ }
  }
}

/* ---------------- Actions ---------------- */

function load_(token) {
  const rev = findReviewer_(token);
  if (!rev || !rev.active) return { ok: false, error: 'inactive' };
  rev.sheet.getRange(rev.row, 5).setValue(nowIso_());
  const list = suggestionRows_().filter(function (s) { return s.token === rev.token; }).map(publicSuggestion_);
  return { ok: true, name: rev.name, done: rev.done, suggestions: list };
}

function save_(b) {
  const rev = findReviewer_(b.r);
  if (!rev || !rev.active) return { ok: false, error: 'inactive' };
  const block = clip_(b.block, 200);
  if (!block) return { ok: false, error: 'missing block' };
  const id = rev.token + '|' + block;
  const sh = sheet_(S_SHEET);
  const rows = suggestionRows_();
  const now = nowIso_();
  const fields = {
    page: clip_(b.page, 40), section: clip_(b.section, 120),
    original: clip_(b.original, MAX_TEXT), suggested: clip_(b.suggested, MAX_TEXT), comment: clip_(b.comment, MAX_TEXT)
  };
  const hit = rows.filter(function (s) { return s.id === id; })[0];
  if (hit) {
    sh.getRange(hit.row, 3, 1, 10).setValues([cells_([rev.name, fields.page, fields.section, block, fields.original,
      fields.suggested, fields.comment, 'open', hit.created, now])]);
    return { ok: true, updated: now };
  }
  const mine = rows.filter(function (s) { return s.token === rev.token; }).length;
  if (mine >= MAX_PER_REVIEWER) return { ok: false, error: 'limit reached' };
  sh.appendRow(cells_([id, rev.token, rev.name, fields.page, fields.section, block, fields.original,
    fields.suggested, fields.comment, 'open', now, now]));
  return { ok: true, updated: now };
}

function remove_(b) {
  const rev = findReviewer_(b.r);
  if (!rev || !rev.active) return { ok: false, error: 'inactive' };
  const id = rev.token + '|' + clip_(b.block, 200);
  const hit = suggestionRows_().filter(function (s) { return s.id === id; })[0];
  if (hit) sheet_(S_SHEET).deleteRow(hit.row);
  return { ok: true };
}

function done_(b) {
  const rev = findReviewer_(b.r);
  if (!rev || !rev.active) return { ok: false, error: 'inactive' };
  rev.sheet.getRange(rev.row, 6).setValue(b.done ? nowIso_() : '');
  return { ok: true };
}

function status_(b) {
  if (!adminOk_(b.k)) return { ok: false, error: 'not allowed' };
  const st = String(b.status || '');
  if (STATUSES.indexOf(st) < 0) return { ok: false, error: 'bad status' };
  const hit = suggestionRows_().filter(function (s) { return s.id === b.id; })[0];
  if (!hit) return { ok: false, error: 'not found' };
  sheet_(S_SHEET).getRange(hit.row, 10).setValue(st);
  return { ok: true };
}

function admin_(k) {
  if (!adminOk_(k)) return { ok: false, error: 'not allowed' };
  const sugg = suggestionRows_();
  const reviewers = reviewerRows_().map(function (r) {
    return {
      name: r.name, token: r.token, active: r.active, lastVisit: r.lastVisit, done: r.done,
      count: sugg.filter(function (s) { return s.token === r.token; }).length
    };
  });
  const list = sugg.map(function (s) {
    const o = publicSuggestion_(s);
    o.id = s.id; o.reviewer = s.reviewer; o.status = s.status || 'open'; o.created = s.created;
    return o;
  });
  return { ok: true, reviewUrl: REVIEW_URL, reviewers: reviewers, suggestions: list };
}

/* ---------------- Helpers ---------------- */

function ensureSheet_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Run "Set up this sheet" first.');
  return sh;
}

function reviewerRows_() {
  const sh = sheet_(R_SHEET);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, R_HEAD.length).getValues().map(function (r, i) {
    return {
      sheet: sh, row: i + 2, token: String(r[0]).trim(), name: String(r[1]).trim(),
      active: isActive_(r[2]), lastVisit: String(r[4] || ''), done: String(r[5] || '')
    };
  }).filter(function (r) { return r.token; });
}

function findReviewer_(token) {
  token = String(token || '').trim();
  if (!token || token.length > 64) return null;
  return reviewerRows_().filter(function (r) { return r.token === token; })[0] || null;
}

function suggestionRows_() {
  const sh = sheet_(S_SHEET);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, S_HEAD.length).getValues().map(function (r, i) {
    return {
      row: i + 2, id: String(r[0]), token: String(r[1]), reviewer: String(r[2]), page: String(r[3]),
      section: String(r[4]), block: String(r[5]), original: String(r[6]), suggested: String(r[7]),
      comment: String(r[8]), status: String(r[9]), created: String(r[10]), updated: String(r[11])
    };
  }).filter(function (s) { return s.id; });
}

function publicSuggestion_(s) {
  return { block: s.block, page: s.page, section: s.section, original: s.original, suggested: s.suggested, comment: s.comment, updated: s.updated };
}

function isActive_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE' || String(v).toLowerCase() === 'yes';
}

function adminOk_(k) {
  const key = getSetting_('adminKey');
  return !!key && String(k || '') === key;
}

function getSetting_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SET_SHEET);
  if (!sh || sh.getLastRow() < 2) return '';
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const hit = rows.filter(function (r) { return r[0] === name; })[0];
  return hit ? String(hit[1]) : '';
}

function setSetting_(name, value) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SET_SHEET);
  sh.appendRow([name, value]);
}

function randomToken_(len) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
    for (let i = 0; i < bytes.length && out.length < len; i++) out += chars[(bytes[i] + 256) % chars.length];
  }
  return out;
}

function clip_(v, n) { return String(v == null ? '' : v).slice(0, n); }
// Text that starts like a formula is stored as plain text, never evaluated.
function cell_(v) { return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v; }
function cells_(row) { return row.map(cell_); }
function nowIso_() { return new Date().toISOString(); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function linkBox_(url) {
  return '<input readonly value="' + escapeHtml_(url) + '" onclick="this.select()" ' +
    'style="width:100%;font:13px monospace;padding:8px;border:1px solid #ccc;border-radius:4px">';
}

function showDialog_(title, body) {
  const html = HtmlService.createHtmlOutput('<div style="font:14px Arial,sans-serif;line-height:1.5">' + body +
    '<p style="color:#666;font-size:12px;margin-top:14px">Click a link to select it, then copy.</p></div>')
    .setWidth(520).setHeight(360);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}
