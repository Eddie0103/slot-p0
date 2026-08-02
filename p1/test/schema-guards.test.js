/**
 * 由 schema 直接保證的法規與工程約束。
 * 這些不是禁止箭頭，但同屬「資料庫層次就該擋掉」的一類。
 *
 * 005 之後餘額只能由帳本推導，所以需要餘額的測試一律經由 Wallet 服務建立；
 * 「能不能直接寫餘額表」本身也成了一組測試。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, assertRejected, uniqKey,
         seedTopup, seedGrantedCoins, seedTickets } from './_helper.js';
import * as wallet from '../src/wallet.js';

let pool, accountId;
before(async () => { pool = await migratedPool(); accountId = await newAccount(pool); });
after(async () => { await pool.end(); });

describe('付費點數不得設使用期限', () => {
  test('topup_points 沒有任何到期欄位', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'topup_points'`);
    const expiryish = rows.map(r => r.column_name).filter(n => /expir|valid_until|deadline|ttl/i.test(n));
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
  test('game_coins 分成 paid_derived 與 granted 兩個欄位，沒有混合的總額欄位', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'game_coins'`);
    const names = rows.map(r => r.column_name);
    assert.ok(names.includes('paid_derived_balance'));
    assert.ok(names.includes('granted_balance'));
    assert.ok(!names.includes('balance'),
      'game_coins 不得有混合的 balance 欄位：可區分才不進履約保證範圍');
  });

  test('餘額不足時扣不動，兩個桶都不會變成負的', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 50);
    await assert.rejects(
      () => wallet.placeBet(pool, { accountId: acc, amount: 51, idempotencyKey: uniqKey() }),
      err => err instanceof wallet.InsufficientFundsError);
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.gameCoins.granted, 50);
    assert.equal(b.gameCoins.paidDerived, 0);
  });
});

describe('儲值點數逐筆保留，可舉證來源', () => {
  test('新的購買紀錄必須從 0 開始，點數只能由帳本灌入', async () => {
    await assertRejected(pool,
      `INSERT INTO topup_points (account_id, unit_price_twd, points_purchased, balance, platform)
       VALUES ($1, 1, 100, 100, 'apple')`, [accountId],
      { messageIncludes: 'balance_not_derived_violation' });
  });

  test('可查出未使用之付費購買點數，並回推到每一筆購買的單價', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 300, unitPrice: 1.0, platform: 'apple' });
    await seedTopup(pool, acc, { points: 500, unitPrice: 0.9, platform: 'google' });
    // 兌換掉 180 點，先進先出會從第一筆扣
    await wallet.exchange(pool, {
      accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 180,
      idempotencyKey: uniqKey('ex'),
    });
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.topupPoints.unused, 620);            // 300+500-180
    assert.equal(b.topupPoints.refundableTwd, 570);     // 120×1.0 + 500×0.9
  });

  test('每一筆扣款都指得出動到哪一筆購買紀錄', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 100 });
    await seedTopup(pool, acc, { points: 100 });
    await wallet.exchange(pool, {
      accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 150,
      idempotencyKey: uniqKey('ex'),
    });
    const { rows } = await pool.query(
      `SELECT topup_lot_id, delta FROM wallet_txn
        WHERE account_id = $1 AND reason = 'exchange_out' ORDER BY seq`, [acc]);
    assert.equal(rows.length, 2, '跨兩筆購買紀錄應落兩列帳');
    assert.deepEqual(rows.map(r => r.delta), [-100, -50]);
    assert.ok(rows.every(r => r.topup_lot_id), '每一列都要指到 lot');
  });
});

describe('append-only：局帳與交易帳不可竄改', () => {
  test('round 不可 UPDATE 也不可 DELETE', async () => {
    const acc = await newAccount(pool);
    const { rows } = await pool.query(
      `INSERT INTO round (account_id, machine_id, math_config_version, server_seed,
                          client_seed, nonce, bet, grid_result, payout)
       VALUES ($1,'m1','v1',$2,'cs',1,10,'[]'::jsonb,0) RETURNING id`, [acc, uniqKey('seed')]);
    const id = rows[0].id;
    await assertRejected(pool, 'UPDATE round SET payout = 999 WHERE id = $1', [id],
      { messageIncludes: 'append_only_violation' });
    await assertRejected(pool, 'DELETE FROM round WHERE id = $1', [id],
      { messageIncludes: 'append_only_violation' });
  });

  test('wallet_txn 不可 UPDATE 也不可 DELETE', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 100);
    const { rows } = await pool.query(
      `SELECT id FROM wallet_txn WHERE account_id = $1 LIMIT 1`, [acc]);
    await assertRejected(pool, 'UPDATE wallet_txn SET delta = 1 WHERE id = $1', [rows[0].id],
      { messageIncludes: 'append_only_violation' });
    await assertRejected(pool, 'DELETE FROM wallet_txn WHERE id = $1', [rows[0].id],
      { messageIncludes: 'append_only_violation' });
  });

  test('同一組 seed 與 nonce 只能有一局（可重現性）', async () => {
    const acc = await newAccount(pool);
    const args = [acc, 'm1', 'v1', uniqKey('seed'), 'seed-b', 7, 10];
    const sql = `INSERT INTO round
       (account_id, machine_id, math_config_version, server_seed, client_seed, nonce, bet, grid_result, payout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,0)`;
    await pool.query(sql, args);
    await assertRejected(pool, sql, args, { constraint: 'round_seed_nonce_uniq' });
  });
});

describe('兌換腳與表頭一致性', () => {
  test('腳的幣別必須對得上表頭', async () => {
    const acc = await newAccount(pool);
    await seedTickets(pool, acc, 'task', 5);
    const { rows } = await pool.query(
      `INSERT INTO currency_conversion (account_id, from_currency, to_currency, from_amount, to_amount)
       VALUES ($1, 'draw_tickets', 'game_coins', 1, 500) RETURNING id`, [acc]);
    // 表頭說來源是抽獎券，腳卻拿遊戲幣出帳
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, conversion_id, coin_bucket)
       VALUES ($1, 'game_coins', -1, 'exchange_out', $2, 0, $3, 'granted')`,
      [acc, uniqKey('leg'), rows[0].id],
      { messageIncludes: 'violation' });
  });

  test('沒有掛兌換就不能用兌換的原因', async () => {
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, coin_bucket)
       VALUES ($1, 'game_coins', 100, 'exchange_in', $2, 0, 'granted')`,
      [accountId, uniqKey('leg2')],
      { messageIncludes: 'conversion_leg_violation' });
  });
});
