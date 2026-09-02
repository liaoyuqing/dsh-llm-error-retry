# dsh-llm-error-retry

大模型请求错误「休眠后重试」——DSH（DeepSeek Harness）的宿主补丁层插件，带 GUI 配置界面。报错时重试大模型请求：支持按 **HTTP 状态码**、**机器码**、**返回字段=值** 命中，命中后休眠配置时长并自动重新请求（次数可配），重试过程在会话框内以原生重试卡片展示。

模型请求失败（如 `429` 限流）时，按规则表命中 → **休眠配置时长** → **自动重新发起请求**；每条规则独立配置休眠时长与最大重试次数，耗尽后错误如实上报。规则可在 GUI「设置」页或网页界面上实时编辑，保存即生效、跨重启持久。

## 特性

- **三种规则形态**（同一条「错误码 / 条件」列，按列表顺序取第一条命中）：

  | 形态 | 例子 | 匹配目标 |
  | --- | --- | --- |
  | HTTP 状态码 | `429`、`500`、`503` | `failure.status`；`failure.code`（`429` / `HTTP_429`）；**message 中的独立数字**（兼容 pi-ai 类适配器把状态码压平进文本的形态，如 DashScope/阿里云百炼） |
  | 机器码 | `RATE_LIMIT`、`QUOTA`、`SERVER`、`TRANSPORT`、`TIMEOUT`、`EMPTY_RESPONSE` | `failure.code`（忽略大小写） |
  | 字段=值 | `code=insufficient_quota`、`type=rate_limit_exceeded` | provider 返回 JSON 的**字段名与值**：① `failure.<字段>` 标量属性 → ② `failure.message` 内嵌 `{...}` JSON 解析后的字段 → ③ message 宽松文本 `"字段":"值"` 匹配 |

- **每条规则独立配额**：`delayMs`（100ms ~ 1h）× `maxRetries`（0~100，`0` = 命中即上报不再重试）。
- **优先于内置 llm-retry**：监听以 `prepend` 挂在水流最外层，命中即接管（覆盖内置 500ms~10s 快速退避）；未命中的失败原样放行，内置行为不变。
- **会话框可视化**：调度休眠时向会话追加 `llm/retry` 持久事件、醒来后追加 `llm/retry-started`（与内置重试同一事件契约、同一 retryId 关联），聊天区原生重试卡片即时渲染；中断显示为已取消。
- **细节语义**：计数按「同一 Agent + 同一请求序列（provider/turn/step）」，新一轮自动重置；服务端 `Retry-After` 比配置更长时按 `Retry-After`（封顶 1h）；休眠可被用户中断/停止即时唤醒。
- **两处配置界面（等价，共用一个本地 API）**：DSH GUI 左下角 **设置 → LLM 错误重试** 分区；备用页 <http://127.0.0.1:3080/llm-error-retry>（宿主 `webServer` 路由直出；headless profile 无此服务时仅无界面，重试逻辑不受影响）。
- **配置来源（优先级从高到低）**：界面保存的 `llm-error-retry.rules.json` → `cordis.patch.yml` 补丁行 `config.rules` → 内置默认（`429 → 60s × 10`）。
- **热更新**：编辑补丁文件即刻生效（config-only HMR）；界面保存即时生效并持久化。

## 安装

1. 把本仓库 `plugins/llm-error-retry-ui/` 整个目录复制到 DSH HOME 的插件目录：

   - Windows：`%USERPROFILE%\.dsh\plugins\llm-error-retry-ui\`
   - Linux/macOS：`~/.dsh/plugins/llm-error-retry-ui/`

2. 在 `~/.dsh/cordis.patch.yml` 末尾追加（web profile 默认 `patchReload: live`，保存即挂载；否则重启 profile）：

   ```yaml
   - insert:
       - id: llm-error-retry
         name: ./plugins/llm-error-retry-ui/host.v5.mjs
         config:
           rules:
             - code: '429'        # HTTP 状态码（status / code / message 数字三通道匹配）
               delayMs: 60000     # 命中后休眠 60 秒再重新请求
               maxRetries: 10     # 该错误码最多重试 10 次，耗尽后错误上报
             # 更多规则按同样格式追加，例如按 provider 响应字段精确命中：
             # - code: type=insufficient_quota
             #   delayMs: 60000
             #   maxRetries: 10
   ```

   > `./` 相对路径以补丁文件所在目录为锚。
   > 在界面保存后会写入 `llm-error-retry.rules.json` 并优先于上面的 `config.rules`；删除该文件即回落到 YAML。

3. 刷新 DSH GUI 页面（浏览器半在页面重载时并入启动图）。打开 **设置**，应出现「LLM 错误重试」分区。

### 仓库结构

```
plugins/llm-error-retry-ui/
├─ package.json       # dsh.client 双拼包声明（浏览器半由 client-modules 扫描并入 GUI 启动图）
├─ host.v5.mjs        # 宿主半：agent/request-error 监听 + 休眠调度 + 会话事件 + 配置路由/API/页面
├─ client.js          # 浏览器半：设置面板「LLM 错误重试」分区（手写 __ModuleLoader__ bundle，零构建）
└─ rules.example.json # 默认规则示例
```

## 工作原理

- 监听 DSH 的 `agent/request-error` **waterfall** 事件（每次模型请求失败后、循环决定重试前触发），`prepend: true` 置于最外层。命中规则 → 等待 `delayMs` → 返回 `{kind:'retry'}` 使循环重新发起同一请求；预算耗尽返回 `undefined` 令错误直接上抛。
- 浏览器半利用 DSH 的**双拼包机制**：`package.json` 声明 `dsh.client.platform=web` + `exports["./client"]`，宿主 `client-modules` 扫描到补丁行后把 bundle 并入 GUI 启动图（`window.__ModuleLoader__.load` 注册协议，与官方打包产物一致，无需构建工具链），在浏览器端注册 `settings.section` 设置分区。

## 已知坑（二次开发必读）

- **宿主半代码改动必须换文件名**（`host.vN.mjs`，同步补丁 `name` 与 `package.json` 的 `exports["."]`）：DSH 的 config-only HMR 不会重载同路径 ESM 模块；只改 `client.js` 无需改名（每次重组重读字节）。
- 宿主 HTTP 响应**绝不自带 `Content-Length`**（只 `setHeader` 后 `res.end`）：web profile 的 gzip 中间件（阈值 1024B）与 `writeHead` 钉死的 CL 冲突，压缩后浏览器会丢弃整个响应体。
- `webServer` 用 `ctx.inject(['webServer'], …)` 异步等待 + 路由 `register` 失败轮询重试：冷启动时补丁层先于 webserver 挂载；补丁重组新旧 fiber 交叠会短暂 duplicate-route。
- 坏 YAML / 校验失败有事务性回滚兜底，但要求被引用文件**先于**补丁编辑存在。
- 行为测试建议走「假 agent + 假 session」探针：`ctx.waterfall('agent/request-error', payload, next)` 触发真实监听链，`session.append` 用收集器承接，零污染真实会话（本项目各版本均以该法回归验证）。

## 版本

- **v5**：规则新增「字段=值」形态（provider 响应 JSON 字段匹配，三层兜底）。
- **v4**：数字规则三通道（覆盖 DashScope 等把状态码压平进 message、code 分类为 QUOTA 的形态）；会话框重试卡片（`llm/retry`/`llm/retry-started` 事件对）。
- **v3**：设置面板分区（双拼包浏览器半）；冷启动/重组路由竞态修复；响应头规范化。
- **v1–v2**：核心重试、备用配置页、设置分区雏形。
