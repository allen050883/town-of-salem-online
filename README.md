# town-of-salem-online
獵巫鎮（Salem 1692）線上版：和朋友開房間，用房號加入，瀏覽器就能玩。

規則與架構設計見 [docs/design.md](docs/design.md)。

## 功能

- 基本牌（紅、綠、藍、黑）、黎明黑貓、夜晚（女巫投票、警長法槌、自首）、傳染、情侶、剩兩人規則、勝負判定
- 15 位鎮公所角色（房主可在大廳關掉），以及「多一張女巫牌」的進階變體
- 電腦玩家：首頁按「單人遊戲」直接和 4 位電腦開局，或由房主在大廳加入／移除。電腦只根據自己座位看得到的資訊做決定，不會偷看
- 觀戰：遊戲進行中加入的人自動觀戰；觀戰者只看得到公開資訊，可以和亡者聊天
- 斷線重連：重新整理或短暫斷線都會回到原座位；斷線玩家輪到時，系統 5 秒後代為行動
- 對戰紀錄與重播：每場結束自動存檔，可逐步播放、切換成任一玩家的視角，或下載 JSON
- 語音聊天（WebRTC）：閉眼時只有女巫互相聽得到，亡者和觀戰者只和彼此說話
- 手機版面

## 專案結構

```
packages/engine/  純函式規則引擎（無 I/O），含單元測試與隨機整局模擬
apps/server/      Colyseus 遊戲伺服器：房號、計時、聊天頻道、隱藏資訊投影、對戰紀錄
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

## 部署（單一連接埠）

```bash
npm run build        # 建置前端到 apps/web/dist
npm start            # 伺服器同時提供前端與 WebSocket：http://localhost:2567
```

- `PORT`：連接埠（預設 2567）
- `REPLAY_DIR`：對戰紀錄存放位置（預設 `apps/server/data/replays`）
- 語音需要麥克風權限，瀏覽器只在 `https` 或 `localhost` 下允許。目前只用公開的 STUN 伺服器，
  沒有 TURN，所以在部分嚴格的公司或行動網路下語音可能連不上（文字聊天不受影響）。

## 測試

```bash
npm test             # 引擎規則測試、角色測試 + 180 局隨機模擬（含角色與進階變體）
npm run typecheck
npm run smoke        # 伺服器啟動後，用 bot 透過 WebSocket 打一整局，含觀戰、斷線重連與重播驗證
                     # N=人數（預設 5），ROLES=0 關閉角色
```

## 尚待確認

- 行動牌張數：除了指控 35 張外，其他牌的張數還沒對照實體卡（`packages/engine/src/cards.ts` 的 `DECK_COUNTS`）。
  網路上的元件表都寫 59 張行動牌，目前設定加起來是 58 張，差 1 張。
