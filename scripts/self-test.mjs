// scripts/self-test.mjs — 纯逻辑自测（无需 SSH/142）
// [0] 冒烟：真实求值 lib/index.js 模块顶层 + Config 断言——cordis 的 Config 定义在模块顶层，
//     z.number().int() 这类宿主 API 失配只在模块求值/装载时暴露（原 0.7.0 启动崩溃的根因），在这里提前拦截。
//     宿主依赖映射（自测环境免装包）：schemastery/dsh-tools 经 registerHooks 解析到 DSH 安装真身；
//     **ssh2 故意不 hook**——它必须真实装在本包 node_modules（桌面端 link: 装载时 DSH 只从插件自己的
//     node_modules 解析运行时依赖；缺失 = 插件列表「did not activate … failed to import」+ 小窗整块消失，
//     2026-10-05 实际踩过）。跑自测前先 `npm install`（依赖见 package.json）。
import { registerHooks, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const winUrl = (p) => 'file:///' + p.replaceAll('\\', '/')
registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') return { url: winUrl('D:/DevEnv/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs'), shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-tools') return { url: new URL('./shims/dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
    // ssh2 走 Node 原生解析：命中本包 node_modules/ssh2（装不上就会在 [0] 冒烟里明确报错——这是故意的）
    return nextResolve(specifier, _context)
  },
})

import {
  parseGpuOutput, parseCpuLine, cpuUtilPercent, parseMemOutput,
  parseTempInput, parseCollectOutput, parseModelsOutput, MonitorCore,
  decimateFrames, windowDelta, parseNetDev, parseIpAddr,
} from '../lib/core.js'
import { parsePrometheusText, mapInferenceMetrics, fetchInference, armUrlFromProxy } from '../lib/http-metrics.js'
import { probeInfer } from '../lib/probe.js'

// 注：index.js 必须动态 import（放在 registerHooks 之后求值）；静态 import 因 hoist 会先于映射注册执行。

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✔', name) }
  else { fail += 1; console.error('  ✘', name, '|', detail ?? '') }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

