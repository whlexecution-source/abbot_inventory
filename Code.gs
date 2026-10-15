/**
 * Abbott premium - เช็คว่าร้านไหน/SKU ไหน ยังไม่ปรับสต็อก
 * ไฟล์เดียวจบ วางใน Apps Script ได้เลย (ไม่ใช้ร่วมกับเวอร์ชันเก่า)
 *
 * แหล่งข้อมูล 3 ที่ ทั้งหมดเป็น API ภายในของ CloudViu (ไม่ใช่ API ทางการ)
 *   project-outlets            -> master ร้าน (ชื่อ, area, channel)
 *   premium-orders-distribute  -> universe: ร้าน x SKU ที่เคลื่อนไหวใน 35 วัน
 *   order-activities           -> stock_adjustment ของรอบจันทร์-อังคาร
 *
 * ผลลัพธ์ = universe LEFT JOIN adjustment
 *   คู่ที่ join ไม่ติด = ยังไม่ได้ปรับ
 *
 * ลำดับการรัน:  checkCredsSet() -> pullOutlets() -> pullUniverse() -> syncNow()
 */

/* ========================== ตั้งค่า ========================== */

var BASE = 'https://app.cloudviu.co';
var ORGANIZATION_ID = 48;          // = project id (ชื่อ field ไม่ตรงความหมาย)
var TIMEZONE = 'Asia/Bangkok';

// universe ย้อนหลังกี่วัน (5 สัปดาห์)
var UNIVERSE_DAYS = 35;

// หน้าต่างที่ถือว่า "ต้องปรับสต็อก" - 1=จันทร์ 2=อังคาร
var ADJUST_DAYS = [1, 2];

// trigger ทำงานจริงเฉพาะในกรอบนี้ (Apps Script ตั้งเงื่อนไขวัน/เวลาไม่ได้ ต้อง gate เอง)
var SYNC_DAYS = [1, 2];
var SYNC_HOUR_FROM = 8;
var SYNC_HOUR_TO = 22;

// คอลัมน์ในชีต outlets ที่จะส่งให้หน้าเว็บใช้เป็นตัวกรอง
// ไม่กรองฝั่ง server แล้ว - ส่งไปทั้งหมด ให้ผู้ใช้เลือกเองบนเว็บ
var CHANNEL_FIELD = 'channel';

var ROUTE_OUTLET = 'routes/_app.project-outlets._index';
var ROUTE_PREMIUM = 'routes/_app.premium-orders-distribute._index';
var ROUTE_ACTIVITY = 'routes/_app.order-activities._index';

var PAGE_OUTLET = 2000;
var PAGE_PREMIUM = 5000;      // ลดเป็น 1000 ถ้า JSON.parse ไม่ไหว
var PAGE_ACTIVITY = 1000;

var ACT_TYPE = 'stock_adjustment';
var ONLY_COMPLETED = true;

// login ด้วยเบอร์โทร - ชีตนี้อัพโหลดเอง ไม่ได้ดึงจาก CloudViu
var SHEET_USERS = 'user_master';
var TOKEN_TTL_DAYS = 7;

var SHEET_OUTLETS = 'outlets';
var SHEET_UNIVERSE = 'universe';
var SHEET_WEBDATA = '_webdata';    // JSON สำเร็จรูป (ซ่อนไว้)

var CELL_LIMIT = 45000;            // เซลล์รับได้ 50,000 เผื่อไว้หน่อย

// cache: doGet จะได้ไม่ต้องเปิด Spreadsheet (ตัวที่กินเวลา 1-3 วิทุกครั้ง)
var CACHE_PREFIX = 'wd_';
var CACHE_CHUNK = 90000;           // CacheService รับได้ 100KB ต่อ key
var CACHE_TTL = 21600;             // 6 ชม. = เพดานของ CacheService

/* ========================== งานหลัก ========================== */

/** ดึงใหม่ทั้งหมด - ใช้ตอนเริ่มหรือตอนอยากรีเซ็ต */
function rebuildAll() {
  pullOutlets();
  pullUniverse();
  syncNow();
}

/** trigger รายสัปดาห์เรียกตัวนี้ */
function pullMasters() {
  pullOutlets();
  pullUniverse();
}

/** trigger ทุก 5 นาทีเรียกตัวนี้ - ไม่อยู่ในกรอบเวลาก็จบใน ~0.1 วิ */
function syncAdjustments() {
  if (!inSyncWindow_()) {
    Logger.log('นอกกรอบเวลา (จ-อ %s:00-%s:00) - ไม่ทำอะไร', SYNC_HOUR_FROM, SYNC_HOUR_TO);
    return;
  }
  syncNow();
}

/** คำนวณใหม่ทันที ไม่สนกรอบเวลา - ใช้ตอนทดสอบ */
function syncNow() {
  var w = adjustWindow_();
  Logger.log('รอบ: %s ถึง %s', fmtYmd_(w.from), fmtYmd_(w.to));

  var universe = readUniverse_();
  if (!universe.length) {
    throw new Error('ชีต ' + SHEET_UNIVERSE + ' ว่าง - รัน pullUniverse() ก่อน');
  }

  var cookie = login_();
  var done = fetchAdjusted_(cookie, w);
  Logger.log('stock_adjustment ในรอบ: %s คู่', Object.keys(done).length);

  var out = combine_(universe, done);
  writeWebData_(out, w);

  Logger.log('ร้านทั้งหมด %s | ทำครบ %s | ยังไม่ครบ %s',
    out.stores.length, out.storesDone, out.stores.length - out.storesDone);
  Logger.log('คู่ร้าน x SKU: ทำแล้ว %s / %s', out.pairsDone, out.pairsTotal);
}

