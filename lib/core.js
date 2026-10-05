// lib/core.js — 纯逻辑核心（无 cordis 依赖，可独立测试）
// 职责：SSH 取数输出解析 / 环形历史 / 窗口聚合 / 阈值告警事件引擎 / 状态视图
// 指标：GPU×2（温度/使用率/显存）、CPU（温度/使用率）、内存（已用/总量/百分比）、vLLM（请求/tokens/时延/缓存/模型名）

export const numOrNull = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null

export const round1 = (v) => Math.round(v * 10) / 10

// ---- nvidia-smi csv 行："0, GeForce RTX 2080 Ti, 62, 45, 5120, 11264" ----
export function parseGpuOutput(text) {
  const gpus = []
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(",").map((s) => s.trim())
    if (parts.length < 6) continue
    gpus.push({
      idx: Number(parts[0]) || 0,
      name: parts[1] || "",
      tempC: numOrNull(Number(parts[2])),
      utilPct: numOrNull(Number(parts[3])),
      memUsedMB: numOrNull(Number(parts[4])),
      memTotalMB: numOrNull(Number(parts[5])),
    })
  }
  return gpus
}

// ---- /proc/stat 首行 "cpu  a b c idle ..." ----
export function parseCpuLine(text) {
  const m = /^cpu\s+([\d\s]+)$/.exec(String(text ?? "").trim())
  if (!m) return null
  const nums = m[1].trim().split(/\s+/).map(Number)
  let total = 0
  for (const n of nums) total += n
  return { total, idle: nums[3] ?? 0 }
}

export function cpuUtilPercent(prev, cur) {
  if (!prev || !cur) return null
  const dTotal = cur.total - prev.total
  const dIdle = cur.idle - prev.idle
  if (dTotal <= 0 || dIdle < 0) return null
  const util = (1 - dIdle / dTotal) * 100
  return util < 0 ? 0 : round1(util)
}

// ---- /proc/meminfo：MemTotal / MemAvailable（kB → MB） ----
export function parseMemOutput(text) {
  const s = String(text ?? "")
  const m = /MemTotal:\s*(\d+)/.exec(s)
  const a = /MemAvailable:\s*(\d+)/.exec(s)
  const totalKb = m ? Number(m[1]) : null
  const availKb = a ? Number(a[1]) : null
  const totalMB = totalKb !== null ? round1(totalKb / 1024) : null
  const usedMB = totalKb !== null && availKb !== null ? round1((totalKb - availKb) / 1024) : null
  const pct = totalKb !== null && availKb !== null && totalKb > 0
    ? round1(((totalKb - availKb) / totalKb) * 100)
    : null
  return { totalMB, usedMB, pct }
}

// ---- hwmon 温度（毫摄氏度，命令里已 sort -rn | head -1） ----
export function parseTempInput(text) {
  const t = Number(String(text ?? "").trim())
  return Number.isFinite(t) && t > 0 ? round1(t / 1000) : null
}

// ---- /proc/cpuinfo 型号（"model name	: AMD Ryzen 5 5600 ..."） ----
export function parseCpuModel(text) {
  const t = String(text ?? "").trim()
  if (!t) return null
  return t.replace(/^model name\s*:\s*/i, "").trim()
}

// ---- 完整取数命令输出解析（分段标记 #S/#T/#M/#F/#V/#Q） ----
export function parseCollectOutput(text) {
  const sec = { __: "" }
  let cur = "__"
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim()
    if (t === "#S" || t === "#C" || t === "#T" || t === "#M" || t === "#F" || t === "#V" || t === "#Q" || t === "#N" || t === "#P") { cur = t; continue }
    sec[cur] = (sec[cur] || "") + line + "\n"
  }
  return {
    gpu: parseGpuOutput(sec.__ || ""),
    cpuStat: parseCpuLine(sec["#S"] || ""),
    cpuModel: parseCpuModel(sec["#C"] || ""),
    cpuTempC: parseTempInput(sec["#T"] || ""),
    mem: parseMemOutput(sec["#M"] || ""),
    vllm: parseVllmMetrics(sec["#V"] || ""),
    vllmModel: parseModelsOutput(sec["#Q"] || ""),
    netDev: parseNetDev(sec["#N"] || ""),
    ipAddr: parseIpAddr(sec["#P"] || ""),
  }
}

