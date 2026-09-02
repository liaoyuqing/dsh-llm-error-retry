/**
 * llm-error-retry v5 — 大模型请求错误「休眠后重试」宿主插件。
 *
 * 相比 v4：规则码新增 `字段=值` 形态（如 code=insufficient_quota、
 * type=rate_limit_exceeded），直接匹配 provider 返回 JSON 的字段：
 *   1) failure 对象的同名标量属性；
 *   2) failure.message 内嵌的 {...} JSON 解析后的字段；
 *   3) message 文本的宽松 `"field":"value"` 正则（兜底非规范 JSON）。
 * 规则码三种形态：
 *   - 数字 '429'：匹配 failure.status、failure.code（429/HTTP_429）、
 *     message 中的独立数字（pi-ai 会压平状态码）。
 *   - 机器码 'RATE_LIMIT'/'QUOTA'…：匹配 failure.code（忽略大小写）。
 *   - '字段=值'：匹配 provider 响应字段（上述三层）。
 *
 * 其余不变：命中 → 休眠该码的 delayMs → {kind:'retry'} 重新请求；每码独立
 * maxRetries，耗尽即上报；prepend 优先于内置 llm-retry；按
 * provider/turn/step 计数重置；Retry-After 取更长；休眠/重试过程通过
 * 'llm/retry' + 'llm/retry-started' 会话事件对显示为聊天区 model-retry 卡片。
 *
 * 配置来源（高→低）：界面保存的 <本目录>/llm-error-retry.rules.json → 补丁行 config.rules。
 * 界面：GUI「设置」→「LLM 错误重试」；备用页 http://127.0.0.1:3080/llm-error-retry
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'llm-error-retry'
export const inject = ['timer']

const DEFAULT_RULES = [{ code: '429', delayMs: 60_000, maxRetries: 10 }]
const MIN_DELAY_MS = 100
const MAX_DELAY_MS = 3_600_000
const MAX_RETRIES_LIMIT = 100
const EVENT_LOG_LIMIT = 20
const UI_PATH = '/llm-error-retry'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse one rule code string into its matcher shape. */
function parseRuleCode(code) {
  const eq = code.indexOf('=')
  if (eq >= 0) {
    const field = code.slice(0, eq).trim()
    const value = code.slice(eq + 1).trim()
    if (!field || !value) return undefined
    return { kind: 'field', field, value }
  }
  if (/^[0-9]+$/.test(code)) return { kind: 'numeric', digits: code }
  return { kind: 'machine', tag: code.toUpperCase() }
}

function normalizeCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

function validateRules(input) {
  if (input !== undefined && !Array.isArray(input)) throw new Error('llm-error-retry: rules must be an array of { code, delayMs, maxRetries }')
  const out = []
  const seen = new Set()
  for (const [index, raw] of (input ?? []).entries()) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`llm-error-retry: rules[${index}] must be an object with { code, delayMs, maxRetries }`)
    }
    const code = normalizeCode(raw.code)
    if (!code) throw new Error(`llm-error-retry: rules[${index}].code must be non-empty (e.g. 429 / RATE_LIMIT / code=insufficient_quota)`)
    const match = parseRuleCode(code)
    if (match === undefined) throw new Error(`llm-error-retry: rule "${code}": "field=value" form needs a non-empty field and value`)
    const tag = code.toUpperCase()
    if (seen.has(tag)) throw new Error(`llm-error-retry: duplicate rule code: ${code}`)
    seen.add(tag)
    const delayMs = Number(raw.delayMs)
    if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
      throw new Error(`llm-error-retry: rule "${code}": delayMs must be a number within ${MIN_DELAY_MS}..${MAX_DELAY_MS}`)
    }
    const maxRetries = Number(raw.maxRetries)
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
      throw new Error(`llm-error-retry: rule "${code}": maxRetries must be an integer 0..${MAX_RETRIES_LIMIT}`)
    }
    out.push({ code, tag, delayMs, maxRetries, match })
  }
  return out
}

function scalarEq(actual, value) {
  return (typeof actual === 'string' || typeof actual === 'number' || typeof actual === 'boolean')
    && String(actual) === value
}

