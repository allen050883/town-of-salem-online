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

## 測試

```bash
npm test             # 引擎規則測試 + 90 局隨機模擬
npm run typecheck
npm run smoke        # 伺服器啟動後，用 bot 透過 WebSocket 打一整局（N=人數，預設 5）
```

## 目前範圍（MVP）

- 基本牌（紅、綠、藍、黑）、黎明黑貓、夜晚（女巫投票、警長法槌、自首）、傳染、情侶、剩兩人規則、勝負判定
- 尚未包含：15 位鎮公所角色（第二階段）
- 除了指控 35 張外，其他行動牌張數仍待對照實體卡（`packages/engine/src/cards.ts` 的 `DECK_COUNTS`）