console.log('[0] 依赖预检：本包 node_modules 必须自带运行时依赖（桌面端 link: 装载只认插件真实路径）')
{
  // 2026-10-05 实测踩坑：桌面端以 junction 装载时，Node 按插件真实路径（E:\...）解析裸导入，
  // 走不到 DSH 的模块回退目录（$DSH_HOME/profiles/node_modules）——所以这三个包必须真实装在本包内。
  // 缺任意一个 → 插件列表只报 `failed to import`（真异常被 logger 吞），小窗整块消失。
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const req = createRequire(path.join(root, 'package.json'))
  for (const spec of ['ssh2', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools']) {
    let resolved = null
    try { resolved = req.resolve(spec) } catch { /* 见 ok 断言 */ }
    ok('本包 node_modules 内含 ' + spec, !!resolved,
      '修复：`npm install` + `node scripts/install-peers.mjs`（DSH 内部包从安装目录拷入）')
  }
}

console.log('[0b] 冒烟：index.js 模块装载 + Config（提前拦截宿主 API 失配/顶层语法错）')
{
  let idx = null, loadErr = null
  try { idx = await import('../lib/index.js') } catch (e) { loadErr = e?.message || String(e) }
  ok('index.js 模块顶层求值成功（Config 导出）', !!idx && typeof idx.Config === 'function', loadErr ?? '')
  if (idx && typeof idx.Config === 'function') {
    const C = idx.Config
    let cfg0 = null, cfgErr = null
    try { cfg0 = C({}) } catch (e) { cfgErr = e?.message || String(e) }
    ok('Config({}) 填充全默认值', !!cfg0 && cfg0.probeIntervalMs === 60000 && cfg0.intervalMs === 0 && cfg0.vllmModelName === '' && cfg0.maxSamples === 28800 && cfg0.host === '192.168.31.142' && cfg0.enabled === true && cfg0.thresholds?.gpuTempWarn === 82, cfgErr ?? JSON.stringify(cfg0))
    ok('非法值 probeIntervalMs=1.5 被拒绝（要求 natural/整数）', throws(() => C({ probeIntervalMs: 1.5 })))
    ok('非法值 probeIntervalMs>1h 被拒绝（max=3600000）', throws(() => C({ probeIntervalMs: 3600001 })))
    ok('非法值 intervalMs=-5 被拒绝（min=1000）', throws(() => C({ intervalMs: -5 })))
    ok('非法 host 被拒绝（union 仅允许 142 两个 IP）', throws(() => C({ host: '8.8.8.8' })))
    ok('probeIntervalMs=0 合法（0=关）', C({ probeIntervalMs: 0 }).probeIntervalMs === 0)
  }
}

console.log('[1] 解析：GPU')
{
  const gpus = parseGpuOutput('0, GeForce RTX 2080 Ti, 62, 45, 5120, 11264\n1, GeForce RTX 2080 Ti, 58, 91, 8900, 11264\n')
  ok('两卡解析', gpus.length === 2 && gpus[0].idx === 0 && gpus[1].idx === 1)
  ok('温度/使用率/显存数值', gpus[0].tempC === 62 && gpus[0].utilPct === 45 && gpus[0].memUsedMB === 5120 && gpus[0].memTotalMB === 11264, JSON.stringify(gpus[0]))
  ok('空输入→空数组', parseGpuOutput('').length === 0)
}
console.log('[2] 解析：CPU 使用率（差值法）')
{
  const a = parseCpuLine('cpu  1000 10 20 9000 5 0 0 0 0 0 0')
  const b = parseCpuLine('cpu  1100 12 24 9088 6 0 0 0 0 0 0')
  ok('cpu 行解析', a && a.total === 10035 && a.idle === 9000, JSON.stringify(a))
  const u1 = cpuUtilPercent(a, b)
  const expect = Math.round(((1 - 88 / 195) * 100) * 10) / 10
  ok('使用率≈' + expect, u1 === expect, 'got ' + u1)
  ok('缺前值→null', cpuUtilPercent(null, b) === null)
}
console.log('[3] 解析：内存 / 温度 / 整段命令输出')
{
  const mem = parseMemOutput('MemTotal:       10000000 kB\nMemAvailable:    8000000 kB')
  ok('内存 20% 已用', mem.totalMB === 9765.6 && Math.abs(mem.pct - 20) < 0.1, JSON.stringify(mem))
  ok('温度 62℃', parseTempInput('62000\n') === 62)
  const full = '0, GeForce RTX 2080 Ti, 62, 45, 5120, 11264\n1, GeForce RTX 2080 Ti, 58, 91, 8900, 11264\n#S\ncpu  1000 10 20 9000 5 0 0 0 0 0 0\n#T\n62000\n#M\nMemTotal:       10000000 kB\nMemAvailable:    8000000 kB\n'
  const p = parseCollectOutput(full)
  ok('整段解析', p.gpu.length === 2 && p.cpuStat && p.cpuTempC === 62 && p.mem.pct === 20, JSON.stringify(p))
  const p2 = parseCollectOutput('nvidia-smi: 无法运行\n#S\ncpu  1000 10 20 9000 5 0 0 0 0 0 0\n#T\n\n#M\nMemTotal:       10000000 kB\n')
  ok('GPU 失败降级（gpu=[]）', p2.gpu.length === 0 && p2.cpuTempC === null && p2.mem.totalMB === 9765.6, JSON.stringify(p2))
}
console.log('[4] 事件引擎：温度告警/恢复')
{
  const core = new MonitorCore({ thresholds: { gpuTempWarn: 82, gpuTempDanger: 90 } })
  core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 60, utilPct: 20 }] })
  ok('正常无告警', core.state().alerts.length === 0)
  core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 85, utilPct: 20 }] })
  let s = core.state()
  ok('85℃ → warn', s.alerts.some((a) => a.label.includes('GPU0') && a.level === 'warn'), JSON.stringify(s.alerts))
  core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 92, utilPct: 20 }] })
  s = core.state()
  ok('92℃ → danger（升级）', s.alerts.some((a) => a.label.includes('GPU0') && a.level === 'danger'), JSON.stringify(s.alerts))
  core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 60, utilPct: 20 }] })
  s = core.state()
  ok('回落 → 无告警', s.alerts.length === 0)
  ok('恢复事件写入', core.recentEvents(100).some((e) => e.type === 'recover_gpu_temp_0'), core.recentEvents(100).map((e) => e.type).join(','))
}
console.log('[5] 事件引擎：GPU 使用率连续高位')
{
  const core = new MonitorCore({ thresholds: { gpuUtilHigh: 95, gpuUtilHighFrames: 3 } })
  for (let i = 0; i < 3; i += 1) core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 60, utilPct: 97 }] })
  ok('连续3帧97% → 告警', core.state().alerts.some((a) => a.label.includes('使用率')), JSON.stringify(core.state().alerts))
  core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 60, utilPct: 10 }] })
  ok('回落 → 清除', core.state().alerts.length === 0)
}
console.log('[6] CPU/内存告警 + 汇总')
{
  // 注意：memPct 90 需同时抬高 memPctDanger（默认 85），否则内存告警落 danger、health 非 warn
  const core = new MonitorCore({ thresholds: { cpuTempWarn: 75, memPctWarn: 90, memPctDanger: 95 } })
  core.ingest({ host: '测试', gpu: [], cpuStat: parseCpuLine('cpu  1000 10 20 9000 5 0 0 0 0 0 0'), cpuTempC: 80, mem: { usedMB: 9000, totalMB: 10000, pct: 90 } })
  const s = core.state()
  ok('CPU 温度 warn + 内存 warn', s.alerts.some((a) => a.label === 'CPU 温度') && s.alerts.some((a) => a.label === '内存使用率'), JSON.stringify(s.alerts))
  ok('连接判定：有帧且 connected=true → health=warn（两个 warn 告警）', s.connected === true && s.health === 'warn')
  const agg = core.summary(1)
  ok('聚合（帧数≥1, cpuTempMax=80）', agg && agg.frames >= 1 && agg.cpuTempMax === 80, JSON.stringify(agg))
}
console.log('[7] 环形缓冲上限')
{
  const core = new MonitorCore({ maxSamples: 5, maxEvents: 5 })
  for (let i = 0; i < 12; i += 1) core.ingest({ host: '测试', gpu: [{ idx: 0, tempC: 50, utilPct: 10 }] })
  ok('history 上限 5', core.history.size === 5, String(core.history.size))
  ok('samples 计数 12', core.samples === 12)
}

