#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=/opt/alist-uploader
SERVICE_NAME=alist-uploader

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo "请使用 sudo 或 root 用户运行安装脚本"
    exit 1
fi

# 确定脚本所在目录
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> 安装 Alist Uploader 到 $INSTALL_DIR"

# 创建目录并复制文件
mkdir -p "$INSTALL_DIR/frontend"
cp -r "$PKG_DIR/frontend/dist" "$INSTALL_DIR/frontend/"
cp "$PKG_DIR/alist-uploader-linux" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/alist-uploader-linux"

# 安装 systemd 服务
cp "$PKG_DIR/alist-uploader.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo ""
echo "==> 安装完成！"
echo "    服务状态：$(systemctl is-active "$SERVICE_NAME")"
echo "    访问地址：http://$(hostname -I | awk '\''{print $1}'\''):8080"
echo "    日志查看：journalctl -u $SERVICE_NAME -f"