// ---- /proc/net/dev: "iface: rxbytes rxpackets ... txbytes txpackets ..."（16 字段） ----
// 返回 { iface: { rx, tx } }（字节数）；前两行表头无冒号，自动跳过
export function parseNetDev(text) {
  const out = {}
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim()
    const ci = t.indexOf(":")
    if (!t || ci <= 0) continue
    const iface = t.slice(0, ci).trim()
    const nums = t.slice(ci + 1).trim().split(/\s+/).map((s) => Number(s))
    if (!iface || nums.length < 16 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[8])) continue
    out[iface] = { rx: nums[0], tx: nums[8] }
  }
  return out
}

// ---- ip -br addr: "iface  UP  192.168.31.142/24 ..." → { iface: 首个 IPv4 }（跳过 lo 与无数值 IP 的行） ----
export function parseIpAddr(text) {
  const out = {}
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(/\s+/)
    const iface = parts[0]
    if (!iface || iface === "lo" || out[iface]) continue
    const ip = parts.find((p) => /^\d{1,3}(\.\d{1,3}){3}/.test(p))
    if (ip) out[iface] = ip.split("/")[0]
  }
  return out
}

// ---- vLLM /metrics 指标段（请求/缓存/tokens/时延；空=不在线） ----
export function parseVllmMetrics(text) {
  const raw = {}
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim()
    if (!t) continue
    // 行形如 vllm:metric{labels} 0.5，或裸 vllm:metric 3；剥离 labels 取行末数值
    const parts = t.split(/\s+/)
    if (parts.length < 2) continue
    const name = parts[0].replace(/\{.*$/, "")
    const v = Number(parts[parts.length - 1])
    if (!Number.isFinite(v)) continue
    raw[name] = v
  }
  const pct = (n) => (raw[n] === undefined ? null : Math.round(raw[n] * 10000) / 100)
  const histMs = (n) => {
    const sum = raw[n + "_sum"]
    const cnt = raw[n + "_count"]
    if (sum === undefined || cnt === undefined || !(cnt > 0)) return null
    return Math.round((sum / cnt) * 1000)
  }
  return {
    runningCount: raw["vllm:num_requests_running"] ?? null,
    waitingCount: raw["vllm:num_requests_waiting"] ?? null,
    swappedCount: raw["vllm:num_requests_swapped"] ?? null,
    kvCacheUsagePct: pct("vllm:kv_cache_usage_perc"),
    gpuCacheUsagePct: pct("vllm:gpu_cache_usage_perc"),
    generationTokensTotal: raw["vllm:generation_tokens_total"] ?? null,
    promptTokensTotal: raw["vllm:prompt_tokens_total"] ?? null,
    numPreempted: raw["vllm:num_preemptions_total"] ?? null,
    ttftMs: histMs("vllm:time_to_first_token_seconds"),
    tpotMs: histMs("vllm:time_per_output_token_seconds"),
    e2eLatencyMs: histMs("vllm:e2e_request_latency_seconds"),
    // 推测解码（MTP）指标：draft/accepted tokens → 接受率
    specDraftTokens: raw["vllm:spec_decode_num_draft_tokens_total"] ?? null,
    specAcceptedTokens: raw["vllm:spec_decode_num_accepted_tokens_total"] ?? null,
    specAcceptRate: (() => {
      const d = raw["vllm:spec_decode_num_draft_tokens_total"]
      const a = raw["vllm:spec_decode_num_accepted_tokens_total"]
      if (d === undefined || a === undefined || !(d > 0)) return null
      return Math.round(a / d * 10000) / 100
    })(),
    alive: Object.keys(raw).length > 0,
  }
}