console.log('[8] 推理指标：llama.cpp / vLLM 双映射（真实样本）')
{
  // 142 llama-server 真实 /metrics 输出节选（qwen38-27b-gsq）
  const llamaText = [
    '# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed, excluding cached tokens',
    '# TYPE llamacpp:prompt_tokens_total counter',
    'llamacpp:prompt_tokens_total 66229',
    'llamacpp:prompt_tokens_cached_total 132261',
    'llamacpp:tokens_predicted_total 543',
    'llamacpp:n_tokens_max 66775',
    'llamacpp:spec_decode_num_draft_tokens_total 516',
    'llamacpp:spec_decode_num_accepted_tokens_total 374',
    'llamacpp:predicted_tokens_seconds 46.3877',
    'llamacpp:requests_processing 0',
    'llamacpp:requests_deferred 0',
    'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 146',
  ].join('\n')
  const v1 = mapInferenceMetrics(parsePrometheusText(llamaText))
  ok('llama alive/运行中/排队', v1.alive === true && v1.runningCount === 0 && v1.waitingCount === 0, JSON.stringify(v1))
  ok('llama tokens 累计', v1.generationTokensTotal === 543 && v1.promptTokensTotal === 66229, JSON.stringify(v1))
  ok('llama TPOT=1000/46.3877≈22ms', v1.tpotMs === 22, 'got ' + v1.tpotMs)
  ok('llama MTP draft/acc（接受率改由 core 滑窗计算，映射层置 null）', v1.specDraftTokens === 516 && v1.specAcceptedTokens === 374 && v1.specAcceptRate === null, 'got ' + v1.specAcceptRate)
  ok('llama 无 KV/TTFT/抢占 → null', v1.kvCacheUsagePct === null && v1.ttftMs === null && v1.numPreempted === null && v1.e2eLatencyMs === null)

  const vllmText = [
    'vllm:num_requests_running 2.0',
    'vllm:num_requests_waiting 5.0',
    'vllm:kv_cache_usage_perc 0.87',
    'vllm:generation_tokens_total 10000.0',
    'vllm:prompt_tokens_total 5000.0',
    'vllm:time_to_first_token_seconds_sum 3.2',
    'vllm:time_to_first_token_seconds_count 8',
    'vllm:time_per_output_token_seconds_sum 4.8',
    'vllm:time_per_output_token_seconds_count 120',
  ].join('\n')
  const v2 = mapInferenceMetrics(parsePrometheusText(vllmText))
  ok('vllm 运行/排队/KV 87%', v2.runningCount === 2 && v2.waitingCount === 5 && v2.kvCacheUsagePct === 87, JSON.stringify(v2))
  ok('vllm TTFT=400ms / TPOT=40ms', v2.ttftMs === 400 && v2.tpotMs === 40, JSON.stringify(v2))
  ok('空输入 → alive=false', mapInferenceMetrics({}).alive === false)

  // 0.10.0：新 vLLM fork 指标改名（2026-10 于 142 实测）——TPOT 新名 + 旧名并存；gpu_cache/swapped 上游已删
  const vllmNewText = [
    'vllm:num_requests_running 1.0',
    'vllm:kv_cache_usage_perc 0.42',
    'vllm:request_time_per_output_token_seconds_sum 3.0',
    'vllm:request_time_per_output_token_seconds_count 60',
    'vllm:inter_token_latency_seconds_sum 2.0',
    'vllm:inter_token_latency_seconds_count 40',
  ].join('\n')
  const v3 = mapInferenceMetrics(parsePrometheusText(vllmNewText))
  ok('新 fork TPOT=新名 request_time_per_output_token（50ms）', v3.tpotMs === 50, 'got ' + v3.tpotMs)
  ok('旧名 TPOT 仍识别（fallback, 40ms）', v2.tpotMs === 40)
  ok('两名字均无 → TPOT null', mapInferenceMetrics(parsePrometheusText('vllm:num_requests_running 1.0')).tpotMs === null)
  ok('上游已删 gpu_cache/swapped → null（卡片 —、告警跳过）', v3.gpuCacheUsagePct === null && v3.swappedCount === null)
}
console.log('[9] 模型名解析（vLLM data[0].id / llama models[0].name / 截断兜底）')
{
  ok('llama 完整 JSON', parseModelsOutput('{"models":[{"name":"qwen38-27b-gsq","model":"qwen38-27b-gsq","type":"model"}]}') === 'qwen38-27b-gsq')
  ok('llama 截断 JSON 正则兜底', parseModelsOutput('{"models":[{"name":"qwen38-27b-gsq"') === 'qwen38-27b-gsq')
  ok('vLLM data[0].id', parseModelsOutput('{"object":"list","data":[{"id":"qwen38-27b-nvfp4","object":"model"}]}') === 'qwen38-27b-nvfp4')
  ok('空输入 → null', parseModelsOutput('') === null)
}
console.log('[10] fetchInference 三分支端到端（本地 HTTP stub，0.10.0 swap 感知）')
{
  const http = await import('node:http')
  // —— 分支 1：直连形态（端口上直接是推理服务，/running 404 非 swap）
  const llamaBody = 'llamacpp:requests_processing 1\nllamacpp:requests_deferred 2\nllamacpp:tokens_predicted_total 100\nllamacpp:predicted_tokens_seconds 40\n'
  const direct = http.createServer((req, res) => {
    if (req.url === '/metrics') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(llamaBody) }
    else if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"models":[{"name":"stub-model","model":"stub-model"}]}') }
    else { res.writeHead(404); res.end('nope') }   // /running → 404 = 非 swap
  })
  await new Promise((r) => direct.listen(0, '127.0.0.1', r))
  const dPort = direct.address().port
  const r1 = await fetchInference('http://127.0.0.1:' + dPort)
  ok('直连形态：/running 404 → state=direct 且取数正常', r1.swap.state === 'direct' && r1.vllm && r1.vllm.alive === true && r1.vllm.runningCount === 1 && r1.vllm.tpotMs === 25, JSON.stringify({ s: r1.swap, v: r1.vllm }))
  ok('直连形态：模型名', r1.modelName === 'stub-model', 'got ' + r1.modelName)
  direct.close()

  // —— 分支 2：llama-swap 形态（泳道臂在独立端口）
  const arm = http.createServer((req, res) => {
    if (req.url === '/metrics') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('vllm:num_requests_running 3.0\nvllm:kv_cache_usage_perc 0.66\nvllm:generation_tokens_total 777.0\n') }
    else if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"served-name-a","object":"model"}]}') }
    else { res.writeHead(404); res.end('nope') }
  })
  await new Promise((r) => arm.listen(0, '127.0.0.1', r))
  const aPort = arm.address().port
  const swapBase = http.createServer((req, res) => {
    if (req.url === '/running') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"running":[{"model":"arm-a","state":"ready","cmd":"x","proxy":"http://localhost:' + aPort + '","ttl":1800}]}')
    } else if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"data":[{"id":"arm-a","status":{"value":"loaded"}},{"id":"arm-b","status":{"value":"unloaded"}}]}')
    } else { res.writeHead(404); res.end('nope') }
  })
  await new Promise((r) => swapBase.listen(0, '127.0.0.1', r))
  const sPort = swapBase.address().port
  const r2 = await fetchInference('http://127.0.0.1:' + sPort)
  ok('swap 形态：去臂端口取 /metrics', r2.vllm && r2.vllm.alive === true && r2.vllm.runningCount === 3 && r2.vllm.kvCacheUsagePct === 66, JSON.stringify(r2.vllm))
  ok('swap state=armed + armId/armPort', r2.swap.state === 'armed' && r2.swap.armId === 'arm-a' && r2.swap.armPort === aPort, JSON.stringify(r2.swap))
  ok('swap 形态：模型名=臂端口 served 名', r2.modelName === 'served-name-a', 'got ' + r2.modelName)
  ok('proxy localhost → 目标主机', armUrlFromProxy('http://localhost:8012', 'http://10.226.127.71:8000') === 'http://10.226.127.71:8012')
  ok('proxy 非 localhost 原样返回', armUrlFromProxy('http://192.168.1.5:9000', 'http://10.226.127.71:8000') === 'http://192.168.1.5:9000')

  // —— 分支 2b：无 ready 臂 → loading（有非 ready 臂）/ idle（全卸载）
  let runningBody = '{"running":[{"model":"arm-b","state":"starting","proxy":"http://localhost:' + aPort + '","ttl":1800}]}'
  const swapIdle = http.createServer((req, res) => {
    if (req.url === '/running') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(runningBody) }
    else if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"arm-b","status":{"value":"unloaded"}}]}') }
    else { res.writeHead(404); res.end('nope') }
  })
  await new Promise((r) => swapIdle.listen(0, '127.0.0.1', r))
  const siPort = swapIdle.address().port
  const r3 = await fetchInference('http://127.0.0.1:' + siPort, 3000)
  ok('无 ready 臂 → loading + loadingArm', r3.vllm === null && r3.swap.state === 'loading' && r3.swap.loadingArm === 'arm-b', JSON.stringify(r3.swap))
  runningBody = '{"running":[]}'
  const r4 = await fetchInference('http://127.0.0.1:' + siPort, 3000)
  ok('/running 空 + 目录全 unloaded → idle（中性，不告警态）', r4.vllm === null && r4.swap.state === 'idle', JSON.stringify(r4.swap))
  const swapLoadingCat = http.createServer((req, res) => {
    if (req.url === '/running') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"running":[]}') }
    else if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"arm-c","status":{"value":"loading"}}]}') }
    else { res.writeHead(404); res.end('nope') }
  })
  await new Promise((r) => swapLoadingCat.listen(0, '127.0.0.1', r))
  const slcPort = swapLoadingCat.address().port
  const r5 = await fetchInference('http://127.0.0.1:' + slcPort, 3000)
  ok('/running 空 + 目录有 loading 态 → loading（目录兜底探测）', r5.swap.state === 'loading' && r5.swap.loadingArm === 'arm-c', JSON.stringify(r5.swap))
  swapBase.close(); arm.close(); swapIdle.close(); swapLoadingCat.close()

  // —— 分支 3：入口失联
  const r6 = await fetchInference('http://127.0.0.1:1', 800)
  ok('不可达 → state=down + up=false（触发失联告警）', r6.vllm === null && r6.swap.up === false && r6.swap.state === 'down', JSON.stringify(r6.swap))
}

