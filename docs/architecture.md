# BRC 架构

## 运行形态

BRC 是单一 npm 包 `@inoceanlee/brc`，支持 Windows、macOS 和 Linux。CLI 统一管理 Relay、Traefik 和 Agent。用户通过 pnpm 全局安装，使用 `brc setup` 初始化，再用 `brc start` 和 `brc stop` 管理进程。

公网 HTTPS 入口由用户管理，通常使用 Tailscale Funnel。入口将 HTTP、MCP 和 WebSocket 转发至本机 Traefik。Relay、Traefik 管理入口和 Agent 管理入口均绑定 loopback。BRC 不管理公网域名或 Funnel 生命周期。

```text
支持远程 MCP 的聊天客户端
             |
       公网 HTTPS 入口
             |
      Traefik (127.0.0.1)
             |
             v
  Relay (HTTP/MCP/OAuth)
             ^
             | 出站 WebSocket
             |
   Agent (24 种本机工具)
   管理端口仅限本机
```

Relay 只信任一个 loopback 代理跳点（`TRUST_PROXY=loopback`）。Traefik 覆盖客户端提交的 `X-Forwarded-For`，因此伪造转发头不能改变登录限流身份。

## 代码结构

- `packages/cli/`
  - `src/cli.ts`：运行入口与对象组装。
  - `src/commands/`：命令树、参数与帮助（`parser.ts`）、配置与诊断命令、取消信号。
  - `src/core/lifecycle/`：无 I/O 的启停规则、依赖接口与编排。
  - `src/adapters/process/`：进程启动、身份核验、就绪与健康请求、启动规格。
  - `src/adapters/storage/`：生命周期锁、运行记录、清理与 Relay 数据库。
  - `src/config/`：配置类型、默认值、校验与平台路径（唯一来源）。
  - `src/traefik/`：代理专属逻辑、模板与二进制管理。
- `packages/relay/`：HTTP 服务、用户及设备、SQLite、OAuth、MCP、审计记录。
- `packages/agent/`：配对和持久凭据、出站 WebSocket、文件和终端等工具。
- `packages/shared/`：通信协议、受管控制接口与共享诊断模块。
- `native/brc-process/`：Rust 进程身份查询器，含自有函数与资源探针。
- `deploy/traefik/`：统一代理的静态和动态配置模板。
- `scripts/`：构建（含函数插桩）、测试发现、隔离基准与发布流程。
- `tests/`：Node 单测、生命周期安全、诊断与发行流程回归。

## 配置与身份

用户数据根默认位置：Windows 为 `%LOCALAPPDATA%\BRC\`，macOS 为 `~/Library/Application Support/brc/`，Linux 为 `$XDG_DATA_HOME/brc/`。可用 `BRC_DATA_ROOT` 覆盖。唯一可编辑配置文件为 `config/brc.yaml`，使用 `brc config show/get/set/apply/path` 管理。默认值、类型和校验集中在 `packages/cli/src/config/settings.ts`。

Relay 使用 SQLite 保存管理员、OAuth 客户端、访问令牌和设备归属。审计默认保留 30 天、50,000 条，定期分批清理。正常重启、升级和配置应用保留这些身份。数据库缺失、归属不一致或管理员异常时，拒绝危险的自动重建；新建数据库由 `brc setup` 初始化。

## 运行诊断

诊断配置（`diagnostics.enabled`、资源采样间隔、函数快照间隔、单条记录上限、保留天数）同样定义在 `settings.ts`，并通过受管子进程环境传递到 Relay、Agent 和 Traefik 管理进程。

- 日志：组件日志写入 `logs/<component>.log`，CLI 启动轨迹与结构化诊断写入 `logs/cli.log`、`logs/<component>-diagnostics.log`。跨进程写入由独立日志锁保护，轮转按容量和保留期执行。
- 启动轨迹：`brc start --timing` 在 stderr 输出阶段耗时；`brc diagnose startup [--json]` 显示最近一次启动的总时长、阶段、失败位置与未归属时间。
- 函数统计：构建期对各包自有 TypeScript 函数插桩，运行时按函数 ID 聚合调用次数、累计时长与最大时长。异步函数的墙钟时长单独统计并标注，生成器不插桩，避免把挂起时间算作执行时间。`brc diagnose functions [--json]` 读取各服务实例的原子快照。
- 资源统计：CLI、Relay、Agent 持续采样 CPU 时间、RSS 与堆内存；Traefik 由管理进程采样；Rust 查询器报告系统峰值。`brc diagnose resources [--json]` 区分系统峰值与采样峰值，并标出已退出、过期或缺测状态。
- 快照：每个受管实例在 `diagnostics/` 下以原子替换写入 `service-instanceId.json`，退出时尽力刷写。CLI 只读查询，不读取其他进程内存。

## 生命周期与清理

启动顺序为 Relay、Traefik、Agent，停止反序。`LifecycleLock.runExclusive()` 是配置变更、启停和 Traefik 切换的唯一跨进程目录锁。进程身份由 Rust 查询器或 POSIX `/proc` / `ps` 核验；归属不明时拒绝干预。清理只回收 BRC 自有失效数据，保留活跃实例与用户配置。

## Traefik 与发布

HTTP、MCP 和 WebSocket 共用单一 `PathPrefix` 路由。Traefik 二进制按运行时平台和架构匹配官方稳定版，经 SHA-256 校验后解压切换。单包发行根为 `packages/cli`；文档文件模式由 CLI package manifest 配置。

## 平台验证范围

Windows x64 有完整单元测试、原生组件构建与端到端验证。Linux 与 macOS 由 CI 矩阵执行定向测试，资源采样的系统峰值可用性因平台而异；未在本机验证的平台结果不外推。