/* ========================== 1. master ร้าน ========================== */

/**
 * ดึงร้านทั้งหมด เก็บทุก field ที่ API ส่งมา
 * สร้างหัวตารางจากของจริง ไม่เดาชื่อคอลัมน์
 */
function pullOutlets() {
  var cookie = login_();
  var page = 1, totalPages = 1;
  var rows = [], seen = {}, keyOrder = [], keySeen = {};

  while (page <= totalPages) {
    var json = getJson_(cookie, '/project-outlets?page=' + page + '&limit=' + PAGE_OUTLET,
      ROUTE_OUTLET, 'outlets หน้า ' + page);
    var meta = (json.data && json.data.meta) || {};
    var items = (json.data && json.data.items) || [];

    if (page === 1) {
      totalPages = meta.totalPages || 1;
      Logger.log('outlets: totalItems %s, totalPages %s', meta.totalItems, totalPages);
      if (items.length) Logger.log('field ที่มี: %s', Object.keys(items[0]).join(', '));
    }
    if (!items.length) break;

    items.forEach(function (o) {
      if (!o || seen[o.id]) return;
      seen[o.id] = true;
      var flat = flatten_(o);
      Object.keys(flat).forEach(function (k) {
        if (!keySeen[k]) { keySeen[k] = true; keyOrder.push(k); }
      });
      rows.push(flat);
    });

    page++;
    if (page > 500) throw new Error('จำนวนหน้า outlets ผิดปกติ');
    Utilities.sleep(200);
  }

  if (!rows.length) throw new Error('ไม่ได้ข้อมูลร้านเลย - ตรวจ ORGANIZATION_ID');

  writeSheet_(SHEET_OUTLETS, keyOrder, rows);
  Logger.log('เขียนชีต %s จำนวน %s ร้าน', SHEET_OUTLETS, rows.length);

  // บอกว่าคอลัมน์ที่จะใช้เป็นตัวกรองบนเว็บมีค่าอะไรบ้าง
  if (keySeen[CHANNEL_FIELD]) {
    var tally = {};
    rows.forEach(function (r) {
      var v = (r[CHANNEL_FIELD] === undefined || r[CHANNEL_FIELD] === '') ? '(ว่าง)' : r[CHANNEL_FIELD];
      tally[v] = (tally[v] || 0) + 1;
    });
    Logger.log('ค่าใน "%s": %s', CHANNEL_FIELD, JSON.stringify(tally));
  } else {
    Logger.log('!! ไม่มีคอลัมน์ "%s" - หน้าเว็บจะไม่มีตัวกรอง เลือกจากที่มีจริง: %s',
      CHANNEL_FIELD, keyOrder.join(', '));
  }
}

/** อ่าน master กลับมาเป็น map: outletId -> {name, area, channel} */
function readOutlets_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_OUTLETS);
  if (!sheet || sheet.getLastRow() < 2) return {};

  var values = sheet.getDataRange().getValues();
  var head = values[0];
  var iId = head.indexOf('id');
  var iName = head.indexOf('name');
  var iArea = head.indexOf('area');
  var iCh = head.indexOf(CHANNEL_FIELD);
  if (iId < 0) return {};

  var map = {};
  for (var r = 1; r < values.length; r++) {
    var id = values[r][iId];
    if (id === '' || id === null) continue;
    map[id] = {
      name: iName >= 0 ? String(values[r][iName] || '') : '',
      area: iArea >= 0 ? String(values[r][iArea] || '') : '',
      channel: iCh >= 0 ? String(values[r][iCh] || '') : ''
    };
  }
  return map;
}

/* ========================== 2. universe ========================== */

/**
 * ร้าน x SKU ที่มีการเคลื่อนไหวใน UNIVERSE_DAYS วันหลังสุด
 *
 * endpoint นี้ไม่รับ startAt/endAt (ลองแล้ว totalItems ไม่ลด) จึงดึงมาทั้งก้อน
 * แล้วกรองวันที่เอง - และกรองแยกต่อบรรทัด:
 *   บรรทัดในใบส่ง  ใช้ createdAt ของใบส่ง   (ตอนส่งออก)
 *   บรรทัดในใบรับ  ใช้ createdAt ของใบรับ   (ตอนรับเข้า)
 * ใบที่สร้างนานแล้วแต่เพิ่งมารับ จะนับเฉพาะฝั่งรับ ซึ่งตรงกับความจริง
 */
