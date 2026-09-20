// scripts/probe-cputemp.mjs — 只读核对板载 127℃ 与真实 CPU 温度（凭据走环境变量 HM_SSH_PASS，可选 HM_SSH_USER / HM_SSH_HOST）
import { SshCollector } from '../lib/ssh.js'
if (!process.env.HM_SSH_PASS) { console.error('缺少 SSH 凭据：请设置环境变量 HM_SSH_PASS（可选 HM_SSH_USER / HM_SSH_HOST）'); process.exit(1) }
const c = new SshCollector({ onStatus: () => {} })
c.configure({ host: process.env.HM_SSH_HOST || '192.168.31.142', port: 22, user: process.env.HM_SSH_USER || '', password: process.env.HM_SSH_PASS })
c.start()
const d = Date.now() + 20000
while (!c.connected && Date.now() < d) await new Promise((r) => setTimeout(r, 500))
if (!c.connected) { console.error('连接失败'); c.stop(); process.exit(1) }
try {
  const out = await c.exec("HW=/sys/class/hwmon/hwmon2\necho '=== nct6779 temp 各通道 + label ==='\nfor t in $HW/temp*_input; do\n  lbl=$(cat ${t%_input}_label 2>/dev/null || echo none)\n  echo \"$(basename $t) = $(cat $t) [$(($(cat $t) / 1000))C] label=$lbl\"\ndone\necho '=== coretemp（真实 CPU 多核/封包）==='\nfor t in /sys/class/hwmon/hwmon1/temp*_input; do [ -f \"$t\" ] && echo \"$(basename $t) = $(cat $t) [$(($(cat $t) / 1000))C]\" ; done | head -8\necho '=== thermal_zone (x86_pkg_temp) ==='\ncat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{printf \"pkg=$(( $1 / 1000 ))C\\n\"}'\necho '=== nvidia GPU temps（参照）==='\nnvidia-smi --query-gpu=index,temperature.gpu --format=csv,noheader,nounits 2>/dev/null", 15000)
  console.log(out)
} catch (e) { console.error('执行失败：', e.message) }
c.stop()
process.exit(0)
