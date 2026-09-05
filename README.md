# dsh-llm-error-retry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![latest release](https://img.shields.io/github/v/tag/liaoyuqing/dsh-llm-error-retry?label=version)](https://github.com/liaoyuqing/dsh-llm-error-retry/tags)
[![ci](https://github.com/liaoyuqing/dsh-llm-error-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/liaoyuqing/dsh-llm-error-retry/actions/workflows/ci.yml)

大模型请求错误「休眠后重试」——DSH（DeepSeek Harness）Profile Bundle 插件，带 GUI 配置界面。

模型请求失败（如 `429` 限流）时，按规则命中 → **休眠配置时长** → **自动重新发起请求**；每条规则独立配置休眠时长与最大重试次数，耗尽后错误如实上报。重试过程在**会话框内以原生重试卡片**展示（第 N/M 次 · 休眠 Xs）；规则在 GUI「设置」页实时编辑，保存即生效、跨重启持久。

支持按 **HTTP 状态码 / 机器码 / 返回字段=值** 三种形态命中报错（含 DashScope/阿里云百炼这类把状态码压平进 message 的适配器形态）。

> 报错时重试大模型请求：配置错误码或响应字段 → 休眠 → 自动重发。

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

把仓库文件（`host.v7.mjs`、`client.js`、`package.json`）放到任意目录（如 `~/.dsh/plugins/llm-error-retry-ui/`），再在 `~/.dsh/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: llm-error-retry
      name: ./plugins/llm-error-retry-ui/host.v7.mjs
      config:
        rules:
          - code: '429'
            delayMs: 60000
            maxRetries: 10
```

web profile 默认 `patchReload: live`，保存即热挂载；刷新 GUI 页面加载设置分区（浏览器半由 DSH 的 client-modules 扫描 `package.json` 的 `dsh.client` 声明自动并入启动图，零构建）。

## 规则语法

「错误码 / 条件」支持三种形态，多条规则**按顺序取第一条命中**；每条规则独立 `delayMs` + `maxRetries`：

| 形态 | 例子 | 匹配目标 |
| --- | --- | --- |
| HTTP 状态码 | `429`、`500`、`503` | `failure.status`；`failure.code`（`429` / `HTTP_429`）；**message 中的独立数字**（词边界，`1429` 不误伤）——覆盖 pi-ai/DashScope 把状态压平进文本的形态 |
| 机器码 | `RATE_LIMIT`、`QUOTA`、`SERVER`、`TRANSPORT`、`TIMEOUT`、`EMPTY_RESPONSE` | `failure.code`（忽略大小写，DSH 适配器的 provider 无关分类码） |
| 字段=值 | `code=insufficient_quota`、`type=rate_limit_exceeded` | **provider 返回 JSON 的字段名与值**，三层兜底：① `failure.<字段>` 标量属性 → ② `failure.message` 内嵌 `{...}` JSON 解析 → ③ message 宽松文本 `"字段":"值"` |

约束：`delayMs` ∈ 100~3600000；`maxRetries` ∈ 0~1000（`0` = 命中即上报）。

行为细节：

- 监听 `agent/request-error` waterfall，`prepend: true` 置于**最外层**：命中即接管，优先于内置 llm-retry 的快速指数退避；预算耗尽直接上报（不再回退到内置策略）；未命中的失败原样放行。
- 计数按「同一 Agent + 同一请求序列（provider/turn/step）」，新一轮请求自动重置；Agent 销毁即清理。
- 服务端返回 `Retry-After` 且比配置更长时按 `Retry-After`（封顶 1 小时）。
- 休眠可被用户中断/停止即时唤醒，会话卡片显示为已取消。

## 配置来源（优先级从高到低）

1. **GUI 界面保存**：`~/.dsh/llm-error-retry/rules.json`（含设置分区与备用页，两处等价；跨重启持久，`npm` 升级不影响）。
2. `~/.dsh/cordis.patch.yml` 中同 id（`llm-error-retry`）覆盖行的 `config.rules`。
3. 本包内置默认（`cordis.patch.yml`）：`429 → 60s × 10`。

运行快照与事件流水：`~/.dsh/llm-error-retry/status.json`（`config.dataDir` 可改数据目录）。

## 工作原理

- **宿主半**（`host.v7.mjs`）：DSH 每次模型请求失败会派发 `agent/request-error` waterfall（payload 携带 `failure{message,code,status?,providerRetryAfterMs?}`、`retryPolicy`、`signal`）。插件命中规则后等待 `delayMs`，返回 `{kind:'retry'}` 让 agent 循环重新发起同一请求；并写入 `llm/retry` / `llm/retry-started` 会话持久事件（与内置重试同一契约、同一 retryId 贯穿整条链），聊天区原生卡片即时渲染。
- **浏览器半**（`client.js`）：DSH 的双拼包机制——`package.json` 声明 `dsh.client.platform=web` + `exports["./client"]`，宿主 client-modules 扫描到后把 bundle 并入 GUI 启动图（`window.__ModuleLoader__.load` 注册协议，与官方打包产物一致），在浏览器端注册 `settings.section` 设置分区。数据面走宿主 `webServer` 路由 `/llm-error-retry/api/config`（同源 fetch）。

## 二次开发注意（DSH 平台怪癖清单）

- **宿主半代码改动必须换文件名**（`host.vN.mjs`，同步 `package.json exports["."]` 与补丁行 name）：DSH 的 config-only HMR 只热更配置，不重载同路径 ESM 模块；只改 `client.js` 无需改名（每次重组重读字节）。
- 宿主 HTTP 响应**绝不自带 `Content-Length`**（`statusCode + setHeader + res.end`）：web profile 的 gzip 中间件（阈值 1024B）与 `writeHead` 钉死的 CL 冲突，压缩后浏览器会丢弃整个响应体。
- `webServer` 用 `ctx.inject(['webServer'], …)` 异步等待 + `register` 失败轮询重试：冷启动时 HOME 补丁层先于 webserver 挂载；bundle 层同样存在新旧 fiber 交叠的 duplicate-route 窗口。headless profile 无 webServer → 仅无界面，重试逻辑不受影响。
- 用户配置绝不能写进包目录（pnpm store 升级即替换）→ 数据目录在 `~/.dsh/llm-error-retry/`。
- 行为回归用「假 agent + 假 session」探针：`ctx.waterfall('agent/request-error', payload, next)` 触发真实监听链，`session.append` 用收集器承接，零污染真实会话。

## 常见问题

- **怎么确认它在工作？** 触发一次限流错误后：会话框出现「模型重试」卡片（第 N/M 次 · 休眠 Xs）；`~/.dsh/llm-error-retry/status.json` 的 `lastEvents` 会依次记录 `sleeping → retrying`，`waiting` 计数即实时休眠数；宿主日志（`llm-error-retry:` 前缀）同步输出。
- **会把不该重试的错误重试掉吗？** 只有命中规则的才重试；未命中一律原样放行（内置策略行为不变）。规则命中后预算耗尽即上报，不会无限吞错。
- **中断会怎样？** 休眠等待可被用户中断/停止即时唤醒，卡片显示为已取消。
- **升级/卸载后我的规则还在吗？** 规则在 `~/.dsh/llm-error-retry/rules.json`，与包无关；`dsh plugin --profile web remove dsh-llm-error-retry` 后想彻底清除数据再删这个目录即可。
- **`dsh plugin add` 卡住？** 本包无构建脚本、零依赖，git 安装不需要 `allowBuilds`；若网络到 `github.com:443` 不稳可稍后重试或用 `tarball` 安装提示。

## 许可

[MIT](./LICENSE) © 2026 liaoyuqing
