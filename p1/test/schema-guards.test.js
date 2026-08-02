/**
 * 其餘由 schema 直接保證的法規與工程約束。
 * 這些不是禁止箭頭，但同屬「資料庫層次就該擋掉」的一類。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, assertRejected } from './_helper.js';

let pool, accountId;
before(async () => { pool = await migratedPool(); accountId = await newAccount(pool); });
after(async () => { await pool.end(); });

describe('付費點數不得設使用期限', () => {
  test('topup_points 沒有任何到期欄位', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'topup_points'`);
    const names = rows.map(r => r.column_name);
    const expiryish = names.filter(n => /expir|valid_until|deadline|ttl/i.test(n));
    assert.deepEqual(expiryish, [],
      `付費點數不得設使用期限，但出現疑似到期欄位：${expiryish.join(', ')}`);
  });

  test('game_coins 的贈送幣則可以設期限（贈品除外條款）', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'game_coins' AND column_name = 'granted_expires_at'`);
    assert.equal(rows.length, 1);
  });
});

describe('付費幣與贈送幣物理隔離', () => {
  test('game_coins 分成 paid_derived 與 granted 兩個欄位', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'game_coins' ORDER BY column_name`);
    const names = rows.map(r => r.column_name);
    assert.ok(names.includes('paid_derived_balance'));
    assert.ok(names.includes('granted_balance'));
    // 不得有一個混在一起的總額欄位，否則就「無法區分」，全部進履約保證範圍
    assert.ok(!names.includes('balance'),
      'game_coins 不得有混合的 balance 欄位：可區分才不進履約保證範圍');
  });

  test('兩種餘額都不可為負', async () => {
    const acc = await newAccount(pool);
    await pool.query('INSERT INTO game_coins (account_id) VALUES ($1)', [acc]);
    await assertRejected(pool,
      'UPDATE game_coins SET paid_derived_balance = -1 WHERE account_id = $1', [acc],
      { constraint: 'game_coins_paid_nonneg' });
    await assertRejected(pool,
      'UPDATE game_coins SET granted_balance = -1 WHERE account_id = $1', [acc],
      { constraint: 'game_coins_granted_nonneg' });
  });
});

describe('儲值點數逐筆保留，可舉證來源', () => {
  test('未使用餘額不得超過購買量、不得為負', async () => {
    await assertRejected(pool,
      `INSERT INTO topup_points
         (account_id, unit_price_twd, points_purchased, balance, platform)
       VALUES ($1, 1, 100, 101, 'apple')`, [accountId],
      { constraint: 'topup_points_balance_in_range' });
    await assertRejected(pool,
      `INSERT INTO topup_points
         (account_id, unit_price_twd, points_purchased, balance, platform)
       VALUES ($1, 1, 100, -1, 'apple')`, [accountId],
      { constraint: 'topup_points_balance_in_range' });
  });

  test('可查出未使用之付費購買點數，並回推到每一筆購買的單價', async () => {
    const acc = await newAccount(pool);
    await pool.query(
      `INSERT INTO topup_points (account_id, unit_price_twd, points_purchased, balance, platform)
       VALUES ($1, 1.0000, 300, 120, 'apple'), ($1, 0.9000, 500, 500, 'google')`, [acc]);
    const { rows } = await pool.query(
      `SELECT sum(balance)::int AS points,
              sum(balance * unit_price_twd)::numeric AS twd
       FROM topup_points WHERE account_id = $1 AND balance > 0`, [acc]);
    assert.equal(rows[0].points, 620);
    assert.equal(Number(rows[0].twd), 570);   // 120×1.0 + 500×0.9
  });
});

describe('append-only：局帳與交易帳不可竄改', () => {
  test('round 不可 UPDATE 也不可 DELETE', async () => {
    const acc = await newAccount(pool);
    const { rows } = await pool.query(
      `INSERT INTO round
         (account_id, machine_id, math_config_version, server_seed, client_seed,
          nonce, bet, grid_result, payout)
       VALUES ($1, 'm1', 'v1', 'ss', 'cs', 1, 10, '[]'::jsonb, 0) RETURNING id`, [acc]);
    const id = rows[0].id;
    await assertRejected(pool, 'UPDATE round SET payout = 999 WHERE id = $1', [id],
      { messageIncludes: 'append_only_violation' });
    await assertRejected(pool, 'DELETE FROM round WHERE id = $1', [id],
      { messageIncludes: 'append_only_violation' });
  });

  test('wallet_txn 不可 UPDATE 也不可 DELETE', async () => {
    const acc = await newAccount(pool);
    const { rows } = await pool.query(
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after)
       VALUES ($1, 'topup_points', 100, 'topup_purchase', $2, 100) RETURNING id`,
      [acc, `ao-${Date.now()}`]);
    await assertRejected(pool, 'UPDATE wallet_txn SET delta = 1 WHERE id = $1', [rows[0].id],
      { messageIncludes: 'append_only_violation' });
    await assertRejected(pool, 'DELETE FROM wallet_txn WHERE id = $1', [rows[0].id],
      { messageIncludes: 'append_only_violation' });
  });

  test('同一組 seed 與 nonce 只能有一局（可重現性）', async () => {
    const acc = await newAccount(pool);
    const args = [acc, 'm1', 'v1', 'seed-a', 'seed-b', 7, 10];
    const sql = `INSERT INTO round
       (account_id, machine_id, math_config_version, server_seed, client_seed, nonce, bet, grid_result, payout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,0)`;
    await pool.query(sql, args);
    await assertRejected(pool, sql, args, { constraint: 'round_seed_nonce_uniq' });
  });
});

describe('冪等鍵', () => {
  test('同一把鍵對同一種貨幣只能落一筆', async () => {
    const acc = await newAccount(pool);
    const key = `idem-${Date.now()}`;
    const sql = `INSERT INTO wallet_txn
      (account_id, currency_type, delta, reason, idempotency_key, balance_after)
      VALUES ($1, 'topup_points', 100, 'topup_purchase', $2, 100)`;
    await pool.query(sql, [acc, key]);
    await assertRejected(pool, sql, [acc, key], { code: '23505' });
  });

  test('同一把鍵可以有兩腳，因為兩腳的貨幣不同', async () => {
    const acc = await newAccount(pool);
    const { rows } = await pool.query(
      `INSERT INTO currency_conversion
         (account_id, from_currency, to_currency, from_amount, to_amount)
       VALUES ($1, 'draw_tickets', 'game_coins', 1, 500) RETURNING id`, [acc]);
    const key = `idem2-${Date.now()}`;
    await pool.query(
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, ticket_source)
       VALUES ($1, 'draw_tickets', -1, 'exchange_out', $2, 0, $3, 'task')`, [acc, key, rows[0].id]);
    await pool.query(
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, coin_bucket)
       VALUES ($1, 'game_coins', 500, 'exchange_in', $2, 500, $3, 'granted')`, [acc, key, rows[0].id]);
    const { rows: n } = await pool.query(
      'SELECT count(*)::int AS n FROM wallet_txn WHERE idempotency_key = $1', [key]);
    assert.equal(n[0].n, 2);
  });
});

describe('兌換腳與表頭一致性', () => {
  test('腳的幣別必須對得上表頭', async () => {
    const acc = await newAccount(pool);
    const { rows } = await pool.query(
      `INSERT INTO currency_conversion
         (account_id, from_currency, to_currency, from_amount, to_amount)
       VALUES ($1, 'topup_points', 'game_coins', 100, 1000) RETURNING id`, [acc]);
    // 表頭說來源是 topup_points，腳卻拿抽獎券出帳
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, ticket_source)
       VALUES ($1, 'draw_tickets', -1, 'exchange_out', $2, 0, $3, 'task')`,
      [acc, `leg-${Date.now()}`, rows[0].id],
      { messageIncludes: 'conversion_leg_violation' });
  });

  test('沒有掛兌換就不能用兌換的原因', async () => {
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after)
       VALUES ($1, 'game_coins', 100, 'exchange_in', $2, 100)`,
      [accountId, `leg2-${Date.now()}`],
      { messageIncludes: 'conversion_leg_violation' });
  });
});

describe('餘額不可為負', () => {
  test('wallet_txn 的 balance_after 不可為負', async () => {
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, coin_bucket)
       VALUES ($1, 'game_coins', -100, 'bet', $2, -100, 'granted')`,
      [accountId, `neg-${Date.now()}`],
      { constraint: 'wallet_txn_balance_nonneg' });
  });

  test('draw_tickets 的餘額不可為負', async () => {
    const acc = await newAccount(pool);
    await pool.query(
      `INSERT INTO draw_tickets (account_id, source_type, balance) VALUES ($1, 'task', 1)`, [acc]);
    await assertRejected(pool,
      `UPDATE draw_tickets SET balance = -1 WHERE account_id = $1`, [acc],
      { constraint: 'draw_tickets_balance_nonneg' });
  });
});
