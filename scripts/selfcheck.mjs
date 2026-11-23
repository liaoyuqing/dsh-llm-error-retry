/**
 * 行为自检：规则文件迁移、默认规则可见性、删除后不复活。
 *
 * 为什么不是纯静态断言：这三件事全在 `apply()` 的启动路径上，而那里依赖 `ctx`
 * （logger / effect / on / inject）。用一份最小 ctx 桩把 `apply()` 真跑起来，
 * 观察实际生效的规则集与写出的文件，比断言源码里有没有某个字符串可靠得多。
 *
 * 与 `validate.mjs` 的分工：那边查包形状与语法，这边查行为。CI 两个都跑。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// 必须走 file:// URL：Windows 上裸的 `D:\…` 被 ESM 解析器当成协议 d:。
const { apply, DEFAULT_RULES, mergeRulesWithDefaults, validateRules } = await import(pathToFileURL(join(root, 'host.mjs')).href)

let passed = 0
let failed = 0
const results = []

/** 用例可以是同步的，也可以返回 Promise（配置路由的端到端用例要发 HTTP 请求）。 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    results.push('  ok   ' + name)
  } catch (error) {
    failed += 1
    results.push('  FAIL ' + name + '\n       ' + String((error && error.message) || error).split('\n').join('\n       '))
  }
}

/** 最小 ctx 桩：只实现 apply() 真正会碰到的方法，全部为空操作。 */
function makeCtx() {
  const logs = []
  const disposers = []
  /** 注册进 webServer 的 prefix 路由：POST 保存要靠它，端到端用例自己发请求。 */
  const routes = []
  const ctx = {
    logger: {
      info: (msg) => { logs.push(['info', String(msg)]) },
      warn: (msg) => { logs.push(['warn', String(msg)]) },
      error: (msg) => { logs.push(['error', String(msg)]) },
    },
    on: () => () => {},
    effect: (fn) => { if (typeof fn === 'function') disposers.push(fn); return () => {} },
    inject: (deps, cb) => {
      // apply() 用 ctx.inject(['webServer'], scope => …) 挂 UI；桩里立刻回调，
      // webServer.register 只把 handler 记下来，不真起端口。
      if (deps.includes('webServer') && typeof cb === 'function') {
        cb({
          webServer: {
            register: ({ path, handler }) => { routes.push({ path, handler }); return () => {} },
          },
          effect: (fn) => { if (typeof fn === 'function') disposers.push(fn); return () => {} },
        })
      }
      return () => {}
    },
    interval: () => () => {},
    timeout: () => () => {},
    agents: { list: () => [] },
    sessions: {},
    logs,
    routes,
    dispose: () => { for (const d of disposers) { try { d() } catch { /* 桩的清理失败与被测行为无关 */ } } },
  }
  return ctx
}

/** 在临时数据目录里跑一次 apply()，返回生效规则与写出的文件内容。 */
function boot(rulesFileContent) {
  const dir = mkdtempSync(join(tmpdir(), 'ler-selfcheck-'))
  const rulesFile = join(dir, 'rules.json')
  if (rulesFileContent !== undefined) writeFileSync(rulesFile, rulesFileContent)
  const ctx = makeCtx()
  apply(ctx, { dataDir: dir })
  const config = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))
  const written = existsSync(rulesFile) ? readFileSync(rulesFile, 'utf8') : null
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true })
  return { rules: config.rules, source: config.rulesSource, written, input: rulesFileContent ?? null, logs: ctx.logs }
}

/**
 * 从配置路由上取 GET/POST 的 handler。apply() 只在该依赖出现时才挂路由，
 * 这里断言它确实挂上了——没挂上时后面的用例会拿到 undefined 而不是静默跳过。
 */
function routeHandlers(routes) {
  assert.equal(routes.length, 1, 'apply() 应该往 webServer 注册恰好一条 UI 路由')
  const handler = routes[0].handler
  assert.equal(typeof handler, 'function')
  return handler
}

/** 造一对假的 req/res，跑一遍 handler，返回 { status, body }。body 对 HTML 路由是原文。 */
async function callRoute(handler, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: path,
    on: (event, cb) => {
      if (event === 'data') for (const chunk of chunks) cb(chunk)
      // 'end' 与 'error' 下一拍触发：readBody 已经把两个回调都挂上了。
      if (event === 'end') setImmediate(cb)
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text },
  }
  await handler(req, res)
  return { status: res.statusCode, raw: res.body }
}

