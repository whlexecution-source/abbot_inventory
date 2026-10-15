/**
 * Proxy ไป Google Apps Script
 *
 * มีไว้ทำไม:
 *   1. cache ที่ edge - supervisor สิบคนเปิดพร้อมกัน ยิง GAS จริงแค่ครั้งเดียว
 *      ที่เหลือได้จาก CDN ซึ่งเร็วกว่า GAS หลายเท่า
 *   2. ซ่อน URL ของ GAS ไว้ใน environment variable ไม่ต้องอยู่ในไฟล์ที่ browser เห็น
 *   3. ไม่มีปัญหา CORS เพราะหน้าเว็บเรียกโดเมนตัวเอง
 *
 * ⚠️ ตัวนี้ไม่ได้ยืนยันตัวตน ใครรู้ URL ของหน้าเว็บก็เรียก /api/data ได้เหมือนกัน
 */

// ตั้ง GAS_URL ใน Vercel → Settings → Environment Variables แล้วลบ fallback ทิ้ง
const FALLBACK_URL =
  'https://script.google.com/macros/s/AKfycbxvq9lJ6lYosKEX278Hu9YS-dvQlzvzEMILkq77ILhVHGVRwhypPxUE6Ngg1OO2j6YCAQ/exec';

// CommonJS - Vercel อ่าน .js ใน /api เป็น CommonJS ถ้าไม่มี package.json ที่ตั้ง type: module
// ใช้ export default แล้วจะ build ไม่ผ่าน และหน้าเว็บจะได้ 404 กลับมาแทน JSON
module.exports = async function handler(req, res) {
  const gasUrl = process.env.GAS_URL || FALLBACK_URL;

  // token จาก login - ไม่ใช่ข้อมูลส่วนบุคคล จึงส่งทาง query ได้
  const k = (req.query && req.query.k) || '';
  if (!k) {
    return res.status(401).json({ ok: false, code: 'AUTH', error: 'กรุณาเข้าสู่ระบบ' });
  }

  try {
    const upstream = await fetch(gasUrl + '?action=all&k=' + encodeURIComponent(k), {
      // GAS ตอบ 302 ไป googleusercontent ก่อน ต้องตามต่อ
      redirect: 'follow'
    });

    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: 'GAS ตอบกลับ HTTP ' + upstream.status });
    }

    const text = await upstream.text();

    // GAS ส่ง HTML หน้า login กลับมาได้ถ้า deploy ไม่ใช่ "Anyone"
    if (text.trim().startsWith('<')) {
      return res.status(502).json({
        ok: false,
        error: 'GAS ตอบเป็น HTML ไม่ใช่ JSON - ตรวจว่า deploy เป็น "Anyone" แล้วหรือยัง'
      });
    }

    /*
     * s-maxage=60            CDN เก็บไว้ 60 วิ (ฝั่ง GAS sync ทุก 5 นาทีอยู่แล้ว)
     * stale-while-revalidate ของเก่าหมดอายุแล้วยังส่งให้ก่อน แล้วค่อยดึงใหม่เบื้องหลัง
     *                        คนที่เปิดหลังจากนี้จึงไม่ต้องรอ GAS เลย
     */
    // private = เบราว์เซอร์ของคนอื่นหรือ proxy กลางทางเก็บไว้ไม่ได้ แต่ CDN ของ Vercel
    // ยัง cache ตาม URL เต็ม (รวม token) ได้ แต่ละคนจึงมีสำเนาของตัวเอง
    res.setHeader('Cache-Control', 'private, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(text);

  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'เชื่อมต่อ GAS ไม่ได้: ' + (err && err.message ? err.message : 'unknown')
    });
  }
};
