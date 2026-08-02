-- =============================================================================
-- 001 三段式錢包、交易帳、局帳
--
-- 對應 spec-p1.md 第一節，以及 CLAUDE.md 第二節（唯一禁止的箭頭）與第三節（法規約束）。
-- 這份 migration 的核心目的不是「把欄位建出來」，而是讓違法的資料狀態
-- 在資料庫層次上寫不進去。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 列舉型別
-- -----------------------------------------------------------------------------

CREATE TYPE account_status AS ENUM ('active', 'suspended', 'deleted');

-- 三段式貨幣。與 src/currency-policy.js 的 CURRENCIES 一致。
CREATE TYPE currency_type AS ENUM ('topup_points', 'game_coins', 'draw_tickets');

-- 抽獎券的合法來源。四種都綁定「消費或行為」，與對局勝負、與 game_coins 餘額無關。
-- 注意：型別本身已限制取值，但下方 draw_tickets 仍額外加一條同名允許清單的
-- CHECK 約束。這是刻意的重複——ALTER TYPE ... ADD VALUE 很容易在日後的
-- migration 裡被加上去，多一條 CHECK 就多一道必須被明確拆掉的絆線。
CREATE TYPE draw_ticket_source AS ENUM ('cumulative_topup', 'daily_checkin', 'task', 'ad_view');

-- 幣異動的原因。哪個原因能配哪種貨幣，由 wallet_txn 的 CHECK 決定，
-- 那條 CHECK 就是禁止箭頭在交易帳層次的攔阻點。
CREATE TYPE txn_reason AS ENUM (
  'topup_purchase',       -- 真錢購買儲值點數（+ topup_points）
  'topup_refund',         -- 退費／解約（- topup_points）
  'exchange_out',         -- 兌換的來源腳（-）
  'exchange_in',          -- 兌換的目標腳（+）
  'bet',                  -- 下注（- game_coins）
  'payout',               -- 派彩（+ game_coins）
  'grant',                -- 系統贈送（+ game_coins.granted）
  'grant_expired',        -- 贈送幣到期回收（- game_coins.granted）
  'cumulative_topup',     -- 累計儲值達標發券（+ draw_tickets）
  'daily_checkin',        -- 簽到發券（+ draw_tickets）
  'task',                 -- 任務發券（+ draw_tickets）
  'ad_view',              -- 看廣告發券（+ draw_tickets）
  'ticket_redeem_prize'   -- 券換實體獎品（- draw_tickets）
);

-- -----------------------------------------------------------------------------
-- 帳號
-- -----------------------------------------------------------------------------

CREATE TABLE account (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  status                      account_status NOT NULL DEFAULT 'active',
  -- 年齡閘用（輔十五級）。只存出生年，不存完整生日，降低個資面。
  birth_year                  smallint NOT NULL,
  -- 限制行為能力人（未滿 18 歲）須法定代理人同意
  is_minor_guardian_consented boolean NOT NULL DEFAULT false,

  CONSTRAINT account_birth_year_sane CHECK (birth_year BETWEEN 1900 AND 2200)
);

COMMENT ON COLUMN account.birth_year IS
  '年齡閘用。實際的十五歲／十八歲判定需要當下時間，CHECK 約束無法使用 now()，故由 Auth 服務執行（spec-p1 任務 6）。';

-- -----------------------------------------------------------------------------
-- 儲值點數：真錢購買，1:1 對應金額
--
-- 一次購買一列（lot）。之所以不是單一 balance 欄位：
-- 驗收標準 2 要求「可查詢未使用之付費購買點數的確切數字並舉證來源」，
-- 退費金額要回推到購買當下的單價，只有逐筆保留才算得出來。
-- -----------------------------------------------------------------------------

CREATE TABLE topup_points (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES account(id),
  purchased_at     timestamptz NOT NULL DEFAULT now(),
  -- 1 點對應的新台幣金額。退費計算與履約保證提列都靠這個。
  unit_price_twd   numeric(12, 4) NOT NULL,
  points_purchased bigint NOT NULL,
  -- 未使用點數。spec 欄位名為 balance。
  balance          bigint NOT NULL,
  -- 平台通路（Apple / Google），退費時扣除必要成本需要知道抽成比例。
  platform         text NOT NULL,

  CONSTRAINT topup_points_purchased_positive CHECK (points_purchased > 0),
  CONSTRAINT topup_points_unit_price_positive CHECK (unit_price_twd > 0),
  CONSTRAINT topup_points_balance_in_range     CHECK (balance >= 0 AND balance <= points_purchased)
);

-- 刻意不設 expires_at 欄位。
-- CLAUDE.md 第三節：不得記載遊戲點數使用期限（贈品除外）。付費點數永不過期，
-- 因此「沒有這個欄位」本身就是約束；test/schema-guards.test.js 會確認它不存在。
COMMENT ON TABLE topup_points IS
  '儲值點數，逐筆購買紀錄。刻意不含任何到期欄位：法規禁止付費點數設使用期限。';

