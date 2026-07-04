// ===== ระบบแจ้งเตือนเด้ง "ใหม่เภสัช" — ตัวช่วยกลางฝั่งเซิร์ฟเวอร์ =====
// เชื่อม Firebase (Firestore + Cloud Messaging) ผ่าน REST ตรงๆ ไม่ใช้ไลบรารีเสริม
// ต้องตั้งค่า Environment variable ใน Netlify: FIREBASE_SERVICE_ACCOUNT = เนื้อไฟล์ JSON ของ service account
const crypto = require('crypto');

const PROJECT = 'naimaphat-pharmacy';
const API_KEY = 'AIzaSyCp-ykqpOv4dRExutf5308T6ia3HVHYuOo'; // web API key (เป็นค่าสาธารณะ อยู่ใน app.html อยู่แล้ว)
const BRANCHES = ['ทรัพย์พัฒนา', 'บางปู', 'อินดี้'];
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function sa() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('ยังไม่ได้ตั้งค่า FIREBASE_SERVICE_ACCOUNT ใน Netlify');
  return JSON.parse(raw);
}
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- ขอ access token จาก service account (เก็บ cache ไว้ใช้ซ้ำใน run เดียวกัน) ----
let _tok = null, _tokExp = 0;
async function accessToken() {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const s = sa();
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: s.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(hdr + '.' + claim).sign(s.private_key);
  const jwt = hdr + '.' + claim + '.' + b64u(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('ขอ access token ไม่สำเร็จ: ' + JSON.stringify(j));
  _tok = j.access_token; _tokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return _tok;
}

// ---- แปลงค่าระหว่าง JSON ปกติ ↔ รูปแบบ Firestore REST ----
function dec(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return +v.integerValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = dec(f[k]); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  return null;
}
function decDoc(d) { const o = {}; const f = d.fields || {}; for (const k in f) o[k] = dec(f[k]); o._id = d.name.split('/').pop(); return o; }
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') { const f = {}; for (const k in v) f[k] = enc(v[k]); return { mapValue: { fields: f } }; }
  return { nullValue: null };
}
function encFields(o) { const f = {}; for (const k in o) f[k] = enc(o[k]); return f; }

// ---- อ่าน/เขียน Firestore ----
async function fsGet(path, tok) {
  const r = await fetch(`${BASE}/${path}`, { headers: { authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  const j = await r.json();
  return j.fields ? decDoc(j) : null;
}
async function fsList(col, tok) {
  let out = [], pageToken = '';
  do {
    const r = await fetch(`${BASE}/${col}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json();
    (j.documents || []).forEach(d => out.push(decDoc(d)));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
async function fsQueryEq(col, filters, tok) {
  const fs = filters.map(([f, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: enc(v) } }));
  const where = fs.length === 1 ? fs[0] : { compositeFilter: { op: 'AND', filters: fs } };
  const r = await fetch(BASE.replace(/\/documents$/, '') + '/documents:runQuery', {
    method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where, limit: 500 } })
  });
  const j = await r.json();
  return (Array.isArray(j) ? j : []).filter(x => x.document).map(x => decDoc(x.document));
}
// เขียนทับเฉพาะ field ที่ระบุ
async function fsPatchField(path, fieldPaths, obj, tok) {
  const mask = fieldPaths.map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
  const r = await fetch(`${BASE}/${path}?${mask}`, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: encFields(obj) })
  });
  return r.ok;
}
// สร้างเอกสารแบบ "ต้องยังไม่มีอยู่ก่อน" — ใช้เป็นตัวกันส่งแจ้งเตือนซ้ำ (สร้างได้ = ยังไม่เคยส่ง)
async function claimOnce(key, tok) {
  const r = await fetch(`${BASE}/notifSent/${encodeURIComponent(key)}?currentDocument.exists=false`, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: encFields({ at: new Date().toISOString() }) })
  });
  return r.ok;
}

// ---- เวลาไทย (UTC+7) — อ่านค่าด้วย getUTC* หลังบวก 7 ชั่วโมงแล้ว ----
function bkk() { return new Date(Date.now() + 7 * 3600000); }
function bkkDate(d) { return (d || bkk()).toISOString().slice(0, 10); }
function bkkMin(d) { d = d || bkk(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function bkkDow(d) { return (d || bkk()).getUTCDay(); }
function hm(s) { const p = String(s || '').split(':').map(Number); return isNaN(p[0]) ? null : p[0] * 60 + (p[1] || 0); }

// ---- ตรวจ ID token ของผู้ใช้ที่ล็อกอิน (เรียกจากแอป) ----
async function verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    const j = await r.json();
    const u = j.users && j.users[0];
    return u ? { uid: u.localId, email: u.email || '' } : null;
  } catch (e) { return null; }
}

// ---- ส่งแจ้งเตือน 1 ข้อความ → 1 เครื่อง (ส่งแบบ data ให้ sw.js ของแอปแสดงเอง) ----
async function fcmSend(token, note, tok) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
    method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        data: { title: note.title || 'ใหม่เภสัช', body: note.body || '', url: note.url || './app.html', tag: note.tag || 'nm' },
        webpush: { headers: { Urgency: 'high', TTL: '43200' } }
      }
    })
  });
  if (r.ok) return true;
  const txt = await r.text();
  if (r.status === 404 || txt.includes('UNREGISTERED') || txt.includes('INVALID_ARGUMENT')) return 'gone';
  return false;
}

// ---- กติกาต่อผู้ใช้: เปิดหัวข้อนี้ไหม + ช่วงห้ามกวน (ค่าเริ่มต้น 22:00–07:00) ----
function topicOn(m, topic) { const t = ((m.notifCfg || {}).topics) || {}; return t[topic] !== false; }
function inQuiet(m, nowMin) {
  const q = (m.notifCfg || {}).quiet || {};
  if (q.off === true) return false;
  const f = hm(q.from || '22:00'), t = hm(q.to || '07:00');
  if (f == null || t == null) return false;
  const mins = nowMin != null ? nowMin : bkkMin();
  return f > t ? (mins >= f || mins < t) : (mins >= f && mins < t);
}

// ---- ส่งถึงสมาชิก 1 คน (ทุกเครื่องที่ลงทะเบียนไว้) — เครื่องที่ token ตายแล้วจะถูกลบทิ้ง ----
async function sendToMember(m, topic, note, tok, opts = {}) {
  if (!opts.force && !topicOn(m, topic)) return 0;
  if (!opts.urgent && !opts.force && inQuiet(m)) return 0;
  const toks = m.fcmTokens || {};
  let n = 0; const gone = [];
  for (const k in toks) {
    const t = toks[k] && toks[k].t;
    if (!t) continue;
    const res = await fcmSend(t, note, tok);
    if (res === 'gone') gone.push(k); else if (res) n++;
  }
  if (gone.length) {
    const left = { ...toks }; gone.forEach(k => delete left[k]);
    try { await fsPatchField('members/' + m._id, ['fcmTokens'], { fcmTokens: left }, tok); } catch (e) { }
  }
  return n;
}

module.exports = {
  PROJECT, API_KEY, BRANCHES,
  accessToken, verifyIdToken,
  fsGet, fsList, fsQueryEq, fsPatchField, claimOnce,
  bkk, bkkDate, bkkMin, bkkDow, hm,
  fcmSend, sendToMember, topicOn, inQuiet,
  _test: { enc, dec, encFields, decDoc, b64u }
};