function fieldHit(field, value, failure, message) {
  if (scalarEq(failure[field], value)) return true
  const jsonStart = message.indexOf('{')
  const jsonEnd = message.lastIndexOf('}')
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart, jsonEnd + 1))
      if (parsed !== null && typeof parsed === 'object' && scalarEq(parsed[field], value)) return true
    } catch {}
  }
  try {
    return new RegExp('"' + escapeRegExp(field) + '"\\s*:\\s*"?' + escapeRegExp(value) + '"?').test(message)
  } catch {
    return false
  }
}

function matchAgainst(rules, failure) {
  if (failure === null || typeof failure !== 'object') return undefined
  const code = typeof failure.code === 'string' ? failure.code : ''
  const upperCode = code.toUpperCase()
  const message = typeof failure.message === 'string' ? failure.message : ''
  for (const rule of rules) {
    if (rule.match.kind === 'field') {
      if (fieldHit(rule.match.field, rule.match.value, failure, message)) return rule
    } else if (rule.match.kind === 'numeric') {
      const digits = rule.match.digits
      if (typeof failure.status === 'number' && String(failure.status) === digits) return rule
      if (upperCode === digits || upperCode === 'HTTP_' + digits) return rule
      if (new RegExp('\\b' + digits + '\\b').test(message)) return rule
    } else if (upperCode === rule.match.tag) {
      return rule
    }
  }
  return undefined
}

function describeFailure(failure) {
  const code = typeof failure.code === 'string' && failure.code ? failure.code : 'UNKNOWN'
  return typeof failure.status === 'number' ? `${code} (HTTP ${failure.status})` : code
}

/** Detach a serializable LlmFailure snapshot (scalars only, message bounded) for the durable session event. */
function snapshotFailure(failure) {
  const message = typeof failure.message === 'string' && failure.message.length > 0
    ? failure.message.slice(0, 400)
    : 'llm request failed'
  const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
  return {
    message,
    code,
    ...typeof failure.status === 'number' ? { status: failure.status } : {},
    ...typeof failure.providerRetryAfterMs === 'number' && Number.isFinite(failure.providerRetryAfterMs)
      ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {},
    ...typeof failure.requestId === 'string' && failure.requestId.length > 0
      ? { requestId: failure.requestId } : {},
  }
}

function renderPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM 错误重试配置</title>
<style>
  :root { color-scheme: dark light; }
  body { font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #14161a; color: #e6e6e6; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { opacity: .65; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; max-width: 820px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.08); }
  th { font-size: 12px; opacity: .7; font-weight: 500; }
  input[type=text], input[type=number] { background: rgba(255,255,255,.07); color: inherit; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 4px 8px; font: inherit; width: 100%; box-sizing: border-box; }
  input[type=number] { width: 110px; }
  button { background: rgba(120,160,255,.18); color: #cfe0ff; border: 1px solid rgba(120,160,255,.4); border-radius: 6px; padding: 5px 14px; font: inherit; cursor: pointer; }
  button:hover { background: rgba(120,160,255,.3); }
  button.primary { background: #2f6feb; color: #fff; border-color: #2f6feb; }
  button.link { background: none; border: none; color: #ff9f9f; padding: 4px 8px; }
  .toolbar { display: flex; gap: 10px; margin: 14px 0; align-items: center; flex-wrap: wrap; }
  .notice { font-size: 13px; min-height: 20px; }
  .ok { color: #7cc36f; } .err { color: #ff7b72; } .warn { color: #e3b341; }
  .meta { font-size: 12px; opacity: .6; margin-bottom: 6px; }
  ul.events { list-style: none; padding: 0; margin: 4px 0 0; max-width: 820px; font-size: 12px; opacity: .85; }
  ul.events li { padding: 2px 0; border-bottom: 1px dashed rgba(255,255,255,.06); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { max-width: 820px; font-size: 12px; opacity: .6; margin-top: 8px; }
  @media (prefers-color-scheme: light) { body { background: #f6f7f9; color: #1c1e21; } input, button { color: inherit; } }
</style>
</head>
<body>
  <h1>LLM 错误休眠重试 · 配置</h1>
  <div class="sub">插件 llm-error-retry ｜ 命中错误码 → 休眠 → 重新请求 ｜ 优先于内置快速重试</div>
  <div id="meta" class="meta"></div>
  <table>
    <thead><tr><th style="width:260px">错误码 / 条件</th><th style="width:130px">休眠（秒）</th><th style="width:130px">最大重试次数</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="toolbar">
    <button id="add">＋ 添加规则</button>
    <button id="save" class="primary">保存（立即生效）</button>
    <button id="revert">放弃本地修改</button>
  </div>
  <div id="notice" class="notice"></div>
  <div class="hint">规则码三种形态：① HTTP 状态码数字（429、500…：匹配 HTTP status、失败 code 与 message 中的独立数字）；② 机器码（RATE_LIMIT、QUOTA、SERVER、TRANSPORT、TIMEOUT…，忽略大小写）；③ <b>字段=值</b>（如 <code>code=insufficient_quota</code>、<code>type=rate_limit_exceeded</code>：匹配 provider 返回 JSON 的字段，含被压平进 message 的响应体）。多条规则按顺序取第一条命中。delayMs 100~3600000；次数 0~100（0=命中即上报）。Retry-After 更长时按提示。休眠/重试显示在会话框重试卡片中。保存写 llm-error-retry.rules.json 并即时生效；删该文件回落 cordis.patch.yml 默认。</div>
  <div class="sub" style="margin-top:18px"><b>最近活动</b></div>
  <ul id="events"><li>加载中…</li></ul>
<script>
(function () {
  var rows = [];
  var dirty = false;
  function $(id) { return document.getElementById(id); }
  function setNotice(text, cls) { var n = $('notice'); n.textContent = text; n.className = 'notice' + (cls ? ' ' + cls : ''); }
  function markDirty() { dirty = true; }
  function renderRows() {
    var tb = $('rows'); tb.innerHTML = '';
    if (rows.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td'); td.colSpan = 4; td.style.opacity = .6; td.style.textAlign = 'center';
      td.textContent = '无规则：全部错误交给内置策略处理';
      tr.appendChild(td); tb.appendChild(tr); return;
    }
    rows.forEach(function (r, i) {
      var tr = document.createElement('tr');
      function cell(el) { var td = document.createElement('td'); td.appendChild(el); tr.appendChild(td); }
      var code = document.createElement('input'); code.type = 'text'; code.value = r.code; code.placeholder = '429 / RATE_LIMIT / code=xxx';
      code.oninput = function () { rows[i].code = code.value; markDirty(); };
      cell(code);
      var delay = document.createElement('input'); delay.type = 'number'; delay.min = '0.1'; delay.step = '1'; delay.value = r.delayMs / 1000;
      delay.oninput = function () { rows[i].delayMs = Math.max(0, Math.round((parseFloat(delay.value) || 0) * 1000)); markDirty(); };
      cell(delay);
      var max = document.createElement('input'); max.type = 'number'; max.min = '0'; max.max = '100'; max.step = '1'; max.value = r.maxRetries;
      max.oninput = function () { rows[i].maxRetries = Math.max(0, Math.round(Number(max.value) || 0)); markDirty(); };
      cell(max);
      var del = document.createElement('button'); del.className = 'link'; del.textContent = '×'; del.title = '删除该规则';
      del.onclick = function () { rows.splice(i, 1); markDirty(); renderRows(); };
      var tdDel = document.createElement('td'); tdDel.appendChild(del); tr.appendChild(tdDel);
      tb.appendChild(tr);
    });
  }
  function renderEvents(list) {
    var ul = $('events'); ul.innerHTML = '';
    if (!list || list.length === 0) { var li0 = document.createElement('li'); li0.textContent = '暂无记录'; ul.appendChild(li0); return; }
    var labels = { mounted: '挂载', sleeping: '休眠等待中', retrying: '已重新发起请求', cancelled: '休眠被取消', exhausted: '预算耗尽，错误上报', saved: '配置已保存' };
    list.slice(0, 12).forEach(function (e) {
      var li = document.createElement('li');
      var t = new Date(e.at).toLocaleTimeString();
      var body = e.type === 'mounted' || e.type === 'saved' ? ('规则: ' + (e.rules || []).join(', '))
        : (e.failure + ' · 规则「' + e.rule + '」 第 ' + (e.retry || e.attempts || '?') + '/' + (e.maxRetries != null ? e.maxRetries : '?') + ' 次 · 休眠 ' + Math.round((e.delayMs || 0) / 1000) + 's');
      li.textContent = t + ' · ' + (labels[e.type] || e.type) + ' · ' + body;
      ul.appendChild(li);
    });
  }
  function applyState(state) {
    $('meta').textContent = '当前生效：' + state.rules.map(function (r) { return r.code + ' → ' + Math.round(r.delayMs / 1000) + 's ×' + r.maxRetries; }).join('；') + (state.rules.length ? '' : '（无规则）')
      + ' ｜ 来源：' + (state.source === 'file' ? '界面保存文件' : 'cordis.patch.yml 默认值')
      + (state.waiting > 0 ? ' ｜ 正在休眠等待: ' + state.waiting : '');
    if (state.waiting > 0) setNotice('有 ' + state.waiting + ' 个请求正在休眠等待重试…', 'warn');
    else if (!dirty) setNotice('');
    renderEvents(state.lastEvents);
  }
  function refresh(keepDraft) {
    return fetch('/llm-error-retry/api/config', { cache: 'no-store' }).then(function (res) {
      return res.text().then(function (text) {
        try { return JSON.parse(text); } catch (e) { throw new Error('HTTP ' + res.status + ' 响应异常：' + (text.length === 0 ? '空响应体' : text.slice(0, 80))); }
      });
    }).then(function (state) {
      if (!keepDraft || !dirty) { rows = (state.rules || []).map(function (r) { return { code: r.code, delayMs: r.delayMs, maxRetries: r.maxRetries }; }); renderRows(); }
      applyState(state);
    }).catch(function (e) { setNotice('读取失败：' + e, 'err'); });
  }
  $('add').onclick = function () { rows.push({ code: '', delayMs: 60000, maxRetries: 10 }); markDirty(); renderRows(); };
  $('revert').onclick = function () { dirty = false; refresh(false); setNotice('已放弃本地修改', 'ok'); };
  $('save').onclick = function () {
    var payload = { rules: rows.filter(function (r) { return String(r.code).trim() !== ''; }).map(function (r) { return { code: String(r.code).trim(), delayMs: r.delayMs, maxRetries: r.maxRetries }; }) };
    fetch('/llm-error-retry/api/config', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) {
        return res.text().then(function (text) {
          var data; try { data = JSON.parse(text); } catch (e) { data = { ok: false, error: 'HTTP ' + res.status + ' 响应异常：' + (text.length === 0 ? '空响应体' : text.slice(0, 80)) }; }
          return { status: res.status, data: data };
        });
      })
      .then(function (out) {
        if (out.status >= 400 || !out.data.ok) { setNotice('保存失败：' + (out.data.error || ('HTTP ' + out.status)), 'err'); return; }
        dirty = false;
        setNotice('已保存并立即生效（持久化到 rules 文件）', 'ok');
        refresh(true);
      })
      .catch(function (e) { setNotice('保存失败：' + e, 'err'); });
  };
  refresh(false);
  setInterval(function () { refresh(true); }, 3000);
})();
</script>
</body>
</html>
`;
}

export function apply(ctx, config = {}) {
  const baseDir = dirname(fileURLToPath(import.meta.url))
  const statusFile = typeof config.statusFile === 'string' && config.statusFile.trim()
    ? config.statusFile
    : join(baseDir, 'llm-error-retry.status.json')
  const rulesFile = typeof config.rulesFile === 'string' && config.rulesFile.trim()
    ? config.rulesFile
    : join(baseDir, 'llm-error-retry.rules.json')
  const yamlRules = validateRules(config.rules === undefined ? DEFAULT_RULES : config.rules)

  let rules = yamlRules
  let rulesSource = 'yaml-default'

  /** agentId -> { epoch, used: Map<ruleTag, number>, retryId: string | undefined } */
  const counters = new Map()
  /** 活跃休眠的唤醒回调：finish(value) */
  const waiters = new Set()
  /** 最近事件环形缓冲（新在前） */
  const recent = []
  let disposed = false
  let seq = 0

  function loadRulesFile() {
    try {
      if (!existsSync(rulesFile)) { rules = yamlRules; rulesSource = 'yaml-default'; return }
      const parsed = JSON.parse(readFileSync(rulesFile, 'utf8'))
      rules = validateRules(parsed.rules)
      rulesSource = 'file'
    } catch (error) {
      rules = yamlRules
      rulesSource = 'yaml-default（覆盖文件被忽略：' + String((error && error.message) || error) + '）'
    }
  }
  loadRulesFile()

  const record = (event) => {
    seq += 1
    const line = { seq, at: new Date().toISOString(), ...event }
    recent.unshift(line)
    if (recent.length > EVENT_LOG_LIMIT) recent.length = EVENT_LOG_LIMIT
    try {
      writeFileSync(statusFile, JSON.stringify({
        status: 'mounted',
        mountedAt: new Date().toISOString(),
        pid: process.pid,
        rules: rules.map(({ code, delayMs, maxRetries }) => ({ code, delayMs, maxRetries })),
        rulesSource,
        ui: UI_PATH,
        waiting: waiters.size,
        lastEvents: recent,
      }, null, 2))
    } catch {}
    return line
  }

  const sleepCancellable = (delayMs, signal) => new Promise((resolve) => {
    if (disposed || signal?.aborted) {
      resolve(false)
      return
    }
    let settled = false
    let cancelTimer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      waiters.delete(finish)
      if (cancelTimer !== null) cancelTimer()
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)
    cancelTimer = ctx.timeout(() => finish(true), delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    waiters.add(finish)
  })

  // prepend：置于水流最外层，命中规则的失败先由本插件处理（否决内置快速重试）。
  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (disposed) return next()
    const { agent, turn, step, provider, failure, signal } = payload
    const rule = matchAgainst(rules, failure)
    if (rule === undefined) return next()

    const agentId = String(agent.id)
    const epoch = `${provider}/${turn}/${step}`
    let state = counters.get(agentId)
    if (!state || state.epoch !== epoch) {
      state = { epoch, used: new Map(), retryId: undefined }
      counters.set(agentId, state)
    }
    const attempt = (state.used.get(rule.tag) ?? 0) + 1
    const label = describeFailure(failure)

    if (attempt > rule.maxRetries) {
      record({ type: 'exhausted', agent: agentId.slice(0, 8), provider, failure: label, rule: rule.code, attempts: rule.maxRetries })
      ctx.logger.info(`llm-error-retry: ${label} 已达规则 "${rule.code}" 的最大重试次数 (${rule.maxRetries})，错误将向上抛出`)
      return Promise.resolve(undefined)
    }

    state.used.set(rule.tag, attempt)
    let delayMs = rule.delayMs
    const hint = failure.providerRetryAfterMs
    if (typeof hint === 'number' && Number.isFinite(hint) && hint > delayMs) {
      delayMs = Math.min(hint, MAX_DELAY_MS)
    }
    ctx.logger.info(`llm-error-retry: ${label} 命中规则 "${rule.code}"，休眠 ${Math.round(delayMs / 1000)}s 后重试（第 ${attempt}/${rule.maxRetries} 次）`)
    const entry = record({ type: 'sleeping', agent: agentId.slice(0, 8), provider, failure: label, rule: rule.code, retry: attempt, maxRetries: rule.maxRetries, delayMs })

    // 会话框原生重试卡片：调度事件在等待前落盘，醒来后补 started。
    if (state.retryId === undefined) state.retryId = randomUUID()
    const retryId = state.retryId
    try {
      agent.session.append('llm/retry', {
        retryId,
        turn,
        step,
        provider: String(provider),
        mode: 'normal',
        policyKey: 'llm-error-retry/' + rule.code,
        retry: attempt,
        maxRetries: rule.maxRetries,
        delayMs,
        failure: snapshotFailure(failure ?? {}),
      })
    } catch (error) {
      ctx.logger.warn(`llm-error-retry: llm/retry session append failed: ${String((error && error.message) || error)}`)
    }

    return sleepCancellable(delayMs, signal).then((slept) => {
      if (!slept) {
        record({ type: 'cancelled', agent: entry.agent, provider, failure: label, rule: rule.code, retry: attempt, maxRetries: rule.maxRetries })
        return undefined
      }
      try {
        agent.session.append('llm/retry-started', { retryId, turn, step, retry: attempt })
      } catch (error) {
        ctx.logger.warn(`llm-error-retry: llm/retry-started session append failed: ${String((error && error.message) || error)}`)
      }
      ctx.logger.info(`llm-error-retry: ${label} 休眠结束，重新发起请求（第 ${attempt}/${rule.maxRetries} 次）`)
      record({ type: 'retrying', agent: entry.agent, provider, failure: label, rule: rule.code, retry: attempt, maxRetries: rule.maxRetries })
      return { kind: 'retry' }
    })
  }, { prepend: true })

  const disposeCleanup = ctx.on('agent/disposed', ({ agent }) => {
    counters.delete(String(agent.id))
  })

  // ---- 网页配置界面。响应绝不手写 content-length（gzip 中间件冲突）；
  // webServer 用 ctx.inject 异步等待（冷启动竞态防护）。
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  const handleRoute = async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (path === UI_PATH) {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(renderPage())
      return
    }
    if (path === `${UI_PATH}/api/config`) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, {
          rules: rules.map(({ code, delayMs, maxRetries }) => ({ code, delayMs, maxRetries })),
          source: rulesSource,
          waiting: waiters.size,
          lastEvents: recent.slice(0, 12),
        })
        return
      }
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const next = validateRules(body.rules)
        writeFileSync(rulesFile, JSON.stringify({ rules: next.map(({ code, delayMs, maxRetries }) => ({ code, delayMs, maxRetries })) }, null, 2))
        rules = next
        rulesSource = 'file'
        counters.clear()
        record({ type: 'saved', source: 'ui', rules: rules.map(({ code, delayMs, maxRetries }) => `${code}->${delayMs}ms x${maxRetries}`) })
        ctx.logger.info(`llm-error-retry: rules saved via UI -> ${rules.map(({ code, delayMs, maxRetries }) => `${code}->${Math.round(delayMs / 1000)}s x${maxRetries}`).join(', ') || '(none, pass-through)'}`)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found: ' + path })
  }

  // 补丁重组可能「先建新 fiber、后销旧 fiber」：同名 prefix 路由仍被旧 fiber
  // 占着时 register 抛 duplicate —— 捕获并在旧注册释放后轮询抢回。
  let routeDisposer = null
  let routeRetries = 0
  const tryRegister = (webServer) => {
    if (disposed || routeDisposer !== null) return
    try {
      routeDisposer = webServer.register({ kind: 'prefix', path: UI_PATH, handler: handleRoute })
      ctx.logger.info(`llm-error-retry: config UI mounted at ${UI_PATH}`)
    } catch {
      routeDisposer = null
    }
  }
  ctx.inject(['webServer'], (scope) => {
    tryRegister(scope.webServer)
    if (routeDisposer === null && !disposed) {
      ctx.logger.warn('llm-error-retry: UI route busy (previous generation still unmounting), retrying…')
      const stopRetry = ctx.interval(() => {
        routeRetries += 1
        tryRegister(scope.webServer)
        if (routeDisposer !== null || disposed || routeRetries >= 50) {
          stopRetry()
          if (routeDisposer === null && !disposed) {
            ctx.logger.error('llm-error-retry: UI route registration gave up after retries; retry rules still active')
          }
        }
      }, 200)
      scope.effect(() => stopRetry, 'llm-error-retry: route retry timer')
    }
  })

  record({ type: 'mounted', rules: rules.map(({ code, delayMs, maxRetries }) => `${code}->${delayMs}ms x${maxRetries}`) })
  ctx.logger.info(`llm-error-retry: mounted with ${rules.length} rule(s) [source: ${rulesSource}] -> ${rules.map(({ code, delayMs, maxRetries }) => `${code}->${Math.round(delayMs / 1000)}s x${maxRetries}`).join(', ') || '(none, pass-through)'}`)

  ctx.effect(() => () => {
    disposed = true
    disposeListener()
    disposeCleanup()
    if (routeDisposer !== null) routeDisposer()
    for (const wake of waiters) wake(false)
    waiters.clear()
    counters.clear()
  }, 'llm-error-retry: unmount listener, UI route, and release pending retry waits')
}
