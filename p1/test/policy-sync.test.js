/**
 * 防漂移：資料層的 CHECK 約束與服務層的白名單必須永遠一致。
 *
 * CLAUDE.md 第四節的原則是為機率公告寫的——「絕不人工維護第二份，不同步即違法」。
 * 允許的兌換箭頭同理：SQL 一份、JS 一份，只要有人只改了一邊，
 * 禁止箭頭就會在其中一層悄悄開一個洞。這份測試讓那種 diff 過不了。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migratedPool } from './_helper.js';
import { ALLOWED_CONVERSIONS, DRAW_TICKET_SOURCES, CURRENCIES } from '../src/currency-policy.js';

let pool;
before(async () => { pool = await migratedPool(); });
after(async () => { await pool.end(); });

async function constraintDef(name) {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name]);
  assert.equal(rows.length, 1, `找不到約束 ${name}，或有重名`);
  return rows[0].def;
}

test('currency_conversion_allowlist 的內容等於 ALLOWED_CONVERSIONS', async () => {
  const def = await constraintDef('currency_conversion_allowlist');
  // Postgres 會把 (a,b) IN (...) 正規化成
  //   ((from = 'x') AND (to = 'y')) OR ((from = 'z') AND (to = 'w'))
  const pairs = [...def.matchAll(
    /from_currency = '(\w+)'::currency_type\)\s*AND\s*\(to_currency = '(\w+)'::currency_type/g)]
    .map(m => `${m[1]}→${m[2]}`).sort();
  assert.ok(pairs.length > 0, `無法從約束定義解析出白名單：${def}`);
  const expected = ALLOWED_CONVERSIONS.map(c => `${c.from}→${c.to}`).sort();
  assert.deepEqual(pairs, expected,
    `SQL 白名單與 currency-policy.js 不一致。\nSQL: ${def}`);
});

test('draw_tickets_source_allowlist 的內容等於 DRAW_TICKET_SOURCES', async () => {
  const def = await constraintDef('draw_tickets_source_allowlist');
  const sources = [...def.matchAll(/'(\w+)'::draw_ticket_source/g)].map(m => m[1]).sort();
  assert.deepEqual(sources, [...DRAW_TICKET_SOURCES].sort(),
    `SQL 來源清單與 currency-policy.js 不一致。\nSQL: ${def}`);
});

test('currency_type enum 的值等於 CURRENCIES', async () => {
  const { rows } = await pool.query(
    `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'currency_type' ORDER BY e.enumsortorder`);
  assert.deepEqual(rows.map(r => r.v), [...CURRENCIES]);
});

test('draw_ticket_source enum 的值等於 DRAW_TICKET_SOURCES', async () => {
  const { rows } = await pool.query(
    `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'draw_ticket_source' ORDER BY e.enumsortorder`);
  assert.deepEqual(rows.map(r => r.v).sort(), [...DRAW_TICKET_SOURCES].sort());
});

test('wallet_txn 的原因搭配裡，draw_tickets 沒有 exchange_in、game_coins 沒有 exchange_out', async () => {
  const def = await constraintDef('wallet_txn_reason_matches_currency');
  const section = (currency) => {
    const m = def.match(new RegExp(`WHEN '${currency}'::currency_type THEN([\\s\\S]*?)(?:WHEN '|END)`));
    assert.ok(m, `約束定義中找不到 ${currency} 的分支`);
    return m[1];
  };
  assert.ok(!section('draw_tickets').includes("'exchange_in'"),
    'draw_tickets 不得出現 exchange_in，否則任何貨幣都能兌換成抽獎券');
  assert.ok(!section('game_coins').includes("'exchange_out'"),
    'game_coins 不得出現 exchange_out，否則遊戲幣就有了出口');
  assert.ok(!section('topup_points').includes("'exchange_in'"),
    'topup_points 不得出現 exchange_in，否則出現換現路徑');
});
