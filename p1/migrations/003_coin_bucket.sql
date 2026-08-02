-- =============================================================================
-- 003 遊戲幣的桶別（付費衍生 / 贈送）
--
-- 決策：抽獎券換來的遊戲幣一律記為「贈送」。
--   理由見 CLAUDE.md 第五節。簡述：抽獎券本身是促銷贈獎，玩家沒有為它付過錢；
--   若把換來的幣記為付費衍生，等於自願把贈品拉進履約保證範圍，只有壞處。
--
-- 001 的 game_coins 已經把兩種餘額分成兩欄，但 wallet_txn 沒有記桶別，
-- 導致帳上無法重建那兩個欄位。這份 migration 補上，並讓桶別由資料庫強制，
-- 而不是靠服務層自己記得。
-- =============================================================================

-- 前提：本系統尚未上線，wallet_txn 沒有任何正式資料
-- （Wallet 服務屬於任務 2，尚未存在，不可能有合法的 game_coins 異動）。
-- 因此直接加上 NOT NULL 性質的 CHECK，不做回填——回填等於替既有列
-- 猜一個桶別，那會是憑空捏造的財務分類。若日後在有資料的環境套用，
-- 必須先寫一份有依據的回填腳本。

CREATE TYPE coin_bucket AS ENUM ('paid_derived', 'granted');

ALTER TABLE wallet_txn ADD COLUMN coin_bucket coin_bucket;

COMMENT ON COLUMN wallet_txn.coin_bucket IS
  '遊戲幣異動落在哪個桶。付費衍生與贈送必須可區分，否則依法全部進履約保證範圍。';

-- 遊戲幣的每一筆異動都必須說得出桶別；其他貨幣不得有桶別
ALTER TABLE wallet_txn ADD CONSTRAINT wallet_txn_coin_bucket_required CHECK (
  (currency_type = 'game_coins' AND coin_bucket IS NOT NULL)
  OR
  (currency_type <> 'game_coins' AND coin_bucket IS NULL)
);

-- 系統贈送與贈送到期回收，只能動贈送桶
ALTER TABLE wallet_txn ADD CONSTRAINT wallet_txn_grant_only_granted CHECK (
  reason NOT IN ('grant', 'grant_expired') OR coin_bucket = 'granted'
);

-- -----------------------------------------------------------------------------
-- 兌換的目標桶由來源貨幣決定，不由呼叫端指定
--
-- topup_points → game_coins   落 paid_derived（玩家真的付過錢）
-- draw_tickets → game_coins   落 granted     （促銷贈獎，玩家沒付過錢）
--
-- 這是 002 的 assert_conversion_leg() 的擴充版本。歷史 migration 不改寫，
-- 用 CREATE OR REPLACE 覆蓋函式本體。
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_conversion_leg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conv          currency_conversion%ROWTYPE;
  expected_bucket coin_bucket;
BEGIN
  IF NEW.conversion_id IS NULL THEN
    IF NEW.reason IN ('exchange_in', 'exchange_out') THEN
      RAISE EXCEPTION
        'conversion_leg_violation: reason=% 必須掛在一筆 currency_conversion 上', NEW.reason
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO conv FROM currency_conversion WHERE id = NEW.conversion_id;

  IF NEW.reason NOT IN ('exchange_in', 'exchange_out') THEN
    RAISE EXCEPTION
      'conversion_leg_violation: 掛在兌換上的異動，reason 只能是 exchange_in 或 exchange_out，收到 %',
      NEW.reason
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.reason = 'exchange_out' AND NEW.currency_type <> conv.from_currency THEN
    RAISE EXCEPTION
      'conversion_leg_violation: 來源腳幣別 % 與兌換表頭的 from_currency % 不符',
      NEW.currency_type, conv.from_currency
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.reason = 'exchange_in' THEN
    IF NEW.currency_type <> conv.to_currency THEN
      RAISE EXCEPTION
        'conversion_leg_violation: 目標腳幣別 % 與兌換表頭的 to_currency % 不符',
        NEW.currency_type, conv.to_currency
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.currency_type = 'game_coins' THEN
      expected_bucket := CASE conv.from_currency
        WHEN 'topup_points' THEN 'paid_derived'::coin_bucket
        WHEN 'draw_tickets' THEN 'granted'::coin_bucket
      END;
      IF expected_bucket IS NULL THEN
        -- 來源不在白名單上，理論上寫不到這裡；防呆用。
        RAISE EXCEPTION
          'conversion_leg_violation: 來源貨幣 % 沒有定義目標桶別', conv.from_currency
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.coin_bucket <> expected_bucket THEN
        RAISE EXCEPTION
          'coin_bucket_violation: % 兌換而來的遊戲幣必須落在 % 桶，收到 %',
          conv.from_currency, expected_bucket, NEW.coin_bucket
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
