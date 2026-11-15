# BRC 架构、CLI 与启动耗时诊断实施计划

> **Agent 执行入口**：superpowers:executing-plans 或 superpowers:subagent-driven-development；工作以测试驱动、独立工作树、分批验收开展。

**目标**：修复已核实的架构与 CLI 违规点，补齐可追溯的启动耗时诊断，依据测量结果优化启动，解决代理信任警告。

**架构**：沿用 TypeScript、Node.js、现有 BRC 配置、日志轮转和隔离测试体系；业务编排通过接口调用进程、磁盘及网络适配器；命令、诊断、日志共享统一执行结果。

**设计稿**：docs/superpowers/specs/2026-11-15-brc-architecture-cli-startup-observability-design.md

**约束**：生产端只读；严禁重启、停止、升级或修改真实 BRC。开发、压测使用独立工作树、BRC_DATA_ROOT 和随机端口。禁止修改全局包/工具环境。只完成文档时不得提前实施代码。

## 用户阅读区

### 推进顺序

- 先让 BRC 准确记录启动每个阶段的耗时，保留现有日志能力。先确定到底哪里慢，再进行加速。
- 先处理 CLI 外部行为：统一命令帮助、机器可读结果、诊断显示、错误与取消。保持简单的日常操作。
- 然后整理核心业务与外部对接结构，在真实需要的地方消除重复实现，不为重构而重构。
- 将日志发现的代理安全警告独立复现并修复，确保限流不会被伪造的转发头绕过。
- 最后用隔离环境对照新旧版本，核实速度、功能、安全和日志结果一致。

### 预期文件树

    packages/
      shared/src/managed-log.ts             共享日志文件轮转
      cli/src/
        cli.ts                               唯一入口与对象连接
        commands/                            命令解析、状态展示、诊断查询
        core/lifecycle/                      启停规则、流程与依赖接口
        core/maintenance/                    数据回收规则
        adapters/process/                    进程启动和身份校验
        adapters/storage/                    状态记录与磁盘清理
        adapters/network/                    就绪和健康请求
        telemetry/                           各阶段计时与结果汇总
        config/                              现有统一设置来源
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
    scripts/benchmark-cli*.mjs               隔离性能验证
    tests/brc-*.test.mjs                     接口、性能、安全回归
    docs/architecture.md                     更新现行跨平台架构

### 交付与验收

- 可直接看到一次启动的总耗时、服务耗时和最慢阶段；失败、取消也能追溯。
- CLI 对人易读，对脚本可解析；常规启动不增加多余操作。
- 既有服务身份和进程保护逻辑不退化；未知归属仍拒绝干预。
- 以同等条件对比启动耗时，不用日志时间差替代基准成绩。

## Agent 阅读区

### 基线与执行准备

- 已读并遵守顶层 AGENTS.md、CONTEXT.md、全局 AGENTS.md/RULES.md。2026-11-15 本地源码在 main，工作树起始干净。
- 用 superpowers:using-git-worktrees 和 auto-git-commit 创建隔离工作树；并发开发必须各自独立工作树，禁止同时修改同一组文件。每批提交、合入 main 前使用 verification-before-completion。
- 首先从已有源码和隔离基准验证现状，禁止使用生产数据根或生产端口。基线包含冷启动、重复启动、status、help、stop，每项至少五次测量；保留各次结果和环境参数，不修改现有服务。
- 实施阶段共同应用 code-rules、cli-rules；结构调整应用 structure-design；未知慢因与安全问题应用 superpowers:systematic-debugging；每一修改应用 superpowers:test-driven-development。设计表述使用 ste-zh，最终同步项目上下文使用 project-context。

### 并行批次：诊断测量与安全测试

**任务：可追溯的单次命令耗时**

- [ ] 新建 packages/cli/src/telemetry/trace.ts 与 report.ts。定义 TraceRecorder 的 begin、span、finish 方法；注入 monotonicClock 和 TraceSink，不在核心直接操作文件。
- [ ] 先添加 tests/brc-startup-trace.test.mjs：成功、异常和取消均闭合；run_id 唯一；非重叠阶段合计与总耗时对应；包含未归属耗时；日志禁止包含 token、授权头和密码。
- [ ] 复用 packages/shared/src/managed-log.ts 的容量受控写入；每次 CLI 调用使用单独的 logs/cli-<run_id>.jsonl；报告结束时执行一次 flush。记录 trace_schema、run_id、command、stage、service、status、start_time、duration_ms、error_code，阶段计时不依赖系统时间跳变。
- [ ] 扩展 packages/cli/src/lifecycle/lock.ts、services.ts、processes.ts、cli.ts：入口初始化、配置加载、锁等待、预状态检查、Traefik 配置、逐服务预检查、spawn→ready、身份验证、健康确认、后状态查询、自动清理和退出摘要均有跨度。流程与控制器使用可选 TraceSink 传入，单项异常保留失败阶段。
- [ ] tests/brc-lifecycle.test.mjs 覆盖失败/中断、部分启动、锁竞争与既存服务；日志异常不得把业务成功改为失败或掩盖原始错误。不得因为计时跳过安全校验。
- [ ] 完成后用 node --test tests/brc-startup-trace.test.mjs tests/brc-lifecycle.test.mjs 和 pnpm build 验证。

