# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；宿主半从 0.18.0 起只有**一个文件** `host.mjs`（此前各版本按 `host.vN.mjs` 发布，`vN` 是 DSH config-only HMR 不重载同路径模块的缓存失效手段，已在 0.18.0 取消——见该版本条目）。

## 0.19.0 — 2026-10-28

- **修复：模型不支持多模态时本轮仍以失败收尾**（0.17.0 的遗留问题）。0.17.0 只往上下文注入提示就 `next()` 放行，失败照样抛给用户、本轮 `turn/end` 仍是 `error`——用户看到「本轮运行失败：The request model is not multimodal」，提示注入了却没起到作用。
  - 现在先落一条持久的 `image/offload` 决定，把当前请求里未省略的图片标记为已省略（与宿主 `@deepseek-ai/dsh-compaction-image-offload` 共用同一份事件与投影）。请求装配随即用占位文字（含只读路径）代替图片字节，于是**同一步重发就能成功**，本轮继续跑、不再出现失败行。
  - 省略只作用于模型可见的请求，用户对话里贴的原图不受影响（替换副本只进模型侧）。
  - 注入提示的动作保留，文案补充「图片已替换为占位说明」；两步都完成后返回 `{kind: 'retry'}`。
  - 找不到可省略的图片（图片来自请求之外、或宿主未装 image-offload 投影）时退回旧行为：只注入提示并 `next()` 放行给模型路由换模型。
  - 新增配置 `notMultimodal.offloadImages`（默认 `true`）；设为 `false` 即恢复「只注入提示、交给路由换模型」。设置分区与备用页各多一个「先把图片替换为占位说明」勾选框。
- 宿主半：`host.mjs`。

## 0.18.0 — 2026-10-26

- **宿主半收敛为单个文件 `host.mjs`**。此前每改一次宿主半就得复制成 `host.vN.mjs` 绕过 ESM 路径缓存（Loader 用文件路径作模块缓存键，同路径必然沿用旧模块），目录与仓库里因此堆了 11 个历史版本文件（`host.v7`~`host.v19`），且 `package.json` / 补丁行 / 文档 / 校验脚本里的引用都指向某个具体版本号。
  - 现在 `host.mjs` 是唯一宿主文件，`package.json` 的 `main` / `exports["."]` / `files`、补丁行 `name`、校验脚本与文档全部指向它。
  - **升级方式变了**：以前换文件名即生效，现在改同一个文件后需要让 Loader 重新 import 该模块（重启该 profile，或临时改补丁行的条目 id 再改回——只改 `config` 属于 config-only 重载，会沿用旧模块）。
- 宿主半：`host.mjs`（此前为 `host.v19.mjs`）。

## 0.17.0 — 2026-10-26

- **新增：模型不支持多模态时不再直接报错**（`notMultimodal`）。上游对带图片的请求回 `The request model is not multimodal`（`code: PI_AI_ERROR`、无 HTTP status、`usage` 全 0，说明在推理前就被拒），此前整轮直接以 `error` 结束，用户看到报错、任务中断。
  - 现在在 `agent/request-error` 里先往会话追加一条**模型可见**的提示（`role: user`、`source.kind = llm-error-retry-notice`），告诉模型图片读不了、改用文字/坐标/工具返回的描述继续；随后照常 `next()` 放行给下游，由模型路由（model-failover）把该模型标记为失败并换到组内支持多模态的模型重试。
  - **不在本插件内重试同一模型**：请求里的图片还在，换口气重发必然同样失败，只会白烧一步并再写一条提示，把上下文越堆越脏。
  - 每轮注入条数由 `maxNotices` 封顶（默认 1，范围 1–10），达上限记 `not-multimodal-skip` 后恢复正常报错——防止模型被反复路由回来时无限刷提示。
  - 命中用 `not[\s_-]*multimodal` 正则，兼容 `NOT MULTIMODAL` / `not-multimodal` / `not_multimodal` 等措辞变体。
  - 设置分区与备用页各有一个「模型不支持多模态时」开关 + 条数输入框。
- 宿主半：`host.v19.mjs`。

## 0.16.0 — 2026-10-21

- **修复：重试链序号记在内存里，会把会话写坏到打不开**。v15 用进程内 `counters`（`agent.id -> {epoch, used, retryId}`）记每条 `(turn, step, provider, policyKey)` 链重试到第几次；以下任一情况都会让它归零：`agent/disposed` 删条目、进程重建、`epoch`（provider/turn/step）变化、设置页保存规则后的 `counters.clear()`。归零后同一条链会接着写出 `retry: 1` + **新** retryId，而宿主读侧（`session-format-v3-to-v4` 的 `relationships`）要求同一策略链 `retry` 严格 +1、`retryId` 恒定，于是**整个会话打不开**，报 `llm/retry skips its policy attempt sequence`（2026-10-21 实测两个会话因此损坏，只能逐事件修日志才恢复）。
  - **修法**：序号与 retryId 一律由 `deriveRetryChain()` 从会话日志现场续——扫本会话 `llm/retry` 事件中同链的最后一条，取 `retry + 1`、沿用其 `retryId`；链不存在则 `1` + 新 id。日志是唯一持久事实来源，内存存不存、进程在不在都不影响结果。
  - 顺带删掉 `counters` / `epoch` / `state.used` / 两处 `counters.clear()` / `agent/disposed` 清理。
  - `llm/retry-started` 加前置条件：只有 `llm/retry` 确实落盘才补 started（读侧要求 started 有配对的调度事件）；读不到日志（`session.ownEvents()` 抛错）时两个事件都不写并 warn——续不上号宁可少一张重试卡片，也不能写出第二条从 1 开始的链。
