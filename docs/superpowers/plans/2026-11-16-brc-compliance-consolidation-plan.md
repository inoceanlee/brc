# BRC 工程规范一致性整改实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 每项任务按测试失败、最小修改、复测、审查、提交推进。
>
> 2026-11-16 · 状态：待实施

**Goal:** 使 BRC 的模块依赖、CLI 契约、诊断能力和安全进程管理满足现行 Skills，保持现有对外功能。

**Architecture:** 保留 Node.js/TypeScript、现有 Shared 诊断和 Rust 身份查询器。业务核心通过自有接口接收外部能力。程序入口创建适配器并连接依赖，CLI 命令从同一执行结果渲染文本和 JSON。

**Tech Stack:** TypeScript、Node.js、pnpm、内置 Node test、现有 SQLite/Express/MCP SDK、现有 Rust 辅助查询器。

**Spec:** `docs/superpowers/specs/2026-11-16-brc-compliance-consolidation-design.md`。

## 用户阅读区

### 工作顺序与难度

| 批次 | 难度 | 内容 | 验收结果 |
| --- | --- | --- | --- |
| 接口与测试门禁 | 中 | 建立全包静态架构检查与稳定接口 | 违规依赖可以被自动检测 |
| CLI 规范整改 | 中高 | 输出、错误、交互、取消及自身清理 | AI 调用不挂起，JSON 可解析 |
| Relay 结构整改 | 中高 | OAuth 业务规则与 HTTP、SQLite 解耦 | 现有认证和限流功能不变 |
| Agent 结构与隐私整改 | 高 | 搜索、配置、工具和日志职责归位 | 工具能力不退化，日志不泄露正文 |
| 诊断补齐 | 中 | 停机计时、真实进程资源、函数覆盖与默认值 | 统计来源准确，可定位失败 |
| 集成验收 | 中高 | 全量测试、隔离 E2E、跨平台与打包 | 结果可复现，生产服务未被干扰 |

### 并行安排

先统一接口和架构测试。随后 CLI、Relay 和 Agent 在不同工作树并行。Shared 诊断由主 Agent 负责公共接口整合，避免多人修改同一文件。最后在一条集成分支验收并合入 main。

本轮不改运行中的 BRC、不升级生产服务、不发 npm 包、不推送 GitHub。迁移目录前复核已批准设计文件树。未通过验收的批次不得标记完成。

## Agent 阅读区

### 全局约束

- 最高优先级 Skills：`structure-design`、`code-rules`、`cli-rules`；设计中的目标树和接口以最新设计稿为准。
- 设计变更前阅读项目 `AGENTS.md`、`CONTEXT.md`、当前规范及最新的本设计和计划。
- 保留启动 Relay → Traefik → Agent、停止反序和所有进程身份保护；只优化可证实重复工作，不并行启动有依赖的服务。
- 不迁移 Rust 业务模块；现有 Rust 查询器仅保持功能和测试，当前批次不扩展 Rust。
- 不添加常驻服务、数据库、Docker、历史兼容包装和重复日志框架。
- 所有服务使用隔离数据根与临时端口测试，不读取生产数据库或影响线上 Funnel。
- 全部新增业务接口由 core 定义，adapters 实现；只有 CLI/Relay/Agent 实际入口创建具体依赖对象。
- 按现行 `code-rules` 禁止行尾/行内注释；可调参数与默认值必须具有唯一来源。
- 命令机器输出 stdout 与诊断 stderr 完全分离；日志与返回结果来自同一结果对象。
- 每批按照 `superpowers:test-driven-development` 先复现失败，再最小改动、复测、提交。
- 提交使用 `auto-git-commit`，独立工作树使用 `superpowers:using-git-worktrees`；最终使用 `superpowers:verification-before-completion`、`project-context`。

### 实施目标文件树

实际职责、接口和迁移前后路径以设计稿中的完整文件树为准。以下仅显示需要新增或重新划分的模块。