// ---- 推理服务 /v1/models 模型名 ----
// vLLM: data[0].id；llama.cpp: models[0].name（回退 .model）；JSON 截断时正则兜底
export function parseModelsOutput(text) {
  const s = String(text ?? "").trim()
  if (!s) return null
  try {
    const j = JSON.parse(s)
    const arr = j && Array.isArray(j.data) ? j.data : null
    if (arr && arr.length && arr[0] && typeof arr[0].id === "string" && arr[0].id) return arr[0].id
    const lm = j && Array.isArray(j.models) ? j.models : null
    if (lm && lm.length && lm[0]) {
      if (typeof lm[0].name === "string" && lm[0].name) return lm[0].name
      if (typeof lm[0].model === "string" && lm[0].model) return lm[0].model
    }
  } catch {}
  const m = /"id"\s*:\s*"([^"]+)"/.exec(s) || /"name"\s*:\s*"([^"]+)"/.exec(s)
  return m ? m[1] : null
}

// ---- 历史抽稀：帧数组 → ≤maxPoints（保留首尾，均匀采样） ----
export function decimateFrames(frames, maxPoints) {
  const n = frames.length
  if (!n || maxPoints < 1) return []
  if (n <= maxPoints) return frames.slice()
  if (maxPoints === 1) return [frames[n - 1]]
  const out = []
  for (let i = 0; i < maxPoints; i += 1) out.push(frames[Math.round((i * (n - 1)) / (maxPoints - 1))])
  return out
}

// ---- 窗口内累计计数器差值（最新-最旧）；计数器回退（进程重启）或帧不足 → null ----
// frames 须按时间升序；key 支持 'a.b' 点路径
export function windowDelta(frames, key, spanMs) {
  const vals = []
  const until = frames.length ? frames[frames.length - 1].ts : 0
  for (const f of frames) {
    const v = key.split('.').reduce((o, k) => (o == null ? null : o[k]), f)
    if (typeof v === 'number' && Number.isFinite(v) && until - f.ts <= spanMs) vals.push({ ts: f.ts, v })
  }
  if (vals.length < 2) return null
  const first = vals[0]
  const last = vals[vals.length - 1]
  if (last.v < first.v) return null
  return { delta: last.v - first.v, spanMs: last.ts - first.ts }
}

// ---- 环形缓冲 ----
export class Ring {
  constructor(cap) { this.cap = cap; this.items = [] }
  push(x) { this.items.push(x); if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap); return x }
  get size() { return this.items.length }
  last(n) { return this.items.slice(-n) }
  all() { return this.items.slice() }
}

// ---- 窗口聚合 ----
export function aggregate(frames) {
  const n = frames.length
  if (n === 0) return null
  const gpuMap = new Map()
  let cpuTempSum = 0, cpuTempCnt = 0, cpuTempMax = 0
  let cpuUtilSum = 0, cpuUtilCnt = 0, cpuUtilMax = 0
  let memPctSum = 0, memPctCnt = 0, memPctMax = 0
  for (const f of frames) {
    for (const g of f.gpu || []) {
      let acc = gpuMap.get(g.idx)
      if (!acc) { acc = { idx: g.idx, n: 0, tempSum: 0, tempMax: 0, utilSum: 0, utilMax: 0 }; gpuMap.set(g.idx, acc) }
      acc.n += 1
      if (g.tempC !== null) { acc.tempSum += g.tempC; acc.tempMax = Math.max(acc.tempMax, g.tempC) }
      if (g.utilPct !== null) { acc.utilSum += g.utilPct; acc.utilMax = Math.max(acc.utilMax, g.utilPct) }
    }
    if (f.cpuTempC !== null) { cpuTempSum += f.cpuTempC; cpuTempCnt += 1; cpuTempMax = Math.max(cpuTempMax, f.cpuTempC) }
    if (f.cpuUtilPct !== null) { cpuUtilSum += f.cpuUtilPct; cpuUtilCnt += 1; cpuUtilMax = Math.max(cpuUtilMax, f.cpuUtilPct) }
    if (f.memPct !== null) { memPctSum += f.memPct; memPctCnt += 1; memPctMax = Math.max(memPctMax, f.memPct) }
  }
  const gpu = [...gpuMap.values()].map((a) => ({
    idx: a.idx,
    tempAvg: a.n ? round1(a.tempSum / a.n) : null,
    tempMax: a.tempMax || null,
    utilAvg: a.n ? round1(a.utilSum / a.n) : null,
    utilMax: a.utilMax || null,
  }))
  const spanMs = frames[n - 1].ts - frames[0].ts
  let vLLMKVSum = 0, vLLMKVCnt = 0, vLLMKVMax = 0, vLLMRunningMax = 0
  let vllmGenSum = 0, vllmGenCnt = 0, vllmPromptSum = 0, vllmPromptCnt = 0
  let vllmTTFTSum = 0, vllmTTFTCnt = 0, vllmTPOTSum = 0, vllmTPOTCnt = 0
  for (const f of frames) {
    if (f.vllm?.alive) {
      vLLMRunningMax = Math.max(vLLMRunningMax, f.vllm.runningCount || 0)
      if (f.vllm.kvCacheUsagePct !== null) { vLLMKVSum += f.vllm.kvCacheUsagePct; vLLMKVCnt += 1; vLLMKVMax = Math.max(vLLMKVMax, f.vllm.kvCacheUsagePct) }
      if (f.vllm.genTokPerSec != null) { vllmGenSum += f.vllm.genTokPerSec; vllmGenCnt += 1 }
      if (f.vllm.promptTokPerSec != null) { vllmPromptSum += f.vllm.promptTokPerSec; vllmPromptCnt += 1 }
      if (f.vllm.ttftMs != null) { vllmTTFTSum += f.vllm.ttftMs; vllmTTFTCnt += 1 }
      if (f.vllm.tpotMs != null) { vllmTPOTSum += f.vllm.tpotMs; vllmTPOTCnt += 1 }
    }
  }
  return {
    frames: n, spanMs, gpu,
    vllmKVCacheAvg: vLLMKVCnt ? round1(vLLMKVSum / vLLMKVCnt) : null,
    vllmKVCacheMax: vLLMKVMax || null,
    vllmRunningMax: vLLMRunningMax || null,
    vllmGenTokPerSecAvg: vllmGenCnt ? round1(vllmGenSum / vllmGenCnt) : null,
    vllmPromptTokPerSecAvg: vllmPromptCnt ? round1(vllmPromptSum / vllmPromptCnt) : null,
    vllmTTFTAvgMs: vllmTTFTCnt ? Math.round(vllmTTFTSum / vllmTTFTCnt) : null,
    vllmTPOTAvgMs: vllmTPOTCnt ? Math.round(vllmTPOTSum / vllmTPOTCnt) : null,
    cpuTempAvg: cpuTempCnt ? round1(cpuTempSum / cpuTempCnt) : null,
    cpuTempMax: cpuTempMax || null,
    cpuUtilAvg: cpuUtilCnt ? round1(cpuUtilSum / cpuUtilCnt) : null,
    cpuUtilMax: cpuUtilMax || null,
    memPctAvg: memPctCnt ? round1(memPctSum / memPctCnt) : null,
    memPctMax: memPctMax || null,
  }
}

