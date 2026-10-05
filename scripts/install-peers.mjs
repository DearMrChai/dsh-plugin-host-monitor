// scripts/install-peers.mjs — 把 DSH 自带的「插件运行时依赖」拷进本包 node_modules。
//
// 为什么需要：桌面端用 `link:`（junction）装载本插件时，Node 按**插件真实路径**解析裸导入，
// 走不到 DSH 的模块回退目录（$DSH_HOME/profiles/node_modules，那里才有 @deepseek-ai/*）。
// 插件以前能用是因为它当时是 profile 下的实体目录；改成 junction 后必须自带这些依赖，
// 否则加载器只报一句 `failed to import`（真异常被 logger 吞掉，小窗整块消失）。
// ssh2 走 npm 装（package.json dependencies），本脚本只处理 DSH 内部包及其运行时依赖闭包。
//
// 用法：node scripts/install-peers.mjs            （自动探测 DSH 安装位置）
//       DSH_SRC=<含 @deepseek-ai/schemastery 的 node_modules> node scripts/install-peers.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DST = path.join(PKG_ROOT, 'node_modules')
const ROOTS = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools']

const CANDIDATES = [
  process.env.DSH_SRC,
  'D:/DevEnv/npm-global/node_modules/@deepseek-ai/dsh/node_modules',
  'C:/Users/Marvin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules',
  path.join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules'),
].filter(Boolean)

const src = CANDIDATES.find((p) => fs.existsSync(path.join(p, '@deepseek-ai/schemastery')))
if (!src) {
  console.error('找不到 DSH 安装目录（里面应有 @deepseek-ai/schemastery）。请用 DSH_SRC=<path> 指定。')
  console.error('候选：\n  ' + CANDIDATES.join('\n  '))
  process.exit(1)
}
console.log('源：' + src)

const req = createRequire(path.join(src, 'anchor.js'))
const pkgRoot = (name) => {
  try { return path.dirname(req.resolve(name + '/package.json')) } catch { /* 包未导出 package.json */ }
  try {
    let dir = path.dirname(req.resolve(name))
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      dir = path.dirname(dir)
    }
  } catch { /* 见下 */ }
  return null
}

const seen = new Set()
const queue = [...ROOTS]
const copied = []
const missed = []
while (queue.length) {
  const name = queue.shift()
  if (seen.has(name)) continue
  seen.add(name)
  const dir = pkgRoot(name)
  if (!dir) { missed.push(name); continue }
  const target = path.join(DST, name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(dir, target, { recursive: true })
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  copied.push(`${name}@${j.version}`)
  for (const d of Object.keys(j.dependencies ?? {})) queue.push(d)
}

console.log('已安装（' + copied.length + '）：\n  ' + copied.join('\n  '))
if (missed.length) console.log('未找到（源里没有，插件若用到需另想办法）：' + missed.join(', '))
