# P1 任務 1～2：資料層與 Wallet 服務

對應 `spec-p1.md` 第七節第 1、2 項。

**Math、GameSession、Disclosure、Auth（任務 3 以後）尚未開始。**

---

## 怎麼跑

需要 PostgreSQL 14 以上（開發用 16）。連線走標準 libpq 環境變數，
不把任何連線字串寫進 Git：

```bash
export PGHOST=/var/run/postgresql   # 或 localhost
export PGPORT=5432
export PGUSER=postgres
export PGDATABASE=slot_p1           # 不存在會自動建立

npm install
npm run migrate          # 套用所有未套用的 migration
npm run migrate:status   # 列出已套用與待套用
npm test                 # 91 項測試
```

---

## 檔案

| 路徑 | 內容 |
|---|---|
| `migrations/001_wallet_and_ledger.sql` | 帳號、三段式錢包、兌換白名單、交易帳、局帳 |
| `migrations/002_immutability_and_leg_guards.sql` | append-only 觸發器、兌換腳一致性觸發器 |
| `migrations/003_coin_bucket.sql` | 遊戲幣桶別（付費衍生／贈送），桶別由來源貨幣強制 |
| `migrations/004_review_fixes.sql` | 節點檢查（PR #1）的修正：TRUNCATE、退費證據凍結、冪等索引、發券來源 |
| `migrations/005_ledger_derived_balances.sql` | 餘額改由帳本推導，直接寫餘額表一律拒絕 |
| `src/wallet.js` | Wallet 服務：儲值、兌換、下注、派彩、贈送、查餘額 |
| `src/ticket-grant.js` | 發券服務。刻意與 wallet 分離，物理上讀不到 gameplay 狀態 |
| `src/currency-policy.js` | 允許箭頭的唯一真實來源＋服務層守門函式 |
| `src/migrate.js` | migration 執行器 |
| `src/db.js` | 連線設定 |
| `test/forbidden-arrow.test.js` | 禁止箭頭的資料層與服務層測試 |
| `test/policy-sync.test.js` | SQL 與 JS 兩份白名單的防漂移測試 |
| `test/schema-guards.test.js` | 期限、隔離、append-only、冪等、餘額等約束 |
| `test/coin-bucket.test.js` | 遊戲幣桶別的資料層與服務層測試 |
| `test/wallet.test.js` | 冪等、消耗順序、先進先出、派彩桶別 |
| `test/ticket-grant.test.js` | 發券服務，含「原始碼不得提及 gameplay 狀態」的結構測試 |
| `test/review-fixes.test.js` | 節點檢查修正的驗證 |
| `test/migration.test.js` | migration 執行器本身 |

---

## 禁止箭頭擋在哪裡

`game_coins → draw_tickets`（CLAUDE.md 第二節）在箭頭可能經過的**每一張表**都設了攔阻點，
防線橫跨整條流程。四層分佈在三張表，各擋不同的資料形狀，彼此互補而非重複：

> 修正紀錄：這裡原本寫「任何一層單獨都足以阻斷」，節點檢查（PR #1）指出那是誇大——
> 實測只拆掉第 1 層，違法的兌換表頭就寫得進去，2／3／4 層對它毫無作用。
> 真正互為冗餘的只有 `wallet_txn` 上的第 3＋4 層，也正是「拆掉觸發器」那個測試驗證的那一對。


| # | 位置 | 機制 |
|---|---|---|
| 1 | `currency_conversion.currency_conversion_allowlist` | 白名單 CHECK，只有 `topup_points→game_coins`、`draw_tickets→game_coins` 兩組可寫入 |
| 2 | `draw_tickets.draw_tickets_source_allowlist` | 券的來源只能是四種消費或行為，與 `game_coins` 無關 |
| 3 | `wallet_txn.wallet_txn_reason_matches_currency` | `draw_tickets` 沒有 `exchange_in`、`game_coins` 沒有 `exchange_out` |
| 4 | `wallet_txn_conversion_leg` 觸發器 | 兌換的腳必須與表頭的幣別相符 |

服務層在 `src/currency-policy.js`：`assertConversionAllowed()` 與
`assertDrawTicketSourceAllowed()`，兩者都是白名單、預設拒絕。

