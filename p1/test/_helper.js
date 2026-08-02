/** 測試共用工具。 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { DB, MAINTENANCE_DATABASE, createPool, ensureDatabase } from '../src/db.js';
import { migrateUp } from '../src/migrate.js';
import * as wallet from '../src/wallet.js';
import { grantTickets } from '../src/ticket-grant.js';

/** 主測試資料庫：套用 migration 後直接使用。 */
export async function migratedPool() {
  await ensureDatabase();
  const pool = createPool();
  await migrateUp(pool, { log: () => {} });
  return pool;
}

/**
 * 開一個用完即丟的資料庫。
 * 需要破壞性操作（DROP SCHEMA、ALTER TYPE ADD VALUE 這種無法還原的變更）的測試用。
 */
export async function withScratchDatabase(label, fn) {
  const name = `p1_scratch_${label}_${process.pid}`;
  const admin = () => new pg.Client({ ...DB, database: MAINTENANCE_DATABASE });

  const a = admin();
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS "${name}"`);
  await a.query(`CREATE DATABASE "${name}"`);
  await a.end();

  const pool = createPool(name);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
    const c = admin();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${name}"`);
    await c.end();
  }
}

/** 建一個測試帳號，回傳 id。 */
export async function newAccount(pool, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO account (birth_year, is_minor_guardian_consented)
     VALUES ($1, $2) RETURNING id`,
    [overrides.birthYear ?? 1990, overrides.consented ?? false]
  );
  return rows[0].id;
}

/**
 * 斷言某段 SQL 會被資料庫擋下。
 * @param {object} opts.constraint 期待違反的約束名稱（CHECK 用）
 * @param {string} opts.messageIncludes 期待錯誤訊息包含的片段（觸發器用）
 * @returns 實際的錯誤，供進一步斷言
 */
export async function assertRejected(pool, sql, params, opts = {}) {
  let err = null;
  try {
    await pool.query(sql, params);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `這段 SQL 應該被資料庫擋下，但成功了：\n${sql}`);
  if (opts.constraint) {
    assert.equal(err.constraint, opts.constraint,
      `應違反約束 ${opts.constraint}，實際為 ${err.constraint}（${err.message}）`);
  }
  if (opts.code) {
    assert.equal(err.code, opts.code, `錯誤代碼應為 ${opts.code}，實際為 ${err.code}`);
  }
  if (opts.messageIncludes) {
    assert.ok(err.message.includes(opts.messageIncludes),
      `錯誤訊息應包含「${opts.messageIncludes}」，實際為：${err.message}`);
  }
  return err;
}


/* ===========================================================================
 * 建立測試資料的工具
 *
 * 005 之後餘額只能由帳本推導，測試不能再直接寫餘額表——這正是要保護的性質。
 * 需要餘額的測試一律經由 Wallet 服務建立。
 * ===========================================================================*/

let seq = 0;
/** 產生一把不會撞的冪等鍵。 */
export const uniqKey = (prefix = 'k') => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;

/** 建一筆購買紀錄並灌入點數，回傳 { lotId, points }。 */
export async function seedTopup(pool, accountId, { points = 1000, unitPrice = 1, platform = 'apple' } = {}) {
  return wallet.purchaseTopup(pool, {
    accountId, points, unitPriceTwd: unitPrice, platform, idempotencyKey: uniqKey('seed-topup'),
  });
}

/** 贈送遊戲幣（落贈送桶）。 */
export async function seedGrantedCoins(pool, accountId, amount) {
  return wallet.grantCoins(pool, { accountId, amount, idempotencyKey: uniqKey('seed-grant') });
}

/** 儲值後兌換，讓帳號有付費衍生的遊戲幣。 */
export async function seedPaidCoins(pool, accountId, coins) {
  const rate = wallet.rateFor('topup_points', 'game_coins');
  const points = Math.ceil(coins / rate);
  await seedTopup(pool, accountId, { points });
  return wallet.exchange(pool, {
    accountId, from: 'topup_points', to: 'game_coins', fromAmount: points,
    idempotencyKey: uniqKey('seed-exchange'),
  });
}

/** 發券。 */
export async function seedTickets(pool, accountId, source, quantity) {
  return grantTickets(pool, {
    accountId, source, quantity, campaignRef: 'seed-campaign', idempotencyKey: uniqKey('seed-ticket'),
  });
}

/** 只建一筆空的購買紀錄（餘額 0），給需要 lot id 但要自己控制帳本的測試。 */
export async function rawLot(pool, accountId, { points = 100, unitPrice = 1, platform = 'apple' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO topup_points (account_id, unit_price_twd, points_purchased, balance, platform)
     VALUES ($1,$2,$3,0,$4) RETURNING id`, [accountId, unitPrice, points, platform]);
  return rows[0].id;
}