~~~text
packages/
  cli/src/
    cli.ts                         入口与依赖注入
    commands/{parser,renderer,lifecycle,diagnostics}.ts  CLI 适配
    core/lifecycle/{policy,ports,workflow}.ts          业务核心
    core/maintenance/policy.ts     清理规则
    adapters/{process,storage,network}/  外部适配
  relay/src/
    cli.ts                         入口与依赖注入
    core/auth/{ports,policy,rate-limit,session-signature}.ts
    adapters/http/{app,oauth-provider,sessions}.ts
    adapters/storage/sqlite.ts
  agent/src/
    cli.ts                         入口与依赖注入
    core/{config,search,tools}/    纯规则与业务流程
    adapters/{filesystem,system,terminal,telemetry}/
    transport/                     远端连接适配
  shared/src/
    diagnostics/core/              纯诊断逻辑与接口
    diagnostics/adapters/          日志、资源和快照
    diagnostics/runtime.ts         已注入资源的生命周期管理
~~~

### Review Focus：容易遗漏的输入与故障

| 输入或条件 | 用户应看到的行为 | 归属批次 |
| --- | --- | --- |
| `brc` 裸命令、无配置文件 | 正常显示状态/帮助，不抛未初始化依赖错误 | CLI |
| `--json` 下参数错误或诊断空结果 | 错误在 stderr 为完整 JSON；空结果在 stdout 为合法 JSON | CLI |
| 没有 TTY 的首次 setup/uninstall | 不阻塞，缺少必要参数返回 2；密码不打印 | CLI |
| Ctrl+C 中断服务启动或锁等待 | 停止后续操作、释放本次资源；保留已完成的真实状态 | CLI |
| 伪造转发头、异工作区 PID、含敏感文本的工具调用 | 限流与身份保护生效；诊断磁盘不写入敏感正文 | Relay、Agent、诊断 |

### 共享接口和依赖批次

**工作范围：** 冻结共享的领域接口和诊断数据契约；架构测试覆盖所有包，而不仅是检查文件存在。

**文件：**
- 修改：`tests/brc-architecture.test.mjs`。
- 修改：`packages/cli/src/core/lifecycle/ports.ts`；新增 `LifecycleLockPort`。
- 新增：`packages/relay/src/core/auth/ports.ts`、`packages/agent/src/core/config/ports.ts`、`packages/agent/src/core/search/ports.ts`。
- 更新：`docs/architecture.md` 中的目标依赖方向，仅记已批准的结构决定。

**接口：**
- `LifecycleLockPort.runExclusive<T>(operation: () => Promise<T>): Promise<T>`。
- `AuthStorePort` 仅暴露授权用例实际调用的存取方法，不暴露 SqliteStore。
- `ConfigStorePort` 负责 read/write/lock/watch 的必要操作。
- `SearchExecutorPort` 接收已校验的搜索任务，返回结构化结果/错误和取消状态。

**执行与检查：**
- [ ] 添加对 CLI、Relay、Agent 各 core 的导入边界测试，检查第三方 SDK、Node IO、adapters 和跨层转出口；测试必须先对已知违规源码失败。
- [ ] 增加显式依赖创建检查：构建时检测 core 中 adapter 具体对象构造和模块级导出单例，保留 Error/Map/纯值对象等合法构造。
- [ ] 在对应 core 中定义实际被使用的端口。接口只承诺已存在的职责，不预建通用抽象层。
- [ ] 将测试中的允许例外写成具体可审查的规则；不得用忽略整个目录掩盖违规。
- [ ] 运行 `node --test tests/brc-architecture.test.mjs`，记录新增失败用例和每包待修列表；该阶段有意保留失败，直到各业务批次修复。
- [ ] 独立提交共享接口和检查框架；接下来的各工作树以同一接口提交为基线。

### CLI 模块与命令契约批次

**工作范围：** 清理 CLI core 的适配器反向依赖；从 `cli.ts` 提取真实命令适配，建立统一数据结果和输出行为。

