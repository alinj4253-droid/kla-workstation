# KLA Workstation 服务端生产镜像。
# 构建上下文必须为仓库根目录：docker build -t kla-server .

# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY server/package.json server/package.json
# pnpm store 挂 BuildKit 缓存卷：部分宿主文件系统（老内核 overlay/fuse、XFS ftype=0）
# 上 SQLite store 索引会报 disk I/O error，同时加速重复构建
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY server server
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @kla-workstation/contracts build \
  && pnpm --filter @kla-workstation/server build \
  && pnpm --filter @kla-workstation/server deploy --prod /out \
  && test -f /out/dist/server.js \
  && test -d /out/migrations

FROM node:22-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out /app
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
