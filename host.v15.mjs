/**
 * llm-error-retry v15 — 大模型请求错误「休眠后重试」宿主插件（DSH Profile Bundle 化）。
 *
 * 相比 v14：新增「首字超时」（first-token timeout）。请求发出后若在设定时间内没有收到
 * 模型的第一个输出（文本 / 思考 / 工具调用都算输出），判定上游卡死，中断本次请求并按
 * 机器码 TIMEOUT 上报，让下面那套规则引擎接手（有 TIMEOUT 规则就休眠重试，没有就直接
 * 结束本轮并在聊天区显示超时）。
 *   - 为什么需要：宿主 pi-ai 适配器只有「流空闲」watchdog（profile.streamIdleTimeoutMs，
 *     按块间隔计时、由 profile 配置），既不区分「首字还没来」，插件也改不了它。
 *   - 接缝为什么是 llm/stream：它是 waterfall，next() 返回下游真正的流，包一层即可在
 *     「第一次拉取」处起表；请求对象自身被 Object.freeze 且带 markAgentLoopRequest 的
 *     对象身份标记，改写 options.signal 既改不下去、也会弄丢标记。
 *   - 为什么产出**合成 finish chunk**而不是抛异常：从中间件里抛会直接穿出 agent-loop
 *     （llm/src/index.ts 明确「middleware 失败仍抛出」），不经过 request-error 瀑布；
 *     而 finish.kind === 'error' 会走宿主正常失败路径（agent.ts 派发 agent/request-error），
 *     本插件据此重试、UI 据此渲染失败行。
 *   - 已知限制：生成器停在 await 上时 return() 要排队等那个 await，所以「放弃消费」不等于
 *     立刻断开 HTTP 连接；上游会在自身 idle watchdog 或轮次信号 abort 时收尾。
 *   - 只约束 agent 主请求：带 purpose（compaction / session-title）或无 sessionId 的调用
 *     不设超时——压缩中途被打断会伤上下文，标题生成也没必要中断。
 *
 * 相比 v13：服务端 Retry-After 改为**有上限地**采信（honorRetryAfterMaxMs，默认 60s）。
 * 上游对 429 常回 `Retry-After: 3600`（一小时），照做会让会话整小时不动，用户规则里
 * 自己写的休眠时长也被悄悄改写。现在提示只能把等待**调大**、且不超过该上限；超出时
 * 按规则自己的 delayMs 重试，并在事件里记录原始要求与截断原因。上限 0 = 完全忽略提示。
 *
 * 相比 v12：Retry-After 采信上限从补丁行 YAML 挪进 GUI 设置分区（独立输入框，秒级），
 * 保存写入 rules.json 的 honorRetryAfterMaxMs，与规则一起立即生效；文件值优先于补丁行，
 * 坏值只忽略该字段、不连累规则整体。
 *
 * 相比 v11：补上「跨轮自动重启」。v11 的轮内接力已生效（截断后在同一轮里续步），
 * 但当模型在截断过的轮里最终以 stop 说完、轮次仍以粘性的 max-tokens 结束时，
 * goal-round-driver 见到该 reason 会 disarm 当前目标（它源码如此），没有任何人
 * 开下一轮——会话就此中断，直到用户手动发「继续」。实测 session-8c98ee18
 * turn 25（2026-10-11）：31 次轮内接力把任务推进 1.5 小时后，turn/end 粘在
 * max-tokens 上，goal  disarm，闲置 65 分钟等人工。v12 在 turn/end=max-tokens 且
 * 该轮确有实质推进（有工具调用或新增文本 >40 字）时，自动 followup(「继续」)
 * 开启新轮；连续重启上限 restartTurns（默认 10，正常收尾即清零），无推进则停，
 * 防止模型只会复读「继续」时空转。
 *
 * 相比 v10：把两类接力分开计数。v10 让「截断续写」与「工具步接力」共用 maxContinues
 * 上限并共用 delayMs 休眠；但工具步接力不是额外重试，只是把宿主本来就会做的那一步补
 * 回来（宿主对普通轮的工具循环既无次数上限也不休眠），真实 agentic 轮常有几十上百步
 * 工具调用，共用预算会在第 5 步后把工具结果永远卡在对话外面。v11 中 maxContinues 只
 * 约束「截断→续写→又截断」，工具步接力无上限、零休眠。
 *
 * 相比 v9：修正「输出截断自动继续」只接力一步就停的问题。v9 在 agent/turn-stopping 里
 * 读的是「最后一步」的 finish；而被截断那一步之后，模型通常还会正常完成一步（执行工具
 * 调用），于是 finishKind 变成 'tool-calls'，续写条件再也满足不了，轮次以 max-tokens
 * 收尾、那一步的工具结果也永远不会回到模型。改为：上一步被截断（max-tokens），
 * 或上一步刚执行完工具调用、模型还欠一个回答（tool-calls）就继续接力，直到模型自己
 * 说完（stop）。续写预算仍按轮累计，不随步重置。
 *
 * 相比 v8：新增「输出截断自动继续」——模型达到输出 token 上限被截断时，自动注入一条
 * 提示让模型接着输出，无需人工发送「继续」。
 *   - 为什么不走 agent/request-error：max-tokens 不是失败。pi-ai 把它映射成
 *     { kind: 'max-tokens' }（llm-pi-ai/src/stream.ts），agent-loop 收到后把 step
 *     结算为 StepEndReason（agent.ts），而 request-error 瀑布只在 error/aborted 时触发，
 *     所以任何规则码都命中不了它。
 *   - 为什么必须在 turn-stopping 接力：宿主的 turnEnds 对 max-tokens 是粘性的
 *     （agent.ts「once any step hits the ceiling, later steps that complete normally
 *     must not downgrade the turn outcome」）。一旦粘住，宿主在每个后续 step 收尾时都会
 *     派发 turn-stopping，并在没人投递新 step 时 break——普通「工具调用后自动继续」
 *     正是在这里失效的。插件在这里补回宿主本该做的判断。
 *   - 实现：agent/assistant-stream 记录每个 agent 最近一步的 finish，agent/turn-stopping
 *     需要接力时 agent.steer(...) 追加一步——与 agent-loop 自身的 /loop 模式
 *     （其 turn-stopping 测试）同一个钩子。
 *   - 防跑飞：每轮「截断→续写→又截断」以 maxContinues 次封顶；续写若没有写出任何
 *     新文本（模型在同一位置原地空转），立即停止并记录会话事件。工具步接力不受此限。
 *
 * 相比 v7：新增第四种规则码形态 'msg~子串'（忽略大小写地子串匹配 failure.message）。
 *
 * 规则码四形态（按顺序取第一条命中）：
 *   - 数字 '429'：匹配 failure.status、failure.code（'429'/'HTTP_429'）、
 *     message 中的独立数字（pi-ai 类适配器会把 HTTP 状态压平进 message）。
 *   - 机器码 'RATE_LIMIT'/'QUOTA'…：匹配 failure.code（忽略大小写）。
 *   - '字段=值'（如 code=insufficient_quota）：匹配 provider 返回 JSON 字段：
 *     ① failure.<字段> 标量属性；② message 内嵌 {...} JSON 解析；③ 宽松文本 "字段":"值"。
 *   - 'msg~子串'（如 msg~finish_reason: error）：子串匹配 failure.message。
 *     用于没有 status、code 又被归到通用桶的失败：provider 在 SSE 里以未识别的
 *     finish_reason 终止流时，pi-ai 报成 message='Provider finish_reason: <值>'、
 *     code='PI_AI_ERROR'（openai-completions.js 的 mapStopReason），前三种形态都命中不了。
 *
 * 命中 → 休眠 delayMs → {kind:'retry'} 重新请求；每规则独立 maxRetries，
 * 耗尽即上报；prepend 优先于内置 llm-retry；按 provider/turn/step 计数重置；
 * Retry-After 更长时按提示推迟，但不超过 honorRetryAfterMaxMs（默认 60s，因为
 * 上游常回 `Retry-After: 3600`，照做会让会话整小时不动）；休眠/重试经 'llm/retry' +
 * 'llm/retry-started' 会话事件对显示为聊天区重试卡片。
 *
 * 配置来源（高→低）：<数据目录>/rules.json（界面保存）→ 补丁行 config.rules → 默认 429×60s×10。
 * 界面：GUI「设置」→「LLM 错误重试」；备用页 http://127.0.0.1:3080/llm-error-retry
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'llm-error-retry'
export const inject = ['timer', 'agents']

const DEFAULT_RULES = [{ code: '429', delayMs: 60_000, maxRetries: 10 }]
const MIN_DELAY_MS = 100
/** 规则 delayMs 与 maxTokens.delayMs 的允许上限（配置校验用）。 */
const MAX_DELAY_MS = 3_600_000
const MAX_RETRIES_LIMIT = 1000
const EVENT_LOG_LIMIT = 20
const UI_PATH = '/llm-error-retry'
/**
 * 服务端 Retry-After 高于规则 delayMs 时，最多允许推迟多久再试。
 * 默认 60s：上游常回 `Retry-After: 3600`（一小时），照做会让会话整小时不动，
 * 而用户设规则时的意图是「自己定节奏」。调大（最大 1h）表示更顺从服务端。
 */
