-- =============================================================================
-- 002 不可竄改性與兌換腳一致性
--
-- CHECK 約束只看得到單一列的欄位，看不到跨表關聯，也擋不住 UPDATE／DELETE。
-- 這份 migration 用觸發器補上這兩類約束。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- append-only：局帳與交易帳只進不出
--
-- CLAUDE.md 第四節：局帳 append-only、不可竄改。
-- 交易帳同理——若可事後修改，「未使用之付費購買點數」就無法舉證。
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'append_only_violation: % 為僅可新增的帳，不允許 % 操作', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION reject_mutation() IS
  '擋下 append-only 表的 UPDATE 與 DELETE。註記：擁有 DDL 權限者仍可拆掉觸發器，正式環境應另以資料庫角色收回 UPDATE/DELETE 權限。';

CREATE TRIGGER round_append_only
  BEFORE UPDATE OR DELETE ON round
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER wallet_txn_append_only
  BEFORE UPDATE OR DELETE ON wallet_txn
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER currency_conversion_append_only
  BEFORE UPDATE OR DELETE ON currency_conversion
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- -----------------------------------------------------------------------------
-- 兌換腳一致性
--
-- 【禁止箭頭・資料層第四道】
-- 前三道擋的是「單列本身合不合法」。這一道擋的是「腳與表頭對不對得起來」：
-- 就算表頭是合法的 topup_points → game_coins，也不能偷偷掛一隻
-- 別種貨幣的腳把幣搬到不該去的地方。
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_conversion_leg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conv currency_conversion%ROWTYPE;
BEGIN
  IF NEW.conversion_id IS NULL THEN
    -- 非兌換的異動，不得使用兌換專用的原因
    IF NEW.reason IN ('exchange_in', 'exchange_out') THEN
      RAISE EXCEPTION
        'conversion_leg_violation: reason=% 必須掛在一筆 currency_conversion 上', NEW.reason
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO conv FROM currency_conversion WHERE id = NEW.conversion_id;

  IF NEW.reason = 'exchange_out' AND NEW.currency_type <> conv.from_currency THEN
    RAISE EXCEPTION
      'conversion_leg_violation: 來源腳幣別 % 與兌換表頭的 from_currency % 不符',
      NEW.currency_type, conv.from_currency
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.reason = 'exchange_in' AND NEW.currency_type <> conv.to_currency THEN
    RAISE EXCEPTION
      'conversion_leg_violation: 目標腳幣別 % 與兌換表頭的 to_currency % 不符',
      NEW.currency_type, conv.to_currency
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.reason NOT IN ('exchange_in', 'exchange_out') THEN
    RAISE EXCEPTION
      'conversion_leg_violation: 掛在兌換上的異動，reason 只能是 exchange_in 或 exchange_out，收到 %',
      NEW.reason
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_txn_conversion_leg
  BEFORE INSERT ON wallet_txn
  FOR EACH ROW EXECUTE FUNCTION assert_conversion_leg();