console.log('[11] 历史抽稀 / 窗口差值 / historyFrames / 告警 key')
{
  const frames = Array.from({ length: 10 }, (_, i) => ({ ts: 1000 + i * 100, v: i * 10, gpu: [] }))
  const d1 = decimateFrames(frames, 4)
  ok('抽稀到 4 点且保留首尾', d1.length === 4 && d1[0].ts === 1000 && d1[3].ts === 1900, JSON.stringify(d1.map((f) => f.ts)))
  ok('点数不足原样返回', decimateFrames(frames, 20).length === 10)
  ok('maxPoints=1 取最后', decimateFrames(frames, 1).length === 1 && decimateFrames(frames, 1)[0].ts === 1900)
  ok('空/非法 → []', decimateFrames([], 5).length === 0 && decimateFrames(frames, 0).length === 0)

  const cnt = Array.from({ length: 5 }, (_, i) => ({ ts: i * 1000, vllmGenTotal: 100 + i * 10 }))
  const w = windowDelta(cnt, 'vllmGenTotal', 60000)
  ok('窗口差值 = 40', w && w.delta === 40 && w.spanMs === 4000, JSON.stringify(w))
  const stale = [{ ts: 0, vllmGenTotal: 100 }, { ts: 100000, vllmGenTotal: 130 }, { ts: 101000, vllmGenTotal: 135 }]
  const w2 = windowDelta(stale, 'vllmGenTotal', 5000)
  ok('超出窗口的旧帧被排除（只算末两帧）', w2 && w2.delta === 5 && w2.spanMs === 1000, JSON.stringify(w2))
  const reset = [{ ts: 0, vllmGenTotal: 100 }, { ts: 1000, vllmGenTotal: 5 }]
  ok('计数器回退（重启）→ null', windowDelta(reset, 'vllmGenTotal', 60000) === null)
  ok('单帧 → null', windowDelta(cnt.slice(0, 1), 'vllmGenTotal', 60000) === null)
  ok('嵌套 key a.b 路径', windowDelta([{ ts: 0, a: { b: 1 } }, { ts: 1000, a: { b: 9 } }], 'a.b', 60000).delta === 8)

  const core = new MonitorCore({ maxSamples: 100 })
  core.ingest({ host: 't', gpu: [{ idx: 0, tempC: 60, utilPct: 50 }], vllm: { alive: true, generationTokensTotal: 10, promptTokensTotal: 5 } })
  core.ingest({ host: 't', gpu: [{ idx: 0, tempC: 61, utilPct: 60 }], vllm: { alive: true, generationTokensTotal: 20, promptTokensTotal: 8 } })
  const hf = core.historyFrames(60000, 10)
  ok('historyFrames 返回全部近期帧', hf.length === 2 && hf[1].vllm.generationTokensTotal === 20, JSON.stringify(hf.map((f) => f.ts)))
  ok('historyFrames 抽稀上限', core.historyFrames(60000, 1).length === 1)

  const c2 = new MonitorCore({ thresholds: { gpuTempWarn: 82 } })
  c2.ingest({ host: 't', gpu: [{ idx: 0, tempC: 85, utilPct: 10 }] })
  const al = c2.state().alerts
  ok('告警带 key=gpu_temp_0', al.length === 1 && al[0].key === 'gpu_temp_0' && al[0].label === 'GPU0 温度', JSON.stringify(al))
}

