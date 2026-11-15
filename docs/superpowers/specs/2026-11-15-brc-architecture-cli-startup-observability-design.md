# BRC 架构、CLI 与启动耗时诊断设计

> 2026-11-15 · 状态：待实施 · 依据：structure-design、code-rules、cli-rules、项目 AGENTS.md 与 CONTEXT.md

## 用户阅读区

### 当前结论

- BRC 已保存 Relay、Traefik、Agent 三种服务日志，支持轮转、7 天默认保留期限和 50 MiB 默认总容量上限。它们主要记录运行事件，缺少统一的 CLI 启动耗时分解。
- 2026-11-15 11:14:12 Relay 开始监听，11:14:14 Traefik 输出启动信息，11:14:35 Agent 连接成功。之前多次启动也约有 23 秒的 Relay 到 Agent 连接间隔。这个间隔不是完整启动时长，尚不能归因于某个具体操作。
- CLI 启动中反复查询服务状态，退出时自动清理。这些步骤都可能耗时，但尚无生产分阶段计时。仓库已有隔离性能脚本，可复用。
- Relay 日志出现 Express 对 trust proxy 与 IP 限流配置的安全警告，须独立验证并修正。

### 改造结果

- 启动、停止和重启保存按阶段拆分的耗时记录，包括总时长、锁等待、配置准备、进程核验、健康检查和结束清理。诊断结果明确区分进程启动、服务就绪与 Agent 连通。
- 使用 brc start --timing 可直接看到阶段耗时；brc diagnose startup 可查看最近一次启动的耗时分配与失败位置；brc logs cli 查看详细原始记录。普通使用保持简洁。
- BRC 所有自有函数均纳入调用计时：统计调用次数、累计耗时与最大耗时。构建时统一插桩，运行时聚合统计，不逐次写磁盘；异常调用保留来源位置及可获得的调用栈。
- CLI、Relay、Agent 持续记录各自 CPU 和内存，Traefik 由管理进程读取子进程资源数据；保留采样和峰值。资源数据与启动耗时可关联。
- 统一日志入口、事件结构、分级、敏感信息处理、轮转与容量控制。复用现有 shared 日志写入器，不为每次命令创建永久独立日志文件。
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
| brc diagnose functions [--json] | 查看 BRC 自有函数的调用次数、累计耗时和最大耗时 |
| brc diagnose resources [--json] | 查看各受管进程的 CPU、内存采样与峰值 |
| brc status --json / brc config show --json | 无额外横幅或清理摘要，输出稳定 JSON |
| brc --version / brc version / brc start --help | 版本与命令帮助可直接查询，帮助包含可复制示例 |

### 预期文件树

    packages/
      shared/src/
        managed-log.ts                 现有轮转写入器，统一日志的文件适配
        diagnostics/                   共享诊断业务模块
          core/                        纯数据与统计逻辑，不操作文件和进程
            event.ts                   诊断事件、错误来源与结果结构
            ports.ts                   日志、函数探针和资源监测接口
            functions.ts               函数调用次数与耗时的有界聚合
            recorder.ts                诊断会话、阶段归集与结果汇总
          adapters/                    外部对接，入口负责实例化
            logging.ts                 统一日志级别、脱敏及轮转写入
            resources-node.ts         Node 进程 CPU/内存连续采样和峰值
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
            resources.ts               受管外部进程的 CPU/内存平台适配
          storage/
            runtime.ts                 运行记录与锁的文件实现
            cleanup.ts                 实际磁盘回收
          network/
            health.ts                  本地控制端点请求
        diagnostics/
          query.ts                     诊断读取与筛选，复用 shared 统一数据类型
        config/                        现有单一配置源与加载/校验接口
        traefik/                       现有 Traefik 专属适配与模板
      relay/src/
        cli.ts                         组装存储、HTTP、认证、共享诊断实例
        core/auth/                     登录限流与授权领域规则
        adapters/http/                 Express 与反代可信来源校验
        adapters/storage/              SQLite 的唯一对接目录
      agent/src/
        cli.ts                         组装工具、通信适配及共享诊断实例
        core/                          与文件/终端无关的业务规则
        adapters/filesystem/           文件、格式和传输操作
        adapters/terminal/             终端和编码适配
        adapters/system/               系统探测及运行时信息
        adapters/telemetry/            Agent 用量及工具日志
    native/brc-process/src/
      diagnostics.rs                    原生函数统计与进程资源摘要，保持机器输出契约
    scripts/
      instrument-functions.mjs         构建时为自有 TS/JS 函数统一插桩
      benchmark-cli.mjs                现有隔离基准入口扩展
      benchmark-cli-phases.mjs         保留诊断兼容，接入新阶段数据
    tests/
      brc-cli.test.mjs                 命令契约与输出流测试
      brc-lifecycle.test.mjs           启停和进程核验测试
      brc-logs.test.mjs                轮转、并发及保密测试
      brc-diagnostics-functions.test.mjs 自有函数覆盖与调用计时
      brc-diagnostics-resources.test.mjs CPU、内存和进程峰值
      brc-benchmark.test.mjs           阶段统计与基准环境测试
      brc-traefik.test.mjs             反代与登录限流安全回归

