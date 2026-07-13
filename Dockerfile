FROM node:20 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM node:20 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3180

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY --from=builder /app/dist ./dist

# 非 root 运行：用官方 node 镜像自带的非特权 node 用户（uid 1000），缩小容器被攻破后的影响面。
# chown 整个 /app，保证 node 用户可读运行文件、并能写 tsx 编译缓存等运行时临时文件。
RUN chown -R node:node /app
USER node

EXPOSE 3180
# 生产用 tsx 直接跑 TS（tsx 已声明为 production dependency）。exec form + 后端已装 SIGTERM 优雅关闭。
CMD ["node", "--import", "tsx", "server/src/index.ts"]