function pullUniverse() {
  var cutoff = Date.now() - UNIVERSE_DAYS * 86400000;
  Logger.log('universe ย้อนหลัง %s วัน (ตั้งแต่ %s)',
    UNIVERSE_DAYS, Utilities.formatDate(new Date(cutoff), TIMEZONE, 'yyyy-MM-dd HH:mm'));

  var cookie = login_();
  var page = 1, totalPages = 1, orders = 0, skipped = 0;
  var pairs = {}, outlets = {}, skus = {};

  while (page <= totalPages) {
    var json = getJson_(cookie,
      '/premium-orders-distribute?page=' + page + '&limit=' + PAGE_PREMIUM,
      ROUTE_PREMIUM, 'premium หน้า ' + page);
    var meta = (json.data && json.data.meta) || {};
    var items = (json.data && json.data.items) || [];

    if (page === 1) {
      totalPages = meta.totalPages || 1;
      Logger.log('premium orders: totalItems %s, totalPages %s', meta.totalItems, totalPages);
    }
    if (!items.length) break;

    items.forEach(function (o) {
      orders++;
      var hit = false;

      // ฝั่งส่ง
      if (ts_(o.createdAt) >= cutoff) {
        hit = true;
        noteOutlet_(outlets, o.fromOutletId, o.fromOutlet);
        noteOutlet_(outlets, o.toOutletId, o.toOutlet);
        (o.items || []).forEach(function (li) {
          addPair_(pairs, skus, o.fromOutletId, li);
          addPair_(pairs, skus, o.toOutletId, li);
        });
      }

      // ฝั่งรับ - คนละวันกับใบส่งได้
      var ro = o.receiveOrder;
      if (ro && ts_(ro.createdAt) >= cutoff) {
        hit = true;
        noteOutlet_(outlets, o.fromOutletId, o.fromOutlet);
        noteOutlet_(outlets, o.toOutletId, o.toOutlet);
        (ro.items || []).forEach(function (li) {
          addPair_(pairs, skus, ro.fromOutletId, li);
          addPair_(pairs, skus, ro.toOutletId, li);
        });
      }

      if (!hit) skipped++;
    });

    page++;
    if (page > 500) throw new Error('จำนวนหน้า premium ผิดปกติ');
    Utilities.sleep(200);
  }

  var keys = Object.keys(pairs);
  if (!keys.length) {
    throw new Error('ไม่ได้คู่ร้าน x SKU เลย - ลองเพิ่ม UNIVERSE_DAYS หรือตรวจ ORGANIZATION_ID');
  }

  var master = readOutlets_();
  var rows = keys.map(function (k) {
    var p = k.split('|');
    var oid = p[0], pid = p[1];
    var m = master[oid] || {};
    var seenInfo = outlets[oid] || {};
    return {
      outletId: Number(oid),
      outletName: m.name || seenInfo.name || '',
      area: m.area || seenInfo.area || '',
      channel: m.channel || '',
      productId: Number(pid),
      sku: skus[pid] || ''
    };
  });

  rows.sort(function (a, b) {
    if (a.outletName !== b.outletName) return a.outletName < b.outletName ? -1 : 1;
    return a.sku < b.sku ? -1 : (a.sku > b.sku ? 1 : 0);
  });

  writeSheet_(SHEET_UNIVERSE,
    ['outletId', 'outletName', 'area', 'channel', 'productId', 'sku'], rows);

  Logger.log('อ่านใบสั่ง %s ใบ (นอกช่วง %s ใบ)', orders, skipped);
  Logger.log('ร้าน %s | SKU %s | คู่ร้าน x SKU %s',
    Object.keys(outlets).length, Object.keys(skus).length, rows.length);

  var noCh = rows.filter(function (r) { return !r.channel; }).length;
  if (noCh) Logger.log('!! %s แถวไม่มี %s - ร้านอาจไม่อยู่ใน master หรือ field ว่าง', noCh, CHANNEL_FIELD);
}

function addPair_(pairs, skus, outletId, li) {
  if (outletId === null || outletId === undefined) return;   // distribution ไม่มีต้นทาง
  if (!li || li.productId === undefined || li.productId === null) return;
  if (li.sku) skus[li.productId] = li.sku;
  pairs[outletId + '|' + li.productId] = true;
}

/** fromOutlet ส่งมาแค่ name ส่วน toOutlet มี area ด้วย - เก็บค่าแรกที่เจอ */
function noteOutlet_(outlets, id, obj) {
  if (id === null || id === undefined) return;
  var cur = outlets[id] || (outlets[id] = { name: '', area: '' });
  if (!obj) return;
  if (obj.name && !cur.name) cur.name = obj.name;
  if (obj.area && !cur.area) cur.area = obj.area;
}

function readUniverse_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_UNIVERSE);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var values = sheet.getDataRange().getValues();
  var head = values[0];
  var col = {};
  head.forEach(function (h, i) { col[h] = i; });

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row[col.outletId] === '' || row[col.outletId] === null) continue;
    out.push({
      outletId: String(row[col.outletId]),
      outletName: String(row[col.outletName] || ''),
      area: String(row[col.area] || ''),
      channel: String(row[col.channel] || ''),
      productId: String(row[col.productId]),
      sku: String(row[col.sku] || '')
    });
  }
  return out;
}

/* ========================== 3. stock adjustment ========================== */

/**
 * คืน map "outletId|productId" -> รายละเอียดครั้งล่าสุด
 *
 * API กรองเป็น UTC และ server บวก endAt ให้อีก 1 วัน
 * จึงขอช่วงกว้างกว่าที่ต้องการ 1 วันทั้งสองฝั่ง แล้วกรองเป็นเวลาไทยเองอีกชั้น
 */
function fetchAdjusted_(cookie, w) {
  var from = fmtYmd_(new Date(w.from.getTime() - 86400000));
  var to = fmtYmd_(new Date(w.to.getTime() + 86400000));

  var page = 1, totalPages = 1, raw = 0;
  var done = {};

  while (page <= totalPages) {
    var q = 'page=' + page + '&limit=' + PAGE_ACTIVITY
      + '&startAt=' + from + '&endAt=' + to + '&type=' + ACT_TYPE;
    var json = getJson_(cookie, '/order-activities?' + q, ROUTE_ACTIVITY, 'activities หน้า ' + page);
    var meta = (json.data && json.data.meta) || {};
    var items = (json.data && json.data.items) || [];

    if (page === 1) totalPages = meta.totalPages || 1;
    if (!items.length) break;

    items.forEach(function (a) {
      raw++;
      if (a.type !== ACT_TYPE) return;                       // server กรองแล้ว แต่กันพลาด
      if (ONLY_COMPLETED && a.status && a.status !== 'completed') return;

      var t = ts_(a.createdAt);
      if (t < w.from.getTime() || t > w.to.getTime()) return;  // กรองเป็นเวลาไทย

      var oid = a.outletId || a.toOutletId || a.fromOutletId;
      if (oid === null || oid === undefined) return;

      (a.items || []).forEach(function (li) {
        if (!li || li.productId === undefined) return;
        var k = oid + '|' + li.productId;
        var prev = done[k];
        if (prev && prev.ts >= t) return;                    // เก็บครั้งล่าสุด
        done[k] = {
          ts: t,
          remain: num_(li.quantityActual),
          diff: num_(li.quantityActual) - num_(li.quantityStock),
          time: thaiDateTime_(new Date(t)),                  // dd/MM/yyyy HH:mm พ.ศ.
          by: (a.actor && a.actor.displayName) || ''         // ไม่เอา mobile
        };
      });
    });

    page++;
    if (page > 500) throw new Error('จำนวนหน้า activities ผิดปกติ');
    Utilities.sleep(200);
  }

  Logger.log('activities ที่อ่าน %s รายการ', raw);
  return done;
}

