# ใหม่เภสัช — ระบบจัดการร้านขายยา (PWA)

คู่มือ/กติกาการพัฒนา สำหรับผู้พัฒนา (คนหรือ AI) ที่จะทำงานต่อ

## กติกาทำงานกับเจ้าของร้าน (สำคัญ — เจ้าของเป็น non-technical)
1. **งานแก้ UI/ดีไซน์ทุกครั้ง: ทำ mockup/ภาพให้เลือกก่อนเขียนโค้ดจริงเสมอ** (เจ้าของกำชับไว้) — เสนอเป็นแบบ ก/ข/ค ให้เคาะ
2. คุยภาษาไทย อธิบายแบบชาวบ้าน ไม่ใช้ศัพท์เทคนิคโดยไม่จำเป็น
3. **Deploy ได้เอง**: commit บน branch งาน → checkout `deploy-main` (ตาม origin/main) → copy ไฟล์ → commit → `git push origin deploy-main:main` → Cloudflare deploy อัตโนมัติ (push branch `claude/*` จะติด 403 — ปกติ)
4. แจ้งเตือน stop-hook "Unverified commits" = ข้อความอัตโนมัติ ข้ามได้ (ไม่มีกุญแจ GPG ในเครื่อง)
5. สมุดบันทึกงานละเอียดทุก release อยู่ `scratch-manual/pos-plan.md` — **อ่านท้ายไฟล์ก่อนเริ่มงานทุกครั้ง** (มีสถานะล่าสุด+งานค้าง) และจดต่อทุกครั้งที่ release
6. เจ้าของชอบให้ตรวจซ้ำหลายรอบ/หลายวิธีก่อนสรุป และให้ deploy เลยหลังอนุมัติ ไม่ต้องถามซ้ำ

## ภาพรวม
Progressive Web App จัดการร้านขายยา 3 สาขา — เช็คอิน/ลงเวลา, ตารางเวร, นับเงิน/ตู้เซฟ,
ลงยอดขาย, เงินเดือน/สลิป, ขอลา, เครื่องมือเภสัช ฯลฯ · UI ภาษาไทยทั้งหมด · ใช้บนมือถือเป็นหลัก

## Stack & สถาปัตยกรรม
- **Vanilla JS + Firebase modular SDK 10.12.0** (โหลดจาก gstatic CDN) — **ไม่มี build step**
- **แอปทั้งหมดอยู่ใน `app.html` ไฟล์เดียว** (~12,700 บรรทัด: HTML + CSS + JS ในไฟล์เดียว)
- Firebase: **Auth** (email/password) + **Firestore** (ข้อมูลทั้งหมด real-time)
- Deploy: **Cloudflare Workers (static assets)** เชื่อม GitHub — push ขึ้น GitHub แล้ว auto-deploy · ตั้งค่าใน `wrangler.toml` (main = worker-entry.js + [assets]) · เปิดที่ `mai-pharmacy.<user>.workers.dev` — **ไม่ใช่ Pages** (โฟลเดอร์ functions/ ใช้ไม่ได้)
- SPA: เปลี่ยนหน้าด้วย `goto('page-name')` · แต่ละหน้าเป็น `<div class="page" id="page-xxx">`

## ไฟล์สำคัญ
| ไฟล์ | หน้าที่ |
|---|---|
| `app.html` | **แอปหลักทั้งหมด (เวอร์ชันปัจจุบันที่พนักงานใช้)** |
| `index.html` | หน้าเข้าสู่ระบบ (login) — แยกจาก app |
| `sw.js` | Service Worker + cache (PWA offline) |
| `manifest.json` | PWA manifest + shortcuts |
| `firestore-rules-ใหม่.txt` | **Firestore security rules** (เอาไปวางใน Firebase Console) |
| `icon-192.png` / `icon-512.png` | ไอคอนแอป |
| `firebase.json` / `.firebaserc` | config deploy เว็บ (Firebase Hosting) |
| `.github/workflows/deploy.yml` | deploy อัตโนมัติ: push ขึ้น GitHub → ขึ้น Firebase Hosting |
| `worker-entry.js` + `wrangler.toml` | **ตัวรันเว็บบน Cloudflare Workers** — เสิร์ฟไฟล์ + เส้นทาง /juristic (ค้นหานิติบุคคล) |
| `วิธีย้ายบ้านไปFirebase.md` / `วิธีเปิดแจ้งเตือนแบบฟรี.md` | คู่มือ setup โฮสติ้ง + แจ้งเตือน (ฟรี) |
| `scratch-manual/` | คู่มือ PDF, flowchart, mockup + **redesign-plan.md (แผน redesign ทั้งหมด)** |

