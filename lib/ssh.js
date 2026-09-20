// lib/ssh.js — ssh2 持久连接封装：连接/心跳/自动重连退避/单命令执行
import { Client } from 'ssh2'

// 一条命令拿硬件指标（分段标记 #S #C #T #M #N #P；全 stdlib，无 sudo 需求）
//   GPU: nvidia-smi 两卡温度/使用率/显存
//   CPU 使用率: /proc/stat cpu 行差值（本机侧算）
//   CPU 型号: /proc/cpuinfo model name（自动识别，换 CPU 无需改插件）
//   CPU 温度: hwmon coretemp/k10temp 最大值（毫摄氏度）；读不到为空
//   内存: /proc/meminfo MemTotal/MemAvailable
//   网速: /proc/net/dev 各网口 rx/tx 字节累计（本机相邻帧差值=上传/下载速度）
//   IP:   ip -br addr 各网口 IP（胶囊/工具展示）
// 推理指标（vLLM/llama.cpp /metrics + /v1/models）不再走 SSH，
// 改由 DSH 宿主机直连 HTTP 取（见 http-metrics.js），脱离对远端构建服务端的依赖。
export function buildCollectCmd() {
  return [
    "nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
    "echo '#S'",
    "grep '^cpu ' /proc/stat",
    "echo '#C'",
    "grep -m1 'model name' /proc/cpuinfo",
    "echo '#T'",
    "_ct=$(for h in /sys/class/hwmon/hwmon*; do n=$(cat $h/name 2>/dev/null); case \"$n\" in coretemp|k10temp) echo $h;; esac; done | head -1); [ -n \"$_ct\" ] && cat $_ct/temp1_input 2>/dev/null",
    "echo '#M'",
    "grep -E '^MemTotal|^MemAvailable' /proc/meminfo",
    "echo '#N'",
    "cat /proc/net/dev",
    "echo '#P'",
    "ip -br addr",
  ].join('; ')
}

const EXEC_TIMEOUT = 15000

export class SshCollector {
  constructor({ onStatus } = {}) {
    this.client = null
    this.onStatus = onStatus || (() => {})
    this.onHostname = null
    this.running = false
    this.host = null
    this.port = 22
    this.user = ''
    this.password = ''
    this.retryTimer = null
    this.retryDelay = 2000
    this.attempts = 0
    this.lastError = null
    this.connected = false
    this.connectedAt = 0
  }

  configure({ host, port, user, password }) {
    this.host = host
    this.port = port || 22
    this.user = user || ''
    this.password = password || ''
  }

  start() {
    if (this.running) return
    this.running = true
    this.connect()
  }

  connect() {
    if (!this.running || this.client) return
    this.attempts += 1
    const c = new Client()
    this.client = c
    c.on('ready', () => {
      this.connected = true
      this.connectedAt = Date.now()
      this.retryDelay = 2000
      this.lastError = null
      this.emit()
      this.exec('hostname').then((out) => this.onHostname?.(String(out).trim())).catch(() => {})
    })
    c.on('error', (err) => {
      this.lastError = err?.message || String(err)
      this.emit()
      this.scheduleRetry()
    })
    c.on('close', () => {
      if (this.client === c) this.client = null
      this.connected = false
      this.emit()
      this.scheduleRetry()
    })
    c.connect({
      host: this.host, port: this.port, username: this.user, password: this.password,
      readyTimeout: 10000, keepaliveInterval: 5000, keepaliveCountMax: 3,
    })
  }

  scheduleRetry() {
    if (!this.running || this.retryTimer || this.client) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, 30000)
      this.connect()
    }, this.retryDelay)
    this.emit()
  }

  /** 执行一条命令返回 stdout；未连接/超时抛错（timeoutMs 可覆盖默认 15s） */
  exec(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const c = this.client
      if (!c || !this.connected) { reject(new Error('ssh not connected')); return }
      let stream = null
      const timer = setTimeout(() => {
        try { stream?.close?.() } catch {}
        reject(new Error('exec timeout'))
      }, timeoutMs || EXEC_TIMEOUT)
      c.exec(cmd, (err, st) => {
        if (err) { clearTimeout(timer); reject(err); return }
        stream = st
        let out = ''
        st.on('data', (d) => { out += d.toString() })
        st.stderr.on('data', () => { /* 采集命令已 2>/dev/null，忽略 */ })
        st.on('close', () => { clearTimeout(timer); resolve(out) })
      })
    })
  }

  emit() {
    this.onStatus?.({
      connected: this.connected,
      host: this.host,
      attempts: this.attempts,
      retryDelay: this.retryDelay,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    })
  }

  stop() {
    this.running = false
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    const c = this.client
    this.client = null
    this.connected = false
    if (c) { try { c.end() } catch {} }
    this.emit()
  }
}
