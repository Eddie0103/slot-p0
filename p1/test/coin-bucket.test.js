/**
 * 遊戲幣桶別：抽獎券換來的幣一律記為「贈送」。
 *
 * 決策見 CLAUDE.md 第五節。這件事不能只寫在文件或服務層——
 * 桶別決定履約保證要提列多少錢，記錯了是財務問題不是程式問題，
 * 所以由資料庫在寫入當下強制。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, assertRejected } from './_helper.js';
import { ALLOWED_CONVERSIONS, COIN_BUCKETS, targetBucketFor } from '../src/currency-policy.js';

let pool;
before(async () => { pool = await migratedPool(); });
after(async () => { await pool.end(); });

/** 建一筆兌換表頭，回傳 id。 */
async function conversion(acc, from, to, fromAmt = 1, toAmt = 500) {
  const { rows } = await pool.query(
    `INSERT INTO currency_conversion
       (account_id, from_currency, to_currency, from_amount, to_amount)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [acc, from, to, fromAmt, toAmt]);
  return rows[0].id;
}

let n = 0;
const key = () => `bucket-${process.pid}-${++n}`;

describe('服務層：targetBucketFor', () => {
  test('抽獎券換來的幣是贈送，儲值點數換來的幣是付費衍生', () => {
    assert.equal(targetBucketFor('draw_tickets', 'game_coins'), 'granted');
    assert.equal(targetBucketFor('topup_points', 'game_coins'), 'paid_derived');
  });

  test('白名單上每一條箭頭都指定了桶別，且是合法的桶', () => {
    for (const c of ALLOWED_CONVERSIONS) {
      assert.ok(COIN_BUCKETS.includes(c.targetBucket),
        `${c.from}→${c.to} 的 targetBucket 不合法：${c.targetBucket}`);
    }
  });

  test('不被允許的兌換問桶別會丟錯，不會給出預設值', () => {
    assert.throws(() => targetBucketFor('game_coins', 'draw_tickets'));
  });
});

describe('資料層：桶別由來源貨幣強制，不由呼叫端指定', () => {
  test('抽獎券換幣時謊報成付費衍生，被資料庫擋下', async () => {
    const acc = await newAccount(pool);
    const conv = await conversion(acc, 'draw_tickets', 'game_coins');
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, coin_bucket)
       VALUES ($1, 'game_coins', 500, 'exchange_in', $2, 500, $3, 'paid_derived')`,
      [acc, key(), conv],
      { messageIncludes: 'coin_bucket_violation' });
  });

  test('儲值點數換幣時謊報成贈送，同樣被擋下', async () => {
    const acc = await newAccount(pool);
    const conv = await conversion(acc, 'topup_points', 'game_coins', 100, 1000);
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, coin_bucket)
       VALUES ($1, 'game_coins', 1000, 'exchange_in', $2, 1000, $3, 'granted')`,
      [acc, key(), conv],
      { messageIncludes: 'coin_bucket_violation' });
  });

  test('照規則寫就通過，且與 currency-policy 的宣告一致', async () => {
    for (const c of ALLOWED_CONVERSIONS) {
      const acc = await newAccount(pool);
      const conv = await conversion(acc, c.from, c.to);
      await pool.query(
        `INSERT INTO wallet_txn
           (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, coin_bucket)
         VALUES ($1, 'game_coins', 500, 'exchange_in', $2, 500, $3, $4)`,
        [acc, key(), conv, c.targetBucket]);
      const { rows } = await pool.query(
        `SELECT coin_bucket FROM wallet_txn WHERE conversion_id = $1`, [conv]);
      assert.equal(rows[0].coin_bucket, targetBucketFor(c.from, c.to));
    }
  });
});

describe('資料層：桶別的其餘規則', () => {
  test('遊戲幣的每一筆異動都必須說得出桶別', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after)
       VALUES ($1, 'game_coins', -10, 'bet', $2, 0)`,
      [acc, key()],
      { constraint: 'wallet_txn_coin_bucket_required' });
  });

  test('其他貨幣不得帶桶別', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, coin_bucket)
       VALUES ($1, 'topup_points', 100, 'topup_purchase', $2, 100, 'paid_derived')`,
      [acc, key()],
      { constraint: 'wallet_txn_coin_bucket_required' });
  });

  test('系統贈送與到期回收只能動贈送桶', async () => {
    const acc = await newAccount(pool);
    for (const reason of ['grant', 'grant_expired']) {
      const delta = reason === 'grant' ? 100 : -100;
      await assertRejected(pool,
        `INSERT INTO wallet_txn
           (account_id, currency_type, delta, reason, idempotency_key, balance_after, coin_bucket)
         VALUES ($1, 'game_coins', ${delta}, '${reason}', $2, 100, 'paid_derived')`,
        [acc, key()],
        { constraint: 'wallet_txn_grant_only_granted' });
      await pool.query(
        `INSERT INTO wallet_txn
           (account_id, currency_type, delta, reason, idempotency_key, balance_after, coin_bucket)
         VALUES ($1, 'game_coins', ${delta}, '${reason}', $2, 100, 'granted')`,
        [acc, key()]);
    }
  });
});