console.log('[12] MTP 接受率：60s 滑窗 Δ（MonitorCore.ingest）')
{
  const mk = (d, a) => ({ host: 't', gpu: [], vllm: { alive: true, runningCount: 0, waitingCount: 0, generationTokensTotal: 0, promptTokensTotal: 0, specDraftTokens: d, specAcceptedTokens: a } })
  const c = new MonitorCore({ maxSamples: 100 })
  const f1 = c.ingest(mk(100, 70))
  ok('首帧建立基准 → null', f1.vllm.specAcceptRate === null, String(f1.vllm.specAcceptRate))
  const f2 = c.ingest(mk(140, 98))
  ok('单帧 Δ 28/40 = 70%', f2.vllm.specAcceptRate === 70, String(f2.vllm.specAcceptRate))
  const f3 = c.ingest(mk(180, 130))
  ok('双帧窗口 60/80 = 75%', f3.vllm.specAcceptRate === 75, String(f3.vllm.specAcceptRate))
  const f4 = c.ingest(mk(180, 130))
  ok('空闲（无新增 draft）→ null', f4.vllm.specAcceptRate === null, String(f4.vllm.specAcceptRate))
  const f5 = c.ingest(mk(5, 3))
  ok('计数回退（重启）→ 基准重置 null', f5.vllm.specAcceptRate === null, String(f5.vllm.specAcceptRate))
  const f6 = c.ingest(mk(10, 5))
  ok('新基准后 Δ 2/5 = 40%', f6.vllm.specAcceptRate === 40, String(f6.vllm.specAcceptRate))
}

