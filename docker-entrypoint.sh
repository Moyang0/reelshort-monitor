#!/bin/sh
# 容器启动入口：首次启动时把镜像内自带的初始历史数据导入持久卷
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ ! -f "$DATA_DIR/.initialized" ]; then
  if [ -f /app/seed-data/seed.jsonl ]; then
    if [ -s "$DATA_DIR/seed.jsonl" ]; then
      echo "[entrypoint] 持久卷已有 seed.jsonl，跳过导入"
    else
      cp /app/seed-data/seed.jsonl "$DATA_DIR/seed.jsonl" 2>/dev/null && \
        echo "[entrypoint] 已导入初始历史数据 → $DATA_DIR/seed.jsonl"
    fi
  fi
  touch "$DATA_DIR/.initialized"
  echo "[entrypoint] 持久卷初始化完成: $DATA_DIR"
else
  echo "[entrypoint] 复用已有持久卷: $DATA_DIR"
fi

echo "[entrypoint] 启动: HOST=$HOST PORT=$PORT POLL_MS=$POLL_MS DATA_DIR=$DATA_DIR"
exec "$@"
