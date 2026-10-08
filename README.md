# Abbott Inventory — เช็คการปรับสต็อก

ดึงข้อมูลจาก CloudViu (project id **48**) มาลง Google Sheet แล้วเปิดเป็นเว็บให้
supervisor เช็คบนมือถือว่า **ร้านไหนยังไม่ได้ปรับสต็อก** ในรอบจันทร์–อังคาร

```
CloudViu API ──┬─[สัปดาห์ละครั้ง]──→ inventory_items  (universe ~5,500 คู่)
               └─[ทุก 5 นาที จ-อ]──→ order-activities
                                          ↓ คำนวณใน Apps Script
                                    _webdata (JSON สำเร็จรูป)
                                          ↓ /api/data (Vercel)
                                    หน้าเว็บมือถือ
```

## โครงสร้าง

```
gas/
  Code.gs       ดึงข้อมูล + คำนวณ + API  (วางใน Apps Script)
  Index.html    หน้า HtmlService สำรอง   (ชื่อไฟล์ใน Apps Script = "Index")
web/            ← Vercel Root Directory
  index.html    หน้าเว็บ
  api/data.js   serverless function proxy ไป GAS
```

---

## ติดตั้ง — ฝั่ง Apps Script

**1. Script Properties** (Project Settings → Script Properties)

| key | value |
|---|---|
| `CLOUDVIU_MOBILE` | เบอร์มือถือที่ใช้ login CloudViu (ตัวเลขล้วน) |
| `CLOUDVIU_PASS` | รหัสผ่าน |

ห้ามเขียนรหัสผ่านลงในโค้ด และอย่าแชร์ Spreadsheet แบบ Editor ให้คนที่ไม่จำเป็น —
คนที่แก้ไขได้จะเปิด Apps Script อ่าน Script Properties ได้

**2. เตรียมข้อมูล** (รันตามลำดับ)

```
checkCredsSet()        ตรวจว่าตั้ง properties ถูก
pullInventory()        ดึง universe
syncAdjustmentsNow()   คำนวณ + สร้าง _webdata
```

**3. Deploy** → New deployment → Web app
- Execute as: **Me**
- Who has access: **Anyone** ← จำเป็นเพื่อให้ Vercel เรียกได้

ทดสอบ: เปิด `<URL>/exec?action=all` ควรเห็น JSON

**4. ตั้ง trigger**

```
installTriggers()
```

| Job | ความถี่ |
|---|---|
| `pullInventory` | จันทร์ 06:00 |
| `syncAdjustments` | ทุก 5 นาที (ทำงานจริงเฉพาะ **จ–อ 08:00–22:00**) |

Apps Script ตั้ง trigger แบบจำกัดวัน/เวลาไม่ได้ จึง gate ไว้ในฟังก์ชันแทน
รอบนอกหน้าต่างจบใน ~0.1 วิ ไม่กินโควต้า

---

## ติดตั้ง — ฝั่ง Vercel

1. Vercel → **Add New → Project** → เลือก repo นี้
2. **Root Directory** → `web`
3. Framework Preset → **Other** (static ไม่ต้อง build)
4. **Environment Variables** → เพิ่ม

   | key | value |
   |---|---|
   | `GAS_URL` | URL ของ GAS Web App (ลงท้าย `/exec`) |

5. Deploy

push ขึ้น GitHub เมื่อไหร่ deploy ใหม่อัตโนมัติ

---

## ⚠️ ความปลอดภัย — อ่านก่อนเปิดใช้จริง

`/api/data` **เปิดให้ใครก็เรียกได้** serverless function แค่ซ่อน URL ของ GAS
ไม่ได้ตรวจว่าใครเป็นคนเรียก → **ใครรู้ URL ของหน้าเว็บ ก็ดึงข้อมูลได้ทั้งหมด**

ข้อมูลที่เปิดอยู่: รายชื่อร้าน, SKU, ยอดสต็อกคงเหลือ, ชื่อพนักงานที่ทำงาน
(ไม่มีเบอร์โทร — ตัดออกตั้งแต่ฝั่ง Apps Script แล้ว)

