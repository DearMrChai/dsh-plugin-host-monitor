// lib/index.js — dsh-plugin-host-monitor 主机侧（cordis entry）
// 双路取数：SSH 持久拉取 142（infer-142）硬件指标（GPU×2/CPU/内存）
//          + 宿主机直连 HTTP 拉取推理服务 /metrics + /v1/models（vLLM 或 llama.cpp）
// → 环形历史 + 阈值告警 → tools + /monitor/api + 设置卡（IP 下拉）
// 142 零部署：只被动响应 sshd，本机持一条持久 SSH 通道（重连退避）
// cordis 铁律：patch 行必须写 inject: [settings, tools]，否则服务永不注入
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MonitorCore, parseCollectOutput, windowDelta, DEFAULT_THRESHOLDS } from './core.js'
import { SshCollector, buildCollectCmd } from './ssh.js'
import { fetchInference } from './http-metrics.js'
import { probeInfer } from './probe.js'

export const name = 'host-monitor'
export const inject = ['settings', 'tools']

const NS_KEY = 'host-monitor'
const HOSTS = ['192.168.31.142', '10.226.127.71']
export const HOST_LABEL = { '192.168.31.142': '局域网', '10.226.127.71': 'ZeroTier' }
const hostLabel = (h) => HOST_LABEL[h] || h

export const Config = z.object({
  enabled: z.boolean().default(true),
  simulate: z.boolean().default(false),
  // 小窗模块显示勾选（设置卡可调；收起态三槽同步遵循）
  showGpu: z.boolean().default(true),
  showVllm: z.boolean().default(true),
  showCpu: z.boolean().default(true),
  host: z.union(HOSTS.map((h) => z.const(h))).default('192.168.31.142'),
  sshPort: z.natural().default(22),
  sshUser: z.string().default(''),   // SSH 凭据不内置默认值：设置卡填写或 cordis.patch.yml config 提供
  sshPass: z.string().default(''),   // 同上；凭据仅存本机 DSH 设置文件，代码/仓库不含真实凭据
  intervalMs: z.natural().max(60000).default(0),   // 0 = 默认关闭（需手动开启），1000~60000 为采集频率
  maxSamples: z.natural().default(28800),
  maxEvents: z.natural().default(200),
  offlineMsFactor: z.number().default(4),
  // 推理入口（0.10.0）：llama-swap 统一入口（:8000）或 vLLM/llama.cpp 直连地址的 base URL
  // （{host} 占位=当前所选目标 IP，宿主机直连 HTTP）。swap 在时自动换臂端口取数；非 swap 时当直连后端。
  vllmBaseUrl: z.string().default('http://{host}:8000'),
  vllmModelName: z.string().default(''),   // 手动兜底模型名；留空 = 不兜底（离线时模型名显示空）
  // llama.cpp（llama.cpp-new）速率/时延探针间隔：每 intervalMs 发 64-token 小请求读服务端 timings；0=关
  probeIntervalMs: z.natural().max(3600000).default(60000),
  thresholds: z.object({
    gpuTempWarn: z.number().default(82),
    gpuTempDanger: z.number().default(90),
    cpuTempWarn: z.number().default(70),
    cpuTempDanger: z.number().default(85),
    memPctWarn: z.number().default(70),
    memPctDanger: z.number().default(85),
    gpuUtilWarn: z.number().default(70),
    gpuUtilDanger: z.number().default(90),
    gpuUtilHighFrames: z.natural().default(5),
    vramWarn: z.number().default(70),
    vramDanger: z.number().default(90),
    // vLLM: KV 空间使用率预警线 / 请求排队预警线（个）/ MTP 接受率（高=好）
    vllmKVWarn: z.number().default(70),
    vllmKVDanger: z.number().default(90),
    vllmWaitingWarn: z.natural().default(8),
    mtpOk: z.number().default(70),
    mtpWarnMin: z.number().default(50),
  }).default({}),
})

