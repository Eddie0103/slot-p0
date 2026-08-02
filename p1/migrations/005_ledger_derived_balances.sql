-- =============================================================================
-- 005 餘額由帳本推導
--
-- CLAUDE.md 第四節：所有幣異動經 Wallet 服務、永不直接改 balance 欄位。
--
-- 到 004 為止，這句話是**服務紀律不是 schema 保證**——節點檢查（PR #1）實測
-- 可以直接 UPDATE draw_tickets 把券灌到 50 萬，帳上一筆 wallet_txn 都沒有。
-- 這份 migration 把它變成資料庫強制的事實：
--
--   1. 餘額表只能被「帳本觸發器」寫，任何其他寫入一律拒絕
--   2. 寫入 wallet_txn 時自動套用到對應的餘額桶，並回填 balance_after
--   3. 因此「餘額 = 該桶所有 delta 的總和」恆成立，且餘額不足會在
--      餘額表的 nonneg CHECK 上直接爆掉——服務層算錯也不會超扣
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 儲值點數的異動必須指到某一筆購買紀錄
--
-- 沒有這個連結，帳本無法推導 lot 餘額，退費也說不出扣了哪幾筆、各以什麼單價。
-- 節點檢查把這件事列為「判斷有分歧」，這裡採納：補上 nullable FK 並對
-- topup_points 強制。
-- -----------------------------------------------------------------------------

ALTER TABLE wallet_txn ADD COLUMN topup_lot_id uuid REFERENCES topup_points(id);

COMMENT ON COLUMN wallet_txn.topup_lot_id IS
  '這筆異動動到哪一筆購買紀錄（lot）。退費時要能說出扣了哪幾筆、各以什麼單價。';

ALTER TABLE wallet_txn ADD CONSTRAINT wallet_txn_topup_lot_required CHECK (
  (currency_type = 'topup_points') = (topup_lot_id IS NOT NULL)
);

CREATE INDEX wallet_txn_topup_lot_idx ON wallet_txn (topup_lot_id) WHERE topup_lot_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 帳本的確定性排序
--
-- created_at 用的是交易時間，同一筆交易裡的多列完全相同（例如跨桶下注的兩列、
-- 跨 lot 扣款的多列）。稽核要重播帳本就需要一個確定的先後，補一個序號。
-- -----------------------------------------------------------------------------

ALTER TABLE wallet_txn ADD COLUMN seq bigserial;

COMMENT ON COLUMN wallet_txn.seq IS
  '帳本的確定性順序。created_at 是交易時間，同一筆交易內的多列無法區分先後。';

CREATE INDEX wallet_txn_account_seq_idx ON wallet_txn (account_id, seq);

-- -----------------------------------------------------------------------------
-- 餘額表的直接寫入守衛
--
-- 只有帳本觸發器會在寫入前把 app.ledger_apply 設為 '1'，其餘一律拒絕。
-- 旗標是 transaction-local（set_config 第三個參數 true），不會外洩到其他連線。
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_direct_balance_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.ledger_apply', true), '0') <> '1' THEN
    RAISE EXCEPTION
      'balance_not_derived_violation: % 的餘額只能經由 wallet_txn 異動，不得直接寫入', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER game_coins_ledger_only
  BEFORE INSERT OR UPDATE OR DELETE ON game_coins
  FOR EACH ROW EXECUTE FUNCTION reject_direct_balance_write();

CREATE TRIGGER draw_tickets_ledger_only
  BEFORE INSERT OR UPDATE OR DELETE ON draw_tickets
  FOR EACH ROW EXECUTE FUNCTION reject_direct_balance_write();

-- topup_points 的 INSERT 是「新增一筆購買紀錄」，由服務建立，不經帳本；
-- 但餘額欄位的異動一樣只能由帳本來。
CREATE TRIGGER topup_points_balance_ledger_only
  BEFORE UPDATE ON topup_points
  FOR EACH ROW
  WHEN (NEW.balance IS DISTINCT FROM OLD.balance)
  EXECUTE FUNCTION reject_direct_balance_write();

-- 新的購買紀錄一律從 0 開始，點數由 topup_purchase 那筆帳本異動灌入。
-- 否則「餘額 = delta 總和」就不成立。
CREATE OR REPLACE FUNCTION assert_new_lot_starts_empty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance <> 0 THEN
    RAISE EXCEPTION
      'balance_not_derived_violation: 新的購買紀錄必須從 0 開始，點數由 topup_purchase 帳本異動灌入（收到 %）',
      NEW.balance
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER topup_points_new_lot_starts_empty
  BEFORE INSERT ON topup_points
  FOR EACH ROW EXECUTE FUNCTION assert_new_lot_starts_empty();

-- 004 的證據凍結觸發器原本規定「餘額只能遞減」，但帳本灌入 topup_purchase
-- 時必須能增加。改為：來自帳本的異動放行，直接寫入仍然只能遞減
-- （而直接寫入已經被上面的守衛擋掉了，這裡是第二層）。
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

  IF NEW.balance > OLD.balance
     AND coalesce(current_setting('app.ledger_apply', true), '0') <> '1' THEN
    RAISE EXCEPTION
      'topup_lot_immutable_violation: 未使用點數只能遞減（% → %）。要增加點數請新增一筆購買紀錄。',
      OLD.balance, NEW.balance
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 帳本 → 餘額
--
-- 寫入 wallet_txn 時自動套用到對應的桶，並把算出來的結果回填 balance_after。
-- 服務層不再自己算 balance_after，也算不了假的。
--
-- 觸發器名稱刻意排在 wallet_txn_conversion_leg 之後：同一事件的觸發器依名稱
-- 順序執行，驗證必須先跑完，才輪到套用餘額。
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_txn_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_balance bigint;
BEGIN
  -- 格式不對的列直接放行，交給 CHECK 約束報錯。
  -- 這個觸發器是 BEFORE，比 CHECK 早跑；若在這裡先爆掉，使用者會看到
  -- 一個跟真正問題無關的訊息（例如「找不到購買紀錄」而不是「缺少桶別」）。
  IF (NEW.currency_type = 'draw_tickets'  AND NEW.ticket_source IS NULL)
  OR (NEW.currency_type = 'game_coins'    AND NEW.coin_bucket   IS NULL)
  OR (NEW.currency_type = 'topup_points'  AND NEW.topup_lot_id  IS NULL) THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.ledger_apply', '1', true);

  IF NEW.currency_type = 'topup_points' THEN
    UPDATE topup_points
       SET balance = balance + NEW.delta
     WHERE id = NEW.topup_lot_id AND account_id = NEW.account_id
    RETURNING balance INTO new_balance;
    IF new_balance IS NULL THEN
      PERFORM set_config('app.ledger_apply', '0', true);
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

  PERFORM set_config('app.ledger_apply', '0', true);

  NEW.balance_after := new_balance;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION apply_txn_to_balance() IS
  '帳本是唯一真實來源：寫入 wallet_txn 時套用到餘額桶並回填 balance_after。'
  '餘額不足會在餘額表的 nonneg CHECK 上直接爆掉，服務層算錯也不會超扣。';

CREATE TRIGGER wallet_txn_zz_apply_balance
  BEFORE INSERT ON wallet_txn
  FOR EACH ROW EXECUTE FUNCTION apply_txn_to_balance();
