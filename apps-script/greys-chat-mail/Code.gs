/**
 * Greys Chat mail — brings client EMAIL replies into Greys Chat.
 *
 * Chat emails go out with Reply-To info+c<code>@greyscheese.com. Mail to info@ arrives in this
 * mailbox; every minute this script finds replies sent to one of those info+c… addresses and hands
 * just those to Greys Chat (edge function chat-mail-in), signed with this Google account's identity.
 * Nothing else in the mailbox is read beyond its To/Cc/Delivered-To lines, and nothing is changed.
 *
 * Install: run setup() once and allow access.   Stop: run stop().
 */
var ENDPOINT = 'https://vdvtrevhqalmjwhjhjug.supabase.co/functions/v1/chat-mail-in';
var REPLY_RE = /info\+c[a-z0-9]{10}@greyscheese\.com/i;
var MAX_ATTACH = 5, MAX_BYTES = 10 * 1024 * 1024;

function setup() {
  stop();
  ScriptApp.newTrigger('pullReplies').timeBased().everyMinutes(1).create();
  var r = post_({ ping: true });
  Logger.log('Greys Chat answered ' + r.code + ': ' + r.text);
  pullReplies();
}

function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pullReplies') ScriptApp.deleteTrigger(t);
  });
}

function pullReplies() {
  var props = PropertiesService.getScriptProperties();
  var started = Math.floor(Date.now() / 1000);
  var since = Number(props.getProperty('SINCE') || started - 6 * 3600);
  var q = 'deliveredto:info@greyscheese.com after:' + (since - 300) + ' -in:sent -in:drafts';
  var list = Gmail.Users.Messages.list('me', { q: q, maxResults: 100 });
  var failed = false;
  (list.messages || []).forEach(function (ref) {
    var meta = Gmail.Users.Messages.get('me', ref.id, { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Delivered-To'] });
    var h = headers_(meta.payload && meta.payload.headers);
    if (!REPLY_RE.test([h['to'], h['cc'], h['delivered-to']].join(' '))) return; // ordinary info@ mail: left alone
    var m = Gmail.Users.Messages.get('me', ref.id, { format: 'full' });
    var hh = headers_(m.payload.headers);
    var out = { text: '', html: '', attachments: [] };
    walk_(m.id, m.payload, out);
    var r = post_({
      id: m.id, from: hh['from'] || '', to: hh['to'] || '', cc: hh['cc'] || '', deliveredTo: hh['delivered-to'] || '',
      subject: hh['subject'] || '', date: new Date(Number(m.internalDate)).toISOString(),
      text: out.text, html: out.html, attachments: out.attachments
    });
    if (r.code !== 200) { failed = true; Logger.log('Greys Chat said ' + r.code + ' for ' + m.id + ': ' + r.text); }
  });
  if (!failed) props.setProperty('SINCE', String(started)); // on a failure the same window is retried next minute
}

function post_(payload) {
  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-google-id-token': ScriptApp.getIdentityToken() },
    payload: JSON.stringify(payload)
  });
  return { code: res.getResponseCode(), text: res.getContentText().slice(0, 300) };
}

function headers_(list) {
  var h = {};
  (list || []).forEach(function (x) {
    var k = String(x.name).toLowerCase();
    h[k] = h[k] ? h[k] + ', ' + x.value : x.value;
  });
  return h;
}

function bytes_(d) { return typeof d === 'string' ? Utilities.base64DecodeWebSafe(d) : d; }

function walk_(id, part, out) {
  if (part.parts && part.parts.length) {
    part.parts.forEach(function (p) { walk_(id, p, out); });
    return;
  }
  var type = String(part.mimeType || '').toLowerCase();
  var h = headers_(part.headers);
  var body = part.body || {};
  if (part.filename && body.attachmentId) {
    var inline = /^inline/i.test(h['content-disposition'] || '') && h['content-id'];
    if (!inline && out.attachments.length < MAX_ATTACH && (body.size || 0) <= MAX_BYTES) {
      var a = Gmail.Users.Messages.Attachments.get('me', id, body.attachmentId);
      out.attachments.push({ name: part.filename, type: type, data: Utilities.base64Encode(bytes_(a.data)) });
    }
    return;
  }
  if (!body.data) return;
  var cs = (/charset="?([^";\s]+)/i.exec(h['content-type'] || '') || [])[1] || 'UTF-8';
  var s;
  try { s = Utilities.newBlob(bytes_(body.data)).getDataAsString(cs); } catch (e) { s = Utilities.newBlob(bytes_(body.data)).getDataAsString(); }
  if (type === 'text/plain' && !out.text) out.text = s.slice(0, 100000);
  else if (type === 'text/html' && !out.html) out.html = s.slice(0, 200000);
}