/* ========================== 4. รวมผล ========================== */

function combine_(universe, done) {
  var byStore = {};
  var pairsDone = 0;

  universe.forEach(function (u) {
    var s = byStore[u.outletId] || (byStore[u.outletId] = {
      id: Number(u.outletId),
      name: u.outletName,
      area: u.area,
      channel: u.channel,
      total: 0,
      done: 0,
      items: []
    });

    var hit = done[u.outletId + '|' + u.productId];
    s.total++;
    if (hit) { s.done++; pairsDone++; }

    s.items.push({
      productId: Number(u.productId),
      sku: u.sku,
      done: hit ? 1 : 0,
      remain: hit ? hit.remain : null,
      diff: hit ? hit.diff : null,
      time: hit ? hit.time : '',
      by: hit ? hit.by : ''
    });
  });

  var stores = Object.keys(byStore).map(function (k) { return byStore[k]; });

  // ยังไม่ครบขึ้นก่อน แล้วเรียงตามชื่อ
  stores.sort(function (a, b) {
    var ar = a.done >= a.total ? 1 : 0;
    var br = b.done >= b.total ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  // ตัวเลือกให้ dropdown บนหน้าเว็บ - ไม่ต้องให้ฝั่ง client ไล่เก็บเอง
  var channels = {}, areas = {}, skus = {}, users = {};
  stores.forEach(function (s) {
    if (s.channel) channels[s.channel] = true;
    if (s.area) areas[s.area] = true;
    s.items.forEach(function (i) {
      if (i.sku) skus[i.sku] = true;
      if (i.by) users[i.by] = true;
    });
  });

  return {
    stores: stores,
    channels: Object.keys(channels).sort(),
    areas: Object.keys(areas).sort(),
    skus: Object.keys(skus).sort(),      // คอลัมน์ของตารางไขว้
    users: Object.keys(users).sort(),
    storesDone: stores.filter(function (s) { return s.done >= s.total; }).length,
    pairsTotal: universe.length,
    pairsDone: pairsDone
  };
}

/* ========================== 5. เขียน JSON ให้เว็บ ========================== */

function writeWebData_(out, w) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_WEBDATA) || ss.insertSheet(SHEET_WEBDATA);
  sheet.clear();

  var meta = {
    generatedAt: thaiDateTime_(new Date()),      // 15/10/2569 10:55
    cycleLabel: cycleLabel_(w),                  // จ. 12 – อ. 13 ต.ค. 2569
    windowFrom: fmtYmd_(w.from),                 // ISO ไว้ให้เครื่องอ่าน
    windowTo: fmtYmd_(w.to),
    universeDays: UNIVERSE_DAYS,
    channelField: CHANNEL_FIELD,
    channels: out.channels,
    areas: out.areas,
    skus: out.skus,
    users: out.users,
    storesTotal: out.stores.length,
    storesDone: out.storesDone,
    pairsTotal: out.pairsTotal,
    pairsDone: out.pairsDone
  };

  // รายการร้านไม่มี items (เบา) ส่วน items แยกไปอีกก้อน
  var light = out.stores.map(function (s) {
    return { id: s.id, name: s.name, area: s.area, channel: s.channel, total: s.total, done: s.done };
  });
  var details = {};
  out.stores.forEach(function (s) { details[s.id] = s.items; });

  var rows = [['meta', JSON.stringify(meta)]];
  pushChunks_(rows, 'stores', JSON.stringify(light));
  pushChunks_(rows, 'details', JSON.stringify(details));

  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  if (!sheet.isSheetHidden()) sheet.hideSheet();

  // ชีตคือของจริงที่เก็บถาวร cache เป็นแค่ทางลัดให้ doGet เร็วขึ้น
  var payload = JSON.stringify({ ok: true, meta: meta, stores: light, details: details });
  cachePut_(payload);
  Logger.log('payload %s KB', Math.round(payload.length / 1024));
}

/* ---- cache ---- */

/** ตัดเป็นท่อนละ 90KB เพราะ CacheService รับได้ 100KB ต่อ key */
function cachePut_(str) {
  var cache = CacheService.getScriptCache();
  var n = Math.ceil(str.length / CACHE_CHUNK);
  try {
    for (var i = 0; i < n; i++) {
      cache.put(CACHE_PREFIX + i, str.substr(i * CACHE_CHUNK, CACHE_CHUNK), CACHE_TTL);
    }
    cache.put(CACHE_PREFIX + 'n', String(n), CACHE_TTL);
    Logger.log('cache: เก็บ %s ท่อน', n);
  } catch (e) {
    // cache พังไม่ใช่เรื่องคอขาดบาดตาย doGet จะถอยไปอ่านชีตเอง
    Logger.log('cache: เก็บไม่สำเร็จ - %s', e.message);
  }
}