同一套白名單也擋下 `任何貨幣 → topup_points`。儲值點數可退費、等同現金，
任何流入路徑都是 CLAUDE.md 第一節紅線 1 的換現出口。

---

## 餘額是帳本的投影，不是可以直接寫的欄位

005 之後，`game_coins`、`draw_tickets`、`topup_points.balance` 都**只能**被
`wallet_txn` 的觸發器寫。任何直接 `INSERT`／`UPDATE`／`DELETE` 都會被
`balance_not_derived_violation` 拒絕。

由此得到三件事：

- 「餘額 = 該桶所有 `delta` 的總和」恆成立，有測試逐桶驗證
- `balance_after` 由資料庫回填，服務層填假值會被覆蓋
- 餘額不足會在餘額表的 nonneg CHECK 上直接爆掉——Wallet 服務算錯也不會超扣

節點檢查（PR #1）實測「可以直接把券灌到 50 萬且帳上無紀錄」，這一版關掉了。

---

## 遊戲幣的桶別

`draw_tickets → game_coins` 換來的幣一律落 `granted`（贈送桶），
`topup_points → game_coins` 換來的落 `paid_derived`（付費衍生桶）。
理由見 CLAUDE.md 第五節。

桶別**由來源貨幣決定，不由呼叫端指定**：`wallet_txn_conversion_leg` 觸發器
會比對兌換表頭的來源貨幣，謊報就丟 `coin_bucket_violation`。
這件事影響履約保證要提列多少錢，記錯是財務問題不是程式問題，所以不能只靠服務層自律。

**下注**依法規預設「先扣贈送、後扣付費」，跨桶時落兩列帳（共用冪等鍵，桶別不同）。

**派彩一律落贈送桶。** 玩家沒有為這些幣付過錢，記成付費衍生等於把它拉進
履約保證範圍。與「抽獎券換來的幣記為贈送」同理。

---

## 為什麼服務層的 policy 檔在任務 1 就出現

`src/currency-policy.js` 嚴格說屬於服務層，但它不含任何 Wallet 邏輯，
只有一份白名單常數與兩個守門函式。放在這裡的理由是
CLAUDE.md 第四節的原則：**絕不人工維護第二份，不同步即違法。**

SQL 的 CHECK 約束與 JS 的白名單如果各寫各的，遲早會有人只改一邊。
`test/policy-sync.test.js` 直接讀 `pg_get_constraintdef()` 與 JS 常數比對，
兩邊不一致就讓測試紅掉。任務 2 的 Wallet 服務直接呼叫這裡的守門函式，不再自訂一份。

---

## 刻意沒做的事

- **沒有 down migration。** 正式環境的錢包資料不允許結構回退，要修就往前加一個檔案。
- **沒有任何 `game_coins → draw_tickets` 的工具函式或測試輔助程式。**
  測試一律用原生 SQL 直接對資料庫送出違法的寫入，驗證它被擋下；
  不提供任何「幫忙組出這條路徑」的程式碼，即使只在測試中使用。
- **沒有資料庫角色權限設定。** append-only 目前靠觸發器，擁有 DDL 權限者仍可拆掉。
  正式部署應另外以角色收回 `round`、`wallet_txn`、`currency_conversion`、`topup_points`
  的 `UPDATE`／`DELETE`／**`TRUNCATE`** 三種權限。
  `TRUNCATE` 是 Postgres 可單獨授予的獨立權限，收回前兩者不會一併收掉它——
  節點檢查（PR #1）就是踩在這一點上：列級觸發器對 `TRUNCATE` 不觸發，
  修正前一句 `TRUNCATE` 就能清空整份法定稽核帳。已於 004 補上 statement 級觸發器。
- **`granted_expires_at` 只有一個時間戳。** 一個帳號若有多批期限不同的贈送幣，
  現在的 schema 表達不了。P1 不設任何贈送幣期限（欄位保留給 P2 的 live-ops），
  真的要用時得先改成分批結構。
- **贈送幣到期回收沒有排程。** `grant_expired` 這個原因存在，但沒有跑它的東西。