**ถ้ารับความเสี่ยงนี้ไม่ได้** เลือกอย่างใดอย่างหนึ่ง:

| วิธี | ความยาก |
|---|---|
| ใช้หน้า `gas/Index.html` ผ่าน Apps Script แทน (Google บังคับ login โดเมนบริษัท) | ง่ายสุด ฟรี |
| Vercel Authentication (แผน Pro) | ง่าย เสียเงิน |
| ใส่รหัสผ่านหน้าเว็บ + ตรวจใน `api/data.js` | ต้องเขียนเพิ่ม |

**ตั้ง repo เป็น Private** ไม่ว่าจะเลือกทางไหน

---

## ตรรกะ

```
universe (ร้าน x SKU)  LEFT JOIN  stock_adjustment ในจันทร์–อังคาร
→ คู่ที่ join ไม่ติด = ยังไม่ได้ปรับ
```

ยึด universe เป็นตัวตั้ง ไม่ใช่ activities — ไม่งั้นจะมองไม่เห็นร้านที่ไม่ทำอะไรเลย
ซึ่งคือสิ่งที่กำลังตามหา

**หน้าต่าง** = จันทร์ 00:00 – อังคาร 23:59 เวลาไทย ของรอบปัจจุบัน
รันหลังอังคารจะย้อนดูรอบที่เพิ่งผ่าน ไม่กระโดดไปสัปดาห์หน้า

**timezone** — API กรองด้วย UTC จึงขอช่วงกว้าง (อาทิตย์–พุธ) แล้วกรอง `createdAt`
เป็นเวลาไทยเองอีกชั้น ไม่งั้นงานที่ทำเช้ามืดวันจันทร์จะหลุดหน้าต่าง

**remain** = `quantityActual` (ยอดที่นับได้จริงตอน adjust)
ถ้าไม่ตรงกับ `quantityStock` จะโชว์ส่วนต่างให้ด้วย เป็นสัญญาณว่าสต็อกเพี้ยน

---

## ข้อควรรู้

- **เช้าวันจันทร์ทุกร้านจะกลับเป็น "ยังไม่ทำ"** เพราะขึ้นรอบใหม่ ไม่ใช่บั๊ก
  หน้าเว็บจึงแสดงช่วงวันที่ไว้ตลอดเวลา
- `order-activities` มีทั้ง `giveaway` และ `coupon_redemption` ปนมาด้วย
  โค้ดกรอง `stock_adjustment` ทั้งฝั่ง server และฝั่งเราอีกชั้น
- ระบบนี้ **พังแบบเงียบได้** — ไม่ได้เลือกโปรเจกต์ / form id ถูกเปลี่ยน / ไม่มีข้อมูล
  ทุกกรณีตอบ HTTP 200 เหมือนกันหมด ถ้าตัวเลขเป็น 0 ให้ดู log ก่อนเสมอ
- นี่คือ **API ภายในของ CloudViu ไม่ใช่ API ทางการ** อาจเปลี่ยนเมื่อไหร่ก็ได้
  (เคยเจอ form id เปลี่ยนมาแล้วในอีกโปรเจกต์)

## ฟังก์ชันที่เรียกเองได้

| ฟังก์ชัน | ทำอะไร | แตะชีต |
|---|---|---|
| `checkCredsSet()` | ตรวจ Script Properties (ไม่พิมพ์ค่าจริง) | ไม่ |
| `probeEndpoint()` | สำรวจ endpoint อื่นด้วย session ที่ login แล้ว | ไม่ |
| `testBigLimit()` | ทดสอบว่าขอ limit ใหญ่ได้แค่ไหน | ไม่ |
| `syncAdjustmentsNow()` | คำนวณใหม่ทันที ไม่สนหน้าต่างเวลา | `_webdata` |
| `exportDetailSheets()` | เขียน 3 ชีตสำหรับวิเคราะห์ / Power BI | ใช่ |
