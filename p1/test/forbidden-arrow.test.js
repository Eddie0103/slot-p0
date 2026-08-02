/**
 * 禁止箭頭 game_coins → draw_tickets 的攔阻測試。
 *
 * CLAUDE.md 第二節：這條線一破，整個產品變成賭博。
 * spec-p1 驗收標準 6：資料層與服務層各自阻擋一次，且有測試覆蓋。
 *
 * 這份測試刻意用窮舉的方式檢查所有貨幣組合，而不是只測那一條禁止的箭頭——
 * 白名單的價值在於「沒列出來的都不行」，只測一條看不出這件事。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool, newAccount, assertRejected, withScratchDatabase,
         uniqKey, seedTickets, seedTopup } from './_helper.js';
import * as wallet from '../src/wallet.js';
import { migrateUp } from '../src/migrate.js';
import {
  CURRENCIES,
  ALLOWED_CONVERSIONS,
  DRAW_TICKET_SOURCES,
  isConversionAllowed,
  assertConversionAllowed,
  assertDrawTicketSourceAllowed,
  ForbiddenConversionError,
  ForbiddenDrawTicketSourceError,
} from '../src/currency-policy.js';

let pool, accountId;

before(async () => {
  pool = await migratedPool();
  accountId = await newAccount(pool);
});
after(async () => { await pool.end(); });

// =============================================================================
// 資料層
// =============================================================================

describe('資料層：currency_conversion 白名單', () => {
  test('game_coins → draw_tickets 被 CHECK 約束擋下', async () => {
    const err = await assertRejected(pool,
      `INSERT INTO currency_conversion
         (account_id, from_currency, to_currency, from_amount, to_amount)
       VALUES ($1, 'game_coins', 'draw_tickets', 100, 1)`,
      [accountId],
      { constraint: 'currency_conversion_allowlist', code: '23514' });
    assert.match(err.message, /currency_conversion/);
  });

  test('九種貨幣組合逐一檢查，只有白名單上的兩種可以寫入', async () => {
    const results = [];
    for (const from of CURRENCIES) {
      for (const to of CURRENCIES) {
        let ok = true;
        try {
          await pool.query(
            `INSERT INTO currency_conversion
               (account_id, from_currency, to_currency, from_amount, to_amount)
             VALUES ($1, $2, $3, 100, 100)`,
            [accountId, from, to]);
        } catch (e) {
          ok = false;
          assert.equal(e.constraint, 'currency_conversion_allowlist',
            `${from} → ${to} 應由白名單約束擋下，實際為 ${e.constraint}`);
        }
        results.push({ from, to, ok });
      }
    }
    const accepted = results.filter(r => r.ok).map(r => `${r.from}→${r.to}`);
    assert.deepEqual(accepted.sort(), ['draw_tickets→game_coins', 'topup_points→game_coins']);

    // 資料庫接受的組合必須與服務層白名單完全一致
    const fromPolicy = ALLOWED_CONVERSIONS.map(c => `${c.from}→${c.to}`).sort();
    assert.deepEqual(accepted.sort(), fromPolicy);
  });

  test('game_coins 沒有任何出向箭頭：它是終點，不是中繼站', async () => {
    for (const to of CURRENCIES) {
      await assertRejected(pool,
        `INSERT INTO currency_conversion
           (account_id, from_currency, to_currency, from_amount, to_amount)
         VALUES ($1, 'game_coins', $2, 100, 100)`,
        [accountId, to],
        { constraint: 'currency_conversion_allowlist' });
    }
  });

  test('沒有任何東西能兌換成 topup_points（可退費＝等同現金，紅線 1）', async () => {
    for (const from of CURRENCIES) {
      await assertRejected(pool,
        `INSERT INTO currency_conversion
           (account_id, from_currency, to_currency, from_amount, to_amount)
         VALUES ($1, $2, 'topup_points', 100, 100)`,
        [accountId, from],
        { constraint: 'currency_conversion_allowlist' });
    }
  });
});

describe('資料層：wallet_txn 原因與貨幣的搭配', () => {
  test('抽獎券不能以「兌換得來」的名義入帳', async () => {
    // 兩道防線都會擋，其中 BEFORE 觸發器比 CHECK 先觸發，所以這裡看到的是觸發器的錯。
    // CHECK 那一層由下面「拆掉觸發器」的測試單獨驗證。
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, ticket_source)
       VALUES ($1, 'draw_tickets', 5, 'exchange_in', $2, 5, 'task')`,
      [accountId, `k-${Date.now()}-1`],
      { messageIncludes: 'conversion_leg_violation' });
  });

  test('遊戲幣不能以「兌換出去」的名義出帳', async () => {
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after)
       VALUES ($1, 'game_coins', -100, 'exchange_out', $2, 0)`,
      [accountId, `k-${Date.now()}-2`],
      { messageIncludes: 'conversion_leg_violation' });
  });

  test('拆掉兌換腳觸發器之後，CHECK 約束仍然單獨擋得住', async () => {
    // 縱深防禦要能被驗證：假設日後有人為了除錯把觸發器停掉，
    // 禁止的形狀仍不得寫入。在用完即丟的資料庫上停用觸發器再試一次。
    await withScratchDatabase('legcheck', async scratch => {
      await migrateUp(scratch, { log: () => {} });
      const acc = await newAccount(scratch);
      // 連帳本套用觸發器一起停掉，這個測試要隔離的是 CHECK 約束本身
      await scratch.query('ALTER TABLE wallet_txn DISABLE TRIGGER wallet_txn_conversion_leg');
      await scratch.query('ALTER TABLE wallet_txn DISABLE TRIGGER wallet_txn_zz_apply_balance');
      const { rows: lot } = await scratch.query(
        `INSERT INTO topup_points (account_id, unit_price_twd, points_purchased, balance, platform)
         VALUES ($1, 1, 100, 0, 'apple') RETURNING id`, [acc]);

      // 節點檢查（PR #1）指出：draw_tickets 的正向 exchange_in 天生同時違反
      // reason_matches_currency 與 ticket_reason_matches_source 兩條約束
      // （exchange_in 不在 draw_ticket_source 列舉裡），無法單獨隔離；
      // 原本斷言之所以會過只是因為約束的 OID 順序。改為接受兩者其一。
      const cases = [
        { currency:'draw_tickets', delta:5, reason:'exchange_in', src:"'task'",
          grant:"'campaign-1'", lot:'NULL',
          accept:['wallet_txn_reason_matches_currency', 'wallet_txn_ticket_reason_matches_source'],
          why:'任何貨幣都不得兌換成抽獎券（此形狀天生雙違反，無法單獨隔離）' },
        { currency:'game_coins', delta:-100, reason:'exchange_out', src:'NULL',
          grant:'NULL', lot:'NULL',
          accept:['wallet_txn_reason_matches_currency'],
          why:'遊戲幣不得成為兌換來源' },
        { currency:'topup_points', delta:100, reason:'exchange_in', src:'NULL',
          grant:'NULL', lot:`'${lot[0].id}'`,
          accept:['wallet_txn_reason_matches_currency'],
          why:'沒有東西能變回可退費的儲值點數' },
      ];
      for (const c of cases) {
        const err = await assertRejected(scratch,
          `INSERT INTO wallet_txn
             (account_id, currency_type, delta, reason, idempotency_key, balance_after,
              ticket_source, coin_bucket, ticket_grant_ref, topup_lot_id)
           VALUES ($1, '${c.currency}', ${c.delta}, '${c.reason}', $2, 999, ${c.src},
                   ${c.currency === 'game_coins' ? "'granted'" : 'NULL'}, ${c.grant}, ${c.lot})`,
          [acc, `nolegtrig-${c.currency}`]);
        assert.ok(c.accept.includes(err.constraint),
          `${c.why}：應違反 ${c.accept.join(' 或 ')}，實際為 ${err.constraint}`);
      }
    });
  });

  test('抽獎券入帳必須標明來源，且來源要與原因一致', async () => {
    // 沒有來源
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, ticket_grant_ref)
       VALUES ($1, 'draw_tickets', 5, 'task', $2, 5, 'campaign-1')`,
      [accountId, `k-${Date.now()}-3`],
      { constraint: 'wallet_txn_ticket_source_required' });

    // 用簽到的名義記任務的券
    await assertRejected(pool,
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, ticket_source, ticket_grant_ref)
       VALUES ($1, 'draw_tickets', 5, 'daily_checkin', $2, 5, 'task', 'campaign-1')`,
      [accountId, `k-${Date.now()}-4`],
      { constraint: 'wallet_txn_ticket_reason_matches_source' });
  });

  test('四種合法來源都可以正常發券', async () => {
    for (const [i, source] of DRAW_TICKET_SOURCES.entries()) {
      await pool.query(
        `INSERT INTO wallet_txn
           (account_id, currency_type, delta, reason, idempotency_key, balance_after, ticket_source, ticket_grant_ref)
         VALUES ($1, 'draw_tickets', 1, $2, $3, 1, $4, $5)`,
        [accountId, source, `ok-${Date.now()}-${i}`, source, `campaign-${source}`]);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM wallet_txn
       WHERE account_id = $1 AND currency_type = 'draw_tickets'`, [accountId]);
    assert.equal(rows[0].n, DRAW_TICKET_SOURCES.length);
  });

  test('允許的兌換走完整兩腳可以成功寫入', async () => {
    const acc = await newAccount(pool);
    await seedTopup(pool, acc, { points: 100 });
    const r = await wallet.exchange(pool, {
      accountId: acc, from: 'topup_points', to: 'game_coins', fromAmount: 100,
      idempotencyKey: uniqKey('conv'),
    });
    const { rows: legs } = await pool.query(
      'SELECT count(*)::int AS n FROM wallet_txn WHERE conversion_id = $1', [r.conversionId]);
    assert.equal(legs[0].n, 2);
    assert.equal(r.coinBucket, 'paid_derived');
  });
});

describe('資料層：draw_tickets 來源允許清單', () => {
  test('game_coins_exchange 這種來源連型別都不存在', async () => {
    await assertRejected(pool,
      `INSERT INTO draw_tickets (account_id, source_type, balance)
       VALUES ($1, 'game_coins_exchange', 10)`,
      [accountId],
      { code: '22P02' });   // invalid_text_representation：不是合法的 enum 值
  });

  test('絆線：即使有人替 enum 加上新來源，CHECK 約束仍會擋下', async () => {
    // ALTER TYPE ... ADD VALUE 無法還原，因此在用完即丟的資料庫上測。
    await withScratchDatabase('enumtripwire', async scratch => {
      await migrateUp(scratch, { log: () => {} });
      const acc = await newAccount(scratch);

      // 模擬日後某人「順手」把來源加進型別
      await scratch.query(`ALTER TYPE draw_ticket_source ADD VALUE 'game_coins_exchange'`);
      // 停掉帳本守衛，這個測試要隔離的是來源允許清單 CHECK
      await scratch.query('ALTER TABLE draw_tickets DISABLE TRIGGER draw_tickets_ledger_only');

      // 型別放行了，但 CHECK 約束沒有
      await assertRejected(scratch,
        `INSERT INTO draw_tickets (account_id, source_type, balance)
         VALUES ($1, 'game_coins_exchange', 10)`,
        [acc],
        { constraint: 'draw_tickets_source_allowlist', code: '23514' });
    });
  });

  test('四種合法來源都可以建立券的餘額分桶', async () => {
    const acc = await newAccount(pool);
    for (const source of DRAW_TICKET_SOURCES) await seedTickets(pool, acc, source, 3);
    const { rows } = await pool.query(
      'SELECT source_type, balance FROM draw_tickets WHERE account_id = $1 ORDER BY source_type', [acc]);
    assert.equal(rows.length, 4);
    assert.ok(rows.every(r => r.balance === 3));
  });
});

// =============================================================================
// 服務層
// =============================================================================

describe('服務層：currency-policy 守門函式', () => {
  test('assertConversionAllowed 擋下 game_coins → draw_tickets 並說明原因', () => {
    assert.throws(
      () => assertConversionAllowed('game_coins', 'draw_tickets'),
      err => {
        assert.ok(err instanceof ForbiddenConversionError);
        assert.equal(err.from, 'game_coins');
        assert.equal(err.to, 'draw_tickets');
        assert.match(err.message, /唯一禁止的箭頭/);
        return true;
      });
  });

  test('assertConversionAllowed 擋下所有換現方向', () => {
    for (const from of CURRENCIES) {
      assert.throws(() => assertConversionAllowed(from, 'topup_points'), ForbiddenConversionError);
    }
    for (const to of CURRENCIES) {
      assert.throws(() => assertConversionAllowed('game_coins', to), ForbiddenConversionError);
    }
  });

  test('白名單是預設拒絕：未知貨幣一律擋下', () => {
    assert.equal(isConversionAllowed('loyalty_points', 'draw_tickets'), false);
    assert.throws(() => assertConversionAllowed('game_coins', 'crypto'), ForbiddenConversionError);
    assert.throws(() => assertConversionAllowed('draw_tickets', 'draw_tickets'), ForbiddenConversionError);
  });

  test('兩條合法箭頭放行', () => {
    assert.doesNotThrow(() => assertConversionAllowed('topup_points', 'game_coins'));
    assert.doesNotThrow(() => assertConversionAllowed('draw_tickets', 'game_coins'));
  });

  test('assertDrawTicketSourceAllowed 擋下任何與遊戲幣有關的來源', () => {
    for (const bad of ['game_coins', 'game_coins_exchange', 'bet_volume', 'leaderboard_rank', 'win_streak']) {
      assert.throws(() => assertDrawTicketSourceAllowed(bad), ForbiddenDrawTicketSourceError);
    }
    for (const good of DRAW_TICKET_SOURCES) {
      assert.doesNotThrow(() => assertDrawTicketSourceAllowed(good));
    }
  });
});