const DEFAULT_HONOR_RETRY_AFTER_MAX_MS = 60_000
/**
 * 首字超时：请求发出后多久还没收到模型的第一个输出 chunk 就判定卡死。
 * 默认 180s 且默认开启——正常模型不会三分钟说不出一个字，而卡死的请求可以挂到天亮。
 */
const DEFAULT_FIRST_TOKEN_TIMEOUT = { enabled: true, timeoutMs: 180_000 }
/** 首字超时的允许范围：太小会把排队/长思考误判成卡死。 */
const MIN_FIRST_TOKEN_TIMEOUT_MS = 1_000
const MAX_FIRST_TOKEN_TIMEOUT_MS = 3_600_000
/** 算作「模型已经开口」的 chunk：文本、思考、工具调用增量都算输出。 */
const FIRST_TOKEN_CHUNKS = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta'])
/** 自动续写注入消息的来源标记（区分人工输入与插件注入）。 */
const CONTINUATION_SOURCE = 'llm-error-retry-continuation'
const DEFAULT_MAX_TOKENS = {
  enabled: true,
  text: '继续',
  maxContinues: 5,
  delayMs: 3000,
  restartTurns: 10,
  restartDelayMs: 1200,
}
const MAX_CONTINUES_LIMIT = 50
/** 跨轮重启判「有实质推进」的最低新增文本字数。 */
const RESTART_PROGRESS_MIN_CHARS = 40

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 日志与状态文件里的 agent 短名：session-<uuid> 只截前 8 位会只剩 "session-"，无法区分。 */
function shortId(agentId) {
  const text = String(agentId)
  const stripped = text.startsWith('session-') ? text.slice(8) : text
  return stripped.slice(0, 8)
}

