#!/usr/bin/env bash
# GameTalk 一键部署脚本（Linux VPS）
# 用法：bash deploy.sh  （需 root 或 sudo，已安装 docker + compose 插件）
set -euo pipefail

cd "$(dirname "$0")"

echo "==> 1/4 生成/读取环境变量"
if [ ! -f .env ]; then
  cat > .env <<EOF
# 必填：请改成强随机值
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
# 你的域名（已解析到本服务器）
GAMETALK_HOST=chat.example.com
EOF
  echo "已生成 .env，请编辑 GAMETALK_HOST 后重新运行：nano .env && bash deploy.sh"
  exit 1
fi

echo "==> 2/4 构建并启动服务"
docker compose up -d --build

echo "==> 3/4 等待健康检查"
for i in $(seq 1 30); do
  if docker compose exec -T server node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "    server 健康 ✅"
    break
  fi
  [ "$i" = 30 ] && { echo "    server 未就绪 ❌ 查看日志: docker compose logs server"; exit 1; }
  sleep 2
done

echo "==> 4/4 完成"
echo "客户端服务器地址填写：https://$(grep GAMETALK_HOST .env | cut -d= -f2)"
echo "查看状态：docker compose ps"