- 宿主半：`host.v18.mjs`（`v16`/`v17` 是同版草稿，占过 HMR 缓存位即弃；改宿主半内容必须换文件名才会被重新 import）。

## 0.15.0 — 2026-10-21

- **新增首字超时**（`firstTokenTimeout`，默认 180s，设置分区可改）。请求发出后超过设定时间仍没有任何内容增量（正文 / **思考** / 工具调用任一都算），就中断这次请求并报超时。
  - **为什么不是一个规则码**：没出字时根本没有失败事件——`agent/request-error` 不会触发，规则引擎没有入口；只能在上游接一层。
  - **接缝是 `llm/stream` waterfall**：包住下游异步迭代器，在第一次拉取处起表，超时后停止拉取并产出**合成的终止 chunk** `{ type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } }`。不抛异常是因为中间件抛错会直接穿出 agent-loop（不经过 `agent/request-error` 瀑布），规则引擎同样没机会重试；合成 finish 走宿主正常失败路径，**再配一条 `TIMEOUT` 规则即可自动重试**。
  - **只约束 agent 主请求**：带 `purpose` 的会话标题 / 上下文压缩不设限（压缩被打断会伤上下文），无 `sessionId` 的零散调用也不管。
  - **已知限制**：放弃消费 ≠ 立刻断开连接。生成器停在 `await` 时 `return()` 是排队的，上游请求要到 provider 自己响应或 pi-ai 的流空闲 watchdog 才收尾；宿主的请求对象被 freeze 且带 agent-loop 对象身份标记，插件既拿不到也不该替换它的 AbortSignal。
- 宿主半：`host.v15.mjs`。

## 0.14.0 — 2026-10-20

- **服务端 Retry-After 改为有上限地采信**（`honorRetryAfterMaxMs`，默认 60s）。此前把提示封顶在 1 小时并**直接覆盖**规则里自己写的休眠时长：上游对 429 常回 `Retry-After: 3600`（“Rate limit exceeded. Please try again later.”），于是规则里的 10s 被悄悄抬成整小时，会话一小时不动且界面看不出是谁改的。现在提示**只能把等待调大**、且不超过该上限；超出时按规则自己的 `delayMs` 重试，并在事件里记录原始要求与截断原因。上限 0 = 完全忽略提示。
- **该上限挪进设置界面**：GUI「设置 → LLM 错误重试」新增独立输入框（秒，0–3600，0 = 忽略服务端提示），保存写入 `rules.json` 的 `honorRetryAfterMaxMs`，与规则一起立即生效；文件值优先于补丁行，坏值只忽略该字段、不连累规则整体回落。
- **设置分区按钮可读性修复**：主按钮改用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`。此前用 `--dsw-alias-brand-primary` 配 `#fff`，在深色主题下底色是近白（neutral-bluish-50）而文字写死白色 → 白底白字，按钮等于隐形。
- 宿主半：`host.v14.mjs`。

## 0.13.0 — 2026-10-20

- **输出截断自动续写**（`config.maxTokens`）：模型输出达到 token 上限被截断时自动注入一条「继续」，无需人工发消息。
  - max-tokens 不是失败：pi-ai 映射成 `{ kind: 'max-tokens' }`，agent-loop 结算为步骤结束原因，而 `agent/request-error` 瀑布只在 error/aborted 时触发——所以它进不了规则通道，必须另走钩子。
  - 接力点选在 `agent/turn-stopping`：宿主把 max-tokens 记在**轮次**上且是粘性的（后续步骤正常完成也不能降级），一旦粘住，普通「工具调用后自动继续」就失效了。
  - 两类接力分开计数：「截断→续写→又截断」受 `maxContinues` 封顶、续写前休眠 `delayMs`；「工具结果待回喂」是宿主本来就会做的那一步，不计入 `maxContinues`、不休眠、无上限（共用预算会让长工具轮在第 5 步后把工具结果卡在对话外面）。
  - 跨轮自动重启：轮次仍以粘性 max-tokens 收尾时（goal 驱动见该 reason 即 disarm，没人开新轮），只要本轮有实质推进就等旧 driver 收敛后自动 `followup` 一条「继续」开新轮；连续上限 `restartTurns`，正常收尾清零，无推进则停。