**文件：**
- 修改：`packages/cli/src/cli.ts`、`commands/parser.ts`、`commands/setup.ts`、`commands/signals.ts`、`maintenance/uninstall.ts`。
- 新增：`packages/cli/src/commands/renderer.ts`、`commands/lifecycle.ts`、`core/maintenance/policy.ts`、`adapters/network/health.ts`（仅在使用现有健康接口时创建）。
- 修改：`packages/cli/src/core/lifecycle/workflow.ts`、`core/lifecycle/ports.ts`、`adapters/storage/lock.ts`。
- 测试：`tests/brc-cli.test.mjs`、`tests/brc-lifecycle.test.mjs`、`tests/brc-clean.test.mjs`、`tests/brc-architecture.test.mjs`。

**接口：**
- `ServiceManager` 构造器显式接收 `ProcessController`、`LifecycleLockPort`、`refreshServices` 和可选 TraceSink。
- `CliResult` 含 `status`、`data`、`error`、`diagnostics`；renderer 接收单个结果和输出模式。
- 取消通过可选 `AbortSignal` 传递到命令与 I/O 端口；不允许仅在信号处理器调用 process.exit()。

**执行与检查：**
- [ ] 先让架构测试检出 ServiceManager 默认实例化与 core 反向依赖，再移除默认创建并从入口注入。
- [ ] 增加 `brc` 裸命令和空配置测试，再修正轻量命令的服务状态注入，不使用未初始化占位对象。
- [ ] 增加 --json 正常/空/错误、--quiet/--verbose/--no-input、help/version、未知参数及退出码测试。
- [ ] 为数据查询命令补 `--output <file>` 测试，验证原子写入、不可覆盖错误、安全路径和默认查询不写文件。
- [ ] 将命令处理返回统一结果。renderer 在 stdout 输出请求结果，在 stderr 输出进度与结构化错误；避免散落的 console。
- [ ] 使 setup/uninstall 独立检测 stdin 与 stderr 的 TTY；非交互缺参数返回 2。提供受控环境输入或显式确认参数，不打印密码。
- [ ] 加入锁竞争、进程启动中断、取消中等待退出、部分成功和重复信号的隔离测试。
- [ ] 用 AbortSignal 串联命令、工作流和受控 I/O。中断时只清理本次操作持有的资源，并按 130/143 退出。
- [ ] 保留所有命令的自身数据清理要求，独立记录清理耗时和失败；禁止改变主要命令的返回结果。
- [ ] 运行受影响测试与 `pnpm build`，在 CLI 单独工作树提交并交主 Agent 复核。

### Relay 授权边界批次

**工作范围：** HTTP/MCP 和 SQLite 留在 adapters；核心保留纯授权、会话签名与限流规则。

**文件：**
- 迁移：`packages/relay/src/core/auth/provider.ts` → `adapters/http/oauth-provider.ts`。
- 迁移：`packages/relay/src/core/auth/sessions.ts` 的 Express 相关方法 → `adapters/http/sessions.ts`。
- 新增：`packages/relay/src/core/auth/policy.ts`、`core/auth/session-signature.ts`；依据用例使用 `core/auth/ports.ts`。
- 修改：`packages/relay/src/cli.ts`、`adapters/http/app.ts`、`adapters/storage/sqlite.ts`。
- 测试：`packages/relay/test/unit.test.mjs`、`tests/brc-proxy-trust.test.mjs`；新增 `tests/brc-relay-boundary.test.mjs`。

**接口：**
- `AuthStorePort` 由 SQLite 适配器提供必需授权操作；核心只看到接口。
- 登录 Cookie 的签名、到期和有效性验证由纯函数完成；Express Request/Response 只出现在 HTTP 适配器。

