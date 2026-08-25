# Alist Uploader Linux

Linux Web 版 Alist 上传管理器，从 Tauri 桌面版迁移而来，核心上传引擎不变。

## 架构

```
src/          Rust 后端（Axum HTTP 服务）
  main.rs     入口，启动 8080 端口
  routes.rs   API 路由（队列、历史、配置、Alist、文件浏览）
  services/   上传调度、队列管理、Alist 客户端（与桌面版共享）
  models/     数据模型
  utils/      存储、日志、文件系统工具
frontend/     React 前端
  src/        页面代码
  dist/       构建产物（由后端作为静态文件服务）
deploy/       systemd 服务单元与安装脚本
.github/      GitHub Actions 工作流
```

## 快速启动

```bash
# 构建前端
cd frontend && npm install && npm run build && cd ..

# 启动后端服务
cargo run
```

服务默认监听 `0.0.0.0:8080`，浏览器打开即可访问。

## 开发模式

```bash
# 终端1：启动后端
cargo run

# 终端2：启动前端开发服务器（带 /api 代理到后端）
cd frontend && npm run dev
```

## 远程文件管理

Web 版内置了远程文件浏览器，点击顶部「文件」标签即可浏览盒子上的挂载磁盘和目录，选择文件加入上传队列，不需要在浏览器本地选择文件。

## 从 GitHub Actions 下载构建产物

每次推送到 `main` 分支或手动触发都会自动构建两个 aarch64 变体，可去仓库的 Actions 页面下载：

- `alist-uploader-linux-aarch64-gnu.tar.gz` &mdash; 标准 glibc 版（适配大多数 Armbian）
- `alist-uploader-linux-aarch64-musl.tar.gz` &mdash; 静态 musl 版（兼容性最好，建议优先使用）

### 安装到 Armbian 设备

```bash
# 解压并安装
tar -xzf alist-uploader-linux-aarch64-*.tar.gz
cd alist-uploader-linux-aarch64-*
sudo bash install.sh

# 服务已启动，访问 http://<设备IP>:8080
```

## 本地交叉编译

```bash
# 安装交叉工具链（Ubuntu/Debian）
sudo apt install gcc-aarch64-linux-gnu binutils-aarch64-linux-gnu

# 为 arm64 架构编译（glibc）
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
  cargo build --release --target aarch64-unknown-linux-gnu

# 静态编译（musl，需要 cargo-zigbuild）
cargo zigbuild --release --target aarch64-unknown-linux-musl
```

## 安全建议

如果通过内网穿透暴露到公网，建议在反向代理（如 Nginx）中配置 Basic Auth 或 IP 白名单。

## 许可

MIT
