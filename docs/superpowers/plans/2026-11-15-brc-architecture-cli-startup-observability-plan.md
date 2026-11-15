# BRC 架构、CLI 与启动耗时诊断实施计划

> **Agent 执行入口**：superpowers:executing-plans 或 superpowers:subagent-driven-development；工作以测试驱动、独立工作树、分批验收开展。

**目标**：修复已核实的架构与 CLI 违规点，补齐可追溯的启动耗时诊断，依据测量结果优化启动，解决代理信任警告。

**架构**：沿用 TypeScript、Node.js、Rust 原生进程查询器与现有日志轮转。项目复用共享诊断模块，统一提供日志、全函数调用计时和 CPU/内存采样；通过接口连接业务流程与外部适配，CLI 只负责命令与结果展示。

**设计稿**：docs/superpowers/specs/2026-11-15-brc-architecture-cli-startup-observability-design.md

**约束**：生产端只读；严禁重启、停止、升级或修改真实 BRC。开发、压测使用独立工作树、BRC_DATA_ROOT 和随机端口。禁止修改全局包/工具环境。只完成文档时不得提前实施代码。

## 用户阅读区

### 推进顺序

- 先建立统一的运行诊断：日志、全函数计时、持续 CPU/内存监测。在此基础上记录启动各阶段耗时，确定瓶颈后再加速。代理限流安全测试可以同步开展。
- 先处理 CLI 外部行为：统一命令帮助、机器可读结果、诊断显示、错误与取消。保持简单的日常操作。
- 然后整理核心业务与外部对接结构，在真实需要的地方消除重复实现，不为重构而重构。
- 将日志发现的代理安全警告独立复现并修复，确保限流不会被伪造的转发头绕过。
- 最后用隔离环境对照新旧版本，核实速度、功能、安全和日志结果一致。

### 预期文件树

    packages/
      shared/src/
        managed-log.ts                     现有共享日志文件轮转
        diagnostics/
          core/                            共享诊断模型、函数和阶段计时接口
          adapters/                        日志锁、原子快照及 Node 资源采样
      cli/src/
        cli.ts                               唯一入口与对象连接
        commands/                            命令解析、状态展示、诊断查询
        core/lifecycle/                      启停规则、流程与依赖接口
        core/maintenance/                    数据回收规则
        adapters/process/                    进程启动、身份与外部进程资源采样
        adapters/storage/                    状态记录与磁盘清理
        adapters/network/                    就绪和健康请求
        diagnostics/                         诊断日志、函数和资源结果查询
        config/settings.ts                   唯一诊断参数来源与校验
        traefik/                             代理业务及专有适配
      relay/src/
        core/auth/                           身份与限流规则
        adapters/http/                       HTTP 和可信代理适配
        adapters/storage/                    数据库适配
      agent/src/
        core/                                纯业务规则
        adapters/filesystem/                 文件外部对接
        adapters/terminal/                   终端外部对接
        adapters/system/                     系统探测
        adapters/telemetry/                  工具记录
    native/brc-process/src/diagnostics.rs    Rust 自有函数探针
    scripts/instrument-functions.mjs          TS/JS 函数的构建期统一插桩
    scripts/build-native.mjs                  交给 Cargo 增量依赖跟踪
    scripts/test-unit.mjs                     自动发现单元测试并统一调用
    scripts/benchmark-cli*.mjs                隔离性能验证
    tests/brc-*.test.mjs                     接口、性能、安全回归
    docs/architecture.md                     更新现行跨平台架构

### 交付与验收

- 可直接看到一次启动的总耗时、服务耗时和最慢阶段；失败、取消也能追溯。
- 可查询项目自有函数调用次数及耗时、各服务 CPU 与内存变化及峰值；区分同步执行与异步等待、系统峰值与采样峰值，并标出过期或不可用的诊断数据。
- CLI 对人易读，对脚本可解析；常规启动不增加多余操作。
- 既有服务身份和进程保护逻辑不退化；未知归属仍拒绝干预。
- 以同等条件对比启动耗时，不用日志时间差替代基准成绩。

