/**
 * ตรวจเบอร์โทรกับชีต user_master แล้วคืน token
 *
 * ใช้ POST เพราะเบอร์โทรเป็นข้อมูลส่วนบุคคล - ถ้าอยู่ใน query string
 * จะถูกบันทึกใน access log ของ Vercel, Google และตัวกลางทุกตัวที่ผ่าน
 *
 * ⚠️ นี่คือการ "ระบุตัวตน" ไม่ใช่การ "ยืนยันตัวตน" - ไม่มีรหัสผ่าน
 *    ใครรู้เบอร์ของคนในทีมก็เข้าได้
 */

const FALLBACK_URL =
  'https://script.google.com/macros/s/AKfycbxvq9lJ6lYosKEX278Hu9YS-dvQlzvzEMILkq77ILhVHGVRwhypPxUE6Ngg1OO2j6YCAQ/exec';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'ต้องเป็น POST' });
  }

  const gasUrl = process.env.GAS_URL || FALLBACK_URL;

  let mobile = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    mobile = String(body.mobile || '').trim();
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง' });
  }
  if (!mobile) {
    return res.status(400).json({ ok: false, error: 'กรุณากรอกเบอร์โทร' });
  }

  try {
    const text = await postToGas(gasUrl, { action: 'login', mobile: mobile });

    if (text.trim().startsWith('<')) {
      return res.status(502).json({
        ok: false,
        error: 'GAS ตอบเป็น HTML ไม่ใช่ JSON - ตรวจว่า deploy เป็น "Anyone" แล้วหรือยัง'
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(text);

  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'เชื่อมต่อ GAS ไม่ได้: ' + (err && err.message ? err.message : 'unknown')
    });
  }
};

/**
 * GAS ตอบ 302 ไป googleusercontent เสมอ
 * ถ้าปล่อยให้ fetch ตาม redirect เอง มันจะเปลี่ยน POST เป็น GET ตามสเปก
 * แล้วไปโดน doGet แทน doPost - ต้องตามเองเป็นสองจังหวะ
 */
async function postToGas(url, payload) {
  const first = await fetch(url, {
    method: 'POST',
    // text/plain เพื่อไม่ให้เกิด preflight และ GAS อ่าน postData.contents ได้ตามปกติ
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'manual'
  });

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    if (!location) throw new Error('GAS ตอบ redirect แต่ไม่มี Location');
    const second = await fetch(location);
    return await second.text();
  }

  if (!first.ok) throw new Error('GAS ตอบกลับ HTTP ' + first.status);
  return await first.text();
}
