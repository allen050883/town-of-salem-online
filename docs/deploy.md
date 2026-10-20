# 部署：NAS（Docker）＋ Cloudflare

```
salem.你的網域        → Cloudflare Pages（前端靜態檔）
salem-api.你的網域    → NAS 上既有的共用 Cloudflare Tunnel → NAS 上的 Docker（遊戲伺服器，host port 25670）
```

- 部署方式比照 FinPilotAsk：push 到 `main` → GitHub Actions 在 **NAS 上的 self-hosted runner** 執行 `docker build` + `docker compose up -d`。
- 不在這個專案開自己的 `cloudflared`，直接在 NAS 既有的 tunnel 新增 Public Hostname；NAS 不用開公網 port。
- 遊戲伺服器容器限制 256MB 記憶體，實測閒置約 60MB，不會影響 NAS 上其他服務。

下面的 `salem.mochigogo.fun` 請換成你的網域。

## 1. Self-hosted runner（一次性）

GitHub runner 綁 repo，需要為這個 repo 在 NAS 上另外跑一個 runner container（同 FinPilotAsk，用
[myoung34/github-runner](https://github.com/myoung34/docker-github-actions-runner)，`REPO_URL` 指到
`https://github.com/allen050883/town-of-salem-online`，label 含 `self-hosted`、`linux`，並掛 `/var/run/docker.sock`）。

## 2. GitHub Secret

Settings → Secrets and variables → Actions → New repository secret：

- 名稱 **`SALEM_ENV_FILE`**，內容就是 `deploy/salem.env` 的完整內容（部署時寫回該檔）：

| 變數 | 值 |
|---|---|
| `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | LINE Developers Console 的 channel |
| `PUBLIC_URL` | `https://salem-api.mochigogo.fun` |
| `WEB_ORIGINS` | `https://salem.mochigogo.fun` |
| `AUTH_SECRET` | `openssl rand -hex 32` 產生 |

## 3. Cloudflare Tunnel

在 NAS 既有的 tunnel 新增 **Public Hostname**：

- Subdomain：`salem-api`，Domain：你的網域
- Service：`HTTP`，URL：`http://localhost:25670`（cloudflared 以 `--network host` 執行；否則填 `http://<NAS 區網 IP>:25670`）。免費憑證只涵蓋單層子網域，所以用 `salem-api`，不要用 `api.salem`

## 4. 部署與驗證

push 到 `main`（或在 Actions 頁手動 **Run workflow**）即部署。Workflow 會：

1. 把 `SALEM_ENV_FILE` 寫成 `deploy/salem.env`
2. 在 NAS 建立 `/volume1/docker/salem/data`（uid 1000 可寫）
3. `docker compose build --no-cache` → `down` → `up -d`，再清掉舊 image

驗證：瀏覽器開 `https://salem-api.mochigogo.fun/auth/config`，應該看到 `{"line":true,"dev":false}`；NAS 上 `docker compose ps` 的 `salem` 應為 healthy。

對戰紀錄（重播）存在 NAS 的 `/volume1/docker/salem/data/replays`，重新部署不會遺失，備份這個資料夾即可。
`apps/web`、`docs`、`README.md` 的變更不會觸發後端部署。

手動部署（不經 CI）：在 NAS 的 `deploy/` 資料夾 `cp salem.env.example salem.env` 填好後 `docker compose up -d --build`。

## 5. Cloudflare Pages（前端）

1. Dashboard → **Workers & Pages → Create → Pages → Connect to Git**，選這個 repo。
2. 設定：
   - Production branch：`main`
   - Build command：`npm run build -w @salem/web`
   - Build output directory：`apps/web/dist`
   - 環境變數：`VITE_SERVER_URL` = `wss://salem-api.mochigogo.fun`、`NODE_VERSION` = `22`
3. 部署完成後到 **Custom domains** 加上 `salem.mochigogo.fun`（同一個 Cloudflare 帳號的網域會自動掛好 DNS）。

## 6. LINE Login 設定

LINE Developers Console → 你的 LINE Login channel：

- **Callback URL**：`https://salem-api.mochigogo.fun/auth/line/callback`
- 把 channel 切到 **Published**，朋友才能登入（Developing 狀態只有管理者能登入）。
