# BRC 架构、CLI 与启动耗时诊断设计

> 2026-11-15 · 状态：待实施 · 依据：structure-design、code-rules、cli-rules、项目 AGENTS.md 与 CONTEXT.md

## 用户阅读区

### 当前结论

- BRC 已保存 Relay、Traefik、Agent 三种服务日志，支持轮转、7 天默认保留期限和 50 MiB 默认总容量上限。它们主要记录运行事件，缺少统一的 CLI 启动耗时分解。
- 2026-11-15 11:14:12 Relay 开始监听，11:14:14 Traefik 输出启动信息，11:14:35 Agent 连接成功。之前多次启动也约有 23 秒的 Relay 到 Agent 连接间隔。这个间隔不是完整启动时长，尚不能归因于某个具体操作。
- CLI 启动中反复查询服务状态，退出时自动清理。这些步骤都可能耗时，但尚无生产分阶段计时。仓库已有隔离性能脚本，可复用。
- Relay 日志出现 Express 对 trust proxy 与 IP 限流配置的安全警告，须独立验证并修正。

### 改造结果

- 启动、停止和重启自动保存按阶段拆分的耗时记录，包含总时长、锁等待、配置准备、每项服务的身份检查、启动/就绪/健康检查，以及结束清理。
- 使用 brc start --timing 可直接看到阶段耗时；brc diagnose startup 可查看最近一次启动的耗时分配与失败位置；brc logs cli 查看详细原始记录。普通使用保持简洁。
- 保留并优化每次 CLI 调用的自身数据清理；清理日志进入 stderr，机器输出保持可解析。
- CLI 支持规范的帮助、版本、JSON 输出、错误类型与取消行为。业务运行时不依赖人类终端提示。
- 核心业务规则与外部进程、文件、网络操作分离，统一公共日志和可调参数来源；跨版本升级继续严格核验旧进程的真实身份。
- 不引入新的常驻服务、外部数据库或日志框架；不得重启生产 BRC 来取得基准数据。

### 用户可见命令约定

| 命令 | 预期结果 |
| --- | --- |
| brc start --timing | 启动后在 stderr 输出分阶段耗时摘要；无论成功或失败都写诊断日志 |
| brc diagnose startup | 显示最近一次启动的总耗时、阶段耗时、失败阶段及未计入的测量范围 |
| brc diagnose startup --json | 机器可读的同一份诊断结果；stdout 仅包含 JSON |
| brc logs cli | 按时间查看 CLI 生命周期诊断日志 |
| brc status --json / brc config show --json | 无额外横幅或清理摘要，输出稳定 JSON |
| brc --version / brc version / brc start --help | 版本与命令帮助可直接查询，帮助包含可复制示例 |

### 预期文件树

    packages/
      shared/src/
        managed-log.ts                 统一轮转写入；默认值供 CLI 配置复用
      cli/src/
        cli.ts                         仅做运行入口和对象组装
        commands/
          parser.ts                    命令树、参数、帮助与错误分类
          renderer.ts                  文本/JSON 输出与 stderr 进度
          diagnostics.ts               启动诊断查询命令
        core/
          lifecycle/
            policy.ts                  服务状态变更、异常状态及升级规则
            workflow.ts                启停编排及阶段结果
            ports.ts                   进程与状态存储的依赖接口
          maintenance/
            policy.ts                  数据回收规则
        adapters/
          process/
            identity.ts                Windows/POSIX 进程身份核验
            controller.ts              子进程启动与关闭
          storage/
            runtime.ts                 运行记录与锁的文件实现
            cleanup.ts                 实际磁盘回收
          network/
            health.ts                  本地控制端点请求
        telemetry/
          trace.ts                     每次命令的单调时钟事件采集
          report.ts                    无重复计数的阶段归集
        config/                        现有单一配置源与加载/校验接口
        traefik/                       现有 Traefik 专属适配与模板
      relay/src/
        cli.ts                         组装存储、HTTP、认证模块
        core/auth/                     登录限流与授权领域规则
        adapters/http/                 Express 与反代可信来源校验
        adapters/storage/              SQLite 的唯一对接目录
      agent/src/
        cli.ts                         组装工具和通信适配
        core/                          与文件/终端无关的业务规则
        adapters/filesystem/           文件、格式和传输操作
        adapters/terminal/             终端和编码适配
        adapters/system/               系统探测及运行时信息
        adapters/telemetry/            Agent 用量及工具日志
    scripts/
      benchmark-cli.mjs                现有隔离基准入口扩展
      benchmark-cli-phases.mjs         保留诊断兼容，接入新阶段数据
    tests/
      brc-cli.test.mjs                 命令契约与输出流测试
      brc-lifecycle.test.mjs           启停和进程核验测试
      brc-logs.test.mjs                轮转、并发及保密测试
      brc-benchmark.test.mjs           阶段统计与基准环境测试
      brc-traefik.test.mjs             反代与登录限流安全回归

