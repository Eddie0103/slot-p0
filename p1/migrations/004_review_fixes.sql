-- =============================================================================
-- 004 節點檢查（Fable 5，PR #1）的修正
--
-- 五項指控全部經實測重現，本檔逐一修正。歷史 migration 不改寫，只往前加。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1【必須修】TRUNCATE 繞過 append-only
--
-- 002 的三支觸發器是 FOR EACH ROW BEFORE UPDATE OR DELETE，而 Postgres 的
-- 列級觸發器對 TRUNCATE 不會觸發。實測 DELETE 被擋、TRUNCATE 靜默成功且清空整表。
-- 局帳、交易帳、兌換帳都是法定稽核資料，一句 TRUNCATE 就能打穿。
--
-- 另外 TRUNCATE 在 Postgres 是可用 GRANT TRUNCATE 單獨授予的權限，不是 DDL，
-- 收回 UPDATE／DELETE 不會一併收掉它，所以角色權限那條建議也不足以緩解。
-- -----------------------------------------------------------------------------

CREATE TRIGGER round_no_truncate
  BEFORE TRUNCATE ON round
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER wallet_txn_no_truncate
  BEFORE TRUNCATE ON wallet_txn
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER currency_conversion_no_truncate
  BEFORE TRUNCATE ON currency_conversion
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

COMMENT ON FUNCTION reject_mutation() IS
  '擋下 append-only 表的 UPDATE、DELETE 與 TRUNCATE。'
  '註記：擁有 DDL 權限者仍可拆掉觸發器，正式環境應另以資料庫角色收回 '
  'UPDATE／DELETE／TRUNCATE 三種權限——TRUNCATE 是獨立權限，收回前兩者不會一併收掉。';

-- -----------------------------------------------------------------------------
-- 2【應該修】退費舉證欄位可被普通 UPDATE 竄改
--
-- 退費金額要回推到購買當下的單價，而單價與購買時間只存在 topup_points 這張表
-- （wallet_txn 只記 delta 與 balance_after）。實測可把 unit_price_twd 改成
-- 0.0001、purchased_at 改成五年前，不留任何痕跡，直接改變玩家應得退費金額
-- 與履約保證提列基礎。
--
-- 這張表不能整個 append-only（balance 本來就要隨消耗遞減），所以改為凍結
-- 證據欄位、且 balance 只能往下走。
-- -----------------------------------------------------------------------------

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

  IF NEW.balance > OLD.balance THEN
    RAISE EXCEPTION
      'topup_lot_immutable_violation: 未使用點數只能遞減（% → %）。要增加點數請新增一筆購買紀錄。',
      OLD.balance, NEW.balance
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER topup_points_evidence_immutable
  BEFORE UPDATE ON topup_points
  FOR EACH ROW EXECUTE FUNCTION assert_topup_lot_immutable();

CREATE TRIGGER topup_points_no_delete
  BEFORE DELETE ON topup_points
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER topup_points_no_truncate
  BEFORE TRUNCATE ON topup_points
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- -----------------------------------------------------------------------------
-- 3【應該修】冪等索引與跨桶下注衝突
--
-- 消耗順序是「先扣贈送、後扣付費」，一次下注可能同時動到兩個桶。
-- coin_bucket 是單值欄位，因此一次下注必然拆成兩列 game_coins
-- （同貨幣、同 reason、同一次操作）。原索引 (idempotency_key, currency_type)
-- 會讓第二列撞鍵，實測 23505。
--
-- 加入 coin_bucket，並且必須加 NULLS NOT DISTINCT：coin_bucket 對
-- topup_points 與 draw_tickets 恆為 NULL，若沿用預設的 NULLS DISTINCT，
-- 同一把鍵可以重複插入兩列，反而把那兩種貨幣的冪等性靜默打掉。
-- -----------------------------------------------------------------------------

DROP INDEX wallet_txn_idempotency_uniq;

CREATE UNIQUE INDEX wallet_txn_idempotency_uniq
  ON wallet_txn (idempotency_key, currency_type, coin_bucket)
  NULLS NOT DISTINCT;

COMMENT ON INDEX wallet_txn_idempotency_uniq IS
  '同一把冪等鍵，對「同一種貨幣的同一個桶」只能落一筆。'
  '一次兌換有兩腳（幣別不同）、一次跨桶下注有兩列（桶別不同），都不會撞鍵。'
  'NULLS NOT DISTINCT 不可省略：非遊戲幣的 coin_bucket 恆為 NULL，'
  '少了它同一把鍵能重複插入，冪等性會被靜默打掉。';

-- -----------------------------------------------------------------------------
-- 4【應該修】發券旁路：帳上無法舉證某張券與 gameplay 無關
--
-- 發券合法地不經 currency_conversion（里程碑贈獎不是貨幣兌換），所以 001 針對
-- 兌換設的三道防線對發券完全無效。四種 reason 只是語意標籤，擋得住「亂填來源」，
-- 擋不住真正決定合法性的事：**發券的觸發條件必須與 game_coins 餘額、下注量、
-- 對局勝負、排名無關**——那是語意條件，schema 表達不了。
--
-- schema 能做的是讓它「可被稽核」：強制每一筆發券寫明是哪個活動／設定觸發的。
-- 現在加是零成本，等任務 2 有了上線資料再加就要回填。
-- 任務 2 導入活動設定表後，應把這個欄位改成指向該表的外鍵。
-- -----------------------------------------------------------------------------

ALTER TABLE wallet_txn ADD COLUMN ticket_grant_ref text;

COMMENT ON COLUMN wallet_txn.ticket_grant_ref IS
  '發券的觸發來源識別碼（哪一個活動／里程碑／任務設定）。'
  '用來逐筆舉證某張券與對局勝負、與 game_coins 餘額無關。'
  '任務 2 導入活動設定表後應改為外鍵。';

ALTER TABLE wallet_txn ADD CONSTRAINT wallet_txn_ticket_grant_ref_required CHECK (
  currency_type <> 'draw_tickets'
  OR delta < 0
  OR (ticket_grant_ref IS NOT NULL AND length(btrim(ticket_grant_ref)) > 0)
);

ALTER TABLE wallet_txn ADD CONSTRAINT wallet_txn_ticket_grant_ref_only_tickets CHECK (
  ticket_grant_ref IS NULL OR currency_type = 'draw_tickets'
);

-- -----------------------------------------------------------------------------
-- 5【分歧・文件】balance_after 的分桶語意未註記
-- -----------------------------------------------------------------------------

COMMENT ON COLUMN wallet_txn.balance_after IS
  '該筆異動後的結餘快照，去正規化欄位，不是餘額的重建來源。'
  '遊戲幣指的是該筆 coin_bucket 所屬那個桶的結餘；抽獎券指該 ticket_source 分桶的結餘；'
  '儲值點數指該筆購買紀錄（lot）的未使用餘額。'
  '真正的重建來源是 delta 依桶別分組加總。';