console.log('[13] 网络速度：/proc/net/dev 解析 + 帧差值（整机物理网口合计）')
{
  const dev1 = [
    'Inter-|   Receive                                                |  Transmit',
    ' Face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1234567     9876    0    0    0     0          0         0  1234567     9876    0    0    0     0       0      0',
    'enp7s0: 65169263598 51000000    0 1234    0     0          0         0 15245551144 32000000    0    0    0     0       0      0',
    'ztcdclbt2b: 1000000    900    0    0    0     0          0         0   900000    800    0    0    0     0       0      0',
  ].join('\n')
  const n1 = parseNetDev(dev1)
  ok('enp7s0 rx/tx', n1.enp7s0 && n1.enp7s0.rx === 65169263598 && n1.enp7s0.tx === 15245551144, JSON.stringify(n1.enp7s0))
  ok('ztcdclbt2b rx', n1.ztcdclbt2b && n1.ztcdclbt2b.rx === 1000000, JSON.stringify(n1.ztcdclbt2b))
  ok('空输入 → 空对象', Object.keys(parseNetDev('')).length === 0)
  ok('无冒号/字段不足行被忽略', Object.keys(parseNetDev('no colon here\nenp7s0: 1 2\n')).length === 0)

  const ip1 = parseIpAddr('lo     UNKNOWN        127.0.0.1/8\nenp7s0     UP             192.168.31.142/24\nztcdclbt2b UP             10.226.127.71/24\nenp6s0     DOWN           \n')
  ok('enp7s0 → 192.168.31.142', ip1.enp7s0 === '192.168.31.142', JSON.stringify(ip1))
  ok('ztcdclbt2b → 10.226.127.71（剥离 /24）', ip1.ztcdclbt2b === '10.226.127.71')
  ok('跳过 lo、跳过无数值 IP 行', ip1.lo === undefined && ip1.enp6s0 === undefined)

  const c = new MonitorCore({ maxSamples: 10, probeIntervalMs: 60000 })
  const f1 = c.ingest({ host: 't', gpu: [], netDev: n1 }, 1000000)
  ok('首帧建基准 → net null', f1.net === null, JSON.stringify(f1.net))
  const dev2 = {
    ...n1,
    lo: { rx: n1.lo.rx + 999, tx: n1.lo.tx + 999 },
    enp7s0: { rx: n1.enp7s0.rx, tx: n1.enp7s0.tx + 1500000 },
    ztcdclbt2b: { rx: n1.ztcdclbt2b.rx + 900000, tx: n1.ztcdclbt2b.tx },
  }
  const f2 = c.ingest({ host: 't', gpu: [], netDev: dev2 }, 1003000)
  ok('up = Δtx/3s = 500000 B/s', f2.net && f2.net.upBps === 500000, JSON.stringify(f2.net))
  ok('down = Δrx/3s = 300000 B/s（lo 不计）', f2.net && f2.net.downBps === 300000, JSON.stringify(f2.net))
  ok('ifname = 参与网口', f2.net && f2.net.ifname === 'enp7s0+ztcdclbt2b', String(f2.net && f2.net.ifname))
  ok('分口 parts', f2.net && f2.net.parts.enp7s0.upBps === 500000 && f2.net.parts.enp7s0.downBps === 0 && f2.net.parts.ztcdclbt2b.downBps === 300000, JSON.stringify(f2.net && f2.net.parts))
  const dev3 = { ...dev2, enp7s0: { rx: 10, tx: 5 }, ztcdclbt2b: { rx: 1, tx: 2 } }
  const f3 = c.ingest({ host: 't', gpu: [], netDev: dev3 }, 1006000)
  ok('计数回退（网卡重置）→ net null', f3.net === null, JSON.stringify(f3.net))
  const dev4 = { ...dev3, enp7s0: { rx: 10, tx: 11 }, ztcdclbt2b: { rx: 1, tx: 2 } }
  const f4 = c.ingest({ host: 't', gpu: [], netDev: dev4 }, 1009000)
  ok('基准重置后 up = 6/3s = 2 B/s', f4.net && f4.net.upBps === 2 && f4.net.downBps === 0, JSON.stringify(f4.net))
}