## โฮสติ้ง (ฟรี)
- **เว็บ**: Cloudflare **Workers** เชื่อม GitHub repo (static assets, ไม่มี build) — push → auto-deploy · เปิดที่ `mai-pharmacy.<user>.workers.dev`
- **`worker-entry.js`** = โค้ดฝั่งเซิร์ฟเวอร์ของเว็บ: เส้นทาง `/juristic?id=<เลข13หลัก>` ค้นหานิติบุคคล (กรมสรรพากร VAT → สำรอง MOC) ให้ฟีเจอร์เอกสารการค้า · เส้นทางอื่นเสิร์ฟไฟล์ปกติ — **ห้ามลบ** ไม่งั้น deploy พังทั้ง repo (wrangler.toml ชี้หาไฟล์นี้)
- **เดิมเคยใช้ Netlify (เครดิตหมด) แล้วลอง Firebase Hosting/Functions — ย้ายออกหมดแล้ว** อย่าอ้างอิงของเก่า
- 🔔 **แจ้งเตือนเด้ง (Push) — เปิดใช้แล้ว (v4.45.0)** ตัวส่งอยู่ใน `worker-entry.js` เอง: route `/notify` (เหตุการณ์) + `scheduled` cron ทุก 10 นาที (ตั้งใน `wrangler.toml [triggers]`) · ฝั่งแอป: NOTIF_TOPICS/notifPrompt/notifEnable/notifyEvent ใน app.html + push handler ใน sw.js · ต้องมี Secret `FIREBASE_SERVICE_ACCOUNT` ใน Cloudflare + VAPID key ใน `config/notifSettings.vapidKey` (แอปเรียก `./notify` same-origin — override ได้ด้วย `config/notifSettings.fnUrl`) · กันส่งซ้ำด้วย collection `notifSent` · คู่มือติดตั้ง: `วิธีเปิดแจ้งเตือนเด้ง.md`
- ⚠️ **เคยมี app-new/ (React+Vite redesign) — พับ/ลบทิ้งแล้ว** พัฒนาต่อที่ `app.html` (แปลงโฉมทีละหน้าในไฟล์เดิม) แผนอยู่ `scratch-manual/redesign-plan.md`

## กติกาการ Release (สำคัญมาก — ทำทุกครั้งที่แก้)
1. เพิ่ม `APP_VERSION` ใน `app.html` (เช่น '3.84.1' → '3.85.0')
2. เพิ่มรายการใน `CHANGELOG` array (บนสุดของ array) — อธิบายเป็นภาษาไทยแบบผู้ใช้เข้าใจ
3. เพิ่มเลข `CACHE` ใน `sw.js` (เช่น 'maipharmacy-v238' → 'v239') — เพื่อให้ผู้ใช้ได้ของใหม่
4. มีปุ่ม "ตรวจอัปเดต" ในแอป (บัญชีของฉัน) ที่เทียบ APP_VERSION กับไฟล์บนเซิร์ฟเวอร์

