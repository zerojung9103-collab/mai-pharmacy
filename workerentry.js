// ตัวรันโค้ดของเว็บ (Cloudflare Worker entry) — v4.13.3
// เส้นทาง /juristic = ค้นหาข้อมูลผู้เสียภาษี/นิติบุคคล ให้ฟอร์มเอกสารการค้า
//   แหล่งหลัก: ระบบตรวจผู้ประกอบการ VAT กรมสรรพากร (ครอบคลุมทุกรายที่จด VAT — ตรงกับงานใบกำกับภาษี)
//   แหล่งสำรอง: MOC Open Data กระทรวงพาณิชย์ (ช้า/ไม่ครบ แต่มีบ้าง)
// คำตอบ normalize เป็น {ok:true,name,address,branch,source} หรือ {ok:false,error}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/juristic') return env.ASSETS.fetch(request);

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    };
    const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
    if (id.length !== 13) {
      return new Response(JSON.stringify({ ok: false, error: 'ต้องเป็นเลข 13 หลัก' }), { status: 400, headers });
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

    // ===== 1) กรมสรรพากร (VAT) =====
    try {
      const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Service xmlns="https://rdws.rd.go.th/JserviceRD3/vatserviceRD3">
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
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'https://rdws.rd.go.th/JserviceRD3/vatserviceRD3/Service'
        },
        body: soap
      }, 12000);
      const xml = await r.text();
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
        return new Response(JSON.stringify({
          ok: true, name, address: parts.join(' '), branch,
          source: 'กรมสรรพากร (ผู้ประกอบการ VAT)'
        }), { status: 200, headers });
      }
      if (err) {
        // เจอระบบแต่ไม่พบเลขนี้ (เช่น ไม่ได้จด VAT) → ลองแหล่งสำรองต่อ
      }
    } catch (e) { /* ไปแหล่งสำรอง */ }

    // ===== 2) สำรอง: MOC Open Data =====
    try {
      const r = await fetchT('https://dataapi.moc.go.th/juristic?juristic_id=' + id, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'maipharmacy-app' }
      }, 8000);
      const j = await r.json();
      const d = (Array.isArray(j) ? j[0] : (j && (j.data && j.data[0] || j.data) || j)) || {};
      const name = d.juristicNameTH || d.juristic_name_th || d.name || '';
      if (name) {
        const a = d.addressInfo || d.address || {};
        const addr = typeof a === 'string' ? a : [a.houseNumber, a.villageName, a.soi, a.street,
          a.subDistrict && 'ต.' + a.subDistrict, a.district && 'อ.' + a.district,
          a.province && 'จ.' + a.province, a.zipcode].filter(Boolean).join(' ');
        return new Response(JSON.stringify({ ok: true, name, address: addr, branch: 'สำนักงานใหญ่', source: 'กระทรวงพาณิชย์' }), { status: 200, headers });
      }
    } catch (e) { /* ตกไปข้อความล่าง */ }

    return new Response(JSON.stringify({
      ok: false,
      error: 'ไม่พบเลขนี้ในฐานผู้ประกอบการ VAT (กรมสรรพากร) และฐานกระทรวงพาณิชย์ — กรอกชื่อ/ที่อยู่เองได้เลย'
    }), { status: 200, headers });
  }
};