/** คืน string เดิม หรือ null ถ้าไม่ครบ (cache หมดอายุ/ถูกไล่ออกทีละท่อนได้) */
function cacheGet_() {
  try {
    var cache = CacheService.getScriptCache();
    var n = Number(cache.get(CACHE_PREFIX + 'n') || 0);
    if (!n) return null;

    var keys = [];
    for (var i = 0; i < n; i++) keys.push(CACHE_PREFIX + i);
    var got = cache.getAll(keys);

    var out = '';
    for (var j = 0; j < n; j++) {
      var part = got[CACHE_PREFIX + j];
      if (part == null) return null;      // ขาดท่อนเดียวก็ใช้ไม่ได้
      out += part;
    }
    return out;
  } catch (e) {
    return null;
  }
}

/** ล้าง cache ด้วยมือ - ใช้ตอนแก้โครงสร้าง payload แล้วอยากให้เห็นผลทันที */
function clearCache() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(CACHE_PREFIX + 'n') || 0);
  var keys = [CACHE_PREFIX + 'n'];
  for (var i = 0; i < n; i++) keys.push(CACHE_PREFIX + i);
  cache.removeAll(keys);
  Logger.log('ล้าง cache แล้ว (%s ท่อน)', n);
}

/** เซลล์รับได้ 50,000 ตัวอักษร - ยาวกว่านั้นตัดเป็นหลายแถว */
function pushChunks_(rows, label, str) {
  if (str.length <= CELL_LIMIT) { rows.push([label, str]); return; }
  var n = 0;
  for (var i = 0; i < str.length; i += CELL_LIMIT) {
    rows.push([label + '#' + n, str.substr(i, CELL_LIMIT)]);
    n++;
  }
  Logger.log('%s ยาว %s ตัวอักษร - แบ่งเป็น %s ท่อน', label, str.length, n);
}

function readWebData_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WEBDATA);
  if (!sheet || sheet.getLastRow() < 1) return null;

  var values = sheet.getDataRange().getValues();
  var buf = {};
  values.forEach(function (r) {
    var label = String(r[0] || '');
    if (!label) return;
    var base = label.split('#')[0];
    buf[base] = (buf[base] || '') + String(r[1] || '');
  });

  if (!buf.meta) return null;
  return {
    meta: JSON.parse(buf.meta),
    stores: buf.stores ? JSON.parse(buf.stores) : [],
    details: buf.details ? JSON.parse(buf.details) : {}
  };
}

/* ========================== 6. API ให้หน้าเว็บ ========================== */

/**
 * Deploy: New deployment -> Web app -> Execute as Me -> Who has access: Anyone
 * ทดสอบ: <URL>/exec?action=all  ควรเห็น JSON
 *
 * หมายเหตุ "Anyone" = ใครรู้ URL ก็ดึงข้อมูลได้ทั้งหมด (รายชื่อร้าน ยอดคงเหลือ ชื่อพนักงาน)
 * ถ้ารับความเสี่ยงนี้ไม่ได้ ต้องเพิ่มชั้น auth ก่อนใช้จริง
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'all';
  var body;

  try {
    if (action === 'ping') {
      // เช็คว่า deploy ถูกต้องไหม โดยไม่เปิดเผยข้อมูล
      body = JSON.stringify({ ok: true, ping: true, at: thaiDateTime_(new Date()) });

    } else if (action !== 'all') {
      body = JSON.stringify({ ok: false, error: 'ไม่รู้จัก action: ' + action });

    } else if (!checkToken_(e && e.parameter && e.parameter.k)) {
      body = JSON.stringify({ ok: false, code: 'AUTH', error: 'กรุณาเข้าสู่ระบบใหม่' });

    } else {
      // ทางเร็ว: cache ตอบได้เลย ไม่ต้องเปิด Spreadsheet
      body = cacheGet_();

      if (!body) {
        // ทางช้า: cache หมดอายุหรือถูกไล่ออก - อ่านชีตแล้วเติม cache กลับไป
        var d = readWebData_();
        if (d) {
          body = JSON.stringify({ ok: true, meta: d.meta, stores: d.stores, details: d.details });
          cachePut_(body);
        } else {
          body = JSON.stringify({ ok: false, error: 'ยังไม่มีข้อมูล - รัน syncNow() ก่อน' });
        }
      }
    }
  } catch (err) {
    body = JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) });
  }

  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * login - รับเบอร์โทรทาง POST body ไม่ใช่ query string
 * เบอร์โทรเป็นข้อมูลส่วนบุคคล ถ้าอยู่ใน URL จะถูกเก็บใน log ของทุกตัวกลางที่ผ่าน
 */
function doPost(e) {
  var body;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (req.action !== 'login') {
      body = JSON.stringify({ ok: false, error: 'ไม่รู้จัก action: ' + req.action });
    } else {
      var u = findUser_(req.mobile);
      body = u
        ? JSON.stringify({
            ok: true,
            token: makeToken_(u.id),
            user: { id: u.id, name: u.name, team: u.team, role: u.role }
          })
        : JSON.stringify({ ok: false, code: 'NOUSER', error: 'ไม่พบเบอร์นี้ในระบบ' });
    }
  } catch (err) {
    body = JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) });
  }

  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========================== ผู้ใช้ + token ========================== */

/**
 * หาผู้ใช้จากเบอร์โทรในชีต user_master
 * ชีตนี้อัพโหลดเอง - ไม่มีใน CloudViu API
 */
