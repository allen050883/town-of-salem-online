# 部署：NAS（Docker）＋ Cloudflare

```
salem.你的網域        → Cloudflare Pages（前端靜態檔）
api.salem.你的網域    → Cloudflare Tunnel → NAS 上的 Docker（遊戲伺服器）
```

- NAS 不用開任何 port，也不用固定 IP；HTTPS 由 Cloudflare 處理，WebSocket 直接走 Tunnel。
- 遊戲伺服器容器限制 256MB 記憶體、0.5 顆 CPU，實測閒置約 60MB，不會影響 NAS 上其他服務。

下面的 `salem.example.com` 請換成你的網域。

## 1. Cloudflare Tunnel

1. Cloudflare Dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**，類型選 **Cloudflared**，取名例如 `salem-nas`。
2. 安裝方式選 **Docker**，複製指令裡 `--token` 後面那串長字串，這就是 `TUNNEL_TOKEN`（不用照它的指令執行，我們用 docker compose 跑）。
3. **Public Hostname** 新增一筆：
   - Subdomain：`api.salem`，Domain：你的網域
   - Service：`HTTP`，URL：`salem:2567`
4. 儲存後 Cloudflare 會自動建立 DNS 記錄（CNAME 指到 tunnel），不用手動掛。

> 如果 NAS 上已經有在跑 cloudflared，也可以直接在那個既有 tunnel 加上述 Public Hostname，
> 並把 `deploy/docker-compose.yml` 的 `cloudflared` 服務刪掉，改用 `ports` 讓既有的 cloudflared 連得到（URL 填 `NAS的IP:25670`）。

## 2. NAS 上啟動遊戲伺服器

需要 Container Manager（Synology）或 Container Station（QNAP），並能用 SSH 執行 docker compose。

```bash
git clone https://github.com/allen050883/town-of-salem-online.git
cd town-of-salem-online/deploy
cp .env.example .env               # 填 TUNNEL_TOKEN
cp salem.env.example salem.env     # 填 LINE、網址、AUTH_SECRET
docker compose up -d --build
docker compose ps                  # salem 應該顯示 healthy
```

`salem.env`：

| 變數 | 值 |
|---|---|
| `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | LINE Developers Console 的 channel |
| `PUBLIC_URL` | `https://api.salem.example.com` |
| `WEB_ORIGINS` | `https://salem.example.com` |
| `AUTH_SECRET` | `openssl rand -hex 32` 產生 |

驗證：瀏覽器開 `https://api.salem.example.com/auth/config`，應該看到 `{"line":true,"dev":false}`。

對戰紀錄（重播）存在名為 `salem-data` 的 Docker volume（容器內的 `/app/data/replays`），重建容器或 `docker compose up -d --build` 都不會遺失。要備份的話備份這個 volume 即可。

更新版本：`git pull && docker compose up -d --build`。

## 3. Cloudflare Pages（前端）

1. Dashboard → **Workers & Pages → Create → Pages → Connect to Git**，選這個 repo。
2. 設定：
   - Production branch：`main`
   - Build command：`npm run build -w @salem/web`
   - Build output directory：`apps/web/dist`
   - 環境變數：`VITE_SERVER_URL` = `wss://api.salem.example.com`、`NODE_VERSION` = `22`
3. 部署完成後到 **Custom domains** 加上 `salem.example.com`（同一個 Cloudflare 帳號的網域會自動掛好 DNS）。

## 4. LINE Login 設定

LINE Developers Console → 你的 LINE Login channel：

- **Callback URL**：`https://api.salem.example.com/auth/line/callback`
- 把 channel 切到 **Published**，朋友才能登入（Developing 狀態只有管理者能登入）。
