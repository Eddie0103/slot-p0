/**
 * 貨幣政策：允許的兌換箭頭，全專案唯一真實來源。
 *
 * 為什麼要有這個檔：CLAUDE.md 第四節「絕不人工維護第二份表」。
 * 資料層的 CHECK 約束（migrations/001）與服務層的守門函式必須永遠一致，
 * 因此白名單只寫一次在這裡，SQL 那份由 test/policy-sync.test.js 比對是否漂移。
 *
 * CLAUDE.md 第二節：
 *   允許  topup_points → game_coins
 *   允許  累計儲值金額 → draw_tickets（不是貨幣兌換，是里程碑贈獎，不走這裡）
 *   允許  draw_tickets → game_coins
 *   禁止  game_coins → draw_tickets   ← 唯一禁止的箭頭，破了整個產品變賭博
 */

/** 三段式貨幣。順序與資料庫 enum currency_type 一致。 */
export const CURRENCIES = Object.freeze(['topup_points', 'game_coins', 'draw_tickets']);

/**
 * 允許的貨幣兌換箭頭。**白名單，預設拒絕。**
 * 不在這張表上的組合一律不成立，包含未來新增的貨幣。
 */
export const ALLOWED_CONVERSIONS = Object.freeze([
  // 玩家真的付過錢 → 落付費衍生桶
  Object.freeze({ from: 'topup_points', to: 'game_coins', targetBucket: 'paid_derived' }),
  // 促銷贈獎，玩家沒付過錢 → 落贈送桶。理由見 CLAUDE.md 第五節。
  Object.freeze({ from: 'draw_tickets', to: 'game_coins', targetBucket: 'granted' }),
]);

/** 遊戲幣的兩個桶。付費衍生與贈送必須可區分，否則全部進履約保證範圍。 */
export const COIN_BUCKETS = Object.freeze(['paid_derived', 'granted']);

/**
 * 抽獎券的合法來源。與資料庫 enum draw_ticket_source 及
 * draw_tickets_source_allowlist CHECK 一致。
 * 這四種都與「消費或行為」綁定，與對局勝負、與 game_coins 餘額完全無關。
 */
export const DRAW_TICKET_SOURCES = Object.freeze([
  'cumulative_topup',   // 累計儲值金額達標
  'daily_checkin',      // 每日簽到
  'task',               // 任務
  'ad_view',            // 觀看廣告
]);

/** 明確列出的禁止箭頭，僅供錯誤訊息與稽核使用；實際攔阻靠白名單。 */
export const FORBIDDEN_CONVERSIONS = Object.freeze([
  Object.freeze({
    from: 'game_coins', to: 'draw_tickets',
    reason: 'CLAUDE.md 第二節：唯一禁止的箭頭。不能用幣買券、不能幣多送券、不能勝場排名換券。',
  }),
  Object.freeze({
    from: 'game_coins', to: 'topup_points',
    reason: 'CLAUDE.md 第一節紅線 1：儲值點數可退費（等同現金），任何流入路徑都構成換現出口。',
  }),
  Object.freeze({
    from: 'draw_tickets', to: 'topup_points',
    reason: 'CLAUDE.md 第一節紅線 1：同上，抽獎券亦不得回流為可退費的儲值點數。',
  }),
]);

/** 兌換是否被允許。白名單比對，任何未列出的組合都是 false。 */
export function isConversionAllowed(from, to) {
  return ALLOWED_CONVERSIONS.some(c => c.from === from && c.to === to);
}

/**
 * 服務層守門：不允許就丟錯。
 * 任何要異動兩種貨幣的服務（Wallet、活動、後台調整）都必須先過這裡。
 * @throws {ForbiddenConversionError}
 */
export function assertConversionAllowed(from, to) {
  if (isConversionAllowed(from, to)) return;
  const known = FORBIDDEN_CONVERSIONS.find(c => c.from === from && c.to === to);
  throw new ForbiddenConversionError(from, to, known ? known.reason : '不在允許的兌換白名單上。');
}

/**
 * 某條兌換箭頭換來的遊戲幣該落在哪個桶。
 * 桶別由來源貨幣決定，不由呼叫端指定——資料層的觸發器會再驗一次。
 * @returns {'paid_derived'|'granted'}
 * @throws {ForbiddenConversionError} 兌換本身就不被允許時
 */
export function targetBucketFor(from, to) {
  const c = ALLOWED_CONVERSIONS.find(x => x.from === from && x.to === to);
  if (!c) assertConversionAllowed(from, to);
  return c.targetBucket;
}

/** 抽獎券來源是否合法。 */
export function isDrawTicketSourceAllowed(source) {
  return DRAW_TICKET_SOURCES.includes(source);
}

/**
 * 服務層守門：抽獎券來源。
 * 這是禁止箭頭在服務層的第二道——就算兌換那條路被繞過，
 * 只要券的來源說不出是這四種之一，就發不出來。
 * @throws {ForbiddenDrawTicketSourceError}
 */
export function assertDrawTicketSourceAllowed(source) {
  if (isDrawTicketSourceAllowed(source)) return;
  throw new ForbiddenDrawTicketSourceError(source);
}

export class ForbiddenConversionError extends Error {
  constructor(from, to, reason) {
    super(`禁止的貨幣兌換：${from} → ${to}。${reason}`);
    this.name = 'ForbiddenConversionError';
    this.from = from;
    this.to = to;
  }
}

export class ForbiddenDrawTicketSourceError extends Error {
  constructor(source) {
    super(`禁止的抽獎券來源：${source}。合法來源僅限 ${DRAW_TICKET_SOURCES.join('、')}。`);
    this.name = 'ForbiddenDrawTicketSourceError';
    this.source = source;
  }
}
