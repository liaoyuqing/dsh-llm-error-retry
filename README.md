# dsh-llm-error-retry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![latest release](https://img.shields.io/github/v/tag/liaoyuqing/dsh-llm-error-retry?label=version)](https://github.com/liaoyuqing/dsh-llm-error-retry/tags)
[![ci](https://github.com/liaoyuqing/dsh-llm-error-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/liaoyuqing/dsh-llm-error-retry/actions/workflows/ci.yml)

大模型请求错误「休眠后重试」——DSH（DeepSeek Harness）Profile Bundle 插件，带 GUI 配置界面。

模型请求失败（如 `429` 限流）时，按规则命中 → **休眠配置时长** → **自动重新发起请求**；每条规则独立配置休眠时长与最大重试次数，耗尽后错误如实上报。重试过程在**会话框内以原生重试卡片**展示（第 N/M 次 · 休眠 Xs）；规则在 GUI「设置」页实时编辑，保存即生效、跨重启持久。

支持按 **HTTP 状态码 / 机器码 / 返回字段=值 / msg~子串** 四种形态命中报错（含 DashScope/阿里云百炼这类把状态码压平进 message 的适配器形态，以及 provider 只给一句文案、无 status 且 code 只到 `PI_AI_ERROR` 的形态）。

另外：**模型输出达到 token 上限被截断时，自动注入一条「继续」让它接着输出**，无需人工打断再发消息。

> 报错时重试大模型请求：配置错误码或响应字段 → 休眠 → 自动重发。
> 输出被截断时自动续写：不用手动打「继续」。

## 安装（一条命令）

```sh
dsh plugin --profile web add github:liaoyuqing/dsh-llm-error-retry
```

然后**重启该 profile**（bundle 层在启动时装配）。刷新 GUI 页面后，左下角 **设置 → LLM 错误重试** 即出现配置分区；备用配置页 <http://127.0.0.1:3080/llm-error-retry>。

发布到 npm 后可用 `dsh plugin --profile web add dsh-llm-error-retry`。

其他命令：

```sh
dsh plugin --profile web update                    # 升级到最新版
dsh plugin --profile web remove dsh-llm-error-retry # 卸载
```

> profile 名按你的实际部署替换（桌面/网页版一般是 `web`）。安装本质是 pnpm 依赖 + `dsh.bundle` 声明自动注册为 profile 层，与 dshmarket、dsh-cost-meter 等社区插件一致；本包**无构建脚本、零运行时依赖**。

### 手动安装（不经过 pnpm 的兜底方式）

把仓库文件（`host.mjs`、`client.js`、`package.json`）放到任意目录（如 `~/.dsh/plugins/llm-error-retry-ui/`），再在 `~/.dsh/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: llm-error-retry
      name: ./plugins/llm-error-retry-ui/host.mjs
      config:
        rules:
          - code: '429'
            delayMs: 5000
            maxRetries: 5
```

web profile 默认 `patchReload: live`，保存即热挂载；刷新 GUI 页面加载设置分区（浏览器半由 DSH 的 client-modules 扫描 `package.json` 的 `dsh.client` 声明自动并入启动图，零构建）。

## 规则语法

「错误码 / 条件」支持四种形态，多条规则**按顺序取第一条命中**；每条规则独立 `delayMs` + `maxRetries`：

| 形态 | 例子 | 匹配目标 |
| --- | --- | --- |
| HTTP 状态码 | `429`、`500`、`503` | `failure.status`；`failure.code`（`429` / `HTTP_429`）；**message 中的独立数字**（词边界，`1429` 不误伤）——覆盖 pi-ai/DashScope 把状态压平进文本的形态 |
| 机器码 | `RATE_LIMIT`、`QUOTA`、`SERVER`、`TRANSPORT`、`TIMEOUT`、`EMPTY_RESPONSE` | `failure.code`（忽略大小写，DSH 适配器的 provider 无关分类码） |
| 字段=值 | `code=insufficient_quota`、`type=rate_limit_exceeded` | **provider 返回 JSON 的字段名与值**，三层兜底：① `failure.<字段>` 标量属性 → ② `failure.message` 内嵌 `{...}` JSON 解析 → ③ message 宽松文本 `"字段":"值"` |
| msg~子串 | `msg~finish_reason: error`、`msg~Provider returned an empty response` | `failure.message` 的子串（忽略大小写）。用于没有 status、code 又被归到通用桶的失败：provider 在 SSE 里以未识别的 `finish_reason` 终止流时，pi-ai 报成 `message='Provider finish_reason: <值>'`、`code='PI_AI_ERROR'`，前三种形态都命中不了 |

约束：`delayMs` ∈ 100~3600000；`maxRetries` ∈ 0~1000（`0` = 命中即上报）。

行为细节：

- 监听 `agent/request-error` waterfall，`prepend: true` 置于**最外层**：命中即接管，优先于内置 llm-retry 的快速指数退避；预算耗尽直接上报（不再回退到内置策略）；未命中的失败原样放行。
- 计数按「同一 Agent + 同一请求序列（provider/turn/step）」，新一轮请求自动重置；Agent 销毁即清理。
- 服务端返回 `Retry-After` 且比配置更长时按 `Retry-After` 推迟，但**最多只多等 `honorRetryAfterMaxMs`**（默认 10s，在设置分区可改，0 = 完全忽略提示）。上游常回 `Retry-After: 3600`（一小时），无上限地照做会让会话整小时不动，还把你规则里写的休眠时长悄悄改掉。
- 休眠可被用户中断/停止即时唤醒，会话卡片显示为已取消。

## 输出截断自动续写

模型输出达到 token 上限被截断时，插件自动注入一条「继续」，让它接着把话说完：

- **为什么不能靠规则码命中**：max-tokens 不是失败。pi-ai 把它映射成 `{ kind: 'max-tokens' }`，agent-loop 收到后结算为步骤结束原因，而 `agent/request-error` 瀑布只在 error/aborted 时触发——所以任何错误码规则都命中不了它。
- **为什么必须在轮次收尾处接力**：宿主把 max-tokens 记在**轮次**上且是粘性的（后续步骤正常完成也不能把它降级）。一旦粘住，宿主在每个后续步骤收尾时都会派发 `agent/turn-stopping`，并在没人投递新步骤时结束轮次——普通「工具调用后自动继续」正是在这里失效的。插件在这个钩子上补回宿主本该做的判断。
- **两类接力分开计数**：「截断 → 续写 → 又截断」受 `maxContinues` 封顶、续写前休眠 `delayMs`；「工具结果待回喂」是宿主本来就会做的那一步，不计入 `maxContinues`、不休眠、无上限（真实 agentic 轮常有几十上百步工具调用，共用预算会在第 5 步后把工具结果永远卡在对话外面）。
- **跨轮自动重启**：轮次仍以粘性的 max-tokens 收尾时（goal 驱动见该 reason 即 disarm，没人开新轮），只要本轮确有实质推进就等旧 driver 收敛后自动 `followup` 一条「继续」开新轮；连续重启上限 `restartTurns`，正常收尾即清零，无推进则停（防止模型只会复读「继续」时空转）。

对应配置（补丁行 `config.maxTokens`）：

```yaml
maxTokens:
  enabled: true      # 关掉则恢复原样：截断后等你手动继续
  text: '继续'        # 注入内容
  maxContinues: 5    # 每轮最多自动续写 5 次（只约束截断续写）
  delayMs: 3000      # 截断续写前休眠 3 秒，别打爆 provider
  restartTurns: 10   # 轮次以粘性 max-tokens 收尾时，最多连开 10 个新轮
  restartDelayMs: 1200  # 重开前等旧 driver 收敛的时间（不能省：running 阶段投递的唤醒会被丢弃）
```

## 首字超时

「输出截断自动续写」管的是「说到一半被截断」，首字超时管的是「一个字都不说」：请求发出后超过 `firstTokenTimeout.timeoutMs` 仍没有任何内容增量，就中断这次请求并报超时。

- **什么叫「第一个字」**：`text-delta`（正文）、`reasoning-delta`（**思考**）、`tool-call-delta`（工具调用）任一到达即撤销计时。只收到 `block-start`/`usage` 这类不含内容的结构帧不算——所以在计时窗口内一直有思考流出的推理模型不会误伤。
- **接缝是 `llm/stream` 中间件**（waterfall，`global: true`）：包住下游流，在第一次拉取处起表。超时后停止拉取，并**产出一个合成的终止 chunk** `{ type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: '首字超时：…' } } }`。之所以不抛异常：中间的 waterfall 抛错会直接穿出 agent-loop（`llm/src/index.ts` 明确「middleware 失败仍抛出」），不经过 `agent/request-error` 瀑布，本插件的规则引擎就没机会重试；合成 finish 则走宿主正常失败路径——因此**再配一条规则码 `TIMEOUT` 就能自动重试**，否则它作为本轮错误上报，聊天区显示超时原因。
- **只约束 agent 主请求**：`compaction` / `session-title` 这类带 `purpose` 的调用不设限（压缩中途被打断会伤上下文），没有 `sessionId` 的零散调用也无从归属。
- **已知限制**：放弃消费不等于立刻断开连接。异步生成器停在 `await` 时 `return()` 是排队的，上游 HTTP 请求可能在 provider 自己响应或 pi-ai 的流空闲 watchdog（`profile.streamIdleTimeoutMs`）触发前继续挂着；本接缝拿不到也不该改宿主的请求对象（它被 `Object.freeze` 且带 agent-loop 的对象身份标记），无法注入自己的 AbortSignal。

对应配置（补丁行 `config.firstTokenTimeout`，或设置分区里的「首字超时」开关 + 秒数）：

```yaml
firstTokenTimeout:
  enabled: true
  timeoutMs: 90000    # 1000–3600000；长思考模型别设太小，否则正常请求也会被判超时
```

## 模型不支持多模态

带图片的请求打到纯文本模型时，上游回 `The request model is not multimodal`（`code: PI_AI_ERROR`、没有 HTTP status、`usage` 全 0——在推理前就被拒）。默认行为不是把这次失败抛给用户，本轮也不以失败收尾：

1. **先把图片变成占位文字**：把当前请求里还没省略的图片标记为已省略（落一条持久的 `image/offload` 决定，与宿主 `@deepseek-ai/dsh-compaction-image-offload` 共用同一份事件与投影）。之后装配的每个请求都用一段说明文字（含图片的只读路径）代替图片字节，因此同一步重发就能被纯文本模型接受。省略只作用于**模型可见的请求**——用户对话里贴的原图仍在，不会被涂改。
2. **再注入一条模型可见的提示**（`role: user`、来源标记 `llm-error-retry-notice`），告诉模型图片已替换为占位说明、改用文字/坐标/工具返回的描述继续；确实需要看图时提示用户换模型。
3. 两步都完成后就地返回 `{kind: 'retry'}` **在同一步重发**：模型照常给出文字回答，聊天区不出现失败行。

找不到可省略的图片时（例如图片来自请求之外、或宿主没装 image-offload 投影）退回保守路径：只注入提示，然后 `next()` 放行给下游——模型路由（如 model-failover-manager）会把该模型标记为失败，换成组内支持多模态的模型重试。

**为什么不只重试不省略**：图片字节还在时换个口气重发必然同样失败，只会白烧一步并再写一条提示，把上下文越堆越脏。

每轮注入条数由 `maxNotices` 封顶（默认 3，范围 1–10）；达到上限后再遇到同样的失败就记一条 `not-multimodal-skip` 并恢复正常报错，避免模型被反复路由回来时无限刷提示。命中判定是 `not[\s_-]*multimodal` 正则，兼容 `NOT MULTIMODAL` / `not-multimodal` / `not_multimodal` 等变体。

对应配置（补丁行 `config.notMultimodal`，或设置分区里的「模型不支持多模态时」两个开关 + 条数）：

```yaml
notMultimodal:
  enabled: true
  offloadImages: true   # 先把图片替换为占位说明再同一步重发；false = 只注入提示、交给路由换模型
  maxNotices: 3         # 每轮最多注入几条（1–10）
  # text 可省略，默认文案见 host 文件 DEFAULT_NOT_MULTIMODAL
```

## 配置来源（优先级从高到低）


1. **GUI 界面保存**：`~/.dsh/llm-error-retry/rules.json`（含设置分区与备用页，两处等价；跨重启持久，`npm` 升级不影响）。文件里除 `rules` 外还存 `honorRetryAfterMaxMs`（Retry-After 采信上限）、`firstTokenTimeout`（首字超时）与 `notMultimodal`（多模态提示）。
2. `~/.dsh/cordis.patch.yml` 中同 id（`llm-error-retry`）覆盖行的 `config.rules`、`config.honorRetryAfterMaxMs`、`config.firstTokenTimeout` 与 `config.notMultimodal`。
3. 本包内置默认（`cordis.patch.yml`，与代码兜底默认一致）：8 条规则 `429`、`400`、`msg~finish_reason: error`、`msg~Provider returned an empty response`、`TRANSPORT`、`524`、`msg~病态重复`、`TIMEOUT`，均 `5s × 5`；`honorRetryAfterMaxMs` 10s、首字超时 90s、`notMultimodal.maxNotices` 3。

运行快照与事件流水：`~/.dsh/llm-error-retry/status.json`（`config.dataDir` 可改数据目录）。

## 工作原理

- **宿主半**（`host.mjs`）：DSH 每次模型请求失败会派发 `agent/request-error` waterfall（payload 携带 `failure{message,code,status?,providerRetryAfterMs?}`、`retryPolicy`、`signal`）。插件命中规则后等待 `delayMs`，返回 `{kind:'retry'}` 让 agent 循环重新发起同一请求；并写入 `llm/retry` / `llm/retry-started` 会话持久事件（与内置重试同一契约、同一 retryId 贯穿整条链，且链号与 retryId 一律从会话日志续，不存进程内存），聊天区原生卡片即时渲染。输出截断的自动续写走 `agent/assistant-stream`（记录每步 finish）+ `agent/turn-stopping`（在轮次收尾处补投一步）+ `session/event`（轮次收尾后跨轮重开）三个钩子；首字超时走 `llm/stream` waterfall（包一层异步生成器，到点产出合成的 TIMEOUT finish chunk）；「不支持多模态」在同一个 `agent/request-error` 钩子上抢先处理（先落 `image/offload` 决定把图片换成占位说明、再注入提示，然后同一步返回 retry）。
- **浏览器半**（`client.js`）：DSH 的双拼包机制——`package.json` 声明 `dsh.client.platform=web` + `exports["./client"]`，宿主 client-modules 扫描到后把 bundle 并入 GUI 启动图（`window.__ModuleLoader__.load` 注册协议，与官方打包产物一致），在浏览器端注册 `settings.section` 设置分区。数据面走宿主 `webServer` 路由 `/llm-error-retry/api/config`（同源 fetch）。

## 二次开发注意（DSH 平台怪癖清单）

- **宿主半代码改动需要让 Loader 重新 import 该模块**：DSH 的 config-only HMR 只热更配置，不重载同路径 ESM 模块（Loader 用文件路径作模块缓存键，同路径必然沿用旧模块）。改完 `host.mjs` 后重启该 profile 即可；只想热重载就临时改补丁行里该条目的 `id` 再改回（**只改 `config` 不算**）。只改 `client.js` 无需如此（每次重组重读字节）。
- 宿主 HTTP 响应**绝不自带 `Content-Length`**（`statusCode + setHeader + res.end`）：web profile 的 gzip 中间件（阈值 1024B）与 `writeHead` 钉死的 CL 冲突，压缩后浏览器会丢弃整个响应体。
- `webServer` 用 `ctx.inject(['webServer'], …)` 异步等待 + `register` 失败轮询重试：冷启动时 HOME 补丁层先于 webserver 挂载；bundle 层同样存在新旧 fiber 交叠的 duplicate-route 窗口。headless profile 无 webServer → 仅无界面，重试逻辑不受影响。
- 用户配置绝不能写进包目录（pnpm store 升级即替换）→ 数据目录在 `~/.dsh/llm-error-retry/`。
- 行为回归用「假 agent + 假 session」探针：`ctx.waterfall('agent/request-error', payload, next)` 触发真实监听链，`session.append` 用收集器承接，零污染真实会话。
- **读侧会校验的时序状态绝不能存进程内存**（v16 教训）：`llm/retry` / `llm/retry-started` 的 `retry`、`retryId` 有跨事件不变量（同链 `retry` 严格 +1、`retryId` 恒定），而 `agent/disposed`、进程重建、规则保存都可能清掉内存计数——一旦清空就会写出第二条从 1 开始的链，宿主读侧直接拒绝**整个会话**（`llm/retry skips its policy attempt sequence`），日志只能逐事件修。这类字段一律从会话日志续（`session.ownEvents()` 扫同链最后一条），日志是唯一事实来源。

## 常见问题

- **怎么确认它在工作？** 触发一次限流错误后：会话框出现「模型重试」卡片（第 N/M 次 · 休眠 Xs）；`~/.dsh/llm-error-retry/status.json` 的 `lastEvents` 会依次记录 `sleeping → retrying`，`waiting` 计数即实时休眠数；宿主日志（`llm-error-retry:` 前缀）同步输出。输出被截断时事件里会记 `continuation`（已自动续写）、`restart`（已自动重开新轮），耗尽或无进展时记 `continuation-exhausted` / `continuation-stalled` / `restart-exhausted` / `restart-stalled`。
- **会把不该重试的错误重试掉吗？** 只有命中规则的才重试；未命中一律原样放行（内置策略行为不变）。规则命中后预算耗尽即上报，不会无限吞错。
- **中断会怎样？** 休眠等待可被用户中断/停止即时唤醒，卡片显示为已取消。
- **升级/卸载后我的规则还在吗？** 规则在 `~/.dsh/llm-error-retry/rules.json`，与包无关；`dsh plugin --profile web remove dsh-llm-error-retry` 后想彻底清除数据再删这个目录即可。
- **`dsh plugin add` 卡住？** 本包无构建脚本、零依赖，git 安装不需要 `allowBuilds`；若网络到 `github.com:443` 不稳可稍后重试或用 `tarball` 安装提示。

## 许可

[MIT](./LICENSE) © 2026 liaoyuqing