## Agent 阅读区

### 基线与执行准备

- 已读并遵守顶层 AGENTS.md、CONTEXT.md、全局 AGENTS.md/RULES.md。2026-11-15 本地源码在 main，工作树起始干净。
- 用 superpowers:using-git-worktrees 和 auto-git-commit 创建隔离工作树；并发开发必须各自独立工作树，禁止同时修改同一组文件。每批提交、合入 main 前使用 verification-before-completion。
- 首先从已有源码和隔离基准验证现状，禁止使用生产数据根或生产端口。基线包含冷启动、重复启动、status、help、stop，每项至少五次测量；保留各次结果和环境参数，不修改现有服务。
- 实施阶段共同应用 code-rules（含「运行诊断」）、cli-rules；结构调整使用 structure-design 并检查诊断基础设施的目录、接口与接线；未知慢因与安全问题使用 superpowers:systematic-debugging；每项修改使用 superpowers:test-driven-development。文档使用 ste-zh，阶段收束使用 project-context。

### 并行前置批次：共享诊断基础设施与反代安全

**任务：共享诊断接口与日志管理**

- [ ] 复用 packages/shared/src/managed-log.ts，新增 packages/shared/src/diagnostics/core/{event,ports,recorder,functions}.ts 与 adapters/{logging,log-lock,snapshots,resources-node}.ts。纯统计核心定义日志、计时、快照及采样接口；文件写入、互斥与系统资源读取由适配器实现。各服务入口负责创建对象及连接依赖。
- [ ] 统一结构化日志：level、timestamp、component、run_id、instance_id、source、message、error_code、stack。只在异常时提取可用堆栈；禁止将令牌、密码、cookie、敏感命令、检索正文和文件 diff 写入常规诊断日志。
- [ ] 在 packages/cli/src/config/settings.ts 中一次性定义 diagnostics 组的启用策略、资源采样间隔、函数统计快照间隔、最大记录容量及保留期，维护 BrcSettings、默认值、合法范围、copy/merge、BRC_SETTING_KEYS、环境映射及 config get/set/show。通过 packages/cli/src/lifecycle/services.ts 现有子进程环境白名单传递到 Relay、Agent 和 Traefik 管理进程；子服务不重复设默认值。增加 tests/brc-config.test.mjs 的优先级、错误输入和端到端传递测试。
- [ ] 日志由组件轮转文件保存，不为每条 CLI 命令单独建日志。现有 managed-log.ts 的 writeQueues 只管理单进程；为 cli.log 追加/轮转增加独立跨进程锁，以原子建锁、归属核验、有限等待与安全崩溃回收管理。锁与生命周期锁分离，写盘失败只降级诊断。JSONL 超长事件写脱敏摘要，禁止截断半条 JSON 记录。
- [ ] 先添加 tests/brc-diagnostics-logging.test.mjs：从多个独立 Node 进程同时写 cli.log，触发轮转、模拟持锁进程崩溃/等待超时并检查 JSONL 逐行解析；覆盖路径替换、敏感数据、满额回收、活跃文件保护及写入失败。确认旧日志可读，主命令结果不受诊断损坏影响。
- [ ] 将已定位的 agent/src/core/utils/{logger,fuzzySearchLogger,trackTools}.ts、Relay/Agent console 输出及 Traefik 代理写入器接入统一诊断入口，原有 MCP 日志/控制台展示仅作为对外适配；常规日志不保留原始检索内容或 diff，工具原有对外结果与内部运行日志分开。
- [ ] 定义并实现 DiagnosticSnapshotPort：Relay、Agent 和 Traefik 管理进程按 service、instance_id 原子更新最新函数/资源快照，记录进程身份、采集时间、数据版本及部分失败。停止时有界 flush，异常退出时保留最后完整快照。CLI 查询不读取其他进程内存，以权限和归属校验读取快照；按过期时间区分当前/退出/过期/缺测。短时 CLI 结果按 run_id 保留在组件轮转日志。
- [ ] 先添加 tests/brc-diagnostics-snapshots.test.mjs，覆盖多进程写读、原子替换、服务重启、旧快照过期、损坏记录、活跃文件保护、数据容量与清理，禁止把失效文件误当当前状态。
- [ ] 在 scripts/test-unit.mjs 使用 Node 文件枚举按约定发现 tests/brc-*.test.mjs 与 packages/relay/test/unit.test.mjs；不依赖 Windows Shell 展开通配符。根 package.json 的 test:unit 只调用这一入口。新增测试必须自动进入单元测试清单，同时排除 E2E、打包脚本和非测试文件。增加枚举与执行结果自检。
- [ ] 验证新增单元测试、tests/brc-logs.test.mjs、tests/brc-clean.test.mjs，并确认自动发现包含全部现有和新增单元测试；完成后固定接口，允许函数与资源任务独立工作树并行。

