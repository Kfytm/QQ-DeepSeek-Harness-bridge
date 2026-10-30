// DSH 适配层：把 bridge.js 现在用的 HTTP API（NodeApiClient）换成就地调用
// `ctx.agents` / `ctx.systemPrompt` / `ctx.tools`。
//
// 为什么要这一层，而不是把 bridge.js 里每一处 `api.xxx` 都改掉：
//   bridge.js 有 1.3 万行、几十处 DSH 调用，逐处改既容易漏也很难回滚。
//   这里保持**同样的方法形状和返回值包装**（`{ result: { ok, value } }`，配 `unwrap`），
//   于是 bridge.js 那边只需要换成「用注入进来的 api 而不是自建 NodeApiClient」一行改动。
//
// 与 HTTP 模式的关键语义差别（都是**变好**的）：
//   1. 不再有 `session/prompt` 请求 → 直接 `agent.followup(msg)`；
//   2. 不再需要在 prompt 里塞时间/角色卡/状态 → 由 systemPrompt.section/context 装配；
//   3. 事件不再经过 remote.mux 长连接 → 直接订阅 agent 的生命周期事件。
import crypto from 'node:crypto';
import fs from 'node:fs';

const ok = (value) => ({ result: { ok: true, value } });
const messageId = () => `qq-${crypto.randomUUID()}`;

/** 把一段文本包成 DSH 的 UserMessage（content 只放 text 块）。 */
export function userMessage(text) {
  return {
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'user' }
  };
}

/**
 * 创建适配层。
 *
 * @param {object} deps
 * @param {object} deps.ctx       插件所在的 cordis 上下文（要能拿到 agents / systemPrompt / tools）
 * @param {object} deps.config    插件配置
 * @param {Function} [deps.onAgentCreated]  agent 建好后的回调（用于装 prompt 段/工具）
 * @param {Function} deps.log      日志函数
 */
// ── 只有 QQ 会话（group:群号 / private:QQ号）才配得上 persona 与运行时面板 ──────
//
// 为什么必须判：桥接还会建**黑话学习 agent**（targetKey = `slang-learner`）。它走
// `runtimePanelV2 → getSocialV2State` 这条路，而后者用 `canonicalV2Key` 严格校验 key，
// 非 `group:/private:` 一律 `throw new Error('无效的会话 key')`。
// 那个函数是作为 `systemPrompt.context` 注册的，每轮装配都求值 —— 于是一个本该跑
// 「挑黑话」的 agent，turn/start 之后立刻以 `reason.kind = 'error'` 收尾，日志里
// 只有一行「学习会话 turn 未正常完成：error」，真正的原因被吊在半路的异常里。
const QQ_SESSION_KEY = /^(group|private):\d+$/;
const isQqSessionKey = (targetKey) => QQ_SESSION_KEY.test(String(targetKey ?? ''));