## Agent 阅读区

### 依据与违规证据

| 优先级 | 已核实问题 | 定位 | 整改方向 |
| --- | --- | --- | --- |
| 高 | 启动日志没有总耗时和分阶段计时，现有 benchmark 相位仅部分覆盖且明确未统计 cleanup | packages/cli/src/cli.ts；scripts/benchmark-cli-phases.mjs；packages/shared/src/managed-log.ts | 在统一生命周期编排埋点，用单调时钟记录闭合阶段，集中生成报告 |
| 高 | 启动状态查询在锁内预查、逐服务检查、完成后再查；自动清理另行运行 | cli.ts 的 start 与 runCli；lifecycle/services.ts 的 startUnlocked；maintenance/cleanup.ts | 先实测各阶段，再消除经证实的重复 IO；不得削弱身份和健康校验 |
| 高 | Relay 使用 trust proxy=true，生产日志有代理信任/限流警告，登录限流键依赖 req.ip | lifecycle/services.ts；relay/src/app.ts；relay/src/auth/rate-limit.ts | 验证可信代理跳数或来源，仅信任实际受控入口；用伪造转发头的隔离 E2E 检验 |
| 高 | --version、子命令 --help、JSON 输出和语义退出码未齐全；帮助描述与裸命令实际行为存在差异 | cli.ts 的 HELP_TEXT、dispatch、main；commands/config.ts | 统一命令定义、解析、帮助、结果渲染和错误语义 |
| 中 | 自动清理摘要写入 stdout；清理失败可仅有警告，仍与主命令共用无结构化结果 | cli.ts 的 clean/runCli；maintenance/cleanup.ts | 结果统一建模，诊断写 stderr，机器输出不混入维护消息 |
| 中 | main 与 dispatch 重复校验参数，使用未初始化 manager 的占位分支；服务对象在入口外有默认 new | cli.ts lightweight/dispatch；lifecycle/services.ts 构造参数；lifecycle/lock.ts | 单一解析入口、显式依赖注入、入口组装 |
| 中 | 核心混合 IO 和规则，公共目录按 utils 泛化，多个核心模块自行实例化单例 | lifecycle/processes.ts；relay/src/app.ts；agent/src/core/terminal-manager.ts、core/file-transfer.ts、core/utils/ | 以用例和数据归属重组核心/外部对接；公共模块按职责重命名 |
| 中 | 日志轮转默认 4 MiB 在共享模块与 CLI 配置重复硬编码 | shared/src/managed-log.ts；cli/src/config/settings.ts | 保留一份共享默认常量，CLI 环境配置仍为唯一运行时来源 |
| 中 | 旧 pnpm 版本的真实受管进程会因安装路径变更被判为异工作区 | CONTEXT.md 已记录；lifecycle/processes.ts 的身份判定 | 明确产品实例身份模型，核验所有权后才允许停止或替换 |
| 低 | docs/architecture.md 仍称 Windows x64 单平台，与现行跨平台设计不一致 | docs/architecture.md；CONTEXT.md | 更新已验证的跨平台范围，避免夸大未验证平台 |

### 用例、接口与职责

| 用例 | 使用者与操作 | 成功条件 | 失败表现 |
| --- | --- | --- | --- |
| 服务启动诊断 | 人在终端启动，查看近期耗时 | 完整阶段和总时长可核对，失败有终止事件 | 超时、部分启动、日志写入异常有可读原因 |
| 自动调用 | AI/脚本查看状态、配置、诊断 | stdout 为稳定 JSON，stderr 仅诊断 | 不支持参数返回 2，资源不存在返回 4 |
| 安全重启与升级 | 用户启停、重复调用与跨版本升级 | 真实归属核验后操作，部分状态如实报告 | 归属不明返回冲突 5，不杀无关进程 |
| 日志自维护 | CLI 每次执行维护受管数据 | 单次维护有界、轮转保留活跃文件 | 损坏目录安全保留并报告，原命令结果独立记录 |
| HTTP 登录限流 | Relay 在受控代理后接收登录请求 | 来源 IP 可追溯，伪造头不能重置限流键 | 可信代理异常时采取安全拒绝策略 |