function findUser_(mobile) {
  var key = normMobile_(mobile);
  if (!key) return null;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error('ไม่มีชีต ' + SHEET_USERS + ' - อัพโหลดรายชื่อผู้ใช้ก่อน');
  }

  var values = sheet.getDataRange().getValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  var iMobile = head.indexOf('mobile');
  var iId = head.indexOf('user_id');
  var iName = head.indexOf('display_name');
  var iTeam = head.indexOf('team');
  var iRole = head.indexOf('user_role');
  if (iMobile < 0) throw new Error('ชีต ' + SHEET_USERS + ' ไม่มีคอลัมน์ mobile');

  for (var r = 1; r < values.length; r++) {
    if (normMobile_(values[r][iMobile]) !== key) continue;
    return {
      id: iId >= 0 ? String(values[r][iId]) : String(r),
      name: iName >= 0 ? String(values[r][iName] || '') : '',
      team: iTeam >= 0 ? String(values[r][iTeam] || '') : '',
      role: iRole >= 0 ? String(values[r][iRole] || '') : ''
    };
  }
  return null;
}

/**
 * เบอร์โทรในชีตอาจกลายเป็นตัวเลขแล้วเลข 0 หน้าหาย (962397462)
 * หรือผู้ใช้พิมพ์มาเป็น 081-234-5678 / +66 81 234 5678
 */
function normMobile_(v) {
  var d = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d.indexOf('66') === 0) d = '0' + d.substring(2);   // +66...
  if (d.length === 9) d = '0' + d;                                          // 0 หน้าหาย
  return d;
}

/**
 * token แบบไม่เก็บ state - ตัว token เซ็นด้วย HMAC ตรวจสอบได้โดยไม่ต้องจำอะไรไว้
 * ข้างในมีแค่ user_id กับวันหมดอายุ ไม่มีเบอร์โทร
 */
function makeToken_(userId) {
  var payload = userId + '.' + (Date.now() + TOKEN_TTL_DAYS * 86400000);
  return payload + '.' + sign_(payload);
}

/** คืน user_id ถ้า token ใช้ได้ ไม่งั้น null */
function checkToken_(token) {
  if (!token) return null;
  var p = String(token).split('.');
  if (p.length !== 3) return null;

  var payload = p[0] + '.' + p[1];
  if (sign_(payload) !== p[2]) return null;        // ถูกแก้ไข
  if (Number(p[1]) < Date.now()) return null;      // หมดอายุ
  return p[0];
}

function sign_(s) {
  var secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  if (!secret) {
    throw new Error('ยังไม่ได้ตั้ง SESSION_SECRET - รัน makeSessionSecret() หนึ่งครั้ง');
  }
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(s, secret)
  ).replace(/=+$/, '');
}

/**
 * สร้าง secret สำหรับเซ็น token - รันครั้งเดียวตอนติดตั้ง
 * รันซ้ำจะทำให้ทุกคนที่ login อยู่ต้อง login ใหม่
 */
function makeSessionSecret() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('SESSION_SECRET')) {
    Logger.log('มี SESSION_SECRET อยู่แล้ว - ถ้าจะเปลี่ยนให้ลบของเดิมออกก่อน');
    return;
  }
  p.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('สร้าง SESSION_SECRET แล้ว');
}

/** ตรวจว่าชีต user_master อ่านได้ไหม - ไม่พิมพ์เบอร์โทรออกมา */
function checkUsers() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  if (!sheet) { Logger.log('!! ไม่มีชีต %s', SHEET_USERS); return; }

  var values = sheet.getDataRange().getValues();
  Logger.log('ชีต %s: %s แถว', SHEET_USERS, values.length - 1);
  Logger.log('คอลัมน์: %s', values[0].join(', '));

  var head = values[0].map(function (h) { return String(h).trim(); });
  var iMobile = head.indexOf('mobile');
  if (iMobile < 0) { Logger.log('!! ไม่มีคอลัมน์ mobile'); return; }

  var bad = 0, dup = {}, seen = {};
  for (var r = 1; r < values.length; r++) {
    var m = normMobile_(values[r][iMobile]);
    if (m.length !== 10) bad++;
    if (seen[m]) dup[m] = true; else seen[m] = true;
  }
  Logger.log('เบอร์ที่ไม่ใช่ 10 หลัก: %s | เบอร์ซ้ำ: %s', bad, Object.keys(dup).length);
}

/* ========================== trigger ========================== */

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'pullMasters' || f === 'syncAdjustments') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('pullMasters').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();

  ScriptApp.newTrigger('syncAdjustments').timeBased()
    .everyMinutes(5).create();

  Logger.log('ตั้ง trigger แล้ว: pullMasters จันทร์ 06:00 | syncAdjustments ทุก 5 นาที (ทำงานจริง จ-อ %s:00-%s:00)',
    SYNC_HOUR_FROM, SYNC_HOUR_TO);
}

function inSyncWindow_() {
  var now = new Date();
  var day = Number(Utilities.formatDate(now, TIMEZONE, 'u')) % 7;   // u: 1=จันทร์..7=อาทิตย์
  var hour = Number(Utilities.formatDate(now, TIMEZONE, 'H'));
  return SYNC_DAYS.indexOf(day) >= 0 && hour >= SYNC_HOUR_FROM && hour < SYNC_HOUR_TO;
}

/**
 * จันทร์ 00:00 - อังคาร 23:59:59 ของรอบปัจจุบัน
 * รันวันพุธขึ้นไปจะย้อนดูรอบที่เพิ่งผ่าน ไม่กระโดดไปสัปดาห์หน้า
 */
