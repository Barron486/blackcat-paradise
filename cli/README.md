# 黑貓天堂 CLI

用指令操作角色，或讓每個帳號在獨立的背景程序中自動遊玩。連線到現有 Railway 遊戲，使用一般玩家登入、角色控制權與雲端存檔。

## 開始使用

需要 Node.js **24.15.0 以上**。CLI 額外使用 JSDOM；遊戲伺服器本身仍沒有第三方套件依賴。

```powershell
cd blackcat-paradise
npm ci --prefix cli --no-audit --no-fund
npm run cli -- help
```

可自行建立 `royal`、`mage`、`elf`、`knight` 四個 profile，分別對應王族、法師、妖精與騎士。儲存庫不包含已建立的帳號或登入資訊。

```powershell
npm run cli -- status
npm run cli -- watch --interval 5
npm run cli -- stop --all
```

`watch` 只是觀看；按 Ctrl+C 結束觀看，角色仍繼續遊玩。`stop` 會停止角色程序並嘗試完成最後一次雲端存檔。

## 建立及啟動帳號

```powershell
npm run cli -- create --profile newknight --class knight --name 新騎士
npm run cli -- start --profile newknight
```

`create` 自動產生獨立帳號與隨機密碼；可用 `--username` 指定帳號，或用 `--server http://localhost:8787` 指定本機伺服器。預設正式站為 `https://game.barron-ai.com`。

| 職業參數 | 職業 | 額外創角配點 |
| --- | --- | --- |
| royal | 王族 | 力量 5、體質 3 |
| mage | 法師 | 智力 6、精神 6、體質 4 |
| elf | 妖精 | 敏捷 6、體質 2 |
| knight | 騎士 | 力量 2、體質 6 |

法師依原版規則有 16 點，其餘三職有 8 點。起始等級、裝備、金幣、藥水與技能書都由原版創角函式產生。

```powershell
npm run cli -- start --profile knight --duration 600
npm run cli -- pause --profile knight
npm run cli -- resume --profile knight
npm run cli -- sync --profile knight
npm run cli -- stop --profile knight
```

不指定 `--duration` 就持續執行；`--duration 600` 代表這次啟動最多 600 秒。已在執行的帳號不會重複啟動，也不會因再次 `start` 改變時間。`--manual` 以暫停自動戰鬥的狀態啟動。`pause` 暫停戰鬥和自動決策，保留連線及 GM 同步。

程序在**這台電腦**執行。關機、程序結束後不會繼續打怪，也沒有設定開機自動啟動。長時間睡眠後恢復可能失去控制權；確認 `status` 再重新 `start`。同帳號由網頁接管時，CLI 停止並保留本機檢查點；只有明確使用 `start --takeover` 才會接管其他視窗。

## 查看及手動操作

```powershell
npm run cli -- status --profile knight --json
npm run cli -- cloud --profile knight
npm run cli -- inspect inventory --profile knight
npm run cli -- inspect skills --profile mage
npm run cli -- inspect maps --profile knight
npm run cli -- inspect effects --profile knight
npm run cli -- inspect log --profile knight
```

背包列出物品 `uid`，供 `use`／`equip` 使用；地圖及技能用資料中的 `id`。狀態列表包含效果說明和剩餘時間。普通 `status` 使用最多約 2 秒前的狀態快照；`inspect` 由正在遊玩的程序即時回覆。`cloud` 直接讀取伺服器的已存角色與在線名單，可確認進度已上傳。

```powershell
npm run cli -- target training --profile knight
npm run cli -- pause --profile knight
npm run cli -- travel training --profile knight
npm run cli -- return-town --profile knight
npm run cli -- buy npc_basin potion_heal 10 --profile knight
npm run cli -- use 物品uid --profile knight
npm run cli -- equip 物品uid --profile knight
npm run cli -- cast sk_lightarrow --profile mage
npm run cli -- setting set-hp-pot 75 --profile knight
npm run cli -- setting set-auto-buy-arrow true --profile elf
npm run cli -- resume --profile knight
```

`target` 設定本次程序的自動練功地圖；手動 `travel` 只移動一次。要持續留在另一地圖，先設定 `target`，或暫停策略再操作。啟動時的預設地圖是 `training`，也可指定 `start --map 地圖id`。

