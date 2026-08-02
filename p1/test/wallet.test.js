/**
 * Wallet 服務：冪等、雙帳本、消耗順序。
 * 對應 spec-p1 第七節任務 2，以及驗收標準 2 與 5。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, uniqKey, seedTopup, seedGrantedCoins, seedPaidCoins } from './_helper.js';
import * as wallet from '../src/wallet.js';

let pool;
before(async () => { pool = await migratedPool(); });
after(async () => { await pool.end(); });

describe('冪等（驗收標準 5）', () => {
  test('重複送出同一筆下注，餘額只變動一次', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 1000);
    const key = uniqKey('bet');

    const first = await wallet.placeBet(pool, { accountId: acc, amount: 100, idempotencyKey: key });
    assert.equal(first.replayed, false);
    const after1 = await wallet.getBalances(pool, acc);

    for (let i = 0; i < 3; i++) {
      const again = await wallet.placeBet(pool, { accountId: acc, amount: 100, idempotencyKey: key });
      assert.equal(again.replayed, true, '第二次以後應該是回放');
      assert.deepEqual({ g: again.fromGranted, p: again.fromPaid },
                       { g: first.fromGranted, p: first.fromPaid });
    }
    const afterN = await wallet.getBalances(pool, acc);
    assert.deepEqual(afterN.gameCoins, after1.gameCoins, '重送不得再扣一次');
    assert.equal(afterN.gameCoins.granted, 900);
  });

  test('並行送出同一把鍵，只有一次真的生效', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 1000);
    const key = uniqKey('race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        wallet.placeBet(pool, { accountId: acc, amount: 100, idempotencyKey: key })));
    const applied = results.filter(r => !r.replayed);
    assert.equal(applied.length, 1, `應只有一次實際生效，實際 ${applied.length}`);
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.gameCoins.granted, 900);
  });

  test('儲值、兌換、派彩、贈送都冪等', async () => {
    const acc = await newAccount(pool);
    const ops = [
      ['topup', k => wallet.purchaseTopup(pool, { accountId: acc, points: 100, unitPriceTwd: 1, platform: 'apple', idempotencyKey: k })],
      ['grant', k => wallet.grantCoins(pool, { accountId: acc, amount: 50, idempotencyKey: k })],
      ['payout', k => wallet.creditPayout(pool, { accountId: acc, amount: 70, idempotencyKey: k })],
      ['exchange', k => wallet.exchange(pool, { accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 40, idempotencyKey: k })],
    ];
    for (const [name, run] of ops) {
      const key = uniqKey(name);
      await run(key);
      const before = await wallet.getBalances(pool, acc);
      const replay = await run(key);
      assert.equal(replay.replayed, true, `${name} 重送應為回放`);
      assert.deepEqual(await wallet.getBalances(pool, acc), before, `${name} 重送後餘額不得改變`);
    }
  });

  test('冪等鍵不可為空', async () => {
    const acc = await newAccount(pool);
    await assert.rejects(
      () => wallet.grantCoins(pool, { accountId: acc, amount: 1, idempotencyKey: '  ' }),
      err => err.code === 'bad_idempotency_key');
  });
});

describe('消耗順序：先扣贈送、後扣付費（法規預設）', () => {
  test('贈送夠用時完全不動付費桶', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 500);
    await seedPaidCoins(pool, acc, 500);
    const r = await wallet.placeBet(pool, { accountId: acc, amount: 300, idempotencyKey: uniqKey() });
    assert.deepEqual({ g: r.fromGranted, p: r.fromPaid }, { g: 300, p: 0 });
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.gameCoins.granted, 200);
    assert.equal(b.gameCoins.paidDerived, 500);
  });

  test('贈送不夠時才動付費桶，且剛好補足差額', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 120);
    await seedPaidCoins(pool, acc, 500);
    const r = await wallet.placeBet(pool, { accountId: acc, amount: 300, idempotencyKey: uniqKey() });
    assert.deepEqual({ g: r.fromGranted, p: r.fromPaid }, { g: 120, p: 180 });
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.gameCoins.granted, 0);
    assert.equal(b.gameCoins.paidDerived, 320);
  });

  test('兩桶加起來不夠就整筆不成立，餘額原封不動', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 100);
    await seedPaidCoins(pool, acc, 100);
    const before = await wallet.getBalances(pool, acc);
    await assert.rejects(
      () => wallet.placeBet(pool, { accountId: acc, amount: 201, idempotencyKey: uniqKey() }),
      err => err instanceof wallet.InsufficientFundsError);
    assert.deepEqual(await wallet.getBalances(pool, acc), before);
  });
});

describe('儲值與兌換', () => {
  test('儲值點數先進先出，退費金額回推得到每筆單價', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 100, unitPrice: 1.0 });
    await seedTopup(pool, acc, { points: 100, unitPrice: 0.5 });
    await wallet.exchange(pool, {
      accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 150,
      idempotencyKey: uniqKey('ex'),
    });
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.topupPoints.unused, 50, '先扣第一筆 100，再扣第二筆 50');
    assert.equal(b.topupPoints.refundableTwd, 25, '剩下的 50 點都來自單價 0.5 的那筆');
  });

  test('兌換的目標桶由來源貨幣決定', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 100 });
    const paid = await wallet.exchange(pool, {
      accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 100,
      idempotencyKey: uniqKey('ex1'),
    });
    assert.equal(paid.coinBucket, 'paid_derived');

    const b1 = await wallet.getBalances(pool, acc);
    assert.equal(b1.gameCoins.paidDerived, 1000);
    assert.equal(b1.gameCoins.granted, 0);
  });

  test('儲值點數不足時整筆不成立', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 10 });
    const before = await wallet.getBalances(pool, acc);
    await assert.rejects(
      () => wallet.exchange(pool, {
        accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 11,
        idempotencyKey: uniqKey('ex'),
      }),
      err => err instanceof wallet.InsufficientFundsError);
    assert.deepEqual(await wallet.getBalances(pool, acc), before);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM currency_conversion WHERE account_id = $1`, [acc]);
    assert.equal(rows[0].n, 0, '失敗的兌換不得留下表頭');
  });

  test('服務層不接受禁止的箭頭', async () => {
    const acc = await newAccount(pool);
    await assert.rejects(
      () => wallet.exchange(pool, {
        accountId: acc, from: 'game_coins', to: 'draw_tickets', fromAmount: 1,
        idempotencyKey: uniqKey(),
      }),
      err => err.name === 'ForbiddenConversionError');
  });
});

describe('派彩落贈送桶', () => {
  test('用付費幣下注贏來的幣記為贈送', async () => {
    const acc = await newAccount(pool);
    await seedPaidCoins(pool, acc, 1000);
    await wallet.placeBet(pool, { accountId: acc, amount: 100, idempotencyKey: uniqKey('b') });
    await wallet.creditPayout(pool, { accountId: acc, amount: 175, idempotencyKey: uniqKey('p') });
    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.gameCoins.paidDerived, 900, '付費桶只被下注扣掉');
    assert.equal(b.gameCoins.granted, 175, '派彩全數落贈送桶');
  });
});

describe('驗收標準 2：任一時點可查出未使用之付費購買點數', () => {
  test('連續操作後，餘額查詢與帳本總和一致', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 200, unitPrice: 1 });
    await seedTopup(pool, acc, { points: 300, unitPrice: 0.8 });
    await wallet.exchange(pool, { accountId: acc, from: 'topup_points', to: 'game_coins',
      fromAmount: 250, idempotencyKey: uniqKey('ex') });
    await wallet.placeBet(pool, { accountId: acc, amount: 1000, idempotencyKey: uniqKey('b') });
    await wallet.creditPayout(pool, { accountId: acc, amount: 400, idempotencyKey: uniqKey('p') });

    const b = await wallet.getBalances(pool, acc);
    const { rows } = await pool.query(
      `SELECT coalesce(sum(delta),0)::bigint AS ledger
         FROM wallet_txn WHERE account_id = $1 AND currency_type = 'topup_points'`, [acc]);
    assert.equal(b.topupPoints.unused, Number(rows[0].ledger));
    assert.equal(b.topupPoints.unused, 250);
    // 剩下 250 點全部來自第二筆（單價 0.8）
    assert.equal(b.topupPoints.refundableTwd, 200);
  });
});

describe('冪等鍵的操作命名空間', () => {
  test('同一把鍵用在不同操作，不會被誤判成回放', async () => {
    const acc = await newAccount(pool);
    await seedGrantedCoins(pool, acc, 1000);
    const shared = uniqKey('shared');

    const bet = await wallet.placeBet(pool, { accountId: acc, amount: 100, idempotencyKey: shared });
    assert.equal(bet.replayed, false);

    // 呼叫端不小心拿同一把鍵去派彩，這是不同操作，必須真的執行
    const payout = await wallet.creditPayout(pool, { accountId: acc, amount: 50, idempotencyKey: shared });
    assert.equal(payout.replayed, false, '不同操作不得被當成回放');
    assert.equal(payout.amount, 50);

    const b = await wallet.getBalances(pool, acc);
    assert.equal(b.gameCoins.granted, 950, '1000 - 100 + 50');
  });

  test('帳本上存的鍵帶有操作命名空間', async () => {
    const acc = await newAccount(pool);
    const k = uniqKey('ns');
    await wallet.grantCoins(pool, { accountId: acc, amount: 10, idempotencyKey: k });
    const { rows } = await pool.query(
      `SELECT idempotency_key FROM wallet_txn WHERE account_id = $1`, [acc]);
    assert.equal(rows[0].idempotency_key, `grant:${k}`);
  });
});
