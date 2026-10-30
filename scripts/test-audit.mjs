// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 人格层重构 P0+P2：静态行为规则只留在预设里（唤醒提示只带运行时数据，省 token），
  // 角色卡按会话/场合绑定，换卡后提示前缀逐字不变（否则 KV 缓存整段失效）。
  'test-persona-refactor.mjs',
  // 梗百科检索：独立于群内黑话库（slang.json 有 2000 上限，混进去会挤掉群内黑话），
  // 检索分层（梗名/标签优先，正文只兜底），公开形状与黑话条目一致。
  'test-memewiki.mjs',
  // 表情库两层标签：画面层（看过图写死一次，`visual.seen` 是"不再调视觉模型"的唯一依据）、
  // 场合层（场景+强度，替换而非追加）、按场景检索候选。含老数据迁移断言。
  'test-sticker-layers.mjs',
  // 插件加载冒烟：ESM 里不能 require、访问服务必须 inject、返回值形状要对。
  // 这些错误只在启动期暴露，而且常常**静默**（插件根本不启动、日志一片安静），
  // 必须能在本地静态抓出来，而不是让用户重启一遍去发现。
  'test-agent-host-smoke.mjs',
  // 适配层：HTTP API 的调用形状 → 进程内 agent 的映射是否正确。
  'test-agent-host-adapter.mjs',
  // 脱敏范围：owner 私聊必须能看到真实错误，群聊必须脱敏。
  'test-audit-scope.mjs',
  // 角色卡搬家：卡全文从 user message 移到 systemPrompt.section，
  // 换卡靠 section 的 text 动态求值生效。含「唤醒提示里绝不能有卡全文」的反向断言。
  'test-role-card-section.mjs',
  // 运行时面板搬 context：此刻状态/当前唤醒/参与度/表情库不再进 user message（内嵌模式）。
  'test-runtime-context.mjs',
  // P1 冷却窗口：发言后 N 秒内不唤醒，窗口内消息合并成一次投递。钉住固定窗口语义
  // （新消息不延长）、不碰分条 burst、合批到点仍在窗口内必须转交而不能绕过。
  'test-speak-cooldown.mjs',
  // P1 单轮总时长上限：turn 跑太久时拒绝再 wait（只拦 wait，不拦收尾动作），
  // 防止「一轮里反复等 3~5 分钟」把单个 turn 拖到十几分钟、几十步。
  'test-turn-budget.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // 「主动机会醒了但无事可做 → 刷一轮 B 站」：分支开关、冷却（防止一夜刷十几轮）、
  // 冷却水位要落盘、以及原有「开个话题」主路径不能被写丢。
  'test-bili-idle-branch.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
