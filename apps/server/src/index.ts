import { existsSync } from 'node:fs';

// Load .env before reading any environment variables (Node 21.7+ built-in)
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { defineRoom, defineServer } = await import('@colyseus/core');
const { WebSocketTransport } = await import('@colyseus/ws-transport');
const { mountAuthRoutes } = await import('./auth');
const { SalemRoom } = await import('./SalemRoom');

const port = Number(process.env.PORT ?? 2567);

const server = defineServer({
  transport: new WebSocketTransport(),
  rooms: {
    salem: defineRoom(SalemRoom),
  },
  express: (app) => {
    app.set('trust proxy', true);
    mountAuthRoutes(app);
  },
});

server.listen(port).then(() => {
  console.log(`獵巫鎮伺服器啟動：http://localhost:${port}`);
});