// ---- 阈值默认值（单一真源：core 构造函数与 index.js applyConfig 共用） ----
export const DEFAULT_THRESHOLDS = {
  gpuTempWarn: 82, gpuTempDanger: 90,
  cpuTempWarn: 70, cpuTempDanger: 85,
  memPctWarn: 70, memPctDanger: 85,
  gpuUtilWarn: 70, gpuUtilDanger: 90, gpuUtilHighFrames: 5,
  vramWarn: 70, vramDanger: 90,
  vllmKVWarn: 70, vllmKVDanger: 90, vllmWaitingWarn: 8,
  mtpOk: 70, mtpWarnMin: 50,
}

// ---- 事件引擎 + 状态 ----
export class MonitorCore {
  constructor(cfg = {}) {
    this.th = {
      ...DEFAULT_THRESHOLDS,
      ...(cfg.thresholds || {}),
    }
    this.maxSamples = cfg.maxSamples || 28800
    this.maxEvents = cfg.maxEvents || 200
    this.offlineMs = cfg.offlineMs ?? (cfg.intervalMs || 3000) * 4
    this.host = cfg.host || null
    this.history = new Ring(this.maxSamples)
    this.events = []
    this.samples = 0
    this.startedAt = Date.now()
    this.lastAt = 0
    this.connected = false
    this.linkNote = ""
    this.currentHost = null
    this.prevCpu = null
    this.alerts = new Map()
    this.gpuUtilStreak = new Map()
    this.lastLinkDownAt = 0
    this.vllmMissed = 0
    this.vllmWasAlive = null
    this.vllmModelName = null
    this.cpuModel = null
    this.prevVllmGen = null
    this.prevVllmPrompt = null
    this.prevVllmAt = 0
    this.prevSpec = null      // MTP 累计计数基准 { d, a }（draft/accepted）
    this.specWindow = []      // MTP 60s 窗口 Δ 条目 { dd, da, ts }
    this.prevNet = null       // /proc/net/dev 计数基准 { iface: { rx, tx } }
    this.prevNetAt = 0        // 网络计数上一帧时刻
    this.lastProbe = null     // 最近一次探针实测 { ttftMs, tpotMs, genTps, promptTps, at }
    this.probeIntervalMs = cfg.probeIntervalMs ?? 60000
    this.lastSwap = null      // 最近一帧的推理入口状态 { up, state, armId, armPort, loadingArm }（0.10.0 swap 感知）
  }