**任务：反向代理信任边界**

- [ ] 读取 packages/relay/src/app.ts、packages/relay/src/auth/rate-limit.ts、packages/cli/src/lifecycle/services.ts、Traefik 配置模板以及实际使用的反代路径，定位 Express 的 trust proxy=true 与登录限流告警来源。
- [ ] 增加 tests/brc-proxy-trust.test.mjs 和必要的隔离 Traefik→Relay 端到端测试：未经信任的客户端伪造 X-Forwarded-For 不改变实际限流身份；同一来源无法通过改头规避连续失败限制；正常访问、OAuth、设备连接仍可用。
- [ ] 修改单一可信代理入口适配，限定允许的代理来源或跳数；受控链路有可信客户端地址，直连/意外拓扑采取安全行为。配置来源及可调项均纳入现有 settings.ts，不在多处硬编码。
- [ ] 完成后执行新增安全测试、tests/brc-traefik.test.mjs 及隔离 E2E；保留安全风险修复依据，不把日志警告本身等同于已被利用。
- [ ] 两项可并行，由主 Agent 汇总计时接口和安全边界，分别独立工作树开发；互不修改同一文件时方可并行，涉及 cli.ts、services.ts 时先合并计时任务再接入安全适配。

### 依赖批次：CLI 命令契约与日志查询

**任务：统一命令定义及输出**

- [ ] 创建 packages/cli/src/commands/parser.ts、renderer.ts。命令树成为唯一语法和帮助来源；移除 cli.ts 的 lightweight/dispatch 双份参数校验及未初始化对象占位。
- [ ] 明确定义 brc --version、brc version、brc <command> --help、brc help <command>、--json、--timing、--no-input、--quiet、--verbose；保留已有用例和交互，帮助中提供真实可执行示例。
- [ ] 给 status、config、diagnose、help/version 等返回数据的命令同一结果对象；JSON 为 stdout 单一合法值，进度、警告与清理摘要仅 stderr，错误 JSON 放 stderr。退出码分别覆盖成功 0、运行失败 1、用法 2、鉴权 3、不存在 4、冲突 5、取消 130/143。
- [ ] 对 setup/uninstall 的 prompt 使用 stdin 与 stderr 独立 TTY 检测；非交互执行必须有参数或环境输入路径，缺少必要输入时明确返回 2，不能挂起。
- [ ] 更新 tests/brc-cli.test.mjs：各深度帮助与错误语法、--json 可 JSON.parse、stdout 零杂讯、无 TTY 不阻塞、Ctrl+C/SIGTERM 传播取消并释放资源；实现前先让新增测试失败。
- [ ] 生命周期结果使用 ProcessPort 和 ServiceStatus，不通过自由格式的 detail 字符串决定是否允许自动恢复；建立明确原因类型，测试所有陈旧/损坏/真实异工作区状态。

**任务：启动诊断与日志管理**

- [ ] 创建 packages/cli/src/commands/diagnostics.ts，支持 brc diagnose startup [--json] 和 brc start --timing；最近一次完整或失败的命令记录均可查看，保留未计入区间；首次查询无记录返回明确空结果。
- [ ] 扩展 packages/cli/src/maintenance/logs.ts 识别 cli 组件。复用现有日志校验与容量/过期回收，不绕过目录链接检查；并发执行时文件不争用，正在写入的日志不被回收。
- [ ] 依据 CLI extension，保留每次命令启动自身数据清理这一明确项目例外；仅回收 BRC 的失效数据，绝不触碰用户配置和生产服务；从 stderr 报告清理并在同一结果模型中记录耗时、失败、保留条目。
- [ ] 更新 tests/brc-logs.test.mjs、tests/brc-clean.test.mjs、tests/brc-cli.test.mjs：多次并行写入、轮转与保留、安全路径、只读输出、自动清理一次、日志写入失败、缺失日志的清晰行为。
- [ ] 执行受影响测试、pnpm build，再执行完整 pnpm test:unit。

