-- =============================================================================
-- 006 餘額守衛改為不可偽造
--
-- 005 用 app.ledger_apply 這個 GUC 當「現在是帳本在寫」的旗標。問題是
-- GUC 任何連線都能自己設：
--
--   BEGIN;
--   SELECT set_config('app.ledger_apply', '1', true);
--   UPDATE draw_tickets SET balance = balance + 500000;   -- 守衛直接放行
--   COMMIT;
--
-- 等於守衛只擋「不知道有這個旗標的人」，那不是防線。
--
-- 改用 pg_trigger_depth()：它回報目前的觸發器巢狀層數，由 Postgres 維護，
-- SQL 端無法設定。
--   直接寫餘額表  → 守衛觸發器本身是第 1 層 → 深度 1 → 拒絕
--   經由帳本寫入  → wallet_txn 觸發器是第 1 層，它內部的 UPDATE 讓守衛成為
--                   第 2 層 → 深度 ≥2 → 放行
-- =============================================================================

CREATE OR REPLACE FUNCTION reject_direct_balance_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 深度 1 代表這個 UPDATE 是外部直接下的；只有帳本觸發器內部的寫入才會有更深的層數。
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION
      'balance_not_derived_violation: % 的餘額只能經由 wallet_txn 異動，不得直接寫入', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 購買紀錄的證據凍結同理：原本用 GUC 判斷「餘額增加是不是帳本來的」。
CREATE OR REPLACE FUNCTION assert_topup_lot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.account_id <> OLD.account_id
     OR NEW.purchased_at <> OLD.purchased_at
     OR NEW.unit_price_twd <> OLD.unit_price_twd
     OR NEW.points_purchased <> OLD.points_purchased
     OR NEW.platform <> OLD.platform THEN
    RAISE EXCEPTION
      'topup_lot_immutable_violation: 購買紀錄的證據欄位不可修改（帳號、購買時間、單價、購買量、通路）'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.balance > OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION
      'topup_lot_immutable_violation: 未使用點數只能遞減（% → %）。要增加點數請新增一筆購買紀錄。',
      OLD.balance, NEW.balance
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 帳本觸發器不再需要設旗標。
CREATE OR REPLACE FUNCTION apply_txn_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_balance bigint;
BEGIN
  -- 格式不對的列直接放行，交給 CHECK 約束報錯。
  -- 這個觸發器是 BEFORE，比 CHECK 早跑；若在這裡先爆掉，使用者會看到
  -- 一個跟真正問題無關的訊息。
  IF (NEW.currency_type = 'draw_tickets'  AND NEW.ticket_source IS NULL)
  OR (NEW.currency_type = 'game_coins'    AND NEW.coin_bucket   IS NULL)
  OR (NEW.currency_type = 'topup_points'  AND NEW.topup_lot_id  IS NULL) THEN
    RETURN NEW;
  END IF;

  IF NEW.currency_type = 'topup_points' THEN
    UPDATE topup_points
       SET balance = balance + NEW.delta
     WHERE id = NEW.topup_lot_id AND account_id = NEW.account_id
    RETURNING balance INTO new_balance;
    IF new_balance IS NULL THEN
      RAISE EXCEPTION
        'ledger_apply_violation: 找不到帳號 % 名下的購買紀錄 %', NEW.account_id, NEW.topup_lot_id
        USING ERRCODE = 'restrict_violation';
    END IF;

  ELSIF NEW.currency_type = 'game_coins' THEN
    INSERT INTO game_coins (account_id) VALUES (NEW.account_id)
      ON CONFLICT (account_id) DO NOTHING;
    IF NEW.coin_bucket = 'paid_derived' THEN
      UPDATE game_coins SET paid_derived_balance = paid_derived_balance + NEW.delta
       WHERE account_id = NEW.account_id
      RETURNING paid_derived_balance INTO new_balance;
    ELSE
      UPDATE game_coins SET granted_balance = granted_balance + NEW.delta
       WHERE account_id = NEW.account_id
      RETURNING granted_balance INTO new_balance;
    END IF;

  ELSE   -- draw_tickets
    INSERT INTO draw_tickets (account_id, source_type) VALUES (NEW.account_id, NEW.ticket_source)
      ON CONFLICT (account_id, source_type) DO NOTHING;
    UPDATE draw_tickets SET balance = balance + NEW.delta
     WHERE account_id = NEW.account_id AND source_type = NEW.ticket_source
    RETURNING balance INTO new_balance;
  END IF;

  NEW.balance_after := new_balance;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION reject_direct_balance_write() IS
  '餘額表只能被 wallet_txn 的觸發器寫。以 pg_trigger_depth() 判斷，'
  'SQL 端無法偽造——不像 GUC 旗標，任何連線都能自己設成放行。';
