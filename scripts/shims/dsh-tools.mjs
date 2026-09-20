// self-test shim：@deepseek-ai/dsh-tools 的本地替身（真身由 DSH 宿主提供）
// defineTool 恒等：原样返回工具定义，仅供 self-test 加载 lib/index.js 时解析，不触发宿主注册行为。
export function defineTool(def) { return def }
