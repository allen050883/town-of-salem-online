# town-of-salem-online
獵巫鎮（Salem 1692）線上版：和朋友開房間，用房號加入，用 LINE 登入，瀏覽器就能玩。

規則與架構設計見 [docs/design.md](docs/design.md)，部署到 NAS＋Cloudflare 見 [docs/deploy.md](docs/deploy.md)。

## 功能

- **規則**：基本牌（紅、綠、藍、黑）、黎明黑貓、夜晚（女巫投票、警長法槌、自首）、傳染、情侶、剩兩人規則、勝負判定。牌的規則採第 5 版，只有「傳染」改成繁中版卡面的寫法：由**黑貓持有者自己選**一張審判牌翻開
- **鎮公所角色**：15 位（房主可在大廳關掉），以及「多一張女巫牌」的進階變體
- **登入**：所有玩家用 LINE 登入，名稱和頭像取自 LINE
- **插畫卡牌**：15 種行動牌都有插畫。手牌以半尺寸顯示，選中的牌在右側顯示完整大卡和效果說明；手牌多時會疊起來，再多就橫向滑動。審判牌在牌桌上是小張的字卡（巫、警、平民）
- **傳染提示**：傳染時，你左手邊的玩家會標出「你的左手邊」並圈起來，夜晚和傳染發生時行動提示旁會出現對應的插畫卡
- **電腦玩家**：首頁按「單人遊戲」直接和 4 位電腦開局，或由房主在大廳加入／移除。電腦只根據自己座位看得到的資訊做決定，不會偷看。設定 `OLLAMA_URL`、`OLLAMA_MODEL` 後，電腦改用自架的 Ollama 模型思考出牌和夜晚行動（從合法動作的選單中選），連不上或太慢時自動改回內建策略
- **觀戰**：遊戲進行中加入的人自動觀戰；觀戰者只看得到公開資訊，可以和亡者聊天
- **斷線重連**：重新整理或短暫斷線都會回到原座位；斷線玩家輪到時，系統 5 秒後代為行動
- **對戰紀錄與重播**：每場結束自動存檔，可逐步播放、切換成任一玩家的視角，或下載 JSON。重播是公開的，所以存檔前會把玩家的 LINE 識別碼換成匿名編號（p1、p2…），名字仍會顯示
- **手機版面**

## 專案結構

```
packages/engine/  純函式規則引擎（無 I/O），含單元測試與隨機整局模擬
apps/server/      Colyseus 遊戲伺服器：LINE 登入、房號、計時、聊天頻道、隱藏資訊投影、對戰紀錄
apps/web/         React + Vite 前端（含 18 張插畫卡牌 apps/web/src/art/cards.ts）
deploy/           NAS 用的 docker-compose（遊戲伺服器 + Cloudflare Tunnel）
docs/             design.md（規則與設計決定）、deploy.md（部署步驟）
Dockerfile        遊戲伺服器的映像（前端另外部署到 Cloudflare Pages）
```

## 開發

需要 Node.js 22 以上。因為所有人都要登入，本機第一次執行前要先有 `apps/server/.env`：

```bash
npm install
cp apps/server/.env.example apps/server/.env   # 預設開啟 AUTH_DEV_LOGIN=1，首頁會有「測試登入」，不用設定 LINE 就能玩
npm run dev:server   # 遊戲伺服器 http://localhost:2567
npm run dev:web      # 前端 http://localhost:5173（另開一個終端機）
```

- `.env` 裡的 `WEB_ORIGINS` 要寫成前端實際的網址。5173 埠被占用時 Vite 會自動換埠，請同步修改，否則登入後會出現「不允許的登入返回網址」。
- 前端預設連到「目前網址的主機:2567」，所以同一個區網的朋友用你的區網 IP 開前端就能一起玩。要改伺服器位址，設定 `VITE_SERVER_URL`，例如 `VITE_SERVER_URL=wss://example.com npm run dev:web`。
- 開發模式下，`http://localhost:5173/?preview=cards` 可以一次看到所有插畫卡牌（白天與夜晚）。

## 登入（LINE Login）