/** Parse one rule code string into its matcher shape. */
function parseRuleCode(code) {
  // `msg~` 是显式前缀，先于 '=' 判定：`msg~a=b` 取整个 "a=b" 作子串，
  // 而字段值里的 '~'（type=rate~limit）不受影响。
  if (/^msg~/i.test(code)) {
    const text = code.slice(4).trim()
    if (!text) return undefined
    return { kind: 'message', text: text.toLowerCase() }
  }
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

/**
 * Validate one `maxTokens` configuration segment for output-truncation continuation.
 * @param {unknown} input - raw `config.maxTokens` from the patch row.
 * @returns {{ enabled: boolean, text: string, maxContinues: number, delayMs: number, restartTurns: number, restartDelayMs: number }} a resolved config.
 * @throws {Error} when a supplied value is of the wrong type or out of range.
 */
export function validateMaxTokens(input) {
  if (input === undefined || input === null) return { ...DEFAULT_MAX_TOKENS }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('llm-error-retry: maxTokens must be an object of { enabled, text, maxContinues, delayMs, restartTurns, restartDelayMs }')
  }
  const enabled = input.enabled === undefined ? DEFAULT_MAX_TOKENS.enabled : input.enabled
  if (typeof enabled !== 'boolean') throw new Error('llm-error-retry: maxTokens.enabled must be a boolean')
  const text = input.text === undefined || input.text === null ? DEFAULT_MAX_TOKENS.text : String(input.text)
  if (text.trim().length === 0) throw new Error('llm-error-retry: maxTokens.text must be non-empty')
  const maxContinues = input.maxContinues === undefined
    ? DEFAULT_MAX_TOKENS.maxContinues
    : Number(input.maxContinues)
  if (!Number.isInteger(maxContinues) || maxContinues < 0 || maxContinues > MAX_CONTINUES_LIMIT) {
    throw new Error(`llm-error-retry: maxTokens.maxContinues must be an integer 0..${MAX_CONTINUES_LIMIT}`)
  }
  const delayMs = input.delayMs === undefined ? DEFAULT_MAX_TOKENS.delayMs : Number(input.delayMs)
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new Error(`llm-error-retry: maxTokens.delayMs must be a number within 0..${MAX_DELAY_MS}`)
  }
  const restartTurns = input.restartTurns === undefined
    ? DEFAULT_MAX_TOKENS.restartTurns
    : Number(input.restartTurns)
  if (!Number.isInteger(restartTurns) || restartTurns < 0 || restartTurns > MAX_CONTINUES_LIMIT) {
    throw new Error(`llm-error-retry: maxTokens.restartTurns must be an integer 0..${MAX_CONTINUES_LIMIT}`)
  }
  const restartDelayMs = input.restartDelayMs === undefined ? DEFAULT_MAX_TOKENS.restartDelayMs : Number(input.restartDelayMs)
  if (!Number.isFinite(restartDelayMs) || restartDelayMs < 0 || restartDelayMs > MAX_DELAY_MS) {
    throw new Error(`llm-error-retry: maxTokens.restartDelayMs must be a number within 0..${MAX_DELAY_MS}`)
  }
  return { enabled, text, maxContinues, delayMs, restartTurns, restartDelayMs }
}

/**
 * Build one identified user message asking the model to continue its truncated output.
 * Branded ids are type-level only, so a hand-built message satisfies the Session contract.
 * @param {string} text - continuation prompt content.
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: string } }} the message.
 */
function createContinuationMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: CONTINUATION_SOURCE },
  })
}

/**
 * Validate the `honorRetryAfterMaxMs` deployment setting.
 * @param {unknown} input - raw value from the patch row.
 * @returns {number} the accepted cap in milliseconds.
 * @throws {Error} when the value is not a finite number in range.
 */
