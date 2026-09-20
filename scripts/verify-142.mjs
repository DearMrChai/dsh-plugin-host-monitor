// scripts/verify-142.mjs — 真实 SSH 验证：连目标机跑采集命令并解析（默认局域网，可传参换地址）
// 用法: node scripts/verify-142.mjs [host] [port] [user] [password]（或设环境变量 HM_SSH_HOST / HM_SSH_USER / HM_SSH_PASS）
import { SshCollector, buildCollectCmd } from '../lib/ssh.js'
import { parseCollectOutput } from '../lib/core.js'

const host = process.argv[2] || process.env.HM_SSH_HOST || '192.168.31.142'
const port = Number(process.argv[3] || 22)
const user = process.argv[4] || process.env.HM_SSH_USER || ''
const password = process.argv[5] || process.env.HM_SSH_PASS || ''
if (!password) { console.error('缺少 SSH 凭据：传参 [host] [port] [user] <password>，或设环境变量 HM_SSH_USER / HM_SSH_PASS'); process.exit(1) }

const c = new SshCollector({ onStatus: (s) => console.log('[状态]', JSON.stringify(s)) })
c.configure({ host, port, user, password })
c.start()

const deadline = Date.now() + 20000
const waitReady = async () => {
  while (!c.connected && Date.now() < deadline) {
    if (c.lastError) console.log('[错误]', c.lastError)
    await new Promise((r) => setTimeout(r, 500))
  }
  return c.connected
}

if (await waitReady()) {
  console.log('=== 已连接 ' + host + ':' + port + '，执行采集命令 ===')
  try {
    const out = await c.exec(buildCollectCmd({ vllmBaseUrl: 'http://127.0.0.1:8000' }))
    console.log('----- 原始输出 -----')
    console.log(out)
    console.log('----- 解析结果 -----')
    console.log(JSON.stringify(parseCollectOutput(out), null, 2))
  } catch (e) { console.error('取数失败：', e.message) }
} else {
  console.error('连接失败：' + host + '（' + (c.lastError || '超时') + '）')
}
c.stop()
process.exit(0)