function adjustWindow_() {
  var today = ymdToUtc_(Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'));
  var back = (today.getUTCDay() + 6) % 7;            // อาทิตย์(0) -> ถอย 6 วัน
  var monday = new Date(today.getTime() - back * 86400000);
  var last = ADJUST_DAYS[ADJUST_DAYS.length - 1] - 1;
  var end = new Date(monday.getTime() + last * 86400000 + 86399999);
  return { from: monday, to: end };
}

/* ========================== เครื่องมือ ========================== */

function checkCredsSet() {
  var p = PropertiesService.getScriptProperties();
  var m = p.getProperty('CLOUDVIU_MOBILE');
  var w = p.getProperty('CLOUDVIU_PASS');

  Logger.log('CLOUDVIU_MOBILE: %s', describeCred_(m, true));
  Logger.log('CLOUDVIU_PASS: %s', describeCred_(w, false));
  if (!m || !w) Logger.log('!! ตั้งค่าที่ Project Settings -> Script Properties');
}

function describeCred_(v, isMobile) {
  if (!v) return 'ยังไม่ได้ตั้ง';
  var t = v.trim();
  if (t !== v) return 'ตั้งแล้ว (ยาว ' + t.length + ') !! มีช่องว่างหัวท้าย';
  if (isMobile) {
    if (t.indexOf('@') >= 0) return 'ตั้งแล้ว !! ดูเหมือนอีเมล ต้องเป็นเบอร์มือถือ';
    if (!/^[0-9]+$/.test(t)) return 'ตั้งแล้ว !! มีตัวที่ไม่ใช่ตัวเลข';
  }
  return 'ตั้งแล้ว (ยาว ' + t.length + ')';
}

/** ส่องโครงสร้าง endpoint อื่นด้วย session ที่ login แล้ว */
function probeEndpoint() {
  var path = '/inventory-items?page=1&limit=5';
  var route = 'routes/_app.inventory-items._index';
  var json = getJson_(login_(), path, route, 'probe');
  Logger.log(JSON.stringify(json).substring(0, 3000));
}

/* ========================== พื้นฐาน ========================== */

function getJson_(cookie, pathAndQuery, route, label) {
  var sep = pathAndQuery.indexOf('?') >= 0 ? '&' : '?';
  var url = BASE + pathAndQuery + sep + '_data=' + encodeURIComponent(route);

  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Cookie: cookie, Accept: 'application/json' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(label + ' ไม่สำเร็จ HTTP ' + res.getResponseCode());
  }
  var txt = res.getContentText();
  if (txt.length > 1048576) Logger.log('%s: %s MB', label, (txt.length / 1048576).toFixed(1));
  try {
    return JSON.parse(txt);
  } catch (err) {
    throw new Error(label + ' ตอบกลับไม่ใช่ JSON (หรือใหญ่เกินไป) - ลดค่า PAGE_*');
  }
}

/**
 * login 3 จังหวะ
 *   1) GET /login                     -> csrf + cookie
 *   2) POST /login?_data=...          -> ได้ session (204 + x-remix-redirect)
 *   3) POST /current-organization     -> ผูก session กับโปรเจกต์
 * ข้ามข้อ 3 จะ login ผ่านแต่ได้ข้อมูลว่าง - พังแบบเงียบ
 */
function login_() {
  var c = creds_();

  // followRedirects: false สำคัญ - ถ้าปล่อยให้ตาม redirect จะได้ HTML คนละหน้า ไม่มี csrf
  var pageRes = UrlFetchApp.fetch(BASE + '/login', {
    method: 'get', followRedirects: false, muteHttpExceptions: true
  });
  var csrf = extractCsrf_(pageRes.getContentText());
  if (!csrf) throw new Error('หา csrf ในหน้า login ไม่เจอ - หน้าเว็บอาจเปลี่ยนโครงสร้าง');

  // ต้องส่ง cookie ทุกตัวกลับไป ไม่ใช่แค่ cldviuapp - csrf ผูกกับ session cookie ตัวอื่น
  var preCookies = collectCookies_(pageRes);

  var opts = {
    method: 'post',
    payload: { csrf: csrf, mobile: c.mobile, password: c.pass },
    followRedirects: false,
    muteHttpExceptions: true
  };
  if (preCookies) opts.headers = { Cookie: preCookies };

  var res = UrlFetchApp.fetch(BASE + '/login?_data=' + encodeURIComponent('routes/_auth.login'), opts);
  var code = res.getResponseCode();

  var cookie = extractSessionCookie_(res);
  if (!cookie) throw new Error('login ไม่สำเร็จ (HTTP ' + code + ') - ไม่พบ cookie cldviuapp');

  /*
   * Remix set cookie มาแม้ login ไม่ผ่าน (ใช้เก็บข้อความ error)
   * การเจอ cookie จึงไม่ได้แปลว่าสำเร็จ ต้องดูว่า redirect เด้งกลับหน้า login หรือเปล่า
   */
  var h = res.getAllHeaders();
  var redirect = String(h['x-remix-redirect'] || h['X-Remix-Redirect'] || '');
  if (redirect && redirect.split('?')[0].replace(/\/$/, '') === '/login') {
    throw new Error('login ไม่ผ่าน - server เด้งกลับหน้า login ตรวจเบอร์/รหัสผ่านด้วย checkCredsSet()');
  }
  Logger.log('login แล้ว (HTTP %s, redirect ไป "%s")', code, redirect || '(ไม่มี)');

  return selectOrganization_(cookie, ORGANIZATION_ID);
}

/** เลือกโปรเจกต์ให้ session - server อาจส่ง cookie ใหม่กลับมา ต้องใช้ตัวใหม่แทน */
function selectOrganization_(cookie, orgId) {
  var res = UrlFetchApp.fetch(
    BASE + '/current-organization?_data=' + encodeURIComponent('routes/_resource.current-organization'), {
      method: 'post',
      payload: { organizationId: String(orgId) },
      headers: { Cookie: cookie },
      followRedirects: false,
      muteHttpExceptions: true
    });
  var code = res.getResponseCode();
  if (code >= 400) {
    throw new Error('เลือกโปรเจกต์ ' + orgId + ' ไม่สำเร็จ (HTTP ' + code + ') - ' +
      'ตรวจว่า ORGANIZATION_ID ถูกและ account มีสิทธิ์');
  }
  var fresh = extractSessionCookie_(res);
  Logger.log('เลือกโปรเจกต์ %s แล้ว (HTTP %s%s)', orgId, code,
    fresh ? ', ได้ cookie ใหม่' : ', ใช้ cookie เดิม');
  return fresh || cookie;
}

