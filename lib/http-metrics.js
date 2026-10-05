// lib/http-metrics.js — 推理指标直连取数（0.10.0：原生支持 llama-swap 形态）
// 背景：DSH 宿主机直连推理入口（{host}:8000，占位符由 index.js 替换为当前所选目标 IP）。
// 0.10.0 起入口可能是 llama-swap（142 自 2026-10-03 的形态：:8000 为统一入口，
// 指标在臂端口上，端口由 swap 动态分配）；取数分流：
//   1) GET {base}/running 探测入口：
//      200+JSON{running}      = llama-swap → 走臂端口
//      404/非 JSON            = 直连形态（端口上直接是 vLLM/llama.cpp，0.9.0 行为）
//      连接失败/超时          = 入口失联（state=down）
//   2) swap 模式：/running 给出 ready 臂的 proxy（如 http://localhost:8012）→
//      armUrlFromProxy 把 localhost 换成目标 IP → 去臂端口取 /metrics（+ 低频 /v1/models）
//   3) 无 ready 臂：/running 里有非 ready 臂 → state=loading（加载中，~2min）；
//      /running 为空再看目录（/v1/models）有无 loaded/unloaded 之外的状态 → loading；
//      否则 state=idle（模型未装载：ttl 到期闲置释放，属正常态，不告警）
//   4) 直连形态 / 入口失联：base 端口取 vllm:* / 全空
// 指标族兼容 llamacpp:*（llama.cpp）与 vllm:*（vLLM），输出字段形状与旧版一致。
// 0.10.0 同时适配新版 vLLM fork 指标改名（2026-10 于 142 实测）：
//   TPOT：time_per_output_token_seconds → request_time_per_output_token_seconds（旧名仍识别）；
//   gpu_cache_usage_perc / num_requests_swapped 已被上游删除 → 对应字段 null（卡片显示 —，告警自动跳过）。

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
 * raw（Prometheus 键值表）→ 监控帧 vllm 对象（字段形状与旧版相同）。
 * vllm:* 优先；无 vllm 前缀时按 llamacpp:* 映射：
 *   requests_processing→runningCount  requests_deferred→waitingCount
 *   tokens_predicted_total→generationTokensTotal  prompt_tokens_total→promptTokensTotal
 *   predicted_tokens_seconds→tpotMs（=1000/tps，decode 吞吐反推单字时延）
 *   spec_decode_num_draft/accepted_tokens_total→MTP 指标
 * vLLM 侧 TPOT 先认新名 request_time_per_output_token_seconds，旧名 fallback；
 * 新版已删 gpu_cache_usage_perc / num_requests_swapped → 相应字段 null。
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
  const histMsAny = (...bases) => {
    for (const b of bases) {
      const v = histMs(b)
      if (v !== null) return v
    }
    return null
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
    // 新 fork 改名：request_time_per_output_token_seconds（2026-10 实测）；旧版 build 仍用旧名
    tpotMs = histMsAny('vllm:request_time_per_output_token_seconds', 'vllm:time_per_output_token_seconds')
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
 * 把 swap 上报的臂 proxy（如 http://localhost:8012）改写成从本机能访问的 URL：
 * localhost/127.0.0.1/::1 → 目标主机（base 的 hostname）；非本机地址原样返回。
 */
export function armUrlFromProxy(proxy, baseUrl) {
  try {
    const p = new URL(proxy)
    const b = new URL(baseUrl)
    if (!p.hostname) return null
    if (!['localhost', '127.0.0.1', '::1'].includes(p.hostname)) return proxy
    return b.protocol + '//' + b.hostname + (p.port ? ':' + p.port : '')
  } catch {
    return null
  }
}

/**
 * 探测推理入口（GET {base}/running）：
 * @returns { up, isSwap, arms, ready, loadingArm }
 *   up=true 时 isSwap=true（llama-swap）/ false（直连形态，无 /running 或响应非 JSON）
 *   up=false 时 isSwap=null（入口失联）
 *   arms: [{id, state, armUrl}]；ready: 首个 state=ready 的臂；
 *   loadingArm: 无 ready 臂时的首个非 ready 臂 id（防御性覆盖 starting/loading 等状态串）
 */
export async function fetchSwapStatus(baseUrl, timeoutMs = 5000) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const fail = { up: false, isSwap: null, arms: null, ready: null, loadingArm: null }
  if (!base) return fail
  let r = null
  try {
    r = await fetch(base + '/running', { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return fail   // 连接失败/超时：入口失联
  }
  if (!r.ok) {
    // 404/405 等：该端口不是 llama-swap 入口（纯 vLLM/llama.cpp 直连形态）
    return { up: true, isSwap: false, arms: [], ready: null, loadingArm: null }
  }
  let j = null
  try { j = await r.json() } catch { j = null }
  const arr = (j && Array.isArray(j.running)) ? j.running : null
  if (!arr) {
    // 200 但非 JSON（如反代落地页）：按非 swap 直连形态处理
    return { up: true, isSwap: false, arms: [], ready: null, loadingArm: null }
  }
  const arms = []
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue
    const id = String(a.model || a.name || a.id || '').trim()
    if (!id) continue
    const state = String(a.state || 'ready')
    const armUrl = a.proxy ? armUrlFromProxy(a.proxy, base) : null
    arms.push({ id, state, armUrl })
  }
  const ready = arms.find((x) => x.state === 'ready') || null
  const loadingArm = (!ready && arms.length >= 1) ? arms[0].id : null
  return { up: true, isSwap: true, arms, ready, loadingArm }
}

/** swap 目录（GET {base}/v1/models）：[{id, status}]；status 为「loaded/unloaded/其他」，失败 → null */
export async function fetchCatalog(baseUrl, timeoutMs = 5000) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return null
  try {
    const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const j = await r.json()
    const arr = (j && Array.isArray(j.data)) ? j.data : null
    if (!arr) return null
    const out = []
    for (const m of arr) {
      if (!m || typeof m !== 'object') continue
      const id = String(m.id || '').trim()
      if (!id) continue
      const st = (m.status && typeof m.status === 'object') ? String(m.status.value || '')
        : (typeof m.status === 'string' ? m.status : '')
      out.push({ id, status: st })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

/** GET 取文本；非 2xx / 超时 / 网络错误 → null */
async function fetchText(url, timeoutMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok ? await r.text() : null
  } catch {
    return null
  }
}

/**
 * 只拉取推理服务模型名（GET {base}/v1/models）——低频用：换臂/开启采集/切频率/切主机/手动刷新时调用。
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
 * 取数主入口（0.10.0 swap 感知三分支）：
 *   swap 在 + ready 臂   → 臂端口 /metrics（+ 可选 /v1/models）
 *   swap 在 + 无 ready 臂 → loading（有非 ready 臂）/ idle（全卸载，正常）
 *   非 swap / 入口失联    → 直连形态取 base 端口 / 全空
 * @param opts.models 是否同时取模型名，默认 true；周期轮询应传 false——
 *        模型名由 index.js 跟随换臂低频拉取（见 fetchModels / fetchSwapStatus），避免每周期重复请求
 * @returns { vllm, modelName, swap: { up, state, armId, armPort, loadingArm } }
 *   state: 'armed' | 'idle' | 'loading' | 'direct' | 'down'
 */
export async function fetchInference(baseUrl, timeoutMs = 5000, { models = true } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const down = { vllm: null, modelName: null, swap: { up: false, state: 'down', armId: null, armPort: null, loadingArm: null } }
  if (!base) return down
  const st = await fetchSwapStatus(base, timeoutMs)
  if (!st.up) return down

  if (st.isSwap === false) {
    // 直连形态：该端口直接是 vLLM/llama.cpp（0.9.0 行为）
    const mText = await fetchText(base + '/metrics', timeoutMs)
    let dText = null
    if (models) dText = await fetchText(base + '/v1/models', timeoutMs)
    const vllm = mapInferenceMetrics(parsePrometheusText(mText))
    return {
      vllm: vllm.alive ? vllm : null,
      modelName: dText !== null ? parseModelsOutput(dText) : null,
      swap: { up: true, state: 'direct', armId: null, armPort: null, loadingArm: null },
    }
  }

  // llama-swap 模式
  if (st.ready && st.ready.armUrl) {
    const mText = await fetchText(st.ready.armUrl + '/metrics', timeoutMs)
    let dText = null
    if (models) dText = await fetchText(st.ready.armUrl + '/v1/models', timeoutMs)
    const vllm = mapInferenceMetrics(parsePrometheusText(mText))
    let armPort = null
    try { armPort = Number(new URL(st.ready.armUrl).port) || null } catch { armPort = null }
    return {
      // 注意：/running 说 ready 但 /metrics 取不到（臂异常/上游无 log-stats）→ vllm=null，
      // state 仍为 armed（入口与臂都在），由 core 按“2 帧无数据”走告警——这是真异常
      vllm: vllm.alive ? vllm : null,
      modelName: dText !== null ? parseModelsOutput(dText) : null,
      swap: { up: true, state: 'armed', armId: st.ready.id, armPort, loadingArm: null },
    }
  }

  if (st.loadingArm) {
    return { vllm: null, modelName: null, swap: { up: true, state: 'loading', armId: null, armPort: null, loadingArm: st.loadingArm } }
  }

  // /running 为空 → 翻目录（loading 中的臂可能未列入 /running，目录状态会是 loaded/unloaded 之外的值）
  const cat = await fetchCatalog(base, timeoutMs)
  if (cat) {
    const loading = cat.find((m) => m.id && m.status && !['loaded', 'unloaded'].includes(m.status))
    if (loading) {
      return { vllm: null, modelName: null, swap: { up: true, state: 'loading', armId: null, armPort: null, loadingArm: loading.id } }
    }
  }
  return { vllm: null, modelName: null, swap: { up: true, state: 'idle', armId: null, armPort: null, loadingArm: null } }
}
