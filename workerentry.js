// ตัวรันโค้ดของเว็บ (Cloudflare Worker entry) — v4.45.0
// หน้าที่ 3 อย่าง:
//   1) เสิร์ฟไฟล์เว็บ (static assets) — เส้นทางที่ตรงกับไฟล์ ไฟล์มาก่อนเสมอ
//   2) /juristic = ค้นหาข้อมูลผู้เสียภาษี/นิติบุคคล ให้ฟอร์มเอกสารการค้า
//   3) 🔔 ระบบแจ้งเตือนเด้ง (Push) — /notify (เกิดเหตุแล้วเด้ง) + Cron ทุก 10 นาที (ตามเวลา)
//      ต้องตั้ง Secret ชื่อ FIREBASE_SERVICE_ACCOUNT ใน Cloudflare ก่อน (ดูไฟล์ "วิธีเปิดแจ้งเตือนเด้ง.md")
// ⚠️ ห้ามลบไฟล์นี้ — wrangler.toml ชี้มาที่นี่ ลบแล้ว deploy พังทั้ง repo

// ===================================================================
// 🔔 ส่วนแจ้งเตือนเด้ง — ตัวช่วยเชื่อม Firebase (Firestore + Cloud Messaging) ผ่าน REST ตรงๆ
// ===================================================================
const PROJECT = 'naimaphat-pharmacy';
const API_KEY = 'AIzaSyCp-ykqpOv4dRExutf5308T6ia3HVHYuOo'; // web API key (ค่าสาธารณะ อยู่ใน app.html อยู่แล้ว)
const BRANCHES = ['ทรัพย์พัฒนา', 'บางปู', 'อินดี้'];
const BSHORT = ['ทรัพย์', 'บางปู', 'อินดี้'];
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function b64u(bytes) { // Uint8Array/ArrayBuffer → base64url
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64uStr = (str) => b64u(new TextEncoder().encode(str));

// ---- ขอ access token จาก service account (เก็บ cache ไว้ใช้ซ้ำจนกว่าจะหมดอายุ) ----
let _tok = null, _tokExp = 0;
async function accessToken(env) {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('ยังไม่ได้ตั้งค่า Secret ชื่อ FIREBASE_SERVICE_ACCOUNT ใน Cloudflare');
  const s = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({
    iss: s.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  // เซ็น JWT ด้วยกุญแจ RSA ของ service account (WebCrypto — มีในตัว Worker)
  const pem = String(s.private_key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(hdr + '.' + claim));
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

// ===================================================================
// 🔔 /notify — ตัวส่งแบบ "เกิดเหตุแล้วเด้ง" (แอปเรียกมาพร้อม ID token ของผู้ใช้)
// ประเภท: test, announce, leave_result, slip, close_diff, edit_request, leave_request,
//         js_error, swap_request, swap_peer, swap_result
// ===================================================================
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type'
};
async function handleNotify(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: CORS });
  try {
    const idToken = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    const user = await verifyIdToken(idToken);
    if (!user) return new Response('unauthorized', { status: 401, headers: CORS });

    let payload = {};
    try { payload = await request.json(); } catch (e) { }
    const type = payload.type, data = payload.data || {};

    const tok = await accessToken(env);
    const members = await fsList('members', tok);
    const me = members.find(m => m._id === user.uid);
    if (!me) return new Response('no member', { status: 403, headers: CORS });
    const admins = members.filter(m => m.role === 'admin' && (m.status || 'active') !== 'inactive');
    const isAdm = me.role === 'admin';
    const name = me.nickname || me.firstName || 'พนักงาน';
    const fmtN = n => Math.round(Math.abs(+n || 0)).toLocaleString('en-US');

    let sent = 0;
    const send = async (list, topic, note, opts) => { for (const m of list) sent += await sendToMember(m, topic, note, tok, opts); };

    if (type === 'test') {
      // ปุ่ม "ทดสอบส่งหาฉัน" — ข้ามทุกเงื่อนไข ส่งถึงตัวเองทันที
      sent += await sendToMember(me, 'test', { title: '🔔 ทดสอบแจ้งเตือน — ใหม่เภสัช', body: 'ทำงานเรียบร้อย! เครื่องนี้จะได้รับแจ้งเตือนจากร้าน', tag: 'test' }, tok, { force: true });
    }
    else if (type === 'announce') {
      if (!isAdm && (me.permissions || {}).announce !== true) return new Response('forbidden', { status: 403, headers: CORS });
      const text = String(data.text || '').slice(0, 140);
      if (text) await send(members.filter(m => m._id !== me._id), 'announce', { title: '📢 ประกาศจากร้าน', body: text, tag: 'announce' });
    }
    else if (type === 'leave_result') {
      if (!isAdm) return new Response('forbidden', { status: 403, headers: CORS });
      const to = members.find(m => m._id === data.uid);
      if (to) await send([to], 'leave_result', {
        title: data.ok ? '🌴 คำขอลาได้รับอนุมัติ' : 'คำขอลาไม่ได้รับอนุมัติ',
        body: `ช่วงวันที่ ${data.from || ''}${data.to && data.to !== data.from ? ' ถึง ' + data.to : ''}`, tag: 'leave'
      });
    }
    else if (type === 'slip') {
      if (!isAdm) return new Response('forbidden', { status: 403, headers: CORS });
      const to = members.find(m => m._id === data.uid);
      if (to) await send([to], 'slip', { title: '🧾 สลิปเงินเดือนออกแล้ว', body: `งวด${data.month || ''} · ยอดสุทธิ ฿${fmtN(data.net)}`, tag: 'slip' });
    }
    else if (type === 'close_diff') {
      const d = +data.diff || 0;
      if (d !== 0) await send(admins, 'adm_close_diff', {
        title: `💸 ${BRANCHES[+data.branch] || ''} ปิดร้าน${d > 0 ? 'เกิน' : 'ขาด'} ฿${fmtN(d)}`,
        body: `โดย ${data.by || name} · แตะเพื่อเปิดแอปตรวจ`, tag: 'closediff'
      }, { urgent: true });
    }
    else if (type === 'edit_request') {
      await send(admins, 'adm_requests', { title: '✏️ คำขอแก้ยอดขายใหม่', body: `${name} ขอแก้ยอด ${BRANCHES[+data.branch] || ''} วันที่ ${data.date || ''}`, tag: 'reqs' });
    }
    else if (type === 'leave_request') {
      await send(admins, 'adm_requests', { title: '🌴 คำขอลาใหม่', body: `${name} ขอลา ${data.from || ''}${data.to && data.to !== data.from ? ' ถึง ' + data.to : ''}`, tag: 'reqs' });
    }
    else if (type === 'swap_request') {
      // ส่งคำขอสลับ/ฝากเวร → เด้งหาเพื่อนที่ถูกขอ
      const to = members.find(m => m._id === data.toUid);
      if (to) await send([to], 'swap', {
        title: `🔄 ${name} ขอ${data.kind === 'give' ? 'ฝากเวรให้คุณ' : 'สลับเวรกับคุณ'}`,
        body: `เวรวันที่ ${data.date || ''} — เปิดแอปกดรับ/ปฏิเสธได้ที่หน้าแรก`, tag: 'swap'
      });
    }
    else if (type === 'swap_peer') {
      // เพื่อนกดรับ/ปฏิเสธ → เด้งหาคนขอ + (ถ้ารับ) เด้งหาแอดมินให้มาอนุมัติ
      const from = members.find(m => m._id === data.fromUid);
      if (data.ok) {
        if (from) await send([from], 'swap', { title: '🔄 เพื่อนรับคำขอเวรของคุณแล้ว', body: `${name} กดรับแล้ว — รอแอดมินอนุมัติ ตารางจะอัปเดตเอง`, tag: 'swap' });
        await send(admins, 'adm_requests', { title: '🔄 คำขอสลับ/ฝากเวรรออนุมัติ', body: `${data.fromName || ''} → ${name} · เปิดแอปกดอนุมัติได้เลย`, tag: 'reqs' });
      } else {
        if (from) await send([from], 'swap', { title: 'คำขอเวรถูกปฏิเสธ', body: `${name} ไม่สะดวกรับเวรนี้ — ลองขอคนอื่น หรือแจ้งแอดมิน`, tag: 'swap' });
      }
    }
    else if (type === 'swap_result') {
      if (!isAdm) return new Response('forbidden', { status: 403, headers: CORS });
      const list = members.filter(m => m._id === data.fromUid || m._id === data.toUid);
      await send(list, 'swap', {
        title: data.ok ? '✅ สลับ/ฝากเวรได้รับอนุมัติ' : 'คำขอสลับเวรไม่ได้รับอนุมัติ',
        body: data.ok ? `ตารางเวรวันที่ ${data.date || ''} อัปเดตแล้ว — เช็คเวรใหม่ของคุณได้เลย` : 'แอดมินไม่อนุมัติรอบนี้ — สอบถามแอดมินได้เลย', tag: 'swap'
      });
    }
    else if (type === 'js_error') {
      // จำกัดวันละ 1 ข้อความ กันสแปม
      if (await claimOnce('jserr_' + bkkDate(), tok)) {
        await send(admins, 'adm_sys', { title: '🐞 แอปเกิดข้อผิดพลาด', body: String(data.msg || '').slice(0, 120), tag: 'sys' });
      }
    }
    else return new Response('unknown type', { status: 400, headers: CORS });

    return new Response(JSON.stringify({ ok: true, sent }), { status: 200, headers: { 'content-type': 'application/json', ...CORS } });
  } catch (e) {
    return new Response('error: ' + (e && e.message || e), { status: 500, headers: CORS });
  }
}

// ===================================================================
// 🔔 Cron ทุก 10 นาที — ตัวส่งแบบ "ตามเวลา" (ตั้งรอบใน wrangler.toml [triggers])
// เตือนก่อนเวร · เลยเวลาเปิด/ปิดร้าน · รอบนับเงินสำรอง · บรีฟค่ำ 21:00 · เงินผิดปกติ 9:00 · เตือนสำรองข้อมูล
// ทุกข้อความมีตัวกันส่งซ้ำ (notifSent) — รันกี่รอบก็ส่งเรื่องเดิมแค่ครั้งเดียว
// ===================================================================
async function runCron(env) {
  const tok = await accessToken(env);
  const now = bkk();
  const today = bkkDate(now);
  const nowMin = bkkMin(now);
  const B = BRANCHES;
  const fmtN = n => Math.round(Math.abs(+n || 0)).toLocaleString('en-US');
  const out = []; // บันทึกว่ารอบนี้ส่งอะไรไปบ้าง (ดูได้ใน log ของ Cloudflare)

  // ---- โหลดข้อมูลที่ใช้ร่วมกัน ----
  const members = (await fsList('members', tok)).filter(m => (m.status || 'active') !== 'inactive');
  const admins = members.filter(m => m.role === 'admin');
  const byUid = {}; members.forEach(m => { byUid[m._id] = m; });

  const schedDoc = await fsGet('schedules/' + today.slice(0, 7), tok);
  const shiftsToday = ((schedDoc && schedDoc.shifts) || []).filter(s => s && s.date === today);
  const checkins = await fsQueryEq('checkins', [['date', today]], tok);
  const checkedIn = uid => checkins.some(c => c.uid === uid && c.checkIn && !c.isTesterCheckin);
  const checkedInAt = b => checkins.filter(c => c.checkIn && !c.isTesterCheckin && +c.branchIn === +b).map(c => byUid[c.uid]).filter(Boolean).filter(m => m.role !== 'tester');
  const staffAt = b => { const u = new Set(shiftsToday.filter(s => +s.branch === +b && s.staffId).map(s => s.staffId)); return [...u].map(id => byUid[id]).filter(Boolean).filter(m => m.role !== 'tester'); };
  const recipientsAt = b => { const c = checkedInAt(b); return c.length ? c : staffAt(b); };

  const cashStates = await fsList('cashState', tok);
  const stOf = b => cashStates.find(d => d._id === String(b)) || {};
  const evToday = await fsQueryEq('cashEvents', [['date', today]], tok);
  const cashCfg = (await fsGet('config/cashSettings', tok)) || {};
  const alertCfg = (await fsGet('config/alertSettings', tok)) || {};

  const send = async (list, topic, note, opts) => { let n = 0; for (const m of list) n += await sendToMember(m, topic, note, tok, opts); if (n) out.push(topic + ':' + n); };

  // ---- (1) ก่อนเวรเริ่ม 30 นาที — เตือนเช็คอิน ----
  for (const s of shiftsToday) {
    if (!s.staffId || !s.start) continue;
    const st = hm(s.start); if (st == null) continue;
    if (nowMin >= st - 30 && nowMin < st && !checkedIn(s.staffId)) {
      const m = byUid[s.staffId];
      if (m && m.role !== 'tester' && await claimOnce(`pre_${s.staffId}_${today}`, tok)) {
        await send([m], 'shift_pre', { title: `⏰ อีกไม่เกิน 30 นาทีถึงเวรคุณ`, body: `เวร ${s.start}–${s.end || ''} ที่${B[+s.branch] || ''} — อย่าลืมเช็คอินนะ`, tag: 'shift' });
      }
    }
  }

  // ---- ต่อสาขา: เปิดสาย / ยังไม่ปิดร้าน / รอบนับสำรอง ----
  for (let b = 0; b < B.length; b++) {
    const bShifts = shiftsToday.filter(s => +s.branch === +b);
    if (!bShifts.length) continue; // วันนี้สาขานี้ไม่มีเวร = ร้านปิด ไม่ต้องเตือน
    const starts = bShifts.map(s => hm(s.start)).filter(v => v != null);
    const ends = bShifts.map(s => hm(s.end)).filter(v => v != null);
    const minStart = starts.length ? Math.min(...starts) : null;
    const maxEnd = ends.length ? Math.max(...ends) : null;
    const opened = stOf(b).openDate === today;
    const closed = evToday.some(e => +e.branch === +b && e.type === 'close');

    // (2) เลยเวลาเปิด 15 นาทีแล้วยังไม่เปิดร้าน
    if (minStart != null && !opened && nowMin >= minStart + 15 && nowMin < minStart + 180) {
      if (await claimOnce(`open_${b}_${today}`, tok)) {
        await send(recipientsAt(b), 'open_late', { title: `☀️ ${B[b]}ยังไม่ได้กดเปิดร้าน`, body: 'เลยเวลาเวรเช้ามา 15 นาทีแล้ว — เปิดแอปกดยืนยันเปิดร้านหน่อยนะ', tag: 'open' });
      }
    }
    // (3) หมดเวรแล้วยังไม่ปิดร้าน → เตือนพนักงานก่อน แล้วค่อยแจ้ง admin
    if (maxEnd != null && opened && !closed) {
      if (nowMin >= maxEnd + 15 && await claimOnce(`closef_${b}_${today}`, tok)) {
        await send(recipientsAt(b), 'close_forgot', { title: `🌙 ${B[b]}ยังไม่ได้ปิดร้าน`, body: 'หมดเวรแล้ว — ลงยอดขาย แล้วกดปิดร้านให้เรียบร้อยนะ', tag: 'close' }, { urgent: true });
      }
      if (nowMin >= maxEnd + 40 && await claimOnce(`closea_${b}_${today}`, tok)) {
        await send(admins, 'adm_not_closed', { title: `🚨 ${B[b]}เลยเวลาปิดร้านมา 40 นาที`, body: 'ยังไม่มีการลงยอด/ปิดร้านในระบบ — ลองเช็คหน้าร้านดูครับ', tag: 'close' }, { urgent: true });
      }
    }
    // (4) รอบนับเงินสำรองประจำสัปดาห์ (ช่วง 10:00–14:00 ของวันนับ)
    const rcDay = cashCfg.reserveCountDay == null ? 1 : +cashCfg.reserveCountDay;
    const skip = cashCfg.reserveCountSkipUntil && today < cashCfg.reserveCountSkipUntil;
    if (bkkDow(now) === rcDay && !skip && nowMin >= 600 && nowMin < 840) {
      const counted = evToday.some(e => +e.branch === +b && e.type === 'reservecount');
      if (!counted && opened && await claimOnce(`rc_${b}_${today}`, tok)) {
        await send(recipientsAt(b), 'reservecount', { title: `🪙 วันนี้รอบนับเงินสำรอง${B[b]}`, body: 'นับแยกแบงค์/เหรียญในแอป ระบบเทียบกับยอดในระบบให้อัตโนมัติ', tag: 'rc' });
      }
    }
  }

  // ---- (5) บรีฟค่ำถึง admin ~21:00 ----
  if (nowMin >= 1260 && nowMin < 1350 && await claimOnce(`brief_${today}`, tok)) {
    let total = 0, cash = 0; const perB = [];
    for (let b = 0; b < B.length; b++) {
      const sd = await fsGet(`sales/${today}_${b}`, tok);
      if (sd) { total += +sd.total || 0; cash += +((sd.amounts || {})['เงินสด']) || 0; }
      const cev = evToday.filter(e => +e.branch === +b && e.type === 'close').sort((a, c) => (c.ts || 0) - (a.ts || 0))[0];
      perB.push(`${BSHORT[b]} ${cev ? (Math.abs(+cev.diff || 0) < 0.01 ? '✓ตรง' : ((+cev.diff > 0 ? 'เกิน' : 'ขาด') + fmtN(cev.diff))) : (sd ? 'ยังไม่ปิด' : '—')}`);
    }
    const dep = evToday.filter(e => e.type === 'deposit').reduce((a, e) => a + (+e.amount || 0), 0);
    await send(admins, 'adm_brief', { title: `🌙 บรีฟค่ำ · ขายวันนี้ ฿${fmtN(total)}`, body: `เงินสด ฿${fmtN(cash)} · เข้าเซฟ ฿${fmtN(dep)} · ${perB.join(' · ')}`, tag: 'brief' });
  }

  // ---- (6) เงินผิดปกติ + (7) เตือนสำรองข้อมูล — เช้า ~9:00 ----
  if (nowMin >= 540 && nowMin < 630) {
    const issues = [];
    const thr = +alertCfg.safeThreshold || 0, rmin = +cashCfg.reserveMin || 0, ftg = +cashCfg.floatTarget || 0;
    for (let b = 0; b < B.length; b++) {
      const st = stOf(b);
      if (thr > 0 && +st.safe > thr) issues.push(`เซฟ${BSHORT[b]} ฿${fmtN(st.safe)} เกินเกณฑ์`);
      if (rmin > 0 && st.reserve != null && +st.reserve < rmin) issues.push(`สำรอง${BSHORT[b]}เหลือ ฿${fmtN(st.reserve)}`);
      const base = st.openDate === today ? (+st.openDrawer || 0) + evToday.filter(e => +e.branch === +b && e.type === 'r2d').reduce((a, e) => a + (+e.amount || 0), 0) : (+st.drawer || 0);
      if (ftg > 0 && base > 0 && base < ftg - 0.01) issues.push(`ลิ้นชัก${BSHORT[b]}ขาด ฿${fmtN(ftg - base)}`);
    }
    if (issues.length && await claimOnce(`money_${today}`, tok)) {
      await send(admins, 'adm_money', { title: `🧰 เช็คเงินหน่อย — ${issues.length} เรื่อง`, body: issues.slice(0, 3).join(' · ') + (issues.length > 3 ? ` และอีก ${issues.length - 3} เรื่อง` : ''), tag: 'money' });
    }
    const bk = await fsGet('config/backupInfo', tok);
    const days = bk && bk.lastAt ? Math.floor((Date.now() - new Date(bk.lastAt).getTime()) / 86400000) : null;
    if (days == null || days >= 30) {
      const wk = today.slice(0, 8) + String(Math.ceil(+today.slice(8) / 7)); // กันซ้ำรายสัปดาห์แบบหยาบ
      if (await claimOnce(`backup_${wk}`, tok)) {
        await send(admins, 'adm_sys', { title: '💾 ถึงรอบสำรองข้อมูลร้านแล้ว', body: days == null ? 'ยังไม่เคยสำรองข้อมูลเลย — เปิดแอป กดปุ่มสำรองในบัญชีของฉัน' : `ไม่ได้สำรองมา ${days} วันแล้ว — กดปุ่มเดียวในแอปเสร็จเลย`, tag: 'sys' });
      }
    }
  }

  console.log('notify-cron', today, nowMin, JSON.stringify(out));
  return out;
}

// ===================================================================
// ตัวหลัก: เสิร์ฟไฟล์ + /juristic + /notify + cron
// ===================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') return handleNotify(request, env);
    if (url.pathname !== '/juristic') return env.ASSETS.fetch(request);

    // ===== /juristic = ค้นหาข้อมูลผู้เสียภาษี/นิติบุคคล ให้ฟอร์มเอกสารการค้า =====
    //   แหล่งหลัก: ระบบตรวจผู้ประกอบการ VAT กรมสรรพากร (ครอบคลุมทุกรายที่จด VAT — ตรงกับงานใบกำกับภาษี)
    //   แหล่งสำรอง: MOC Open Data กระทรวงพาณิชย์ (ช้า/ไม่ครบ แต่มีบ้าง)
    // คำตอบ normalize เป็น {ok:true,name,address,branch,source} หรือ {ok:false,error}
    // เติม &debug=1 ต่อท้าย URL = แสดงอาการดิบของแต่ละแหล่ง (ไว้ไล่ปัญหา)
    const debug = url.searchParams.get('debug') ? [] : null;
    const mkHeaders = (cache) => ({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // เก็บ cache เฉพาะตอนค้นเจอ — ตอนพลาด/ตอน debug ห้ามจำ ไม่งั้นแก้แล้วยังเห็นของเก่า
      'Cache-Control': (cache && !debug) ? 'public, max-age=86400' : 'no-store'
    });
    const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
    if (id.length !== 13) {
      return new Response(JSON.stringify({ ok: false, error: 'ต้องเป็นเลข 13 หลัก' }), { status: 400, headers: mkHeaders(false) });
    }

    const fetchT = (u, opt, ms) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), ms);
      return fetch(u, { ...opt, signal: ac.signal }).finally(() => clearTimeout(t));
    };
    // ดึงค่าในแท็ก XML (ตัดแท็กลูก เช่น <anyType> ออก) · '-' = ว่าง
    const tag = (xml, name) => {
      const m = xml.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
      if (!m) return '';
      const v = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return v === '-' ? '' : v;
    };
    const fail = (msg) => new Response(JSON.stringify(
      debug ? { ok: false, error: msg, debug } : { ok: false, error: msg }
    ), { status: 200, headers: mkHeaders(false) });

    // ===== 1) กรมสรรพากร (VAT) =====
    // เซิร์ฟเวอร์ .NET ของกรมฯ เลือกงานตาม SOAPAction ที่ต้องตรงเป๊ะกับ namespace ของระบบ
    // ลองทีละ namespace ที่เป็นไปได้ จนกว่าจะเจอตัวที่เซิร์ฟเวอร์รู้จัก
    const NSS = [
      'https://rdws.rd.go.th/serviceRD3/vatserviceRD3',
      'https://rdws.rd.go.th/JserviceRD3/vatserviceRD3',
      'https://rdws.rd.go.th/VATService',
      'http://tempuri.org'
    ];
    for (const ns of NSS) {
      try {
        const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Service xmlns="${ns}">
      <username>anonymous</username>
      <password>anonymous</password>
      <TIN>${id}</TIN>
      <Name></Name>
      <ProvinceCode>0</ProvinceCode>
      <BranchNumber>0</BranchNumber>
      <AmphurCode>0</AmphurCode>
    </Service>
  </soap:Body>
</soap:Envelope>`;
        const r = await fetchT('https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx', {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"' + ns + '/Service"' },
          body: soap
        }, 12000);
        const xml = await r.text();
        if (debug) debug.push('RD ns=' + ns + ' HTTP ' + r.status + ' → ' + xml.slice(0, 500));
        if (/did not recognize/i.test(xml)) continue; // SOAPAction ไม่ตรง → ลอง namespace ถัดไป
        const err = tag(xml, 'vmsgerr');
        const vName = tag(xml, 'vName');
        if (vName && !err) {
          const name = (tag(xml, 'vtitleName') + ' ' + vName + ' ' + tag(xml, 'vSurname')).replace(/\s+/g, ' ').trim();
          const parts = [];
          const add = (label, v) => { if (v) parts.push(label ? label + v : v); };
          add('', tag(xml, 'vBuildingName'));
          add('ห้อง ', tag(xml, 'vRoomNumber'));
          add('ชั้น ', tag(xml, 'vFloorNumber'));
          add('', tag(xml, 'vVillageName'));
          add('เลขที่ ', tag(xml, 'vHouseNumber'));
          add('หมู่ ', tag(xml, 'vMooNumber'));
          add('ซ.', tag(xml, 'vSoiName'));
          add('ถ.', tag(xml, 'vStreetName'));
          add('ต.', tag(xml, 'vThambol'));
          add('อ.', tag(xml, 'vAmphur'));
          add('จ.', tag(xml, 'vProvince'));
          add('', tag(xml, 'vPostCode'));
          const brNo = tag(xml, 'vBranchNumber');
          const branch = (!brNo || brNo === '0' || /สำนักงานใหญ่/.test(tag(xml, 'vBranchTitleName'))) ? 'สำนักงานใหญ่' : ('สาขา ' + brNo);
          const body = { ok: true, name, address: parts.join(' '), branch, source: 'กรมสรรพากร (ผู้ประกอบการ VAT)' };
          if (debug) body.debug = debug;
          return new Response(JSON.stringify(body), { status: 200, headers: mkHeaders(true) });
        }
        break; // เซิร์ฟเวอร์รู้จักคำสั่งแล้ว (แต่ไม่พบชื่อ/แจ้ง error) → ไม่ต้องลอง namespace อื่น
      } catch (e) {
        if (debug) debug.push('RD ns=' + ns + ' ผิดพลาด: ' + String(e));
      }
    }

    // ===== 2) สำรอง: MOC Open Data =====
    try {
      const r = await fetchT('https://dataapi.moc.go.th/juristic?juristic_id=' + id, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'maipharmacy-app' }
      }, 8000);
      const text = await r.text();
      if (debug) debug.push('MOC HTTP ' + r.status + ' → ' + text.slice(0, 400));
      const j = JSON.parse(text);
      const d = (Array.isArray(j) ? j[0] : (j && (j.data && j.data[0] || j.data) || j)) || {};
      const name = d.juristicNameTH || d.juristic_name_th || d.name || '';
      if (name) {
        const a = d.addressInfo || d.address || {};
        const addr = typeof a === 'string' ? a : [a.houseNumber, a.villageName, a.soi, a.street,
          a.subDistrict && 'ต.' + a.subDistrict, a.district && 'อ.' + a.district,
          a.province && 'จ.' + a.province, a.zipcode].filter(Boolean).join(' ');
        const body = { ok: true, name, address: addr, branch: 'สำนักงานใหญ่', source: 'กระทรวงพาณิชย์' };
        if (debug) body.debug = debug;
        return new Response(JSON.stringify(body), { status: 200, headers: mkHeaders(true) });
      }
    } catch (e) {
      if (debug) debug.push('MOC ผิดพลาด: ' + String(e));
    }

    return fail('ไม่พบเลขนี้ในฐานผู้ประกอบการ VAT (กรมสรรพากร) และฐานกระทรวงพาณิชย์ — กรอกชื่อ/ที่อยู่เองได้เลย');
  },

  // Cloudflare เรียกเองทุก 10 นาที (ตั้งรอบใน wrangler.toml → [triggers])
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch(e => console.log('notify-cron error: ' + (e && e.message || e))));
  }
};