## Agent 阅读区

### 依据与违规证据

| 优先级 | 已核实问题 | 定位 | 整改方向 |
| --- | --- | --- | --- |
| 高 | 启动日志没有总耗时和分阶段计时，现有 benchmark 相位仅部分覆盖且明确未统计 cleanup | packages/cli/src/cli.ts；scripts/benchmark-cli-phases.mjs；packages/shared/src/managed-log.ts | 在统一生命周期编排埋点，用单调时钟记录闭合阶段，集中生成报告 |
| 高 | 全项目自有函数没有统一的调用次数和执行耗时统计 | packages/cli/src、relay/src、agent/src、shared/src；scripts/build-native.mjs；native/brc-process/src | 构建期自动插桩加统一运行时计数；覆盖原生 Rust 自有函数和常驻构建/发布 JS |
| 高 | 缺少持续 CPU/内存监测与峰值统计，现有日志只能显示服务事件 | shared/src、cli/src/lifecycle/services.ts、cli/src/traefik/runtime.ts | Node 自监测加受管 Traefik 子进程采样；统一有界记录及查询 |
| 中 | 各模块日志语义、结构及错误来源不一致；Agent 的模糊检索日志含原始检索内容及 diff | shared/src/managed-log.ts；agent/src/core/utils/logger.ts、fuzzySearchLogger.ts、trackTools.ts | 接入统一事件系统，保留专用出口但集中控制结构、脱敏、调用栈与保留策略 |
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
| 函数诊断 | 开发者检查自有代码热点 | 自有函数有调用次数、累计/峰值耗时，异常保留位置 | 无法覆盖的外部函数标记范围，诊断失败不影响业务 |
| 资源诊断 | 运维人员查看受管服务 CPU/内存 | CLI、Relay、Agent、Traefik 均有连续采样、资源变化及峰值 | 进程退出、重启或采样不可得时显示缺测状态 |
| HTTP 登录限流 | Relay 在受控代理后接收登录请求 | 来源 IP 可追溯，伪造头不能重置限流键 | 可信代理异常时采取安全拒绝策略 |