**任务：反向代理信任边界**

- [ ] 以已核实的 relay/src/app.ts 中 trust proxy=true、登录限流依赖 req.ip 及 services.ts 的代理环境传递为基础，先编写伪造转发头的隔离失败测试；不在实施阶段重新进行无目标的源码探查。
- [ ] 增加 tests/brc-proxy-trust.test.mjs 和必要的隔离 Traefik→Relay 端到端测试：未经信任的客户端伪造 X-Forwarded-For 不改变实际限流身份；同一来源无法通过改头规避连续失败限制；正常访问、OAuth、设备连接仍可用。
- [ ] 修改单一可信代理入口适配，限定允许的代理来源或跳数；受控链路有可信客户端地址，直连/意外拓扑采取安全行为。配置来源及可调项均纳入现有 settings.ts，不在多处硬编码。
- [ ] 完成后执行新增安全测试、tests/brc-traefik.test.mjs 及隔离 E2E；保留安全风险修复依据，不把日志警告本身等同于已被利用。
- [ ] 与共享诊断基础设施使用独立工作树并行验证和修复。配置传播及 cli.ts/services.ts 的变更由主 Agent 在合并阶段协调。

### 并行批次：函数计时与资源监测

**任务：覆盖项目全部自有函数**

- [ ] 在 scripts/instrument-functions.mjs 集中实现构建期插桩，覆盖 packages/{cli,relay,agent,shared}/src 中自有同步/异步函数、类方法、回调、生成器和访问器；构建/发布 JS 脚本纳入同一覆盖清单。输出函数 ID 与源码映射，统计可测函数总数及不可测原因；保持原函数调用、this、Promise、异常及生成器语义。第三方依赖与生成文件不计入自有函数。
- [ ] 在 shared/diagnostics/core/functions.ts 按函数 ID 聚合调用次数、累计及最大耗时，使用单调时钟。同步函数记录调用执行时长；异步函数记录调用到 Promise 完成的墙钟时间并标注包含 await 等待；生成器按每次 next/throw/return 的执行片段计时，不累计 yield 挂起间隔。普通调用只更新内存；异常记录来源和可得堆栈，采集器递归受控。
- [ ] 在 native/brc-process/src/diagnostics.rs 对自有 Rust 函数复用统一探针，向 CLI 诊断适配输出计数和耗时，保持 Windows 原生身份查询 stdout JSON 契约。短时原生进程记录资源摘要及可靠峰值来源；无法测出的值标记缺测。Traefik 第三方二进制仅统计资源和调用边界。
- [ ] 修正 scripts/build-native.mjs 固定五个输入文件的时间戳判断：每次走 cargo build --release --locked，由 Cargo 的增量依赖跟踪判断是否重编译；编译输出仍须检验 PE 格式并仅在产物变化时复制。添加修改/新增 Rust 模块触发重编译的隔离测试，并测量未改动时的构建开销。
- [ ] 先编写 tests/brc-diagnostics-functions.test.mjs：对照源码函数清单检查覆盖；断言同步/异步/抛错/递归/闭包/生成器、调用次数、累计及最大耗时；分别检查 TS/JS 与 Rust 输出。增加诊断关闭/启用语义对照及开销基准，保护定时器、Promise 和异常传播。
- [ ] 将现有构建与打包脚本接入插桩和源码映射，验证正式发行包的函数覆盖表与实际调用一致；禁止将采样型 profiler 的估算值当作真实调用次数。应用 code-rules、structure-design、superpowers:test-driven-development。