console.log('[14] 探针：applyProbe + llama 覆写（vLLM 引擎不受影响）')
{
  const llamaFrame = (gen, prompt) => ({ host: 't', gpu: [], vllm: { alive: true, engine: 'llama', runningCount: 0, waitingCount: 0, generationTokensTotal: gen, promptTokensTotal: prompt, ttftMs: null, tpotMs: null, genTokPerSec: null, promptTokPerSec: null } })
  const c = new MonitorCore({ maxSamples: 10, probeIntervalMs: 60000 })
  ok('未应用探针 → state().probeAt null', c.state().probeAt === null, String(c.state().probeAt))
  c.applyProbe(null)
  c.applyProbe({ foo: 1 })
  ok('null/缺 at 探针被忽略', c.state().probeAt === null)
  const probeFresh = { ttftMs: 596, tpotMs: 18.7, genTps: 53.35, promptTps: 57.06, at: 2000000 }
  c.applyProbe(probeFresh)
  ok('state().probeAt = 探针 at', c.state().probeAt === 2000000, String(c.state().probeAt))

  const f1 = c.ingest(llamaFrame(0, 0), 2000000)
  ok('llama 新鲜探针 → 覆写四字段', f1.vllm.ttftMs === 596 && f1.vllm.tpotMs === 18.7 && f1.vllm.genTokPerSec === 53.4 && f1.vllm.promptTokPerSec === 57.1, JSON.stringify(f1.vllm))
  const f2 = c.ingest(llamaFrame(100, 2000), 2003000)
  ok('第 2 帧仍为探针值（不被差值 33.3/666.7 覆盖）', f2.vllm.genTokPerSec === 53.4 && f2.vllm.promptTokPerSec === 57.1 && f2.vllm.ttftMs === 596, JSON.stringify(f2.vllm))

  const vFrame = c.ingest({ host: 't', gpu: [], vllm: { alive: true, engine: 'vllm', runningCount: 1, waitingCount: 0, generationTokensTotal: 1000, promptTokensTotal: 500, ttftMs: 400, tpotMs: 40 } }, 2006000)
  ok('vLLM 引擎不被探针覆写（400/40 保留）', vFrame.vllm.ttftMs === 400 && vFrame.vllm.tpotMs === 40, JSON.stringify(vFrame.vllm))

  const c2 = new MonitorCore({ maxSamples: 10, probeIntervalMs: 60000 })
  c2.applyProbe({ ttftMs: 999, tpotMs: 99.9, genTps: 111.1, promptTps: 222.2, at: 3000000 })
  const g1 = c2.ingest(llamaFrame(0, 0), 3000000 + 10 * 60 * 1000)
  ok('陈旧探针（>10min > 新鲜窗口 180s）→ 不覆写', g1.vllm.ttftMs === null && g1.vllm.tpotMs === null && g1.vllm.genTokPerSec === null, JSON.stringify(g1.vllm))
}