  /** 保存最近一次探针实测值（index.js 触发 probeInfer 成功后调用；null/非法值忽略） */
  applyProbe(r) {
    if (r && typeof r === "object" && typeof r.at === "number") this.lastProbe = r
  }

  pushEvent(type, level, msg, data) {
    const now = Date.now()
    this.events.push({ at: now, type, level, msg, ...(data !== undefined ? { data } : {}) })
    if (this.events.length > this.maxEvents) this.events.shift()
  }

  setAlert(key, label, level, msg) {
    const prev = this.alerts.get(key)
    if (prev && prev.level === level) return
    this.alerts.set(key, { label, level, since: Date.now(), msg })
    this.pushEvent("alert_" + key, level === "danger" ? "danger" : "warn",
      (level === "danger" ? "⚠️ 危险 " : "⚠ 预警 ") + label + "：" + msg)
  }

  clearAlert(key, reason) {
    const prev = this.alerts.get(key)
    if (!prev) return
    this.alerts.delete(key)
    this.pushEvent("recover_" + key, "info", "✔ 恢复 " + prev.label + "：" + reason)
  }

  /** 设置主机标识（自动跟随远端 hostname；变化时记事件） */
  setHost(h) {
    const v = String(h || "").trim()
    if (!v || v === this.host) return
    const prev = this.host
    this.host = v
    this.pushEvent("host_name", "info", "🏷 主机标识：" + v + (prev && prev !== "unknown" ? "（原 " + prev + "）" : ""))
  }

  /** 低频设置模型名（开启采集/切换频率/切换主机时由 index.js 调用）；与 ingest 里的模型名变化逻辑共用 */
  setModelName(name) {
    if (name && name !== this.vllmModelName) {
      const prev = this.vllmModelName
      this.vllmModelName = name
      this.pushEvent("vllm_model", "info", "🤖 vLLM 模型：" + name + (prev ? "（原 " + prev + "）" : ""))
    }
  }

  /** 链路状态变化（连接/断开事件，断开节流 10s） */
  noteLink(up, msg) {
    const now = Date.now()
    this.connected = up
    this.linkNote = msg || ""
    if (up) {
      this.pushEvent("link_up", "info", "🔗 已连接 " + msg)
    } else {
      if (now - this.lastLinkDownAt < 10000) return
      this.lastLinkDownAt = now
      this.pushEvent("link_down", "warn", "⛔ 连接断开 " + msg)
    }
  }

  /** 关闭采集时重置监控数据：清空历史/最新帧/告警/速率基准/模型名，小窗不再显示旧数据 */
  reset() {
    this.history = new Ring(this.maxSamples)
    this.samples = 0
    this.startedAt = Date.now()
    this.lastAt = 0
    this.connected = false
    this.linkNote = ""
    this.prevCpu = null
    this.alerts = new Map()
    this.gpuUtilStreak = new Map()
    this.lastLinkDownAt = 0
    this.vllmMissed = 0
    this.vllmWasAlive = null
    this.vllmModelName = null
    this.cpuModel = null
    this.prevVllmGen = null
    this.prevVllmPrompt = null
    this.prevVllmAt = 0
    this.prevSpec = null
    this.specWindow = []
    this.prevNet = null
    this.prevNetAt = 0
    this.lastProbe = null
    this.lastSwap = null
  }

