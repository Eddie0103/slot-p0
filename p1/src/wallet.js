/**
 * Wallet 服務：所有幣異動的唯一入口。
 *
 * CLAUDE.md 第四節：所有幣異動經 Wallet 服務、帶冪等鍵，永不直接改 balance 欄位。
 *
 * 這一層的設計前提是「不信任自己」：
 *   - 餘額由 005 的帳本觸發器推導，本服務算錯也不會寫出不一致的餘額
 *   - 餘額不足由資料庫的 nonneg CHECK 擋，不靠這裡的 if 判斷
 *   - 允許的兌換箭頭來自 currency-policy.js，與資料層讀同一份白名單
 *   - 桶別由來源貨幣決定，本服務不接受呼叫端指定
 */
import { withTransaction } from './db.js';
import { assertConversionAllowed, targetBucketFor } from './currency-policy.js';

/**
 * 兌換比率。**暫定值，待產品決定後替換。**
 * 放在這裡而不是寫死在流程裡，是為了讓「比率」成為一個可被改、可被公告的設定，
 * 而不是散落在程式中的魔術數字。
 */
export const EXCHANGE_RATES = Object.freeze({
  'topup_points→game_coins': 10,   // 1 儲值點數 → 10 遊戲幣
  'draw_tickets→game_coins': 500,  // 1 抽獎券   → 500 遊戲幣
});

export function rateFor(from, to) {
  assertConversionAllowed(from, to);
  const r = EXCHANGE_RATES[`${from}→${to}`];
  if (!r) throw new WalletError('no_rate', `${from} → ${to} 沒有設定兌換比率`);
  return r;
}

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** 餘額不足。資料庫也會擋，這個型別只是讓呼叫端好處理。 */
export class InsufficientFundsError extends WalletError {
  constructor(message) { super('insufficient_funds', message); }
}

/* ============================================================================
 * 冪等
 * ==========================================================================*/

/**
 * 以冪等鍵包住一段操作。
 *
 * 先取交易級 advisory lock，避免同一把鍵並行進來各做一次；
 * 再查帳本上有沒有這把鍵的紀錄，有就直接回放先前的結果，不重做。
 */
async function idempotent(client, key, replay, run) {
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new WalletError('bad_idempotency_key', '冪等鍵不可為空');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  const { rows } = await client.query(
    `SELECT id, currency_type, delta, reason, balance_after, coin_bucket, ticket_source,
            conversion_id, topup_lot_id
       FROM wallet_txn WHERE idempotency_key = $1 ORDER BY seq`, [key]);
  if (rows.length) return { replayed: true, ...replay(rows) };
  return { replayed: false, ...(await run()) };
}

/** 寫一筆帳。balance_after 由資料庫的帳本觸發器回填，這裡不傳。 */
async function writeTxn(client, t) {
  const { rows } = await client.query(
    `INSERT INTO wallet_txn
       (account_id, currency_type, delta, reason, idempotency_key,
        balance_after, coin_bucket, ticket_source, ticket_grant_ref, conversion_id, topup_lot_id)
     VALUES ($1,$2,$3,$4,$5, 0, $6,$7,$8,$9,$10)
     RETURNING id, balance_after`,
    [t.accountId, t.currency, t.delta, t.reason, t.idempotencyKey,
     t.coinBucket ?? null, t.ticketSource ?? null, t.ticketGrantRef ?? null,
     t.conversionId ?? null, t.topupLotId ?? null]);
  return rows[0];
}

/** 把資料庫的約束違反翻成好懂的錯誤。 */
function translate(err) {
  const m = err.message || '';
  if (err.constraint === 'game_coins_paid_nonneg' || err.constraint === 'game_coins_granted_nonneg'
      || err.constraint === 'draw_tickets_balance_nonneg'
      || err.constraint === 'topup_points_balance_in_range'
      || err.constraint === 'wallet_txn_balance_nonneg') {
    return new InsufficientFundsError('餘額不足：' + m);
  }
  return err;
}

/* ============================================================================
 * 對外操作
 * ==========================================================================*/

/**
 * 購買儲值點數。真錢進來的唯一入口。
 * 新建一筆購買紀錄（lot，餘額 0），再由帳本把點數灌進去。
 */
