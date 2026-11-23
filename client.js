/**
 * 浏览器半端：在「插件 → BMad Method（项目级）详情页」里渲染设置卡片。
 *
 * 三块内容：
 *   1. 设置：用户名 / 语言 / 产物目录（走 configForms 的 scope，改完立即生效）
 *   2. 状态：装在哪、核心版本、产物目录、uv 是否可用
 *   3. 模块开关：逐个模块开关 + 一个「安装/更新运行时」按钮
 *
 * 只 require('react')：第三方插件拿不到 @deepseek-ai/dsh-client-ui-primitives。
 * 模块开关与安装都走同源 HTTP（浏览器端调不了 Host 工具）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bmad-method-project',
  factory: (require) => {
    const React = require('react')

    const NS = 'dsh-bmad-method-project'
    // Host 侧 settings 命名空间就是 Loader 行 id；两种拼法都试，取真正 serve 的那个
    const CANDIDATES = ['bmad-method-project', 'include:bmad-method-project']
    const API = '/api/bmad-method-project'

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 18px' },
      head: { display: 'flex', flexDirection: 'column', gap: 4 },
      title: { fontSize: 15, fontWeight: 600 },
      sub: { fontSize: 12, opacity: 0.62, lineHeight: 1.5 },
      row: { display: 'grid', gridTemplateColumns: '132px 1fr auto', alignItems: 'center', gap: 10 },
      label: { fontSize: 13 },
      input: {
        fontSize: 13,
        padding: '6px 9px',
        borderRadius: 7,
        border: '1px solid rgba(127,127,127,.32)',
        background: 'transparent',
        color: 'inherit',
        minWidth: 0,
      },
      hint: { gridColumn: '2 / span 2', fontSize: 11, opacity: 0.5, marginTop: -4 },
      badge: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,.3)',
        opacity: 0.8,
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
      },
      actions: { display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' },
      btn: { fontSize: 13, padding: '6px 14px', borderRadius: 7, cursor: 'pointer' },
      note: { fontSize: 12, opacity: 0.62 },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 6,
        paddingTop: 14,
        borderTop: '1px solid rgba(127,127,127,.18)',
      },
      info: {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '3px 12px',
        fontSize: 12,
        opacity: 0.75,
        lineHeight: 1.6,
      },
      infoKey: { opacity: 0.6 },
      modRow: {
        display: 'grid',
        gridTemplateColumns: '1fr auto auto',
        alignItems: 'center',
        gap: 12,
        padding: '7px 0',
      },
      modName: { fontSize: 13, display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 },
      modVer: { fontSize: 11, opacity: 0.45 },
      modDesc: { fontSize: 11, opacity: 0.5, marginTop: 2 },
      switch: {
        width: 38,
        height: 21,
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,.35)',
        cursor: 'pointer',
        padding: 0,
        position: 'relative',
        transition: 'background .15s',
        background: 'rgba(127,127,127,.22)',
      },
      switchOn: { background: '#2f9e44', borderColor: '#2f9e44' },
      knob: {
        position: 'absolute',
        top: 2,
        width: 15,
        height: 15,
        borderRadius: 999,
        background: '#fff',
        transition: 'left .15s',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)',
      },
      err: { fontSize: 12, color: '#e03131' },
      ok: { fontSize: 12, color: '#2f9e44' },
    }

    async function apiGet() {
      const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function apiToggle(module, enabled) {
      const res = await fetch(`${API}/toggle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ module, enabled }),
      })
      return res.json()
    }

    async function apiInstall() {
      const res = await fetch(`${API}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      return res.json()
    }

    /** 状态 + 模块开关 + 安装按钮，共用一份服务端数据。 */
    function StatusAndModules() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        let alive = true
        apiGet()
          .then((next) => {
            if (!alive) return
            setData(next)
            if (next.ok === false) setError(next.error || '读取失败')
          })
          .catch((e) => alive && setError(String(e?.message ?? e)))
        return () => {
          alive = false
        }
      }, [])

      const load = () => {
        apiGet()
          .then((next) => {
            setData(next)
            setError(next.ok === false ? next.error || '读取失败' : '')
          })
          .catch((e) => setError(String(e?.message ?? e)))
      }

      const toggle = async (m) => {
        setBusy(m.code)
        setError('')
        setMessage('')
        try {
          const next = await apiToggle(m.code, !m.enabled)
          if (Array.isArray(next.modules)) setData(next)
          if (next.ok === false) setError((next.notes && next.notes[0]) || '切换失败')
          else setMessage(`${m.name || m.code} 已${next.enabled ? '启用' : '停用'}，下一轮对话生效`)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy('')
        }
      }

      const install = async () => {
        setBusy('__install__')
        setError('')
        setMessage('')
        try {
          const next = await apiInstall()
          if (Array.isArray(next.modules)) setData(next)
          if (next.ok === false) setError((next.notes && next.notes[0]) || '安装失败')
          else setMessage(next.installStatus === 'ok' ? '运行时已就绪' : `安装结束：${next.installStatus}`)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy('')
        }
      }

      const children = [
        React.createElement(
          'div',
          { style: S.head, key: 'h' },
          React.createElement('div', { style: S.title }, 'BMad 运行时'),
          React.createElement(
            'div',
            { style: S.sub },
            '每个项目自己的 _bmad/，与上游 npx bmad-method install 同构；skill 随插件包提供，不落磁盘',
          ),
        ),
      ]

      if (data && data.ok !== false && data.installed) {
        children.push(
          React.createElement(
            'div',
            { style: S.info, key: 'info' },
            React.createElement('span', { style: S.infoKey }, '安装位置'),
            React.createElement('span', null, data.bmadDir),
            React.createElement('span', { style: S.infoKey }, '核心版本'),
            React.createElement('span', null, data.coreVersion || '未知'),
            React.createElement('span', { style: S.infoKey }, '产物目录'),
            React.createElement('span', null, data.outputDir),
            React.createElement('span', { style: S.infoKey }, 'uv'),
            React.createElement('span', null, data.uv ? '可用' : '不可用（Python 脚本改用 python 直接跑）'),
          ),
        )
      } else if (data && data.ok !== false) {
        children.push(
          React.createElement('div', { style: S.note, key: 'notinst' }, '未安装：点下方「安装 / 更新运行时」'),
        )
      }

      if (data === null && !error) {
        children.push(React.createElement('div', { style: S.note, key: 'loading' }, '正在读取状态…'))
      }

      const rows = (data?.modules ?? []).filter((m) => m.code !== 'core')
      if (rows.length) {
        children.push(
          React.createElement(
            'div',
            { style: S.section, key: 'mods' },
            React.createElement('div', { style: S.title }, '模块开关'),
            React.createElement(
              'div',
              { style: S.sub },
              '只决定这个模块的 skill 参不参与 dsh（下一轮对话生效，不用重启），模块文件一个都不删',
            ),
            ...rows.map((m) =>
              React.createElement(
                'div',
                { style: S.modRow, key: m.code },
                React.createElement(
                  'div',
                  { style: { minWidth: 0 } },
                  React.createElement(
                    'div',
                    { style: S.modName },
                    React.createElement('span', null, m.name || m.code),
                    React.createElement(
                      'span',
                      { style: S.modVer },
                      `${m.code}${m.version ? ` · ${m.version}` : ''}`,
                    ),
                  ),
                  m.description ? React.createElement('div', { style: S.modDesc }, m.description) : null,
                ),
                React.createElement(
                  'span',
                  { style: { ...S.note, whiteSpace: 'nowrap' } },
                  !m.installed ? '未安装' : !m.toggleable ? '不可开关' : m.enabled ? '启用' : '已停用',
                ),
                m.installed && m.toggleable
                  ? React.createElement(
                      'button',
                      {
                        style: { ...S.switch, ...(m.enabled ? S.switchOn : {}) },
                        disabled: busy === m.code,
                        title: m.enabled ? '停用（它的 skill 立刻从清单里消失）' : '启用',
                        onClick: () => toggle(m),
                      },
                      React.createElement('span', { style: { ...S.knob, left: m.enabled ? 20 : 2 } }),
                    )
                  : React.createElement('span', { style: { width: 38, height: 21 } }),
              ),
            ),
          ),
        )
      }

      children.push(
        React.createElement(
          'div',
          { style: S.actions, key: 'act' },
          React.createElement(
            'button',
            { style: S.btn, disabled: busy === '__install__', onClick: install },
            busy === '__install__' ? '正在安装…' : '安装 / 更新运行时',
          ),
          React.createElement('button', { style: S.btn, disabled: busy === '__install__', onClick: load }, '刷新状态'),
        ),
      )

      if (message) children.push(React.createElement('div', { style: S.ok, key: 'msg' }, message))
      if (error) children.push(React.createElement('div', { style: S.err, key: 'err' }, error))
      return React.createElement('div', { style: S.section }, children)
    }

    function namespacesOf(mirror) {
      const view = mirror?.getSnapshot?.()?.view
      return Array.isArray(view?.namespaces) ? view.namespaces.map((v) => v.ns) : []
    }

    const FIELDS = [
      { key: 'userName', label: '用户名', placeholder: '留空 = BMad', hint: '写进 BMad 核心配置的 user_name' },
      { key: 'language', label: '语言', placeholder: '简体中文', hint: '沟通与文档输出语言' },
      { key: 'outputFolder', label: '产物目录', placeholder: '_bmad-output', hint: '相对项目根' },
    ]

    function Card(props) {
      const { mirror, getScope } = props
      const [names, setNames] = React.useState(() => namespacesOf(mirror))
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)

      // 命名空间 = Host 侧的 profile entry id：先精确匹配候选，再退回「含 bmad 的任意命名空间」
      const ns = CANDIDATES.find((c) => names.includes(c)) ?? names.find((n) => /bmad/i.test(String(n)))
      const scope = ns ? getScope(ns) : null

      const [snap, setSnap] = React.useState(() => (scope ? scope.getSnapshot() : { status: 'unavailable' }))

      React.useEffect(() => mirror.subscribe(() => setNames(namespacesOf(mirror))), [mirror])

      React.useEffect(() => {
        if (!scope) {
          setSnap({ status: 'unavailable' })
          return undefined
        }
        setSnap(scope.getSnapshot())
        return scope.subscribe(() => setSnap(scope.getSnapshot()))
      }, [scope])

      const value = snap.value ?? {}
      const user = snap.user ?? {}
      const writable = Boolean(snap.writable)
      const shown = (k) => (k in draft ? draft[k] : value[k] ?? '')
      const dirty = Object.keys(draft).some((k) => draft[k] !== (value[k] ?? ''))

      const save = async () => {
        setBusy(true)
        try {
          for (const k of Object.keys(draft)) {
            if (draft[k] === (value[k] ?? '')) continue
            // 清空 = 删除用户覆盖，回落到内置默认
            if (String(draft[k]).trim() === '') await scope.unset(k)
            else await scope.set(k, String(draft[k]))
          }
          setDraft({})
        } finally {
          setBusy(false)
        }
      }

      if (snap.status !== 'ready') {
        return React.createElement(
          'div',
          { style: S.note },
          snap.status === 'loading'
            ? '正在读取配置…'
            : `没有拿到本插件的配置命名空间。Host 当前提供：${names.length ? names.join('、') : '（空列表）'}`,
        )
      }

      const children = [
        React.createElement(
          'div',
          { style: S.head, key: 'head' },
          React.createElement('div', { style: S.title }, 'BMad 设置'),
          React.createElement(
            'div',
            { style: S.sub },
            `${writable ? '保存后立即生效' : '当前只读'} · 留空 = 用内置默认值`,
          ),
        ),
      ]

      const resetBadge = (key) =>
        key in user
          ? React.createElement(
              'button',
              {
                key: 'reset',
                style: S.badge,
                title: '清除这里的覆盖值，回落到默认',
                onClick: () => {
                  setDraft((d) => {
                    const next = { ...d }
                    delete next[key]
                    return next
                  })
                  scope.unset(key)
                },
              },
              '已覆盖 · 恢复',
            )
          : React.createElement('span', { key: 'pad' })

      for (const f of FIELDS) {
        children.push(
          React.createElement(
            'div',
            { style: S.row, key: f.key },
            React.createElement('span', { style: S.label }, f.label),
            React.createElement('input', {
              style: S.input,
              value: shown(f.key),
              placeholder: f.placeholder,
              disabled: !writable || busy,
              onChange: (e) => {
                const next = e.target.value
                setDraft((d) => ({ ...d, [f.key]: next }))
              },
            }),
            resetBadge(f.key),
          ),
        )
        if (f.hint) children.push(React.createElement('div', { style: S.hint, key: `${f.key}-hint` }, f.hint))
      }

      children.push(
        React.createElement(
          'div',
          { style: S.actions, key: 'actions' },
          React.createElement(
            'button',
            { style: S.btn, disabled: !dirty || busy || !writable, onClick: save },
            busy ? '保存中…' : '保存',
          ),
          React.createElement(
            'button',
            { style: S.btn, disabled: !dirty || busy, onClick: () => setDraft({}) },
            '放弃修改',
          ),
        ),
      )

      children.push(React.createElement(StatusAndModules, { key: 'status' }))
      return React.createElement('div', { style: S.wrap }, children)
    }

    const inject = ['slots', 'configForms']

    function apply(ctx) {
      // apply 期间只登记「等 slot 出现」，不碰其它服务：
      // plugins.bundle.config 是插件页挂载后才声明的子 slot
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: NS,
                // 把 settings 镜像整块交给卡片：命名空间在 Host 提供的列表里挑，不猜拼法
                inject: () => ({
                  mirror: ctx.configForms.describe(),
                  getScope: (nsKey) => ctx.configForms.get(nsKey),
                }),
              },
              Card,
            ),
          ),
        'dsh-BMad-Method: config card',
      )
    }

    // 官方 client bundle 用 exports 暴露入口（loader 按 CJS 语义取），这里同时 return 兼容两种取法
    if (typeof exports !== 'undefined') {
      exports.apply = apply
      exports.inject = inject
    }
    return { inject, apply }
  },
})
