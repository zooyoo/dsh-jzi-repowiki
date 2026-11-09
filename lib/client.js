/**
 * Browser half of dsh-plugin-repowiki: the sidebar entry and the Repo Wiki
 * browsing page (left tree + rendered markdown + source citations).
 *
 * Shipped as a prebuilt `window.__ModuleLoader__.load(...)` bundle, which is
 * how DSH loads client halves. React and the UI primitives come from the
 * host platform modules; nothing here is bundled from npm. Data comes from
 * the host's same-origin `/plugins/dsh-plugin-repowiki/api/*` routes served
 * by the host half, so no custom remote namespace is needed.
 *
 * @module dsh-plugin-repowiki/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-repowiki',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    /**
     * `createElement`, not the jsx-runtime `jsx` — varargs-children style, as
     * documented by the WorkBuddy/Tuanjie bundles (mixing the two signatures
     * passes children as keys and throws inside React).
     */
    const h = react.createElement
    const Fragment = react.Fragment
    const useState = react.useState
    const useEffect = react.useEffect
    const useCallback = react.useCallback
    const useMemo = react.useMemo
    const emptySnapshot = {}
    const useEmptyStore = () => emptySnapshot

    /** Markdown renderer from the platform UI library, when available. */
    let MarkdownText = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      MarkdownText = primitives?.MarkdownText ?? null
    } catch { /* fall back to the plain renderer below */ }

    /**
     * Stable Cordis plugin name for the browser half — must NOT equal the
     * host half's name (two separate cordis plugins in one runtime).
     */
    const name = 'dsh-plugin-repowiki-client'

    /** Services this half needs before it can contribute. */
    const inject = ['slots', 'locale', 'workspaces', 'sessions']

    /** Locale namespace owned by this plugin. */
    const NS = 'repowiki'

    /** Same-origin API base served by the host half. */
    const API_BASE = '/plugins/dsh-plugin-repowiki/api'

    /** Source-of-truth (zh) dictionary. */
    const zh = {
      panel: 'Repo Wiki',
      loading: '加载中…',
      refresh: '刷新',
      refreshStatus: '检查更新',
      statusOk: '全部页面均为最新',
      noBaseline: '无增量更新基线：可以浏览 Qoder Wiki，但尚不能判断源码变化或页面是否过期。',
      sources: '本文引用的文件',
      updatedAt: '更新于',
      generatedAt: '快照时间',
      pagesCount: '页',
      noWikiTitle: '此工作区还没有 Repo Wiki',
      noWikiBody: '在会话中让 agent 运行 repowiki_init 创建骨架，然后由 agent 调用 repowiki_scan / repowiki_write_page 生成并增量维护页面。生成的 Wiki 兼容 Qoder 的 .qoder/repowiki 结构。',
      noWorkspaceTitle: '无法确定工作区',
      noWorkspaceBody: '请先打开一个工作区或会话，然后刷新。',
      workspace: '工作区',
      errorTitle: '无法加载 Repo Wiki',
      selectPage: '从左侧目录选择一个页面开始浏览',
      stale: '可能过期',
      noSources: '（未记录来源文件）',
      copyCode: '复制代码',
      copiedCode: '已复制',
      codeLabel: '代码',
      wrapCode: '自动换行',
      unwrapCode: '取消自动换行',
      footnotes: '脚注',
    }
    /** English mirror, kept key-complete with zh. */
    const en = {
      panel: 'Repo Wiki',
      loading: 'Loading…',
      refresh: 'Refresh',
      refreshStatus: 'Check freshness',
      statusOk: 'All pages are up to date',
      noBaseline: 'No incremental update baseline: Qoder pages are readable, but source changes and page freshness cannot yet be assessed.',
      sources: 'Referenced files',
      updatedAt: 'Updated',
      generatedAt: 'Snapshot',
      pagesCount: 'pages',
      noWikiTitle: 'No Repo Wiki in this workspace yet',
      noWikiBody: 'Ask the agent to run repowiki_init in a session to create the skeleton, then let it generate and maintain pages with repowiki_scan / repowiki_write_page. The output is compatible with Qoder\'s .qoder/repowiki layout.',
      noWorkspaceTitle: 'Unable to identify the workspace',
      noWorkspaceBody: 'Open a workspace or session, then refresh.',
      workspace: 'Workspace',
      errorTitle: 'Failed to load Repo Wiki',
      selectPage: 'Pick a page from the tree to start reading',
      stale: 'possibly stale',
      noSources: '(no recorded source files)',
      copyCode: 'Copy code',
      copiedCode: 'Copied',
      codeLabel: 'Code',
      wrapCode: 'Wrap lines',
      unwrapCode: 'Unwrap lines',
      footnotes: 'Footnotes',
    }

    // -------------------------------------------------------------------------
    // styles (single <style> tag, plugin-tagged, idempotent)
    // -------------------------------------------------------------------------
    const css = `
.rw-root{display:flex;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rw-tree{width:300px;min-width:220px;max-width:45%;flex:none;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:10px 8px 24px;box-sizing:border-box}
.rw-content{flex:1;min-width:0;overflow-y:auto;padding:18px 26px 48px;box-sizing:border-box}
.rw-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.rw-title{font-size:18px;font-weight:600}
.rw-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.rw-btn{min-height:26px;padding:3px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.rw-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rw-dir{font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-primary);margin-top:8px}
.rw-pageBtn{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:3px 6px;border-radius:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-pageBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rw-pageBtn[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.rw-badge{flex:none;font-size:10px;line-height:14px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.rw-badge[data-stale="true"]{color:var(--dsw-alias-label-warning,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-border-l1)}
.rw-cite{margin:10px 0 18px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.rw-citeTitle{font-weight:600;margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
.rw-citeList{margin:0;padding-left:16px;display:grid;gap:2px}
.rw-citeList code{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.rw-statusLine{margin:8px 0 2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rw-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px;text-align:center;color:var(--dsw-alias-label-secondary)}
.rw-centerTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.rw-centerBody{max-width:520px;font-size:12.5px;line-height:1.7}
.rw-fallback{white-space:pre-wrap;font-size:13px;line-height:1.7;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.rw-error{color:var(--dsw-alias-label-primary);font-size:12px;word-break:break-all}
.rw-treeSection{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.rw-treeStats{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.rw-workspace{display:flex;align-items:center;gap:6px;max-width:100%;margin:4px 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rw-workspace select{min-width:0;max-width:100%;padding:3px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}
`
    const CSS_TAG_ID = 'dsh-plugin-repowiki/repowiki.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-repowiki'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // data access
    // -------------------------------------------------------------------------
    async function fetchJson(pathname) {
      const response = await fetch(pathname, { cache: 'no-store' })
      const text = await response.text()
      let body = null
      try { body = JSON.parse(text) } catch { body = null }
      if (!response.ok) {
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
      }
      return body
    }

    /** Split a Qoder-style page into its <cite> block and the markdown body. */
    function splitCite(markdown) {
      const text = String(markdown ?? '')
      const match = text.match(/^(\s*(?:#[ \t]+[^\r\n]*(?:\r?\n)+\s*)?)<cite>([\s\S]*?)<\/cite>\s*/)
      if (match === null) return { cite: [], body: text }
      const files = [...match[2].matchAll(/\[([^\]]+)\]\(file:\/\/([^)]+)\)/g)]
        .map((m) => ({ name: m[1], path: m[2] }))
      if (files.length === 0) {
        for (const line of match[2].split('\n')) {
          const trimmed = line.trim().replace(/^[-*]\s*/, '')
          if (trimmed.length > 0 && !trimmed.startsWith('**') && !trimmed.startsWith('#')) {
            files.push({ name: trimmed, path: trimmed })
          }
        }
      }
      return { cite: files, body: match[1] + text.slice(match[0].length) }
    }

    // -------------------------------------------------------------------------
    // components
    // -------------------------------------------------------------------------
    function PanelIcon({ size }) {
      const s = size ?? 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
      },
        h('path', {
          d: 'M2.5 3.2c0-.66.54-1.2 1.2-1.2h3.1c.66 0 1.2.54 1.2 1.2v9.1c0 .66-.54 1.2-1.2 1.2H3.7c-.66 0-1.2-.54-1.2-1.2V3.2Z',
          stroke: 'currentColor', 'stroke-width': 1.2,
        }),
        h('path', {
          d: 'M8 3.2c0-.66.54-1.2 1.2-1.2h3.1c.66 0 1.2.54 1.2 1.2v9.1c0 .66-.54 1.2-1.2 1.2H9.2c-.66 0-1.2-.54-1.2-1.2V3.2Z',
          stroke: 'currentColor', 'stroke-width': 1.2,
        }),
        h('path', { d: 'M3.6 5h3M3.6 7h3M9.4 5h3M9.4 7h3', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linecap': 'round' }),
      )
    }

    function TreeNode({ node, depth, selected, onSelect, staleSet }) {
      const isDir = node.children.length > 0
      const [open, setOpen] = useState(depth < 2)
      const meta = node.page
      const stale = meta !== null && staleSet !== null && staleSet.has(meta.path)
      const row = isDir
        ? h('div', {
          className: 'rw-dir', style: { paddingLeft: `${depth * 12 + 4}px`, cursor: 'pointer' },
          onClick: () => setOpen((v) => !v),
          title: node.name,
        }, (open ? '▾ ' : '▸ ') + node.name)
        : h('button', {
          type: 'button', className: 'rw-pageBtn',
          'data-active': selected === (meta?.path ?? null),
          style: { paddingLeft: `${depth * 12 + 6}px` },
          onClick: () => meta?.path != null && onSelect(meta.path),
          title: node.name,
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, node.name),
          stale ? h('span', { className: 'rw-badge', 'data-stale': 'true' }, '!') : null,
        )
      return h(Fragment, null, row,
        isDir && open && node.children.map((child, i) => h(TreeNode, {
          key: `${child.name}#${i}`, node: child, depth: depth + 1,
          selected, onSelect, staleSet,
        })))
    }

    function CiteBlock({ files, t }) {
      if (files.length === 0) return null
      return h('div', { className: 'rw-cite' },
        h('div', { className: 'rw-citeTitle' }, t('sources')),
        h('ul', { className: 'rw-citeList' },
          files.map((f, i) => h('li', { key: `${f.path}#${i}` }, h('code', null, f.path ?? f.name)))))
    }

    function PlainMarkdown({ text }) {
      return h('div', { className: 'rw-fallback' }, text)
    }

    /** 根据主视图会话选择工作区；没有会话时采用宿主记录的最近工作区。 */
    function resolveWorkspaceId(workspaces, sessions, explicitSessionId) {
      const items = workspaces?.items ?? []
      const byId = sessions?.byId ?? {}
      const active = Object.values(byId)
        .filter((row) => (row.retainedBy?.mainView ?? 0) > 0)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
      const sessionId = explicitSessionId ?? active?.id
      const current = items.find((item) => item.sessionIds?.includes(sessionId))
      if (current) return current.workspaceId
      if (items.some((item) => item.workspaceId === workspaces?.recentWorkspaceId)) {
        return workspaces.recentWorkspaceId
      }
      let recent
      let latest = -Infinity
      for (const item of items) {
        const sessionTimes = (item.sessionIds ?? []).map((id) => Number(byId[id]?.updatedAt) || 0)
        const createdAt = Date.parse(item.createdAt) || 0
        const updatedAt = sessionTimes.length > 0 ? Math.max(...sessionTimes, 0) : 0
        const timestamp = updatedAt || createdAt
        if (!recent || timestamp > latest) { recent = item; latest = timestamp }
      }
      return recent?.workspaceId
    }

    /**
     * The Repo Wiki browsing page: left tree + right rendered markdown.
     * Registered into the `main` keyed slot with key "repowiki"; the sidebar
     * panel entry switches to it via ctx.layout.selectPanel.
     */
    function RepowikiPage(props) {
      const { t } = props
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useEmptyStore
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : useEmptyStore
      const workspaces = useWorkspaces((state) => state)
      const sessions = useSessions((state) => state)
      const items = workspaces?.items ?? []
      const [chosenWorkspace, setChosenWorkspace] = useState(null)
      const inferredWorkspace = resolveWorkspaceId(workspaces, sessions, props.sessionId)
      const workspaceId = items.some((item) => item.workspaceId === chosenWorkspace)
        ? chosenWorkspace : inferredWorkspace
      const workspaceQuery = workspaceId ? `workspaceId=${encodeURIComponent(workspaceId)}` : ''
      const generation = react.useRef(0)
      const pageGeneration = react.useRef(0)
      const [wiki, setWiki] = useState(null)          // /api/wiki payload
      const [phase, setPhase] = useState('loading')   // loading|error|no-workspace|nowiki|ok
      const [errorText, setErrorText] = useState('')
      const [selected, setSelected] = useState(null)  // selected page path
      const [page, setPage] = useState(null)          // /api/page payload
      const [pageError, setPageError] = useState('')
      const [statusLine, setStatusLine] = useState(null)

      const refresh = useCallback(async () => {
        const request = ++generation.current
        pageGeneration.current++
        setPhase('loading')
        setPage(null)
        setSelected(null)
        setPageError('')
        setStatusLine(null)
        try {
          const data = await fetchJson(`${API_BASE}/wiki?${workspaceQuery}`)
          if (request !== generation.current) return
          if (data?.state === 'ok') {
            setWiki(data)
            setPhase('ok')
          } else if (data?.state === 'no-wiki') {
            setPhase(data.reason === 'Run repowiki_init in a session workspace first.' ? 'no-workspace' : 'nowiki')
          } else {
            setPhase('error')
            setErrorText(data?.error ?? data?.reason ?? String(data?.state ?? 'unknown'))
          }
        } catch (error) {
          if (request !== generation.current) return
          setPhase('error')
          setErrorText(String(error?.message ?? error))
        }
      }, [workspaceQuery])

      useEffect(() => {
        void refresh()
        return () => { generation.current++; pageGeneration.current++ }
      }, [refresh])

      const openPage = useCallback(async (pagePath) => {
        const workspaceRequest = generation.current
        const request = ++pageGeneration.current
        setSelected(pagePath)
        setPageError('')
        try {
          const data = await fetchJson(`${API_BASE}/page?${workspaceQuery}&path=${encodeURIComponent(pagePath)}`)
          if (workspaceRequest !== generation.current || request !== pageGeneration.current) return
          if (data?.state === 'ok') {
            setPage(data)
          } else {
            setPage(null)
            setPageError(data?.state ?? 'error')
          }
        } catch (error) {
          if (workspaceRequest !== generation.current || request !== pageGeneration.current) return
          setPage(null)
          setPageError(String(error?.message ?? error))
        }
      }, [workspaceQuery])

      const checkStatus = useCallback(async () => {
        const request = generation.current
        try {
          const data = await fetchJson(`${API_BASE}/status?${workspaceQuery}`)
          if (request !== generation.current) return
          if (data?.state === 'ok') {
            const stale = new Set((data.pages ?? []).filter((p) => p.stale).map((p) => p.path))
            setWiki((prev) => (prev === null ? prev : { ...prev, staleSet: stale }))
            const staleCount = stale.size
            setStatusLine(staleCount === 0
              ? { ok: true, text: t('statusOk') }
              : { ok: false, text: `${staleCount} ${t('stale')}` })
          } else if (data?.state === 'no-index') {
            setStatusLine({ ok: false, text: t('noBaseline') })
          } else {
            setStatusLine({ ok: false, text: data?.reason ?? data?.state ?? 'error' })
          }
        } catch (error) {
          if (request !== generation.current) return
          setStatusLine({ ok: false, text: String(error?.message ?? error) })
        }
      }, [t, workspaceQuery])

      const workspaceSelector = items.length > 1 ? h('label', { className: 'rw-workspace' },
        h('span', null, t('workspace')),
        h('select', {
          value: workspaceId ?? '',
          'aria-label': t('workspace'),
          onChange: (event) => {
            const nextWorkspace = event.target.value
            if (nextWorkspace === workspaceId) return
            generation.current++
            pageGeneration.current++
            setChosenWorkspace(nextWorkspace)
          },
        }, items.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.path ?? item.workspaceId)))) : null

      if (phase === 'loading') {
        return h('div', { className: 'rw-root' }, h('div', { className: 'rw-center' },
          workspaceSelector,
          h('div', { className: 'rw-centerTitle' }, t('loading'))))
      }
      if (phase === 'nowiki' || phase === 'no-workspace') {
        const noWorkspace = phase === 'no-workspace'
        return h('div', { className: 'rw-root' }, h('div', { className: 'rw-center' },
          workspaceSelector,
          h('div', { className: 'rw-centerTitle' }, t(noWorkspace ? 'noWorkspaceTitle' : 'noWikiTitle')),
          h('div', { className: 'rw-centerBody' }, t(noWorkspace ? 'noWorkspaceBody' : 'noWikiBody')),
          h('button', { type: 'button', className: 'rw-btn', onClick: () => { void refresh() } }, t('refresh'))))
      }
      if (phase === 'error') {
        return h('div', { className: 'rw-root' }, h('div', { className: 'rw-center' },
          workspaceSelector,
          h('div', { className: 'rw-centerTitle' }, t('errorTitle')),
          h('div', { className: 'rw-error' }, errorText),
          h('button', { type: 'button', className: 'rw-btn', onClick: () => { void refresh() } }, t('refresh'))))
      }

      const staleSet = wiki.staleSet instanceof Set ? wiki.staleSet : null
      const tree = wiki.tree ?? []
      const split = page !== null ? splitCite(page.markdown) : { cite: [], body: '' }
      const markdownLabels = {
        code: {
          copyLabel: t('copyCode'),
          copiedLabel: t('copiedCode'),
          toolbarLabels: {
            codeLabel: t('codeLabel'),
            wrapLabel: t('wrapCode'),
            unwrapLabel: t('unwrapCode'),
          },
        },
        footnotes: t('footnotes'),
      }

      return h('div', { className: 'rw-root' },
        h('div', { className: 'rw-tree' },
          h('div', { className: 'rw-treeSection' },
            h('span', { className: 'rw-treeStats' },
              `${wiki.pageCount ?? 0} ${t('pagesCount')} · ${wiki.workspace ?? ''}`),
            h('button', { type: 'button', className: 'rw-btn', onClick: () => { void refresh() } }, t('refresh'))),
          workspaceSelector,
          tree.map((node, i) => h(TreeNode, {
            key: `${node.name}#${i}`, node, depth: 0, selected, onSelect: openPage, staleSet,
          }))),
        h('div', { className: 'rw-content' },
          wiki.incrementalBaseline === false ? h('div', { className: 'rw-statusLine' }, t('noBaseline')) : null,
          page === null
            ? h('div', { className: 'rw-center', style: { height: '100%' } },
              h('div', { className: 'rw-centerBody' }, pageError !== '' ? pageError : t('selectPage')))
            : h(Fragment, null,
              h('div', { className: 'rw-header' },
                h('span', { className: 'rw-title' }, page.title),
                h('span', { className: 'rw-meta' },
                  page.updatedAt != null ? `${t('updatedAt')} ${page.updatedAt}` : null,
                  page.size != null ? ` · ${(page.size / 1024).toFixed(1)} KiB` : null),
                h('button', { type: 'button', className: 'rw-btn', onClick: () => { void checkStatus() } }, t('refreshStatus'))),
              statusLine !== null ? h('div', { className: 'rw-statusLine' }, statusLine.text) : null,
              h(CiteBlock, { files: split.cite, t }),
              MarkdownText !== null
                ? h(MarkdownText, { text: split.body, variant: 'body', labels: markdownLabels })
                : h(PlainMarkdown, { text: split.body }))))
    }

    // -------------------------------------------------------------------------
    // registration
    // -------------------------------------------------------------------------

    /** 订阅宿主服务的数据源；服务不可用时使用稳定的空快照。 */
    function useFeed(feed) {
      const subscribe = useCallback((notify) => feed?.subscribe?.(notify) ?? (() => {}), [feed])
      const getSnapshot = useCallback(() => feed?.getSnapshot?.() ?? emptySnapshot, [feed])
      return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /**
     * Register the locale dictionaries, the sidebar entry, and the main page.
     * @param ctx - browser plugin context with the injected services.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      // 主区域插槽不一定提供工作区 hook，从宿主服务订阅作为回退。
      function BoundRepowikiPage(props) {
        const workspaces = useFeed(ctx.workspaces.list)
        const sessions = useFeed(ctx.sessions.list)
        return h(RepowikiPage, {
          ...props,
          useWorkspaces: props.useWorkspaces ?? ((select) => select(workspaces)),
          useSessions: props.useSessions ?? ((select) => select(sessions)),
        })
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'repowiki: dictionaries')
      ctx.effect(
        () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'repowiki',
          order: 45,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon)),
        'repowiki: sidebar panel entry',
      )
      ctx.effect(
        () => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'repowiki',
          locale: NS,
        }, BoundRepowikiPage)),
        'repowiki: main wiki page',
      )
    }

    exports.NS = NS
    exports.PANEL_ID = 'repowiki'
    exports.RepowikiPage = RepowikiPage
    exports.PanelIcon = PanelIcon
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