// ===== 输出 schema（oneOf([null, type]) 表示可空字段，AC 同款约定） =====
const nullableNum = { oneOf: [{ type: 'null' }, { type: 'number' }] }
const gpuItemSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    idx: { type: 'integer' }, name: { type: 'string' },
    tempC: nullableNum, utilPct: nullableNum,
    memUsedMB: nullableNum, memTotalMB: nullableNum,
  },
}
// 推理入口状态（0.10.0 llama-swap 感知）：state=armed(臂在跑)/idle(无臂装载,正常)/loading(换臂中)/direct(非 swap 直连)/down(入口失联)
const swapSchema = {
  oneOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false,
    properties: {
      up: { type: 'boolean' },
      state: { type: 'string', enum: ['armed', 'idle', 'loading', 'direct', 'down'] },
      armId: { oneOf: [{ type: 'null' }, { type: 'string' }] },
      armPort: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
      loadingArm: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    },
    required: ['up', 'state'],
  }],
}
const frameSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ts: { type: 'integer' }, host: { type: 'string' },
    gpu: { type: 'array', items: gpuItemSchema },
    cpuTempC: nullableNum, cpuUtilPct: nullableNum,
    memUsedMB: nullableNum, memTotalMB: nullableNum, memPct: nullableNum,
    vllm: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { runningCount: nullableNum, waitingCount: nullableNum, swappedCount: nullableNum, kvCacheUsagePct: nullableNum, gpuCacheUsagePct: nullableNum, generationTokensTotal: nullableNum, promptTokensTotal: nullableNum, numPreempted: nullableNum, ttftMs: nullableNum, tpotMs: nullableNum, e2eLatencyMs: nullableNum, genTokPerSec: nullableNum, promptTokPerSec: nullableNum, specDraftTokens: nullableNum, specAcceptedTokens: nullableNum, specAcceptRate: nullableNum, engine: { oneOf: [{ type: 'null' }, { type: 'string', enum: ['vllm', 'llama'] }] }, alive: { type: 'boolean' } } }] },
    swap: swapSchema,
    net: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { upBps: nullableNum, downBps: nullableNum, ifname: { type: 'string' }, parts: { type: 'object', additionalProperties: true } } }] },
  },
}
const alertSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    level: { type: 'string', enum: ['warn', 'danger'] },
    since: { type: 'integer' }, msg: { type: 'string' },
  },
}
const stateSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    host: { type: 'string' },
    currentHost: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    connected: { type: 'boolean' }, linkNote: { type: 'string' },
    lastAt: { type: 'integer' }, samples: { type: 'integer' }, startedAt: { type: 'integer' },
    latest: { oneOf: [{ type: 'null' }, frameSchema] },
    vllmModelName: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    cpuModel: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    swap: swapSchema,
    probeAt: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
    alerts: { type: 'array', items: alertSchema },
    health: { type: 'string', enum: ['ok', 'warn', 'danger', 'offline'] },
  },
}
const summarySchema = {
  oneOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false,
    properties: {
      frames: { type: 'integer' }, spanMs: { type: 'integer' },
      gpu: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          idx: { type: 'integer' },
          tempAvg: nullableNum, tempMax: nullableNum,
          utilAvg: nullableNum, utilMax: nullableNum,
        },
      } },
      cpuTempAvg: nullableNum, cpuTempMax: nullableNum,
      cpuUtilAvg: nullableNum, cpuUtilMax: nullableNum,
      memPctAvg: nullableNum, memPctMax: nullableNum,
      vllmKVCacheAvg: nullableNum, vllmKVCacheMax: nullableNum, vllmRunningMax: nullableNum,
      vllmGenTokPerSecAvg: nullableNum, vllmPromptTokPerSecAvg: nullableNum,
      vllmTTFTAvgMs: nullableNum, vllmTPOTAvgMs: nullableNum,
    },
  }],
}
const eventSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    at: { type: 'integer' }, type: { type: 'string' },
    level: { type: 'string', enum: ['info', 'warn', 'danger'] },
    msg: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
  },
}