  /** 采集周期入口；cpuStat 为 /proc/stat 原始 cpu 行（差值算使用率），或直接给 cpuUtilPct
   *  swap：推理入口状态 { up, state, armId, armPort, loadingArm }（0.10.0；非 swap/模拟模式下为 null）
   *  tsOverride 仅供自测注入确定帧时刻（生产路径传 Date.now() 等价） */
  ingest({ host, gpu = [], cpuStat = null, cpuUtilPct = null, cpuTempC = null, mem, vllm = null, vllmModelName = null, cpuModel = null, netDev = null, swap = null }, tsOverride = null) {
    const ts = tsOverride ?? Date.now()
    const util = cpuUtilPct !== null ? cpuUtilPct : cpuUtilPercent(this.prevCpu, cpuStat)
    if (cpuStat) this.prevCpu = cpuStat
    const v = vllm ?? null
    const sw = (swap && typeof swap === 'object') ? swap : null
    this.lastSwap = sw
    // token 速率（相邻两帧差值 / 时间差；vLLM 重启计数回退时置空并重置基准）
    if (v && v.alive && v.generationTokensTotal !== null) {
      const prevGen = this.prevVllmGen
      const prevPrompt = this.prevVllmPrompt
      const prevAt = this.prevVllmAt
      this.prevVllmGen = v.generationTokensTotal
      this.prevVllmPrompt = v.promptTokensTotal
      this.prevVllmAt = ts
      if (prevGen !== null && prevAt > 0 && ts > prevAt) {
        const dt = (ts - prevAt) / 1000
        const dg = v.generationTokensTotal - prevGen
        if (dt > 0 && dg >= 0) v.genTokPerSec = round1(dg / dt)
        const dp = v.promptTokensTotal !== null && prevPrompt !== null ? v.promptTokensTotal - prevPrompt : null
        if (dt > 0 && dp !== null && dp >= 0) v.promptTokPerSec = round1(dp / dt)
      }
    }
    // MTP 接受率：近 60s 滑窗 Δ（Σacc/Σdraft），替代映射层累计比值——
    // 空闲（无新增 draft tokens）→ null（前端显示「—」），不再冻结在固定累计值上；
    // 计数回退（推理进程重启）→ 重置基准与窗口
    if (v && v.alive) {
      const d = v.specDraftTokens, a = v.specAcceptedTokens
      if (typeof d === 'number' && typeof a === 'number') {
        const base = this.prevSpec
        if (base === null || d < base.d || a < base.a) {
          this.prevSpec = { d, a }
          this.specWindow = []
          v.specAcceptRate = null
        } else {
          const dd = d - base.d, da = a - base.a
          this.prevSpec = { d, a }
          if (dd > 0 || da > 0) {
            this.specWindow.push({ dd, da, ts })
            while (this.specWindow.length && ts - this.specWindow[0].ts > 60000) this.specWindow.shift()
            let sdd = 0, sda = 0
            for (const e of this.specWindow) { sdd += e.dd; sda += e.da }
            v.specAcceptRate = sdd > 0 ? Math.round((sda / sdd) * 10000) / 100 : null
          } else {
            v.specAcceptRate = null
          }
        }
      } else {
        this.prevSpec = null
        this.specWindow = []
      }
    }
    // llama.cpp（llama.cpp-new）速率/时延：探针实测值覆写——
    // 该 build 的 /metrics 计数器只在请求结束批量更新（旧"3s 差值"大部分帧为 0），
    // predicted_tokens_seconds gauge 恒 ≈0，且没有 TTFT 指标；
    // 改由 index.js 周期发小请求读服务端自计时 timings（见 probe.js），有新鲜实测值时覆写四字段
    if (v && v.alive && v.engine === "llama" && this.lastProbe) {
      const age = ts - this.lastProbe.at
      if (age >= 0 && age <= Math.max(3 * this.probeIntervalMs, 180000)) {
        if (this.lastProbe.ttftMs !== null) v.ttftMs = this.lastProbe.ttftMs
        if (this.lastProbe.tpotMs !== null) v.tpotMs = this.lastProbe.tpotMs
        if (this.lastProbe.genTps !== null) v.genTokPerSec = round1(this.lastProbe.genTps)
        if (this.lastProbe.promptTps !== null) v.promptTokPerSec = round1(this.lastProbe.promptTps)
      }
    }
    // 模型名变化事件（自动读取优先；读不到时由上层传手动兜底值）
    if (vllmModelName && vllmModelName !== this.vllmModelName) {
      const prev = this.vllmModelName
      this.vllmModelName = vllmModelName
      this.pushEvent("vllm_model", "info", "🤖 vLLM 模型：" + vllmModelName + (prev ? "（原 " + prev + "）" : ""))
    }
    // CPU 型号变化事件（自动识别 /proc/cpuinfo model name；换 CPU 后自动更新，无需改插件）
    if (cpuModel && cpuModel !== this.cpuModel) {
      const prev = this.cpuModel
      this.cpuModel = cpuModel
      this.pushEvent("cpu_model", "info", "🖥 CPU：" + cpuModel + (prev ? "（原 " + prev + "）" : ""))
    }
    // 网速：/proc/net/dev 相邻帧差值（整机物理网口合计，lo 除外）；某口计数回退（重置）跳过该口
    let net = null
    if (netDev && Object.keys(netDev).length > 0) {
      const prevNet = this.prevNet
      const prevNetAt = this.prevNetAt
      this.prevNet = netDev
      this.prevNetAt = ts
      if (prevNet && prevNetAt > 0 && ts > prevNetAt) {
        const dt = (ts - prevNetAt) / 1000
        let upB = 0, downB = 0
        const parts = {}
        let any = false
        for (const [iface, c] of Object.entries(netDev)) {
          if (iface === "lo") continue
          const p = prevNet[iface]
          if (!p) continue
          const du = c.tx - p.tx
          const dd = c.rx - p.rx
          if (du < 0 || dd < 0) continue
          if (du > 0 || dd > 0) any = true
          upB += du
          downB += dd
          parts[iface] = { upBps: round1(du / dt), downBps: round1(dd / dt) }
        }
        if (any && dt > 0) {
          net = { upBps: round1(upB / dt), downBps: round1(downB / dt), ifname: Object.keys(parts).join("+") || "all", parts }
        }
      }
    }
    const frame = {
      ts,
      host: host || this.host || "unknown",
      gpu,
      cpuTempC: numOrNull(cpuTempC),
      cpuUtilPct: util,
      memUsedMB: mem?.usedMB ?? null,
      memTotalMB: mem?.totalMB ?? null,
      memPct: mem?.pct ?? null,
      vllm: v,
      swap: sw,
      net,
    }
    this.history.push(frame)
    this.samples += 1
    this.lastAt = ts
    this.currentHost = host || this.currentHost
    this.connected = true
    this.detectEvents(frame)
    return frame
  }

