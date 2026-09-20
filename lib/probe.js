// lib/probe.js — 推理服务探针：周期性向推理服务发一个小请求，读服务端自计时的 timings 块，
// 得到 4 个实时指标：首字时延 / 输入速率 / 生成速率 / 单字时延。
//
// 背景（142 llama.cpp-new build 实测，2026-09）：
//   该 build 的 /metrics 计数器是"请求级批量上报"——tokens_predicted_total 在请求结束时一次性累加，
//   prompt_tokens_total 在 prefill 完成后跳变；predicted_tokens_seconds gauge 是上次 reset 以来的
//   累计平均步频（≈0）且该 build 没有 TTFT 指标。插件"相邻帧差值÷间隔"的旧算法因此大部分帧为 0、
//   请求结束帧巨大尖刺，TTFT/TPOT 恒 null。
//   而该 build 每个请求响应自带 timings 对象（服务端自计时，比计数器精确）：
//     prompt_ms / prompt_per_second / predicted_per_token_ms / predicted_per_second
//     draft_n / draft_n_accepted（MTP 草稿/接受）
//   vLLM（标准 OpenAI 响应）没有 timings → 返回 null，调用方继续走 /metrics 原逻辑。
//
// 探针开销：max_tokens≈64 的小请求 / probeIntervalMs（默认 60s），占并发槽位 1/N，可忽略。

const randNonce = () => 'probe-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)

/** 随机前缀 + 固定短指令；nonce 保证服务端前缀缓存必未命中（timings 量的是完整 prefill） */
export const probePrompt = () => randNonce() + ' 请从1数到30，只输出数字，用空格分隔。'

/**
 * 向 {base}/v1/chat/completions 发非流式小请求并读 timings。
 * @param base  推理服务 base（如 http://192.168.31.142:8000）
 * @param model 模型名（/v1/models 自动读取值或手动兜底）
 * @returns {ttftMs, tpotMs, genTps, promptTps, tokens, cached, at} 或 null（无 timings / 请求失败）
 */
export async function probeInfer(base, model, { maxTokens = 64, timeoutMs = 90000 } = {}) {
  const b = String(base || '').replace(/\/+$/, '')
  if (!b || !model) return null
  let j = null
  try {
    const r = await fetch(b + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: probePrompt() }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    j = await r.json()
  } catch {
    return null
  }
  const t = j && typeof j === 'object' ? j.timings : null
  if (!t || typeof t !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const ttftMs = num(t.prompt_ms)
  const tpotMs = num(t.predicted_per_token_ms)
  const genTps = num(t.predicted_per_second)
  const promptTps = num(t.prompt_per_second)
  if (ttftMs === null && tpotMs === null && genTps === null && promptTps === null) return null
  const usage = (j && typeof j === 'object' && j.usage && typeof j.usage === 'object') ? j.usage : {}
  return {
    ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
    tpotMs: tpotMs !== null ? Math.round(tpotMs * 10) / 10 : null,
    genTps: genTps !== null ? Math.round(genTps * 10) / 10 : null,
    promptTps: promptTps !== null ? Math.round(promptTps * 10) / 10 : null,
    tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
    cached: usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens : null,
    at: Date.now(),
  }
}
