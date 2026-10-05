# dsh-plugin-host-monitor — 服务器监控（142 零部署）

SSH **持久拉取**远程推理服务器 infer-142（192.168.31.142 / ZeroTier 10.226.127.71）的
GPU×2 温度/使用率/显存、CPU 温度/使用率、内存使用率、vLLM（请求/tokens/时延/缓存/模型名）；在 DSH 内呈现为：
侧栏**状态胶囊**（实时数值 + 告警标色 + IP 下拉切换）、Agent 工具（state/summary/events）、设置卡（IP/阈值可调）。

> 资源策略：**本机多耗、142 零负担**——142 上不部署任何进程/服务/文件，只被动响应 sshd 执行一条采集命令。

## 架构

```
142 (Ubuntu, 2×RTX 2080 Ti)         本机 Windows (DSH)
┌──────────────┐   SSH 持久连接     ┌────────────────────────────┐
│ 仅 sshd 响应  │ ◀────────────── │ DSH 插件 dsh-plugin-host-monitor
│ nvidia-smi    │   每 3s 一条命令   │  ssh2 持久通道（重连退避）    │
│ /proc/stat    │ ──────────────▶ │  → 环形历史 24h ≈2.88万条     │
│ hwmon/thermal │   解析回填        │  → 阈值告警事件引擎          │
│ /proc/meminfo │                  │  → 状态胶囊 / tools / 设置卡  │
└──────────────┘                  └────────────────────────────┘
```

SSH 采集命令（全 stdlib、无 sudo、142 零改动，分段标记 #S/#T/#M）：
```sh
nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits; echo '#S'; grep '^cpu ' /proc/stat; echo '#T'; <coretemp/k10temp 最大温度>; echo '#M'; grep -E '^MemTotal|^MemAvailable' /proc/meminfo
```
> 推理指标（/metrics + /v1/models）自 0.5.0 起**不再走 SSH**：DSH 宿主机直连 HTTP 取（见下方 0.5.0 章节），
> 地址由 `vllmBaseUrl` 配置、`{host}` 占位符跟随胶囊所选 IP。

## 设置项（设置卡 · 插件名 host-monitor）

| 字段 | 默认 | 说明 |
|---|---|---|
| host | 192.168.31.142 | 下拉切换：局域网 / ZeroTier（胶囊里也有同款下拉） |
| sshUser / sshPass | （空）/（空） | SSH 凭据代码不内置默认值——设置卡填写或 cordis.patch.yml config 提供；仅存本机 DSH 设置文件 |
| intervalMs | 0 | 采样间隔（**0 = 默认关闭采集**，小窗频率下拉选秒数即手动开启；关闭时 SSH 断开、监控数据重置；其余 1000~60000），142 资源≈0（仅每周期一条命令） |
| maxSamples | 28800 | 24h @3s 环形历史（内存，重启清零） |
| thresholds | 默认 | GPU>82℃ 预警 / >90℃ 危险；CPU>75℃ / >85℃；内存>90%；GPU 使用率连续 5 帧≥95%；vLLM KV 缓存>85%、请求排队≥8（连续 3 帧） |
| simulate | false | 模拟模式：不连 142，本地生成演示数据 |
| showGpu / showVllm / showCpu | true | 小窗模块显示勾选：显卡块 / 推理块 / CPU·内存块 是否显示（收起态三槽同步遵循） |
| vllmBaseUrl | http://{host}:8000 | 推理入口地址（0.10.0）：llama-swap 统一入口或 vLLM/llama.cpp 直连地址；swap 在时自动换臂端口取 /metrics 与 /v1/models，非 swap 当直连后端；支持 `{host}` 占位符=当前所选目标 IP（跟随 ZeroTier/局域网切换） |
| vllmModelName | （空） | vLLM 模型名手动兜底（可选）：自动读取 /v1/models 失败时显示此值；**留空 = 不兜底**，推理服务器离线时模型名显示空/「无」（不再显示旧默认值） |
| probeIntervalMs | 60000 | llama.cpp（llama.cpp-new）速率/时延探针间隔：每 intervalMs 发一发 64-token 小请求读服务端自计时 timings（TTFT/TPOT/输入速率/生成速率）；0 = 关；vLLM 引擎不受影响 |

## vLLM 监控（0.3.0）

