/**
 * Vault Wall —— 浏览器半（手写 lazy-CJS bundle 协议，零构建，零宿主值级依赖）。
 *
 * 外观完全对齐官方设置页设计语汇：所有颜色/边框走 --dsw-alias-* 设计 token，
 * 结构参考官方 ModelsSection（section 列宽 760、行卡片 = border-l4 .5px + radius16 +
 * pad 12/14、行头 identity + margin-left:auto 操作区、rowTag 边框注记、彩色圆点）。
 * 组件用宿主基线 primitives（Button/Input/Modal/Pill）；与宿主/服务端交互走
 * apply(ctx) 的 ctx 服务（slots、settingsScope；uiWorkspace 目录浏览为可选延迟依赖——
 * 不在激活依赖列表里，避免无该服务的宿主整块 pending，可用时自动点亮「浏览」）。
 *
 * 功能：结构化隔离规则编辑器（规则卡片 + 新增/编辑 Modal + JSON 视图），
 * 绑定服务端 `vault-wall` 命名空间（schema 单字段 rulesJson），
 * 保存 = scope.mutate 路径式 set + expectedRevision 冲突栅栏 → 服务端 watch 热重建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-vault-wall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect

    var ui = require('@deepseek-ai/dsh-client-ui-primitives')
    var Button = ui.Button
    var Input = ui.Input
    var Modal = ui.Modal
    var Pill = ui.Pill
    var IconPlusOutline16 = ui.IconPlusOutline16

    /** cordis 激活依赖：slots=注册 section，settingsScope=命名空间。
     *  uiWorkspace（目录浏览）刻意不入列——缺失时不阻塞激活，改为延迟轮询（见 uiSvc）。 */
    var inject = ['slots', 'settingsScope']
    /** apply(ctx) 注入的客户端根 ctx（供弹窗目录选择使用）。 */
    var rootCtx = null

    /** 延迟解析 uiWorkspace：先看激活注入的属性，再看 ctx.get；都没有则 null。 */
    function uiSvc() {
      var c = rootCtx
      if (!c) return null
      if (c.uiWorkspace && typeof c.uiWorkspace.listDirectory === 'function') return c.uiWorkspace
      if (typeof c.get === 'function') {
        try {
          var g = c.get('uiWorkspace')
          if (g && typeof g.listDirectory === 'function') return g
        } catch (e) { /* service 未就绪/未知键 */ }
      }
      return null
    }
    function browseReady() {
      return uiSvc() !== null
    }
    /** 读取 scope 快照（readScopeSnap 供 useScope seat 缺席时的自订阅回退使用）。 */
    function readScopeSnap(scope) {
      try {
        if (scope && typeof scope.getSnapshot === 'function') {
          var s = scope.getSnapshot()
          if (s && typeof s === 'object') return s
        }
      } catch (e) { /* 忽略快照读取异常 */ }
      return { status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory' }
    }

    // ---- 设计 token（官方 alias，主题自适应明暗） ----
    var tok = {
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l4)',
      borderTag: 'var(--dsw-alias-border-l3)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-label)',
      code: 'var(--dsw-font-markdown-code)',
    }
    var mono = { fontFamily: tok.code, fontSize: 12, lineHeight: '18px', color: tok.text2 }

    // ---- 模式元数据 ----
    var MODE_META = {
      hidden: {
        tag: '隐藏',
        dot: tok.text3,
        desc: '对 agent 装作不存在：读取 / 列出 / 触碰一律 not-found，连路径名都不透露。',
      },
      deny: {
        tag: '拒绝',
        dot: tok.error,
        desc: '直接报错并注明该处受规则保护：agent 会知道自己不该碰这里。',
      },
    }

    // 规则可限定工具（引擎按 exec 工具名匹配）。
    var TOOL_OPTIONS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh']

    // ---- 弹窗表单双栏行（标签左、控件右） ----
    var vwDialogClass = 'vw-wall-dialog'
    var rightCol = { flex: 1, minWidth: 0 }
    function fieldRowStyle() {
      return { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }
    }
    function fieldLabelStyle() {
      return { width: 64, flex: 'none', whiteSpace: 'nowrap', fontSize: 14, lineHeight: '20px', color: tok.text2, margin: 0, paddingTop: 6 }
    }
    /** 宿主 Modal 面板默认窄（min(380px,100%)）；注入一次私有样式：放宽 + 按设置面板居中平移。 */
    var vwStyleInjected = false
    var vwShift = 0
    function vwStyleRule() {
      var rule = '.' + vwDialogClass + '{width:min(92vw, 520px) !important;'
      if (vwShift !== 0) rule += 'transform: translateX(' + vwShift + 'px) !important;'
      rule += '}' + '.' + vwDialogClass + ' > div:last-child{padding-right:12px !important;}'
      return rule
    }
    function ensureModalWidthStyle() {
      if (vwStyleInjected || typeof document === 'undefined') return
      vwStyleInjected = true
      var style = document.createElement('style')
      style.setAttribute('data-vw-wall', 'true')
      style.textContent = vwStyleRule()
      ;(document.head || document.documentElement).appendChild(style)
    }
    function shiftDialog(dx) {
      vwShift = dx || 0
      if (vwStyleInjected && typeof document !== 'undefined') {
        var el = document.querySelector('style[data-vw-wall="true"]')
        if (el) el.textContent = vwStyleRule()
      }
    }

    // ---- 通用内联样式片段（对齐官方 CSS 几何） ----
    // 规则以行卡片呈现；行内按钮采用 Agent 预设页那种安静文字按钮样式。
    var rowCard = {
      border: '1px solid var(--dsw-alias-border-l3, rgba(140, 142, 152, 0.45))',
      borderRadius: 16,
      padding: '12px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      color: tok.text,
    }
    var rowIdentity = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }
    var rowName = { fontSize: 15, lineHeight: '21px', fontWeight: 600, color: tok.text }
    var rowTagStyle = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '1px 8px',
      border: '0.5px solid ' + tok.borderTag,
      borderRadius: 999,
      fontSize: 11,
      lineHeight: '17px',
      fontWeight: 500,
      whiteSpace: 'nowrap',
      color: tok.text2,
    }
    var ghostOutline = { border: '1px solid rgba(140, 145, 155, 0.6)', background: 'transparent' }
    /** 行内文字按钮（编辑/删除）——带可见浅边框，保证边界清楚。 */
    function quietBtn(danger) {
      return {
        border: '1px solid rgba(140, 145, 155, 0.6)',
        background: 'none',
        borderRadius: 8,
        padding: '4px 10px',
        fontSize: 12.5,
        lineHeight: '18px',
        color: danger ? tok.error : tok.text2,
        cursor: 'pointer',
      }
    }
    var pathRemoveBtnStyle = {
      border: 'none',
      background: 'none',
      borderRadius: 6,
      padding: '2px 6px',
      fontSize: 11,
      lineHeight: '16px',
      color: tok.text3,
      cursor: 'pointer',
      flex: 'none',
    }
    var labelStyle = { fontSize: 12, lineHeight: '18px', color: tok.text2, margin: '0 0 4px' }
    var fieldWrap = { width: '100%', marginBottom: 10 }

    // ---- 工具函数 ----
    function rulesJsonOf(snap) {
      if (!snap || snap.status !== 'ready' || !snap.value) return ''
      var value = snap.value.rulesJson
      return typeof value === 'string' ? value : ''
    }

    function parseRules(text) {
      var trimmed = String(text ?? '').trim()
      if (trimmed === '') return []
      var doc
      try {
        doc = JSON.parse(trimmed)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: '顶层必须是对象文档' }
      if (!Array.isArray(doc.rules)) return { error: '缺少 rules 数组' }
      return doc.rules
    }

    function serialize(rules) {
      return JSON.stringify({ version: 1, rules: rules }, null, 2)
    }

    function validateRules(rules) {
      var seen = new Set()
      for (var i = 0; i < rules.length; i += 1) {
        var rule = rules[i] || {}
        if (typeof rule.id !== 'string' || rule.id.trim() === '') return '第 ' + (i + 1) + ' 条缺少 id'
        if (seen.has(rule.id)) return 'id 重复：' + rule.id
        seen.add(rule.id)
        if (rule.mode !== 'hidden' && rule.mode !== 'deny') return '规则 ' + rule.id + ' 的 mode 只能是 hidden 或 deny'
        var paths = Array.isArray(rule.paths) ? rule.paths : []
        if (paths.length === 0 || paths.some(function (p) { return typeof p !== 'string' || p.trim() === '' })) {
          return '规则 ' + rule.id + ' 至少需要一个非空路径'
        }
      }
      return null
    }

    /** 规则卡片的模式注记（rowTag 式小标签 + 圆点），悬停可看解释。 */
    function modeTag(mode) {
      var meta = MODE_META[mode] || { tag: mode, dot: tok.text3, desc: '' }
      return h('span', { title: meta.desc, style: rowTagStyle },
        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: meta.dot, display: 'inline-block' } }),
        meta.tag)
    }

    function textAreaStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        border: '0.5px solid ' + tok.border,
        borderRadius: 8,
        background: tok.layer2,
        color: tok.text,
        padding: '6px 8px',
        outline: 'none',
        fontFamily: tok.code,
        fontSize: 12,
        lineHeight: '18px',
        resize: 'vertical',
      }
    }

    // ===================== 单条规则编辑 Modal =====================
    function RuleEditorModal(props) {
      var initial = props.initial
      var idState = useState(initial && initial.id ? initial.id : '')
      var id = idState[0]
      var setId = idState[1]
      var modeState = useState(initial && initial.mode === 'deny' ? 'deny' : 'hidden')
      var mode = modeState[0]
      var setMode = modeState[1]
      var pathsState = useState(Array.isArray(initial && initial.paths) ? initial.paths.slice() : [])
      var paths = pathsState[0]
      var setPaths = pathsState[1]
      var addState = useState('')
      var addInput = addState[0]
      var setAddInput = addState[1]
      var noteState = useState((initial && initial.note) || '')
      var note = noteState[0]
      var setNote = noteState[1]
      var toolsOnlyState = useState(initial && Array.isArray(initial.tools) && initial.tools.length > 0)
      var toolsOnly = toolsOnlyState[0]
      var setToolsOnly = toolsOnlyState[1]
      var toolsSelState = useState(Array.isArray(initial && initial.tools) ? initial.tools.slice() : [])
      var toolsSel = toolsSelState[0]
      var setToolsSel = toolsSelState[1]
      var toolsOpenState = useState(false)
      var toolsOpen = toolsOpenState[0]
      var setToolsOpen = toolsOpenState[1]
      var errState = useState(null)
      var err = errState[0]
      var setErr = errState[1]
      var tipState = useState(false)
      var tipOpen = tipState[0]
      var setTipOpen = tipState[1]
      var browseOpenState = useState(false)
      var browseOpen = browseOpenState[0]
      var setBrowseOpen = browseOpenState[1]
      var browsePathState = useState('')
      var browsePath = browsePathState[0]
      var setBrowsePath = browsePathState[1]
      var browseCrumbsState = useState([])
      var browseCrumbs = browseCrumbsState[0]
      var setBrowseCrumbs = browseCrumbsState[1]
      var browseEntriesState = useState([])
      var browseEntries = browseEntriesState[0]
      var setBrowseEntries = browseEntriesState[1]
      var browseHomeState = useState('')
      var browseHome = browseHomeState[0]
      var setBrowseHome = browseHomeState[1]
      var browseErrState = useState(null)
      var browseErr = browseErrState[0]
      var setBrowseErr = browseErrState[1]
      var browseBusyState = useState(false)
      var browseBusy = browseBusyState[0]
      var setBrowseBusy = browseBusyState[1]

      function addPath(raw) {
        var value = String(raw || '').trim()
        if (value === '') return
        if (paths.indexOf(value) !== -1) { setErr('该路径已添加：' + value); return }
        setPaths(paths.concat([value]))
        setAddInput('')
        setErr(null)
      }

      function canBrowse() {
        return browseReady()
      }
      /** naive Windows parent（绝对路径带尾分隔符）；已是根则返回 ''。 */
      function parentOf(p) {
        if (!p) return ''
        var q = p.replace(/[\\/]+$/, '')
        if (/^[A-Za-z]:$/.test(q)) return q + '\\'
        var i = Math.max(q.lastIndexOf('\\'), q.lastIndexOf('/'))
        if (i <= 0) return ''
        return q.slice(0, i + 1)
      }
      function loadBrowse(path) {
        if (!path) { setBrowseBusy(false); return }
        var svc = uiSvc()
        if (!svc) { setBrowseErr('目录浏览服务不可用（宿主未提供 uiWorkspace）'); setBrowseBusy(false); return }
        setBrowseBusy(true)
        setBrowseErr(null)
        svc.listDirectory(path).then(function (res) {
          setBrowsePath(res && res.path ? res.path : path)
          setBrowseCrumbs(res && Array.isArray(res.crumbs) ? res.crumbs : [])
          setBrowseEntries(res && Array.isArray(res.entries) ? res.entries : [])
          setBrowseHome(res && res.home ? res.home : '')
          setBrowseBusy(false)
        }, function (browseFail) {
          setBrowseErr('浏览目录失败：' + String(browseFail && browseFail.message ? browseFail.message : browseFail))
          setBrowseBusy(false)
        })
      }
      function openBrowser() {
        setErr(null)
        if (!canBrowse()) return
        setBrowseOpen(true)
        var start = 'C:\\'
        if (paths.length > 0) {
          var parent = parentOf(paths[paths.length - 1])
          if (parent) start = parent
        }
        loadBrowse(start)
      }
      function browseTo(path) {
        if (path) loadBrowse(path)
      }
      function browseUp() {
        if (browseCrumbs.length > 1) loadBrowse(browseCrumbs[browseCrumbs.length - 2].path)
      }
      function browseToHome() {
        if (browseHome) loadBrowse(browseHome)
      }
      function chooseBrowseDir() {
        if (browsePath) addPath(browsePath)
        setBrowseOpen(false)
      }
      var crumbBtnStyle = {
        border: '1px solid rgba(140, 145, 155, 0.55)',
        background: 'none',
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        lineHeight: '16px',
        color: tok.text2,
        cursor: 'pointer',
        flex: 'none',
      }
      function buildBrowsePanel() {
        return h('div', { key: 'browse', style: { border: '0.5px solid ' + tok.border, borderRadius: 8, background: tok.layer2, marginTop: 6, overflow: 'hidden' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', padding: '6px 8px', borderBottom: '0.5px solid ' + tok.border } },
            h('button', { type: 'button', style: crumbBtnStyle, disabled: browseBusy || browseCrumbs.length <= 1, onClick: browseUp }, '↑ 上级'),
            browseHome ? h('button', { type: 'button', style: crumbBtnStyle, disabled: browseBusy, onClick: browseToHome }, '主目录') : null,
            browseCrumbs.map(function (c, i) {
              return h('button', { key: i, type: 'button', style: crumbBtnStyle, disabled: browseBusy, onClick: function () { browseTo(c.path) } }, c.name)
            })),
          browseErr !== null ? h('div', { style: { padding: '6px 8px', fontSize: 12, lineHeight: '18px', color: tok.error } }, browseErr) : null,
          h('div', { style: { maxHeight: 210, overflowY: 'auto', padding: '4px' } },
            browseBusy ? h('div', { style: { padding: '6px 8px', fontSize: 12, color: tok.text3 } }, '读取中…')
              : browseEntries.length === 0 ? h('div', { style: { padding: '6px 8px', fontSize: 12, color: tok.text3 } }, '（没有可进入的子目录）')
              : browseEntries.map(function (entry) {
                  return h('button', {
                    key: entry.path,
                    type: 'button',
                    style: { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', borderRadius: 6, padding: '4px 8px', fontSize: 12, lineHeight: '18px', color: tok.text2, cursor: 'pointer' },
                    onClick: function () { browseTo(entry.path) },
                  }, '▸ ' + entry.name)
                })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderTop: '0.5px solid ' + tok.border } },
            h('span', { style: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: '16px', color: tok.text3, fontFamily: tok.code, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, browsePath),
            h('button', { type: 'button', style: { border: '1px solid rgba(140, 145, 155, 0.6)', background: 'none', borderRadius: 7, padding: '4px 8px', fontSize: 12, lineHeight: '18px', color: tok.text2, cursor: 'pointer' }, onClick: function () { setBrowseOpen(false) } }, '取消浏览'),
            h('button', { type: 'button', style: { border: 'none', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-bg-layer-3, #fff)', borderRadius: 7, padding: '4px 10px', fontSize: 12, lineHeight: '18px', cursor: 'pointer' }, onClick: chooseBrowseDir }, '选择此目录')))
      }

      function removePath(index) {
        var next = paths.slice()
        next.splice(index, 1)
        setPaths(next)
        setErr(null)
      }

      function addOneTool(tool) {
        var next = toolsSel.slice()
        if (next.indexOf(tool) === -1) next.push(tool)
        setToolsSel(next)
        setToolsOnly(true)
        setErr(null)
      }
      function dropTool(tool) {
        var next = toolsSel.slice()
        var at = next.indexOf(tool)
        if (at !== -1) next.splice(at, 1)
        setToolsSel(next)
        if (next.length === 0) setToolsOnly(false)
        setErr(null)
      }
      function clearTools() {
        setToolsSel([])
        setToolsOnly(false)
        setToolsOpen(false)
        setErr(null)
      }
      var toolCardStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, border: '1px solid rgba(140, 145, 155, 0.55)', borderRadius: 10, padding: '6px 8px', minWidth: 0, cursor: 'pointer', background: 'transparent' }
      function toolSwitchStyle(on, disabled) {
        return { position: 'relative', boxSizing: 'border-box', width: 32, height: 18, borderRadius: 999, border: '1px solid ' + (on ? 'transparent' : 'rgba(140, 145, 155, 0.6)'), background: on ? 'var(--dsw-alias-button-primary-fill)' : 'transparent', padding: 0, cursor: disabled ? 'default' : 'pointer', flex: 'none' }
      }
      function toolKnobStyle(on) {
        return { position: 'absolute', top: 2, left: on ? 16 : 2, width: 12, height: 12, borderRadius: '50%', background: on ? '#fff' : 'rgba(140, 145, 155, 0.85)' }
      }

      function saveRule() {
        var trimmedId = id.trim()
        if (trimmedId === '') { setErr('规则 id 不能为空'); return }
        if ((props.existingIds || []).indexOf(trimmedId) !== -1) { setErr('id 已存在：' + trimmedId); return }
        if (paths.length === 0) { setErr('至少添加一个绝对路径'); return }
        var rule = { id: trimmedId, mode: mode, paths: paths.slice() }
        if (toolsOnly) {
          if (toolsSel.length === 0) { setErr('请至少勾选一个工具，或改回「全部」'); return }
          rule.tools = toolsSel.slice()
        }
        if (note.trim() !== '') rule.note = note.trim()
        props.onSave(rule)
      }

      var pathRows = paths.length === 0
        ? null
        : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column' } },
            paths.map(function (path, i) {
              return h('div', { key: 'p' + i, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
                h('span', { style: { flex: 1, minWidth: 0, fontFamily: tok.code, fontSize: 12, lineHeight: '18px', color: tok.text2, wordBreak: 'break-all' } }, path),
                h('button', { type: 'button', style: pathRemoveBtnStyle, onClick: function () { removePath(i) } }, '移除'))
            }))
      var browsePanel = browseOpen ? buildBrowsePanel() : null
      return h(Modal, {
        open: props.open,
        onClose: props.onClose,
        className: vwDialogClass,
        title: initial ? '编辑文件' : 'add',
        closeLabel: '关闭',
        footer: h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(Button, { variant: 'ghost', style: ghostOutline, onClick: props.onClose }, '取消'),
          h(Button, { variant: 'primary', onClick: saveRule }, '保存')),
      },
        err !== null ? h('p', { role: 'alert', style: { margin: '0 0 10px', fontSize: 12, lineHeight: '18px', color: tok.error } }, err) : null,
        h('div', { style: fieldRowStyle() },
          h('div', { style: fieldLabelStyle() }, '规则 id'),
          h('div', { style: rightCol },
            h(Input, { value: id, onChange: function (e) { setId(e.target.value); setErr(null) }, placeholder: '如 personal-vault', style: { width: '100%' } }))),
        h('div', { style: fieldRowStyle() },
          h('div', { style: fieldLabelStyle() }, '模式'),
          h('div', { style: rightCol },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', position: 'relative' } },
              h(Pill, { active: mode === 'hidden', onClick: function () { setMode('hidden'); setErr(null) } }, '隐藏'),
              h(Pill, { active: mode === 'deny', onClick: function () { setMode('deny'); setErr(null) } }, '拒绝'),
              h('button', {
                type: 'button',
                'aria-label': '查看模式说明',
                onMouseEnter: function () { setTipOpen(true) },
                onMouseLeave: function () { setTipOpen(false) },
                onFocus: function () { setTipOpen(true) },
                onBlur: function () { setTipOpen(false) },
                style: { border: '1px solid rgba(140, 145, 155, 0.6)', background: 'none', borderRadius: '50%', width: 20, height: 20, padding: 0, fontSize: 12, lineHeight: '18px', color: tok.text2, cursor: 'pointer', textAlign: 'center' },
              }, '?'),
              tipOpen && MODE_META[mode]
                ? h('div', { style: { position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, maxWidth: 360, padding: '6px 10px', borderRadius: 6, background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', fontSize: 12, lineHeight: '18px', boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)' } }, MODE_META[mode].desc)
                : null))),
        h('div', { style: fieldRowStyle() },
          h('div', { style: fieldLabelStyle() }, '路径'),
          h('div', { style: rightCol },
            pathRows,
            browsePanel,
            h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
              h(Input, {
                value: addInput,
                onChange: function (e) { setAddInput(e.target.value); setErr(null) },
                onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); addPath(addInput) } },
                placeholder: '输入要隔离的绝对路径',
                style: { width: '100%' },
              }),
              h(Button, { variant: 'primary', size: 'sm', onClick: function () { addPath(addInput) } }, '添加'),
              canBrowse() ? h(Button, { variant: 'ghost', size: 'sm', style: ghostOutline, onClick: openBrowser }, '浏览') : null))),
        h('div', { style: fieldRowStyle() },
          h('div', { style: fieldLabelStyle() }, '备注'),
          h('div', { style: rightCol },
            h(Input, { value: note, onChange: function (e) { setNote(e.target.value) }, placeholder: '这条规则保护什么', style: { width: '100%' } }))),
        h('div', { style: fieldRowStyle() },
          h('div', { style: fieldLabelStyle() }, '工具范围'),
          h('div', { style: rightCol },
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
              h('div', { key: 'allcard', style: toolCardStyle, onClick: function () { if (toolsSel.length !== 0) clearTools() } },
                h('span', { style: { flex: 1, minWidth: 0, fontSize: 13, color: tok.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '全部（不限定）'),
                h('button', { type: 'button', onClick: function (e) { e.stopPropagation(); if (toolsSel.length !== 0) clearTools() }, style: toolSwitchStyle(toolsSel.length === 0, toolsSel.length === 0) }, h('span', { style: toolKnobStyle(toolsSel.length === 0) }))),
              TOOL_OPTIONS.map(function (tool) {
                var on = toolsSel.indexOf(tool) !== -1
                return h('div', { key: tool, style: toolCardStyle, onClick: function () { if (on) dropTool(tool); else addOneTool(tool) } },
                  h('span', { style: { flex: 1, minWidth: 0, fontFamily: tok.code, fontSize: 13, color: tok.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tool),
                  h('button', { type: 'button', onClick: function (e) { e.stopPropagation(); if (on) dropTool(tool); else addOneTool(tool) }, style: toolSwitchStyle(on) }, h('span', { style: toolKnobStyle(on) })))
              }))))
      )
    }

    // ===================== JSON 视图 Modal =====================
    function JsonEditorModal(props) {
      var textState = useState('')
      var text = textState[0]
      var setText = textState[1]
      var errState = useState(null)
      var err = errState[0]
      var setErr = errState[1]
      useEffect(function () {
        if (props.open) { setText(props.text); setErr(null) }
      }, [props.open])

      function apply() {
        var trimmed = text.trim()
        if (trimmed === '') { props.onApply(''); return }
        var parsed = parseRules(text)
        if (parsed && parsed.error) { setErr('JSON 无效：' + parsed.error); return }
        props.onApply(trimmed)
      }

      return h(Modal, {
        open: props.open,
        onClose: props.onClose,
        className: vwDialogClass,
        title: '以 JSON 编辑规则',
        closeLabel: '关闭',
        description: 'version 1 文档。点「解析并应用到列表」只更新草稿，仍需点页面「保存更改」写入。',
        footer: h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(Button, { variant: 'ghost', style: ghostOutline, onClick: props.onClose }, '取消'),
          h(Button, { variant: 'primary', onClick: apply }, '解析并应用到列表')),
      },
        err !== null ? h('p', { role: 'alert', style: { margin: '0 0 8px', fontSize: 12, lineHeight: '18px', color: tok.error } }, err) : null,
        h('textarea', {
          rows: 16,
          spellCheck: false,
          style: textAreaStyle(),
          value: text,
          onChange: function (e) { setText(e.target.value); setErr(null) },
        }),
      )
    }

    // ===================== 页面：规则列表 =====================
    function VaultWallSection(props) {
      // snap：优先用渲染器按 hooks.scope 绑定的 useScope seat；个别宿主没绑定时
      // 退回自订阅 scope（getSnapshot/subscribe 契约，见 SettingsScopeController）。
      var useScope = typeof props.useScope === 'function' ? props.useScope : null
      var scope = props.scope
      var snapState = useState(function () {
        if (useScope) return useScope(function (s) { return s })
        return readScopeSnap(scope)
      })
      var snap = snapState[0]
      var setSnap = snapState[1]
      useEffect(function () {
        if (useScope) return
        if (!scope || typeof scope.subscribe !== 'function') return
        var off = scope.subscribe(function () { setSnap(readScopeSnap(scope)) })
        return function () { off() }
      }, [])

      var rawState = useState('')
      var rawText = rawState[0]
      var setRawText = rawState[1]
      var adoptedState = useState('')
      var adoptedText = adoptedState[0]
      var setAdoptedText = adoptedState[1]
      var adoptErrState = useState(null)
      var adoptErr = adoptErrState[0]
      var setAdoptErr = adoptErrState[1]
      var savingState = useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var savedState = useState(false)
      var saved = savedState[0]
      var setSaved = savedState[1]
      var pageErrState = useState(null)
      var pageErr = pageErrState[0]
      var setPageErr = pageErrState[1]
      var editState = useState(null) // { index } | { new: true } | null
      var edit = editState[0]
      var setEdit = editState[1]
      var jsonState = useState(false)
      var jsonOpen = jsonState[0]
      var setJsonOpen = jsonState[1]

      var dirty = rawText !== adoptedText

      useEffect(function () {
        if (snap.status !== 'ready') return
        var next = rulesJsonOf(snap)
        if (!dirty) {
          setRawText(next)
          setAdoptedText(next)
          var parsed = parseRules(next)
          setAdoptErr(parsed && parsed.error ? parsed.error : null)
        }
      }, [snap.status, snap.value])

      // 弹窗以「设置面板」水平中心为准（右侧工作区不应影响其出现位置）。
      var rootRef = react.useRef(null)
      var modalVisible = edit !== null || jsonOpen
      useEffect(function () {
        if (!modalVisible) return
        var el = rootRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        var delta = (rect.left + rect.width / 2) - window.innerWidth / 2
        shiftDialog(delta)
        return function () { shiftDialog(0) }
      }, [modalVisible])

      // uiWorkspace 服务延迟就绪轮询（不阻塞激活）：可用后点亮「浏览」。
      var browseCapState = useState(browseReady())
      var browseCapable = browseCapState[0]
      var setBrowseCapable = browseCapState[1]
      useEffect(function () {
        var timer = null
        function tick() {
          if (browseReady()) { setBrowseCapable(true); return true }
          return false
        }
        if (tick()) return
        timer = setInterval(function () {
          if (tick()) clearInterval(timer)
        }, 700)
        return function () { if (timer !== null) clearInterval(timer) }
      }, [])

      var parsedRules = parseRules(rawText)
      var listRules = parsedRules && !parsedRules.error ? parsedRules : null

      function commitRules(nextRules) {
        var validation = validateRules(nextRules)
        if (validation !== null) { setPageErr(validation); return false }
        setRawText(serialize(nextRules))
        setPageErr(null)
        setSaved(false)
        return true
      }
      function addRule(rule) {
        if (edit && edit.new) {
          var next = listRules ? listRules.concat([rule]) : [rule]
          if (commitRules(next)) setEdit(null)
        }
      }
      function updateRule(rule) {
        if (edit && typeof edit.index === 'number' && listRules) {
          var next = listRules.slice()
          next[edit.index] = rule
          if (commitRules(next)) setEdit(null)
        }
      }
      function removeRule(index) {
        if (!listRules) return
        var next = listRules.filter(function (_, i) { return i !== index })
        if (commitRules(next)) setSaved(false)
      }
      function applyJsonText(text) {
        var clean = text.trim() === '' ? serialize([]) : JSON.stringify(JSON.parse(text), null, 2)
        setRawText(clean)
        setAdoptErr(null)
        setPageErr(null)
        setSaved(false)
        setJsonOpen(false)
      }
      function saveAll() {
        var effective = listRules === null ? [] : listRules
        var validation = validateRules(effective)
        if (validation !== null) { setPageErr(validation); return }
        if (rawText.trim() !== '' && listRules === null) {
          setPageErr('当前内容不是合法 JSON，无法保存：' + adoptErr)
          return
        }
        var text = rawText.trim() === '' ? serialize([]) : JSON.stringify(JSON.parse(rawText), null, 2)
        setPageErr(null)
        setSaved(false)
        setSaving(true)
        var ops = [{ op: 'set', path: ['rulesJson'], value: text }]
        var expectedRevision = snap.revision
        scope.mutate(ops, expectedRevision).then(function () {
          var latest = ''
          try {
            latest = rulesJsonOf(scope.getSnapshot())
          } catch (e2) { /* 忽略 */ }
          if (latest !== text) {
            adoptLatestAfterWrite()
            setPageErr('写入被拒（并发修改）——已载入最新值，请复查后重试')
          } else {
            setAdoptedText(text)
            setSaved(true)
          }
          setSaving(false)
        }, function (err) {
          adoptLatestAfterWrite()
          setPageErr('保存失败：' + String(err && err.message ? err.message : err))
          setSaving(false)
        })
      }
      function revert() {
        setRawText(adoptedText)
        setPageErr(null)
        setSaved(false)
      }
      function adoptLatestAfterWrite() {
        var latest = ''
        try {
          latest = rulesJsonOf(scope.getSnapshot())
        } catch (e) { /* 忽略 */ }
        if (latest !== '') {
          setRawText(latest)
          setAdoptedText(latest)
        } else {
          setAdoptedText(rawText)
        }
      }

      var editable = snap.status === 'ready' && snap.writable === true
      var editingRule = null
      var existingIds = []
      if (edit && listRules) {
        if (typeof edit.index === 'number') editingRule = listRules[edit.index]
        existingIds = listRules.filter(function (_, i) { return i !== edit.index }).map(function (r) { return r.id })
      }

      if (snap.status === 'loading') {
        return h('div', { style: { padding: '4px 0', fontSize: 13, lineHeight: '20px', color: tok.text3 } },
          '正在加载设置…（若长期停留，请重启宿主后重试并保留此页反馈）')
      }

      // 说明 + 操作条
      var header = [
        h('p', { key: 'intro', style: { margin: 0, fontSize: 14, lineHeight: '22px', color: tok.text3 } },
          '配置隔离墙：被保护的路径对 agent 不可读、不可触碰。隐藏 = 装作不存在；拒绝 = 明确报错。保存即实时生效。'),
        h('div', { key: 'toolbar', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, flexWrap: 'wrap' } },
          h(Button, {
            variant: 'primary',
            icon: h(IconPlusOutline16, { size: 16 }),
            disabled: !editable,
            onClick: function () { setEdit({ new: true }); setPageErr(null) },
          }, '新增文件'),
          h(Button, { variant: 'ghost', style: ghostOutline, disabled: !editable, onClick: function () { setJsonOpen(true); setPageErr(null) } }, '以 JSON 编辑'),
          dirty ? h(Button, { variant: 'ghost', style: ghostOutline, onClick: revert }, '放弃更改') : null,
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto' } },
            h(Button, { variant: 'primary', disabled: !editable || saving || !dirty, onClick: saveAll }, saving ? '保存中…' : '保存更改'),
            saved ? h('span', { role: 'status', style: { fontSize: 12, lineHeight: '18px', color: tok.success } }, '已保存并生效 ✓') : null,
            pageErr !== null ? h('span', { role: 'alert', style: { fontSize: 12, lineHeight: '18px', color: tok.error } }, pageErr) : null)),
      ]

      // 状态横幅
      if (snap.status === 'unavailable') {
        header.push(h('p', { key: 'unavail', role: 'alert', style: { margin: '12px 0 0', fontSize: 12, lineHeight: '18px', color: tok.error } },
          '命名空间不可用（writable=' + String(snap.writable) + '）——规则改不了，请检查宿主设置服务。'))
      } else if (snap.writable === false) {
        header.push(h('p', { key: 'ro', role: 'alert', style: { margin: '12px 0 0', fontSize: 12, lineHeight: '18px', color: tok.error } }, '当前宿主文档只读，无法保存。'))
      }
      if (parseWarn()) {
        header.push(h('p', { key: 'warn', role: 'alert', style: { margin: '12px 0 0', fontSize: 12, lineHeight: '18px', color: tok.warn } }, parseWarn()))
      }

      // 规则卡片列表
      var cards = []
      if (listRules) {
        for (var i = 0; i < listRules.length; i += 1) {
          ;(function (rule, index) {
            var headChildren = [
              h('span', { key: 'id', style: rowName }, rule.id),
              modeTag(rule.mode),
            ]
            if (typeof rule.note === 'string' && rule.note !== '') {
              headChildren.push(h('span', { key: 'note', style: { fontSize: 12, lineHeight: '18px', color: tok.text3 } }, rule.note))
            }
            var body = []
            for (var p = 0; p < rule.paths.length; p += 1) {
              ;(function (path) {
                body.push(h('div', { key: 'p' + p, style: mono }, path))
              })(rule.paths[p])
            }
            if (Array.isArray(rule.tools) && rule.tools.length > 0) {
              body.push(h('div', { key: 'tools', style: { fontSize: 12, lineHeight: '18px', color: tok.text3 } },
                '仅限工具：' + rule.tools.join(' · ')))
            }
            cards.push(h('div', { key: rule.id || 'r' + index, style: rowCard },
              h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', { style: rowIdentity }, headChildren),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, body)),
              h('div', { style: { display: 'inline-flex', flexDirection: 'row', gap: 2, alignItems: 'center', flex: 'none' } },
                h('button', { type: 'button', style: quietBtn(false), onClick: function () { setEdit({ index: index }) } }, '编辑'),
                h('button', { type: 'button', style: quietBtn(true), onClick: function () { removeRule(index) } }, '删除'))))
          })(listRules[i], i)
        }
      }

      function parseWarn() {
        if (adoptErr !== null) return adoptErr
        if (rawText.trim() !== '' && listRules === null) return '内容不是合法 rulesJson，无法进入列表模式（可到「以 JSON 编辑」修正）'
        return null
      }

      var emptyState = listRules === null || listRules.length === 0
        ? h('div', { key: 'empty', style: { ...rowCard, padding: '14px 16px', color: tok.text3, fontSize: 13, lineHeight: '20px' } },
            parseWarn() !== null ? '等待修正为合法 JSON…' : '还没有隔离规则——点「新增文件」添加第一条。')
        : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 } }, cards)

      return h('div', { ref: rootRef, style: { display: 'flex', flexDirection: 'column', gap: 4, width: '100%', maxWidth: 760, color: tok.text } },
        header,
        emptyState,
        edit !== null
          ? h(RuleEditorModal, {
              open: true,
              initial: edit.new ? null : editingRule,
              existingIds: existingIds,
              onSave: edit.new ? addRule : updateRule,
              onClose: function () { setEdit(null) },
            })
          : null,
        jsonOpen
          ? h(JsonEditorModal, {
              open: true,
              text: rawText.trim() === '' ? '{\n  "version": 1,\n  "rules": []\n}' : rawText,
              onApply: applyJsonText,
              onClose: function () { setJsonOpen(false) },
            })
          : null,
      )
    }

    /** 浏览器半主逻辑：绑定 vault-wall scope 并注册 settings.section 页面。 */
    function apply(ctx) {
      rootCtx = ctx
      ensureModalWidthStyle()
      var scope = ctx.settingsScope.bind({ namespace: 'vault-wall' })
      var injected = function () {
        return {
          hooks: { scope: scope },
          scope: scope,
        }
      }
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'vault-wall',
          order: 40,
          label: '保险区 Vault Wall',
          inject: injected,
        }, VaultWallSection)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
