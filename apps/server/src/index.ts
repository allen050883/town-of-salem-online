import { defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { SalemRoom } from './SalemRoom';

const port = Number(process.env.PORT ?? 2567);

const server = defineServer({
  transport: new WebSocketTransport(),
  rooms: {
    salem: defineRoom(SalemRoom),
  },
});

server.listen(port).then(() => {
  console.log(`獵巫鎮伺服器啟動：ws://localhost:${port}`);
});
