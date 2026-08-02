/**
 * 發券服務：抽獎券進帳的唯一入口。
 *
 * ── 這個檔案為什麼要單獨存在 ──────────────────────────────────────────
 *
 * CLAUDE.md 第二節：**發券的觸發條件不得讀取任何 gameplay 狀態。**
 * 不得依 game_coins 餘額、下注量、對局勝負、排名發券。破了這條，
 * 就是「幣多送券」「勝場排名換券」，等同 game_coins → draw_tickets，
 * 整個產品變成賭博。
 *
 * 這是**語意條件**，資料庫的 CHECK 約束表達不了——SQL 看得到「發了幾張券」，
 * 看不到「為什麼發」。所以守法的方式是把它變成程式結構上的事實：
 *
 *   1. 發券只走這一個函式，它的輸入參數裡沒有任何幣量、局帳、排名欄位
 *   2. 這個模組不 import wallet.js、不查 game_coins、不查 round——
 *      物理上讀不到那些數字，想違規也寫不出來
 *   3. 每一筆發券都必須帶 campaignRef，記錄是哪個活動設定觸發的，
 *      稽核可以逐筆反證與 gameplay 無關
 *
 * 第 2 點由 test/ticket-grant.test.js 掃描本檔原始碼強制執行。
 * 這不是防惡意，是防「日後有人為了方便順手加一個參數」。
 * ─────────────────────────────────────────────────────────────────────
 */
import { withTransaction } from './db.js';
import { assertDrawTicketSourceAllowed } from './currency-policy.js';

export class TicketGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TicketGrantError';
    this.code = code;
  }
}

/**
 * 發券。
 *
 * @param {object} input 刻意只有這五個欄位。要加欄位前先讀上面那段。
 * @param {string} input.accountId
 * @param {string} input.source      四種合法來源之一（白名單，預設拒絕）
 * @param {number} input.quantity    張數
 * @param {string} input.campaignRef 觸發的活動／里程碑設定識別碼，稽核用
 * @param {string} input.idempotencyKey
 */
export async function grantTickets(pool, { accountId, source, quantity, campaignRef, idempotencyKey }) {
  assertDrawTicketSourceAllowed(source);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TicketGrantError('bad_quantity', '發券張數必須是正整數');
  }
  if (!campaignRef || !String(campaignRef).trim()) {
    throw new TicketGrantError('missing_campaign_ref',
      '發券必須註明觸發的活動設定，否則稽核無法反證這張券與對局無關');
  }

  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);
    const { rows: prior } = await client.query(
      `SELECT delta, balance_after FROM wallet_txn WHERE idempotency_key = $1`, [idempotencyKey]);
    if (prior.length) {
      return { replayed: true, quantity: prior[0].delta, balance: prior[0].balance_after };
    }
    const { rows } = await client.query(
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key,
          balance_after, ticket_source, ticket_grant_ref)
       VALUES ($1, 'draw_tickets', $2, $3, $4, 0, $5, $6)
       RETURNING balance_after`,
      [accountId, quantity, source, idempotencyKey, source, String(campaignRef)]);
    return { replayed: false, quantity, balance: rows[0].balance_after };
  });
}

/** 扣券（換實體獎品）。與發券分開，避免把「發」和「扣」寫成同一個帶正負號的函式。 */
export async function redeemTicketsForPrize(pool, { accountId, source, quantity, idempotencyKey }) {
  assertDrawTicketSourceAllowed(source);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TicketGrantError('bad_quantity', '扣券張數必須是正整數');
  }
  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);
    const { rows: prior } = await client.query(
      `SELECT delta, balance_after FROM wallet_txn WHERE idempotency_key = $1`, [idempotencyKey]);
    if (prior.length) {
      return { replayed: true, quantity: -prior[0].delta, balance: prior[0].balance_after };
    }
    const { rows } = await client.query(
      `INSERT INTO wallet_txn
         (account_id, currency_type, delta, reason, idempotency_key, balance_after, ticket_source)
       VALUES ($1, 'draw_tickets', $2, 'ticket_redeem_prize', $3, 0, $4)
       RETURNING balance_after`,
      [accountId, -quantity, idempotencyKey, source]);
    return { replayed: false, quantity, balance: rows[0].balance_after };
  });
}