**执行与检查：**
- [ ] 补充纯授权规则、会话过期、重放与伪造代理头测试，证明现有行为边界。
- [ ] 将 MCP SDK provider 与 HTTP sessions 迁移至适配器；将所需纯规则拆入 core。
- [ ] 更新 Relay 入口组装与相关导入；不增加空壳适配层或旧目录兼容 wrapper。
- [ ] 检查 OAuth 注册、授权码、刷新、撤销、API Key 和登录限流隔离回归。
- [ ] 运行 Relay 单元测试、架构测试、隔离 OAuth/MCP E2E，通过后独立提交。

### Agent 核心与日志隐私批次

**工作范围：** 让配置与搜索核心不直接读写文件、启动进程或依赖终端；保留 MCP 工具返回契约。

**文件：**
- 迁移：`packages/agent/src/core/config-storage.ts` → `adapters/filesystem/config-storage.ts`。
- 拆分：`core/config-manager.ts` → `core/config/{policy,workflow,ports}.ts`。
- 拆分：`core/search-manager.ts` → `core/search/{workflow,ports}.ts` 与 `adapters/system/ripgrep-search.ts`、`adapters/filesystem/document-search.ts`。
- 调整：`core/command-manager.ts`、`core/utils/feature-flags.ts` 以及对应入口和调用方，移除导出具体单例。
- 修改：`adapters/telemetry/fuzzySearchLogger.ts`、`trackTools.ts`、`toolHistory.ts`、`toolHistoryStorage.ts`，接入共享日志接口。
- 测试：`tests/brc-architecture.test.mjs`、`tests/brc-agent-history.test.mjs`；新增 `tests/brc-agent-boundary.test.mjs`、`tests/brc-agent-log-privacy.test.mjs`。

**接口：**
- `ConfigStorePort` 供配置流程使用；watch 和锁释放是可注入能力。
- `SearchExecutorPort` 由 ripgrep 与文档读取适配器实现；异步搜索结果和会话上限沿用当前工具契约。
- 工具持久事件只保存允许的名称、时间、持续时间、状态和脱敏来源；工具执行输出仍按授权调用方原契约返回。

**执行与检查：**
- [ ] 添加配置并发写入、监视、搜索取消与会话回收测试，固定当前对外行为。
- [ ] 从 core 移出真实文件操作、ChildProcess、外部 SDK 和日志 IO，并用构造注入替换模块级单例。
- [ ] 更新 Agent 入口、dispatcher、handlers 与各工具调用方；不留下临时同名转发文件。
- [ ] 添加包含密码、token、路径正文、搜索 diff 的测试样本；验证日志、历史及异常堆栈不保留秘密。
- [ ] 日志统一通过 Shared DiagnosticLogPort 或其专用适配；保留工具 API 对用户返回的数据和结构。
- [ ] 验证工具搜索、读取、编辑、终端、历史、WebSocket 连接及权限策略没有行为退化。
- [ ] 运行 Agent 单元测试、架构测试和隔离 Agent E2E，通过后独立提交。

### Shared 诊断完整性批次

**工作范围：** 修正参数与采样事实，完成 stop/restart 的阶段诊断，并复用单套日志与资源系统。

**文件：**
- 修改：`packages/shared/src/diagnostics/runtime.ts`、`core/session.ts`、`adapters/resources-node.ts`、`adapters/logging.ts`。
- 修改：`packages/cli/src/config/settings.ts`、`cli.ts`、`commands/diagnostics.ts`、`traefik/runtime.ts`。
- 新增：`packages/cli/src/adapters/process/resources.ts`；不修改原生 Rust 身份查询器。
- 修改：`scripts/instrument-functions.mjs` 与 `tests/brc-instrumentation.test.mjs`（生成器覆盖）。
- 测试：`tests/brc-startup-trace.test.mjs`、`tests/brc-diagnostics-resources.test.mjs`、`tests/brc-diagnostics-logging.test.mjs`、`tests/brc-diagnostics-functions.test.mjs`。

