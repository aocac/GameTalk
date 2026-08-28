# ============ GameTalk Server 构建（多阶段，面向 Linux） ============
# 产物：极小的 Node 运行时镜像，启动时自动执行数据库迁移

# ---- 阶段 1：依赖安装 + 构建 ----
FROM node:22-slim AS builder
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/migrations ./migrations
RUN npm run build

# ---- 阶段 2：生产运行时 ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
# /health 读取版本号用（createRequire('../package.json')）
COPY --from=builder /app/package.json ./package.json

# 非 root 运行
RUN groupadd -r gametalk && useradd -r -g gametalk gametalk \
  && chown -R gametalk:gametalk /app
USER gametalk

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
