# town-of-salem-online
獵巫鎮（Salem 1692）線上版：和朋友開房間，用房號加入，瀏覽器就能玩。

規則與架構設計見 [docs/design.md](docs/design.md)。

## 專案結構

```
packages/engine/  純函式規則引擎（無 I/O），含單元測試與隨機整局模擬
apps/server/      Colyseus 遊戲伺服器：房號、計時、聊天頻道、隱藏資訊投影
apps/web/         React + Vite 前端
```

## 開發

需要 Node.js 22 以上。

```bash
npm install
npm run dev:server   # 遊戲伺服器 ws://localhost:2567
npm run dev:web      # 前端 http://localhost:5173（另開一個終端機）
```

前端預設連到「目前網址的主機:2567」，所以同一個區網的朋友用你的區網 IP 開前端就能一起玩。
要改伺服器位址，設定 `VITE_SERVER_URL`，例如 `VITE_SERVER_URL=wss://example.com npm run dev:web`。

## 登入（LINE Login）

所有玩家都必須用 LINE 登入。伺服器設定放在 `apps/server/.env`（複製 [apps/server/.env.example](apps/server/.env.example)，`.env` 不會進 git）。

### 建立 LINE Login channel

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建一個 Provider，再新增 **LINE Login** channel（App type 勾 Web app）。
2. 在 **Basic settings** 複製 `Channel ID`、`Channel secret`，填進 `.env` 的 `LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`。
3. 在 **LINE Login → Callback URL** 填入 `{PUBLIC_URL}/auth/line/callback`
   - 本機：`http://localhost:2567/auth/line/callback`
   - 上線：例如 `https://api.你的網域/auth/line/callback`
4. 若要讓朋友登入，把 channel 從 **Developing** 切到 **Published**（Developing 狀態只有 channel 管理者能登入）。
5. `AUTH_SECRET` 用 `openssl rand -hex 32` 產生。

### 本機測試

一個人要開多個視窗測試時，LINE 帳號不夠用，可以在 `.env` 設 `AUTH_DEV_LOGIN=1`，首頁會多一個「測試登入」（輸入任意名字）。
`NODE_ENV=production` 時伺服器會拒絕開啟這個選項。

## 測試

```bash
npm test             # 引擎規則測試 + 90 局隨機模擬
npm run typecheck
npm run smoke        # 伺服器以 AUTH_DEV_LOGIN=1 啟動後，用 bot 透過 WebSocket 打一整局（N=人數，預設 5）
```

## 目前範圍（MVP）

- 基本牌（紅、綠、藍、黑）、黎明黑貓、夜晚（女巫投票、警長法槌、自首）、傳染、情侶、剩兩人規則、勝負判定
- 尚未包含：15 位鎮公所角色（第二階段）
- 除了指控 35 張外，其他行動牌張數仍待對照實體卡（`packages/engine/src/cards.ts` 的 `DECK_COUNTS`）