CREATE INDEX topup_points_account_unused_idx
  ON topup_points (account_id, purchased_at)
  WHERE balance > 0;

-- -----------------------------------------------------------------------------
-- 遊戲幣：付費衍生與贈送必須物理隔離
--
-- CLAUDE.md 第三節：附贈點數若與購買點數可區分則不進履約保證範圍，
-- 無法區分則全部進入。兩個欄位分開存就是「可區分」的實作。
-- -----------------------------------------------------------------------------

CREATE TABLE game_coins (
  account_id           uuid PRIMARY KEY REFERENCES account(id),
  -- 由 topup_points 或 draw_tickets 兌換而來
  paid_derived_balance bigint NOT NULL DEFAULT 0,
  -- 系統贈送。贈品可設期限。
  granted_balance      bigint NOT NULL DEFAULT 0,
  granted_expires_at   timestamptz,

  CONSTRAINT game_coins_paid_nonneg    CHECK (paid_derived_balance >= 0),
  CONSTRAINT game_coins_granted_nonneg CHECK (granted_balance >= 0)
);

COMMENT ON TABLE game_coins IS
  '遊戲幣。無任何出口：不能換回儲值點數、不能換抽獎券、不能換現。只能下注或隨贈送到期回收。';

-- -----------------------------------------------------------------------------
-- 抽獎券：唯一禁止箭頭的終點，這張表的約束最重要
--
-- 以 (帳號, 來源) 為主鍵分桶存放，而非單一 balance。
-- 這樣「這張券是怎麼來的」是資料結構本身的一部分，不是靠旁邊的紀錄推論；
-- 稽核時可以直接證明某帳號的券沒有一張來自 game_coins。
-- -----------------------------------------------------------------------------

CREATE TABLE draw_tickets (
  account_id  uuid NOT NULL REFERENCES account(id),
  source_type draw_ticket_source NOT NULL,
  balance     bigint NOT NULL DEFAULT 0,

  PRIMARY KEY (account_id, source_type),
  CONSTRAINT draw_tickets_balance_nonneg CHECK (balance >= 0),

  -- 【禁止箭頭・資料層第一道】
  -- 明列允許來源。即使日後有人在 draw_ticket_source 型別上
  -- ALTER TYPE ... ADD VALUE 'game_coins_exchange'，這條 CHECK 仍會擋下，
  -- 除非有人明確地把這條約束一起拆掉——那就會出現在 code review 的 diff 裡。
  CONSTRAINT draw_tickets_source_allowlist CHECK (
    source_type IN ('cumulative_topup', 'daily_checkin', 'task', 'ad_view')
  )
);

COMMENT ON CONSTRAINT draw_tickets_source_allowlist ON draw_tickets IS
  'CLAUDE.md 第二節唯一禁止的箭頭。抽獎券只能來自消費或行為，不得有任何來自 game_coins 的路徑。';

-- -----------------------------------------------------------------------------
-- 貨幣兌換：白名單，預設拒絕
--
-- 把「兌換」變成一張有具體列的表，而不是散落在服務裡的函式呼叫。
-- 只要兌換一定要先寫這一列，允許哪些箭頭就是一條可被資料庫檢查的事實。
-- -----------------------------------------------------------------------------

CREATE TABLE currency_conversion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id),
  from_currency currency_type NOT NULL,
  to_currency   currency_type NOT NULL,
  from_amount   bigint NOT NULL,
  to_amount     bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT currency_conversion_amounts_positive
    CHECK (from_amount > 0 AND to_amount > 0),

  -- 【禁止箭頭・資料層第二道】
  -- 白名單而非黑名單：沒列出來的組合一律不成立，包含未來新增的貨幣。
  -- 這一條同時擋下三件事：
  --   game_coins → draw_tickets （CLAUDE.md 第二節唯一禁止的箭頭）
  --   game_coins → topup_points （紅線 1：儲值點數可退費，等同換現出口）
  --   draw_tickets → topup_points（同上）
  -- 內容必須與 src/currency-policy.js 的 ALLOWED_CONVERSIONS 一致，
  -- 由 test/policy-sync.test.js 比對防止漂移。
  CONSTRAINT currency_conversion_allowlist CHECK (
    (from_currency, to_currency) IN (
      ('topup_points', 'game_coins'),
      ('draw_tickets', 'game_coins')
    )
  )
);

COMMENT ON CONSTRAINT currency_conversion_allowlist ON currency_conversion IS
  '允許的兌換箭頭白名單。game_coins 沒有任何出向箭頭，是終點不是中繼站。';

CREATE INDEX currency_conversion_account_idx ON currency_conversion (account_id, created_at);

-- -----------------------------------------------------------------------------
-- 交易帳：所有幣異動的唯一入口
--
-- CLAUDE.md 第四節：永不直接改 balance 欄位，一律經此表。
-- -----------------------------------------------------------------------------

