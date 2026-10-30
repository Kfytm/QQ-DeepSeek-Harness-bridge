/**
 * qq-agent-host —— 浏览器半端（设置在「设置」里的一页）
 * =========================================================================
 *
 * ⚠️ **client bundle 不是 ESM，是自注册脚本**（约定照 dsh-bili-scroll / dsh-meme）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<package.json 里的 name>',
 *       factory: (require) => ({ inject: [...], apply(ctx) {...} }),
 *     })
 *
 * 进「设置」的方式（`label` 就是左侧导航那一项）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'qq-agent-host', order: 40, label: 'QQ 桥接' },
 *       () => h(Panel),
 *     ))
 *
 * 数据走 HTTP 回源：设置页在浏览器里，拿不到 cordis ctx，只能调插件自己挂的
 * `/api/qq-agent-host/*`（服务端在 index.js 里用 ctx.webServer.register 挂的）。
 * =========================================================================
 */
window.__ModuleLoader__.load({
  id: 'qq-agent-host',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/qq-agent-host';

    const asJson = async (res) => {
      if (res.ok) return res.json();
      const why = res.status === 401 ? '（未登录 / 没权限）'
        : res.status === 403 ? '（被宿主拦了）'
          : res.status === 404 ? '（路由没挂上）' : '';
      throw new Error(`HTTP ${res.status}${why}`);
    };
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }));
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }));

    const CSS = `
[data-qa-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:680px;}
[data-qa-sec]{display:flex;flex-direction:column;gap:8px;}
[data-qa-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qa-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-qa-grow]{flex:1;min-width:0;}
[data-qa-label]{font-size:13px;}
[data-qa-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qa-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;background:var(--dsw-alias-fill-tertiary,#3a3a3c);transition:background .15s;}
[data-qa-sw][data-on="1"]{background:var(--dsw-alias-brand,#4c8dff);}
[data-qa-sw]::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;}
[data-qa-sw][data-on="1"]::after{transform:translateX(16px);}
[data-qa-in]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:13px;
  border:1px solid var(--dsw-alias-border-secondary,#3a3a3c);background:var(--dsw-alias-bg-secondary,#1c1c1e);color:inherit;font-family:inherit;}
[data-qa-in]:focus{outline:none;border-color:var(--dsw-alias-brand,#4c8dff);}
[data-qa-btn]{padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-secondary,#3a3a3c);background:transparent;color:inherit;}
[data-qa-btn][data-primary="1"]{background:var(--dsw-alias-brand,#4c8dff);border-color:transparent;color:#fff;}
[data-qa-btn]:disabled{opacity:.5;cursor:default;}
[data-qa-msg]{font-size:12px;padding:8px 10px;border-radius:8px;}
[data-qa-msg][data-kind="ok"]{background:rgba(52,199,89,.15);color:#34c759;}
[data-qa-msg][data-kind="err"]{background:rgba(255,69,58,.15);color:#ff453a;}
[data-qa-roles]{display:flex;flex-direction:column;gap:6px;}
[data-qa-role]{display:flex;align-items:center;gap:10px;padding:8px 11px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-secondary,#3a3a3c);font-size:13px;}
[data-qa-role][data-cur="1"]{border-color:var(--dsw-alias-brand,#4c8dff);background:rgba(76,141,255,.09);}
[data-qa-role-name]{font-weight:500;flex:none;min-width:4.5em;}
[data-qa-role-title]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px;}
[data-qa-role-cur]{flex:none;font-size:11px;padding:1px 8px;border-radius:9px;
  background:var(--dsw-alias-brand,#4c8dff);color:#fff;}
`;

    // 每个字段的展示方式：开关 / 输入框 / 逗号分隔的数组
    const FIELDS = [
      { key: 'enabled', kind: 'switch', label: '启用桥接',
        note: '关掉 = 插件停止接管 QQ（改完要重启 DSH 才会真正停）' },
      { key: 'bridgeRoot', kind: 'text', label: '桥接目录',
        note: '含 config.json 与 src/ 的目录；留空 = 相对本插件 ../../' },
      { key: 'agentPreset', kind: 'text', label: 'DSH 预设',
        note: '建 agent 用哪个 preset，默认 qq-chat-v2' },
      { key: 'snowlumaWsUrl', kind: 'text', label: 'SnowLuma WS',
        note: '如 ws://127.0.0.1:3001；留空 = 用 config.json 里的值' },
      { key: 'snowlumaHttpUrl', kind: 'text', label: 'SnowLuma HTTP',
        note: '如 http://127.0.0.1:3000（别填 WS 端口）；留空 = 用 config.json' },
      { key: 'snowlumaToken', kind: 'password', label: 'SnowLuma Token',
        note: '换号或重装 SnowLuma 后要更新；留空 = 用 config.json' },
      { key: 'consoleToken', kind: 'password', label: '控制台 Token',
        note: '她调 qq_* 工具时用；改了会让正在跑的回合失效' },
      { key: 'ownerQQ', kind: 'text', label: '管理员 QQ',
        note: '只有这个人能下指令；留空 = 用 config.json' },
      { key: 'allowPrivate', kind: 'list', label: '允许的私聊 QQ',
        note: '逗号分隔；留空 = 用 config.json 的 allow.private' },
      { key: 'allowGroups', kind: 'list', label: '允许的群号',
        note: '逗号分隔；留空 = 用 config.json 的 allow.groups' },

    ];

    function Row({ field, value, onChange }) {
      const { key, kind, label, note } = field;
      let control;
      if (kind === 'switch') {
        control = h('button', {
          'data-qa-sw': '',
          'data-on': value ? '1' : '0',
          'aria-pressed': Boolean(value),
          onClick: () => onChange(key, !value),
        });
      } else if (kind === 'list') {
        const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
        control = h('input', {
          'data-qa-in': '',
          value: text,
          placeholder: '123456,789012',
          onChange: (e) => onChange(key, e.target.value.split(',').map((s) => s.trim()).filter(Boolean)),
        });
      } else {
        control = h('input', {
          'data-qa-in': '',
          type: kind === 'password' ? 'password' : 'text',
          value: value == null ? '' : String(value),
          onChange: (e) => onChange(key, e.target.value),
        });
      }
      return h('div', { 'data-qa-sec': '' },
        h('div', { 'data-qa-row': '' },
          h('div', { 'data-qa-grow': '' },
            h('div', { 'data-qa-label': '' }, label),
            note ? h('div', { 'data-qa-note': '' }, note) : null,
          ),
          kind === 'switch' ? control : null,
        ),
        kind === 'switch' ? null : control,
      );
    }

    // 只读的「可用副卡」列表：显示有哪些卡、每张卡是什么、当前在用哪张。
    // 不给切换按钮 —— 切卡是她按语境自己决定的事（qq_switch_role），
    // 设置页只需要让用户**看见**有什么卡。
    function RolesPanel() {
      const [data, setData] = React.useState(null);
      const [err, setErr] = React.useState(null);
      React.useEffect(() => {
        jget('/roles').then((r) => setData(r)).catch((e) => setErr(e.message));
      }, []);
      if (err) return h('div', { 'data-qa-note': '' }, `读取副卡失败：${err}`);
      if (!data) return h('div', { 'data-qa-note': '' }, '读取中…');
      const roles = data.roles ?? [];
      return h('div', { 'data-qa-sec': '' },
        h('div', { 'data-qa-row': '' },
          h('div', { 'data-qa-grow': '' },
            h('div', { 'data-qa-label': '' }, '可用副卡'),
            h('div', { 'data-qa-note': '' },
              `共 ${roles.length} 张。切卡由她按语境自己决定（qq_switch_role），这里只做浏览。`),
          ),
        ),
        roles.length === 0
          ? h('div', { 'data-qa-note': '' }, data.note || 'roles/ 目录里没有卡')
          : h('div', { 'data-qa-roles': '' }, roles.map((r) => h('div', {
              key: r.name,
              'data-qa-role': '',
              'data-cur': data.current === r.name ? '1' : '0',
            },
              h('span', { 'data-qa-role-name': '' }, r.name),
              h('span', { 'data-qa-role-title': '' }, r.title || ''),
              data.current === r.name
                ? h('span', { 'data-qa-role-cur': '' }, '使用中')
                : null,
            ))),
      );
    }

    function Panel() {
      const [cfg, setCfg] = React.useState(null);
      const [revision, setRevision] = React.useState(0);
      const [draft, setDraft] = React.useState({});
      const [msg, setMsg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const r = await jget('/config');
          setCfg(r.value ?? {});
          setDraft(r.value ?? {});
          setRevision(r.revision ?? 0);
          setMsg(null);
        } catch (e) {
          setMsg({ kind: 'err', text: `读取失败：${e.message}` });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const onChange = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

      const save = async () => {
        setBusy(true);
        try {
          await jpost('/config', { patch: draft, revision });
          const r = await jpost('/config', { patch: draft });
          setMsg({ kind: 'ok', text: r.note ?? '已保存。桥接配置需要重启 DSH 才生效。' });
          await load();
        } catch (e) {
          setMsg({ kind: 'err', text: `保存失败：${e.message}` });
        } finally {
          setBusy(false);
        }
      };

      const dirty = cfg && JSON.stringify(cfg) !== JSON.stringify(draft);

      return h('div', { 'data-qa-page': '' },
        h('div', { 'data-qa-sec': '' },
          h('div', { 'data-qa-h': '' }, 'QQ 桥接'),
          h('div', { 'data-qa-note': '' },
            '这里的值**就是** config.json 里的值。改完点保存会直接写回该文件（自动备份），桥接类配置需要重启 DSH 才生效。'),
        ),
        ...FIELDS.map((f) => h(Row, {
          key: f.key,
          field: f,
          value: draft[f.key],
          onChange,
        })),
        h(RolesPanel),
        msg ? h('div', { 'data-qa-msg': '', 'data-kind': msg.kind }, msg.text) : null,
        h('div', { 'data-qa-row': '' },
          h('button', {
            'data-qa-btn': '',
            'data-primary': '1',
            disabled: busy || !dirty,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h('button', { 'data-qa-btn': '', disabled: busy, onClick: load }, '重新读取'),
          dirty ? h('span', { 'data-qa-note': '' }, '有未保存的改动') : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'qq-agent-host');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'qq-agent-host: 设置页样式');

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'qq-agent-host', order: 40, label: 'QQ 桥接' },
          () => h(Panel),
        ));
      },
    };
  },
});
