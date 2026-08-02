/**
 * 發券服務。
 *
 * 最重要的一項是最後那個「原始碼掃描」測試：
 * CLAUDE.md 第二節要求「發券統一走單一服務，其輸入型別上就不含局帳與幣量
 * （物理上讀不到）」。這是語意條件，資料庫擋不了，只能靠結構強制，
 * 而結構會被日後的人「順手」改掉——所以用測試把它釘住。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migratedPool, newAccount, uniqKey, seedTickets } from './_helper.js';
import { grantTickets, redeemTicketsForPrize, TicketGrantError } from '../src/ticket-grant.js';
import { DRAW_TICKET_SOURCES, ForbiddenDrawTicketSourceError } from '../src/currency-policy.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ticket-grant.js');

let pool;
before(async () => { pool = await migratedPool(); });
after(async () => { await pool.end(); });

describe('發券', () => {
  test('四種合法來源都能發，餘額分桶記在對應來源下', async () => {
    const acc = await newAccount(pool);
    for (const source of DRAW_TICKET_SOURCES) {
      const r = await grantTickets(pool, {
        accountId: acc, source, quantity: 2, campaignRef: `camp-${source}`,
        idempotencyKey: uniqKey(source),
      });
      assert.equal(r.balance, 2);
    }
    const { rows } = await pool.query(
      `SELECT source_type, balance FROM draw_tickets WHERE account_id = $1 ORDER BY source_type`, [acc]);
    assert.equal(rows.length, 4);
    assert.ok(rows.every(r => r.balance === 2));
  });

  test('不合法的來源一律拒絕，包含任何與對局有關的名目', async () => {
    const acc = await newAccount(pool);
    for (const bad of ['game_coins', 'bet_volume', 'leaderboard_rank', 'win_streak', 'coin_balance']) {
      await assert.rejects(
        () => grantTickets(pool, {
          accountId: acc, source: bad, quantity: 1, campaignRef: 'c', idempotencyKey: uniqKey(),
        }),
        err => err instanceof ForbiddenDrawTicketSourceError);
    }
  });

  test('沒說觸發的活動就不准發——稽核要能逐筆反證與對局無關', async () => {
    const acc = await newAccount(pool);
    for (const ref of [undefined, '', '   ', null]) {
      await assert.rejects(
        () => grantTickets(pool, {
          accountId: acc, source: 'task', quantity: 1, campaignRef: ref, idempotencyKey: uniqKey(),
        }),
        err => err instanceof TicketGrantError && err.code === 'missing_campaign_ref');
    }
  });

  test('張數必須是正整數', async () => {
    const acc = await newAccount(pool);
    for (const q of [0, -1, 1.5, 'many']) {
      await assert.rejects(
        () => grantTickets(pool, {
          accountId: acc, source: 'task', quantity: q, campaignRef: 'c', idempotencyKey: uniqKey(),
        }),
        err => err instanceof TicketGrantError && err.code === 'bad_quantity');
    }
  });

  test('重複發同一把鍵只生效一次', async () => {
    const acc = await newAccount(pool);
    const key = uniqKey('grant');
    const a = await grantTickets(pool, { accountId: acc, source: 'daily_checkin', quantity: 3, campaignRef: 'c1', idempotencyKey: key });
    const b = await grantTickets(pool, { accountId: acc, source: 'daily_checkin', quantity: 3, campaignRef: 'c1', idempotencyKey: key });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    const { rows } = await pool.query(
      `SELECT balance FROM draw_tickets WHERE account_id = $1 AND source_type = 'daily_checkin'`, [acc]);
    assert.equal(rows[0].balance, 3);
  });
});

describe('扣券', () => {
  test('換實體獎品會扣掉對應來源的券', async () => {
    const acc = await newAccount(pool);
    await seedTickets(pool, acc, 'ad_view', 5);
    const r = await redeemTicketsForPrize(pool, {
      accountId: acc, source: 'ad_view', quantity: 2, idempotencyKey: uniqKey('redeem'),
    });
    assert.equal(r.balance, 3);
  });

  test('券不夠就扣不動', async () => {
    const acc = await newAccount(pool);
    await seedTickets(pool, acc, 'task', 1);
    await assert.rejects(() => redeemTicketsForPrize(pool, {
      accountId: acc, source: 'task', quantity: 2, idempotencyKey: uniqKey('redeem'),
    }));
    const { rows } = await pool.query(
      `SELECT balance FROM draw_tickets WHERE account_id = $1 AND source_type = 'task'`, [acc]);
    assert.equal(rows[0].balance, 1);
  });
});

describe('結構強制：發券服務物理上讀不到 gameplay 狀態', () => {
  test('grantTickets 的參數不含任何幣量、局帳、排名欄位', () => {
    const params = grantTickets.toString().match(/\{([^}]*)\}/)[1]
      .split(',').map(s => s.trim()).filter(Boolean);
    assert.deepEqual(params.sort(),
      ['accountId', 'campaignRef', 'idempotencyKey', 'quantity', 'source'].sort(),
      '發券的輸入欄位只能有這五個。要加欄位前先讀 CLAUDE.md 第二節。');
  });

  test('ticket-grant.js 原始碼不提及任何 gameplay 狀態', async () => {
    const src = await readFile(SRC, 'utf8');
    // 去掉註解——註解裡本來就要說明「不得讀 game_coins」
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const forbidden = [
      'game_coins', 'paid_derived', 'granted_balance', 'coin_bucket',
      'round', 'grid_result', 'payout', 'bet', 'rank', 'streak', 'wallet.js',
    ];
    const hits = forbidden.filter(w => new RegExp(`\\b${w}\\b`).test(code));
    assert.deepEqual(hits, [],
      `發券服務不得讀取 gameplay 狀態，但原始碼提到了：${hits.join('、')}。\n` +
      'CLAUDE.md 第二節：發券的觸發條件不得讀取任何 gameplay 狀態。');
  });

  test('ticket-grant.js 不 import wallet 或任何局帳模組', async () => {
    const src = await readFile(SRC, 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(imports.sort(), ['./currency-policy.js', './db.js'].sort(),
      '發券服務只能依賴連線與貨幣政策，不得依賴錢包或局帳');
  });
});