所有玩家都必須用 LINE 登入。伺服器設定放在 `apps/server/.env`（複製 [apps/server/.env.example](apps/server/.env.example)，`.env` 不會進 git）。

### 建立 LINE Login channel

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建一個 Provider，再新增 **LINE Login** channel（App type 勾 Web app）。
2. 在 **Basic settings** 複製 `Channel ID`、`Channel secret`，填進 `.env` 的 `LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`（secret 只放在 `.env`，不要貼到別處）。
3. 在 **LINE Login → Callback URL** 填入 `{PUBLIC_URL}/auth/line/callback`，必須和 `.env` 的 `PUBLIC_URL` 完全一致
   - 本機：`http://localhost:2567/auth/line/callback`
   - 上線：例如 `https://api.你的網域/auth/line/callback`（兩行可以同時登記）
4. 若要讓朋友登入，把 channel 從 **Developing** 切到 **Published**（Developing 狀態只有 channel 管理者能登入）。
5. `AUTH_SECRET` 用 `openssl rand -hex 32` 產生，要固定不變，否則每次重啟所有人都要重新登入。

### 本機測試

一個人要開多個視窗測試時，LINE 帳號不夠用，可以在 `.env` 設 `AUTH_DEV_LOGIN=1`，首頁會多一個「測試登入」（輸入任意名字）。
`NODE_ENV=production` 時伺服器會拒絕開啟這個選項。

## 部署

NAS（Docker）＋ Cloudflare 的完整步驟見 [docs/deploy.md](docs/deploy.md)：遊戲伺服器跑在 NAS 的 Docker 裡，用 Cloudflare Tunnel 對外，前端放 Cloudflare Pages。

也可以單一連接埠自己跑（伺服器同時提供前端與 WebSocket）：

```bash
npm run build        # 建置前端到 apps/web/dist
npm start            # http://localhost:2567
```

- `PORT`：連接埠（預設 2567）
- `OLLAMA_URL`、`OLLAMA_MODEL`（選填）：電腦玩家改用 Ollama 模型思考。Ollama 要能被伺服器連到（預設只聽本機，需設 `OLLAMA_HOST=0.0.0.0`）
- `REPLAY_DIR`：對戰紀錄存放位置。預設是執行目錄下的 `data/replays`（用 `npm start` 時是 `apps/server/data/replays`）；Docker 裡是 `/app/data/replays`，`deploy/docker-compose.yml` 已把它掛成 volume，重建容器不會遺失
- 正式環境（`NODE_ENV=production`，Docker 映像已預設）一定要設定 `AUTH_SECRET`，沒設會拒絕啟動；也不能開 `AUTH_DEV_LOGIN`

## 測試

```bash
npm test             # 53 項：規則、角色、電腦玩家、AI 候選動作，加上 180 局隨機整局模擬（含角色與進階變體）
npm run typecheck
npm run smoke        # 伺服器以 AUTH_DEV_LOGIN=1 啟動後，用 bot 透過 WebSocket 打一整局，含觀戰、斷線重連與重播驗證
                     # N=人數（預設 5），ROLES=0 關閉角色
```

## 已知限制與尚待確認

- **還沒用真的 LINE 帳號驗證登入**：開發時都用「測試登入」，它和 LINE 登入走同一套 token 與加入房間流程，但 LINE 的授權畫面和 Callback 要設定完成後才能實測。
- **還沒有實際部署到 NAS／Cloudflare**，延遲和 WebSocket 穩定度要部署後才知道。
- **行動牌張數**：除了指控 35 張外，其他牌的張數還沒對照實體卡（`packages/engine/src/cards.ts` 的 `DECK_COUNTS`）。
  目前行動牌加起來是 58 張，加上黑貓、夜晚、傳染共 61 張，與繁中版商品頁的 61 張一致；英文規則書寫 59 張行動牌，差 1 張，待確認。
- 重播 API 對所有網站開放讀取，同房玩家的名字（不含 LINE 識別碼）會被看到。
- 前端打包後有一個超過 500KB 的檔案（主要是 18 幅插畫與角色資料），功能不受影響，之後可以拆檔。