export function createDshAdapter({ ctx, config = {}, log = () => {}, hooks = null, onAgentCreated = null }) {
  /** serverSessionId -> { agent, handle } */
  const live = new Map();
  /** targetKey(group:123 等) -> serverSessionId */
  const keyToSession = new Map();
  /** serverSessionId -> Set<(event) => void> */
  const watchers = new Map();
  /** turn 级收集器：serverSessionId -> collector */
  const collectors = new Map();

  const emit = (sessionId, event) => {
    const set = watchers.get(sessionId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch (error) { log(`event watcher 抛错：${error?.message ?? error}`); }
    }
  };

  // ── 帧队列：喂给 bridge.js 的 pumpMux ───────────────────────────────────
  //
  // bridge.js 用 `for await (const envelope of api.events.mux({}))` 消费事件，
  // 每次拿到 `envelope.payload` 再按 `frame.type` 分派。进程内模式下没有 mux 长连接，
  // 所以这里做一个真实队列 + 异步生成器，把 DSH 的 `session/event` 原样转成同形状的帧。
  // **保留这个形状**是整套改造里最省事的一点：pumpMux 和它下游几百行判定一行都不用改。
  const frames = [];
  const frameWaiters = [];
  const FRAME_QUEUE_MAX = 5000; // 消费端卡死时不能无限涨

  function pushFrame(frame) {
    if (frameWaiters.length > 0) {
      frameWaiters.shift()({ payload: frame });
      return;
    }
    frames.push(frame);
    if (frames.length > FRAME_QUEUE_MAX) frames.splice(0, frames.length - FRAME_QUEUE_MAX);
  }

  function nextFrame() {
    if (frames.length > 0) return Promise.resolve({ payload: frames.shift() });
    return new Promise((resolve) => frameWaiters.push(resolve));
  }

  // ── agent 生命周期 ──────────────────────────────────────────────────────
  // 桥接的调用顺序是 workspace.create({ path }) → sessions.create({ workspaceId })。
  // 工作目录只在前者出现，后者不带 —— 这里记住它，否则 agent 会落在 `_no-cwd` 下，
  // GUI 按 cwd 分组列会话时根本列不出来（表现为「历史加载失败 session/not-found」）。
  let workspacePath = '';
  /** 真实的 Workspace 实体（create 返回的那一个），rename 要靠它改标题。 */
  let workspaceEntity = null;

  /**
   * 给会话起名。DSH 的标题服务有 rename(session, title)，同步生效。
   * 起不出来不影响主流程，所以整段吞掉异常。
   */
  function setTitle(agent, sessionId, targetKey) {
    const service = ctx.sessionTitle;
    if (!service?.rename) return;
    const [, kind, id] = /^(private|group):(\d+)$/.exec(String(targetKey)) ?? [];
    const label = kind === 'group' ? 'QQ 群' : kind === 'private' ? 'QQ 私聊' : 'QQ';
    const title = id ? `${label} · ${id}` : `${label} · ${sessionId}`;
    try {
      service.rename(agent.session, title);
    } catch (error) {
      log(`[adapter] 设置会话标题失败 ${sessionId}：${error?.message ?? error}`);
    }
  }

  async function createAgent({ targetKey, agentPreset, cwd }) {
    const sessionId = `qq-${targetKey.replace(/[^a-zA-Z0-9]+/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: cwd || workspacePath || undefined, agentPreset },
      // 注意 setup 是 async：挂载 preset 是异步的，而且**必须在注册自己的 section 之前**
      // 完成 —— preset 会注册它自己的 persona section，顺序反了会被我们的内容盖掉。
      setup: async (agentCtx, agent) => {
        // ★ 真正挂载 preset。少了这一步，这个 agent 的 system prompt 里**没有 preset 的任何内容**
        //   （主人格、底线、安全规则、思考语言全都没有），只剩我们插件自己注册的那几段。
        //   meta.agentPreset 只是个标签，不触发装配。
        if (agentPreset) {
          try {
            await ctx.agentPresets.mount(agentCtx, agentPreset);
            log(`[adapter] 已挂载 preset ${agentPreset}（agent ${sessionId}）`);
          } catch (error) {
            // 挂不上必须显式失败：没有 preset 的 QQ 会话等于「没有安全规则和人格」，
            // 静默继续会让一个裸 agent 顶着她的名字去群里说话。
            throw new Error(`挂载 preset ${agentPreset} 失败：${error?.message ?? error}`);
          }
        }
        if (!isQqSessionKey(targetKey) && (hooks?.roleCardBlock || hooks?.runtimePanel)) {
          log(`[adapter] ${targetKey} 不是 QQ 会话 key，跳过角色卡/运行时面板装配（否则每轮装配都会抛「无效的会话 key」把 turn 打断）`);
        }
        // 这里是**唯一**该装配这个 agent 人格/工具的地方：
        // agentCtx 是 agent 作用域，注册的东西只影响这一个 agent。
        //
        // 角色卡走 section 而不是 user message：
        //   · section 的 text 接受函数、每次装配都求值 ⇒ 换卡后下次唤醒自动用新卡；
        //   · 卡全文逐字不变 ⇒ 属于稳定前缀，缓存能命中（放 user message 里会被
        //     当成每轮新内容重发，1000+ 字符白烧）。
        if (hooks?.roleCardBlock && agentCtx?.systemPrompt?.section && isQqSessionKey(targetKey)) {
          try {
            agentCtx.systemPrompt.section({
              name: 'qq:role-card',
              // 0 = persona prefix 之后；比工具说明都靠前，她一开始就看到自己是谁。
              order: 100,
              text: () => hooks.roleCardBlock(targetKey)
            });
          } catch (error) {
            log(`[adapter] 注册角色卡 section 失败：${error?.message ?? error}`);
          }
        }
        // 运行时面板（此刻状态 / 当前唤醒 / 参与度 / 表情库）走 context()：
        // 这些是每轮重算的「背景状态」，不属于「对方说了什么」，
        // 放进 user message 会一轮轮往历史里堆。context 每轮重新求值、不追加。
        if (hooks?.runtimePanel && agentCtx?.systemPrompt?.context && isQqSessionKey(targetKey)) {
          try {
            agentCtx.systemPrompt.context({
              name: 'qq:runtime',
              order: 200,
              text: () => hooks.runtimePanel(targetKey)
            });
          } catch (error) {
            log(`[adapter] 注册运行时 context 失败：${error?.message ?? error}`);
          }
        }
        onAgentCreated?.({ agentCtx, agent, targetKey, sessionId });
      }
    });
    live.set(sessionId, { agent: handle.agent, handle });
    keyToSession.set(targetKey, sessionId);
    // 把会话**归属到工作区**。漏了这一步的后果：workspaces.sessionIds 里没有它，
    // GUI 按工作区分组时找不到归属，会话就显示成「未命名」/孤立条目 ——
    // 即使 cwd 和工作区路径完全一致也没用（cwd 只决定文件落哪个目录，不建立归属关系）。
    if (workspaceEntity?.attachSession) {
      try {
        await workspaceEntity.attachSession(sessionId);
      } catch (error) {
        log(`[adapter] 会话归属工作区失败 ${sessionId}：${error?.message ?? error}`);
      }
    } else {
      log(`[adapter] 还没有 workspaceEntity，跳过会话归属（工作区会在第一次 workspace.create 后才有）`);
    }
    // 给会话一个可读标题。不设的话 DSH 会用 fallback：截取第一条 prompt 的开头，
    // 而我们的第一条 prompt 以【当前时间】开头 —— 列表里就会显示「【当前时间】2026/10/30 06:02:56（」。
    setTitle(handle.agent, sessionId, targetKey);
    log(`[adapter] agent 已创建 ${targetKey} -> ${sessionId}（preset ${agentPreset ?? '默认'}）`);
    return sessionId;
  }

  function agentOf(sessionId) {
    return live.get(sessionId)?.agent ?? null;
  }

  // ── HTTP API 的等价物 ────────────────────────────────────────────────────
  const api = {
    sessions: {
      /** bridge.js: const value = unwrap(await api.sessions.create(params)); sessionId = value.sessionId */
      create: async (params = {}) => {
        const targetKey = params.targetKey || params.sessionId || `unknown-${crypto.randomUUID().slice(0, 6)}`;
        const sessionId = await createAgent({
          targetKey,
          agentPreset: params.agentPreset,
          cwd: params.cwd
        });
        return ok({ sessionId, session: { sessionId } });
      },
      /**
       * bridge.js 用 `mode: 'queue'` 投递唤醒提示。对应到 agent：
       *   queue（默认，排一个独立回合）→ followup
       *   steer（本轮内插话）          → steer
       */
      prompt: async ({ sessionId, content, mode } = {}) => {
        const agent = agentOf(sessionId);
        if (!agent) throw new Error(`没有找到会话 ${sessionId} 对应的 agent`);
        const text = Array.isArray(content)
          ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : String(content ?? '');
        const msg = userMessage(text);
        if (mode === 'steer') agent.steer(msg);
        else agent.followup(msg);
        return ok({ accepted: true, sessionId });
      },
      list: async () => ok({ sessions: [...live.keys()].map((sessionId) => ({ sessionId })) }),
      selectModel: async ({ sessionId, provider, model }) => {
        const agent = agentOf(sessionId);
        if (agent) agent.options.provider = provider ?? agent.options.provider;
        if (agent) agent.options.model = model ?? agent.options.model;
        return ok({ selected: { provider, model } });
      },
      modelCatalog: async () => ok({ models: [] }),
      rename: async ({ sessionId, title }) => {
        const agent = agentOf(sessionId);
        if (agent && ctx.sessionTitle?.rename) {
          try { ctx.sessionTitle.rename(agent.session, String(title ?? '')); } catch (error) {
            log(`[adapter] 重命名失败 ${sessionId}：${error?.message ?? error}`);
          }
        }
        return ok({ sessionId, title });
      }
    },

    events: {
      /**
       * bridge.js 在创建会话后调用一次 `events.follow(sessionId)`，之后靠事件流
       * 驱动「回合结束/要文本/要审批」。这里换成注册 watcher。
       */
      follow: (sessionId) => {
        if (!watchers.has(sessionId)) watchers.set(sessionId, new Set());
        // 真正的 agent 事件订阅在 index.js 里统一做（agent 生命周期事件是全局的），
        // 这里只占位保证 bridge.js 的调用不会抛。
        return ok({ following: sessionId });
      },
      forget: (sessionId) => {
        watchers.delete(sessionId);
        return ok({ forgotten: sessionId });
      },
      /** bridge.js 里 mux 用于断开/重连检测；进程内模式恒为健康。 */
      mux: async function* muxStream() {
        // 永不结束的异步生成器，形状与 HTTP 模式的 remote.mux 一致。
        // bridge.js 的 pumpMux 会对它 `for await`，进程内模式下这就是事件入口。
        for (;;) {
          const envelope = await nextFrame();
          yield envelope;
        }
      }
    },

    workspace: {
      /**
       * 桥接在这里给出工作目录（`cfg.sessionCwd` 或 `state/agents`），紧接着才建会话。
       * 必须记住这个 path：agent 的 cwd 决定 DSH 把会话存在哪个目录下，
       * 为空会落到 `_no-cwd`，GUI 按 cwd 分组时列不出来。
       */
      create: async ({ path: dir } = {}) => {
        if (dir) {
          workspacePath = String(dir);
          // 必须真的把目录建出来：DSH 的 agent 会把这个路径当 cwd，
          // 指向一个不存在的目录时创建会失败（HTTP 模式下是 workspace.create 代劳的，
          // 这里换成进程内实现就得自己补上）。
          try {
            fs.mkdirSync(workspacePath, { recursive: true });
          } catch (error) {
            log(`创建工作目录失败 ${workspacePath}：${error?.message ?? error}`);
          }
          // 用真实注册表建/取工作区。返回已存在的那个时不会改标题，
          // 所以下面仍然标 created=true 让桥接调 rename（rename 是幂等的）。
          try {
            workspaceEntity = (await ctx.workspaceRegistry?.create?.(workspacePath)) ?? null;
          } catch (error) {
            log(`注册工作区失败 ${workspacePath}：${error?.message ?? error}`);
            workspaceEntity = null;
          }
        }
        return ok({
          created: Boolean(workspaceEntity),
          workspace: { workspaceId: workspaceEntity?.id ?? 'qq-agent-host' }
        });
      },
      // 桥接在 created=true 时会调这里把工作区标题设成 cfg.workspaceTitle（默认「QQ 聊天」）。
      // 不设的话 GUI 里这个工作区就叫「未命名」——因为注册表里的默认标题是自动生成的。
      rename: async ({ workspaceId, title } = {}) => {
        const ws = workspaceEntity?.id === workspaceId
          ? workspaceEntity
          : ctx.workspaceRegistry?.get?.(workspaceId);
        if (ws?.setTitle) {
          try { await ws.setTitle(String(title ?? '')); } catch (error) {
            log(`重命名工作区失败 ${workspaceId}：${error?.message ?? error}`);
          }
        } else {
          log(`重命名工作区跳过：拿不到 ${workspaceId} 对应的 Workspace 实体`);
        }
        return ok({ workspaceId, title });
      },
      /** 退役会话 = 释放 agent（对应 HTTP 模式的 archiveSession）。 */
      archiveSession: async ({ sessionId }) => {
        const entry = live.get(sessionId);
        if (entry) {
          try { await entry.handle.dispose(); } catch (error) { log(`[adapter] dispose 失败：${error?.message ?? error}`); }
          live.delete(sessionId);
          watchers.delete(sessionId);
        }
        return ok({ archived: sessionId });
      }
    },

    settings: {
      /**
       * bridge.js 靠这一条读 `qq-mode` 命名空间来决定当前模式（chat / reserved2…）。
       * 早先这里是返回空数组的桩，后果是**字段全读不到**、模式永远停在默认的
       * `chat`，进而去要一个不存在的 `qq-chat` preset，把每个会话都拒绝掉。
       */
      describe: async () => {
        try {
          const list = ctx.settings?.describe?.({ redactSecrets: true }) ?? [];
          return ok({ namespaces: list });
        } catch (error) {
          log(`settings.describe 失败：${error?.message ?? error}`);
          return ok({ namespaces: [] });
        }
      },
      update: async (nsOrObject, patch) => {
        // bridge.js 的调用形状是 update({ ns, patch })，也兼容 update(ns, patch)。
        const ns = typeof nsOrObject === 'string' ? nsOrObject : nsOrObject?.ns;
        const body = typeof nsOrObject === 'string' ? patch : nsOrObject?.patch;
        if (!ns) throw new Error('settings.update 缺少 ns');
        if (!ctx.settings?.update) throw new Error('settings 服务不可用');
        await ctx.settings.update(ns, body ?? {});
        return ok({ updated: true });
      }
    },

    agentPresets: {
      /**
       * bridge.js 用这份清单校验「要挂的 preset 到底存不存在」。
       * 早先返回空数组 ⇒ 每个会话都被判定为「preset 不在 DSH 可用清单中」而拒绝创建。
       */
      list: async () => {
        try {
          const presets = (await ctx.agentPresets?.list?.()) ?? [];
          return ok({ presets });
        } catch (error) {
          log(`agentPresets.list 失败：${error?.message ?? error}`);
          return ok({ presets: [] });
        }
      }
    },

    // ── 以下三个在 bridge.js 里是顶层方法（不是命名空间） ──────────────────
    respond: async ({ sessionId, outcome } = {}) => {
      const agent = agentOf(sessionId);
      // 回答提问/审批：把答案作为一条 user 消息喂回去（进程内模式下 agent 会
      // 在自己那一步继续，不需要走 HTTP 的 question/requested 往返）。
      if (agent && outcome) agent.steer(userMessage(JSON.stringify(outcome)));
      return ok({ responded: true });
    },
    stopSessionWork: async (sessionId) => {
      const agent = agentOf(sessionId);
      if (agent) agent.cancel('user');
      return { removed: 1 };
    },
    callUnary: async (method) => {
      // bridge.js 只用 callUnary 取模型目录 / 设置；进程内模式没什么可调的。
      throw new Error(`callUnary(${method}) 在进程内模式下不可用`);
    }
  };

  return {
    api,
    live,
    keyToSession,
    agentOf,
    createAgent,
    emit,
    /** 给 index.js 用：把真实的 session 事件转成 bridge.js 认的帧 */
    publish(sessionId, event) { pushFrame({ type: 'session/event', sessionId, event }); },
    /** 给 index.js 用：无条件推一个帧（快照等） */
    publishFrame(frame) { pushFrame(frame); }
  };
}