  detectEvents(f) {
    const th = this.th
    for (const g of f.gpu || []) {
      const key = "gpu_temp_" + g.idx
      if (g.tempC !== null && g.tempC >= th.gpuTempDanger) {
        this.setAlert(key, "GPU" + g.idx + " 温度", "danger", g.tempC + "℃（≥" + th.gpuTempDanger + "）")
      } else if (g.tempC !== null && g.tempC >= th.gpuTempWarn) {
        this.setAlert(key, "GPU" + g.idx + " 温度", "warn", g.tempC + "℃（≥" + th.gpuTempWarn + "）")
      } else if (g.tempC !== null) {
        this.clearAlert(key, g.tempC + "℃ 回落")
      }
      const utilKey = "gpu_util_" + g.idx
      if (g.utilPct !== null && g.utilPct >= th.gpuUtilWarn) {
        const s = (this.gpuUtilStreak.get(g.idx) || 0) + 1
        this.gpuUtilStreak.set(g.idx, s)
        if (s >= th.gpuUtilHighFrames) {
          const danger = g.utilPct >= th.gpuUtilDanger
          this.setAlert(utilKey, "GPU" + g.idx + " 使用率", danger ? "danger" : "warn", "连续 " + s + " 帧 " + (danger ? "≥" + th.gpuUtilDanger + "%" : "≥" + th.gpuUtilWarn + "%"))
        }
      } else {
        this.gpuUtilStreak.delete(g.idx)
        this.clearAlert(utilKey, "使用率回落")
      }
    }
    if (f.cpuTempC !== null) {
      if (f.cpuTempC >= th.cpuTempDanger) this.setAlert("cpu_temp", "CPU 温度", "danger", f.cpuTempC + "℃（≥" + th.cpuTempDanger + "）")
      else if (f.cpuTempC >= th.cpuTempWarn) this.setAlert("cpu_temp", "CPU 温度", "warn", f.cpuTempC + "℃（≥" + th.cpuTempWarn + "）")
      else this.clearAlert("cpu_temp", f.cpuTempC + "℃ 回落")
    }
    if (f.memPct !== null) {
      if (f.memPct >= th.memPctDanger) this.setAlert("mem", "内存使用率", "danger", f.memPct + "%（≥" + th.memPctDanger + "）")
      else if (f.memPct >= th.memPctWarn) this.setAlert("mem", "内存使用率", "warn", f.memPct + "%（≥" + th.memPctWarn + "）")
      else this.clearAlert("mem", f.memPct + "% 回落")
    }
    // vLLM 三指标告警 + 存活跳变（0.10.0：swap 感知三分支）
    const sw = f.swap || null
    if (f.vllm && f.vllm.alive) {
      this.vllmMissed = 0
      if (this.vllmWasAlive === false) {
        this.pushEvent("vllm_start", "info", "🟢 vLLM 恢复运行" + (sw && sw.state === 'armed' && sw.armId ? "（" + sw.armId + " 就绪）" : ""))
      }
      this.vllmWasAlive = true
      const kv = f.vllm.kvCacheUsagePct
      if (kv !== null) {
        if (kv >= th.vllmKVDanger) this.setAlert("vllm_kv", "vLLM KV 缓存", "danger", kv + "%（≥" + th.vllmKVDanger + "）")
        else if (kv >= th.vllmKVWarn) this.setAlert("vllm_kv", "vLLM KV 缓存", "warn", kv + "%（≥" + th.vllmKVWarn + "）")
        else this.clearAlert("vllm_kv", kv + "% 回落")
      }
      const w = f.vllm.waitingCount
      if (w !== null) {
        if (w >= (th.vllmWaitingWarn || 8)) {
          const s = (this.gpuUtilStreak.get("vllm_wait") || 0) + 1
          this.gpuUtilStreak.set("vllm_wait", s)
          if (s >= 3) this.setAlert("vllm_queue", "vLLM 请求队列", "warn", w + " 个请求排队（≥" + (th.vllmWaitingWarn || 8) + "）")
        } else {
          this.gpuUtilStreak.delete("vllm_wait")
          this.clearAlert("vllm_queue", "队列释放")
        }
      }
    } else if (sw && sw.up === true && (sw.state === 'idle' || sw.state === 'loading')) {
      // swap 活着但无 ready 臂：正常形态（ttl 到期闲置释放 / 换臂加载中）——
      // 不累计"服务消失"告警，仅 armed→idle 跳变时发中性 info
      if (this.vllmWasAlive === true) {
        if (sw.state === 'loading' && sw.loadingArm) {
          this.pushEvent("vllm_swapping", "info", "🔁 换臂中：" + sw.loadingArm + " 正在加载（旧臂已释放，新臂就绪需要几分钟）")
        } else {
          this.pushEvent("vllm_idle", "info", "💤 模型未装载：无臂在运行（闲置自动释放，属正常；有请求进来会自动拉起）")
        }
      }
      this.vllmMissed = 0
      this.vllmWasAlive = false
      this.clearAlert("vllm_kv", "无臂运行清空")
      this.clearAlert("vllm_queue", "无臂运行清空")
    } else {
      this.vllmMissed += 1
      // 恰好第 2 次离线时 fire 一次 vllm_stop（此时 wasAlive 仍为 true，避免下次提前置 false 漏判）
      if (this.vllmMissed === 2 && this.vllmWasAlive === true) {
        const entryDown = !sw || sw.up === false
        this.pushEvent("vllm_stop", "warn", entryDown
          ? "🔶 推理入口失联：:8000 无 /running 与 /metrics 响应"
          : "🔶 推理服务消失：连续 2 帧无 /metrics 响应")
      }
      // 第 2 次及以后才把 wasAlive 置 false，保证 stop 判定窗口正常
      if (this.vllmMissed >= 2) this.vllmWasAlive = false
      this.clearAlert("vllm_kv", "vLLM 离线清空")
      this.clearAlert("vllm_queue", "vLLM 离线清空")
    }
  }

