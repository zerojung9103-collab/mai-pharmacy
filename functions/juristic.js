// ตัวกลางค้นหานิติบุคคล (Cloudflare Pages Function — ฟรี ไม่ต้องตั้งค่าอะไร)
// วิธีติดตั้ง: วางไฟล์นี้ไว้ในโฟลเดอร์ชื่อ functions/ ที่รากของ repo GitHub
// → Cloudflare Pages เปิดใช้ให้อัตโนมัติที่ https://<เว็บเรา>/juristic?id=เลข13หลัก
// หน้าที่: รับเลขนิติบุคคล → ไปถามกรมพัฒนาธุรกิจการค้า (MOC Open Data) แทนเบราว์เซอร์
// (เบราว์เซอร์เรียกตรงไม่ได้เพราะติด CORS — เซิร์ฟเวอร์เรียกแทนได้)
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400'
  };
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
