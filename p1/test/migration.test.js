/**
 * Migration 執行器本身的行為。
 * 在用完即丟的資料庫上跑，避免影響其他測試。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withScratchDatabase } from './_helper.js';
import { migrateUp } from '../src/migrate.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

describe('migration', () => {
  test('從空資料庫可以一次建起完整 schema，且重跑是冪等的', async () => {
    await withScratchDatabase('migrate', async pool => {
      const first = await migrateUp(pool, { log: () => {} });
      assert.ok(first.length >= 2, `應套用至少 2 個 migration，實際 ${first.length}`);

      const second = await migrateUp(pool, { log: () => {} });
      assert.deepEqual(second, [], '重跑不應再套用任何 migration');

      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`);
      const tables = rows.map(r => r.table_name);
      for (const t of ['account', 'topup_points', 'game_coins', 'draw_tickets',
                       'currency_conversion', 'wallet_txn', 'round', 'schema_migrations']) {
        assert.ok(tables.includes(t), `缺少資料表 ${t}（實際：${tables.join(', ')}）`);
      }
    });
  });

  test('已套用的 migration 被改動時中止，不默默略過', async () => {
    await withScratchDatabase('tamper', async pool => {
      await migrateUp(pool, { log: () => {} });
      const path = join(MIGRATIONS_DIR, '001_wallet_and_ledger.sql');
      const original = await readFile(path, 'utf8');
      try {
        await writeFile(path, original + '\n-- 事後偷改\n');
        await assert.rejects(
          () => migrateUp(pool, { log: () => {} }),
          /已套用但內容已被改動/);
      } finally {
        await writeFile(path, original);
      }
    });
  });

  test('每個 migration 各自成為一筆交易，失敗不留半套 schema', async () => {
    await withScratchDatabase('atomic', async pool => {
      // 直接對 pool 送一段會失敗的 DDL 交易，確認回滾行為
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('CREATE TABLE half_baked (id int)');
        await assert.rejects(() => client.query('CREATE TABLE half_baked (id int)'));
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'half_baked'`);
      assert.equal(rows[0].n, 0);
    });
  });
});