**接口：**
- Shared 的 `ResourceSamplePort` 统一返回样本值、PID/实例标识、采集窗口与峰值来源。
- Traefik 进程采样器使用系统现有进程查询能力：Windows 有界 Get-Process；Linux /proc；macOS ps。诊断不可得明确标记 unavailable。
- `DiagnosticsRuntime` 只管理由入口注入的日志、函数统计、资源采样和快照，不隐式创建具体适配对象。

**执行与检查：**
- [ ] 为 start/stop/restart 三条路径增加完成、失败、取消、未归属时长和日志 flush 的测试，再统一阶段跟踪。
- [ ] 将共享诊断的实例创建移到各程序入口；runtime 接收已构造依赖，取消重复的参数默认值。
- [ ] 对独立 Traefik 进程采样分别验证 CPU 时间与 RSS、真实/采样峰值、PID 复用与进程退出。
- [ ] 采样超时、权限不足或平台不支持时返回缺测，绝不把 Node 管理进程的数据标成 Traefik 子进程。
- [ ] 对现有函数清单补生成器推进片段测试和异常传播测试；不修改 Rust 工程，仅校验现有辅助进程。
- [ ] 验证跨进程日志轮转、敏感字段脱敏、正在写入的文件保护、容量与保留期。
- [ ] 同条件对比诊断开启与关闭的资源、启动开销；发现异常增加时修复采样频率或 IO 方式。
- [ ] 运行全部诊断测试、`pnpm build`；与 CLI 分支的共享文件修改由主 Agent 串行合并并提交。

### 跨版本安全与集成验收批次

**工作范围：** 修正旧 pnpm 路径的受管实例识别；以隔离环境完成全量验证。

**文件：**
- 修改：`packages/cli/src/core/lifecycle/policy.ts`、`adapters/process/identity.ts`、`adapters/process/controller.ts`。
- 修改：`tests/brc-lifecycle.test.mjs`、`tests/brc-architecture.test.mjs`、`tests/brc-cli.test.mjs`。
- 更新：`README.md`、`README_zh.md`、`docs/architecture.md`、外层项目 `CONTEXT.md`。

**执行与检查：**
- [ ] 补旧版本 pnpm 路径、相同 PID 不同启动时间、损坏记录、异工作区进程和锁失效的测试。
- [ ] 只有经过严格归属证明才允许停止旧实例。归属未知返回冲突，不以路径相似或进程名推断身份。
- [ ] 补齐所有 core 的依赖检查、对象创建、配置默认值、行内注释和函数计时覆盖门禁。
- [ ] 依次执行 `pnpm build`、`pnpm test:unit`、`pnpm test:package`、隔离 `pnpm test:e2e`；记录实际通过数与失败项。
- [ ] 单独核对 Windows PowerShell 7/5.1、CMD、无 TTY、JSON、Ctrl+C 的 CLI 契约；Linux/macOS 以真实 CI 或设备日志为准。
- [ ] 抽查生产服务运行状态但不重启，检查隔离测试后进程、锁、临时文件和数据根已回收。
- [ ] 对照设计用例、接口、目录树逐项验收，所有强制 Skills 违规均必须有通过的验证证据。
- [ ] 按 `auto-git-commit` 验证提交、合并 main、清理已合并工作树；依 `project-context` 全量同步上下文。
- [ ] 整改全部验收通过后再删除本次已完成设计与计划，Git 历史保留；npm 发布、GitHub 推送和生产升级另行获得用户授权。

### 分批验收与失败处理

- 批次间以接口为依赖。共享端口先固定，CLI、Relay、Agent 隔离并行，Shared 与 CLI 同文件修改由主 Agent 整合。
- 每次改动都必须有对应失败测试、成功测试和可独立审查的提交；单元测试通过不等于对外协议验收通过。
- 对当前无法获取的平台采样与 CI，明确记录缺测或待验证，不声明所有平台通过。
- 遇到安全归属不明或测试无法隔离生产数据时立即停止相关实施，保留源码和 Git 状态。
- 按 `superpowers:verification-before-completion` 检查输出、退出码、日志、快照、实际进程和发布包，不以代码已提交代替完成。
