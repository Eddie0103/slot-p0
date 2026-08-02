/**
 * 節點檢查（Fable 5，PR #1）指出的問題，逐項驗證修正確實生效。
 * 五項指控在修正前都經實測重現過。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, assertRejected, uniqKey,
         seedTopup, seedGrantedCoins, seedPaidCoins, seedTickets, rawLot } from './_helper.js';
import * as wallet from '../src/wallet.js';

let pool;
before(async () => { pool = await migratedPool(); });
after(async () => { await pool.end(); });

describe('004-1 TRUNCATE 不得繞過 append-only', () => {
  for (const table of ['round', 'wallet_txn', 'currency_conversion', 'topup_points']) {
    test(`${table} 不可 TRUNCATE`, async () => {
      await assertRejected(pool, `TRUNCATE ${table} CASCADE`, [],
        { messageIncludes: 'append_only_violation' });
    });
  }

  test('TRUNCATE 被擋下後資料仍在', async () => {
    const acc = await newAccount(pool);
    await pool.query(
      `INSERT INTO round (account_id, machine_id, math_config_version, server_seed,
                          client_seed, nonce, bet, grid_result, payout)
       VALUES ($1,'m','v',$2,'c',1,10,'[]'::jsonb,0)`, [acc, uniqKey('seed')]);
    await assertRejected(pool, 'TRUNCATE round CASCADE', [],
      { messageIncludes: 'append_only_violation' });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM round WHERE account_id = $1', [acc]);
    assert.equal(rows[0].n, 1);
  });
});

describe('004-2 退費舉證欄位不可竄改', () => {
  test('單價、購買時間、購買量、通路、帳號都凍結', async () => {
    const acc = await newAccount(pool);
    const { lotId } = await seedTopup(pool, acc, { points: 100, unitPrice: 1, platform: 'apple' });
    for (const [col, val] of [['unit_price_twd', '0.0001'],
                              ['purchased_at', "now() - interval '5 years'"],
                              ['points_purchased', '999999'],
                              ['platform', "'other'"]]) {
      await assertRejected(pool, `UPDATE topup_points SET ${col} = ${val} WHERE id = $1`, [lotId],
        { messageIncludes: 'topup_lot_immutable_violation' });
    }
    const { rows } = await pool.query(
      'SELECT unit_price_twd, points_purchased, platform FROM topup_points WHERE id = $1', [lotId]);
    assert.equal(Number(rows[0].unit_price_twd), 1);
    assert.equal(rows[0].points_purchased, 100);
    assert.equal(rows[0].platform, 'apple');
  });

  test('未使用點數不能被直接改，連減少都不行（005 之後只能走帳本）', async () => {
    const acc = await newAccount(pool);
    const { lotId } = await seedTopup(pool, acc, { points: 100 });
    await assertRejected(pool, 'UPDATE topup_points SET balance = 40 WHERE id = $1', [lotId],
      { messageIncludes: 'balance_not_derived_violation' });
    const { rows } = await pool.query('SELECT balance FROM topup_points WHERE id = $1', [lotId]);
    assert.equal(rows[0].balance, 100);
  });

  test('購買紀錄不可刪除', async () => {
    const acc = await newAccount(pool);
    const { lotId } = await seedTopup(pool, acc, { points: 100 });
    await assertRejected(pool, 'DELETE FROM topup_points WHERE id = $1', [lotId],
      { messageIncludes: 'append_only_violation' });
  });
});

describe('004-3 冪等索引與跨桶下注', () => {
  test('一次下注跨兩個桶，同一把鍵落兩列', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 60);
    await seedPaidCoins(pool, acc, 100);
    const key = uniqKey('bet');
    const r = await wallet.placeBet(pool, { accountId: acc, amount: 100, idempotencyKey: key });
    assert.deepEqual({ ...r, replayed: undefined },
      { fromGranted: 60, fromPaid: 40, replayed: undefined });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM wallet_txn WHERE idempotency_key = $1', [key]);
    assert.equal(rows[0].n, 2);
  });

  test('同一把鍵、同一個桶仍然只能落一筆', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 100);
    const key = uniqKey('dup');
    const sql = `INSERT INTO wallet_txn
      (account_id,currency_type,delta,reason,idempotency_key,balance_after,coin_bucket)
      VALUES ($1,'game_coins',-10,'bet',$2,0,'granted')`;
    await pool.query(sql, [acc, key]);
    await assertRejected(pool, sql, [acc, key], { code: '23505' });
  });

  test('NULLS NOT DISTINCT：非遊戲幣的冪等性沒有被打掉', async () => {
    const acc = await newAccount(pool);
    const lotId = await rawLot(pool, acc, { points: 100 });
    const key = uniqKey('nulls');
    const sql = `INSERT INTO wallet_txn
      (account_id,currency_type,delta,reason,idempotency_key,balance_after,topup_lot_id)
      VALUES ($1,'topup_points',1,'topup_purchase',$2,0,$3)`;
    await pool.query(sql, [acc, key, lotId]);
    await assertRejected(pool, sql, [acc, key, lotId], { code: '23505' });
  });

  test('索引確實建成 NULLS NOT DISTINCT 且含 coin_bucket', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'wallet_txn_idempotency_uniq'`);
    assert.match(rows[0].indexdef, /NULLS NOT DISTINCT/);
    assert.match(rows[0].indexdef, /coin_bucket/);
  });
});

describe('004-4 發券必須說得出觸發來源', () => {
  test('沒寫 ticket_grant_ref 的發券被擋下', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_source)
       VALUES ($1,'draw_tickets',5,'task',$2,0,'task')`, [acc, uniqKey()],
      { constraint: 'wallet_txn_ticket_grant_ref_required' });
  });

  test('空白字串不算數', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_source,ticket_grant_ref)
       VALUES ($1,'draw_tickets',5,'task',$2,0,'task','   ')`, [acc, uniqKey()],
      { constraint: 'wallet_txn_ticket_grant_ref_required' });
  });

  test('每張券都查得出由哪個活動發出', async () => {
    const acc = await newAccount(pool);
    await seedTickets(pool, acc, 'cumulative_topup', 5);
    const { rows } = await pool.query(
      `SELECT ticket_grant_ref FROM wallet_txn
        WHERE account_id = $1 AND currency_type = 'draw_tickets' AND delta > 0`, [acc]);
    assert.deepEqual(rows.map(r => r.ticket_grant_ref), ['seed-campaign']);
  });

  test('其他貨幣不得帶發券來源', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 10);
    await assertRejected(pool,
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,coin_bucket,ticket_grant_ref)
       VALUES ($1,'game_coins',10,'grant',$2,0,'granted','campaign-1')`, [acc, uniqKey()],
      { constraint: 'wallet_txn_ticket_grant_ref_only_tickets' });
  });
});

describe('005 餘額只能由帳本推導（節點檢查的「應該修 1(B)」）', () => {
  test('直接灌券被擋下', async () => {
    const acc = await newAccount(pool);
    await seedTickets(pool, acc, 'task', 1);
    await assertRejected(pool,
      `UPDATE draw_tickets SET balance = balance + 500000 WHERE account_id = $1`, [acc],
      { messageIncludes: 'balance_not_derived_violation' });
  });

  test('直接灌遊戲幣被擋下，連新增餘額列都不行', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO game_coins (account_id, granted_balance) VALUES ($1, 999999)`, [acc],
      { messageIncludes: 'balance_not_derived_violation' });
    await seedGrantedCoins(pool, acc, 10);
    await assertRejected(pool,
      `UPDATE game_coins SET granted_balance = 999999 WHERE account_id = $1`, [acc],
      { messageIncludes: 'balance_not_derived_violation' });
  });

  test('餘額表也不能被刪除', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 10);
    await assertRejected(pool, `DELETE FROM game_coins WHERE account_id = $1`, [acc],
      { messageIncludes: 'balance_not_derived_violation' });
  });

  test('餘額恆等於該桶所有 delta 的總和', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 500);
    await seedPaidCoins(pool, acc, 300);
    await wallet.placeBet(pool, { accountId: acc, amount: 200, idempotencyKey: uniqKey('b') });
    await wallet.creditPayout(pool, { accountId: acc, amount: 350, idempotencyKey: uniqKey('p') });
    await seedTickets(pool, acc, 'ad_view', 3);

    const { rows } = await pool.query(
      `SELECT
         (SELECT coalesce(sum(delta),0) FROM wallet_txn
           WHERE account_id=$1 AND currency_type='game_coins' AND coin_bucket='granted') AS ledger_granted,
         (SELECT coalesce(sum(delta),0) FROM wallet_txn
           WHERE account_id=$1 AND currency_type='game_coins' AND coin_bucket='paid_derived') AS ledger_paid,
         (SELECT granted_balance FROM game_coins WHERE account_id=$1) AS bal_granted,
         (SELECT paid_derived_balance FROM game_coins WHERE account_id=$1) AS bal_paid,
         (SELECT coalesce(sum(delta),0) FROM wallet_txn
           WHERE account_id=$1 AND currency_type='draw_tickets') AS ledger_tickets,
         (SELECT coalesce(sum(balance),0) FROM draw_tickets WHERE account_id=$1) AS bal_tickets,
         (SELECT coalesce(sum(delta),0) FROM wallet_txn
           WHERE account_id=$1 AND currency_type='topup_points') AS ledger_topup,
         (SELECT coalesce(sum(balance),0) FROM topup_points WHERE account_id=$1) AS bal_topup`,
      [acc]);
    const r = rows[0];
    assert.equal(Number(r.bal_granted), Number(r.ledger_granted), '贈送桶');
    assert.equal(Number(r.bal_paid), Number(r.ledger_paid), '付費衍生桶');
    assert.equal(Number(r.bal_tickets), Number(r.ledger_tickets), '抽獎券');
    assert.equal(Number(r.bal_topup), Number(r.ledger_topup), '儲值點數');
  });

  test('balance_after 由資料庫回填，服務層填的假值會被覆蓋', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 100);
    const { rows } = await pool.query(
      `INSERT INTO wallet_txn
         (account_id,currency_type,delta,reason,idempotency_key,balance_after,coin_bucket)
       VALUES ($1,'game_coins',50,'grant',$2, 999999, 'granted')
       RETURNING balance_after`, [acc, uniqKey('fake')]);
    assert.equal(rows[0].balance_after, 150, '應為實際餘額，不是傳進去的 999999');
  });
});
