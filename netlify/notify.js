// ===== ตัวส่งแจ้งเตือนแบบ "เกิดเหตุแล้วเด้ง" — แอปเรียกมาที่นี่พร้อม ID token ของผู้ใช้ =====
// ประเภท: test, announce, leave_result, slip, close_diff, edit_request, leave_request, js_error
const fb = require('./lib/fb.js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  try {
    const idToken = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer /, '');
    const user = await fb.verifyIdToken(idToken);
    if (!user) return { statusCode: 401, body: 'unauthorized' };

    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch (e) { }
    const type = payload.type, data = payload.data || {};

    const tok = await fb.accessToken();
    const members = await fb.fsList('members', tok);
    const me = members.find(m => m._id === user.uid);
    if (!me) return { statusCode: 403, body: 'no member' };
    const admins = members.filter(m => m.role === 'admin' && (m.status || 'active') !== 'inactive');
    const isAdm = me.role === 'admin';
    const name = me.nickname || me.firstName || 'พนักงาน';
    const B = fb.BRANCHES;
    const fmtN = n => Math.round(Math.abs(+n || 0)).toLocaleString('en-US');

    let sent = 0;
    const send = async (list, topic, note, opts) => { for (const m of list) sent += await fb.sendToMember(m, topic, note, tok, opts); };

    if (type === 'test') {
      // ปุ่ม "ทดสอบส่งหาฉัน" — ข้ามทุกเงื่อนไข ส่งถึงตัวเองทันที
      sent += await fb.sendToMember(me, 'test', { title: '🔔 ทดสอบแจ้งเตือน — ใหม่เภสัช', body: 'ทำงานเรียบร้อย! เครื่องนี้จะได้รับแจ้งเตือนจากร้าน', tag: 'test' }, tok, { force: true });
    }
    else if (type === 'announce') {
      if (!isAdm && (me.permissions || {}).announce !== true) return { statusCode: 403, body: 'forbidden' };
      const text = String(data.text || '').slice(0, 140);
      if (text) await send(members.filter(m => m._id !== me._id), 'announce', { title: '📢 ประกาศจากร้าน', body: text, tag: 'announce' });
    }
    else if (type === 'leave_result') {
      if (!isAdm) return { statusCode: 403, body: 'forbidden' };
      const to = members.find(m => m._id === data.uid);
      if (to) await send([to], 'leave_result', {
        title: data.ok ? '🌴 คำขอลาได้รับอนุมัติ' : 'คำขอลาไม่ได้รับอนุมัติ',
        body: `ช่วงวันที่ ${data.from || ''}${data.to && data.to !== data.from ? ' ถึง ' + data.to : ''}`, tag: 'leave'
      });
    }
    else if (type === 'slip') {
      if (!isAdm) return { statusCode: 403, body: 'forbidden' };
      const to = members.find(m => m._id === data.uid);
      if (to) await send([to], 'slip', { title: '🧾 สลิปเงินเดือนออกแล้ว', body: `งวด${data.month || ''} · ยอดสุทธิ ฿${fmtN(data.net)}`, tag: 'slip' });
    }
    else if (type === 'close_diff') {
      const d = +data.diff || 0;
      if (d !== 0) await send(admins, 'adm_close_diff', {
        title: `💸 ${B[+data.branch] || ''} ปิดร้าน${d > 0 ? 'เกิน' : 'ขาด'} ฿${fmtN(d)}`,
        body: `โดย ${data.by || name} · แตะเพื่อเปิดแอปตรวจ`, tag: 'closediff'
      }, { urgent: true });
    }
    else if (type === 'edit_request') {
      await send(admins, 'adm_requests', { title: '✏️ คำขอแก้ยอดขายใหม่', body: `${name} ขอแก้ยอด ${B[+data.branch] || ''} วันที่ ${data.date || ''}`, tag: 'reqs' });
    }
    else if (type === 'leave_request') {
      await send(admins, 'adm_requests', { title: '🌴 คำขอลาใหม่', body: `${name} ขอลา ${data.from || ''}${data.to && data.to !== data.from ? ' ถึง ' + data.to : ''}`, tag: 'reqs' });
    }
    else if (type === 'js_error') {
      // จำกัดวันละ 1 ข้อความ กันสแปม
      if (await fb.claimOnce('jserr_' + fb.bkkDate(), tok)) {
        await send(admins, 'adm_sys', { title: '🐞 แอปเกิดข้อผิดพลาด', body: String(data.msg || '').slice(0, 120), tag: 'sys' });
      }
    }
    else return { statusCode: 400, body: 'unknown type' };

    return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + (e && e.message || e) };
  }
};
