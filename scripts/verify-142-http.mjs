// scripts/verify-142-http.mjs — Windows 宿主机直连 142 推理服务 /metrics（无 SSH，模拟插件取数路径）
// 用法: node scripts/verify-142-http.mjs [baseUrl]
const base = (process.argv[2] || 'http://192.168.31.142:8000').replace(/\/+$/, '')
const t = AbortSignal.timeout(6000)
const [m, d] = await Promise.all([
  fetch(base + '/metrics', { signal: t }).then((r) => (r.ok ? r.text() : 'HTTP ' + r.status)).catch((e) => 'ERR ' + e.message),
  fetch(base + '/v1/models', { signal: t }).then((r) => (r.ok ? r.text() : 'HTTP ' + r.status)).catch((e) => 'ERR ' + e.message),
])
console.log('base:', base)
console.log('--- /metrics (前 8 行) ---')
console.log(m.split('\n').slice(0, 8).join('\n'))
console.log('--- /v1/models (前 200 字符) ---')
console.log(d.slice(0, 200))
const alive = /^llamacpp:|^vllm:/m.test(m)
console.log(alive ? 'METRICS_OK' : 'METRICS_FAIL')
process.exit(alive ? 0 : 1)