/** รวบ cookie ทุกตัวเป็น string สำหรับ header Cookie (ตัด Path/Max-Age ฯลฯ ทิ้ง) */
function collectCookies_(res) {
  var h = res.getAllHeaders();
  var sc = h['Set-Cookie'] || h['set-cookie'];
  if (!sc) return '';
  if (!Array.isArray(sc)) sc = [sc];

  var pairs = [];
  var ATTRS = /^(path|expires|max-age|domain|samesite|secure|httponly|version)$/i;
  sc.forEach(function (s) {
    String(s).split(/,(?=\s*[A-Za-z0-9_\-.]+=)/).forEach(function (one) {
      var m = one.trim().match(/^([A-Za-z0-9_\-.]+)=([^;]*)/);
      if (m && !ATTRS.test(m[1])) pairs.push(m[1] + '=' + m[2]);
    });
  });
  return pairs.join('; ');
}

/** Apps Script คืน Set-Cookie ได้หลายแบบ จึงค้นแบบไม่ยึดตัวคั่น */
function extractSessionCookie_(res) {
  var h = res.getAllHeaders();
  var sc = h['Set-Cookie'] || h['set-cookie'];
  if (!sc) return null;
  if (!Array.isArray(sc)) sc = [sc];
  for (var i = 0; i < sc.length; i++) {
    var m = String(sc[i]).match(/cldviuapp=([^;,\s]+)/);
    if (m) return 'cldviuapp=' + m[1];
  }
  return null;
}

/** หน้า login เคยเปลี่ยนโครงสร้างมาแล้ว - เผื่อไว้ 3 รูปแบบ */
function extractCsrf_(html) {
  var m = html.match(/name=["']csrf["'][^>]*value=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/value=["']([^"']+)["'][^>]*name=["']csrf["']/i);
  if (m) return m[1];
  m = html.match(/["']csrf["']\s*:\s*["']([0-9a-fA-F-]{36})["']/);
  return m ? m[1] : null;
}

function creds_() {
  var p = PropertiesService.getScriptProperties();
  var mobile = (p.getProperty('CLOUDVIU_MOBILE') || '').trim();
  var pass = (p.getProperty('CLOUDVIU_PASS') || '').trim();
  if (!mobile || !pass) {
    throw new Error('ยังไม่ได้ตั้ง CLOUDVIU_MOBILE / CLOUDVIU_PASS ใน Script Properties');
  }
  return { mobile: mobile, pass: pass };
}

/* ========================== ตัวช่วยเล็กๆ ========================== */

function writeSheet_(name, headers, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();

  var now = new Date();
  var values = [headers.concat(['syncedAt'])];
  rows.forEach(function (r) {
    values.push(headers.map(function (h) {
      return (r[h] === undefined || r[h] === null) ? '' : r[h];
    }).concat([now]));
  });

  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  sheet.setFrozenRows(1);
}

/** object ซ้อนแบนลงมาชั้นเดียว array ข้ามไป (ยัดลงเซลล์เดียวไม่ได้) */
function flatten_(o) {
  var out = {};
  Object.keys(o).forEach(function (k) {
    var v = o[k];
    if (v === null || v === undefined) { out[k] = ''; return; }
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') { out[k] = v; return; }
    if (Array.isArray(v)) return;
    if (t === 'object') {
      Object.keys(v).forEach(function (k2) {
        var v2 = v[k2];
        var t2 = typeof v2;
        if (v2 === null || v2 === undefined) { out[k + '.' + k2] = ''; return; }
        if (t2 === 'string' || t2 === 'number' || t2 === 'boolean') out[k + '.' + k2] = v2;
      });
    }
  });
  return out;
}

function ts_(s) {
  if (!s) return 0;
  var t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

function num_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function ymdToUtc_(s) {
  var p = s.split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function fmtYmd_(d) {
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/* ---- วันที่แบบไทย (พ.ศ.) สำหรับแสดงบนหน้าเว็บ ---- */

var TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
var TH_DAY = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

/** 15/10/2569 10:55 */
function thaiDateTime_(d) {
  var be = Number(Utilities.formatDate(d, TIMEZONE, 'yyyy')) + 543;
  return Utilities.formatDate(d, TIMEZONE, 'dd/MM/') + be + ' ' +
    Utilities.formatDate(d, TIMEZONE, 'HH:mm');
}

/**
 * จ. 12 – อ. 13 ต.ค. 2569   (เดือนเดียวกัน)
 * จ. 29 ก.ย. – อ. 30 ก.ย. 2569  (คนละเดือน)
 * w.from / w.to เป็น UTC midnight ที่แทนวันไทย จึงอ่านด้วย getUTC*
 */
function cycleLabel_(w) {
  var a = w.from, b = w.to;
  var am = a.getUTCMonth(), bm = b.getUTCMonth();
  var be = b.getUTCFullYear() + 543;

  var head = TH_DAY[a.getUTCDay()] + ' ' + a.getUTCDate() +
    (am === bm ? '' : ' ' + TH_MONTH[am]);
  var tail = TH_DAY[b.getUTCDay()] + ' ' + b.getUTCDate() + ' ' + TH_MONTH[bm] + ' ' + be;
  return head + ' – ' + tail;
}