**任务：持续监测各进程 CPU 与内存**

- [ ] 通过 shared/diagnostics/adapters/resources-node.ts 采样 CLI、Relay、Agent 及构建/发布脚本的 CPU 时间、CPU 使用变化、RSS 与堆内存。长驻进程持续采样，短命进程启动及退出时补充平台资源计数器；优先使用可靠系统峰值，缺少时将最大采样值标为 sampled_peak 并附采样窗口，不声称真实峰值。
- [ ] 扩展 cli/adapters/process/resources.ts 及现有原生/跨平台查询，监测 Traefik 子进程。每条资源记录标识进程身份、测量来源、采样窗口和峰值，异常退出、权限不足或平台不支持时显示缺测状态。
- [ ] 先编写 tests/brc-diagnostics-resources.test.mjs：持续采样、CPU/内存上升及回落、真实系统峰值与 sampled_peak 的区分、短命进程采样盲区、PID 复用、进程退出、不可读状态、定时器回收及日志容量。对照有无监测的启动耗时与内存开销。
- [ ] 确保日志、函数统计、资源采样由同一个诊断模块协调，并通过统一接口供 CLI、Relay、Agent 复用；不得在业务模块复制监测循环。应用 code-rules「运行诊断」、structure-design 和 superpowers:test-driven-development。

**并发分工**：共享诊断与代理安全分别在独立工作树同步开始，互不修改相同源文件；共享诊断接口验收后再并行执行函数计时与资源监测，涉及 shared/diagnostics 相同文件由主 Agent 串行整合。测试与安全验收由主 Agent 汇总。


### 依赖批次：启动耗时记录

**任务：可追溯的单次命令耗时**

- [ ] 复用 shared/diagnostics/core/recorder.ts 的 begin、span、finish 接口，CLI 生命周期仅传阶段标识和服务结果。各模块使用同一时间计量与日志通道，不再建立 cli/telemetry 第二套基础设施。
- [ ] 先添加 tests/brc-startup-trace.test.mjs：成功、异常和取消均闭合；run_id 唯一；非重叠阶段合计与总耗时对应；包含未归属耗时；日志禁止包含 token、授权头和密码。
- [ ] 阶段记录写入统一 CLI 日志流，依 run_id 筛选；在 CLI 退出前完成一次有界 flush。字段包含 trace_schema、command、stage、service、status、start_time、duration_ms、error_code。父阶段与子阶段重叠耗时不相加，未归属时长单列。
- [ ] 扩展 packages/cli/src/lifecycle/lock.ts、services.ts、processes.ts、cli.ts：入口初始化、配置加载、锁等待、预状态检查、Traefik 配置、逐服务预检查、spawn→ready、身份验证、健康确认、后状态查询、自动清理和退出摘要均有跨度。流程与控制器使用可选 TraceSink 传入，单项异常保留失败阶段。
- [ ] tests/brc-lifecycle.test.mjs 覆盖失败/中断、部分启动、锁竞争与既存服务；日志异常不得把业务成功改为失败或掩盖原始错误。不得因为计时跳过安全校验。
- [ ] 完成后用 node --test tests/brc-startup-trace.test.mjs tests/brc-lifecycle.test.mjs 和 pnpm build 验证。

### 依赖批次：CLI 命令契约与日志查询

**任务：统一命令定义及输出**