`buy` 必須人在該商人的村莊，且該商人確實販售該物品、金幣足夠。施法必須已學會或由遊戲授予，仍受 MP、職業與原版施法限制。一般 `revive` 僅限正常死亡；GM 強制死亡必須由 GM 復活。

## 自動遊玩方式

- 每 100 毫秒執行原版一個 tick，使用原始命中、傷害、掉落、經驗、升級、藥水與技能規則。
- 預設去新兵修練場。HP 低於 35% 時嘗試正常返城；依背包與金幣補藥、補箭。
- 達到職業等級門檻才讀背包的技能書。只使用已學會的基本治療、保護罩與光箭；裝備可以手動選擇。
- 每約 5 秒做一次策略決策，失敗動作會延後重試。每約 3 秒同步雲端，每約 2 秒寫入本機檢查點。
- 斷線時暫停戰鬥並重試同步；控制權或登入權限失效則停止，避免兩個視窗同時操作。
- GM 發物品、增益、死亡與復活會透過現有版本衝突協定套用；保留未同步的正常遊戲進度，避免重複領取。

CLI 載入本機 `index.html` 的原版腳本，在 JSDOM 中省略繪圖及音效，由背景程序管理計時。原版戰鬥仍在客戶端計算；真人功能沿用現有的帳號、在線名單、雲端存檔及 GM 同步，沒有把原版 NPC 血盟或戰場改成真人共用戰場。

## 登入資訊與恢復

```powershell
npm run cli -- credentials --profile knight
```

這個指令會顯示該帳號的密碼。若要在瀏覽器遊玩，先 `stop` 對應角色，再使用帳密登入；網頁若仍提示控制權被占用，可選擇接管。

私密檔案位於 `data/cli/profiles/<profile>.json`，包含密碼和工作階段；`data/cli/runtime/<profile>/checkpoint.json` 保留尚未同步的存檔。`data/` 已排除 Git、Docker 和 Railway 上傳。請保留並妥善保存；不要分享整個資料夾。測試／其他獨立工作區可用 `BLACKCAT_CLI_HOME` 指定存放位置。

註冊前先保存產生的登入資訊；註冊結果若因連線中斷不確定，`start` 會嘗試使用這組帳密登入，避免遺失已建立的帳號。不要刪掉設定檔後重複註冊同名帳號。錯誤及決策紀錄位於 `runtime/<profile>/worker.log` 和 `worker-error.log`，一般狀態輸出不含密碼或 Cookie。

## AI 世界聊天 bridge

AI 世界聊天可選本機 Ollama 或 Codex CLI；Ollama 需啟動本機服務並安裝模型，Codex 模式需先完成 `codex login`。GM 設定啟用後，在 `data/cli/ai-chat/bridge.json` 放入伺服器 origin、bridge token，以及可選的 `codexBin`，再執行：

```powershell
node cli/ai-chat.mjs start
node cli/ai-chat.mjs status
node cli/ai-chat.mjs stop
```

bridge 僅產生文字，不使用工具或網路搜尋。GM → AI 聊天可指定 Ollama 網址與模型；詳見 [本機模型操作說明](../deploy/CHAT-OLLAMA.md)。

四職共用一個發言排程；GM 可設定發言間隔，每日生成上限 `0` 代表不限次數，並可開啟回覆一般玩家。訊息正文不重複加 AI／模型前綴，聊天室仍顯示 AI 身分標籤。請自行在 `/gm` 的「AI 聊天」分頁設定角色、模型與內容並啟用；本機 bridge 憑證需要另行設定，電腦須保持開機。使用 Codex 模式的用量計入自己的帳戶額度。

`bridge.json` 含只允許 AI 聊天的私密 token，已排除上傳及 Git。不要分享此檔。角色遊玩與 AI 聊天是不同程序；停止聊天不會停止練功。

## 驗證

Windows 對執行中存檔的短暫鎖定會在原子替換時有限重試，保留上一份完整檔案；永久錯誤仍回報，不會無限重試。相關單元與 CLI 整合測試共 7 項通過。

`node --test --test-concurrency=1 test/*.test.mjs`：本版完整測試 153 項通過，包含四職合法創角、連續戰鬥、雲端存檔、背景程序啟停、GM 權限、交易所、AI 排程／取消／驗證、介面設定與 CLI 生成。測試使用隔離資料庫，不操作正式玩家。
