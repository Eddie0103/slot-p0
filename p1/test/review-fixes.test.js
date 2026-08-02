/**
 * 節點檢查（Fable 5，PR #1）指出的問題，逐項驗證修正確實生效。
 *
 * 五項指控在修正前都經實測重現過，這裡的每一項對應 004 的一段修正。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, assertRejected } from './_helper.js';

let pool;
before(async () => { pool = await migratedPool(); });
after(async () => { await pool.end(); });

let n = 0;
const key = () => `rev-${process.pid}-${++n}`;

describe('004-1 TRUNCATE 不得繞過 append-only', () => {
  // 列級觸發器對 TRUNCATE 不觸發，修正前一句 TRUNCATE 就能清空整份法定稽核帳
  for (const [table, extra] of [['round', ''], ['wallet_txn', ''],
                                ['currency_conversion', ' CASCADE'], ['topup_points', '']]) {
    test(`${table} 不可 TRUNCATE`, async () => {
      await assertRejected(pool, `TRUNCATE ${table}${extra}`, [],
        { messageIncludes: 'append_only_violation' });
    });
  }

  test('TRUNCATE 被擋下後資料仍在', async () => {
    const acc = await newAccount(pool);
    await pool.query(
      `INSERT INTO round (account_id, machine_id, math_config_version, server_seed,
                          client_seed, nonce, bet, grid_result, payout)
       VALUES ($1,'m','v',$2,'c',1,10,'[]'::jsonb,0)`, [acc, `seed-${key()}`]);
    await assertRejected(pool, 'TRUNCATE round', [], { messageIncludes: 'append_only_violation' });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM round WHERE account_id = $1', [acc]);
    assert.equal(rows[0].n, 1);
  });
});

describe('004-2 退費舉證欄位不可竄改', () => {
  async function lot(acc) {
    const { rows } = await pool.query(
      `INSERT INTO topup_points (account_id, unit_price_twd, points_purchased, balance, platform)
       VALUES ($1, 1.0000, 100, 100, 'apple') RETURNING id`, [acc]);
    return rows[0].id;
  }

  test('單價、購買時間、購買量、通路、帳號都凍結', async () => {
    const acc = await newAccount(pool);
    const id = await lot(acc);
    const frozen = [
      ['unit_price_twd', '0.0001'],
      ['purchased_at', "now() - interval '5 years'"],
      ['points_purchased', '999999'],
      ['platform', "'other'"],
    ];
    for (const [col, val] of frozen) {
      await assertRejected(pool, `UPDATE topup_points SET ${col} = ${val} WHERE id = $1`, [id],
        { messageIncludes: 'topup_lot_immutable_violation' });
    }
    const { rows } = await pool.query(
      'SELECT unit_price_twd, points_purchased, platform FROM topup_points WHERE id = $1', [id]);
    assert.equal(Number(rows[0].unit_price_twd), 1);
    assert.equal(rows[0].points_purchased, 100);
    assert.equal(rows[0].platform, 'apple');
  });

  test('未使用點數只能遞減，不能被加回去', async () => {
    const acc = await newAccount(pool);
    const id = await lot(acc);
    await pool.query('UPDATE topup_points SET balance = 40 WHERE id = $1', [id]);   // 消耗，允許
    await assertRejected(pool, 'UPDATE topup_points SET balance = 100 WHERE id = $1', [id],
      { messageIncludes: 'topup_lot_immutable_violation' });
    const { rows } = await pool.query('SELECT balance FROM topup_points WHERE id = $1', [id]);
    assert.equal(rows[0].balance, 40);
  });

  test('購買紀錄不可刪除', async () => {
    const acc = await newAccount(pool);
    const id = await lot(acc);
    await assertRejected(pool, 'DELETE FROM topup_points WHERE id = $1', [id],
      { messageIncludes: 'append_only_violation' });
  });
});

describe('004-3 冪等索引與跨桶下注', () => {
  test('一次下注跨兩個桶，同一把鍵可以落兩列', async () => {
    const acc = await newAccount(pool);
    const k = key();
    await pool.query(
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,coin_bucket)
       VALUES ($1,'game_coins',-60,'bet',$2,40,'granted')`, [acc, k]);
    await pool.query(
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,coin_bucket)
       VALUES ($1,'game_coins',-40,'bet',$2,0,'paid_derived')`, [acc, k]);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM wallet_txn WHERE idempotency_key = $1', [k]);
    assert.equal(rows[0].n, 2);
  });

  test('同一把鍵、同一個桶仍然只能落一筆', async () => {
    const acc = await newAccount(pool);
    const k = key();
    const sql = `INSERT INTO wallet_txn
      (account_id,currency_type,delta,reason,idempotency_key,balance_after,coin_bucket)
      VALUES ($1,'game_coins',-10,'bet',$2,0,'granted')`;
    await pool.query(sql, [acc, k]);
    await assertRejected(pool, sql, [acc, k], { code: '23505' });
  });

  test('NULLS NOT DISTINCT：非遊戲幣的冪等性沒有被打掉', async () => {
    // coin_bucket 對 topup_points 恆為 NULL。若少了 NULLS NOT DISTINCT，
    // 同一把鍵會因為 NULL 互不相等而重複插入兩列，冪等性靜默失效。
    const acc = await newAccount(pool);
    const k = key();
    const sql = `INSERT INTO wallet_txn
      (account_id,currency_type,delta,reason,idempotency_key,balance_after)
      VALUES ($1,'topup_points',100,'topup_purchase',$2,100)`;
    await pool.query(sql, [acc, k]);
    await assertRejected(pool, sql, [acc, k], { code: '23505' });
  });

  test('索引確實建成 NULLS NOT DISTINCT', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'wallet_txn_idempotency_uniq'`);
    assert.match(rows[0].indexdef, /NULLS NOT DISTINCT/,
      `索引缺少 NULLS NOT DISTINCT：${rows[0].indexdef}`);
    assert.match(rows[0].indexdef, /coin_bucket/);
  });
});

describe('004-4 發券必須說得出觸發來源', () => {
  test('沒寫 ticket_grant_ref 的發券被擋下', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_source)
       VALUES ($1,'draw_tickets',5,'task',$2,5,'task')`, [acc, key()],
      { constraint: 'wallet_txn_ticket_grant_ref_required' });
  });

  test('空白字串不算數', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_source,ticket_grant_ref)
       VALUES ($1,'draw_tickets',5,'task',$2,5,'task','   ')`, [acc, key()],
      { constraint: 'wallet_txn_ticket_grant_ref_required' });
  });

  test('寫了觸發來源就通過，且可逐筆查出每張券由哪個活動發出', async () => {
    const acc = await newAccount(pool);
    await pool.query(
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_source,ticket_grant_ref)
       VALUES ($1,'draw_tickets',5,'cumulative_topup',$2,5,'cumulative_topup','milestone-topup-3000')`,
      [acc, key()]);
    const { rows } = await pool.query(
      `SELECT ticket_grant_ref FROM wallet_txn WHERE account_id = $1 AND currency_type = 'draw_tickets'`,
      [acc]);
    assert.deepEqual(rows.map(r => r.ticket_grant_ref), ['milestone-topup-3000']);
  });

  test('扣券不需要觸發來源', async () => {
    const acc = await newAccount(pool);
    await pool.query(
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_source)
       VALUES ($1,'draw_tickets',-1,'ticket_redeem_prize',$2,0,'task')`, [acc, key()]);
  });

  test('其他貨幣不得帶發券來源', async () => {
    const acc = await newAccount(pool);
    await assertRejected(pool,
      `INSERT INTO wallet_txn (account_id,currency_type,delta,reason,idempotency_key,balance_after,ticket_grant_ref)
       VALUES ($1,'topup_points',100,'topup_purchase',$2,100,'campaign-1')`, [acc, key()],
      { constraint: 'wallet_txn_ticket_grant_ref_only_tickets' });
  });
});
