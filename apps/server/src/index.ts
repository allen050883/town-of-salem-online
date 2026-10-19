import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { SalemRoom } from './SalemRoom';
import { getReplay, listReplays, loadReplays } from './replays';

const port = Number(process.env.PORT ?? 2567);
/** The built web client (npm run build -w @salem/web); served from this port too when present */
const webDist = process.env.WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

loadReplays();

const server = defineServer({
  transport: new WebSocketTransport(),
  rooms: {
    salem: defineRoom(SalemRoom),
  },
  express: (app) => {
    // The dev client runs on another port, so allow cross-origin reads of the public replay API
    app.use('/api', (_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    });
    app.get('/api/replays', (_req, res) => {
      res.json(listReplays());
    });
    app.get('/api/replays/:id', (req, res) => {
      const r = getReplay(req.params.id);
      if (!r) res.status(404).json({ error: '找不到這場對戰紀錄' });
      else res.json(r);
    });
    if (existsSync(webDist)) {
      app.use(express.static(webDist));
      console.log(`前端：http://localhost:${port}`);
    }
  },
});

server.listen(port).then(() => {
  console.log(`獵巫鎮伺服器啟動：ws://localhost:${port}`);
});
