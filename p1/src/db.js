/**
 * 資料庫連線。
 *
 * CLAUDE.md 第四節：錢包用強一致性的關聯式資料庫，不可最終一致。
 * 這裡選 PostgreSQL；交易隔離等級與鎖的策略屬於 Wallet 服務（spec-p1 任務 2），
 * 本檔只負責連線設定。
 *
 * 連線參數走標準的 libpq 環境變數（PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE），
 * 不把任何連線字串寫進 Git。
 */
import pg from 'pg';

export const DB = Object.freeze({
  host:     process.env.PGHOST     ?? '/tmp',
  port:     Number(process.env.PGPORT ?? 5432),
  user:     process.env.PGUSER     ?? 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'slot_p1',
});

/** 建立資料庫時要連的維護用資料庫。 */
export const MAINTENANCE_DATABASE = process.env.PGMAINTDB ?? 'postgres';

/** bigint 預設以字串回傳，本專案的金額都在安全整數範圍內，轉成 Number 方便斷言。 */
pg.types.setTypeParser(pg.types.builtins.INT8, v => Number(v));

export function createPool(database = DB.database) {
  return new pg.Pool({ ...DB, database });
}

/** 在單一連線上跑一段程式，結束後歸還。 */
export async function withClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** 在交易中跑一段程式，丟錯就整筆回滾。 */
export async function withTransaction(pool, fn) {
  return withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** 若目標資料庫不存在就建立。migration 前置動作。 */
export async function ensureDatabase(name = DB.database) {
  const admin = new pg.Client({ ...DB, database: MAINTENANCE_DATABASE });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rows.length) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