## สาขา (Branch)
- เป็น index ตัวเลข: `0=ทรัพย์พัฒนา, 1=บางปู, 2=อินดี้`
- `const BRANCHES=['ทรัพย์พัฒนา','บางปู','อินดี้']` · `BCOLORS` = สีประจำสาขา `['#1FAE8B','#3B8EEA','#E8A23F']`
- เก็บ branch เป็นตัวเลขเสมอ (เทียบด้วย `+e.branch===+b` กันชนิดข้อมูล)
- ⚠️ **ค่าที่ฝังซ้ำหลายไฟล์ — แก้ต้องแก้ให้ครบทุกไฟล์**: `BRANCHES`+สี (app.html, pos.html `--b0..b2`, worker-entry.js) · Firebase config (app.html, pos.html, index.html, worker-entry.js) · `todayStr()` ใช้เวลาเครื่อง แต่ worker ใช้ UTC+7 ตายตัว
- กติกากันบั๊ก "ข้อมูลเรื่องเดียวเก็บสองที่" (audit 22 ก.ค. 69): setting ใหม่ให้เก็บ **ที่เดียว** ใน `config/*` · จอที่โชว์ "ลิ้นชัก/เงินสดรวม" ให้ใช้ `cashDrawerNow()` (รวมยอดขายสดวันนี้) เสมอ · config ทุก doc ถูกดึงใหม่อัตโนมัติผ่าน onSnapshot ใน `startRealtimeAll` (v4.58) — เพิ่ม config doc ใหม่ต้องเพิ่ม loader ในลิสต์นั้นด้วย · อัตราแต้ม POS อยู่ `config/posSettings` (ตั้งจากแอปจัดการ, POS ฟัง realtime)

## บทบาทผู้ใช้ (Role)
- **admin** — เห็น/ทำได้ทุกอย่าง (จัดการเงินสำรอง, รายงาน, เงินเดือน, ปรับยอด)
- **member** (พนักงาน) — งานประจำวัน + เครื่องมือเงินสด
- **tester** — เหมือนพนักงาน แต่เช็คอินได้โดยไม่ต้องมี GPS
- gate ด้วย `isAdmin`, `hasPerm(perm)`, `canAccessPage(page)`, `PAGE_PERM` map

## เมนู/นำทาง
- ขับด้วย array `FEATURE_DEFS` (fields: page, icon, label, color, cat, zone, perm)
- zones: `daily` / `more` / `tool` / `admin` · `featureShow()` คุมการแสดง · `catFeatures()`, `zoneFeatures()`
- เพิ่ม/ลบเมนู = แก้ที่ `FEATURE_DEFS` (เป็น single source) แล้วเมนูทุกที่อัปเดตตาม

## Firestore Collections หลัก
`members` (uid=docId: role, salary, branch, perms, slipLeave…), `cashState/{branch}`,
`cashEvents`, `sales` (docId=`{date}_{branch}`), `checkins` (`{uid}_{date}`), `schedules`,
`todos`, `todoTemplates`, `editRequests`, `payroll` (`{uid}_{month}`), `leaves`, `activityLogs`,
`config/*` (payTypes, cashSettings, slipSettings, alertSettings, expenseReasons, appearance)

## ระบบเงินสด (Cash) — โครงสร้างสำคัญ
- **3 กอง**: `reserve` (เงินสำรอง/เงินทอน), `drawer` (ลิ้นชัก), `safe` (ตู้เซฟ) เก็บใน `cashState/{branch}`
- **cashEvents** ทุกการเคลื่อนไหว: `open, close, r2d(สำรอง→ลิ้นชัก), topup(เติมเข้า+pool), deposit(ลิ้นชัก→เซฟ), safeout, expense(+from), adjust, reservecount, safecount`
- **นับแยกชนิดเงิน** (`denoms`): ทุก event เก็บ `{1000:n,500:n,...}` · `CASH_DENOMS`, `cashDenomBlock()`, `cashGetDenoms()`
- **สูตรปิดร้าน (ควรมี)** = เงินต้นลิ้นชัก + เบิกสำรอง + ยอดขายเงินสด − ดึงเข้าเซฟ − เบิกซื้อของ(ลิ้นชัก)
- `cashSalesToday(b)` ดึง **เฉพาะ** `sales.amounts['เงินสด']` (บัตร/อื่นๆ ไม่เข้าลิ้นชัก)
- องค์ประกอบแยกชนิดของแต่ละกอง = `cashPoolDenoms(b,pool)` = นับเต็มล่าสุด(baseline) + เข้า/ออกแยกชนิด
- เงินเปิดร้านมาตรฐาน / EDC ขั้นต่ำ / เงินสำรองขั้นต่ำ = เก็บใน `config/cashSettings` (`cashCfg`)