- [ ] 创建 packages/cli/src/commands/parser.ts、renderer.ts。命令树成为唯一语法和帮助来源；移除 cli.ts 的 lightweight/dispatch 双份参数校验及未初始化对象占位。
- [ ] 明确定义 brc --version、brc version、brc <command> --help、brc help <command>、--json、--timing、--no-input、--quiet、--verbose；保留已有用例和交互，帮助中提供真实可执行示例。
- [ ] 给 status、config、diagnose、help/version 等返回数据的命令同一结果对象；JSON 为 stdout 单一合法值，进度、警告与清理摘要仅 stderr，错误 JSON 放 stderr。退出码分别覆盖成功 0、运行失败 1、用法 2、鉴权 3、不存在 4、冲突 5、取消 130/143。
- [ ] 对 setup/uninstall 的 prompt 使用 stdin 与 stderr 独立 TTY 检测；非交互执行必须有参数或环境输入路径，缺少必要输入时明确返回 2，不能挂起。
- [ ] 更新 tests/brc-cli.test.mjs：各深度帮助与错误语法、--json 可 JSON.parse、stdout 零杂讯、无 TTY 不阻塞、Ctrl+C/SIGTERM 传播取消并释放资源；实现前先让新增测试失败。
- [ ] 生命周期结果使用 ProcessPort 和 ServiceStatus，不通过自由格式的 detail 字符串决定是否允许自动恢复；建立明确原因类型，测试所有陈旧/损坏/真实异工作区状态。

**任务：启动诊断与日志管理**

- [ ] 创建 packages/cli/src/commands/diagnostics.ts，支持 brc diagnose startup、brc diagnose functions、brc diagnose resources（各可 --json）和 brc start --timing。读取共享组件日志和服务实例原子快照，显示各进程身份、采集时间、当前/已退出/过期/缺测状态，区分异步等待和 CPU 时间、真实峰值和采样峰值；首次无数据返回明确空结果。
- [ ] 扩展 packages/cli/src/maintenance/logs.ts 识别 CLI 日志和服务诊断快照。按现有保留期/容量上限清理过期记录，校验文件归属、符号链接和活跃实例；多进程轮转使用独立诊断锁，清理不能移除正在写的文件。
- [ ] 依据 CLI extension，保留每次命令启动自身数据清理这一明确项目例外；仅回收 BRC 的失效数据，绝不触碰用户配置和生产服务；从 stderr 报告清理并在同一结果模型中记录耗时、失败、保留条目。
- [ ] 更新 tests/brc-logs.test.mjs、tests/brc-clean.test.mjs、tests/brc-cli.test.mjs：并行写入、轮转与保留、安全路径、只读输出、自动清理一次、日志写入失败、缺失日志，以及函数/资源查询的机器输出。
- [ ] 执行受影响测试、pnpm build，再执行完整 pnpm test:unit。

### 依赖批次：结构整理及性能优化

**任务：核心与外部适配解耦**

- [ ] 基于设计稿接口表从 CLI 生命周期开始迁移：core/lifecycle/{policy,workflow,ports}.ts；adapters/process/{identity,controller}.ts、storage/{runtime,cleanup}.ts、network/health.ts。CLI 入口统一创建对象并连接依赖；拆分过程保留安全顺序与身份校验。
- [ ] 将 Relay 登录限流规则归 core/auth，Express 与 SQLite 归 adapters/http、adapters/storage，并从 relay/cli.ts 注入；将 Agent core 下实际触及文件、终端、系统或外部日志的对象迁移到按业务职责命名的 adapters；核对每个 utils 文件的真实职责，迁移后仅删除无引用的泛化目录。保留原有工具调用对外契约。
- [ ] 按设计稿中已核实的源文件及职责完成迁移，不建立空目录、无用例抽象层或历史兼容包装。每次迁移同步调整导入路径和测试；仅保留确实服务于多模块的共享实现。
- [ ] 统一共享 managed-log 默认值与 CLI settings.ts；运行时的唯一配置来源仍是 settings.ts，内部无硬编码副本。
- [ ] 增加单元测试确认纯规则模块无 fs/net/child_process 依赖、外部实例仅入口构造、公共目录按职责；确保每项用例对应的诊断模块、日志接口与资源采样器都能在目录树找到。增删文件与导入随每一子任务同步验证。
- [ ] 此批次可按 CLI / Relay / Agent 三个独立工作树并行，但必须在测量与命令契约接口稳定后开始；结构选择复核 structure-design 的用例、目录、接口、决策和未决事项。

