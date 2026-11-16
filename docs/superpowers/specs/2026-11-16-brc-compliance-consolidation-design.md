# BRC 工程规范一致性整改设计

> 2026-11-16 · 状态：待实施 · 依据：structure-design、code-rules、cli-rules、现行项目规则和 Git 历史设计

## 用户阅读区

### 结论与目标

BRC 已具备可用的 CLI、Relay、Traefik、Agent 和运行诊断能力，但部分实现只完成了目录迁移，没有完成职责隔离。此次整改以现有 TypeScript、Node.js 和已在使用的 Rust 辅助查询器为基础。重点修复规范违规与可验证的功能缺口。

- 保持 Relay、Traefik、Agent 的启动顺序和安全归属核验。对外行为变化必须明确列出并测试。
- 让业务规则独立于文件、网络、数据库和终端。外部操作集中到适配器，由入口连接。
- 统一 CLI 的帮助、机器输出、提示、退出码和取消逻辑。AI 和人工终端调用同一套命令。
- 统一日志入口、函数计时与 CPU/内存监测。所有诊断数据有来源、上限和失效处理。
- 完善跨版本进程归属识别与跨平台验证，不触碰运行中的生产服务。

### 改造范围与边界

- 架构：CLI、Relay、Agent、Shared 的核心与外部适配分离；消除核心中的具体对象创建和重复参数来源。
- CLI：命令解析、结果渲染、交互提示、错误归类、取消信号、安全清理。
- 诊断：修补 Agent 敏感日志、停止/重启阶段计时、Traefik 真正的子进程资源采样。
- 安全与验收：跨版本进程身份、结构检查、隔离端到端测试及三平台验证。
- 保留已验证的 OAuth、MCP、文件/终端工具及单包发行功能。只做必要重组，不开发新的通用框架。
- 不迁移到 Rust，不因重构改写服务串行依赖。启动提速仅在有可比测量且不影响安全时另行决策。
- 本轮交付设计与计划文件。目录重构进入实施前，以本文件中的目标树取得用户确认。

### 实施后的外部表现

| 操作 | 期望结果 |
| --- | --- |
| 查看帮助、版本、配置、状态 | 快速获得准确结果；数据只进入标准输出，提示只进入错误输出 |
| 通过脚本读取结果 | JSON 格式完整且可解析；参数错误和运行失败有结构化错误与退出码 |
| 启动、停止、重启 | 状态清晰；服务按照既有依赖顺序变化；中断后安全清理本次资源 |
| 读取诊断信息 | 可分别看到服务阶段耗时、函数调用和实际进程的 CPU、内存及采样来源 |
| 使用远程工具 | 现有工具输入输出保持可用；本地诊断日志不储存用户文件正文和完整命令参数 |
| 跨版本升级 | 能确认归属时安全停止旧实例；无法确认时报告冲突，不误停其他进程 |

## Agent 阅读区

### 现状与审查依据

- 本地 main 源码及已批准历史稿件是设计依据。历史稿件已由 Git 保留；重复实施已完成的项目没有收益。
- 现有诊断模块已提供函数统计、事件、快照、采样和跨进程日志锁，继续复用。
- CLI `core/lifecycle/workflow.ts` 从 adapters 导入 `ProcessManager` 和 `LifecycleLock`，并在构造器中提供具体默认对象。
- Relay `core/auth/provider.ts` 依赖 Express、MCP SDK 和 SQLite；`core/auth/sessions.ts` 依赖 Express。
- Agent `core/config-storage.ts`、`core/search-manager.ts` 和部分 `core/utils` 直接读写文件或创建外部进程；多个核心模块创建单例。
- `cli.ts` 兼有入口、服务组装、业务命令与 console 输出；现有 `commands/parser.ts` 解析的部分全局参数没有接入实际执行。
- `commands/setup.ts`、`maintenance/uninstall.ts` 的交互提示使用 stdout，TTY 约束未分别覆盖 stdin 和 stderr。
- `start` 有阶段 Trace；`stop`、`restart` 没有同等级记录。Traefik 资源快照来自 Node 管理进程，而不是 Traefik 二进制进程。
- Agent 模糊检索、工具调用和历史日志仍保存原始搜索内容、参数或输出。共享诊断默认值与 CLI settings 存在副本。
- 现有架构测试主要限制 CLI core 的少量 node: 导入，未覆盖各包的 adapter 反向依赖、外部 SDK 与对象创建位置。

### 用例与职责

