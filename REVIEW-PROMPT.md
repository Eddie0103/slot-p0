# 節點檢查提示詞

用途：在每個任務結束時，找**另一個模型**（目前用 Fable 5）對這個 repo 做一次獨立審查。

寫程式的模型審自己的產出看不到自己的盲點，這個專案的失敗模式又是
「合法性只靠一條線撐著」，所以固定找第二雙眼睛。

**怎麼用**
1. 開一個新的 Claude Code session，選這個 repo，模型切成 Fable 5
2. 對它說：`先讀 REVIEW-PROMPT.md，照裡面「提示詞開始／結束」之間的內容執行。`
   （找不到檔案的話，先叫它 `git checkout claude/spec-implementation-index-h90xbm`）
3. 每次檢查前，只需要更新「本次檢查重點」與「留意見的地方」兩段

**檢查時機**：每個任務結束時各一次；另外這兩個時刻一定要做——
動任務 2（開始碰錢）之前、任何真的接上金流之前。

**檢查紀錄**

| 日期 | 範圍 | 審查者 | 審查用 PR | 結果 |
|---|---|---|---|---|
| 2026-08-02 | P0 原型 ＋ P1 任務 1 | Fable 5 | [#1](https://github.com/Eddie0103/slot-p0/pull/1) | 1 必須修 ＋ 4 應該修 ＋ 4 分歧，全部經實測重現後修正（migration 004） |

---

──── 提示詞開始 ────

你是這個專案的獨立審查者。這是節點檢查，不是要你動手改東西。

**【第一步】切到工作分支，main 是空的：**

```
git checkout claude/spec-implementation-index-h90xbm
```

**【第二步】** 讀 `CLAUDE.md`。那是專案守則，優先於任何其他文件，也優先於你自己對「social casino 該有什麼功能」的直覺。第一節紅線與第二節箭頭是整個產品合法性的支點。

再讀 `spec-p0.md`、`spec-p1.md`，然後看 `README.md` 與 `p1/README.md`。

**【背景】**

台灣市場的直屏 social casino。真錢買遊戲幣，官方不提供任何換現管道。整個產品的合法性只靠一件事撐著：玩家取得的虛擬財產不可再換取金錢或實物。

目前進度：

- P0（直屏手感原型，單一 `index.html`，純前端假餘額）已完成
- P1 第七節八個任務中，只做完任務 1（資料模型 + migration + 禁止箭頭）
- 任務 2 以後（錢包服務、Math、GameSession、Disclosure、Auth）都還沒開始

前一位工程師（Claude Opus 5）寫的東西全部在這個分支上。

**【要跑測試的話，環境要自己架】**

本專案用 PostgreSQL。容器裡通常沒有跑起來的 server：

```bash
export PATH=/usr/lib/postgresql/16/bin:$PATH
mkdir -p /var/lib/postgresql/rv && chown postgres:postgres /var/lib/postgresql/rv
su postgres -c "initdb -D /var/lib/postgresql/rv -U postgres --encoding=UTF8 --locale=C"
su postgres -c "pg_ctl -D /var/lib/postgresql/rv -o '-p 5433 -k /tmp' -l /tmp/pg.log start"
cd p1 && npm install
export PGHOST=/tmp PGPORT=5433 PGUSER=postgres PGDATABASE=slot_p1
npm run migrate && npm test
```

跑不起來也沒關係，直接讀 SQL 一樣看得出設計問題，但請說明你是讀的還是跑的。

**【本次檢查重點，照重要性排序】**

**1. 禁止箭頭有沒有漏洞（最重要）**

`CLAUDE.md` 第二節：`game_coins → draw_tickets` 是唯一禁止的箭頭，破了整個產品變賭博。另外 `topup_points` 不得有任何入向箭頭（它可退費、等同現金）。

請用攻擊者的角度重想一遍：有沒有辦法在不碰 `currency_conversion` 這張表的情況下，讓玩家用遊戲幣拿到抽獎券？例如繞過某一層、利用某個沒被約束到的欄位組合、或是未來的活動系統直接寫 `draw_tickets`。能想出一條路徑就是重大發現，請寫出具體的 SQL 或呼叫序列。

**2. 那組「最黏人」的手感參數**

使用者曾要求「偵測玩家快輸光時故意給一次中獎，讓人上癮」，前一位工程師拒絕實作，理由是實際機率必須等於公告機率（法定義務），但接著照使用者要求調出了一組「中獎頻繁、回收率 95%、session 很長」的參數，並在面板加了節奏統計工具。

這條線劃在「機率固定可公告 vs 依玩家狀態動態調整」。請獨立判斷：這條線劃得對嗎？做出來的東西有沒有實質上越過它？`CLAUDE.md` 紅線第 9 條與第五節的決策紀錄是事後補寫的，一併檢視。

**3. schema 的解讀是不是對的**

`spec-p1.md` 第一節的欄位定義很簡略，以下是前一位工程師的推論，不是 spec 明寫：

- `topup_points` 讀成「逐筆購買紀錄（lot）」，不是單一 balance
- `draw_tickets` 讀成「按來源分桶，主鍵 (帳號, 來源)」
- 新增了 spec 沒有的 `currency_conversion` 表
- 冪等鍵唯一性訂為 `(idempotency_key, currency_type)`
- `wallet_txn` 新增 `coin_bucket`，抽獎券換來的幣一律記為贈送

這些錯了要在任務 2 動工前發現，之後改就要動已上線資料。

**4. 法規對應**

`CLAUDE.md` 第三節列的義務，有哪些應該在資料層就成立卻沒做到？特別是退費舉證、履約保證的可區分性、機率揭露的可舉證性。

**5. 縱深防禦是不是真的有那麼多層**

`p1/README.md` 宣稱禁止箭頭有四道防線。請驗證每一道是不是真的獨立有效，而不是永遠被外層蓋住、實際上是空的。（測試裡有一項刻意 `DISABLE TRIGGER` 來驗證這件事，請評估那個手法夠不夠。）

**6. 前一位工程師自己列出的疑義**

在 `p1/README.md` 與 git log 的 commit message 裡。請評估他的判斷，並補上他沒注意到的。

**【不要做的事】**

- 不要修改任何檔案。這是唯讀審查，動手改會跟現有分支衝突。
- 不要建議新增功能。範圍已由 spec 定死，任務 2 以後的東西現在不該存在。
- 如果你認為 `CLAUDE.md` 的紅線或箭頭該改，寫成「需要 Eddie 裁決的意見」，不要寫成結論。那兩節是產品合法性的支點，不由任何模型單方面調整。
- 不要因為「social casino 通常都有」而建議排行榜獎勵、VIP 返利、每日轉盤、簽到送幣連動勝場之類的東西——那些多半直接踩紅線。

**【意見留在 PR 上，不要只回在對話裡】**

審查用的 PR 是 **`Eddie0103/slot-p0` 的 #1**：
https://github.com/Eddie0103/slot-p0/pull/1

請用 GitHub 工具在那個 PR 上留意見（`pull_request_review_write` 建立 pending review
→ `add_comment_to_pending_review` 逐行加註 → `submit_pending` 送出）：

- **能指到具體某一行的，就留成該行的 review comment**，不要全部塞進總結
- 留完逐行意見後，用 review 的總結欄位或一則 issue comment 寫整體結論

留在 PR 上的理由：這份程式碼之後由另一個 session 接手修，逐行的意見它能直接對應到位置；
寫在對話裡的意見會跟著那個 session 消失。

**【輸出格式】**

不管是逐行意見還是總結，都分成三類並標明類別：

1. **必須修**（會導致違法、資料錯誤、或安全問題）——每項附具體重現方式
2. **應該修**（設計缺陷、日後會痛，但不緊急）
3. **判斷有分歧**（你的看法與前一位工程師不同，但兩邊都說得通）

每一項請寫清楚：為什麼是問題、你建議怎麼處理。

**總結裡請明確寫出你檢查過但沒發現問題的部分**，例如「四道防線我逐一讀過並實際跑過，
沒有發現可繞過的路徑」。只列問題會讓人無法判斷你看了多少、哪些是真的安全。

──── 提示詞結束 ────

---

## 下次要改哪裡

- 「本次檢查重點」整段換掉，換成該次任務的內容
- 背景那段的「目前進度」更新
- **PR 編號要換成該次審查用的那個**（每個任務開一個新 PR 比較乾淨）
- 分支名稱如果換了要一起改
- 上面的檢查紀錄表補一列
