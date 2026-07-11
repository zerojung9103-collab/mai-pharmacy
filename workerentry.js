// ตัวรันโค้ดของเว็บ (Cloudflare Worker entry) — v4.12.2
// หน้าที่: 1) เส้นทาง /juristic = ตัวกลางค้นหานิติบุคคลจากกรมพัฒนาธุรกิจการค้า (MOC Open Data)
//          2) นอกนั้นเสิร์ฟไฟล์เว็บตามปกติ (app.html ฯลฯ)
// (เบราว์เซอร์เรียกเว็บกรมพัฒน์ตรงไม่ได้เพราะติด CORS — ให้ Worker เรียกแทน)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/juristic') {
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      };
      const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
      if (id.length !== 13) {
        return new Response(JSON.stringify({ error: 'ต้องเป็นเลขนิติบุคคล 13 หลัก' }), { status: 400, headers });
      }
      try {
        const r = await fetch('https://dataapi.moc.go.th/juristic?juristic_id=' + id, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'maipharmacy-app' }
        });
        const text = await r.text();
        return new Response(text, { status: r.status, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers });
      }
    }

    // ที่เหลือ = ไฟล์เว็บปกติ
    return env.ASSETS.fetch(request);
  }
};