### 依赖批次：结构整理及性能优化

**任务：核心与外部适配解耦**

- [ ] 基于设计稿接口表从 CLI 生命周期开始迁移：core/lifecycle/{policy,workflow,ports}.ts；adapters/process/{identity,controller}.ts、storage/{runtime,cleanup}.ts、network/health.ts。CLI 入口统一创建对象并连接依赖；拆分过程保留安全顺序与身份校验。
- [ ] 将 Relay 登录限流规则归 core/auth，Express 与 SQLite 归 adapters/http、adapters/storage，并从 relay/cli.ts 注入；将 Agent core 下实际触及文件、终端、系统或外部日志的对象迁移到按职责命名的 adapters；删除无引用的宽泛 utils 目录。
- [ ] 不建立空目录、没有真实用例的抽象层或历史兼容包装；变更前更新实际依赖图，每次迁移都同步更新导入路径与测试。仅保留确实服务于多模块的共享实现。
- [ ] 统一共享 managed-log 默认值与 CLI settings.ts；运行时的唯一配置来源仍是 settings.ts，内部无硬编码副本。
- [ ] 增加单元测试确认纯规则模块无 fs/net/child_process 依赖、外部实例仅入口构造、公共目录按职责；增删文件与导入随每一子任务同步验证。
- [ ] 此批次可按 CLI / Relay / Agent 三个独立工作树并行，但必须在测量与命令契约接口稳定后开始；结构选择复核 structure-design 的用例、目录、接口、决策和未决事项。

**任务：实测瓶颈与升级恢复**

- [ ] 用 scripts/benchmark-cli.mjs 扩展的隔离测量对比相同环境、工作负载与服务版本的改造前后数据；诊断用脚本可标注嵌套区间，但正式报告只展示不重复计数的分配。
- [ ] 按耗时排序，仅处理已经量化的最慢非必要重复工作。例如状态查询、Traefik version 校验或清理检查，先确认可复用/缓存的有效期及身份、安全约束，再改代码。
- [ ] 旧 pnpm 版本进程路径变更问题由 typed identity policy 处理。验证进程创建时间、命令行、路径、控制端口及所有权；允许确定归属的安全停止，无法确认则返回冲突，不误杀外部进程。
- [ ] tests/brc-benchmark.test.mjs、tests/brc-lifecycle.test.mjs 覆盖五次冷/热测量、状态语义、错误恢复与旧版本实例；记录基线和新中位数/p95，未验证提升则如实报告，不虚构百分比。

### 集成批次：说明、全面验收与合并

- [ ] 修订 docs/architecture.md 的实际跨平台范围，README.md / README_zh.md 的帮助、诊断命令、日志路径和输出约定；更新本次实施涉及的用例到测试映射，维持配置和版本唯一来源。
- [ ] 执行 pnpm build、pnpm test:unit、受影响的隔离 E2E、pnpm test:package；执行无 TTY、PowerShell 7/5.1、CMD 的输出/中断检查；Linux 和 macOS 路径以可验证 CI 或独立机器测试为准。
- [ ] 安全复核：伪造代理头、损坏/陈旧 PID、并行启停/清理、信号中断、日志满额、只读命令污染；记录每项结果和未验证内容。
- [ ] 使用 auto-git-commit 每个可独立验收模块提交，完成后按项目要求合并 main、清理临时工作树并按 project-context 全量同步 CONTEXT.md；新版本发布、GitHub 推送及生产升级须另获授权。
- [ ] 当本设计和计划全部实施、验收完毕后，依项目规则删除完成稿件，历史保留于 Git。

### 风险与自检

- **安全**：进程身份验证和代理信任不能为提速牺牲；诊断不得写 token、cookie、密码、控制端口鉴权信息。
- **计时**：跨进程日志时间戳仅用于辅助；总耗时与阶段分配必须以单调时钟闭合测量，显示未归属时间，避免重复相加。
- **兼容**：现有 CLI 行为保持用户可依赖的接口；若旧行为与 CLI Style 冲突，使用本项目约定并在文档列明，例如每次命令的受限自身数据清理。
- **验收焦点**：首次空数据运行、长时间锁竞争、日志写盘失败、部分成功、正常与错误 JSON、非交互提示、安全代理头、旧进程归属和平台差异均有对应测试。
- **完成判断**：每项审查问题均能指向文件、独立测试及观察到的结论；仍未知的性能/安全结果明确标记待测，不能以代码已经写入替代验证。