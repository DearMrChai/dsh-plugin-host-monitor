// lib/http-metrics.js — 推理指标直连取数（DSH 宿主机 → http://{host}:8000）
// 背景：vLLM 时代走 SSH 远程 curl（依赖对方构建的服务端点）；现改为宿主机直连 /metrics，
// 跟随设置卡 vllmBaseUrl（支持 {host} 占位，由 index.js 替换为当前所选目标 IP）。
// 兼容两套指标族：llamacpp:*（llama.cpp）与 vllm:*（vLLM）；输出字段形状与 core.parseVllmMetrics 一致。

import { parseModelsOutput } from './core.js'

/** 通用 Prometheus 文本解析：行形如 name{labels} 0.5；跳过 # 注释行；同名取末值 */
export function parsePrometheusText(text) {
  const raw = {}
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const parts = t.split(/\s+/)
    if (parts.length < 2) continue
    const name = parts[0].replace(/\{.*$/, '')
    const v = Number(parts[parts.length - 1])
    if (!Number.isFinite(v)) continue
    raw[name] = v
  }
  return raw
}

/**
 * raw（Prometheus 键值表）→ 监控帧 vllm 对象（字段形状与 core.parseVllmMetrics 相同）。
 * vllm:* 优先；无 vllm 前缀时按 llamacpp:* 映射：
 *   requests_processing→runningCount  requests_deferred→waitingCount
 *   tokens_predicted_total→generationTokensTotal  prompt_tokens_total→promptTokensTotal
 *   predicted_tokens_seconds→tpotMs（=1000/tps，decode 吞吐反推单字时延）
 *   spec_decode_num_draft/accepted_tokens_total→MTP 指标
 * llama.cpp 无 KV 缓存占比/TTFT/E2E/抢占数 → 相应字段为 null（卡片显示 —，告警自动跳过）
 */
export function mapInferenceMetrics(raw) {
  const hasVllm = Object.keys(raw).some((k) => k.startsWith('vllm:'))
  const hasLlama = Object.keys(raw).some((k) => k.startsWith('llamacpp:'))
  const alive = hasVllm || hasLlama
  const num = (k) => (raw[k] === undefined ? null : raw[k])
  const pct = (k) => (raw[k] === undefined ? null : Math.round(raw[k] * 10000) / 100)
  const histMs = (base) => {
    const sum = raw[base + '_sum']
    const cnt = raw[base + '_count']
    if (sum === undefined || cnt === undefined || !(cnt > 0)) return null
    return Math.round((sum / cnt) * 1000)
  }

  let runningCount, waitingCount, swappedCount, kvCacheUsagePct, gpuCacheUsagePct
  let generationTokensTotal, promptTokensTotal, numPreempted, ttftMs, tpotMs, e2eLatencyMs
  let specDraftTokens, specAcceptedTokens, specAcceptRate

  if (hasVllm) {
    runningCount = num('vllm:num_requests_running')
    waitingCount = num('vllm:num_requests_waiting')
    swappedCount = num('vllm:num_requests_swapped')
    kvCacheUsagePct = pct('vllm:kv_cache_usage_perc')
    gpuCacheUsagePct = pct('vllm:gpu_cache_usage_perc')
    generationTokensTotal = num('vllm:generation_tokens_total')
    promptTokensTotal = num('vllm:prompt_tokens_total')
    numPreempted = num('vllm:num_preemptions_total')
    ttftMs = histMs('vllm:time_to_first_token_seconds')
    tpotMs = histMs('vllm:time_per_output_token_seconds')
    e2eLatencyMs = histMs('vllm:e2e_request_latency_seconds')
    specDraftTokens = num('vllm:spec_decode_num_draft_tokens_total')
    specAcceptedTokens = num('vllm:spec_decode_num_accepted_tokens_total')
  } else {
    runningCount = num('llamacpp:requests_processing')
    waitingCount = num('llamacpp:requests_deferred')
    swappedCount = null
    kvCacheUsagePct = null
    gpuCacheUsagePct = null
    generationTokensTotal = num('llamacpp:tokens_predicted_total')
    promptTokensTotal = num('llamacpp:prompt_tokens_total')
    numPreempted = null
    ttftMs = null
    e2eLatencyMs = null
    const tps = raw['llamacpp:predicted_tokens_seconds']
    tpotMs = tps !== undefined && tps > 0 ? Math.round(1000 / tps) : null
    specDraftTokens = num('llamacpp:spec_decode_num_draft_tokens_total')
    specAcceptedTokens = num('llamacpp:spec_decode_num_accepted_tokens_total')
  }
  // specAcceptRate（滑窗速率）由 MonitorCore.ingest 计算（近 60s ΣΔacc/ΣΔdraft）：
  // 映射层不再输出累计比值——累计在空闲时冻结，UI 会出现「一直 100% 不动」的假象
  specAcceptRate = null

  return {
    runningCount, waitingCount, swappedCount,
    kvCacheUsagePct, gpuCacheUsagePct,
    generationTokensTotal, promptTokensTotal, numPreempted,
    ttftMs, tpotMs, e2eLatencyMs,
    specDraftTokens, specAcceptedTokens, specAcceptRate,
    engine: hasVllm ? 'vllm' : hasLlama ? 'llama' : null,
    alive,
  }
}

/**
 * 只拉取推理服务模型名（GET {base}/v1/models）——低频用：仅在开启采集/切换频率/切换主机时调用。
 * @returns 模型名 string | null（端点不可达/无模型 → null）
 */
export async function fetchModels(baseUrl, timeoutMs = 5000) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return null
  try {
    const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    return parseModelsOutput(await r.text())
  } catch {
    return null
  }
}

/**
 * 直连推理服务取指标（GET {base}/metrics），可选同时取模型名（GET {base}/v1/models）。
 * @param opts.models 是否同时取模型名，默认 true；周期轮询应传 false——模型名改为低频单独拉取（见 fetchModels），
 *        避免每周期都打一次 /v1/models 浪费请求
 */
export async function fetchInferenceMetrics(baseUrl, timeoutMs = 5000, { models = true } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return { vllm: null, modelName: null }
  const signal = AbortSignal.timeout(timeoutMs)
  let mText = null
  let dText = null
  try {
    const tasks = [fetch(base + '/metrics', { signal }).then((r) => (r.ok ? r.text() : null)).catch(() => null)]
    if (models) tasks.push(fetch(base + '/v1/models', { signal }).then((r) => (r.ok ? r.text() : null)).catch(() => null))
    const [mRes, dRes] = await Promise.all(tasks)
    mText = mRes
    dText = dRes
  } catch { /* 超时/网络错误 → 全部按空处理 */ }
  const vllm = mapInferenceMetrics(parsePrometheusText(mText))
  return { vllm: vllm.alive ? vllm : null, modelName: dText !== null ? parseModelsOutput(dText) : null }
}