  /** 当前状态视图（最新帧 + 告警 + 健康度） */
  state() {
    const now = Date.now()
    const latest = this.history.last(1)[0] ?? null
    const connected = this.connected && latest !== null && (now - this.lastAt <= this.offlineMs)
    const alerts = [...this.alerts.entries()].map(([k, a]) => ({ key: k, ...a }))
    const health = alerts.some((a) => a.level === "danger") ? "danger"
      : alerts.some((a) => a.level === "warn") ? "warn"
      : connected ? "ok" : "offline"
    return {
      host: this.host,
      currentHost: this.currentHost,
      connected,
      linkNote: this.linkNote,
      lastAt: this.lastAt,
      samples: this.samples,
      startedAt: this.startedAt,
      latest,
      vllmModelName: this.vllmModelName,
      cpuModel: this.cpuModel,
      swap: this.lastSwap,
      probeAt: this.lastProbe && typeof this.lastProbe.at === "number" ? this.lastProbe.at : null,
      alerts,
      health,
    }
  }

  summary(minutes = 5) {
    const until = Date.now()
    const frames = this.history.all().filter((f) => until - f.ts <= minutes * 60000)
    return aggregate(frames)
  }

  /** 最近 spanMs 内历史帧 + 抽稀到 maxPoints（前端 sparkline 用） */
  historyFrames(spanMs, maxPoints) {
    const until = this.lastAt || Date.now()
    const win = this.history.all().filter((f) => until - f.ts <= spanMs)
    return decimateFrames(win, maxPoints)
  }

  recentEvents(n = 20) { return this.events.slice(-Math.min(n, this.maxEvents)) }
}