| 用例 | 使用者与操作 | 核心规则 | 外部对接 | 成功标准与失败表现 |
| --- | --- | --- | --- | --- |
| 生命周期 | 用户/AI 启停或查询服务 | 状态转移、依赖顺序、身份策略 | 进程、锁、控制端点、配置 | 状态真实；未知归属返回冲突 |
| 授权服务 | MCP 客户端认证、刷新、撤销 | 令牌有效性、权限、会话校验 | Express、MCP SDK、SQLite | 授权正确；伪造代理头无效 |
| Agent 工具 | 远端读取、搜索、终端操作 | 参数与路径权限、搜索会话规则 | 文件、ripgrep、终端、WebSocket | 工具返回保持；错误可复现 |
| CLI 自动化 | AI 查询结果和诊断 | 命令语法、结果和错误分类 | stdin/stdout/stderr、JSON | JSON 单值；无 TTY 不阻塞 |
| 运行诊断 | 开发者定位问题 | 事件、阶段统计、函数统计 | 日志、进程资源采样、快照 | 计时可核对；峰值来源准确 |
| 清理与升级 | 用户更新或卸载 | 数据归属、失效恢复、安全回退 | 文件、进程、pnpm | 保留用户配置；不误停进程 |

### 目标文件树

以下是受影响部分的目标树。省略的模块保留原位置；每个目录的职责在名称后说明，具体文件按实际调用关系迁移，删除迁移后无人引用的旧位置。

~~~text
packages/
  cli/src/
    cli.ts                                外部入口：连接对象与依赖
    commands/                             外部对接：命令参数、交互和输出
      parser.ts                           命令定义、帮助、参数验证
      renderer.ts                         文本/JSON 输出、错误和 stderr 反馈
      lifecycle.ts                        启停/status 命令适配
      diagnostics.ts                      诊断命令适配
      setup.ts                            首次管理员凭据输入
      signals.ts                          中断适配
    core/lifecycle/                       核心：进程状态、流程和契约
      policy.ts
      ports.ts
      workflow.ts
    core/maintenance/                     核心：自身数据清理规则
      policy.ts
    adapters/process/                     外部对接：进程和资源探测
      controller.ts
      identity.ts
      resources.ts
    adapters/storage/                     外部对接：锁、状态与数据回收
    adapters/network/                     外部对接：受管控制端点
      health.ts
    config/settings.ts                    可调参数唯一权威来源
  relay/src/
    cli.ts                                外部入口：组装授权、HTTP 和数据存储
    core/auth/                            核心：授权与会话纯规则
      ports.ts
      policy.ts
      rate-limit.ts
      session-signature.ts
    adapters/http/                        外部对接：Express、MCP SDK 和页面
      app.ts
      oauth-provider.ts
      sessions.ts
    adapters/storage/sqlite.ts            外部对接：SQLite
  agent/src/
    cli.ts                                外部入口：工具与依赖组装
    core/config/                          核心：配置规则与存取接口
      ports.ts
      policy.ts
      workflow.ts
    core/search/                          核心：搜索会话与结果策略
      ports.ts
      workflow.ts
    core/tools/                           核心：工具规则与调用流程
    adapters/filesystem/                  外部对接：配置、文件和文档搜索
    adapters/system/                      外部对接：ripgrep、系统与进程
    adapters/terminal/                    外部对接：Shell、终端与编码
    adapters/telemetry/                   外部对接：持久工具历史与专用日志
    transport/                            外部对接：远端通信
  shared/src/
    diagnostics/core/                     核心：事件、计时、统计、端口
    diagnostics/adapters/                 外部对接：轮转日志、快照、资源
    diagnostics/runtime.ts                已组装依赖的生命周期控制
    managed-log.ts                        唯一通用日志轮转实现
scripts/                                    工程脚本；沿用现有自动插桩和构建
tests/                                      规范检查与功能回归
~~~

### 接口清单

| 接口 | 定义位置 | 实现位置 | 输入输出与责任 |
| --- | --- | --- | --- |
| `ProcessController` | CLI core/lifecycle/ports.ts | CLI adapters/process/controller.ts | start/stop/status；不改变进程身份保护 |
| `LifecycleLockPort`（新增） | CLI core/lifecycle/ports.ts | CLI adapters/storage/lock.ts | runExclusive；由入口注入 |
| `IdentityPort`（现有） | CLI core/lifecycle/ports.ts | CLI adapters/process/identity.ts | 校验 PID、创建时间和命令行 |
| `ControlHealthPort`（现有） | CLI core/lifecycle/ports.ts | CLI adapters/network/health.ts | 只负责控制端点健康请求；由流程需要时注入 |
| `AuthStorePort`（新增） | Relay core/auth/ports.ts | Relay adapters/storage/sqlite.ts 的适配 | 授权所需最小 CRUD 契约，不暴露 SQL |
| `ConfigStorePort`（新增） | Agent core/config/ports.ts | Agent adapters/filesystem 的配置存储 | 读、原子写、监视；入口连接 |
| `SearchExecutorPort`（新增） | Agent core/search/ports.ts | Agent adapters/system 与 filesystem | 调用 ripgrep/文档搜索并返回有界结果 |
| `DiagnosticLogPort`（现有） | Shared diagnostics/core/ports.ts | Shared diagnostics/adapters/logging.ts | 统一事件、脱敏与轮转写入 |
| `ResourceSamplePort`（现有） | Shared diagnostics/core/ports.ts | Shared/CLI 的 Node 与子进程采样器 | 采样 CPU、RSS、峰值及测量来源 |
| `CliResult`（新增数据结构） | CLI commands/renderer.ts | CLI 命令适配 | 状态、数据、错误、诊断；文本和 JSON 同源 |