| 核心接口 | 定义位置 | 实现位置 | 契约 |
| --- | --- | --- | --- |
| ProcessPort | cli/core/lifecycle/ports.ts | cli/adapters/process/controller.ts | start/stop/statusMany，返回带真实状态的结果 |
| IdentityPort | cli/core/lifecycle/ports.ts | cli/adapters/process/identity.ts | 按 PID、启动时间、执行路径、命令行校验归属 |
| RuntimeStatePort | cli/core/lifecycle/ports.ts | cli/adapters/storage/runtime.ts | 原子读取/写入记录、锁及失效恢复 |
| ControlHealthPort | cli/core/lifecycle/ports.ts | cli/adapters/network/health.ts | 带超时/取消的就绪与健康检查 |
| TraceSink | cli/telemetry/trace.ts | shared/managed-log.ts 适配 | begin/span/end，绝不记录凭据、授权头或原始命令参数 |
| CleanupPort | cli/core/maintenance/policy.ts | cli/adapters/storage/cleanup.ts | 返回 removed、preserved、failures、duration |
| CliRenderer | cli/commands/renderer.ts | cli/cli.ts 入口组装 | 相同结果数据产生文本/JSON；错误发往 stderr |

### 测量与日志约定

- 性能计时使用 performance.now()，时间戳仅用于跨服务对齐；每个 run_id 区分一次 CLI 调用，标注阶段名、服务、状态、elapsed_ms、duration_ms、error_code。总耗时由入口到最终退出计算，单项耗时只在非重叠区间求和，并单独列出未归属时间。
- 启动阶段：入口初始化、配置读取、锁等待、初始状态检查、Traefik 配置写入、逐服务预检查、spawn→ready、身份核验、健康就绪、启动后状态检查、自动清理、结果渲染。子进程内部耗时若暂不可见，作为父阶段整体报告，不假称已分解。
- 复用 shared/managed-log.ts 的追加与轮转能力。建议启动类命令每次生成一个 logs/cli-<run_id>.jsonl 文件，避免多 CLI 同时向同一文件轮转竞争；复用现有日志过期/容量管理。brc diagnose startup 从最近完整或失败的记录生成摘要。
- 日志失败不得遮蔽业务失败；诊断应记录原命令及清理各自的结果。自动清理的行为依 CLI 扩展规则保留为本项目明确例外：只回收 BRC 自有失效数据，不变更服务配置或外部资源；read-only 命令只允许这一受控后台维护副作用。
- 终端输出规范：stdout 为请求的数据，stderr 为提示和进度；JSON 错误仅 stderr，退出码 0/1/2/3/4/5/130/143。缺少 TTY 时禁止等待交互。支持 --yes/--preview 的命令必须明确变更范围。
- 对原生 Traefik 可执行文件的版本检查、健康轮询及身份查询，先根据真实分阶段数据判断是否需要缓存或合并。拒绝只为提速跳过校验。
- 性能验收使用隔离 BRC_DATA_ROOT、临时工作区与随机 loopback 端口，固定工作量至少五次采样，记录中位数、p95、各阶段分布及结果一致性。生产端只读分析，不主动停止、启动或升级。

### 决策记录与未决事项

- 采用原有 Node/TypeScript、共享轮转日志和基准脚本：降低新增依赖、与现行架构一致。
- 优先完成耗时采集再处理性能瓶颈：日志间隔只能定位范围，不能证明根因。
- 启动类日志每调用独立文件：隔离并发写入和文件轮转，避免为单纯读状态争抢生命周期锁。
- 核心依赖接口、外部适配统一实例化于 CLI/Relay/Agent 各自入口：满足可测试性和职责边界。
- 旧版本运行实例的安全处置按真实身份而非包路径文本判断：兼顾升级体验与进程安全。
- 待测量：最慢阶段及能否显著缩短整体时长；需要隔离实验确定，不按现有日志臆断。
- 待验证：可信代理源的准确边界与 IP 取值；需在隔离 Traefik→Relay 链路做伪造头测试。
- 待复验：Linux/macOS 的完整 CLI 命令契约与进程停止/信号行为；以 CI 与隔离机器结果为准。

### Skills 与验收边界

- 设计阶段：structure-design、code-rules、cli-rules、superpowers:brainstorming、superpowers:writing-plans、ste-zh。
- 性能和安全定位：superpowers:systematic-debugging；先证据再修复。
- 执行阶段：superpowers:test-driven-development、code-rules、cli-rules、structure-design、auto-git-commit；独立工作树并行时用 dispatching-parallel-agents。
- 验收与收束：superpowers:verification-before-completion、project-context、auto-git-commit；所有功能必须有可重复测试。