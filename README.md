# 黑貓天堂

放置 RPG 的帳號、雲端存檔、GM 管理與玩家交易版本。

[遊戲入口](https://game.barron-ai.com/) · [GM 管理台](https://game.barron-ai.com/gm) · [CLI 說明](cli/README.md)

## 目前功能

- **帳號與存檔**：註冊、登入、scrypt 密碼雜湊、HttpOnly 工作階段、每帳號八個角色欄位、雲端同步、單一操作視窗與版本衝突處理。
- **GM 管理**：線上及離線玩家增益、死亡、復活、物品發放、權限管理與操作稽核。可調整經驗、金幣、掉落倍率、地圖開放與進入等級、全體傳送、掉落率顯示與每隻怪物的物品掉落率。
- **藍鑽商店**：由 GM 發放帳號共用藍鑽；更名卡 3,000 藍鑽、更改密碼卡 500 藍鑽、全狀態 300 藍鑽／1 小時。全狀態套用至選定角色，重複購買延長時間、離線照常倒數。線上版匯出為唯讀角色報告，停用角色匯入及免費更名。
- **玩家交易所**：玩家以藍鑽或金幣上架物品，成交收取 20% 系統手續費（不足一枚進位）；支援物品託管、購買、下架與金幣收入領取。
- **聊天與通知**：世界聊天、線上人數及名單、傳說／遺物裝備掉落跑馬燈。GM 可管理 AI 聊天內容、角色、回覆玩家與生成頻率，支援本機 Ollama、Codex CLI 或伺服器模型 API。玩家介面統一顯示角色名稱及在線總人數；模型資訊與生成紀錄僅供 GM 管理。
- **手機介面**：冒險／角色／背包／狀態／日誌分頁、戰場下方即時傷害與掉寶日誌、獨立狀態倒數、大格背包與可捲動面板。帳號、在線人數與聊天整合進冒險地圖框，桌面地圖選擇位於左欄。
- **自動販賣規則**：預設列出背包物品，可搜尋、分類及複選，一次設為永遠保留或永遠販賣；支援全選目前清單，儲存後生效。鎖定、不可販賣及系統保護物品仍受保護。
- **遊戲 CLI**：王族、法師、妖精、騎士可使用獨立帳號背景遊玩，支援手動操作、原版戰鬥計時、策略與雲端同步。

多人功能包括聊天、在線狀態、玩家交易與 GM 指令同步。戰鬥、原版 NPC 血盟、競技場與攻城仍由客戶端模擬，尚未改為真人共享戰場或完整伺服器防作弊架構。

## 本機執行

需要 **Node.js 24.15.0 以上**。伺服器使用 Node.js 內建 SQLite，沒有第三方伺服器依賴。

```sh
git clone --depth 1 https://github.com/Barron486/blackcat-paradise.git
cd blackcat-paradise
npm start
```

1. 首次開啟 `http://localhost:8787/setup` 建立 GM 帳號，密碼至少 12 字。
2. 遊戲入口為 `http://localhost:8787/`，管理入口為 `http://localhost:8787/gm`。
3. 一般玩家在登入頁建立自己的帳號。

首次 GM 網頁設定只允許伺服器本機連線，已有 GM 後自動關閉。沒有預設正式帳密。帳號、存檔及設定保存在 `data/`，不納入 Git。

### CLI 與測試

CLI 及部分測試使用 JSDOM，需另安裝其鎖定依賴：

```sh
npm ci --prefix cli --no-audit --no-fund
npm run cli -- help
node --test --test-concurrency=1 test/*.test.mjs
```

本版 **157 項測試通過**，涵蓋帳號隔離、CSRF、GM 權限、存檔衝突、升級保存、藍鑽與卡片、交易重試及原子性、自動販賣複選與物品保護、CLI、AI 聊天、世界設定與掉寶廣播。測試使用隔離資料庫。

需要瀏覽器測試時，可執行 `node test/manual-server.mjs` 啟動 `http://localhost:8790/login`。測試帳號和密碼見該檔，資料只存在記憶體，不連正式站。

## Railway 部署

儲存庫包含 `Dockerfile` 與 `railway.json`。Docker 建置會從固定上游提交下載遊戲素材，再加入本版本的遊戲與伺服器程式。

1. 在 Railway 建立專案與 Service，連接本儲存庫的預設分支。
2. 掛載持久 **Volume 至 `/data`**。
3. 使用**單一副本、單一區域**；此版本以 SQLite 及持久磁碟儲存資料。
4. 設定 Networking 的目標連接埠為 `8787`，產生網址或新增自訂網域。
5. 部署後先註冊自己的帳號，再於 Railway 伺服器終端執行 `node server/promote-gm.mjs 你的帳號`。

| 環境變數 | 用途 |
| --- | --- |
| `HOST` | Docker 預設 `0.0.0.0` |
| `PORT` | Docker 預設 `8787`，須與 Networking 一致 |
| `DATA_DIR` | Docker 預設 `/data`，必須位於 Volume |
| `PUBLIC_ORIGIN` | 自訂網域的 HTTPS origin，例如 `https://game.example.com`；驗證完成後設定，不附加路徑 |
| `RAILWAY_PUBLIC_DOMAIN` | Railway 自動提供，未設 `PUBLIC_ORIGIN` 時使用 |
| `OPENAI_API_KEY` | 僅使用伺服器模型 API 聊天模式時需要；於 Railway 私密變數設定 |

Railway 未掛載 Volume 時，程式會拒絕啟動。健康檢查為 `/healthz`。

亦可從本目錄使用 Railway CLI 上傳。`railway ssh -- node server/promote-gm.mjs 你的帳號` 必須在部署容器內執行；`railway run` 在本機執行，不會修改雲端資料庫。

目前遊戲使用 `game.barron-ai.com`，根網域 `barron-ai.com` 保留原網站。部署自己的副本時，請設定自己的網域及 GM，不會繼承正式站的帳號或資料。

## 備份

在執行遊戲的伺服器上執行：

```sh
npm run backup
```

一致性備份保存在資料目錄的 `backups/`。請另行下載保存；同一 Volume 內的副本無法防止整個 Volume 遺失。SQLite 運作中可能有 WAL／SHM 檔，不要只複製主資料庫作為備份。

復原前先停止服務並保留現有資料目錄副本，再以備份還原 `game.sqlite`，移開舊 WAL／SHM 後重新啟動。資料會回到備份時間點。

## 功能文件

- [玩家交易所、20% 手續費與同步](deploy/PLAYER-MARKET.md)
- [藍鑽、卡片與角色匯入限制](deploy/BLUE-DIAMONDS.md)
- [GM 世界設定、地圖與掉落表](deploy/WORLD-SETTINGS.md)
- [世界聊天與本機 Ollama](deploy/CHAT-OLLAMA.md)
- [掉寶廣播與裝備分類](deploy/LOOT-BROADCASTS.md)
- [CLI、背景遊玩與 AI bridge](cli/README.md)

## 來源與素材

以 [shines871/idle-lineage-class](https://github.com/shines871/idle-lineage-class) v3.8.34 為基礎，上游提交 `b3fb21ce1960954adbbfcaa8f6dde9c8642d208b`。保留原始來源及權利聲明，素材與授權資訊見 [credits](online/credits.html)。遊戲圖片與音樂仍屬原權利方；本版本不新增原素材授權。

正式帳密、玩家資料庫、CLI profiles、AI bridge 憑證、SSH 金鑰及內部維運紀錄不包含在此儲存庫。