### 结构决策

| 决策 | 理由 | 对应用例 |
| --- | --- | --- |
| 入口只负责创建和连接具体对象 | core 不应依赖 adapters；避免隐式全局单例 | 生命周期、Agent 工具 |
| 核心只接收接口与数据 | 可离线单元测试，业务规则不产生 IO 副作用 | 全部业务流程 |
| MCP SDK 与 Express 留在 Relay HTTP 适配器 | 领域规则不依赖第三方 SDK；保留已验证的对外协议 | 授权服务 |
| 保留单套 Shared 诊断 | 复用已有模块，不建立第二套日志、计时或资源采样 | 运行诊断 |
| CLI 结果数据只生成一次 | stdout、stderr、日志使用同一执行结果，避免互相矛盾 | CLI 自动化 |
| 保护进程身份优先于升级便利 | 归属未知时不允许凭 PID 误杀 | 生命周期、升级 |
| 目录迁移按职责逐包推进 | 同时大改四包风险高，支持独立验收与回滚 | 全部业务流程 |

### 详细行为契约

- CLI 支持 `help/version/status/config/diagnose` 的机器输出；`--json` 成功时 stdout 仅一个 JSON，失败时 stderr 仅一个 JSON 错误对象，错误码与退出码对应。
- 数据查询命令支持显式 `--output <file>` 原子保存请求结果；该参数是用户主动选择的文件写入副作用，默认查询不写文件。
- `--quiet`、`--verbose`、`--no-input` 解析后必须影响执行。不同流分别检测 TTY；交互提示与警告走 stderr；敏感密码不回显。
- `brc` 裸命令展示真实可用状态和帮助，不输出未初始化服务管理器错误。空结果、异常与取消有明确语义。
- 取消信号沿命令、生命周期工作流、外部调用传播。有界等待后释放由本次操作取得的锁、子进程和文件资源；保留阶段结果。
- 保留现有每次命令进行自身失效数据清理的项目规则；仅清理有归属的 BRC 数据，所有输出保持机器可解析。
- 共享诊断由真实程序入口创建资源对象；`runtime.ts` 仅连接已注入的依赖及管理生命周期，避免藏匿对象创建。
- 每个自有函数的调用次数与耗时使用现有插桩器和统一探针。生成器必须记录推进片段，Rust 辅助程序列出可覆盖函数与例外。
- Traefik 管理进程和 Traefik 二进制进程分别采样，记录 PID 身份和来源；缺失系统峰值时标记采样峰值。
- 本地日志不得保存工具原始参数、检索正文、模糊搜索 diff 和文件原文。用户请求的工具返回值仍按原有工具契约输出。
- 对外配置默认值和范围集中在 CLI settings；子进程只接收入口解析后的值，诊断模块不再静默复制默认值。
- 日志、资源快照和升级前后的文件都执行归属检查；日志写盘失败不改变业务操作成功与失败结论。
- 性能比较仅采用相同负载与隔离环境。服务就绪依赖顺序保持不变，不宣称语言迁移会改善串行等待。

### 未决问题与执行门槛

| 问题 | 影响 | 决策者 |
| --- | --- | --- |
| 目标文件树及核心接口是否用于正式重构 | 决定跨文件迁移范围 | 用户批准设计后进入实施 |
| Linux/macOS 本轮修改的 CI 与实际设备结果 | 决定跨平台验收覆盖范围 | 执行阶段通过真实 CI 决定 |
| 进程旧版本归属无法严格证明的案例 | 决定是否拒绝自动停机 | 按安全策略拒绝；无需人工猜测 |

### Skills 和验收边界

- 设计以 `structure-design`、`code-rules`、`cli-rules` 为强制标准。冲突时以现行强制规则为准。
- 实施使用 `superpowers:test-driven-development`、`safe-refactor`、`superpowers:systematic-debugging`；涉及隔离分支使用 `superpowers:using-git-worktrees` 与 `auto-git-commit`。
- 相互独立的包可用 `superpowers:dispatching-parallel-agents` 同时推进；接口接线和总体验收由主 Agent 汇总。
- 交付使用 `superpowers:verification-before-completion`、`project-context` 和 `ste-zh`。
- 通过标准是静态架构检查、CLI 行为检查、单元测试、隔离 OAuth/MCP/Agent E2E、打包与跨平台测试，不以目录存在或测试数量代替行为验证。
