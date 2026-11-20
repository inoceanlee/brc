# Better Remote Commander (BRC)

[English](README.md) | 简体中文

本项目能够帮助你充分利用各家 AI 的聊天端资源，如当前 Chat 暂时免费的 GPT，以及 Chat 额度与 Coding 额度分开的 Gemini，实现 Chat 端对于本地电脑的安全操控，让你在日常对话中获取到和本地 Harness 近乎相同的 Agent 能力，包括管理文件、运行终端命令并查看系统状态。

本项目基于 [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander) 重写，专为 Windows、Linux 和 macOS 全平台运行时自适应优化。

## 工作原理

```text
AI 聊天端（远程 MCP 客户端）
  |
公网 HTTPS 入口（用户管理）
  |
Traefik（限速与并发保护）
  |
Relay（OAuth、设备配对与工具授权）
  |
Agent（在本地执行文件与终端操作）
```

Agent 主动通过出站 WebSocket 连接 Relay，无须向公网开放 Agent 监听端口。

## 核心设计

- **单包管理**：`@inoceanlee/brc` 包含 CLI、Relay、Agent、Traefik 配置模板和原生工具。执行 `brc setup` 时下载并校验 Traefik 程序。
- **统一手动启停**：通过 `brc start`、`brc stop` 和 `brc status` 管理服务，不注册自动启动的系统服务。
- **分层安全控制**：Traefik 负责请求限速和并发限制；Relay 负责 OAuth、设备配对与工具授权。Agent 使用本地运行账号的权限执行已授权操作。
- **集中配置**：通过 `config/brc.yaml` 或 `brc config` 管理参数。

## 环境要求

- 操作系统：Windows 10/11 x64、Linux x64/arm64、macOS x64/Apple Silicon。
- 运行环境：Node.js 22.15.0 或更高版本，包管理器使用 pnpm 或 npm。
- 初始化时需能访问 GitHub，以下载并校验 Traefik。
- 远程连接需要单独配置公网 HTTPS 入口。

**公网入口由用户管理。** 公网入口终止 HTTPS 加密连接，再将 HTTP 和 WebSocket 流量转发给 Traefik（默认 `http://127.0.0.1:13001`）。可使用 Tailscale Funnel、Cloudflare Tunnel 等方案。BRC 不负责启动或管理这些公网隧道。

## 安装与快速上手

Windows 使用 PowerShell，Linux/macOS 使用 Bash 或 zsh。以下 BRC 命令在这些终端中通用。

**1. 全局安装**（任选一种包管理器）：

pnpm：

```sh
pnpm add -g @inoceanlee/brc
```

npm：

```sh
npm install -g @inoceanlee/brc
```

**2. 初始化 BRC：**

```sh
brc setup
```

按提示设置管理员账号（默认 `admin`）及至少 8 位的密码。初始化会创建本地配置，并下载 Traefik。

**3. 配置公网入口：**

先自行配置 HTTPS 转发，再设置对应的公网地址：

```sh
brc config set services.publicUrl https://your-domain.example
```

只填写 HTTPS 源地址，不要附加 `/mcp`。

**4. 启动服务并配对设备：**

```sh
brc start
brc status
brc logs agent
```

首次启动后，在 Agent 日志中获取设备验证页面和配对码。打开页面并批准配对，再用 `brc status` 确认 Agent 在线。

**5. 连接 AI 聊天端：**

在支持远程 MCP 的 AI 聊天端中添加服务器 `https://your-domain.example/mcp`，并按照提示完成 OAuth 授权。公网入口必须同时支持 HTTPS 和 WebSocket。

## 常用命令

| 命令                               | 用途                             |
| ---------------------------------- | -------------------------------- |
| `brc help`                         | 查看帮助与所有命令               |
| `brc start`                        | 依次启动 Relay、Traefik 和 Agent |
| `brc stop`                         | 停止所有受管服务                 |
| `brc restart`                      | 重启所有受管服务                 |
| `brc status`                       | 查看各服务运行与健康状态         |
| `brc status --json`                | 以 JSON 输出服务状态             |
| `brc logs [relay\|agent\|traefik\|cli]` | 查看指定服务或 CLI 日志      |
| `brc diagnose startup`             | 查看最近一次启动的分阶段耗时     |
| `brc diagnose functions`           | 查看自有函数调用次数与耗时       |
| `brc diagnose resources`           | 查看各进程 CPU、内存与峰值       |
| `brc config show`                  | 查看当前生效配置                 |
| `brc config get <key>`             | 读取指定配置项                   |
| `brc config set <key> <value>`     | 修改配置项并原子保存             |
| `brc config apply`                 | 应用手动编辑后的 YAML 配置文件   |
| `brc config path`                  | 显示配置文件存放路径             |
| `brc update traefik`               | 检查并更新 Traefik 组件          |
| `brc clean`                        | 清理临时运行时数据与无效锁       |
| `brc uninstall`                    | 停止服务、删除数据并卸载 BRC     |

更新 BRC 版本：

```sh
pnpm up -g @inoceanlee/brc --latest
# 或
npm update -g @inoceanlee/brc
```

## 配置与数据存储

BRC 默认将配置及私有数据保存在以下位置：
- Windows：`%LOCALAPPDATA%\BRC\`
- Linux：`$XDG_DATA_HOME/brc` 或 `~/.local/share/brc`
- macOS：`~/Library/Application Support/brc`

使用环境变量 `BRC_DATA_ROOT` 可以修改数据根目录。执行 `brc config path` 可查看配置文件位置。

日志位于 `logs/`，诊断快照位于 `diagnostics/`，两者都受保留期和容量上限管理。`brc start --timing` 可在启动后于 stderr 查看阶段耗时；`brc diagnose ... --json` 输出稳定 JSON，便于脚本读取。异步函数的耗时包含等待时间，资源峰值会标明来源是系统计数器还是采样值。

## 常见问题

- **Agent 等待配对**：运行 `brc logs agent` 获取当前验证页面和配对码；在浏览器批准后运行 `brc status`。
- **AI 聊天端无法连接**：先用 `brc status` 检查服务，再确认公网 HTTPS 已转发至 `http://127.0.0.1:13001` 且支持 WebSocket。MCP 地址应为 `https://your-domain.example/mcp`。
- **`/mcp` 返回 HTTP 401**：未授权请求收到 401 属正常现象。应在聊天端完成 OAuth 授权，不应关闭 Relay 身份验证。
- **服务启动失败**：分别查看 `brc logs relay`、`brc logs traefik`、`brc logs agent`；安全边界见 [SECURITY.md](SECURITY.md)。

## 卸载

**保留配置和私有数据：**先停止服务，再使用安装时的包管理器移除程序。

使用 pnpm：

```sh
brc stop
pnpm remove -g @inoceanlee/brc
```

使用 npm：

```sh
brc stop
npm uninstall -g @inoceanlee/brc
```

**彻底卸载：**该操作停止服务，并永久删除 Relay 数据库、设备凭据、配置及日志等私有数据，然后由安装时的包管理器移除全局包。

```sh
brc uninstall
```

Windows 会在 BRC 命令退出后再执行包卸载。若卸载失败，可查看 BRC 输出的报告路径；如命令仍存在，请按安装方式执行 `pnpm remove -g @inoceanlee/brc` 或 `npm uninstall -g @inoceanlee/brc`。如果无法识别安装来源，BRC 会在删除数据前停止。

## 许可协议与安全

安全规范参见 [SECURITY.md](SECURITY.md)，开源协议参见 [LICENSE](LICENSE)，第三方工具归属详见 [NOTICE](NOTICE)。