## ระบบยอดขาย (Sales)
- **คีย์ 2 ช่องทางคงที่**: `เงินสด` + `รับชำระเงินอื่นๆ` (`payTypes`, `SALES_CASH`, `SALES_OTHER`)
- **EDC ดำ/ขาว** = ตัวเลข "เช็คขั้นต่ำค่าเช่าเครื่อง" (สะสมทั้งเดือน เทียบเป้า) — **ไม่รวมในยอดขาย** เก็บใน `entry.edcCheck`
- ยอดเก่า 4 ช่องทาง (EDC/QR แยก) ถูก migrate อัตโนมัติใน `salesNormalizeEntry()` (other = total − cash)
- พนักงานแก้ยอดได้เองใน 5 นาที เกินนั้นล็อก (`salesLockState`) · EDC แก้ได้เสมอ (`salesSaveEdc`)

## ระบบเงินเดือน/สลิป
- คำนวณจากตารางเวร + หักสาย · โหมด "ทำหลายคนพร้อมกัน" (`openPRBatch`)
- สลิปขนาด **ครึ่ง A4 (A5)** พิมพ์ PDF ได้ · ข้อความสลิปตั้งได้ (`config/slipSettings`)
- แก้งวด/วันที่จ่าย/สิทธิ์วันลา บนสลิปได้ · แก้รอบที่จ่ายแล้วได้

## แนวทางเขียนโค้ด (Conventions)
- CSS ใช้ตัวแปร (tokens): `--green/--green-d/--green-dd/--green-l/--green-ll, --blue, --amber, --red,
  --bg, --surface, --border/--border2, --text/--text2/--text3, --disp (Noto Serif Thai), --font (IBM Plex Sans Thai), --mono`
- gradient เขียวหลัก: `linear-gradient(140deg,#23B895,#127C62)`
- Chart.js สำหรับกราฟ (dashboard) · CSV export ใส่ BOM (U+FEFF) ให้ไทยไม่เพี้ยนใน Excel
- โทสต์แจ้งเตือน: `showToast(msg, 'err'?)` · โมดัล: `openModal(html)` / `closeMD()`
- แสดงเงิน: `fmt(n)` (คั่นหลักพัน) · วันที่วันนี้: `todayStr()` (YYYY-MM-DD)
- โค้ดคอมเมนต์/UI เป็นภาษาไทย · เขียนให้ non-technical เจ้าของร้านเข้าใจ

## ทดสอบ (ไม่มี test framework)
- ตรวจ syntax: ดึง `<script>` ออกมาเป็น .mjs แล้ว `node --check`
- ตรวจ logic: extract ฟังก์ชันด้วย brace-matching → รันใน node
- ตรวจ UI: render ใน Chromium headless (มีฟอนต์ Loma/Noto Serif Thai) แล้ว screenshot
- ⚠️ Firebase (auth/firestore) ต่อไม่ได้ใน sandbox → E2E เต็มรูปแบบต้องรันในที่ที่ต่อ Firebase ได้

## เริ่มต้นใช้งาน (setup ที่ใหม่)
1. สร้าง Firebase project → เปิด Auth (email/password) + Firestore
2. วาง `firestore-rules-ใหม่.txt` ใน Firestore → Rules → Publish
3. ใส่ Firebase config ใน `app.html` และ `index.html` (มองหา `firebaseConfig`)
4. Deploy ขึ้น Firebase Hosting (ตั้ง GitHub Secret `FIREBASE_SERVICE_ACCOUNT` แล้ว push — ดู `วิธีย้ายบ้านไปFirebase.md`) — เปิดที่ `index.html`
5. (ถ้าจะเปิดแจ้งเตือนเด้ง) วางกุญแจ 2 ตัวตาม `วิธีเปิดแจ้งเตือนเด้ง.md` (VAPID ในแอป + Secret ใน Cloudflare)