- **模型名自动读取**：每周期 GET `${vllmBaseUrl}/v1/models` 取 `data[0].id`，模型换了界面自动跟（产生 `vllm_model` 事件）；读不到（如开了 API Key 鉴权）时回退设置卡 `vllmModelName` 手动值
- **监控指标**（/metrics）：运行中/排队/被抢占请求、KV 与 GPU 缓存使用率、累计生成/输入 tokens（及每秒速率，本机差分计算）、TTFT 首字时延、TPOT 单字输出时延、E2E 请求时延（histogram 均值）
- **地址可配置**：默认服务器本机回环 `http://127.0.0.1:8000`；设成 `http://{host}:8000` 即跟随胶囊里选的 ZeroTier/局域网 IP

> ⚠️ **142 实测发现（2026-08-31）**：当前 Qwen3-27B MTP 分支 vLLM 的 `/metrics` 只导出 prometheus-client 基础指标（`python_gc_*` 等，约 1.9KB），**没有 `vllm:*` 指标** → 运行/排队/KV/tokens/时延这些指标暂时取不到，卡片显示「当前进程暂无 /metrics 数据」；**模型名不受影响**（`/v1/models` 自动读取已实测生效，显示为 `qwen27b-int4-fp16kv-256K-mtp3-text-only-cu128`）。待确认 MTP 分支的指标开关或换标准 vLLM 后自动恢复（插件无需再改）。

## 小窗交互（0.2.0）