/** 在临时目录里启动一次 apply()，保留 ctx 与 dataDir 供用例发请求后检查落盘结果。 */
function bootLive(rulesFileContent) {
  const dir = mkdtempSync(join(tmpdir(), 'ler-selfcheck-live-'))
  const rulesFile = join(dir, 'rules.json')
  if (rulesFileContent !== undefined) writeFileSync(rulesFile, rulesFileContent)
  const ctx = makeCtx()
  apply(ctx, { dataDir: dir })
  const handler = routeHandlers(ctx.routes)
  const callJson = async (method, body) => {
    const out = await callRoute(handler, method, '/llm-error-retry/api/config', body)
    return { ...out, body: out.raw === undefined ? undefined : JSON.parse(out.raw) }
  }
  return {
    ctx,
    dir,
    rulesFile,
    call: callJson,
    callPath: (method, path, body) => callRoute(handler, method, path, body),
    readFile: () => (existsSync(rulesFile) ? readFileSync(rulesFile, 'utf8') : null),
    close: () => { ctx.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const codesOf = (rules) => rules.map((rule) => rule.code)
const DEFAULT_CODES = codesOf(DEFAULT_RULES)

await test('DEFAULT_RULES 里有 8 条，码值不重复', () => {
  assert.equal(DEFAULT_RULES.length, 8)
  assert.equal(new Set(DEFAULT_CODES.map((c) => c.toUpperCase())).size, DEFAULT_RULES.length)
})

await test('没有规则文件时用内置默认，且不写文件', () => {
  const out = boot(undefined)
  assert.deepEqual(codesOf(out.rules), DEFAULT_CODES)
  assert.equal(out.written, null, '只是读默认值，不该落下 rules.json')
})

await test('旧格式文件（无 configVersion）会补入缺失的默认', () => {
  const out = boot(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  assert.deepEqual(codesOf(out.rules), ['402', ...DEFAULT_CODES], '用户那条保持第一，默认补在后面')
})

await test('迁移后写出的文件带 configVersion: 2', () => {
  const out = boot(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  assert.notEqual(out.written, null, '迁移必须落盘，否则下次启动还要再合一次')
  assert.equal(JSON.parse(out.written).configVersion, 2)
})

await test('迁移保留用户规则的参数，只补缺的码', () => {
  const out = boot(JSON.stringify({ rules: [{ code: '429', delayMs: 120000, maxRetries: 99 }] }))
  const first = out.rules[0]
  assert.equal(first.code, '429')
  assert.equal(first.delayMs, 120000, '用户改过的休眠不能被默认的 5000 覆盖')
  assert.equal(first.maxRetries, 99, '用户改过的次数不能被默认的 5 覆盖')
  assert.equal(codesOf(out.rules).filter((c) => c === '429').length, 1, '同一个码不能出现两次')
})

await test('迁移时用户码与默认码忽略大小写去重', () => {
  const out = boot(JSON.stringify({ rules: [{ code: 'transport', delayMs: 8000, maxRetries: 2 }] }))
  const hits = codesOf(out.rules).filter((c) => c.toUpperCase() === 'TRANSPORT')
  assert.equal(hits.length, 1, '小写的 transport 与默认的 TRANSPORT 是同一个码')
  assert.equal(out.rules.find((r) => r.code.toUpperCase() === 'TRANSPORT').delayMs, 8000)
})

await test('2 号文件即权威：删掉的默认不会复活', () => {
  // 用户删了 7 条、只留 429，然后点保存 —— 落盘的就是这份 2 号文件。
  const kept = [{ code: '429', delayMs: 5000, maxRetries: 5 }]
  const input = JSON.stringify({ configVersion: 2, rules: kept, honorRetryAfterMaxMs: 10000 })
  const out = boot(input)
  assert.deepEqual(codesOf(out.rules), ['429'], '2 号文件里没有的码不许被补回来')
  assert.equal(out.written, input, '2 号文件不该被再次改写')
})

await test('2 号文件支持空列表（全关 = 全部交给下游路由）', () => {
  const out = boot(JSON.stringify({ configVersion: 2, rules: [] }))
  assert.deepEqual(codesOf(out.rules), [], '空列表是合法状态，不能回落到默认')
})

await test('旧文件里的空列表也会补入默认（空不是「用户全删了」的意思）', () => {
  // 1 号文件没有 configVersion，空 rules 只说明「那时候没存规则」，不代表用户逐条删过。
  const out = boot(JSON.stringify({ rules: [] }))
  assert.deepEqual(codesOf(out.rules), DEFAULT_CODES)
})

await test('文件坏掉时回落到 yaml 默认并说明原因', () => {
  const out = boot('{ this is not json')
  assert.deepEqual(codesOf(out.rules), DEFAULT_CODES)
  assert.match(out.source, /覆盖文件被忽略/, 'source 必须写明为什么没用文件')
})

await test('mergeRulesWithDefaults 只补缺、不重排', () => {
  const fileRules = validateRules([{ code: 'zzz', delayMs: 1000, maxRetries: 1 }])
  const defaults = validateRules([{ code: '429', delayMs: 5000, maxRetries: 5 }, { code: 'zzz', delayMs: 9000, maxRetries: 9 }])
  const merged = mergeRulesWithDefaults(fileRules, defaults)
  assert.deepEqual(codesOf(merged.rules), ['zzz', '429'])
  assert.deepEqual(merged.added, ['429'])
  assert.equal(merged.rules[0].delayMs, 1000, '用户那条原封不动')
})

await test('挂载日志会说明这次迁移补了几条', () => {
  const out = boot(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  const line = out.logs.map(([, msg]) => msg).find((msg) => msg.includes('已补入'))
  assert.notEqual(line, undefined, '静默迁移会让「怎么突然多出 8 行」无从解释')
  assert.match(line, /已补入 8 条/)
})

await test('GET 配置把默认规则一并交给界面', async () => {
  const live = bootLive(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  try {
    const out = await live.call('GET')
    assert.equal(out.status, 200)
    assert.deepEqual(codesOf(out.body.rules), ['402', ...DEFAULT_CODES], '列表里必须有那 8 条默认')
    assert.deepEqual(codesOf(out.body.defaults), DEFAULT_CODES, '「恢复默认规则」按钮靠这个字段')
  } finally {
    live.close()
  }
})

await test('POST 保存写出的文件带 configVersion: 2', async () => {
  const live = bootLive(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  try {
    const kept = [
      { code: '429', delayMs: 3000, maxRetries: 2 },
      { code: 'TIMEOUT', delayMs: 7000, maxRetries: 4 },
    ]
    const out = await live.call('POST', { rules: kept, honorRetryAfterMaxMs: 5000 })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    const written = JSON.parse(live.readFile())
    assert.equal(written.configVersion, 2, '不带这个标记，下次启动会把默认又补回来')
    assert.deepEqual(codesOf(written.rules), ['429', 'TIMEOUT'], '存的就是界面上的这份列表')
    assert.equal(written.honorRetryAfterMaxMs, 5000)
  } finally {
    live.close()
  }
})

await test('POST 保存后重启，删掉的默认不会复活', async () => {
  const live = bootLive(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  let saved
  try {
    await live.call('POST', { rules: [{ code: '429', delayMs: 3000, maxRetries: 2 }] })
    saved = live.readFile()
  } finally {
    live.close()
  }
  const restarted = boot(saved)
  assert.deepEqual(codesOf(restarted.rules), ['429'], '这是本版的核心承诺：删掉的默认不再回来')
})

await test('POST 全空列表也能存（等于关掉规则引擎）', async () => {
  const live = bootLive(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  try {
    const out = await live.call('POST', { rules: [] })
    assert.equal(out.status, 200)
    assert.deepEqual(JSON.parse(live.readFile()).rules, [])
  } finally {
    live.close()
  }
})

await test('POST 坏规则报 400，且不写坏文件', async () => {
  const live = bootLive(JSON.stringify({ rules: [{ code: '402', delayMs: 10000, maxRetries: 5 }] }))
  try {
    const before = live.readFile()
    const out = await live.call('POST', { rules: [{ code: '', delayMs: 5000, maxRetries: 1 }] })
    assert.equal(out.status, 400)
    assert.equal(out.body.ok, false)
    assert.match(String(out.body.error), /code must be non-empty/)
    assert.equal(live.readFile(), before, '校验失败不许动已经生效的文件')
  } finally {
    live.close()
  }
})

await test('备用页把默认规则内联成 JSON 交给按钮，不靠宿主作用域', async () => {
  const live = bootLive(undefined)
  try {
    const out = await live.callPath('GET', '/llm-error-retry')
    assert.equal(out.status, 200)
    // 浏览器里没有 host.mjs 的模块作用域：裸标识符 DEFAULT_RULES 会 ReferenceError。
    // 判据是「赋值语句之外还引用了它」——那才是宿主的那个数组，页面上应该是内联的副本。
    const refs = [...out.raw.matchAll(/DEFAULT_RULES/g)].length
    const declares = [...out.raw.matchAll(/var DEFAULT_RULES =/g)].length
    assert.equal(declares, 1, '页面脚本应当自己声明一次 DEFAULT_RULES')
    assert.equal(refs, declares + 1, '除声明外只该在「恢复内置默认」里读它一次；多出来的引用就是宿主作用域泄漏')
    const injected = /var DEFAULT_RULES = (\[.*?\]);/s.exec(out.raw)
    assert.notEqual(injected, null, '默认必须内联进页面脚本')
    assert.deepEqual(codesOf(JSON.parse(injected[1])), DEFAULT_CODES, '补丁行没写 config.rules 时，内联的就是代码内置的 8 条')
  } finally {
    live.close()
  }
})

console.log(results.join('\n'))
console.log(`\nselfcheck: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)