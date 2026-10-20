# Game server image (the frontend is deployed separately to Cloudflare Pages)
# Build: docker build -t salem-server .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @salem/server --include-workspace-root
COPY packages/engine packages/engine
COPY apps/server apps/server
RUN npm run build -w @salem/server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=2567
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @salem/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
# Finished games are saved here as replays; mount a volume on /app/data to keep them across rebuilds
ENV REPLAY_DIR=/app/data/replays
RUN mkdir -p /app/data/replays && chown -R node:node /app/data
USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/auth/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/server.mjs"]