- **进度条展示**：GPU 温度大字 + 使用率条 + 显存条；CPU 温度/使用率、内存条（颜色随阈值：正常→预警橙→危险红）
- **频率下拉**（小窗内）：1s/2s/3s/5s/10s/30s/60s/**关闭**，即选即生效（后端 `/monitor/api/config` 热切换，无需重启；选「关闭」= 停止采集 + 断开 SSH，小窗显示「已暂停」，适合推理机临时关机时不再反复重连）
- **vLLM 卡**（0.3.0）：标题=模型名（自动读取/兜底值）；运行/排队请求、KV 空间使用率进度条、生成/输入 tok/s、TTFT/TPOT 时延、累计生成 tokens、被抢占次数
- **收起后也可拖动**：按住小浮钮拖拽移动，点一下才展开（移动超阈值不触发展开）

## UI 设计要点（本轮落地，与功能并行维护）

### ⑥ 状态点取舍（“字前圆点”）
- **板块内每个指标前不放圆点**（早前设想的“指标前原点”已否决）——状态改由「数值文字颜色 + 进度条填充色 + 卡闪烁」来表达。
- 只保留板块**外**的状态点：展开态页头左上连接点、收起信息条左端**在线状态色块**（替代原「小圆点 + 监控」二字，高 12px 与文字上下沿对齐，暂用当前状态色）+ `GPU0/GPU1` 状态色。
- 每张 GPU 是**顶层卡**（无外层“GPU ×2”包裹），各自独立边框、各自按自身温度/使用率闪烁。
- GPU 板块**不可折叠**。
- GPU 使用率 / CPU 使用率：仅保留 sparkline 折线**去进度条**；保留进度条的：GPU 温度、显存、CPU 温度、内存、KV、TPOT、MTP。
- 全界面**不用加粗**区分层级（只靠字号 + 颜色）。
- 配色为**主题感知**（读 `--dsw-alias-bg-base` 亮度切浅/深两套），**已按方案 A 落地**（见 `docs/配色方案-交接.md`）：正常数值中性化（不再成片绿）、进度条 ok 填充=模块身份色（GPU 蓝 / 推理青 / CPU 绿三色可辨）、CPU 身份色 `#4dc9a0/#158a63`（与语义 ok 绿不同）、语义 ok 绿仅正负型指标（MTP≥70、连接、推理状态）。

### ⑧ 板块闪烁的报警条件
触发逻辑在 `lib/client.js`：**连续 3 次刷新仍维持同一等级才闪**（`SUST=3`），回落即停——避免临界抖动闪屏。

| 板块 | 危险闪烁 danger | 警告闪烁 warn |
|---|---|---|
| GPU（每卡独立） | 温度 ≥ **90℃** | 温度 ≥ **82℃**，或 使用率 ≥ **95%** |
| CPU · 内存 | CPU 温度 ≥ **85℃** | CPU 温度 ≥ **75℃**，或 CPU 使用率 ≥ **90%**，或 内存 ≥ **90%** |
| 推理 | （无 danger 级） | KV 缓存 ≥ **85%**，或 排队等待 ≥ **8 个** |

阈值来自 `status.cfg.thresholds`，设置卡可调（`gpuTempWarn/Danger`、`cpuTempWarn/Danger`、`memPctWarn`、`gpuUtilHigh`、`vllmKVWarn`、`vllmWaitingWarn`）。

## Agent 工具

- ```host_monitor_state``` — 最新帧 + 连接状态 + 当前告警（currentHost/health）
- ```host_monitor_summary``` — 最近 N 分钟聚合（GPU/CPU/内存均值与峰值）
- ```host_monitor_events``` — 告警/恢复/连接事件批次

## HTTP 路由（胶囊数据源）

- ```GET /monitor/api/status``` · ```/monitor/api/summary?minutes=``` · ```/monitor/api/events?n=```
- ```GET /monitor/api/host?host=192.168.31.142|10.226.127.71``` — 胶囊下拉切目标
- ```GET /monitor/api/reconnect``` — 手动重连
- ```GET /monitor/api/refresh``` — 手动刷新：采一帧（硬件+推理）+ 补拉一次模型名

## 安装（装入 web profile）

1. 编辑 ```%USERPROFILE%\.dsh\profiles\web\package.json``` 的 dependencies 增加
   ```"dsh-plugin-host-monitor": "file:<本仓库克隆路径>"```，并在该目录 ```pnpm install```
2. ```profiles/web/cordis.patch.yml``` 追加行（**必须写 inject**，cordis 只认 patch 行的 inject）：
   ```yaml
   - id: host-monitor
     name: dsh-plugin-host-monitor
     inject: [settings, tools]
     config:
       enabled: true
       host: '192.168.31.142'
       intervalMs: 3000
   ```
3. 新 entry 会触发热重载重新 import；若胶囊/工具未出现，重启 DSH 进程。
4. 验证：```GET /monitor/api/status``` 有数据 = Host 生效；侧栏出现胶囊 = Client 生效。

## 排坑（DSH 插件铁律）

- patch 行没写 ```inject: [settings, tools]``` → 状态全绿、工具/设置卡全无（先查 ```/api/settings.describe```）
- 改 lib/ 产物不触发热重载 → 必须重启 DSH 进程
- **profile 的 file: 安装是拷贝（非符号链接）**：改源目录里的 lib 后，要同步到
  `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-plugin-host-monitor\lib`（Copy-Item 或 pnpm install）再重启，否则加载的是旧拷贝（实测踩坑）
- CPU 温度读不到（hwmon 无 coretemp）→ cpuTempC=null，其余指标不受影响

## 自测 / 真机验证

```sh
node scripts/self-test.mjs          # 纯逻辑自测（无网络）
# verify 脚本凭据走环境变量（代码不含任何默认凭据）：
HM_SSH_USER=用户名 HM_SSH_PASS=密码 node scripts/verify-142.mjs         # 真连目标机跑采集命令并解析
HM_SSH_PASS=密码 node scripts/verify-142.mjs 10.226.127.71   # 走 ZeroTier
```

## 变更记录

### 0.10.0（推理面适配 llama-swap：入口探测 + 臂端口取数 + 换臂会员跟随）
- **背景**：142 推理架构换代为 llama-swap + vLLM（:8000 成统一入口，按模型名路由，臂动态起停、端口由 swap 自 8010 起分配）；旧逻辑「:8000 就是 vLLM」直拉 `/metrics`/`/v1/models` 失真——swap 的 `/metrics` 只出 `llamaswap_*` 不透传 `vllm:*`，`alive` 判据（`vllm:*` 有无）在臂 ttl 到点卸载时误报「服务消失」
- **取数三分支**（`lib/http-metrics.js` 新增 `fetchInference`/`fetchSwapStatus`/`fetchCatalog`/`armUrlFromProxy`）：每周期先探 `{base}/running`——
  - **200+JSON = llama-swap**：取首个 `state=ready` 臂，把其 `proxy`（如 `http://localhost:8012`）的本机地址改写为目标 IP 后去**臂端口**取 `/metrics`（+ 低频 `/v1/models`）
  - **404/非 JSON = 直连形态**：退回旧行为（base 端口直接当 vLLM/llama.cpp）——兼容日后拆掉 swap
  - **连接失败 = 入口失联**（state=down，触发原「连续 2 帧消失」告警）
- **状态语义**（frame/state 新增 `swap: { up, state, armId, armPort, loadingArm }`）：`armed`（臂在跑）/`idle`（无臂装载，**中性正常态**，不告警）/`loading`（换臂加载中）/`direct`（非 swap）/`down`（入口失联）。核心事件引擎分三支：`vllm_start`（恢复）、`vllm_idle`（💤 未装载 info）、`vllm_swapping`（🔁 换臂中 info）；仅 `down`/直连无数据才累计 `vllm_stop` warn
- **模型名跟随换臂**（`index.js` followArmName）：/running 每周期已报告 ready 臂（零额外请求）；臂 id 变化才刷新——同臂命中「臂 id→served 名」缓存直接设，新臂低频拉一次其 `/v1/models`（served 名由 useModelName 固定，同臂不变）；refresh 按钮/开采集/切频率走 swap 感知的 `refreshInferenceName`
- **新 vLLM fork 指标改名适配**（2026-10 于 142 实测）：TPOT 先认 `request_time_per_output_token_seconds` 新名、旧名 fallback；`gpu_cache_usage_perc`/`num_requests_swapped` 上游已删 → 相应字段 null（卡片 —、告警自动跳过）
- **小窗**：推理卡无数据态**只用右上状态位表达、不再加说明行/占位行**——`模型未装载`（无臂，闲置自动释放）/`换臂中`/`入口掉线`/`指标缺失`（臂 ready 但取不到 `vllm:*`）/`离线`（非 swap 直连形态无数据）；标题在无臂时只显示「推理」（不残留上次模型名）、换臂中显示「加载中 {臂名}」；armed 时直接进指标行（**无**「入口 · 臂」小字）
- **数据/配置**：`vllmBaseUrl` 语义变「推理入口地址」（默认值不变）；无新增配置项；硬件半（SSH GPU/CPU/内存/网速）0 改动
- 自测：`scripts/self-test.mjs` 新增 swap 三分支/目录探测/新名 TPOT/状态机事件用例（本地 HTTP stub，无需 142）
- **⚠ 装载依赖（桌面端 `link:` 装法必读）**：本包运行时依赖必须真实装在自己的 `node_modules` 里——
  `npm install`（装 `ssh2`）+ `node scripts/install-peers.mjs`（从 DSH 安装目录拷入 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 及依赖闭包）。
  原因：桌面端以 junction 直连本仓库时，Node 按**插件真实路径**解析裸导入，走不到 DSH 的模块回退目录
  （`$DSH_HOME/profiles/node_modules`，那些 DSH 内部包只在那里）；缺任一依赖 → 插件列表只报 `failed to import`（真异常被 logger 吞掉）、小窗整块消失。
  自测 `[0]` 已内置这三项预检，缺了会直接报错并给出修复命令

### 0.9.0（桌面端 0.2.0 兼容）
- DSH 桌面端 0.2.0-rc.2 的 dsh-settings 重构（`register`/`watch` 已删）→ host 半 apply 能力探测（无 register 则跳过 namespace 闭环，config 由 `apply(ctx, config)` 参数直接给出）；client 半 inject 只留 slots（桌面端无 settingsScope 服务，设置卡缺席自动跳过）；详见 commit c615876

### 0.8.1（条测改刷新：一键采一帧 + 补拉模型名）
- **撤「条测」按钮**：小窗设置行的「条测」（进度条测试：循环 ok/warn/danger 假填充、不影响真实数值）及其全部关联代码移除——`barTestMode`/`BAR_TEST`/`barEff`/`cycleBar` 状态与离线推理卡的空壳兜底一并清理
- **换成「刷新」按钮**：点击立即在后端 `poll()` 采一帧（硬件 GPU/CPU/内存 + 推理指标），并 `refreshModelName()` 补拉一次 `/v1/models` 模型名——解决「模型名只在开启采集/切频率时拉一次、切换模型后名字陈旧」的原始诉求；采集关闭（intervalMs=0）时按钮置灰，采集开启时立即出新数据与新模型名
- **后端**：新增 `GET /monitor/api/refresh` 路由；`cfgSnapshot()` 抽取供 status/refresh 共用，避免配置快照重复

### 0.8.0（采集可关闭 + 默认关闭 + 阈值默认值单一真源）
- **默认关闭、手动开启**：Config schema `intervalMs` 默认改为 0、cordis.patch.yml 显式 `intervalMs: 0`——DSH 启动后监控不自动采集（小窗显示「监控 · 已暂停」），需要时在小窗频率下拉或设置卡选秒数即手动开启；重启后保持关闭状态（`createInstance` 的 `intervalMs` 读取同步改为 `?? 3000`，0 不再被 `||` 兜底成 3000 而复活）
- **频率下拉加「关闭」**：小窗频率下拉新增「关闭」选项（intervalMs=0）——停止轮询采集并断开 SSH 连接（不再反复重连退避），小窗显示「已暂停」；重新选回频率即恢复（重新连 SSH + 恢复轮询）。后端 `/monitor/api/config?intervalMs=0` 同样生效，路由验证改为「0 或 1000~60000」；Config schema `intervalMs` 放宽为 `z.natural().max(60000)`（0=关闭）。前端 `intervalMs` 读取由 `|| 3000` 兜底改为 `?? 3000`——0 不再被兜底成 3000（否则下拉选「关闭」后仍显示最后一次的秒数）
- **关闭时重置监控数据**：`core.reset()` 新增——清空环形历史/最新帧/采样数/告警/速率基准（prevCpu/prevVllm/prevNet/MTP 滑窗）/模型名/CPU 型号；选「关闭」时调用，小窗不再停留最后采集的温度/显存/使用率等旧数据，显示「已暂停」空态
- **移除模型名硬编码兜底**：旧默认 `vllmModelName: 'qwen27b-int4-fp16kv'` 三处硬编码（Config schema / createInstance / simulateTick）全部改空——推理服务器离线时模型名显示空（「暂无运行中的模型」），不再显示错误的默认名；如需要可手动在设置卡填一个兜底名
- **阈值默认值单一真源**：`core.js` 导出 `DEFAULT_THRESHOLDS`（16 字段完整默认值），`MonitorCore` 构造函数与 `index.js applyConfig` 共用同一常量——修复旧 applyConfig 手写 9 字段兜底导致的三个问题：① `cpuTempWarn` 70→75、`memPctWarn` 70→90、`vllmKVWarn` 70→85 悄悄跳值；② 缺失 7 个字段（memPctDanger/gpuUtilWarn/gpuUtilDanger/vramWarn/vramDanger/vllmKVDanger/mtpOk/mtpWarnMin）变 undefined 致对应告警静默失效；③ 死字段 `gpuUtilHigh` 移除。**触发场景**：用户在小窗切频率或切主机时 applyConfig 被调用，旧代码会污染 `core.th` 直到重启 DSH——本次一并修复
- **模块显示勾选**（设置卡）：新增 `showGpu` / `showVllm` / `showCpu` 三个布尔勾选项——小窗显卡块 / 推理块 / CPU·内存块 是否显示（默认全开）；收起态三槽贪心同步遵循（如关 GPU 则收起条不再填 GPU 温度/使用率槽）
- **模型名低频拉取**：`/v1/models` 不再每周期与 `/metrics` 并行请求——新增 `fetchModels()` 单独拉取，仅在**开启采集 / 切换频率 / 切换主机**（applyConfig 触发）时取一次并 `core.setModelName()` 更新（变化仍记 `vllm_model` 事件）；`fetchInferenceMetrics()` 加 `opts.models` 参数（周期轮询传 false）；llama 探针的 model 改从低频更新的 `core.vllmModelName` 取
- **设置卡补注册（根因修复）**：client.js 此前**从未注册 `settings.plugin.item` 插槽**（仅注册 `shell.overlay` 浮动小窗）——DSH 新版设置界面只显示显式注册卡片的 namespace，故「设置→插件→插件配置」里 host-monitor 卡片整个消失（task-notify 可见、host-monitor 不可见；API 直查 settings/describe 确认 namespace 已注册、插件 fiberPhase=active）。仿 task-notify 补齐：新增 `MonitorSettingsCard`（Plugins 标签页卡片，--dsw-alias-* 设计令牌内联样式，字段含目标主机下拉 / 采集频率下拉（含关闭）/ **模块显示三勾选（showGpu/showVllm/showCpu）** / 模拟模式 / SSH 账号密码 / 推理服务地址 / 模型名兜底 / 探针间隔 / 告警阈值 16 项折叠子区，草稿式保存/放弃）+ `ctx.slots.inject('settings.plugin.item', ...)`（key='host-monitor'，value/set 绑定 `ctx.settingsScope`）；inject 数组加 `settingsScope`；注册失败仅 warn 不影响浮动小窗
- **设置卡改动即时生效（根因修复）**：设置卡保存只更新 settings namespace，实例 cfg 此前是 apply 时的静态快照——API 直查 `settings/describe` 已见新值（showGpu=false）但 `/monitor/api/status` 仍返回旧值。修复：`ctx.settings.register` 返回值保留为 `scope`，`scope.watch((next, prev) => ...)` 把**变化的字段**喂给 `applyConfig` 同步实例；同时优化 `applyConfig`——仅当**频率变化（开/关/换频）或连接参数变化（host/端口/账号/密码/模拟）**才重启 SSH，仅模块显示/阈值等变化只更新 cfg 不重连、不清数据
- **设置卡保存后 UI 即时同步（时间差修复）**：勾选→保存链路本身正常（后端/浮窗即时生效），但保存后组件立即清空草稿回退读 `value`（settings describe 快照**异步刷新有延迟**）——卡片界面短暂显示保存前的旧勾选，需刷新才同步。修复：新增 `local` 本地固化基准（`base = local ?? value`），保存时把草稿合并为新基准 `setLocal(next)` 立即反映，不再依赖 describe 快照刷新；外部对 settings 的修改仅通过本卡片（小窗频率/主机走 /monitor/api/* 不改 namespace），无冲突
- **设置卡刷新后首渲染同步（二次刷新修复）**：`local` 仅是 React state，页面刷新后重置为 null——刷新后首次打开设置卡仍读 describe 快照（同步延迟）显示旧勾选，需再刷新才正常。修复：`local` 持久化到 `localStorage['dsh:host-monitor:settings-local']`（初始化时恢复、保存时写入），刷新后首渲染即恢复保存值，完全绕开 describe 快照时序；host-monitor 的 settings 仅由本卡片修改，local 与后端值始终一致
- 自测 93 项通过（Config 默认值断言、阈值合并逻辑均兼容）

### 0.7.0（服务器网速 + 探针实测速率/时延 + 小窗瘦身）
- **服务器网速**（页脚）：SSH 采集命令新增 `#N`（`cat /proc/net/dev`）与 `#P`（`ip -br addr`）段；帧差值算**整机物理网口合计**上传/下载速度（lo 除外；单口计数回退=网卡重置时跳过该口并重置基准）；页脚显示 `↑ 上传 ↓ 下载`，悬停看参与网口名（如 `enp7s0+ztcdclbt2b`）与分口速率
- **探针实测 TTFT/TPOT/速率**（修 llama build /metrics 请求级批量上报导致的「速率大多帧为 0 + 请求结束尖刺」「TTFT/TPOT 恒 —」）：新增 `lib/probe.js`——每 `probeIntervalMs`（默认 60s）向推理服务发一发 64-token 小非流式请求，读服务端自计时 `timings` 块（nonce 随机前缀保证完整 prefill）；引擎为 llama.cpp 时帧四字段（ttftMs/tpotMs/genTokPerSec/promptTokPerSec）改由实测值覆写（新鲜窗口 `max(3×interval, 180s)`）；vLLM 引擎继续走 /metrics 计数器差值 + 直方图均值
- **撤皮肤/试闪按钮**：皮肤固定为方案 A（数值中性 + 模块身份色条，深浅色自动跟随 DSH 主题）；条测按钮移到设置行（目标/频率旁）；localStorage 旧 `skin`/`flashMode` 字段静默忽略
- **数据/配置**：frame 新增 `net`（upBps/downBps/ifname/parts）与 vllm.engine（`vllm`/`llama`）；state 新增 `probeAt`；设置新增 `probeIntervalMs`（0=关）
- 自测 93 项通过：[0] 冒烟=模块真实装载+Config 全默认/非法值断言（提前拦截宿主 API 失配类问题，不必等 DSH 重启才暴露）；[13] 网速解析+帧差值、[14] applyProbe/llama 覆写/vLLM 不受影响/陈旧探针、[15] probeInfer 本地 stub 端到端

### 0.6.0（面板视觉升级：统一配色 + sparkline 曲线 + 状态胶囊 + 告警闪烁）（工作态迭代，0.6.x 收尾）
- **收起条分隔符去掉 width**：收起信息条的 `｜` 不再定宽槽位（原硬编码 22px / 运行时实测 19px），改用自然字符宽度，容器定宽同步为 `Z1+Z2+Z3+2×SEP_W`（SEP_W=实测 `｜` 宽）
- **MTP 接受率改 60s 滑窗**：`specAcceptRate` 从「累计 accepted/draft」改为「近 60s ΣΔacc/ΣΔdraft」（`core.ingest` 计算），空闲无新生成 → null（卡片显示「—」），修复「会话没进行也一直 100% 不动」；计数回退（推理进程重启）自动重置基准；「MTP draft / acc」行仍显示进程启动以来累计
- **GPU 去嵌套**：去掉外层“GPU ×2”整卡包裹，每张 GPU 直接为顶层卡、各自独立边框与各自闪烁
- **去加粗**：全界面移除 fontWeight，仅靠字号+颜色区分层级
- **使用率改为纯折线**：GPU/CPU 使用率去掉进度条、保留 sparkline；带进度条仅剩温度/显存/内存/KV/TPOT/MTP
- **去“字前圆点”**：板块内指标前不再有点；保留页头连接点 + 收起信息条连接点 & GPU0/GPU1 状态点
- **试闪按钮**（0.7.0 已撤）：面板底部，强制三卡 danger 呼吸演示
- **持续闪烁**：客户端按“连续 3 次刷新维持同一等级”才闪，摆脱对 history 帧字段名的依赖
- **首帧空指针修复**：`mtpLv` 等无条件访问改为可选链，`shell.overlay` 不再首帧崩溃（曾导致浮窗整块不显示）
- **防越界**：恢复保存位置时钳回可视区，杜绝“拖到屏外找不到浮窗”
- **收起条样式**：去「监控」二字与小圆点，左端改为在线状态色块（与文字上下沿对齐，暂用当前状态色）；数据项（gpu0/gpu1/t-s/运行·排队）改为等宽槽位横向均匀分布；右侧 ●/○ 连接字符并入色块一并去掉
- **方案 A 配色落地**：`mRow` 数值正常态→中性主文字（`valCol`；正负型传 `semantic` 单独走语义色）；`bar`/`mBar` 新增 `okFill`，ok 态进度条填充=模块身份色（显存/温度/内存=GPU 蓝·CPU 绿，KV/TPOT=推理青）；MTP 接受率为正负型（数值+条 ok=语义绿）；CPU 身份色改 `#4dc9a0/#158a63`；收起条 t/s 数值中性化；展开页头连接字符在线绿/离线红
- **整面板拖拽 + 边缘磁吸**（~28px 贴边）
- 配色为主题感知浅/深两套；深浅调优待单独迭代

### 0.7.0（风扇功能彻底退役 2026-09-10）
- **服务端**：142 上 `fan-control.service`（unit + wants 链接）与 `/opt/host-monitor-fan/`、`/run/host-monitor-fan/` 全删；daemon 不复活
- **触发事件**：2026-09-09 换板（X470 Master SLI + R5 5600）后新板 nct6779 排号从 hwmon2 变 hwmon1，daemon hardcoded 路径全失效成僵尸；背景=挂在双 2080 Ti 缝隙的外挂拆机小风扇曾在自动控制下被跑死，本就不打算续命
- **插件侧**：`ssh.js` 删 #F 段（nct6779 fan1/pwm1 采集）；`core.js` 删 `parseFanOutput` 与帧内 fan 字段；`index.js` 删 `/monitor/api/fan` 路由与 schema fan 字段；UI 卡早在 0.6.0 已去
- **留底**：agent/ 两个文件 + scripts/ 探测安装修复脚本共 16 件整体移入 `归档-fan-退役-20260910/`（留底不删）
- 备注：2080 Ti 双卡自此由板载固件自管温度曲线；外挂风扇如再需接回新板在 hwmon1/fan2（实测 1584rpm 在转）
- 变更清单同步：README 采集命令段、index.js 头部注释

### 0.6.0（面板视觉升级：统一配色 + sparkline 曲线 + 状态胶囊 + 告警闪烁）
- **配色统一**：每卡 3px 身份色左边条（GPU 蓝 / 推理 青 / CPU·内存 绿），角色色映射（正常=主文字色、warn 橙、danger 红），数值 tabular-nums
- **数据+图形**：新增 API `GET /monitor/api/history?spanMs=&maxPoints=`（24h 环形帧抽稀 ≤240 点）；内联 SVG sparkline：GPU 使用率（1h）、推理生成/处理双曲线（1h，带图例）、CPU 使用率（1h）；TPOT 加量条（0~200ms 刻度）、MTP 接受率条加 50%/70% 分区刻度线
- **状态提示**：每卡头部状态胶囊——GPU「高负载/正常」、推理「空闲/生成中/排队中/排队积压」、CPU·内存「CPU 偏热/内存吃紧/正常」
- **告警闪烁**：告警按 key 精确命中卡片（gpu_temp_N/gpu_util_N→GPU 卡、cpu_temp/mem→CPU 卡、vllm_kv/vllm_queue→推理卡），warn/danger 边框+光晕脉冲；页脚 badge 保留
- **去风扇卡**（UI；数据管道与服务端 fan-ctl.py 原样保留，逐步废弃）
- **累计数据修正**：「累计生成」→「近 1h 生成/处理」（前端窗口差值，窗口不足 1h 自动标「近 X 分」；进程重启计数器回退时显示 —）；原自启动累计值移入 tooltip
- **前端轮询跟随后端**：轮询间隔取 `cfg.intervalMs`（原硬编码 3s）
- 卡标题「vLLM」→「推理」（模型无关）；收起浮钮显示告警数
- 自测 49 项通过（新增抽稀/窗口差值/historyFrames/告警 key 用例）

### 0.5.0（推理指标直连 /metrics，脱离 SSH 远程 curl）
- **背景**：142 由 vLLM 换成 llama.cpp llama-server 后，原 SSH 远程 curl + `grep '^vllm:...'` 前缀失配，vLLM 卡全空；且取数绑死在 SSH 通道与对方构建的服务端点上
- **取数改为双路并行**：SSH 只出硬件帧（GPU/CPU/内存/风扇）；`lib/http-metrics.js` 由 DSH 宿主机原生 fetch 直连 `{vllmBaseUrl}/metrics` + `{vllmBaseUrl}/v1/models`（5s 超时，失败→vllm=null，沿用"连续 2 帧消失"告警逻辑）
- **通用 Prometheus 解析 + 双指标族映射**：`llamacpp:*`（llama.cpp）与 `vllm:*`（vLLM）→ 同一字段形状
  - llama.cpp：requests_processing→运行中、requests_deferred→排队、tokens_predicted/prompt_tokens_total→累计 tokens、predicted_tokens_seconds→TPOT（1000/tps）、spec_decode_num_*→MTP 接受率
  - llama.cpp 无 KV 缓存占比/TTFT/E2E/抢占数 → 相应字段 null（卡片显示 —）
- **模型名兼容**：`/v1/models` 同时支持 vLLM `data[0].id` 与 llama.cpp `models[0].name`（含截断 JSON 正则兜底）
- **默认 vllmBaseUrl 改为 `http://{host}:8000`**（宿主机直连；旧默认 127.0.0.1 只对 SSH 远程执行有意义）
- 自测：`scripts/self-test.mjs` 37 项通过（含 llama.cpp 真实样本、vLLM 样本、本地 HTTP stub 端到端）；`scripts/verify-142-http.mjs` 宿主机直连真机验证

### 0.4.0（UI 风格对齐 + 风扇模块锁定）
- **UI 风格对齐 DSH 设计系统**：所有颜色替换为 DSH CSS 变量（`--dsw-alias-*` 带 `--dsh-boot-*` 回退），支持暗/亮主题自动切换
- **风扇控制模块锁定**：UI 灰化+禁交互，标题标注"（待废弃）"，控制代码（FAN_STAGES/fanSt/fanCmd/refreshFanOnce）已清理
- **保留项**：风扇转速只读显示、服务器端 fan-ctl.py + systemd 服务不变
- **颜色映射**：背景 `#0a0e14` → `color-mix(var(--dsw-alias-bg-base))`，边框 `#1e2a3d` → `var(--dsw-alias-border-l2)`，文字 `#dbe4f0` → `var(--dsw-alias-label-primary)`，次要文字 `#7a8ba3` → `var(--dsw-alias-label-secondary)`