| 核心接口 | 定义位置 | 实现位置 | 契约 |
| --- | --- | --- | --- |
| ProcessPort | cli/core/lifecycle/ports.ts | cli/adapters/process/controller.ts | start/stop/statusMany，返回带真实状态的结果 |
| IdentityPort | cli/core/lifecycle/ports.ts | cli/adapters/process/identity.ts | 按 PID、启动时间、执行路径、命令行校验归属 |
| RuntimeStatePort | cli/core/lifecycle/ports.ts | cli/adapters/storage/runtime.ts | 原子读取/写入记录、锁及失效恢复 |
| ControlHealthPort | cli/core/lifecycle/ports.ts | cli/adapters/network/health.ts | 带超时/取消的就绪与健康检查 |
| DiagnosticLogPort | shared/diagnostics/core/ports.ts | shared/diagnostics/adapters/logging.ts → managed-log.ts | 统一结构化记录、错误来源、可得调用栈、脱敏、轮转和容量 |
| FunctionTimingPort | shared/diagnostics/core/ports.ts | shared/diagnostics/core/functions.ts，scripts/instrument-functions.mjs 注入调用 | 采集全部自有函数调用次数、总/最大耗时；有界聚合 |
| ResourceSamplePort | shared/diagnostics/core/ports.ts | shared/diagnostics/adapters/resources-node.ts、cli/adapters/process/resources.ts | 持续 CPU/内存采样、资源变化、峰值及缺测说明 |
| TraceSink | shared/diagnostics/core/ports.ts | shared/diagnostics/core/recorder.ts + shared/diagnostics/adapters/logging.ts | begin/span/end，绝不记录凭据、授权头或原始命令参数 |
| CleanupPort | cli/core/maintenance/policy.ts | cli/adapters/storage/cleanup.ts | 返回 removed、preserved、failures、duration |
| CliRenderer | cli/commands/renderer.ts | cli/cli.ts 入口组装 | 相同结果数据产生文本/JSON；错误发往 stderr |

### 测量与日志约定

- 性能计时使用 performance.now()，时间戳仅用于跨服务对齐；每个 run_id 区分一次 CLI 调用，标注阶段名、服务、状态、elapsed_ms、duration_ms、error_code。总耗时由入口到最终退出计算，单项耗时只在非重叠区间求和，并单独列出未归属时间。
- 启动阶段：入口初始化、配置读取、锁等待、初始状态检查、Traefik 配置写入、逐服务预检查、spawn→ready、身份核验、健康就绪、启动后状态检查、自动清理、结果渲染。子进程内部耗时若暂不可见，作为父阶段整体报告，不假称已分解。
- 复用 shared/managed-log.ts 的追加与轮转能力。使用日志组件自己的受控追加与滚动文件，事件内标记 run_id，避免每次命令生成永久独立文件；跨进程写入须保证完整记录、轮转并发安全及失败隔离。复用现有日志过期/容量管理。brc diagnose startup 从最近完整或失败的记录生成摘要。
- 全函数统计使用构建时统一插桩，不逐个文件人工添加计时器。覆盖自有 TS/JS 同步函数、异步函数、类方法、生成器和回调，保留调用语义；原生 Rust 使用统一探针。排除第三方依赖与 Traefik 外部二进制函数，外部边界作为 BRC 调用阶段计时。输出调用数、累计/最大耗时、函数身份和源码位置，不直接把异步重叠时长相加。插桩运行时处理自身调用的递归保护，覆盖清单自动核对。
- 长期运行的 Node 进程用 process.cpuUsage() 与 process.memoryUsage() 周期采样；正式构建/发布脚本、短时 CLI 和 Rust 原生查询器至少记录启动到退出的资源变化和峰值；受管 Traefik 子进程通过现有原生进程适配及跨平台探查采样。保存 CPU 使用变化、RSS/堆内存、峰值和采样缺口。采样间隔、内存上限和保留期限从现有 settings.ts 取得，资源监测与日志写盘均有界。
- 统一日志事件包含时间、级别、服务、run_id（CLI 命令）和 instance_id（受管服务实例）、来源文件/函数、错误原因及可用调用栈。只有异常路径收集堆栈，普通函数调用仅在内存聚合。迁移 Agent 工具历史与模糊检索日志时去除原始敏感命令、检索内容及差异文本，避免泄漏凭据或私人文件内容。
- 日志失败不得遮蔽业务失败；诊断应记录原命令及清理各自的结果。自动清理的行为依 CLI 扩展规则保留为本项目明确例外：只回收 BRC 自有失效数据，不变更服务配置或外部资源；read-only 命令只允许这一受控后台维护副作用。
- 终端输出规范：stdout 为请求的数据，stderr 为提示和进度；JSON 错误仅 stderr，退出码 0/1/2/3/4/5/130/143。缺少 TTY 时禁止等待交互。支持 --yes/--preview 的命令必须明确变更范围。
- 对原生 Traefik 可执行文件的版本检查、健康轮询及身份查询，先根据真实分阶段数据判断是否需要缓存或合并。拒绝只为提速跳过校验。
- 性能验收使用隔离 BRC_DATA_ROOT、临时工作区与随机 loopback 端口，固定工作量至少五次采样，记录中位数、p95、各阶段分布及结果一致性。生产端只读分析，不主动停止、启动或升级。