export function validateHonorRetryAfter(input) {
  if (input === undefined || input === null) return DEFAULT_HONOR_RETRY_AFTER_MAX_MS
  const value = Number(input)
  if (!Number.isFinite(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new Error(`llm-error-retry: honorRetryAfterMaxMs must be a number within 0..${MAX_DELAY_MS}`)
  }
  return value
}

/**
 * Validate the `firstTokenTimeout` deployment setting.
 * @param {unknown} input - raw value from the patch row or rules file.
 * @returns {{ enabled: boolean, timeoutMs: number }} a resolved setting.
 * @throws {Error} when a supplied value is of the wrong type or out of range.
 */
export function validateFirstTokenTimeout(input) {
  if (input === undefined || input === null) return { ...DEFAULT_FIRST_TOKEN_TIMEOUT }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('llm-error-retry: firstTokenTimeout must be an object of { enabled, timeoutMs }')
  }
  const enabled = input.enabled === undefined ? DEFAULT_FIRST_TOKEN_TIMEOUT.enabled : input.enabled
  if (typeof enabled !== 'boolean') throw new Error('llm-error-retry: firstTokenTimeout.enabled must be a boolean')
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_FIRST_TOKEN_TIMEOUT.timeoutMs : Number(input.timeoutMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_FIRST_TOKEN_TIMEOUT_MS || timeoutMs > MAX_FIRST_TOKEN_TIMEOUT_MS) {
    throw new Error(`llm-error-retry: firstTokenTimeout.timeoutMs must be a number within ${MIN_FIRST_TOKEN_TIMEOUT_MS}..${MAX_FIRST_TOKEN_TIMEOUT_MS}`)
  }
  return { enabled, timeoutMs }
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
    if (match === undefined) throw new Error(`llm-error-retry: rule "${code}": the "msg~…" and "field=value" forms need a non-empty value after the marker`)
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
    } else if (rule.match.kind === 'message') {
      if (message.toLowerCase().includes(rule.match.text)) return rule
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
  .settings { max-width: 820px; margin-top: 18px; padding: 12px 14px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; }
  .settings-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  .settings-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .settings-row input[type=number] { width: 110px; }
  .settings-note { font-size: 12px; opacity: .7; }
  .settings-help { font-size: 12px; opacity: .6; margin-top: 8px; line-height: 1.55; }
  .settings-help code { background: rgba(255,255,255,.09); padding: 1px 4px; border-radius: 4px; }
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
  <div class="settings">
    <div class="settings-title">服务端 Retry-After 采信上限</div>
    <div class="settings-row">
      <input id="honor" type="number" min="0" max="3600" step="1">
      <span class="unit">秒</span>
      <span id="honor-note" class="settings-note"></span>
    </div>
    <div class="settings-help">上游对 429 常回 <code>Retry-After: 3600</code>（一小时）。它只会把等待<b>调大</b>、不会缩短你规则里的休眠；超过此上限就按规则自己的节奏走。填 <code>0</code> = 完全忽略服务端提示。范围 0–3600 秒。</div>
  </div>
  <div class="settings">
    <div class="settings-title">首字超时（模型多久不出第一个字就中断）</div>
    <div class="settings-row">
      <label style="display:flex;align-items:center;gap:6px"><input id="ft-enabled" type="checkbox"> 启用</label>
      <input id="ft-seconds" type="number" min="1" max="3600" step="1">
      <span class="unit">秒</span>
      <span id="ft-note" class="settings-note"></span>
    </div>
    <div class="settings-help">请求发出后，若这段时间内没有收到模型的任何输出（文本、思考、工具调用都算输出），就中断本次请求并上报错误码 <code>TIMEOUT</code>。规则表里若有 <code>TIMEOUT</code> 规则，会按该规则休眠后自动重试；没有则本轮直接以失败结束，聊天区显示超时。范围 1–3600 秒，取消勾选 = 关闭。</div>
  </div>
  <div class="hint">规则码四种形态：① HTTP 状态码数字（429、500…：匹配 HTTP status、失败 code 和 message 中的独立数字）；② 机器码（RATE_LIMIT、QUOTA、SERVER、TRANSPORT、TIMEOUT、EMPTY_RESPONSE…，忽略大小写）；③ <b>字段=值</b>（如 <code>code=insufficient_quota</code>、<code>type=rate_limit_exceeded</code>：匹配 provider 返回 JSON 的字段，含被压平进 message 的响应体）；④ <b>msg~子串</b>（如 <code>msg~finish_reason: error</code>：忽略大小写地子串匹配失败 message，用于没有 status、只有一句文本的失败，例如 provider 用 finish_reason 终止请求时的 <code>Provider finish_reason: error</code>）。多条规则按顺序取第一条命中。delayMs 范围 100~3600000 毫秒；次数 0~1000（0 = 命中即上报）。服务端 Retry-After 更长时按提示推迟，但会被下方「服务端 Retry-After 采信上限」截断——上游的 <code>Retry-After: 3600</code> 不会让你等满一小时。休眠/重试过程显示在会话框重试卡片中。保存写入 ~/.dsh/llm-error-retry/rules.json 并立即生效；删除该文件回落到 cordis.patch.yml 默认规则。</div>
  <div class="sub" style="margin-top:18px"><b>最近活动</b></div>
  <ul id="events"><li>加载中…</li></ul>
<script>
(function () {
  var rows = [];
  var dirty = false;
  var honorMs = 60000;
  var ftEnabled = true;
  var ftMs = 180000;
  function $(id) { return document.getElementById(id); }
  function setNotice(text, cls) { var n = $('notice'); n.textContent = text; n.className = 'notice' + (cls ? ' ' + cls : ''); }
  function markDirty() { dirty = true; }
  function honorNote(ms) {
    if (ms === 0) return '忽略服务端提示，只按规则节奏';
    if (ms <= 10000) return '基本按规则节奏（提示最多让它多等 ' + (ms / 1000) + 's）';
    if (ms <= 120000) return '适度的服务端礼貌等待';
    return '较顺从服务端（最长要等 ' + (ms / 1000) + 's）';
  }
  function renderHonor() {
    $('honor').value = honorMs / 1000;
    $('honor-note').textContent = honorNote(honorMs);
  }
  function ftNote(ms, enabled) {
    if (!enabled) return '已关闭：不限制首字等待';
    if (ms <= 30000) return '很激进：长思考模型容易被误判';
    if (ms <= 120000) return '较激进：两分钟内不出字即中断';
    if (ms <= 300000) return '适中';
    return '很宽松：要等 ' + Math.round(ms / 1000) + 's 才判定卡死';
  }
  function renderFirstToken() {
    $('ft-enabled').checked = ftEnabled;
    $('ft-seconds').value = Math.round(ftMs / 1000);
    $('ft-note').textContent = ftNote(ftMs, ftEnabled);
  }
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
      var code = document.createElement('input'); code.type = 'text'; code.value = r.code; code.placeholder = '429 / RATE_LIMIT / code=xxx / msg~xxx';
      code.oninput = function () { rows[i].code = code.value; markDirty(); };
      cell(code);
      var delay = document.createElement('input'); delay.type = 'number'; delay.min = '0.1'; delay.step = '1'; delay.value = r.delayMs / 1000;
      delay.oninput = function () { rows[i].delayMs = Math.max(0, Math.round((parseFloat(delay.value) || 0) * 1000)); markDirty(); };
      cell(delay);
      var max = document.createElement('input'); max.type = 'number'; max.min = '0'; max.max = '1000'; max.step = '1'; max.value = r.maxRetries;
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
    var labels = { mounted: '挂载', sleeping: '休眠等待中', retrying: '已重新发起请求', cancelled: '休眠被取消', exhausted: '预算耗尽，错误上报', saved: '配置已保存', continuation: '已自动续写', 'continuation-exhausted': '续写次数用尽', 'continuation-stalled': '续写无进展已停止', restart: '已自动重开新轮', 'restart-exhausted': '重开新轮次数用尽', 'restart-stalled': '无实质推进未重开', 'first-token-timeout': '首字超时已中断' };
    list.slice(0, 12).forEach(function (e) {
      var li = document.createElement('li');
      var t = new Date(e.at).toLocaleTimeString();
      var body
      if (e.type === 'mounted' || e.type === 'saved') {
        body = '规则: ' + (e.rules || []).join(', ')
      } else if (e.type.indexOf('continuation') === 0) {
        body = '第 ' + (e.turn !== undefined ? e.turn : '?') + ' 轮 · ' + (e.reason === 'max-tokens' ? '输出被截断' : e.reason === 'tool-calls' ? '工具结果待回喂' : (e.reason || ''))
          + ' · 第 ' + (e.attempts !== undefined ? e.attempts : '?') + ' 次' + (e.maxContinues !== undefined ? '/' + e.maxContinues : '')
      } else if (e.type.indexOf('restart') === 0) {
        body = '第 ' + (e.turn !== undefined ? e.turn : '?') + ' 轮 · max-tokens 收尾 · 第 ' + (e.attempts !== undefined ? e.attempts : '?') + ' 次' + (e.maxRestartTurns !== undefined ? '/' + e.maxRestartTurns : '')
      } else if (e.type === 'first-token-timeout') {
        body = (e.provider || '?') + '/' + (e.model || '?') + ' · ' + Math.round((e.timeoutMs || 0) / 1000) + 's 内无任何输出'
      } else {
        body = e.failure + ' · 规则「' + e.rule + '」 第 ' + (e.retry || e.attempts || '?') + '/' + (e.maxRetries != null ? e.maxRetries : '?') + ' 次 · 休眠 ' + Math.round((e.delayMs || 0) / 1000) + 's'
      }
      li.textContent = t + ' · ' + (labels[e.type] || e.type) + ' · ' + body;
      ul.appendChild(li);
    });
  }
  function applyState(state) {
    $('meta').textContent = '当前生效：' + state.rules.map(function (r) { return r.code + ' → ' + Math.round(r.delayMs / 1000) + 's ×' + r.maxRetries; }).join('；') + (state.rules.length ? '' : '（无规则）')
      + ' ｜ Retry-After 上限 ' + (Number(state.honorRetryAfterMaxMs) === 0 ? '已忽略' : Math.round(Number(state.honorRetryAfterMaxMs) / 1000) + 's')
      + ' ｜ 首字超时 ' + (state.firstTokenTimeout && state.firstTokenTimeout.enabled === false
          ? '已关闭'
          : Math.round(Number(state.firstTokenTimeout && state.firstTokenTimeout.timeoutMs) || 0) / 1000 + 's')
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
      if (!keepDraft || !dirty) { honorMs = Number(state.honorRetryAfterMaxMs) || 0; renderHonor(); }
      if (!keepDraft || !dirty) {
        var ft = state.firstTokenTimeout || {};
        ftEnabled = ft.enabled !== false;
        ftMs = Number(ft.timeoutMs) || 180000;
        renderFirstToken();
      }
      applyState(state);
    }).catch(function (e) { setNotice('读取失败：' + e, 'err'); });
  }
  $('honor').oninput = function () {
    var sec = Math.min(3600, Math.max(0, Math.round(parseFloat($('honor').value) || 0)));
    honorMs = sec * 1000;
    $('honor-note').textContent = honorNote(honorMs);
    markDirty();
  };
  $('ft-enabled').onchange = function () {
    ftEnabled = $('ft-enabled').checked;
    $('ft-note').textContent = ftNote(ftMs, ftEnabled);
    markDirty();
  };
  $('ft-seconds').oninput = function () {
    var sec = Math.min(3600, Math.max(1, Math.round(parseFloat($('ft-seconds').value) || 0)));
    ftMs = sec * 1000;
    $('ft-note').textContent = ftNote(ftMs, ftEnabled);
    markDirty();
  };
  $('add').onclick = function () { rows.push({ code: '', delayMs: 60000, maxRetries: 10 }); markDirty(); renderRows(); };
  $('revert').onclick = function () { dirty = false; refresh(false); setNotice('已放弃本地修改', 'ok'); };
  $('save').onclick = function () {
    var payload = {
      rules: rows.filter(function (r) { return String(r.code).trim() !== ''; }).map(function (r) { return { code: String(r.code).trim(), delayMs: r.delayMs, maxRetries: r.maxRetries }; }),
      honorRetryAfterMaxMs: honorMs,
      firstTokenTimeout: { enabled: ftEnabled, timeoutMs: ftMs },
    };
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
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir
    : join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'llm-error-retry')
  try { mkdirSync(dataDir, { recursive: true }) } catch {}
  const statusFile = typeof config.statusFile === 'string' && config.statusFile.trim()
    ? config.statusFile
    : join(dataDir, 'status.json')
  const rulesFile = typeof config.rulesFile === 'string' && config.rulesFile.trim()
    ? config.rulesFile
    : join(dataDir, 'rules.json')
  const yamlRules = validateRules(config.rules === undefined ? DEFAULT_RULES : config.rules)
  const maxTokens = validateMaxTokens(config.maxTokens)
  const yamlHonorRetryAfter = validateHonorRetryAfter(config.honorRetryAfterMaxMs)
  const yamlFirstToken = validateFirstTokenTimeout(config.firstTokenTimeout)

  let rules = yamlRules
  let rulesSource = 'yaml-default'
  /** 服务端 Retry-After 的采信上限：界面保存值优先于补丁行，保存后即时生效。 */
  let honorRetryAfterMaxMs = yamlHonorRetryAfter
  /** 首字超时：界面保存值优先于补丁行，保存后即时生效。 */
  let firstTokenTimeout = yamlFirstToken

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
      if (!existsSync(rulesFile)) { rules = yamlRules; rulesSource = 'yaml-default'; honorRetryAfterMaxMs = yamlHonorRetryAfter; firstTokenTimeout = yamlFirstToken; return }
      const parsed = JSON.parse(readFileSync(rulesFile, 'utf8'))
      rules = validateRules(parsed.rules)
      // 设置单独校验：坏值只忽略它自己，不连累规则整体回落到 yaml 默认。
      if (parsed.honorRetryAfterMaxMs !== undefined) {
        try { honorRetryAfterMaxMs = validateHonorRetryAfter(parsed.honorRetryAfterMaxMs) } catch {}
      }
      if (parsed.firstTokenTimeout !== undefined) {
        try { firstTokenTimeout = validateFirstTokenTimeout(parsed.firstTokenTimeout) } catch {}
      }
      rulesSource = 'file'
    } catch (error) {
      rules = yamlRules
      honorRetryAfterMaxMs = yamlHonorRetryAfter
      firstTokenTimeout = yamlFirstToken
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
        version: '0.15.0',
        rules: rules.map(({ code, delayMs, maxRetries }) => ({ code, delayMs, maxRetries })),
        rulesSource,
        firstTokenTimeout,
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
      record({ type: 'exhausted', agent: shortId(agentId), provider, failure: label, rule: rule.code, attempts: rule.maxRetries })
      ctx.logger.info(`llm-error-retry: ${label} 已达规则 "${rule.code}" 的最大重试次数 (${rule.maxRetries})，错误将向上抛出`)
      return Promise.resolve(undefined)
    }

    state.used.set(rule.tag, attempt)
    let delayMs = rule.delayMs
    let honorCapped = false
    // 服务端 Retry-After 更长时按提示推迟，但不超过 honorRetryAfterMaxMs：
    // 上游回 `Retry-After: 3600` 会与规则里用户自定的 10s 差两个数量级。
    // 提示只能把等待**调大**：上限 0 表示完全拒绝提示、保留规则自己的 delayMs。
    const hint = failure.providerRetryAfterMs
    if (typeof hint === 'number' && Number.isFinite(hint) && hint > delayMs) {
      const obeyed = Math.min(hint, honorRetryAfterMaxMs)
      honorCapped = obeyed < hint
      if (obeyed > delayMs) delayMs = obeyed
    }
    const capNote = honorCapped
      ? (delayMs === rule.delayMs
          ? `；服务端要求 ${Math.round(hint / 1000)}s，超过 honorRetryAfterMaxMs，按规则 ${Math.round(delayMs / 1000)}s 重试`
          : `；服务端要求 ${Math.round(hint / 1000)}s，已按 honorRetryAfterMaxMs 截到 ${Math.round(delayMs / 1000)}s`)
      : ''
    ctx.logger.info(`llm-error-retry: ${label} 命中规则 "${rule.code}"，休眠 ${Math.round(delayMs / 1000)}s 后重试（第 ${attempt}/${rule.maxRetries} 次${capNote}）`)
    const entry = record({ type: 'sleeping', agent: shortId(agentId), provider, failure: label, rule: rule.code, retry: attempt, maxRetries: rule.maxRetries, delayMs, ...honorCapped ? { providerRetryAfterMs: hint, cappedBy: honorRetryAfterMaxMs } : {} })

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

  // ---- 输出 token 截断自动续写。max-tokens 不是失败：它不经过 request-error 瀑布，
  // 所以只能自己观察每次 attempt 的 finish，再在轮次收尾处投递一条「继续」。
  /** agentId -> { turn, truncations, toolSteps, finishKind, textChars, cutTextChars, sawMaxTokens } */
  const continuations = new Map()

  const disposeCleanup = ctx.on('agent/disposed', ({ agent }) => {
    counters.delete(String(agent.id))
    continuations.delete(String(agent.id))
    restarts.delete(String(agent.id))
  })

  // 记录每个 agent 最近一步的 finish 与累计文本长度。
  // 只有 'start' 帧带 turn（chunk 帧不带），所以轮次边界必须靠 start 帧建立，
  // 否则 chunk 帧写入的 state.turn 是 undefined，与 turn-stopping 的 turn 永远不相等。
  const disposeStreamWatch = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (disposed) return
    const agentId = String(agent.id)
    if (frame.type === 'start') {
      if (frame.turn === undefined) return
      // 每一次续写都是一个新 step → 新的 start 帧；但续写预算属于「一轮」而非「一步」，
      // 所以只有 turn 真的换了新的才重置，否则上一次累计的计数会被抹掉，
      // 上限与「无进展」判定就再也触不到（死循环的根源）。
      const existing = continuations.get(agentId)
      if (existing !== undefined && existing.turn === frame.turn) return
      continuations.set(agentId, {
        turn: frame.turn, truncations: 0, toolSteps: 0, finishKind: undefined,
        textChars: 0, cutTextChars: undefined, sawMaxTokens: false,
      })
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object') return
    const state = continuations.get(agentId)
    if (state === undefined) return
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') state.textChars += chunk.text.length
      return
    }
    if (chunk.type === 'finish') {
      state.finishKind = chunk.reason?.kind
      // 宿主把 max-tokens 粘在本轮上（agent.ts「later steps that complete normally
      // must not downgrade the turn outcome」）：一旦粘住，turnEnds 不再为 null，
      // 宿主就不再自动跑「工具调用 → 下一步」的循环。所以本轮一旦被截断过，
      // 后续接力全部由本插件负责，直到模型自己以 stop 收尾。
      if (state.finishKind === 'max-tokens') state.sawMaxTokens = true
    }
  })

  const disposeTurnStopping = ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (disposed || !maxTokens.enabled) return
    if (signal?.aborted) return
    const agentId = String(agent.id)
    const state = continuations.get(agentId)
    if (state === undefined || state.turn !== turn) return

    const truncated = state.finishKind === 'max-tokens'
    // 本轮从未被截断：宿主的工具循环本来就正常（turnEnds 为 null 时会继续跑），
    // 这里不要插手，包括以 concludesTurn 正常收束的轮次。
    if (!truncated && !state.sawMaxTokens) return
    if (truncated) {
      // 原地空转：截断→续写→又截断，而续写那一步没写出任何新文本。
      if (state.cutTextChars !== undefined && state.textChars <= state.cutTextChars) {
        record({ type: 'continuation-stalled', agent: shortId(agentId), turn, attempts: state.truncations, reason: 'no progress' })
        ctx.logger.warn(`llm-error-retry: turn ${turn} 自动续写停止：续写一步后未产生新文本，模型原地空转`)
        return
      }
      if (state.truncations >= maxTokens.maxContinues) {
        record({ type: 'continuation-exhausted', agent: shortId(agentId), turn, attempts: state.truncations })
        ctx.logger.info(`llm-error-retry: turn ${turn} 自动续写已达上限 ${maxTokens.maxContinues} 次，停止`)
        return
      }
    } else if (state.finishKind !== 'tool-calls') {
      // 被截断过的轮次里模型自己以 stop 说完，本轮真的结束。
      return
    }

    state.finishKind = undefined
    if (truncated) {
      // 记下当时的文本量，供下次截断判断续写是否真有新产出。
      state.cutTextChars = state.textChars
      state.truncations += 1
      if (maxTokens.delayMs > 0) {
        const slept = await sleepCancellable(maxTokens.delayMs, signal)
        if (!slept) { state.truncations -= 1; return }
      }
      agent.steer(createContinuationMessage(maxTokens.text))
      ctx.logger.info(`llm-error-retry: turn ${turn} 输出被截断，自动注入续写（第 ${state.truncations}/${maxTokens.maxContinues} 次）`)
      record({
        type: 'continuation',
        agent: shortId(agentId),
        turn,
        reason: 'max-tokens',
        attempts: state.truncations,
        textChars: state.textChars,
        maxContinues: maxTokens.maxContinues,
      })
      return
    }

    // 工具步接力：这**不是**额外重试，只是把宿主本来就会做的那一步补回来
    // （宿主对普通轮的工具循环没有任何次数上限，也不会休眠）。所以它不计入
    // maxContinues、不休眠——真实 agentic 轮常有几十上百步工具调用，共用截断
    // 预算会在第 5 步后把工具结果永远卡在对话外面。
    state.toolSteps += 1
    agent.steer(createContinuationMessage(maxTokens.text))
    if (state.toolSteps === 1 || state.toolSteps % 10 === 0) {
      // 首步与每 10 步记一条，避免长工具轮刷满事件环形缓冲。
      record({ type: 'continuation', agent: shortId(agentId), turn, reason: 'tool-calls', attempts: state.toolSteps, toolSteps: state.toolSteps })
      ctx.logger.info(`llm-error-retry: turn ${turn} 工具结果待回喂，自动接力（第 ${state.toolSteps} 步）`)
    }
  })

  // ---- 跨轮自动重启（v12）。turn/end 粘性 max-tokens 会挡住 goal-round-driver 的
  // 自动续轮（它见 max-tokens 即 disarm，goal-round-driver/src/index.ts:333），模型
  // 若在截断过的轮里以 stop 说完，会话就停在原地等人工「继续」。实测 session-8c98ee18
  // turn 25（2026-10-11）：31 次轮内接力推进 1.5 小时后，turn/end 粘 max-tokens、
  // goal disarm、闲置 65 分钟等人工。v12 在轮结束且确有实质推进时，延迟 followup
  // 一条「继续」开启新轮。延迟是必需的：turn/end 派发瞬间 driver 的 phase 仍是
  // running（signal 未 abort），wakeDriver 对这种唤醒既不 latch 也不起新轮
  // （agent.ts send/wakeDriver），必须等它收敛到 idle 后再投。干净收尾（completed）
  // 清零重启计数；连续重启封顶 restartTurns；无推进立即停，防模型只会复读「继续」
  // 时空转烧钱。
  /** agentId -> { restarts: number } */
  const restarts = new Map()

  const disposeSessionWatch = ctx.on('session/event', async (session, event) => {
    if (disposed || !maxTokens.enabled) return
    if (event.type !== 'turn/end') return
    const agentId = String(session.id)
    let state = restarts.get(agentId)
    if (state === undefined) {
      state = { restarts: 0 }
      restarts.set(agentId, state)
    }
    if (event.data.reason.kind === 'completed') {
      if (state.restarts > 0) {
        ctx.logger.info(`llm-error-retry: agent ${shortId(agentId)} 干净收尾，跨轮重启计数清零`)
        state.restarts = 0
      }
      return
    }
    if (event.data.reason.kind !== 'max-tokens') return // aborted/error/blocked 交人工与内置策略
    // 实质推进 = 本轮发生过截断续写、工具接力，或写出了像样的新文本。
    const cont = continuations.get(agentId)
    const progressed = cont !== undefined
      && (cont.sawMaxTokens || cont.toolSteps > 0 || cont.textChars > RESTART_PROGRESS_MIN_CHARS)
    if (!progressed) {
      record({ type: 'restart-stalled', agent: shortId(agentId), turn: event.data.turn, reason: 'no progress' })
      ctx.logger.warn(`llm-error-retry: turn ${event.data.turn} 以 max-tokens 结束但本轮无实质推进，不自动重开新轮`)
      return
    }
    if (state.restarts >= maxTokens.restartTurns) {
      record({ type: 'restart-exhausted', agent: shortId(agentId), turn: event.data.turn, attempts: state.restarts })
      ctx.logger.info(`llm-error-retry: 跨轮自动重启已达上限 ${maxTokens.restartTurns} 次，停手等人工`)
      return
    }
    state.restarts += 1
    const attempt = state.restarts
    // 收敛等待：turn/end 派发瞬间旧 driver 的 phase 仍是 running，此时 followup 的
    // 唤醒既不 latch 也不起新轮（agent.ts wakeDriver 只在 idle 时起轮、只在
    // maintenance/aborted 时 latch）。等它收敛到 idle 后再投，与人工发「继续」同路径。
    if (maxTokens.restartDelayMs > 0) {
      const slept = await sleepCancellable(maxTokens.restartDelayMs, new AbortController().signal)
      if (!slept) { state.restarts -= 1; return }
    }
    const agent = ctx.agents?.get(session.id)
    if (agent === undefined || agent.session !== session) return
    agent.followup(createContinuationMessage(maxTokens.text))
    record({ type: 'restart', agent: shortId(agentId), turn: event.data.turn, attempts: attempt, maxRestartTurns: maxTokens.restartTurns })
    ctx.logger.info(`llm-error-retry: turn ${event.data.turn} 粘性 max-tokens 收尾但有推进，自动开启新轮（第 ${attempt}/${maxTokens.restartTurns} 次）`)
  })

  // ---- 首字超时（v15）。max-tokens 管「说到一半被截断」，这里管「一个字都不说」。
  // llm/stream 是 waterfall：next() 返回下游真正的流。在它外面包一层异步生成器，
  // 在第一次拉取处起表；第一个内容 chunk 到达就撤表。到点不再拉取，而是**产出一个
  // 终止 finish chunk**（kind:'error'，code:'TIMEOUT'）——从中间件抛异常会直接穿出
  // agent-loop（llm/src/index.ts：「middleware 失败仍抛出」），不经过 request-error
  // 瀑布，本插件的规则引擎就没机会重试；合成 finish 则走宿主正常失败路径。
  const TIMED_OUT = Symbol('llm-error-retry/first-token-timeout')
  const ABORTED = Symbol('llm-error-retry/first-token-aborted')

  const guardFirstToken = (inner, timeoutMs, signal, onTimeout) => (async function* () {
    const iterator = inner[Symbol.asyncIterator]()
    let cancelDeadline = null
    let onAbort = null
    try {
      const deadline = new Promise((resolve) => {
        cancelDeadline = ctx.timeout(() => resolve(TIMED_OUT), timeoutMs)
        if (signal !== undefined) {
          onAbort = () => resolve(ABORTED)
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      let armed = true
      let pending = iterator.next()
      // 超时后这个 promise 没人再等：先挂一个吞掉的处理器，避免 unhandled rejection。
      pending.then(undefined, () => {})
      while (true) {
        let step
        if (armed) {
          const raced = await Promise.race([pending, deadline])
          if (raced === TIMED_OUT) {
            onTimeout()
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  code: 'TIMEOUT',
                  message: `首字超时：${Math.round(timeoutMs / 1000)} 秒内没有收到模型的任何输出`,
                },
              },
            }
            return
          }
          // 轮次被取消：不再计时，等原来那个 next 收尾（适配器会给出 aborted 的 finish）。
          if (raced === ABORTED) { armed = false; step = await pending }
          else step = raced
        } else {
          step = await pending
        }
        if (step.done === true) return
        const chunk = step.value
        if (armed && chunk !== null && typeof chunk === 'object' && FIRST_TOKEN_CHUNKS.has(chunk.type)) {
          armed = false
          if (cancelDeadline !== null) { cancelDeadline(); cancelDeadline = null }
          if (onAbort !== null && signal !== undefined) { signal.removeEventListener('abort', onAbort); onAbort = null }
        }
        yield chunk
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') return
        pending = iterator.next()
        if (armed) pending.then(undefined, () => {})
      }
    } finally {
      if (cancelDeadline !== null) cancelDeadline()
      if (onAbort !== null && signal !== undefined) signal.removeEventListener('abort', onAbort)
      // 消费者提前停止（超时/宿主取消）时上游可能还挂在某个 await 上：尽力关闭但**不等**——
      // 生成器停在 await 时 return() 要排在那个 await 之后，await 它会让本流永远不结束。
      const close = iterator.return?.bind(iterator)
      if (close !== undefined) {
        try {
          const closing = close()
          if (closing !== undefined && typeof closing.then === 'function') closing.then(undefined, () => {})
        } catch {}
      }
    }
  })()

  const disposeFirstToken = ctx.on('llm/stream', (options, next) => {
    if (disposed || !firstTokenTimeout.enabled || firstTokenTimeout.timeoutMs <= 0) return next()
    if (options === null || typeof options !== 'object') return next()
    // 只约束 agent 主请求：compaction / session-title 显式带 purpose（压缩中途被打断会
    // 伤上下文），没有 sessionId 的零散调用也无从归属。
    if (options.purpose !== undefined || options.sessionId === undefined) return next()
    const inner = next()
    if (inner === null || inner === undefined || typeof inner[Symbol.asyncIterator] !== 'function') return inner
    const timeoutMs = firstTokenTimeout.timeoutMs
    const provider = String(options.provider ?? '?')
    const model = String(options.model ?? '?')
    return guardFirstToken(inner, timeoutMs, options.signal, () => {
      record({ type: 'first-token-timeout', agent: shortId(options.sessionId), provider, model, timeoutMs })
      ctx.logger.warn(`llm-error-retry: ${provider}/${model} 首字超时：${Math.round(timeoutMs / 1000)}s 内没有收到任何输出，中断本次请求`)
    })
  }, { global: true })

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
          honorRetryAfterMaxMs,
          firstTokenTimeout,
          source: rulesSource,
          waiting: waiters.size,
          lastEvents: recent.slice(0, 12),
        })
        return
      }
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const next = validateRules(body.rules)
        // 设置缺省时保留当前值，便于只改规则的旧客户端继续工作。
        const nextHonor = body.honorRetryAfterMaxMs === undefined
          ? honorRetryAfterMaxMs
          : validateHonorRetryAfter(body.honorRetryAfterMaxMs)
        const nextFirstToken = body.firstTokenTimeout === undefined
          ? firstTokenTimeout
          : validateFirstTokenTimeout(body.firstTokenTimeout)
        writeFileSync(rulesFile, JSON.stringify({
          rules: next.map(({ code, delayMs, maxRetries }) => ({ code, delayMs, maxRetries })),
          honorRetryAfterMaxMs: nextHonor,
          firstTokenTimeout: nextFirstToken,
        }, null, 2))
        rules = next
        honorRetryAfterMaxMs = nextHonor
        firstTokenTimeout = nextFirstToken
        rulesSource = 'file'
        counters.clear()
        record({ type: 'saved', source: 'ui', rules: rules.map(({ code, delayMs, maxRetries }) => `${code}->${delayMs}ms x${maxRetries}`), honorRetryAfterMaxMs, firstTokenTimeout: nextFirstToken })
        ctx.logger.info(`llm-error-retry: rules saved via UI -> ${rules.map(({ code, delayMs, maxRetries }) => `${code}->${Math.round(delayMs / 1000)}s x${maxRetries}`).join(', ') || '(none, pass-through)'}; Retry-After 采信上限 ${Math.round(nextHonor / 1000)}s${nextHonor === 0 ? '（忽略服务端提示）' : ''}`)
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
  ctx.logger.info(`llm-error-retry: mounted with ${rules.length} rule(s) [source: ${rulesSource}] -> ${rules.map(({ code, delayMs, maxRetries }) => `${code}->${Math.round(delayMs / 1000)}s x${maxRetries}`).join(', ') || '(none, pass-through)'}; 首字超时 ${firstTokenTimeout.enabled ? Math.round(firstTokenTimeout.timeoutMs / 1000) + 's' : '已关闭'}`)

  ctx.effect(() => () => {
    disposed = true
    disposeListener()
    disposeCleanup()
    disposeStreamWatch()
    disposeTurnStopping()
    disposeSessionWatch()
    disposeFirstToken()
    if (routeDisposer !== null) routeDisposer()
    for (const wake of waiters) wake(false)
    waiters.clear()
    counters.clear()
  }, 'llm-error-retry: unmount listener, UI route, and release pending retry waits')
}
