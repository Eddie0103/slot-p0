/**
 * Migration 執行器。
 *
 * 刻意不引入 migration 框架：這一層要能被稽核，SQL 必須是可直接閱讀的靜態檔案，
 * 不希望有任何工具在中間改寫。規則只有三條：
 *   1. migrations/ 下的 .sql 依檔名排序執行
 *   2. 已套用的檔案記在 schema_migrations，含 SHA-256
 *   3. 已套用的檔案若內容被改動，直接中止——歷史 migration 不可改寫，只能新增
 *
 * 用法：
 *   node src/migrate.js up       套用所有未套用的 migration
 *   node src/migrate.js status   列出已套用與待套用
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, withClient, ensureDatabase } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

async function loadMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
  return Promise.all(files.map(async filename => {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

/** 套用所有未套用的 migration。回傳實際套用的檔名。 */
export async function migrateUp(pool, { log = console.log } = {}) {
  const migrations = await loadMigrations();
  return withClient(pool, async client => {
    await client.query(BOOTSTRAP);
    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map(r => [r.filename, r.checksum]));

    for (const m of migrations) {
      if (applied.has(m.filename)) {
        if (applied.get(m.filename) !== m.checksum) {
          throw new Error(
            `migration ${m.filename} 已套用但內容已被改動。` +
            '歷史 migration 不可改寫，請另外新增一個檔案。'
          );
        }
        continue;
      }
      // 每個 migration 自成一筆交易：失敗就整份回滾，不會留下半套的 schema
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [m.filename, m.checksum]
        );
        await client.query('COMMIT');
        log(`已套用 ${m.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.filename} 失敗：${err.message}`);
      }
    }
    const appliedNow = migrations.filter(m => !applied.has(m.filename)).map(m => m.filename);
    if (!appliedNow.length) log('沒有待套用的 migration');
    return appliedNow;
  });
}

/**
 * 把整個 schema 砍掉重建。僅供測試使用。
 * 刻意不提供「往回退一版」的 down migration：正式環境的錢包資料不允許結構回退，
 * 要修就往前加一個 migration。
 */
export async function resetSchema(pool) {
  await withClient(pool, async client => {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });
}

async function status(pool) {
  const migrations = await loadMigrations();
  await withClient(pool, async client => {
    await client.query(BOOTSTRAP);
    const { rows } = await client.query('SELECT filename, applied_at FROM schema_migrations');
    const applied = new Map(rows.map(r => [r.filename, r.applied_at]));
    for (const m of migrations) {
      const at = applied.get(m.filename);
      console.log(`${at ? '已套用' : '待套用'}  ${m.filename}${at ? '  ' + at.toISOString() : ''}`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] || 'up';
  await ensureDatabase();
  const pool = createPool();
  try {
    if (cmd === 'up') await migrateUp(pool);
    else if (cmd === 'status') await status(pool);
    else { console.error(`未知指令：${cmd}`); process.exitCode = 1; }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
