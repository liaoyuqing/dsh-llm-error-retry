# Security Policy

## 数据面

- 插件在本机宿主进程内运行，配置读写仅发生在 `~/.dsh/`（`llm-error-retry/` 数据目录与补丁文件）。
- 配置界面（`/llm-error-retry` 及设置分区）仅注册在本机 `webServer`（默认 `127.0.0.1`，与 DSH GUI 同源同端口），不新增监听面；无跨机网络行为。
- 除模型请求外插件不发起任何网络请求；失败快照（含 provider 消息文本）仅写入本机会话日志与 `status.json`，供界面展示。

## 凭证

插件不读取、不传输、不存储任何 API key / credential。重试所需的模型请求完全复用宿主既有路由配置。

## 报告漏洞

请开 [GitHub Issue](https://github.com/liaoyuqing/dsh-llm-error-retry/issues)（可标 `security` 前缀）。本插件为社区开源工具，无 SLA；修复会随任意补丁版本发布并在 CHANGELOG 注明。
