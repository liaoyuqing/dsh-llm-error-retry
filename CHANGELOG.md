# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；宿主半模块文件名带 `vN` 是 DSH config-only HMR 的缓存失效手段（同路径模块不会被重新 import），与产品版本号的对应关系见下。

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