console.log('[15] 探针端到端：probeInfer（本地 HTTP stub）')
{
  const http = await import('node:http')
  let capturedBody = null
  const timingsBody = JSON.stringify({
    id: 'stub', object: 'chat.completion', model: 'stub-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '1 2 3' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 40, completion_tokens: 32, total_tokens: 72, prompt_tokens_details: { cached_tokens: 0 } },
    timings: { cache_n: 0, prompt_n: 40, prompt_ms: 595.8, prompt_per_token_ms: 14.89, prompt_per_second: 57.06, predicted_n: 32, predicted_ms: 599.8, predicted_per_token_ms: 18.74, predicted_per_second: 53.35, draft_n: 26, draft_n_accepted: 22 },
  })
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = ''
      req.on('data', (ch) => { body += ch })
      req.on('end', () => {
        capturedBody = body
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(timingsBody)
      })
    } else { res.writeHead(404); res.end('nope') }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const r = await probeInfer('http://127.0.0.1:' + port, 'stub-model')
  ok('timings → ttftMs 596（595.8 四舍五入）', r && r.ttftMs === 596, JSON.stringify(r))
  ok('tpotMs 18.7', r && r.tpotMs === 18.7, String(r && r.tpotMs))
  ok('genTps 53.4', r && r.genTps === 53.4, String(r && r.genTps))
  ok('promptTps 57.1', r && r.promptTps === 57.1, String(r && r.promptTps))
  ok('usage → tokens 32 / cached 0', r && r.tokens === 32 && r.cached === 0, JSON.stringify(r))
  ok('at 为数字', r && typeof r.at === 'number')
  ok('请求体带 nonce probe- 前缀', capturedBody && capturedBody.includes('probe-'), String(capturedBody && capturedBody.slice(0, 160)))
  const sent = JSON.parse(capturedBody)
  ok('max_tokens=64 / stream=false / temperature=0', sent.max_tokens === 64 && sent.stream === undefined && sent.temperature === 0, JSON.stringify(sent))
  server.close()
  const r2 = await probeInfer('http://127.0.0.1:1', 'stub-model', { timeoutMs: 800 })
  ok('端点不可达 → null', r2 === null, JSON.stringify(r2))
  const r3 = await probeInfer('http://127.0.0.1:' + 1, '')
  ok('缺 model → null（不发请求）', r3 === null)
}

console.log('[16] swap 状态机事件（0.10.0：模型卸载中性化 / 入口失联告警）')
{
  const c = new MonitorCore({ intervalMs: 3000, maxSamples: 200 })
  const ARMED = { up: true, state: 'armed', armId: 'arm-a', armPort: 8012, loadingArm: null }
  const IDLE = { up: true, state: 'idle', armId: null, armPort: null, loadingArm: null }
  const LOADING = { up: true, state: 'loading', armId: null, armPort: null, loadingArm: 'arm-b' }
  const DOWN = { up: false, state: 'down', armId: null, armPort: null, loadingArm: null }
  const aliveVllm = () => ({ alive: true, engine: 'vllm', runningCount: 1, waitingCount: 0, kvCacheUsagePct: 20, generationTokensTotal: 100, promptTokensTotal: 50, specDraftTokens: 10, specAcceptedTokens: 9 })
  let t = 1_000_000
  const step = (vllm, swap) => { t += 3000; c.ingest({ host: 't', gpu: [{ idx: 0, name: 'G', tempC: 60, utilPct: 10, memUsedMB: 1000, memTotalMB: 11264 }], cpuUtilPct: 10, mem: { usedMB: 1000, totalMB: 8000, pct: 12 }, vllm, swap, ts: t }) }
  const ev = (name) => c.recentEvents(200).some((e) => e.type === name)
  const noAlert = (key) => !c.state().alerts.some((a) => a.key === key)

  step(aliveVllm(), ARMED)
  ok('armed 帧 → alive 无事件', c.state().connected === true && noAlert('vllm_kv') && noAlert('vllm_queue'))
  step(null, IDLE)
  step(null, IDLE)
  ok('armed→idle：无 vllm_stop（ttyl 卸载中性化）', !ev('vllm_stop'))
  step(null, LOADING)
  step(aliveVllm(), ARMED)
  ok('回 ready → vllm_start 带臂名', ev('vllm_start') && c.state().health !== 'warn')

  const c2 = new MonitorCore({ intervalMs: 3000, maxSamples: 200 })
  let t2 = 1_000_000
  const step2 = (vllm, swap) => { t2 += 3000; c2.ingest({ host: 't', gpu: [{ idx: 0, name: 'G', tempC: 60, utilPct: 10, memUsedMB: 1000, memTotalMB: 11264 }], cpuUtilPct: 10, mem: { usedMB: 1000, totalMB: 8000, pct: 12 }, vllm, swap, ts: t2 }) }
  step2(aliveVllm(), ARMED)
  step2(null, DOWN)
  step2(null, DOWN)
  ok('armed→失联 2 帧 → vllm_stop warn（真告警）', c2.recentEvents(200).some((e) => e.type === 'vllm_stop' && e.level === 'warn'))
  step2(null, DOWN)
  ok('持续失联不重复 fire', c2.recentEvents(200).filter((e) => e.type === 'vllm_stop').length === 1)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)