export async function purchaseTopup(pool, { accountId, points, unitPriceTwd, platform, idempotencyKey }) {
  if (!(points > 0)) throw new WalletError('bad_amount', '購買點數必須為正');
  return withTransaction(pool, async client =>
    idempotent(client, idempotencyKey,
      rows => ({ lotId: rows[0].topup_lot_id, points: rows[0].delta, balance: rows[0].balance_after }),
      async () => {
        const { rows } = await client.query(
          `INSERT INTO topup_points
             (account_id, unit_price_twd, points_purchased, balance, platform)
           VALUES ($1,$2,$3,0,$4) RETURNING id`,
          [accountId, unitPriceTwd, points, platform]);
        const lotId = rows[0].id;
        const txn = await writeTxn(client, {
          accountId, currency: 'topup_points', delta: points, reason: 'topup_purchase',
          idempotencyKey, topupLotId: lotId,
        });
        return { lotId, points, balance: txn.balance_after };
      }));
}

/**
 * 兌換。箭頭走 currency-policy 的白名單，目標桶由來源貨幣決定。
 *
 * 儲值點數採先進先出：從最早的購買紀錄開始扣，退費舉證才說得出扣了哪幾筆。
 */
export async function exchange(pool, { accountId, from, to, fromAmount, ticketSource, idempotencyKey }) {
  assertConversionAllowed(from, to);
  if (!(fromAmount > 0)) throw new WalletError('bad_amount', '兌換數量必須為正');
  const rate = rateFor(from, to);
  const bucket = targetBucketFor(from, to);

  return withTransaction(pool, async client => {
    try {
      return await idempotent(client, idempotencyKey,
        rows => {
          const inLeg = rows.find(r => r.reason === 'exchange_in');
          return { toAmount: inLeg.delta, conversionId: inLeg.conversion_id, coinBucket: inLeg.coin_bucket };
        },
        async () => {
          const toAmount = fromAmount * rate;
          const { rows: conv } = await client.query(
            `INSERT INTO currency_conversion
               (account_id, from_currency, to_currency, from_amount, to_amount)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [accountId, from, to, fromAmount, toAmount]);
          const conversionId = conv[0].id;

          if (from === 'topup_points') {
            await spendTopupFifo(client, {
              accountId, amount: fromAmount, reason: 'exchange_out',
              idempotencyKey, conversionId,
            });
          } else {
            await writeTxn(client, {
              accountId, currency: from, delta: -fromAmount, reason: 'exchange_out',
              idempotencyKey, conversionId, ticketSource,
            });
          }

          await writeTxn(client, {
            accountId, currency: to, delta: toAmount, reason: 'exchange_in',
            idempotencyKey, conversionId, coinBucket: bucket,
          });
          return { toAmount, conversionId, coinBucket: bucket };
        });
    } catch (e) { throw translate(e); }
  });
}

/**
 * 從儲值點數扣款，先進先出。
 * 一次兌換可能跨多筆購買紀錄，因此冪等鍵要加上 lot 序號才不會撞唯一索引。
 */
async function spendTopupFifo(client, { accountId, amount, reason, idempotencyKey, conversionId }) {
  const { rows: lots } = await client.query(
    `SELECT id, balance FROM topup_points
      WHERE account_id = $1 AND balance > 0
      ORDER BY purchased_at, id
      FOR UPDATE`, [accountId]);
  let left = amount;
  const used = [];
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, lot.balance);
    await writeTxn(client, {
      accountId, currency: 'topup_points', delta: -take, reason,
      idempotencyKey: `${idempotencyKey}#lot${used.length}`, conversionId, topupLotId: lot.id,
    });
    used.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  if (left > 0) {
    throw new InsufficientFundsError(
      `儲值點數不足：需要 ${amount}，可用 ${amount - left}`);
  }
  return used;
}

/**
 * 下注。
 *
 * 消耗順序是法規預設：**先扣贈送，後扣付費**（CLAUDE.md 第三節）。
 * 消費者先行使用無履約保證的附贈點數，這不是產品選擇，是法規預設。
 * 跨兩個桶時會落兩列帳，兩列共用同一把冪等鍵——桶別不同，不會撞索引。
 */
export async function placeBet(pool, { accountId, amount, idempotencyKey }) {
  if (!(amount > 0)) throw new WalletError('bad_amount', '下注額必須為正');
  return withTransaction(pool, async client => {
    try {
      return await idempotent(client, idempotencyKey,
        rows => ({
          fromGranted: -(rows.find(r => r.coin_bucket === 'granted')?.delta ?? 0) || 0,
          fromPaid: -(rows.find(r => r.coin_bucket === 'paid_derived')?.delta ?? 0) || 0,
        }),
        async () => {
          const { rows } = await client.query(
            `SELECT granted_balance, paid_derived_balance FROM game_coins
              WHERE account_id = $1 FOR UPDATE`, [accountId]);
          const granted = rows[0]?.granted_balance ?? 0;
          const paid = rows[0]?.paid_derived_balance ?? 0;
          if (granted + paid < amount) {
            throw new InsufficientFundsError(
              `遊戲幣不足：需要 ${amount}，可用 ${granted + paid}（贈送 ${granted}／付費 ${paid}）`);
          }
          const fromGranted = Math.min(amount, granted);
          const fromPaid = amount - fromGranted;

          if (fromGranted > 0) {
            await writeTxn(client, {
              accountId, currency: 'game_coins', delta: -fromGranted, reason: 'bet',
              idempotencyKey, coinBucket: 'granted',
            });
          }
          if (fromPaid > 0) {
            await writeTxn(client, {
              accountId, currency: 'game_coins', delta: -fromPaid, reason: 'bet',
              idempotencyKey, coinBucket: 'paid_derived',
            });
          }
          return { fromGranted, fromPaid };
        });
    } catch (e) { throw translate(e); }
  });
}

/**
 * 派彩。
 *
 * 決定：派彩一律落**贈送桶**。玩家沒有為這些幣付過錢，記成付費衍生等於
 * 把它拉進履約保證範圍，憑空增加提列負債。與「抽獎券換來的幣記為贈送」同理。
 */
export async function creditPayout(pool, { accountId, amount, idempotencyKey }) {
  if (!(amount > 0)) throw new WalletError('bad_amount', '派彩額必須為正');
  return withTransaction(pool, async client =>
    idempotent(client, idempotencyKey,
      rows => ({ amount: rows[0].delta, balance: rows[0].balance_after }),
      async () => {
        const txn = await writeTxn(client, {
          accountId, currency: 'game_coins', delta: amount, reason: 'payout',
          idempotencyKey, coinBucket: 'granted',
        });
        return { amount, balance: txn.balance_after };
      }));
}

/** 系統贈送遊戲幣。只能動贈送桶（004 的 CHECK 也會擋）。 */
export async function grantCoins(pool, { accountId, amount, idempotencyKey }) {
  if (!(amount > 0)) throw new WalletError('bad_amount', '贈送額必須為正');
  return withTransaction(pool, async client =>
    idempotent(client, idempotencyKey,
      rows => ({ amount: rows[0].delta, balance: rows[0].balance_after }),
      async () => {
        const txn = await writeTxn(client, {
          accountId, currency: 'game_coins', delta: amount, reason: 'grant',
          idempotencyKey, coinBucket: 'granted',
        });
        return { amount, balance: txn.balance_after };
      }));
}

/** 查餘額。回傳三段式貨幣的完整快照。 */
export async function getBalances(pool, accountId) {
  const [coins, tickets, topup] = await Promise.all([
    pool.query(`SELECT paid_derived_balance, granted_balance FROM game_coins WHERE account_id = $1`, [accountId]),
    pool.query(`SELECT source_type, balance FROM draw_tickets WHERE account_id = $1 ORDER BY source_type`, [accountId]),
    pool.query(
      `SELECT coalesce(sum(balance), 0)::bigint AS points,
              coalesce(sum(balance * unit_price_twd), 0)::numeric AS refundable_twd
         FROM topup_points WHERE account_id = $1`, [accountId]),
  ]);
  return {
    gameCoins: {
      paidDerived: coins.rows[0]?.paid_derived_balance ?? 0,
      granted: coins.rows[0]?.granted_balance ?? 0,
      total: (coins.rows[0]?.paid_derived_balance ?? 0) + (coins.rows[0]?.granted_balance ?? 0),
    },
    drawTickets: Object.fromEntries(tickets.rows.map(r => [r.source_type, r.balance])),
    topupPoints: {
      unused: topup.rows[0].points,
      // 驗收標準 2：任一時點可查出未使用之付費購買點數的確切數字與可退金額
      refundableTwd: Number(topup.rows[0].refundable_twd),
    },
  };
}
