# qq-agent-host

把 QQ 聊天桥接成 **DSH 插件**：每个 QQ 会话对应一个进程内 agent，人格/工具/上下文都由 DSH 的
preset 机制管理，不再需要单独跑一个 Node 进程去"遥控" DSH。

## 它解决什么问题

传统做法是让桥接当客户端，通过 HTTP 调 DSH 的会话 API。那样 DSH 的会话生命周期、上下文组装、
prefix cache 全都在桥接外面重新实现一遍，桥接只是个**遥控器**。

这个插件反过来：桥接被搬进 DSH 进程，用 `ctx.agents.create()` 直接建 agent，
用 `ctx.systemPrompt` 注册人格段，用 `ctx.agentPresets.mount()` 挂载 preset。
DSH 负责它擅长的（会话、上下文、缓存），插件只负责 QQ 那一路的收发。

## 依赖

- **DSH** 0.2.x（需要 `ctx.agents` / `ctx.agentPresets` / `ctx.systemPrompt` / `ctx.tools`）
- **SnowLuma**（OneBot v11 网关，提供 QQ 收发；本插件不含它，需自行部署）
- **Node.js** 22+

## 安装

1. 把本目录放进 `~/.dsh/plugins/qq-agent-host`（或用 junction 指过来）。

2. 在 profile 的 `package.json` 里**同时**加两处（只加一处不生效）：

```json
{
  "dependencies": {
    "qq-agent-host": "link:C:/Users/<你>/.dsh/plugins/qq-agent-host"
  },
  "dsh": {
    "profile": {
      "bundles": ["qq-agent-host"]
    }
  }
}
```

3. 复制 `config.example.json` 到项目根的 `config.json`，把 `X` 换成真实值：

| 键 | 含义 |
|---|---|
| `snowluma.wsUrl` / `snowluma.httpUrl` | SnowLuma 的 WS / HTTP 地址 |
| `snowluma.accessToken` | SnowLuma token |
| `consoleToken` | 本地控制台鉴权 token（自己生成一个随机串） |
| `ownerQQ` | 管理员 QQ 号（只有这个人能下指令） |
| `allow.private` / `allow.groups` | 允许的私聊 / 群号 |
| `socialV2.image.allowDirs` | 允许发图的本地目录 |
| `persona.hosts.qq.mainCard` | 主卡文件路径（AGENTS.md 风格） |

4. 重启 DSH。插件默认 `enabled: false`，第一次要先在插件设置里打开
   （避免和正在跑的独立 bridge 抢同一个 QQ 号）。

## 工作原理

```
QQ → SnowLuma → 本插件（bridge.js 内核）→ adapter → DSH 进程内 agent
                                              ↓
                                     systemPrompt.section   ← 人格/角色卡
                                     systemPrompt.context   ← 状态/表情库
                                     ctx.tools              ← qq_* 工具
```

`lib/adapter.js` 把 bridge.js 原本调用的 HTTP API 用进程内服务重新实现了一遍
（`sessions.create/prompt`、`agents.create`、`systemPrompt` 等），
所以 `src/bridge.js` 几乎不用改就能跑在插件里。

## 配置：两个源

这套插件有**两个配置来源**，改的时候很容易漏掉一边：

| 配置项 | 存在哪 | 谁读它 | 生效时机 |
|---|---|---|---|
| `enabled`（总开关） | 插件的 `Config`（DSH settings） | `apply()` 决定是否 `startBridge()` | **重启 DSH** |
| `agentPreset` | 插件的 `Config` | 建 agent 时用 | **重启 DSH** |
| SnowLuma 地址 / token | `config.json` | `src/bridge.js` 的 `loadConfig()` | **重启 DSH** |
| `consoleToken` / `ownerQQ` / `allow.*` | `config.json` | 同上 | **重启 DSH** |
| 当前副卡 | `state/session-roles.json` | 每次装配时读 | **立即** |

### 设置页怎么做

设置页（`client.js`）**读写 `config.json`**（所见即所得），`enabled` 和 `agentPreset` 另走 `ctx.settings`。

**踩过的坑**：改成读写 `config.json` 之后，`enabled` 被漏掉了 —— 它不在那个文件里，于是：
- `GET /config` 不返回它 → 界面拿到 `undefined` → 开关永远显示关闭
- `POST /config` 不处理它 → 保存被静默忽略

**而且不报错。** 现在有两条断言盯着（`scripts/test-agent-host-smoke.mjs` 里的「设置接口对 enabled 双向处理」）。

### 为什么不做成单一配置源

`enabled` 必须在 DSH settings 里（插件装载时就要知道它，那时还没读 `config.json`）；
其余配置必须在 `config.json` 里（独立进程模式的 `start.bat` 也读同一份）。

**所以两源是结构性的，不是设计失误**——但要在文档和代码里都明确分流。

## 几个容易踩的坑

**① 访问 DSH 服务必须先写进 `inject`**

cordis 里访问未声明的服务会**直接抛** `cannot get property "x" without inject`，
不是返回 undefined——所以 `ctx.foo?.bar` 的 `?.` 救不了。

**② `meta.agentPreset` 只是标签**

它不会挂载 preset。真正挂载是 `ctx.agentPresets.mount(agentCtx, id)`，
参数必须是 **setup 回调里的 agentCtx**。不调的话 agent 的 system prompt 里
**没有任何 preset 内容**——没有人格、没有安全规则，而且不报错。

**③ 会话要手动归属工作区**

`cwd` 相同只决定文件落哪个目录，不建立归属关系。不调 `Workspace.attachSession()`
的话 GUI 里那个会话会是"未命名"/孤立条目。

**④ Config 里必须有 `volatile` 字段，否则插件在设置页里根本看不见**

这条最坑：插件功能完全正常、日志也对，但用户在 DSH 设置页找不到它，**也就没法开关**。

`dsh-settings` 的 `describe()` 会用 `volatileForm(schema)` 过滤每个插件：
```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema);
  if (schema.type === "object") { /* 递归保留 volatile 子字段 */ }
  // 一个 volatile 都没有 → 返回 undefined → 这个 entry 被 describe() 跳过
}
```

**注意写法**：DSH 内部用的是 `z.xxx().volatile()`，但那是**客户端**给 `Schema.prototype`
打的补丁（`dsh-client-connection/lib/client.js`），插件侧这份 schemastery 没有这个方法。
直接往 meta 上写即可（`describe()` 读的就是这里）：

```js
const markVolatile = (schema) => { schema.meta.volatile = true; return schema; };
export const Config = z.object({
  enabled: markVolatile(z.boolean().default(false)),
});
```

**⑤ ESM 里没有 `require`**

即使在函数体内，调用时也会炸。用 `import`。

## 测试

```bash
node scripts/test-agent-host-smoke.mjs      # 插件加载冒烟（require/inject/返回值形状）
node scripts/test-agent-host-adapter.mjs    # 适配层契约
node scripts/test-role-card-section.mjs     # 角色卡 section 注册与动态求值
node scripts/test-runtime-context.mjs       # 运行时面板走 context
```

前两个不需要 DSH、不需要 SnowLuma，纯静态 + mock 就能跑。
它们专门盯上面五个坑里的前三个——那些错误只在启动期暴露，而且往往**静默**。

## 已知限制

- 只支持 **reserved2**（二代仿真）模式的工具面
- 上下文压缩（一席/切段）未实现，长会话会持续增长
- `list_agents` 等少数工具的 restrict 时序不完美（有运行时 guard 兜底）
- 依赖 SnowLuma，不内置 QQ 协议实现
