# ReelShort 剧集实时监控看板 —— 生产镜像
# 纯 Node 内置模块，无 npm 依赖，基础镜像即可运行
FROM node:22-alpine

LABEL org.opencontainers.image.title="reelshort-monitor"
LABEL org.opencontainers.image.description="ReelShort 剧集实时数据监控看板（采集 + REST/SSE + 前端）"
LABEL org.opencontainers.image.source="https://github.com/OWNER/REPO"

WORKDIR /app

# 运行参数（Sealos 上可用环境变量覆盖）
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8899 \
    DATA_DIR=/data \
    POLL_MS=60000 \
    HISTORY_MAX=5000

# 应用代码（无第三方依赖，不需要 npm install）
COPY server.mjs ./server.mjs
COPY lib ./lib
COPY public ./public

# 初始历史数据（首次启动时导入到持久卷，保证曲线接得上）
COPY data/seed.jsonl ./seed-data/seed.jsonl

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 去除可能的 CRLF，避免容器内 `bad interpreter`
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data

EXPOSE 8899

# Sealos / K8s 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8899)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