### 决策记录

| 决定 | 理由 | 对应用例 |
| --- | --- | --- |
| 复用共享轮转日志、Node/TS 和既有隔离基准脚本 | 统一日志语义，减少新依赖和重复实现 | 日志自维护、服务启动诊断 |
| 共享诊断核心与文件/系统适配分离，服务入口连接实例 | 核心可纯测试，运行计时、日志和资源采样由全部模块复用 | 函数诊断、资源诊断、服务启动诊断 |
| 构建期统一插桩并在运行时聚合，Rust 复用自有探针 | 记录全部自有函数的真实调用数和耗时，避免逐次写盘 | 函数诊断 |
| Node 自监测与 Traefik 子进程适配配合 | 覆盖 BRC 各类受管进程，统一采样格式和资源峰值 | 资源诊断 |
| 按组件轮转日志，以命令 ID 和服务实例 ID 关联事件 | 保护并发写入，避免运行一次新增一个长期存在的日志文件 | 日志自维护、服务启动诊断 |
| 先测量启动各阶段，再修改瓶颈 | 两个日志时间戳的差值无法确定真实瓶颈 | 服务启动诊断 |
| 仅按真实进程身份处理升级残留 | 跨 pnpm 版本保持可控启停，不误操作其他进程 | 安全重启与升级 |
| CLI 输出统一来源结果模型 | 人类阅读与自动调用复用结果，输出流和退出码一致 | 自动调用 |

### 未决问题

| 问题 | 影响 | 负责确认 |
| --- | --- | --- |
| 启动流程的实际最慢阶段 | 决定后续针对哪段重复检查优化 | 执行阶段隔离基准 |
| 可信代理源和真实 IP 的提取边界 | 决定认证限流的安全配置 | 隔离 Traefik→Relay E2E |
| 自动插桩的语言语义和计时开销 | 影响生成器、异步及原生函数的覆盖与性能 | 插桩测试与性能测试 |
| Windows/Linux/macOS 的资源采样可用性与误差 | 影响外部 Traefik CPU/内存峰值的完整性 | 跨平台隔离测试 |
| Linux/macOS 退出信号与状态恢复 | 决定跨平台 CLI 验收覆盖范围 | CI 与独立系统验证 |

### Skills 与验收边界

- 设计阶段：structure-design、code-rules（含新「运行诊断」）、cli-rules、superpowers:brainstorming、superpowers:writing-plans、ste-zh。
- 性能和安全定位：superpowers:systematic-debugging；先证据再修复。
- 全函数和资源诊断设计与实现：code-rules「运行诊断」、structure-design 诊断基础设施检查项、superpowers:test-driven-development；验证全函数覆盖率、计时误差、资源采样开销和峰值。
- 复用诊断系统贯穿 CLI、Relay、Agent、原生进程查询器、正式构建发布脚本；禁止在各模块复制日志写入和采样实现。
- 执行阶段：superpowers:test-driven-development、code-rules、cli-rules、structure-design、auto-git-commit；独立工作树并行时用 dispatching-parallel-agents。
- 验收与收束：superpowers:verification-before-completion、project-context、auto-git-commit；所有功能必须有可重复测试。