- 宿主半：`host.v13.mjs`。

## 0.12.0 — 2026-10-14

- 跨轮自动重启落地（详见 0.13.0 的续写说明）：`restartTurns` / `restartDelayMs` 可配，轮次以粘性 max-tokens 收尾且本轮有推进时自动开新轮。
- 宿主半：`host.v12.mjs`。

## 0.11.0 — 2026-10-10

- 截断续写与工具步接力**分开计数**：`maxContinues` 只约束「截断→续写→又截断」，工具步接力无上限、零休眠。
- 宿主半：`host.v11.mjs`。

## 0.8.0 – 0.10.0 — 2026-10-08 ~ 2026-10-10

- 新增「输出截断自动继续」与 `msg~子串` 规则码形态；修正「只接力一步就停」（截断后模型通常还会正常跑一步工具调用，读「最后一步的 finish」会让条件永不满足），改为按「本轮是否曾截断」判断，并在模型欠回答的工具步后同样接力。续写预算按轮累计、不随步重置。
- 宿主半：`host.v8.mjs` → `host.v10.mjs`。

## 0.7.0 — 2026-09-02

- 单条规则的最大重试次数上限放宽：`MAX_RETRIES_LIMIT` 100 → **1000**（校验、备用页输入框、设置分区输入框、文档同步到 `maxRetries ∈ 0~1000`）。
- 宿主半：`host.v7.mjs`（重命名仅为绕过 DSH config-only HMR 不重载同路径模块的限制）。

## 0.6.0 — 2026-09-02

- **仓库重构为 DSH Profile Bundle 包**：`dsh plugin --profile web add github:liaoyuqing/dsh-llm-error-retry` 一条命令安装（与 dshmarket / dsh-cost-meter 等社区插件一致），不再需要手工编辑 `~/.dsh/cordis.patch.yml`。
- 数据文件迁出包目录 → `~/.dsh/llm-error-retry/{rules.json,status.json}`：pnpm store 中包目录升级即替换，用户配置必须持久于 HOME 级数据目录。`config.dataDir` 可覆盖。
- 发布 LICENSE（MIT）与 CHANGELOG；package.json 补全 repository/keywords/engines/files。
- 宿主半：`host.v6.mjs`。

## 0.5.0 — 2026-09-02

- 规则新增**「字段=值」形态**（如 `code=insufficient_quota`、`type=rate_limit_exceeded`）：匹配 provider 返回 JSON 的字段名与值，三层兜底（failure 直接属性 → message 内嵌 `{...}` JSON 解析 → 宽松文本 `"字段":"值"`）。
- 规则按列表顺序取第一条命中；命中规则的预算耗尽不回退到后续规则/内置策略（规则级上限语义）。
- 宿主半：`host.v5.mjs`。

## 0.4.0 — 2026-09-02

- **DashScope/阿里云百炼形态兼容**：pi-ai 适配器把 HTTP 状态压平进 message、`failure.code` 分类为 `QUOTA` 等且无 `status` —— 数字规则改为三通道匹配（`failure.status` / `failure.code` / message 中独立数字，词边界不误伤 `1429`）。
- **会话框重试卡片**：调度时 append `llm/retry`、醒来后 append `llm/retry-started`（与内置 llm-retry 同一事件契约，同一 retryId 关联整条重试链），聊天区原生 model-retry 节点即时显示「第 N/M 次 · 休眠 Xs」，中断显示已取消。
- 宿主半：`host.v4.mjs`。

## 0.3.0 — 2026-09-02

- **GUI 设置面板分区**（「设置 → LLM 错误重试」）：仓库升级为双拼包（`dsh.client.platform=web` + `exports["./client"]`），浏览器半以 `window.__ModuleLoader__.load` 协议注册，零构建。
- 冷启动/重组竞态修复：`webServer` 改 `ctx.inject` 异步等待 + 路由 duplicate 轮询重试；HTTP 响应不再手写 `Content-Length`（与 gzip 中间件冲突导致浏览器丢 body）。
- 浏览器半错误回显强化（HTTP 状态 + 响应体首段）。
- 宿主半：`host.v3.mjs`。

## 0.1.0 – 0.2.0 — 2026-09-02

- 核心：`agent/request-error` waterfall 以 `prepend` 挂最外层（优先于内置 llm-retry 快速退避）；规则 = 错误码 → `delayMs` 休眠 → `{kind:'retry'}`；每码独立最大重试次数，耗尽上报；按 provider/turn/step 计数重置；`Retry-After` 更长时按提示（封顶 1h）；休眠可中断。
- 备用配置页 + `/llm-error-retry/api/config`（GET/POST）；`rules.json` 覆盖层；`status.json` 运行快照与事件流水。
- 全链路行为验证：合成事件探针（假 agent/假 session）+ 大响应 gzip 一致性 + 配置热更新与事务回滚。
- 宿主半：`host.mjs` → `host.v2.mjs`。
