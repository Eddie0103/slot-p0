# P1 Spec — 垂直切片：可長大的地基

## 目的

把 P0 驗證過的手感，架在一個**能舉證、能退費、能上架**的地基上。

P1 不是「加功能」，是**換地基**。P0 的前端 RNG 與前端餘額全部丟棄，不沿用。

---

## 範圍

**做**：帳號、三段式錢包、server 端結算、局帳、機率公告自動產生、法遵功能、一台機。

**不做**（留給 P2 之後）：多台機、大廳、美術資產、抽獎系統、IAP 串接、live-ops、社交功能。

**一台機就夠。** P1 要證明的是地基正確，不是內容豐富。

---

## 一、資料模型

### 錢包（三段式，物理隔離）

```
account
  id, created_at, status, birth_year(用於年齡閘)
  is_minor_guardian_consented  # 限制行為能力人須法定代理人同意

topup_points        # 儲值點數：真錢購買，1:1 對應金額
  account_id, balance, purchased_at, unit_price
  # 不得設使用期限。未使用者須退費。進履約保證範圍。

game_coins          # 遊戲幣
  account_id, paid_derived_balance, granted_balance, granted_expires_at
  # paid_derived = 由 topup_points 兌換而來
  # granted      = 系統贈送（贈品可設期限）
  # 兩者必須可區分，否則全部進履約保證範圍

draw_tickets        # 抽獎券（P1 只建表與累積邏輯，不做抽獎）
  account_id, balance, source_type
  # source_type 僅允許: cumulative_topup | daily_checkin | task | ad_view
  # 資料庫層加 CHECK 約束，禁止任何來自 game_coins 的路徑
```

**消耗順序（法規預設）**：扣遊戲幣時，先扣 `granted_balance`，再扣 `paid_derived_balance`。

**唯一禁止的轉換**：任何 `game_coins → draw_tickets` 的路徑。在資料層與服務層各擋一次。

### 交易與局帳

```
wallet_txn          # 所有幣異動的唯一入口
  id, account_id, currency_type, delta, reason, idempotency_key,
  balance_after, created_at
  # 永不直接 UPDATE balance 欄位，一律經此表

round               # 局帳，append-only，不可 UPDATE / DELETE
  id, account_id, machine_id, math_config_version,
  server_seed, client_seed, nonce, bet, grid_result, payout,
  created_at
  # math_config_version 是日後舉證機率的關鍵
```

---

## 二、服務邊界

- **Auth**：註冊、登入、年齡閘（輔十五級）、法定代理人同意流程、帳號刪除
- **Wallet**：所有幣異動，冪等，強一致
- **GameSession**：接收下注 → 呼叫 Math → 結算 → 寫局帳 → 回傳結果
- **Math**：吃版本化的 math config，產生盤面與賠付。**只在 server 執行**
- **Disclosure**：從 math config 自動產生對外機率公告頁
- **Audit**：局帳與 wallet_txn 的查詢介面（客訴與爭議處理用）

Client 只負責送出「我要下注 X」與播放回傳結果的動畫。**Client 不得持有任何機率資訊或計算任何結果。**

---

## 三、機率公告自動產生（不可省略）

`Disclosure` 服務讀取當前生效的 math config，輸出一個公開頁面，內容包含：

- 每個符號的出現機率（數字百分比，不得用文字描述）
- 每種中獎組合的機率與賠付
- 理論 RTP
- 加註：「此為機會中獎商品，消費者購買或參與活動不代表即可獲得特定商品」

**絕對不允許人工維護第二份機率表。** 公告頁與遊戲結算必須讀同一份 config，改 config 即改公告。

每次 config 變更產生新版本號，舊版本保留。局帳記錄該局使用的版本。

---

## 四、法遵功能清單

全部要有可操作的介面，不是條款文字：

- [ ] 7 日內解約：使用者可自助申請，系統計算未使用之 `topup_points` 餘額
- [ ] 退費流程：契約終止後 30 日內退還，可扣除必要成本（平台抽成）
- [ ] 停止營運公告機制：後台可發布，並依登錄通訊資料通知，記錄公告時間戳
- [ ] 帳號刪除：app 內入口 ＋ 外部網頁入口，真刪資料
- [ ] 契約審閱：註冊流程提供至少 3 日審閱權說明
- [ ] 年齡閘 ＋ 限制行為能力人之法定代理人同意流程
- [ ] 分級標示（輔十五級）與「不得利用遊戲賭博」警語，尺寸符合規定
- [ ] 付費內容與金額標示
- [ ] 機率公告頁（見上）

---

## 五、手感參數移植

P0 產出的參數 JSON 貼在下方，直接作為 P1 客戶端動畫層的預設值：

```json
{
  "spinUpMs": 120,
  "spinConstMs": 240,
  "spinDownMs": 260,
  "reelStaggerMs": 90,
  "bounceRatio": 0.34,
  "bounceMs": 130,
  "anticipationOn": true,
  "anticipationMs": 240,
  "winFlashMs": 170,
  "winFlashCount": 2,
  "winCountUpMs": 300,
  "autoIntervalMs": 120,
  "symbolScale": 0.88,
  "reelGapPx": 5,
  "symbolWeights": { "cherry": 50, "lemon": 8, "bell": 8, "star": 8, "gem": 7, "coin": 7 }
}
```

> **狀態：暫定，待實機確認後替換。**
> 上面這組是以模擬推導出來的節奏基準（中獎率 42.2%、理論回收率 95.0%、
> 平均 2.37 把中一次），尚未經過 spec-p0 驗收標準 1 的實機單手 50 次測試。
> Eddie 在實機調校完成後，用 P0 面板的「複製目前參數」覆蓋這一段。
>
> `symbolWeights` 只是 P0 用來體驗節奏的前端權重，**不是 P1 的 math config**。
> P1 的機率由 server 端版本化 config 決定（任務 3），並由 Disclosure 服務自動產生公告頁。
> 兩者不得互相參照，也不得由前端這份數字反推公告內容。

P1 保留調校面板，但改為**僅開發環境可見**（正式環境隱藏）。

盤面規格沿用 P0：4 欄 × 5 列，任一列 4 個相同符號即中獎。

---

## 六、驗收標準

1. 關掉客戶端 JS、直接打 API，無法影響任何一局的結果
2. 任一帳號在任一時點，可查詢「未使用之付費購買點數」的確切數字並舉證來源
3. 修改 math config 後，機率公告頁自動反映新數值，不需任何人工編輯
4. 任一局可由 `round` 表的 seed ＋ config 版本完整重現
5. 重複送出同一筆下注請求（相同冪等鍵），餘額只變動一次
6. 資料層與服務層各自阻擋一次 `game_coins → draw_tickets`，且有測試覆蓋
7. 法遵功能清單全部可操作
8. 手感與 P0 一致（同一組參數下，主觀感受無差異）

---

## 七、執行方式

**不要一次做完。** 依序分成獨立任務，每個任務跑完、驗過再進下一個：

1. 資料模型 ＋ migration ＋ 禁止箭頭的 CHECK 約束與測試
2. Wallet 服務（冪等、雙帳本、消耗順序）＋ 測試
3. Math 服務 ＋ 版本化 config ＋ Monte Carlo 驗證工具
4. GameSession ＋ 局帳 ＋ 重現工具
5. Disclosure 自動產生
6. Auth ＋ 年齡閘 ＋ 帳號刪除
7. 客戶端接上 server 結算，移植 P0 參數
8. 法遵功能清單

每個任務結束時回報：做了什麼、spec 沒明講而你自行決定的部分、你認為 spec 有矛盾或不清楚的地方。
