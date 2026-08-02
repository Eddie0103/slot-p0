# P1 任務 1：資料模型與 migration

對應 `spec-p1.md` 第七節第 1 項：資料模型、migration、以及禁止箭頭
（`game_coins → draw_tickets`）的 CHECK 約束與測試。

**本目錄只有資料層。** Wallet、Math、GameSession、Disclosure、Auth 屬於任務 2 之後，
尚未開始。唯一的例外是 `src/currency-policy.js`，說明見下。

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
npm test                 # 41 項測試
```

---

## 檔案

| 路徑 | 內容 |
|---|---|
| `migrations/001_wallet_and_ledger.sql` | 帳號、三段式錢包、兌換白名單、交易帳、局帳 |
| `migrations/002_immutability_and_leg_guards.sql` | append-only 觸發器、兌換腳一致性觸發器 |
| `src/currency-policy.js` | 允許箭頭的唯一真實來源＋服務層守門函式 |
| `src/migrate.js` | migration 執行器 |
| `src/db.js` | 連線設定 |
| `test/forbidden-arrow.test.js` | 禁止箭頭的資料層與服務層測試 |
| `test/policy-sync.test.js` | SQL 與 JS 兩份白名單的防漂移測試 |
| `test/schema-guards.test.js` | 期限、隔離、append-only、冪等、餘額等約束 |
| `test/migration.test.js` | migration 執行器本身 |

---

## 禁止箭頭擋在哪裡

`game_coins → draw_tickets`（CLAUDE.md 第二節）在四個地方被擋，任何一層單獨都足以阻斷：

| # | 位置 | 機制 |
|---|---|---|
| 1 | `currency_conversion.currency_conversion_allowlist` | 白名單 CHECK，只有 `topup_points→game_coins`、`draw_tickets→game_coins` 兩組可寫入 |
| 2 | `draw_tickets.draw_tickets_source_allowlist` | 券的來源只能是四種消費或行為，與 `game_coins` 無關 |
| 3 | `wallet_txn.wallet_txn_reason_matches_currency` | `draw_tickets` 沒有 `exchange_in`、`game_coins` 沒有 `exchange_out` |
| 4 | `wallet_txn_conversion_leg` 觸發器 | 兌換的腳必須與表頭的幣別相符 |

服務層在 `src/currency-policy.js`：`assertConversionAllowed()` 與
`assertDrawTicketSourceAllowed()`，兩者都是白名單、預設拒絕。

同一套白名單也擋下 `任何貨幣 → topup_points`。儲值點數可退費、等同現金，
任何流入路徑都是 CLAUDE.md 第一節紅線 1 的換現出口，即使 spec 沒有明列。

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
  正式部署應另外以角色收回 `round`、`wallet_txn` 的 `UPDATE`／`DELETE` 權限。