function defineTools(core) {
  return [
    defineTool({
      name: 'host_monitor_state',
      description: '获取远程服务器最新监控帧与连接状态：GPU×2 温度/使用率/显存、CPU 温度/使用率、内存使用率、推理服务（运行/排队/抢占请求、KV/GPU 缓存、tokens 速率、TTFT/TPOT 时延、模型名、llama-swap 入口状态 armed/idle/loading/direct/down 与当前臂）、网络上传/下载速度、当前告警',
      parameters: {},
      output: { schema: stateSchema, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async () => core.state(),
    }),
    defineTool({
      name: 'host_monitor_summary',
      description: '获取最近 N 分钟聚合摘要（GPU/CPU/内存均值与峰值、vLLM tokens 速率与时延均值，趋势查看）',
      parameters: { minutes: { type: 'integer', description: '分钟窗口，默认 5' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { summary: summarySchema } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async (args) => ({ summary: core.summary(args?.minutes || 5) }),
    }),
    defineTool({
      name: 'host_monitor_events',
      description: '获取最近事件批次（GPU/CPU 温度预警与危险、内存高、GPU 使用率持续高位、vLLM 存活/模型变化、连接断开/恢复）',
      parameters: { n: { type: 'integer', description: '条数，默认 20' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { events: { type: 'array', items: eventSchema } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async (args) => ({ events: core.recentEvents(args?.n || 20) }),
    }),
  ]
}

let instance = null
export function apply(ctx, config) {
  if (instance) instance.dispose()
  instance = createInstance(ctx, config)
  ctx.logger?.info?.('[host-monitor] 已挂载：host=' + config.host + ' simulate=' + !!config.simulate + ' interval=' + (config.intervalMs ?? 3000) + 'ms')
}

function createInstance(ctx, config) {
  const cfg = {
    enabled: config.enabled !== false,
    simulate: config.simulate === true,
    showGpu: config.showGpu !== false,
    showVllm: config.showVllm !== false,
    showCpu: config.showCpu !== false,
    host: config.host || '192.168.31.142',
    sshPort: config.sshPort || 22,
    sshUser: config.sshUser || '',
    sshPass: config.sshPass || '',
    intervalMs: config.intervalMs ?? 3000,   // ?? 而非 ||：0（关闭）不能被兜底成 3000
    maxSamples: config.maxSamples || 28800,
    maxEvents: config.maxEvents || 200,
    offlineMsFactor: config.offlineMsFactor || 4,
    vllmBaseUrl: config.vllmBaseUrl || 'http://{host}:8000',
    vllmModelName: config.vllmModelName || '',
    probeIntervalMs: config.probeIntervalMs ?? 60000,
    thresholds: config.thresholds || {},
  }
  const core = new MonitorCore({
    maxSamples: cfg.maxSamples, maxEvents: cfg.maxEvents,
    intervalMs: cfg.intervalMs, thresholds: cfg.thresholds,
    host: hostLabel(cfg.host),
    probeIntervalMs: cfg.probeIntervalMs,
  })
  const coll = new SshCollector({ onStatus: () => {} })
  // 主机标识自动跟随远端 hostname（接通即取；远端改名后自动更新，无需改插件）
  coll.onHostname = (h) => { if (h) core.setHost(h) }
  let prevLink = null
  let disposed = false
  let timer = null
  let simTick = 0
  let probeInFlight = false
  let lastProbeAt = 0
  let modelNameInFlight = false

  const statusOnChange = (s) => {
    if (prevLink === s.connected) return
    prevLink = s.connected
    if (disposed) return
    core.noteLink(s.connected,
      s.connected ? ('已连接 ' + (s.host || cfg.host) + '（' + hostLabel(cfg.host) + '）')
        : ('SSH：' + (s.lastError || '连接断开') + '，自动重连退避 ' + s.retryDelay + 'ms'))
  }
  coll.onStatus = statusOnChange

  const poll = async () => {
    if (disposed) return
    if (cfg.simulate) { simulateTick(); return }
    if (!coll.connected) return
    // 双路并行取数：SSH 出硬件帧（GPU/CPU/内存）；宿主机直连 HTTP 出推理指标
    // （vllmBaseUrl 可配置，{host} 占位符替换为当前所选目标 IP，跟随 ZeroTier/局域网切换）
    const vllmBase = String(cfg.vllmBaseUrl || 'http://{host}:8000').replace('{host}', cfg.host || '')
    const [sshRes, httpRes] = await Promise.allSettled([
      coll.exec(buildCollectCmd()),
      fetchInference(vllmBase, 5000),   // 0.10.0：swap 感知三分支（臂端口/直连/失联）；模型名跟本次取数一起取
    ])
    if (disposed) return
    if (sshRes.status !== 'fulfilled') {
      core.noteLink(false, '取数失败：' + (sshRes.reason?.message || sshRes.reason))
      return
    }
    const p = parseCollectOutput(sshRes.value)
    const hm = httpRes.status === 'fulfilled' ? httpRes.value : null
    const vllm = hm?.vllm ?? null
    const swap = hm?.swap ?? null
    const modelName = applyModelName(hm)   // 模型名跟取数同频；无臂装载/换臂中 → 清空（不留上次的模型）
    core.ingest({ host: hostLabel(cfg.host), gpu: p.gpu, cpuStat: p.cpuStat, cpuModel: p.cpuModel, cpuTempC: p.cpuTempC, mem: p.mem, vllm, vllmModelName: modelName, netDev: p.netDev, swap })
    // 探针：llama.cpp（llama.cpp-new）引擎时，每 probeIntervalMs 发一发小请求读服务端 timings
    // （该 build 的 /metrics 计数器只在请求结束批量更新且无 TTFT 指标，旧差值法失效；见 probe.js）
    // model 用低频更新的 core.vllmModelName（跟随换臂/开启/切频率时由 refreshInferenceName 拉取）
    const probeModel = core.vllmModelName || cfg.vllmModelName || ''
    if (vllm && vllm.alive && vllm.engine === 'llama' && cfg.probeIntervalMs > 0 && !probeInFlight) {
      if (Date.now() - lastProbeAt >= cfg.probeIntervalMs) {
        probeInFlight = true
        probeInfer(vllmBase, probeModel).then((r) => {
          if (r && !disposed) { core.applyProbe(r); lastProbeAt = r.at }
        }).catch(() => {}).finally(() => { probeInFlight = false })
      }
    }
  }

  // 模型名跟取数同频（0.10.0 简化，用户裁定）：armed/direct → 用本次取到的 served 名；
  // idle（无臂装载）/loading（换臂中）→ 清空显示，不残留上次的模型；down（入口失联）→ 保留上次名字（避免单周期抖动闪空）。
  // 返回本帧要记进 frame 的名字（'' = 无名字，core.ingest 收到空串不会清空，清空只走这里的显式调用）。
  const applyModelName = (hm) => {
    const swap = hm?.swap ?? null
    if (swap && (swap.state === 'idle' || swap.state === 'loading')) {
      core.setModelName('')
      return ''
    }
    const name = hm?.modelName || cfg.vllmModelName || ''
    if (hm?.modelName) core.setModelName(hm.modelName)
    return name
  }

  // 名字的单次刷新（开启采集/切换频率/切换主机/手动刷新时调用；周期内由 poll 同步取）
  const refreshInferenceName = async () => {
    if (modelNameInFlight || disposed) return
    modelNameInFlight = true
    try {
      const base = String(cfg.vllmBaseUrl || 'http://{host}:8000').replace('{host}', cfg.host || '')
      applyModelName(await fetchInference(base, 5000))
    } catch { /* 忽略 */ } finally { modelNameInFlight = false }
  }

  function simulateTick() {
    simTick += 1
    const n = simTick
    const drift = 6 * Math.sin(n / 18)
    const spike = n % 19 === 0
    core.ingest({
      host: '模拟',
      gpu: [
        { idx: 0, name: 'RTX 2080 Ti', tempC: spike ? 86 + (n % 3) * 2 : Math.round(52 + drift), utilPct: spike ? 97 : Math.round(34 + drift * 2) },
        { idx: 1, name: 'RTX 2080 Ti', tempC: Math.round(48 + drift), utilPct: spike ? 99 : Math.round(22 + drift) },
      ],
      cpuTempC: Math.round(45 + drift),
      cpuUtilPct: Math.round(15 + drift),
      mem: { usedMB: Math.round(7600 + Math.random() * 400), totalMB: 15872, pct: 47.9 },
      vllm: {
        runningCount: spike ? 3 : 1 + Math.floor(Math.random() * 2),
        waitingCount: spike ? 14 : Math.round(2 + 3 * Math.sin(n / 6)),
        swappedCount: 0,
        kvCacheUsagePct: spike ? 94 : Math.round(46 + 14 * Math.sin(n / 9)),
        gpuCacheUsagePct: spike ? 91 : Math.round(40 + 12 * Math.sin(n / 9)),
        generationTokensTotal: 1200000 + n * 240,
        promptTokensTotal: 600000 + n * 90,
        numPreempted: Math.floor(n / 50),
        ttftMs: spike ? 320 : 140 + Math.round(40 * Math.sin(n / 5)),
        tpotMs: spike ? 90 : 45 + Math.round(15 * Math.sin(n / 7)),
        e2eLatencyMs: spike ? 4200 : 1800 + Math.round(600 * Math.sin(n / 8)),
        alive: n % 23 > 0,
      },
      vllmModelName: cfg.vllmModelName || '',
    })
  }

  const applyConfig = (next) => {
    Object.assign(cfg, next)
    core.th = { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}) }
    core.offlineMs = cfg.intervalMs * cfg.offlineMsFactor
    core.probeIntervalMs = cfg.probeIntervalMs ?? 60000
    // SSH 需重启的场景：频率变化（开/关/换频）或 连接参数变化（host/端口/账号/密码/模拟）；
    // 仅模块显示/阈值等变化不重连、不清数据（设置卡场景）
    const sshChanged = ['host', 'sshPort', 'sshUser', 'sshPass', 'simulate'].some((k) => k in next)
    if (typeof next.intervalMs === 'number') {
      clearInterval(timer)
      if (cfg.intervalMs > 0) {
        timer = setInterval(poll, cfg.intervalMs)
      } else {
        core.reset()   // 关闭采集：清空历史/最新帧/告警，小窗不再显示旧数据
      }
    }
    if (!cfg.simulate) {
      if (typeof next.intervalMs === 'number') {
        if (cfg.intervalMs > 0) {
          coll.configure({ host: cfg.host, port: cfg.sshPort, user: cfg.sshUser, password: cfg.sshPass })
          coll.stop()
          coll.start()
          refreshInferenceName()   // 开启采集/切换频率/切换主机：低频拉一次模型名（swap 感知）
        } else {
          coll.stop()
        }
      } else if (sshChanged && cfg.intervalMs > 0) {
        coll.configure({ host: cfg.host, port: cfg.sshPort, user: cfg.sshUser, password: cfg.sshPass })
        coll.stop()
        coll.start()
        refreshInferenceName()   // 切换主机：低频拉一次模型名（swap 感知）
      }
    } else if (sshChanged || typeof next.intervalMs === 'number') {
      coll.stop()
    }
  }

  // 启动
  // 双端兼容（2026-10-03 桌面端适配）：
  // - web 0.1.x dsh-settings：有 register/watch API → 注册 namespace + 监听（设置卡保存闭环）。
  // - 桌面端 0.2.0-rc.2 dsh-settings 重构为 SettingsForms：register 已被删除（无此 API），
  //   直接调用会 TypeError → apply 抛错 → 插件整包死（/monitor/api 404、采集全空，2026-10-03 实证）。
  //   0.2.0 的 config 由 apply(ctx, config) 参数给出（profile patch 合并值）；后续变更走
  //   配置层热重载 → entry 重挂载 → apply 重跑，无需本实例监听。
  let stopWatch = null
  try {
    const settingsSvc = ctx.settings
    if (settingsSvc && typeof settingsSvc.register === 'function') {
      const scope = settingsSvc.register(NS_KEY, Config, { base: config, applies: 'live' })
      // 设置卡/外部 settings 更新（模块显示/host/intervalMs/阈值/SSH…）→ 同步实例；只把变化的字段喂给 applyConfig
      stopWatch = scope.watch((next, prev) => {
        if (disposed || !next) return
        const patch = {}
        for (const k of Object.keys(next)) {
          if (!(k in cfg) || JSON.stringify(prev?.[k]) !== JSON.stringify(next[k])) patch[k] = next[k]
        }
        if (Object.keys(patch).length) applyConfig(patch)
      })
    }
  } catch (err) {
    try { ctx.logger?.warn?.('[host-monitor] settings namespace 注册失败（不影响采集与路由）:', err) } catch { /* 忽略 */ }
  }
  if (!cfg.simulate && cfg.intervalMs > 0) {
    coll.configure({ host: cfg.host, port: cfg.sshPort, user: cfg.sshUser, password: cfg.sshPass })
    coll.start()
  }
  if (cfg.intervalMs > 0) {
    timer = setInterval(poll, cfg.intervalMs)
    poll()
  }

  // tools + 路由（ctx.effect：重载/卸载时自动注销）
  ctx.effect(() => {
    // tools 注册独立 try/catch：跨版本 tools 服务差异不允许连累同 effect 里的路由挂载（采集主链路）
    try {
      for (const t of defineTools(core)) ctx.tools?.register?.(t)
    } catch (err) {
      try { ctx.logger?.warn?.('[host-monitor] tools 注册失败（不影响采集与路由）:', err) } catch { /* 忽略 */ }
    }
    const disposers = []
    let installed = false
    const off = ctx.on('internal/service', installRoutes)
    function installRoutes() {
      if (installed) return
      const ws = ctx.get?.('webServer')
      if (!ws) return
      installed = true
      const send = (res, data) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(data))
      }
      const qnum = (req, key, fb) => {
        try {
          const u = new URL(req.url ?? '/', 'http://x')
          const r = u.searchParams.get(key)
          if (r === null || r === '') return fb
          const v = Number(r)
          return Number.isFinite(v) ? v : fb
        } catch { return fb }
      }
      const cfgSnapshot = () => ({ host: cfg.host, simulate: cfg.simulate, intervalMs: cfg.intervalMs, maxSamples: cfg.maxSamples, vllmBaseUrl: cfg.vllmBaseUrl, vllmModelName: cfg.vllmModelName, probeIntervalMs: cfg.probeIntervalMs, thresholds: cfg.thresholds, showGpu: cfg.showGpu, showVllm: cfg.showVllm, showCpu: cfg.showCpu })
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/status', handler: async (_q, res) =>
        send(res, { ok: true, cfg: cfgSnapshot(), ...core.state() }) }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/refresh', handler: async (_q, res) => {
        try {
          // 手动刷新 = 采一帧（硬件+推理）+ 补拉一次模型名。
          // 模型名平时跟随换臂/开启/切频率/切主机低频拉取（refreshInferenceName），这里补拉防止名字陈旧。
          await poll()
          await refreshInferenceName()
          send(res, { ok: true, cfg: cfgSnapshot(), ...core.state() })
        } catch (e) { send(res, { ok: false, error: String(e) }) }
      } }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/config', handler: async (req, res) => {
        try {
          const u = new URL(req.url ?? '/', 'http://x')
          const iv = u.searchParams.get('intervalMs')
          if (iv !== null && iv !== '') {
            const n = Number(iv)
            if (!Number.isFinite(n) || n > 60000 || (n !== 0 && n < 1000)) { send(res, { ok: false, error: 'intervalMs 须为 0（关闭）或 1000~60000' }); return }
            applyConfig({ intervalMs: n })
          }
          send(res, { ok: true, intervalMs: cfg.intervalMs })
        } catch (e) { send(res, { ok: false, error: String(e) }) }
      } }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/summary', handler: async (req, res) =>
        send(res, { ok: true, summary: core.summary(qnum(req, 'minutes', 5)) }) }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/events', handler: async (req, res) =>
        send(res, { ok: true, events: core.events(qnum(req, 'n', 20)) }) }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/history', handler: async (req, res) => {
        const spanMs = Math.min(Math.max(qnum(req, 'spanMs', 3600000), 60000), 86400000)
        const maxPoints = Math.min(Math.max(qnum(req, 'maxPoints', 120), 2), 240)
        const frames = core.historyFrames(spanMs, maxPoints).map((f) => ({
          ts: f.ts,
          gpu: (f.gpu || []).map((g) => ({
            idx: g.idx, utilPct: g.utilPct, tempC: g.tempC,
            memPct: g.memTotalMB > 0 ? Math.round(((g.memUsedMB ?? 0) / g.memTotalMB) * 100) : null,
          })),
          cpuUtilPct: f.cpuUtilPct, cpuTempC: f.cpuTempC, memPct: f.memPct,
          vllmGen: f.vllm?.genTokPerSec ?? null,
          vllmPrompt: f.vllm?.promptTokPerSec ?? null,
          vllmRunning: f.vllm?.runningCount ?? null,
          vllmWaiting: f.vllm?.waitingCount ?? null,
          vllmGenTotal: f.vllm?.generationTokensTotal ?? null,
          vllmPromptTotal: f.vllm?.promptTokensTotal ?? null,
        }))
        send(res, {
          ok: true, spanMs, frames,
          winGen: windowDelta(frames, 'vllmGenTotal', 3600000) || null,
          winPrompt: windowDelta(frames, 'vllmPromptTotal', 3600000) || null,
        })
      } }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/host', handler: async (req, res) => {
        try {
          const u = new URL(req.url ?? '/', 'http://x')
          const h = u.searchParams.get('host')
          if (!HOSTS.includes(h || '')) { send(res, { ok: false, error: 'host 必须是 ' + HOSTS.join(' / ') }); return }
          applyConfig({ host: h })
          send(res, { ok: true, host: h })
        } catch (e) { send(res, { ok: false, error: String(e) }) }
      } }))
      disposers.push(ws.register({ kind: 'exact', path: '/monitor/api/reconnect', handler: async (_q, res) => {
        if (!cfg.simulate) { coll.stop(); coll.start() }
        send(res, { ok: true })
      } }))
      console.log('[host-monitor] 路由已挂载：/monitor/api/{status,summary,events,history,host,reconnect,refresh}')
    }
    installRoutes()
    return () => {
      try { off?.() } catch {}
      disposers.splice(0).forEach((d) => { try { d() } catch {} })
    }
  })

  return {
    dispose() {
      disposed = true
      try { stopWatch?.() } catch {}
      clearInterval(timer)
      coll.stop()
    },
    applyConfig,
  }
}