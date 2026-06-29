// ─── Database backend ────────────────────────────────────────────────────────
// ใช้ Postgres เมื่อมี DATABASE_URL (เช่นบน Render → Neon/Supabase) ข้อมูลถาวร
// ไม่มี DATABASE_URL → ใช้ SQLite ไฟล์ในเครื่อง (สำหรับ dev local)
// เผยอินเทอร์เฟซ db.run / db.get / db.all (callback แบบ sqlite3) + db.exec (Promise)
// เพื่อให้โค้ดเดิมที่เรียกใช้แทบไม่ต้องแก้
const USE_PG = !!process.env.DATABASE_URL;

// แปลง placeholder "?" ของ sqlite → "$1, $2, ..." ของ Postgres
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

let backend;

if (USE_PG) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon/Supabase/Render ต้องใช้ SSL — ตั้ง DATABASE_SSL=off เฉพาะกรณีต่อ PG ภายในที่ไม่มี SSL
    ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (err) => console.error('[pg] pool error', err.message));

  const normalize = (sql, params, cb) => {
    if (typeof params === 'function') { cb = params; params = []; }
    return { sql: toPg(sql), params: params || [], cb };
  };

  backend = {
    isPg: true,
    pk: 'SERIAL PRIMARY KEY',
    run(sqlRaw, paramsRaw, cbRaw) {
      const { sql: base, params, cb } = normalize(sqlRaw, paramsRaw, cbRaw);
      // INSERT → ขอแถวกลับมาเพื่อรองรับ this.lastID แบบ sqlite
      // ใช้ RETURNING * (ไม่ใช่ RETURNING id) เพราะบางตารางไม่มีคอลัมน์ id เช่น page_locks (PK = page_key)
      const isInsert = /^\s*insert\s/i.test(sqlRaw);
      const sql = (isInsert && !/returning/i.test(sqlRaw)) ? base + ' RETURNING *' : base;
      pool.query(sql, params)
        .then((r) => {
          const ctx = { lastID: r.rows && r.rows[0] ? r.rows[0].id : undefined, changes: r.rowCount };
          if (cb) cb.call(ctx, null);
        })
        .catch((err) => { if (cb) cb.call({}, err); else console.error('[pg] run error', err.message); });
    },
    get(sqlRaw, paramsRaw, cbRaw) {
      const { sql, params, cb } = normalize(sqlRaw, paramsRaw, cbRaw);
      pool.query(sql, params).then((r) => cb && cb(null, r.rows[0])).catch((e) => cb && cb(e));
    },
    all(sqlRaw, paramsRaw, cbRaw) {
      const { sql, params, cb } = normalize(sqlRaw, paramsRaw, cbRaw);
      pool.query(sql, params).then((r) => cb && cb(null, r.rows)).catch((e) => cb && cb(e));
    },
    serialize(fn) { if (fn) fn(); },
    exec(sqlRaw, params = []) { return pool.query(toPg(sqlRaw), params); },
  };
} else {
  const sqlite3 = require('sqlite3').verbose();
  const sdb = new sqlite3.Database(process.env.SQLITE_PATH || './cip_database.sqlite', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to the SQLite database.');
  });
  backend = {
    isPg: false,
    pk: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    run(...a) { return sdb.run(...a); },
    get(...a) { return sdb.get(...a); },
    all(...a) { return sdb.all(...a); },
    serialize(fn) { return sdb.serialize(fn); },
    exec(sql, params = []) {
      return new Promise((resolve, reject) => {
        sdb.run(sql, params, function (err) { err ? reject(err) : resolve({ rowCount: this.changes, rows: [] }); });
      });
    },
  };
}

if (USE_PG) console.log('[db] using Postgres (DATABASE_URL)');
else console.log('[db] using SQLite (local)');

module.exports = backend;
