# Contributing

开发闭环无需 DSH 源码树：本包零依赖、无构建步骤，宿主半/浏览器半都是直读的纯 JS。

## 本地校验

```sh
node scripts/validate.mjs   # CI 同款门禁：manifest 形状、gzip 安全头、bundle id 重绑、两半语法
```

## 改代码的关键规则（DSH 平台怪癖）

1. **宿主半改动必须换文件名**（`host.vN.mjs`），并同步 `package.json` 的 `main/exports["."]`、`files`、`scripts/validate.mjs` 与 `cordis.patch.yml` 的行 name。原因：DSH 的 config-only HMR 不重载同路径 ESM 模块。
2. **浏览器半 `client.js` 的注册 id 必须等于 `package.json` 的 `name`**（启动图 row id = 包名），改动注册 id 需同步刷新页面。
3. HTTP 响应只走 `statusCode + setHeader + res.end`，**永远不要设置 `Content-Length` 头**（gzip 中间件冲突）。CI 会拦截。
4. 文件一律 UTF-8 **无 BOM** + LF（combo 拼接下 BOM 会引发语法错误）。`.editorconfig` 已约束。

## 行为测试

用「假 agent + 假 session」探针行临时挂进你本机 `~/.dsh/cordis.patch.yml`：
`ctx.waterfall('agent/request-error', payload, next)` 走真实监听链，`session.append` 由收集器承接，
结果写 JSON 文件比对（各版本 CHANGELOG 的验证记录均出自此法）。测完删探针行与文件。

## 试装

```sh
dsh plugin --profile <你的profile> add <本仓库本地路径或 git-url>
# 重启 profile；设置页出现「LLM 错误重试」即装配成功
```

## 发版

更新 `package.json` 版本 + `CHANGELOG.md` → 提交 → `git tag -a vX.Y.Z -m ... && git push origin main --tags`。
release workflow 自动生成 Release 并挂**不带版本号命名**的 `dsh-llm-error-retry.tgz` 资产（供市场 `tarball:` 链接长期有效）。
