// ===== ตัวส่งแจ้งเตือนแบบ "ตามเวลา" — Netlify เรียกเองทุก 10 นาที (ตั้งใน exports.config ล่างสุด) =====
// เตือนก่อนเวร · เลยเวลาเปิด/ปิดร้าน · รอบนับเงินสำรอง · บรีฟค่ำ 21:00 · เงินผิดปกติ 9:00 · เตือนสำรองข้อมูล
// ทุกข้อความมีตัวกันส่งซ้ำ (notifSent) — รันกี่รอบก็ส่งเรื่องเดิมแค่ครั้งเดียว
const fb = require('./lib/fb.js');

exports.handler = async () => {
  try {
    const tok = await fb.accessToken();
    const now = fb.bkk();
    const today = fb.bkkDate(now);
    const nowMin = fb.bkkMin(now);
    const B = fb.BRANCHES;
    const fmtN = n => Math.round(Math.abs(+n || 0)).toLocaleString('en-US');
    const out = []; // บันทึกว่ารอบนี้ส่งอะไรไปบ้าง (ดูได้ใน Netlify log)

    // ---- โหลดข้อมูลที่ใช้ร่วมกัน ----
    const members = (await fb.fsList('members', tok)).filter(m => (m.status || 'active') !== 'inactive');
    const admins = members.filter(m => m.role === 'admin');
    const byUid = {}; members.forEach(m => { byUid[m._id] = m; });

    const schedDoc = await fb.fsGet('schedules/' + today.slice(0, 7), tok);
    const shiftsToday = ((schedDoc && schedDoc.shifts) || []).filter(s => s && s.date === today);
    const checkins = await fb.fsQueryEq('checkins', [['date', today]], tok);
    const checkedIn = uid => checkins.some(c => c.uid === uid && c.checkIn && !c.isTesterCheckin);
    const checkedInAt = b => checkins.filter(c => c.checkIn && !c.isTesterCheckin && +c.branchIn === +b).map(c => byUid[c.uid]).filter(Boolean).filter(m => m.role !== 'tester');
    const staffAt = b => { const u = new Set(shiftsToday.filter(s => +s.branch === +b && s.staffId).map(s => s.staffId)); return [...u].map(id => byUid[id]).filter(Boolean).filter(m => m.role !== 'tester'); };
    const recipientsAt = b => { const c = checkedInAt(b); return c.length ? c : staffAt(b); };

    const cashStates = await fb.fsList('cashState', tok);
    const stOf = b => cashStates.find(d => d._id === String(b)) || {};
    const evToday = await fb.fsQueryEq('cashEvents', [['date', today]], tok);
    const cashCfg = (await fb.fsGet('config/cashSettings', tok)) || {};
    const alertCfg = (await fb.fsGet('config/alertSettings', tok)) || {};

    const send = async (list, topic, note, opts) => { let n = 0; for (const m of list) n += await fb.sendToMember(m, topic, note, tok, opts); if (n) out.push(topic + ':' + n); };

    // ---- (1) ก่อนเวรเริ่ม 30 นาที — เตือนเช็คอิน ----
    for (const s of shiftsToday) {
      if (!s.staffId || !s.start) continue;
      const st = fb.hm(s.start); if (st == null) continue;
      if (nowMin >= st - 30 && nowMin < st && !checkedIn(s.staffId)) {
        const m = byUid[s.staffId];
        if (m && m.role !== 'tester' && await fb.claimOnce(`pre_${s.staffId}_${today}`, tok)) {
          await send([m], 'shift_pre', { title: `⏰ อีกไม่เกิน 30 นาทีถึงเวรคุณ`, body: `เวร ${s.start}–${s.end || ''} ที่${B[+s.branch] || ''} — อย่าลืมเช็คอินนะ`, tag: 'shift' });
        }
      }
    }

    // ---- ต่อสาขา: เปิดสาย / ยังไม่ปิดร้าน / รอบนับสำรอง ----
    for (let b = 0; b < B.length; b++) {
      const bShifts = shiftsToday.filter(s => +s.branch === +b);
      if (!bShifts.length) continue; // วันนี้สาขานี้ไม่มีเวร = ร้านปิด ไม่ต้องเตือน
      const starts = bShifts.map(s => fb.hm(s.start)).filter(v => v != null);
      const ends = bShifts.map(s => fb.hm(s.end)).filter(v => v != null);
      const minStart = starts.length ? Math.min(...starts) : null;
      const maxEnd = ends.length ? Math.max(...ends) : null;
      const opened = stOf(b).openDate === today;
      const closed = evToday.some(e => +e.branch === +b && e.type === 'close');

      // (2) เลยเวลาเปิด 15 นาทีแล้วยังไม่เปิดร้าน
      if (minStart != null && !opened && nowMin >= minStart + 15 && nowMin < minStart + 180) {
        if (await fb.claimOnce(`open_${b}_${today}`, tok)) {
          await send(recipientsAt(b), 'open_late', { title: `☀️ ${B[b]}ยังไม่ได้กดเปิดร้าน`, body: 'เลยเวลาเวรเช้ามา 15 นาทีแล้ว — เปิดแอปกดยืนยันเปิดร้านหน่อยนะ', tag: 'open' });
        }
      }
      // (3) หมดเวรแล้วยังไม่ปิดร้าน → เตือนพนักงานก่อน แล้วค่อยแจ้ง admin
      if (maxEnd != null && opened && !closed) {
        if (nowMin >= maxEnd + 15 && await fb.claimOnce(`closef_${b}_${today}`, tok)) {
          await send(recipientsAt(b), 'close_forgot', { title: `🌙 ${B[b]}ยังไม่ได้ปิดร้าน`, body: 'หมดเวรแล้ว — ลงยอดขาย แล้วกดปิดร้านให้เรียบร้อยนะ', tag: 'close' }, { urgent: true });
        }
        if (nowMin >= maxEnd + 40 && await fb.claimOnce(`closea_${b}_${today}`, tok)) {
          await send(admins, 'adm_not_closed', { title: `🚨 ${B[b]}เลยเวลาปิดร้านมา 40 นาที`, body: 'ยังไม่มีการลงยอด/ปิดร้านในระบบ — ลองเช็คหน้าร้านดูครับ', tag: 'close' }, { urgent: true });
        }
      }
      // (4) รอบนับเงินสำรองประจำสัปดาห์ (ช่วง 10:00–14:00 ของวันนับ)
      const rcDay = cashCfg.reserveCountDay == null ? 1 : +cashCfg.reserveCountDay;
      const skip = cashCfg.reserveCountSkipUntil && today < cashCfg.reserveCountSkipUntil;
      if (fb.bkkDow(now) === rcDay && !skip && nowMin >= 600 && nowMin < 840) {
        const counted = evToday.some(e => +e.branch === +b && e.type === 'reservecount');
        if (!counted && opened && await fb.claimOnce(`rc_${b}_${today}`, tok)) {
          await send(recipientsAt(b), 'reservecount', { title: `🪙 วันนี้รอบนับเงินสำรอง${B[b]}`, body: 'นับแยกแบงค์/เหรียญในแอป ระบบเทียบกับยอดในระบบให้อัตโนมัติ', tag: 'rc' });
        }
      }
    }

    // ---- (5) บรีฟค่ำถึง admin ~21:00 ----
    if (nowMin >= 1260 && nowMin < 1350 && await fb.claimOnce(`brief_${today}`, tok)) {
      let total = 0, cash = 0; const perB = [];
      for (let b = 0; b < B.length; b++) {
        const sd = await fb.fsGet(`sales/${today}_${b}`, tok);
        if (sd) { total += +sd.total || 0; cash += +((sd.amounts || {})['เงินสด']) || 0; }
        const cev = evToday.filter(e => +e.branch === +b && e.type === 'close').sort((a, c) => (c.ts || 0) - (a.ts || 0))[0];
        perB.push(`${['ทรัพย์', 'บางปู', 'อินดี้'][b]} ${cev ? (Math.abs(+cev.diff || 0) < 0.01 ? '✓ตรง' : ((+cev.diff > 0 ? 'เกิน' : 'ขาด') + fmtN(cev.diff))) : (sd ? 'ยังไม่ปิด' : '—')}`);
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
        if (thr > 0 && +st.safe > thr) issues.push(`เซฟ${['ทรัพย์', 'บางปู', 'อินดี้'][b]} ฿${fmtN(st.safe)} เกินเกณฑ์`);
        if (rmin > 0 && st.reserve != null && +st.reserve < rmin) issues.push(`สำรอง${['ทรัพย์', 'บางปู', 'อินดี้'][b]}เหลือ ฿${fmtN(st.reserve)}`);
        const base = st.openDate === today ? (+st.openDrawer || 0) + evToday.filter(e => +e.branch === +b && e.type === 'r2d').reduce((a, e) => a + (+e.amount || 0), 0) : (+st.drawer || 0);
        if (ftg > 0 && base > 0 && base < ftg - 0.01) issues.push(`ลิ้นชัก${['ทรัพย์', 'บางปู', 'อินดี้'][b]}ขาด ฿${fmtN(ftg - base)}`);
      }
      if (issues.length && await fb.claimOnce(`money_${today}`, tok)) {
        await send(admins, 'adm_money', { title: `🧰 เช็คเงินหน่อย — ${issues.length} เรื่อง`, body: issues.slice(0, 3).join(' · ') + (issues.length > 3 ? ` และอีก ${issues.length - 3} เรื่อง` : ''), tag: 'money' });
      }
      const bk = await fb.fsGet('config/backupInfo', tok);
      const days = bk && bk.lastAt ? Math.floor((Date.now() - new Date(bk.lastAt).getTime()) / 86400000) : null;
      if (days == null || days >= 30) {
        const wk = today.slice(0, 8) + String(Math.ceil(+today.slice(8) / 7)); // กันซ้ำรายสัปดาห์แบบหยาบ
        if (await fb.claimOnce(`backup_${wk}`, tok)) {
          await send(admins, 'adm_sys', { title: '💾 ถึงรอบสำรองข้อมูลร้านแล้ว', body: days == null ? 'ยังไม่เคยสำรองข้อมูลเลย — เปิดแอป กดปุ่มสำรองในบัญชีของฉัน' : `ไม่ได้สำรองมา ${days} วันแล้ว — กดปุ่มเดียวในแอปเสร็จเลย`, tag: 'sys' });
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, at: today + ' ' + Math.floor(nowMin / 60) + ':' + String(nowMin % 60).padStart(2, '0'), sent: out }) };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + (e && e.message || e) };
  }
};

// ให้ Netlify เรียกฟังก์ชันนี้เองทุก 10 นาที
exports.config = { schedule: '*/10 * * * *' };