CREATE TABLE wallet_txn (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id),
  currency_type   currency_type NOT NULL,
  delta           bigint NOT NULL,
  reason          txn_reason NOT NULL,
  idempotency_key text NOT NULL,
  balance_after   bigint NOT NULL,
  -- 屬於某次兌換的腳。非兌換的異動為 NULL。
  conversion_id   uuid REFERENCES currency_conversion(id),
  -- 抽獎券的異動必須說得出來源；其餘貨幣必須為 NULL。
  ticket_source   draw_ticket_source,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wallet_txn_delta_nonzero     CHECK (delta <> 0),
  CONSTRAINT wallet_txn_balance_nonneg    CHECK (balance_after >= 0),

  -- 【禁止箭頭・資料層第三道】
  -- 哪個原因能配哪種貨幣。三個關鍵事實藏在這張表裡：
  --   1. draw_tickets 沒有 exchange_in  → 任何貨幣都不能「兌換成」抽獎券
  --   2. game_coins   沒有 exchange_out → 遊戲幣不能成為任何兌換的來源
  --   3. topup_points 沒有 exchange_in  → 沒有任何東西能變回可退費的儲值點數
  -- 三者合起來，game_coins → draw_tickets 連一條可記帳的路徑都不存在。
  CONSTRAINT wallet_txn_reason_matches_currency CHECK (
    CASE currency_type
      WHEN 'topup_points' THEN
        reason IN ('topup_purchase', 'topup_refund', 'exchange_out')
      WHEN 'game_coins' THEN
        reason IN ('exchange_in', 'bet', 'payout', 'grant', 'grant_expired')
      WHEN 'draw_tickets' THEN
        reason IN ('cumulative_topup', 'daily_checkin', 'task', 'ad_view',
                   'ticket_redeem_prize', 'exchange_out')
    END
  ),

  -- 原因決定正負號，避免「用負的派彩去偷扣」這類記帳花招
  CONSTRAINT wallet_txn_sign_matches_reason CHECK (
    CASE
      WHEN reason IN ('topup_purchase', 'exchange_in', 'payout', 'grant',
                      'cumulative_topup', 'daily_checkin', 'task', 'ad_view')
        THEN delta > 0
      WHEN reason IN ('topup_refund', 'exchange_out', 'bet', 'grant_expired',
                      'ticket_redeem_prize')
        THEN delta < 0
    END
  ),

  -- 抽獎券的每一筆異動都必須標明來源；其他貨幣不得有來源欄位值
  CONSTRAINT wallet_txn_ticket_source_required CHECK (
    (currency_type = 'draw_tickets' AND ticket_source IS NOT NULL)
    OR
    (currency_type <> 'draw_tickets' AND ticket_source IS NULL)
  ),

  -- 發券時，reason 與 ticket_source 必須是同一件事，不能用簽到的名義記任務的券
  CONSTRAINT wallet_txn_ticket_reason_matches_source CHECK (
    currency_type <> 'draw_tickets'
    OR delta < 0
    OR reason::text = ticket_source::text
  )
);

COMMENT ON CONSTRAINT wallet_txn_reason_matches_currency ON wallet_txn IS
  'draw_tickets 無 exchange_in、game_coins 無 exchange_out、topup_points 無 exchange_in。禁止箭頭在交易帳層次沒有可記錄的形狀。';

-- 冪等鍵：同一個邏輯操作對同一種貨幣只能落一筆。
-- 一次兌換會有兩腳（來源與目標），共用同一把鍵但貨幣不同，因此鍵包含貨幣。
CREATE UNIQUE INDEX wallet_txn_idempotency_uniq
  ON wallet_txn (idempotency_key, currency_type);

CREATE INDEX wallet_txn_account_idx ON wallet_txn (account_id, created_at);
CREATE INDEX wallet_txn_conversion_idx ON wallet_txn (conversion_id) WHERE conversion_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 局帳：append-only
--
-- CLAUDE.md 第四節：局帳不可竄改，記錄該局使用的 math config 版本。
-- 不可 UPDATE / DELETE 的實作在 002。
-- -----------------------------------------------------------------------------

CREATE TABLE round (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES account(id),
  machine_id          text NOT NULL,
  -- 日後舉證「實際機率等於公告機率」的關鍵
  math_config_version text NOT NULL,
  server_seed         text NOT NULL,
  client_seed         text NOT NULL,
  nonce               bigint NOT NULL,
  bet                 bigint NOT NULL,
  -- 盤面結果。P0 規格沿用：4 欄 × 5 列。
  grid_result         jsonb NOT NULL,
  payout              bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT round_bet_positive   CHECK (bet > 0),
  CONSTRAINT round_payout_nonneg  CHECK (payout >= 0),
  CONSTRAINT round_nonce_nonneg   CHECK (nonce >= 0),

  -- 可重現性（驗收標準 4）：同一組 seed 與 nonce 只能對應一局
  CONSTRAINT round_seed_nonce_uniq UNIQUE (account_id, server_seed, client_seed, nonce)
);

CREATE INDEX round_account_idx ON round (account_id, created_at);
CREATE INDEX round_config_version_idx ON round (math_config_version);