**任务：实测瓶颈与升级恢复**

- [ ] 用 scripts/benchmark-cli.mjs 扩展的隔离测量对比相同环境、工作负载与服务版本的改造前后数据；诊断用脚本可标注嵌套区间，但正式报告只展示不重复计数的分配。
- [ ] 按耗时排序，仅处理已经量化的最慢非必要重复工作。例如状态查询、Traefik version 校验或清理检查，先确认可复用/缓存的有效期及身份、安全约束，再改代码。
- [ ] 旧 pnpm 版本进程路径变更问题由 typed identity policy 处理。验证进程创建时间、命令行、路径、控制端口及所有权；允许确定归属的安全停止，无法确认则返回冲突，不误杀外部进程。
- [ ] tests/brc-benchmark.test.mjs、tests/brc-lifecycle.test.mjs 覆盖五次冷/热测量、状态语义、错误恢复与旧版本实例；同时记录诊断本身对 CPU、内存、启动时长的额外开销。记录基线和新中位数/p95，未验证提升则如实报告。

### 集成批次：说明、全面验收与合并

- [ ] 修订 docs/architecture.md 的已验证跨平台范围，README.md / README_zh.md 的诊断命令、数据新鲜度、异步计时口径、系统峰值/采样峰值、日志位置和错误约定；维持配置与版本唯一来源。
- [ ] 执行 pnpm build、pnpm test:unit、受影响的隔离 E2E、pnpm test:package；确认新单元测试自动进入全量运行，Rust 新文件触发构建。验证真实多 CLI 日志轮转、原子快照重启/过期、函数计时语义、CPU/内存峰值来源、诊断配置端到端生效；验证发行包与无 TTY、PowerShell 7/5.1、CMD。Linux/macOS 仅报告实际 CI 或隔离机器结果。
- [ ] 安全复核：伪造代理头、损坏/陈旧 PID、并行启停/清理、信号中断、日志满额、只读命令污染；记录每项结果和未验证内容。
- [ ] 使用 auto-git-commit 每个可独立验收模块提交，完成后按项目要求合并 main、清理临时工作树并按 project-context 全量同步 CONTEXT.md；新版本发布、GitHub 推送及生产升级须另获授权。
- [ ] 当本设计和计划全部实施、验收完毕后，依项目规则删除完成稿件，历史保留于 Git。

### 风险与自检

- **安全**：进程身份验证和代理信任不能为提速牺牲；诊断不得写 token、cookie、密码、控制端口鉴权信息。
- **计时**：跨进程日志时间戳仅用于辅助；总耗时与阶段分配必须以单调时钟闭合测量，显示未归属时间，避免重复相加。函数累计耗时与服务启动总时长不可直接相加，异步调用尤其需要明确计时语义。
- **隐私**：统一日志不保留普通工具调用的原始参数、文件正文或模糊搜索 diff；异常记录只保存必要来源、错误与脱敏调用栈。
- **兼容**：现有 CLI 行为保持用户可依赖的接口；若旧行为与 CLI Style 冲突，使用本项目约定并在文档列明，例如每次命令的受限自身数据清理。
- **验收焦点**：首次空数据运行、长时间锁竞争、日志写盘失败、部分成功、正常与错误 JSON、非交互提示、安全代理头、旧进程归属和平台差异均有对应测试。
- **诊断验收**：运行与发行包都覆盖自有函数调用统计；同步、异步、生成器、Rust、正式脚本及异常测试有覆盖清单。CLI、Relay、Agent、Traefik 都有 CPU/内存采样与峰值，指标缺失时明确说明；通过压力及并发测试验证采样和日志不会显著拖慢启动或无限占用内存。
- **完成判断**：每项审查问题均能指向文件、独立测试及观察到的结论；仍未知的性能/安全结果明确标记待测，不能以代码已经写入替代验证。