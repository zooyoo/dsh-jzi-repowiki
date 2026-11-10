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
    const useLayoutEffect = react.useLayoutEffect ?? useEffect
    let createPortal = null
    try { createPortal = require('react-dom')?.createPortal ?? null } catch { /* 旧宿主保留常规渲染路径。 */ }
    const canCacheOffline = typeof createPortal === 'function' && typeof document !== 'undefined' && typeof document.createElement === 'function'
    const emptySnapshot = {}
    const identitySnapshot = (state) => state
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
      catalog: '文档目录',
      pageContents: '本页目录',
      searchPages: '搜索 Wiki 页面…',
      clearSearch: '清除搜索',
      noResults: '没有找到匹配的页面',
      trySearch: '试试其他关键词',
      expandSection: '展开章节',
      collapseSection: '收起章节',
      expandAll: '全部展开',
      collapseAll: '全部收起',
      openCatalog: '打开文档目录',
      closeCatalog: '关闭文档目录',
      baselineHint: '尚未建立增量更新基线',
      previousPage: '上一篇',
      nextPage: '下一篇',
      retry: '重试',
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
      catalog: 'Contents',
      pageContents: 'On this page',
      searchPages: 'Search Wiki pages…',
      clearSearch: 'Clear search',
      noResults: 'No matching pages',
      trySearch: 'Try another keyword',
      expandSection: 'Expand section',
      collapseSection: 'Collapse section',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      openCatalog: 'Open contents',
      closeCatalog: 'Close contents',
      baselineHint: 'Incremental baseline not set up',
      previousPage: 'Previous',
      nextPage: 'Next',
      retry: 'Retry',
    }

    // -------------------------------------------------------------------------
    // styles (single <style> tag, plugin-tagged, idempotent)
    // -------------------------------------------------------------------------
    const css = `
.rw-root{--rw-bg:var(--dsw-alias-bg-layer-1,#fff);--rw-surface:var(--dsw-alias-bg-layer-2,#f5f6f8);--rw-ink:var(--dsw-alias-label-primary,#202735);--rw-muted:var(--dsw-alias-label-secondary,#596273);--rw-faint:var(--dsw-alias-label-tertiary,#737c8b);--rw-line:var(--dsw-alias-border-l1,#e4e7ec);--rw-accent:var(--dsw-alias-link,#3774cf);--rw-tint:color-mix(in srgb,var(--rw-accent) 10%,var(--rw-bg));display:flex;position:relative;container:repowiki / inline-size;isolation:isolate;width:100%;height:100%;min-height:0;overflow:hidden;color:var(--rw-ink);background:var(--rw-bg);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5}
.rw-root *{box-sizing:border-box}
:where(.rw-root) :is(button,input,select){font:inherit}
.rw-root button{cursor:pointer}
.rw-root button:disabled{cursor:wait;opacity:.55}
.rw-root :is(button,input,select,summary,a):focus-visible{outline:2px solid var(--rw-accent);outline-offset:2px}
.rw-root button,.rw-root summary{transition:background-color .15s ease,color .15s ease}
.rw-icon{display:block;width:16px;height:16px;flex:none}
.rw-tree{display:flex;flex-direction:column;width:296px;min-width:0;flex:none;border-right:1px solid var(--rw-line);background:var(--rw-bg)}
.rw-treeHeader{flex:none;padding:20px 16px 14px}
.rw-treeSection{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.rw-brand{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:650;letter-spacing:-.02em}
.rw-brand>.rw-icon{width:19px;height:19px;color:var(--rw-accent)}
.rw-treeStats{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rw-faint);font-size:11px;margin-top:10px}
.rw-workspace{display:flex;align-items:center;gap:10px;max-width:100%;margin:0 0 12px;font-size:12px;color:var(--rw-muted)}
.rw-workspace>span{flex:none;white-space:nowrap}
.rw-workspace select{flex:1;min-width:0;width:100%;height:30px;padding:3px 24px 3px 8px;color:var(--rw-ink);background:var(--rw-surface);border:1px solid var(--rw-line);border-radius:6px;text-overflow:ellipsis}
.rw-search{display:flex;align-items:center;gap:8px;min-width:0;min-height:34px;padding:0 9px;border:1px solid var(--rw-line);border-radius:7px;background:var(--rw-surface);color:var(--rw-faint)}
.rw-search:focus-within{border-color:var(--rw-accent);outline:2px solid var(--rw-tint)}
.rw-search input{width:100%;min-width:0;height:32px;border:0;outline:0;background:transparent;color:var(--rw-ink);font-size:12px}
.rw-search input:focus-visible{outline:0}
.rw-search input::placeholder{color:var(--rw-faint)}
.rw-search input::-webkit-search-cancel-button{display:none}
.rw-search .rw-iconBtn{width:24px;height:24px;min-height:24px;margin-right:-4px}
.rw-catalogHeading{display:flex;align-items:center;justify-content:space-between;padding:0 16px 6px;color:var(--rw-faint);font-size:11px;letter-spacing:.02em}
.rw-treeScroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 10px 24px;scrollbar-width:thin;scrollbar-gutter:stable}
.rw-treeList,.rw-treeChildren{list-style:none;margin:0;padding:0}
.rw-treeList>.rw-treeItem+.rw-treeItem{margin-top:8px}
.rw-treeChildren{margin:3px 0 6px 15px;padding-left:10px;border-left:1px solid var(--rw-line)}
.rw-treeRow{display:flex;position:relative;align-items:center;min-height:32px;gap:1px;padding:0 4px;border-radius:6px;color:var(--rw-muted)}
.rw-treeRow:hover{background:var(--rw-surface);color:var(--rw-ink)}
.rw-treeRow[data-active="true"]{background:var(--rw-tint);color:var(--rw-accent)}
.rw-treeRow[data-active="true"]:before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--rw-accent)}
.rw-treeRow[data-trail="true"]{color:var(--rw-ink)}
.rw-toggle{display:flex;align-items:center;justify-content:center;flex:none;width:24px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--rw-faint)}
.rw-toggle:hover{color:var(--rw-ink);background:color-mix(in srgb,var(--rw-ink) 6%,transparent)}
.rw-toggle .rw-icon{width:12px;height:12px;transition:transform .15s ease}
.rw-toggle[aria-expanded="true"] .rw-icon{transform:rotate(90deg)}
.rw-pageBtn{display:flex;align-items:center;gap:7px;min-width:0;min-height:32px;flex:1;padding:6px 5px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;font-size:12.5px;line-height:20px}
.rw-pageLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.rw-pageBtn>.rw-icon{width:13px;height:13px;opacity:.65}
.rw-treeList>.rw-treeItem>.rw-treeRow>.rw-pageBtn{font-weight:600}
.rw-pageBtn[data-active="true"]{font-weight:600}
.rw-leafSpacer{flex:none;width:16px}
.rw-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:20px;padding:0 6px;border:1px solid var(--rw-line);border-radius:5px;color:var(--rw-muted);font-size:10px;font-weight:500;line-height:18px;font-variant-numeric:tabular-nums}
.rw-badge[data-stale="true"]{margin-left:auto;min-width:16px;padding:0 4px;color:var(--dsw-alias-label-warning,var(--rw-muted))}
.rw-btn,.rw-iconBtn{display:inline-flex;align-items:center;justify-content:center;flex:none;gap:6px;min-height:30px;padding:5px 10px;border:1px solid var(--rw-line);border-radius:6px;background:transparent;color:var(--rw-muted);font-size:12px;line-height:18px}
.rw-btn:hover,.rw-iconBtn:hover{background:var(--rw-surface);color:var(--rw-ink)}
.rw-iconBtn{width:30px;height:30px;padding:0;border-color:transparent}
.rw-treeFooter{flex:none;display:flex;align-items:center;gap:7px;padding:12px 16px;border-top:1px solid var(--rw-line);font-size:11px;color:var(--rw-faint)}
.rw-treeFooter .rw-icon{width:14px;height:14px}
.rw-reader{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;contain:layout style}
.rw-topbar{display:flex;align-items:center;gap:12px;min-height:54px;padding:10px 28px;border-bottom:1px solid var(--rw-line);flex:none}
.rw-breadcrumb{display:flex;align-items:center;flex:1;min-width:0;gap:8px;color:var(--rw-faint);font-size:12px;white-space:nowrap;overflow:hidden}
.rw-breadcrumb span{overflow:hidden;text-overflow:ellipsis}
.rw-breadcrumb span:last-child{color:var(--rw-muted)}
.rw-breadcrumb .rw-icon{width:12px;height:12px;opacity:.65}
.rw-menuBtn,.rw-navScrim{display:none}
.rw-content{flex:1;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;contain:layout paint style;background:var(--rw-bg);transform:translateZ(0)}
.rw-markdownCache[hidden]{display:none}
.rw-article{width:100%;max-width:none;margin:0;padding:32px 28px 48px}
.rw-header{margin-bottom:24px}
.rw-title{font-size:28px;font-weight:650;line-height:1.45;letter-spacing:-.025em;margin:0 0 12px;overflow-wrap:anywhere;color:var(--rw-ink)}
.rw-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:var(--rw-faint);font-size:11px;line-height:20px}
.rw-metaItem{display:inline-flex;align-items:center;gap:5px}
.rw-metaItem .rw-icon{width:13px;height:13px}
.rw-cite{margin:0 0 28px;border:1px solid var(--rw-line);border-radius:8px;font-size:12px;background:var(--rw-surface)}
.rw-citeTitle{display:flex;align-items:center;gap:8px;padding:10px 12px;list-style:none;cursor:pointer;color:var(--rw-muted);font-size:12px}
.rw-citeTitle::-webkit-details-marker{display:none}
.rw-citeTitle>.rw-icon:last-child{margin-left:auto;width:12px;height:12px;transition:transform .15s ease}
.rw-cite[open]>.rw-citeTitle>.rw-icon:last-child{transform:rotate(90deg)}
.rw-citeList{margin:0;padding:4px 16px 14px;list-style:none;display:grid;gap:7px}
.rw-citeList li{display:flex;gap:8px;min-width:0}
.rw-citeList code{font-size:11px;line-height:1.65;color:var(--rw-muted);overflow-wrap:anywhere}
.rw-citeList .rw-icon{width:12px;height:18px;color:var(--rw-faint)}
.rw-statusLine{display:flex;align-items:flex-start;gap:7px;margin:0 0 20px;padding:10px 12px;border:1px solid var(--rw-line);border-radius:6px;font-size:12px;color:var(--rw-muted);line-height:1.7}
.rw-statusLine .rw-icon{margin-top:2px;width:14px;height:14px}
.rw-markdown{font-size:15px;line-height:1.85;overflow-wrap:anywhere;color:var(--rw-ink)}
.rw-markdown>div{font-family:inherit;font-size:inherit;line-height:inherit}
.rw-markdown :is(h1,h2,h3,h4,h5,h6){font-family:inherit;letter-spacing:-.015em;color:var(--rw-ink);scroll-margin-top:24px}
.rw-markdown h1{font-size:26px;line-height:1.45;margin:32px 0 16px}
.rw-markdown h2{font-size:21px;font-weight:600;line-height:1.5;margin:36px 0 16px;padding-bottom:10px;border-bottom:1px solid var(--rw-line)}
.rw-markdown h3{font-size:17px;font-weight:600;line-height:1.6;margin:28px 0 12px}
.rw-markdown h4{font-size:15px;font-weight:600;margin:24px 0 10px}
.rw-markdown :is(p,ul,ol,blockquote,pre,table):not(svg *){margin-top:0;margin-bottom:18px}
/* Mermaid 在独立容器测量标签；正文行高不能改变 SVG foreignObject 的实际文字尺寸。 */
.rw-markdown :is(p,li):not(svg *){line-height:1.85}
.rw-markdown :is(ul,ol){padding-left:24px}
.rw-markdown li{margin:5px 0}
.rw-markdown li>:is(ul,ol){margin-top:6px;margin-bottom:8px}
.rw-markdown a{color:var(--rw-accent);text-underline-offset:3px;text-decoration-thickness:1px}
.rw-markdown a:hover{text-decoration:underline}
.rw-markdown :not(pre)>code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.86em;border:1px solid var(--rw-line);border-radius:4px;padding:1px 5px;background:var(--rw-surface)}
.rw-markdown pre{max-width:100%;overflow:auto;border:1px solid var(--rw-line);border-radius:8px;font-size:12px;line-height:1.7}
.rw-markdown pre code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:inherit;overflow-wrap:normal}
.rw-markdown blockquote{margin-left:0;margin-right:0;padding:6px 16px;border-left:3px solid var(--rw-line);color:var(--rw-muted)}
.rw-markdown blockquote>p:last-child{margin-bottom:0}
.rw-markdown table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;font-size:13px}
.rw-markdown :is(th,td){padding:10px 12px;border:1px solid var(--rw-line);text-align:left;line-height:1.65}
.rw-markdown th{background:var(--rw-surface);font-weight:600}
.rw-markdown :is(img,svg){max-width:100%}
/* 阅读滚动层与当前页图表分别合成，避免复杂 SVG 随滚动整区重绘。 */
.rw-markdown .dsh-mmd-pane>svg{will-change:transform;transform:translateZ(0)}
.rw-markdown hr{border:0;border-top:1px solid var(--rw-line);margin:32px 0}
.rw-toc{margin:0 0 28px;padding:18px 20px;border:1px solid var(--rw-line);border-radius:8px;font-size:12.5px;line-height:1.7}
.rw-tocTitle{font-weight:600;color:var(--rw-muted);margin-bottom:10px}
.rw-toc ol{margin:0;padding-left:20px;columns:2;column-gap:28px}
.rw-toc li{padding:3px 0;break-inside:avoid;color:var(--rw-faint)}
.rw-toc a{color:var(--rw-muted);text-decoration:none;text-underline-offset:3px}
.rw-toc a:hover{color:var(--rw-accent);text-decoration:underline}
.rw-pagination{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:48px;padding-top:24px;border-top:1px solid var(--rw-line)}
.rw-pageLink{display:flex;align-items:center;gap:12px;min-width:0;padding:14px 16px;border:1px solid var(--rw-line);border-radius:8px;color:var(--rw-muted);background:transparent;text-align:left}
.rw-pageLink:hover{background:var(--rw-surface);border-color:var(--rw-accent)}
.rw-pageLink[data-next="true"]{text-align:right;justify-content:flex-end;grid-column:2}
.rw-pageLink small{display:block;font-size:11px;color:var(--rw-faint);margin-bottom:4px}
.rw-pageLink span{min-width:0;overflow-wrap:anywhere;font-size:12px}
.rw-pageLink .rw-icon{width:14px;height:14px}
.rw-center{display:flex;flex:1;min-width:0;min-height:240px;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px 24px;text-align:center;color:var(--rw-muted)}
.rw-centerTitle{font-size:15px;font-weight:600;color:var(--rw-ink)}
.rw-centerBody{max-width:520px;font-size:13px;line-height:1.8}
.rw-emptySearch{text-align:center;padding:28px 10px;color:var(--rw-faint);font-size:12px;line-height:1.8}
.rw-emptySearch strong{display:block;font-weight:500;color:var(--rw-muted);margin-bottom:4px}
.rw-fallback{white-space:pre-wrap;font-size:14px;line-height:1.85;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.rw-error{color:var(--rw-ink);font-size:12px;overflow-wrap:anywhere}
@container repowiki (max-width:1000px){.rw-tree{width:268px}.rw-article{padding:32px 28px 48px}.rw-topbar{padding:10px 24px}.rw-title{font-size:25px}}
@container repowiki (max-width:760px){.rw-tree{display:none}.rw-menuBtn{display:inline-flex}.rw-topbar{padding:10px 16px;gap:8px}.rw-topbar>.rw-btn{padding:5px 8px;font-size:11px}.rw-article{padding:28px 22px 40px}.rw-title{font-size:24px}.rw-markdown{font-size:15px}.rw-markdown h2{font-size:20px}.rw-root[data-nav-open="true"] .rw-tree{position:absolute;inset:0 auto 0 0;z-index:3;display:flex;width:min(320px,88%);box-shadow:8px 0 32px #0002}.rw-root[data-nav-open="true"] .rw-navScrim{display:block;position:absolute;inset:0;z-index:2;border:0;background:#0004}.rw-root[data-nav-open="true"] .rw-tree .rw-menuBtn{display:inline-flex}.rw-pagination{gap:10px}.rw-pageLink{padding:12px;gap:8px}.rw-toc ol{columns:1}}
@media (prefers-reduced-motion:reduce){.rw-root *{transition:none!important;scroll-behavior:auto!important}}
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
    async function fetchJson(pathname, signal) {
      const response = await fetch(pathname, { cache: 'no-store', ...(signal ? { signal } : {}) })
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

    /** 与宿主一致的细线图标，避免字符箭头随字体改变外观。 */
    function Icon({ name }) {
      const paths = {
        book: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm16 0h-4a3 3 0 0 0-3 3m0 14a4 4 0 0 1 4-2h3V4',
        search: 'm20 20-4.5-4.5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
        refresh: 'M20 7v5h-5M4 17v-5h5M5.2 8a7 7 0 0 1 11.6-3L20 9M4 15l3.2 4A7 7 0 0 0 18.8 16',
        chevron: 'm9 5 7 7-7 7',
        file: 'M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6',
        layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
        clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
        info: 'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
        menu: 'M4 6h16M4 12h16M4 18h16',
        close: 'm6 6 12 12M6 18 18 6',
        expand: 'm8 8 4-4 4 4m-8 8 4 4 4-4',
        collapse: 'm8 4 4 4 4-4m-8 16 4-4 4 4',
        arrowLeft: 'M19 12H5m6-6-6 6 6 6',
        arrowRight: 'M5 12h14m-6-6 6 6-6 6',
      }
      return h('svg', { className: 'rw-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: paths[name] ?? paths.file }))
    }

    /** 搜索保留命中节点的祖先和原始顺序；命中章节时展示整个章节。 */
    function filterTree(nodes, query) {
      const term = query.trim().toLocaleLowerCase()
      if (!term) return nodes
      return nodes.flatMap((node) => {
        if (`${node.name} ${node.page?.title ?? ''}`.toLocaleLowerCase().includes(term)) return [node]
        const children = filterTree(node.children ?? [], term)
        return children.length ? [{ ...node, children }] : []
      })
    }

    function collectPages(nodes) {
      const pages = []
      const seen = new Set()
      const visit = (node) => {
        if (node.page?.path && !seen.has(node.page.path)) {
          seen.add(node.page.path)
          pages.push({ ...node.page, title: node.page.title ?? node.name })
        }
        for (const child of node.children ?? []) visit(child)
      }
      nodes.forEach(visit)
      return pages
    }

    function containsPage(node, selected) {
      return selected != null && (node.page?.path === selected || (node.children ?? []).some((child) => containsPage(child, selected)))
    }

    function TreeNodeView({ node, depth, selected, onSelect, staleSet, query, expandAll, t }) {
      const children = node.children ?? []
      const isDir = children.length > 0
      const [expanded, setExpanded] = useState(depth === 0)
      const rowRef = react.useRef(null)
      const active = node.page?.path != null && selected === node.page.path
      const inBranch = !active && containsPage(node, selected)
      const open = expanded
      const stale = node.page?.path != null && staleSet?.has(node.page.path)
      useEffect(() => { if (inBranch) setExpanded(true) }, [selected, inBranch])
      useEffect(() => { if (expandAll !== null) setExpanded(expandAll) }, [expandAll])
      useEffect(() => { if (query.trim()) setExpanded(true) }, [query])
      useEffect(() => { if (active) rowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [active])
      return h('li', { className: 'rw-treeItem' },
        h('div', { className: 'rw-treeRow', ref: rowRef, 'data-active': active, 'data-trail': inBranch },
          isDir ? h('button', {
            type: 'button', className: 'rw-toggle', 'aria-expanded': open,
            'aria-label': `${t(open ? 'collapseSection' : 'expandSection')} · ${node.name}`,
            onClick: () => setExpanded((value) => !value),
          }, h(Icon, { name: 'chevron' })) : h('span', { className: 'rw-leafSpacer', 'aria-hidden': true }),
          h('button', {
            type: 'button', className: 'rw-pageBtn', title: node.name,
            'data-active': active, 'aria-current': active ? 'page' : undefined,
            'aria-expanded': node.page == null && isDir ? open : undefined,
            onClick: () => node.page?.path != null ? onSelect(node.page.path) : setExpanded((value) => !value),
          },
            h(Icon, { name: isDir ? 'layers' : 'file' }),
            h('span', { className: 'rw-pageLabel' }, node.name),
            stale ? h('span', { className: 'rw-badge', 'data-stale': true, title: t('stale'), 'aria-label': t('stale') }, '!') : null)),
        isDir && open ? h('ul', { className: 'rw-treeChildren' }, children.map((child) => h(TreeNode, {
          key: child.page?.path ?? child.path ?? child.name, node: child, depth: depth + 1,
          selected, onSelect, staleSet, query, expandAll, t,
        }))) : null)
    }

    // 目录状态变化只更新必要的分支，正文不参与树节点的更新。
    const TreeNode = typeof react.memo === 'function' ? react.memo(TreeNodeView) : TreeNodeView

    function CiteBlock({ files, t }) {
      if (files.length === 0) return null
      return h('details', { className: 'rw-cite' },
        h('summary', { className: 'rw-citeTitle' },
          h(Icon, { name: 'file' }), h('span', null, t('sources')),
          h('span', { className: 'rw-badge' }, files.length), h(Icon, { name: 'chevron' })),
        h('ul', { className: 'rw-citeList' }, files.map((file, index) => h('li', { key: `${file.path}#${index}` },
          h(Icon, { name: 'file' }), h('code', null, file.path ?? file.name)))))
    }

    /** 页面标题由阅读头部呈现，只去除正文开头完全同名的一级标题。 */
    function preparePage(markdown, title) {
      const split = splitCite(markdown)
      const heading = split.body.match(/^\s*#[ \t]+([^\r\n]+)(?:\r?\n|$)/)
      const normalize = (value) => String(value ?? '').replace(/[*_`]/g, '').replace(/\s+#+\s*$/, '').trim()
      if (heading && normalize(heading[1]) === normalize(title)) split.body = split.body.slice(heading[0].length).trimStart()
      const lines = split.body.split(/\r?\n/)
      let fence = null
      let start = -1
      for (let index = 0; index < lines.length; index++) {
        const marker = lines[index].match(/^\s*(`{3,}|~{3,})/)
        if (marker) {
          if (fence === null) fence = marker[1][0]
          else if (fence === marker[1][0]) fence = null
        }
        if (fence === null && /^#{1,6}[ \t]+(?:目录|contents|table of contents)[ \t]*#*[ \t]*$/i.test(lines[index])) { start = index; break }
      }
      split.toc = []
      if (start >= 0) {
        let end = start + 1
        const entries = []
        for (; end < lines.length; end++) {
          if (!lines[end].trim()) continue
          const link = lines[end].match(/^\s*(?:\d+[.)]|[-*+])\s+\[([^\]]+)\]\((#[^\s)]+)\)\s*$/)
          if (!link) break
          let id
          try { id = decodeURIComponent(link[2].slice(1)) } catch { break }
          entries.push({ title: link[1], id })
        }
        if (entries.length > 0) {
          split.toc = entries
          split.body = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trimStart()
        }
      }
      return split
    }

    function headingSlug(text) {
      return String(text).trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s+/g, '-')
    }

    function PageContents({ entries, onNavigate, t }) {
      if (entries.length === 0) return null
      return h('nav', { className: 'rw-toc', 'aria-label': t('pageContents'), onClick: onNavigate },
        h('div', { className: 'rw-tocTitle' }, t('pageContents')),
        h('ol', null, entries.map((entry, index) => h('li', { key: `${entry.id}:${index}` },
          h('a', { href: `#${encodeURIComponent(entry.id)}` }, entry.title)))))
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
      const inferredWorkspace = props.inferredWorkspaceId ?? resolveWorkspaceId(workspaces, sessions, props.sessionId)
      const workspaceId = items.some((item) => item.workspaceId === chosenWorkspace) ? chosenWorkspace : inferredWorkspace
      const workspaceQuery = workspaceId ? `workspaceId=${encodeURIComponent(workspaceId)}` : ''
      const generation = react.useRef(0)
      const pageGeneration = react.useRef(0)
      const contentRef = react.useRef(null)
      const markdownRef = react.useRef(null)
      const documentHostRef = react.useRef(null)
      const menuRef = react.useRef(null)
      const rootRef = react.useRef(null)
      const treeRef = react.useRef(null)
      const pageCache = react.useRef(new Map())
      const pageRequests = react.useRef(new Map())
      const renderedPages = react.useRef([])
      const renderSequence = react.useRef(0)
      const [wiki, setWiki] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [errorText, setErrorText] = useState('')
      const [selected, setSelected] = useState(null)
      const [page, setPage] = useState(null)
      const [pageLoading, setPageLoading] = useState(false)
      const [pageError, setPageError] = useState('')
      const [statusLine, setStatusLine] = useState(null)
      const [checkingStatus, setCheckingStatus] = useState(false)
      const [query, setQuery] = useState('')
      const [expandAll, setExpandAll] = useState(null)
      const [navOpen, setNavOpen] = useState(false)
      const pages = useMemo(() => collectPages(wiki?.tree ?? []), [wiki?.tree])
      const tree = useMemo(() => filterTree(wiki?.tree ?? [], query), [wiki?.tree, query])
      const split = useMemo(() => page !== null ? preparePage(page.markdown, page.title) : { cite: [], body: '', toc: [] }, [page])
      const copyLabel = t('copyCode'), copiedLabel = t('copiedCode'), codeLabel = t('codeLabel')
      const wrapLabel = t('wrapCode'), unwrapLabel = t('unwrapCode'), footnotes = t('footnotes')
      const markdownLabels = useMemo(() => ({
        code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes,
      }), [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes])
      // 按页数和正文总量限制已渲染 DOM；连续阅读后返回仍可复用 Markdown 与图表。
      const markdownViews = useMemo(() => {
        if (!page) { renderedPages.current = []; return [] }
        const path = `${workspaceQuery}:${page.path ?? page.title}`
        const cached = renderedPages.current.find((entry) => entry.path === path)
        const current = cached?.body === split.body && cached.labels === markdownLabels ? cached : {
          path, body: split.body, labels: markdownLabels, order: ++renderSequence.current, key: `${path}:${renderSequence.current}`,
          container: canCacheOffline ? document.createElement('div') : null,
          hasDiagrams: /^[\t ]*(?:>[\t ]*)*(?:(?:[-+*]|\d+[.)])[\t ]+)?(?:`{3,}|~{3,})[\t ]*mermaid\b/im.test(split.body),
          element: MarkdownText !== null
            ? h(MarkdownText, { text: split.body, variant: 'body', labels: markdownLabels })
            : h(PlainMarkdown, { text: split.body }),
        }
        const recent = [current, ...renderedPages.current.filter((entry) => entry.path !== path)]
        const retained = []
        let units = 0
        for (const entry of recent) {
          if (retained.length > 0 && (retained.length >= (canCacheOffline ? 12 : 3) || units + entry.body.length > 512 * 1024)) break
          retained.push(entry)
          units += entry.body.length
        }
        renderedPages.current = retained
        // LRU 顺序只用于淘汰，已挂载节点保持位置，避免移动整篇文档触发增强器扫描。
        return [...renderedPages.current].sort((a, b) => a.order - b.order)
      }, [page, split.body, markdownLabels, workspaceQuery])

      useLayoutEffect(() => {
        if (!canCacheOffline) return
        markdownRef.current = null
        if (!documentHostRef.current) return
        const host = documentHostRef.current
        const activePath = page ? `${workspaceQuery}:${page.path ?? page.title}` : null
        const retained = new Set(markdownViews.map((view) => view.container))
        for (const child of [...host.children]) if (!retained.has(child)) child.remove()
        for (const view of markdownViews) {
          const active = view.path === activePath
          const container = view.container
          container.className = active ? 'rw-markdown' : 'rw-markdownCache'
          container.hidden = !active
          const graphs = [...container.querySelectorAll('.dsh-mmd')]
          const complete = graphs.length > 0 ? graphs.every((graph) => graph.dataset.state === 'ok') : !view.hasDiagrams
          // 未完成图表的离页正文移出文档，让增强器取消后台任务；React portal 保留正文状态。
          // 已完成图表继续隐藏保留，避免增强器断连清理后重新生成 SVG。
          if (active || complete) {
            if (container.parentNode !== host) host.appendChild(container)
          } else container.remove()
          if (active) markdownRef.current = container
        }
      }, [markdownViews, page, workspaceQuery])

      const pageKey = useCallback((pagePath) => `${workspaceQuery}&path=${encodeURIComponent(pagePath)}`, [workspaceQuery])
      const loadPage = useCallback((pagePath, revalidate = false) => {
        const key = pageKey(pagePath)
        const pending = pageRequests.current.get(key)
        if (pending && !revalidate) return pending.promise
        // 点击时重新读取正文，不让较早的预读响应替代本次重验。
        if (pending) pending.controller?.abort()
        const workspaceRequest = generation.current
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const promise = fetchJson(`${API_BASE}/page?${key}`, controller?.signal).then((data) => {
          if (data?.state !== 'ok' || workspaceRequest !== generation.current
            || pageRequests.current.get(key)?.promise !== promise) return data
          const previous = pageCache.current.get(key)
          const stable = previous?.markdown === data.markdown && previous.title === data.title
            && previous.updatedAt === data.updatedAt && previous.size === data.size ? previous : data
          pageCache.current.delete(key)
          pageCache.current.set(key, stable)
          // LRU 同时限制页数与正文总量，避免长时间浏览持续积累内存。
          let units = 0
          for (const entry of pageCache.current.values()) units += entry.markdown?.length ?? 0
          while (pageCache.current.size > 12 || units > 2 * 1024 * 1024) {
            const oldest = pageCache.current.keys().next().value
            units -= pageCache.current.get(oldest)?.markdown?.length ?? 0
            pageCache.current.delete(oldest)
          }
          return stable
        }).finally(() => {
          if (pageRequests.current.get(key)?.promise === promise) pageRequests.current.delete(key)
        })
        pageRequests.current.set(key, { promise, controller })
        return promise
      }, [pageKey])
      const openPage = useCallback(async (pagePath) => {
        const workspaceRequest = generation.current
        const request = ++pageGeneration.current
        const key = pageKey(pagePath)
        const cached = pageCache.current.get(key)
        if (cached) {
          pageCache.current.delete(key)
          pageCache.current.set(key, cached)
          setPage(cached)
        }
        setSelected(pagePath)
        setPageLoading(!cached)
        setPageError('')
        setNavOpen(false)
        try {
          // 缓存页立即展示，同时重验正文；磁盘修改不会被浏览器缓存长期遮蔽。
          const data = await loadPage(pagePath, true)
          if (workspaceRequest !== generation.current || request !== pageGeneration.current) return
          if (data?.state === 'ok') setPage(data)
          else { if (!cached) setPage(null); setPageError(data?.state ?? 'error') }
        } catch (error) {
          if (workspaceRequest !== generation.current || request !== pageGeneration.current) return
          if (!cached) setPage(null)
          setPageError(String(error?.message ?? error))
        } finally {
          if (workspaceRequest === generation.current && request === pageGeneration.current) setPageLoading(false)
        }
      }, [loadPage, pageKey])

      const refresh = useCallback(async (force = false) => {
        const request = ++generation.current
        pageGeneration.current++
        for (const pending of pageRequests.current.values()) pending.controller?.abort()
        pageRequests.current.clear()
        pageCache.current.clear()
        setPhase('loading')
        setPage(null)
        setSelected(null)
        setPageError('')
        setPageLoading(false)
        setStatusLine(null)
        setCheckingStatus(false)
        setQuery('')
        setExpandAll(null)
        setNavOpen(false)
        try {
          const data = await fetchJson(`${API_BASE}/wiki?${workspaceQuery}&includeFirstPage=1${force ? '&refresh=1' : ''}`)
          if (request !== generation.current) return
          if (data?.state === 'ok') {
            setWiki(data)
            setPhase('ok')
            // 首篇在目录响应中可用时，同一提交展示正文，省去串行 /page 请求。
            const firstPage = collectPages(data.tree ?? [])[0]
            const initialPage = data.initialPage
            if (firstPage && initialPage?.state === 'ok' && initialPage.path === firstPage.path && typeof initialPage.markdown === 'string') {
              pageCache.current.set(pageKey(firstPage.path), initialPage)
              setSelected(firstPage.path)
              setPage(initialPage)
            } else if (firstPage) void openPage(firstPage.path)
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
      }, [workspaceQuery, openPage, pageKey])

      useEffect(() => {
        void refresh()
        return () => {
          generation.current++; pageGeneration.current++
          for (const pending of pageRequests.current.values()) pending.controller?.abort()
          pageRequests.current.clear()
          pageCache.current.clear()
        }
      }, [refresh])

      useEffect(() => {
        if (phase === 'ok' && selected === null && pages.length > 0) void openPage(pages[0].path)
      }, [phase, selected, pages, openPage])
      useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0 }, [workspaceQuery, page?.path ?? page?.title])
      useEffect(() => {
        if (phase !== 'ok' || !page || !selected || pageLoading) return
        const index = pages.findIndex((entry) => entry.path === selected)
        const adjacent = [pages[index + 1], pages[index - 1]].filter(Boolean)
        const preload = () => {
          for (const entry of adjacent) if (!pageCache.current.has(pageKey(entry.path))) void loadPage(entry.path).catch(() => {})
        }
        // 等空闲再预读相邻正文，不与当前页的绘制和图表布局争抢首帧。
        if (typeof requestIdleCallback === 'function') {
          const task = requestIdleCallback(preload, { timeout: 1500 })
          return () => cancelIdleCallback(task)
        }
        const task = setTimeout(preload, 120)
        return () => clearTimeout(task)
      }, [phase, page, selected, pageLoading, pages, pageKey, loadPage])

      // 抽屉在当前插件内管理键盘焦点，关闭时回到目录按钮。
      useEffect(() => {
        if (!navOpen) return
        treeRef.current?.querySelector('.rw-search input')?.focus()
        return () => menuRef.current?.focus()
      }, [navOpen])
      useEffect(() => {
        if (!rootRef.current || typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(([entry]) => {
          if (entry.contentRect.width > 760) setNavOpen(false)
        })
        observer.observe(rootRef.current)
        return () => observer.disconnect()
      }, [phase])

      const checkStatus = useCallback(async () => {
        const request = generation.current
        setCheckingStatus(true)
        try {
          const data = await fetchJson(`${API_BASE}/status?${workspaceQuery}`)
          if (request !== generation.current) return
          if (data?.state === 'ok') {
            const stale = new Set((data.pages ?? []).filter((item) => item.stale).map((item) => item.path))
            setWiki((prev) => prev === null ? prev : { ...prev, staleSet: stale })
            setStatusLine({ ok: stale.size === 0, text: stale.size === 0 ? t('statusOk') : `${stale.size} ${t('stale')}` })
          } else {
            setStatusLine({ ok: false, text: data?.state === 'no-index' ? t('noBaseline') : data?.reason ?? data?.state ?? 'error' })
          }
        } catch (error) {
          if (request === generation.current) setStatusLine({ ok: false, text: String(error?.message ?? error) })
        } finally {
          if (request === generation.current) setCheckingStatus(false)
        }
      }, [t, workspaceQuery])

      // 宿主 MarkdownText 不生成标题 id，页内目录由插件绑定到当前正文。
      useEffect(() => {
        if (!markdownRef.current) return
        const headings = [...markdownRef.current.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        const used = new Map()
        for (const element of headings) {
          const base = headingSlug(element.textContent) || 'section'
          const count = used.get(base) ?? 0
          used.set(base, count + 1)
          element.id = count === 0 ? base : `${base}-${count}`
        }
        for (const entry of split.toc) {
          const target = headings.find((element) => element.id === entry.id)
            ?? headings.find((element) => headingSlug(element.textContent) === headingSlug(entry.title))
          if (target) target.id = entry.id
        }
      }, [split])

      // 限定在当前阅读容器内查找锚点，避免跳到宿主应用的同名元素。
      const onMarkdownClick = useCallback((event) => {
        const link = event.target.closest?.('a[href]')
        const href = link?.getAttribute('href') ?? ''
        if (!href.startsWith('#') || !markdownRef.current) return
        let anchor
        try { anchor = decodeURIComponent(href.slice(1)) } catch { return }
        const target = [...markdownRef.current.querySelectorAll('[id],a[name]')]
          .find((element) => element.id === anchor || element.getAttribute('name') === anchor)
        event.preventDefault()
        event.stopPropagation()
        if (target) target.scrollIntoView({ block: 'start' })
      }, [])

      const workspaceSelector = items.length > 1 ? h('label', { className: 'rw-workspace' },
        h('span', null, t('workspace')),
        h('select', {
          value: workspaceId ?? '', 'aria-label': t('workspace'),
          onChange: (event) => {
            const nextWorkspace = event.target.value
            if (nextWorkspace === workspaceId) return
            generation.current++
            pageGeneration.current++
            setChosenWorkspace(nextWorkspace)
          },
        }, items.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.path ?? item.workspaceId)))) : null

      if (phase !== 'ok') {
        const noWorkspace = phase === 'no-workspace'
        const title = phase === 'loading' ? 'loading' : phase === 'error' ? 'errorTitle' : noWorkspace ? 'noWorkspaceTitle' : 'noWikiTitle'
        return h('div', { className: 'rw-root' }, h('div', { className: 'rw-center' },
          workspaceSelector,
          h(Icon, { name: 'book' }),
          h('div', { className: 'rw-centerTitle', role: phase === 'loading' ? 'status' : undefined }, t(title)),
          phase === 'error' ? h('div', { className: 'rw-error' }, errorText) : null,
          phase === 'nowiki' || noWorkspace ? h('div', { className: 'rw-centerBody' }, t(noWorkspace ? 'noWorkspaceBody' : 'noWikiBody')) : null,
          phase !== 'loading' ? h('button', { type: 'button', className: 'rw-btn', onClick: () => { void refresh(true) } }, t('refresh')) : null))
      }

      const staleSet = wiki.staleSet instanceof Set ? wiki.staleSet : null
      const currentIndex = pages.findIndex((item) => item.path === selected)
      const previous = currentIndex > 0 ? pages[currentIndex - 1] : null
      const next = currentIndex >= 0 ? pages[currentIndex + 1] : null
      const crumbs = [wiki.workspace, ...(selected ?? '').split('/')].filter((value, index, all) => value && value !== all[index - 1])
      const iconButton = (icon, label, onClick, extra = {}) => h('button', {
        type: 'button', className: 'rw-iconBtn', title: t(label), 'aria-label': t(label), onClick, ...extra,
      }, h(Icon, { name: icon }))
      const pageLink = (target, isNext) => target ? h('button', {
        type: 'button', className: 'rw-pageLink', 'data-next': isNext, onClick: () => { void openPage(target.path) },
      }, !isNext ? h(Icon, { name: 'arrowLeft' }) : null,
      h('span', null, h('small', null, t(isNext ? 'nextPage' : 'previousPage')), target.title),
      isNext ? h(Icon, { name: 'arrowRight' }) : null) : null

      return h('div', {
        className: 'rw-root', ref: rootRef, 'data-nav-open': navOpen,
        onKeyDown: (event) => {
          if (!navOpen) return
          if (event.key === 'Escape') {
            event.preventDefault()
            setNavOpen(false)
          } else if (event.key === 'Tab' && treeRef.current) {
            const controls = [...treeRef.current.querySelectorAll('button,input,select,[tabindex]')]
              .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length > 0)
            const first = controls[0]
            const last = controls[controls.length - 1]
            const focused = event.currentTarget.ownerDocument.activeElement
            if (event.shiftKey && focused === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && focused === last) { event.preventDefault(); first?.focus() }
          }
        },
      },
        h('button', { type: 'button', className: 'rw-navScrim', 'aria-label': t('closeCatalog'), onClick: () => setNavOpen(false), tabIndex: -1 }),
        h('aside', { className: 'rw-tree', ref: treeRef, role: navOpen ? 'dialog' : undefined, 'aria-modal': navOpen || undefined, 'aria-label': t('catalog') },
          h('div', { className: 'rw-treeHeader' },
            h('div', { className: 'rw-treeSection' },
              h('div', { className: 'rw-brand' }, h(Icon, { name: 'book' }), t('panel')),
              h('div', { style: { display: 'flex', gap: '2px' } },
                iconButton('close', 'closeCatalog', () => setNavOpen(false), { className: 'rw-iconBtn rw-menuBtn' }),
                iconButton('refresh', 'refresh', () => { void refresh(true) }))),
            workspaceSelector,
            h('div', { className: 'rw-search' }, h(Icon, { name: 'search' }),
              h('input', { type: 'search', value: query, placeholder: t('searchPages'), 'aria-label': t('searchPages'), onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === 'Escape') setQuery('') } }),
              query ? iconButton('close', 'clearSearch', () => setQuery('')) : null),
            h('span', { className: 'rw-treeStats', title: wiki.workspace }, `${wiki.pageCount ?? 0} ${t('pagesCount')} · ${wiki.workspace ?? ''}`)),
          h('div', { className: 'rw-catalogHeading' }, h('span', null, t('catalog')),
            iconButton(expandAll ? 'collapse' : 'expand', expandAll ? 'collapseAll' : 'expandAll', () => setExpandAll((value) => value !== true))),
          h('nav', { className: 'rw-treeScroll', 'aria-label': t('catalog') },
            tree.length ? h('ul', { className: 'rw-treeList' }, tree.map((node) => h(TreeNode, {
              key: `${workspaceId ?? ''}:${node.page?.path ?? node.path ?? node.name}`, node, depth: 0, selected, onSelect: openPage, staleSet, query, expandAll, t,
            }))) : h('div', { className: 'rw-emptySearch', role: 'status' }, h('strong', null, t('noResults')), t('trySearch'))),
          wiki.incrementalBaseline === false ? h('div', { className: 'rw-treeFooter', title: t('noBaseline') }, h(Icon, { name: 'info' }), t('baselineHint')) : null),
        h('section', { className: 'rw-reader', 'aria-label': page?.title ?? t('panel') },
          h('div', { className: 'rw-topbar' },
            iconButton('menu', 'openCatalog', () => setNavOpen((value) => !value), { className: 'rw-iconBtn rw-menuBtn', 'aria-expanded': navOpen, ref: menuRef }),
            h('nav', { className: 'rw-breadcrumb', 'aria-label': t('panel'), title: crumbs.join(' / ') },
              crumbs.length ? crumbs.map((crumb, index) => h(Fragment, { key: `${crumb}:${index}` }, index > 0 ? h(Icon, { name: 'chevron' }) : null, h('span', { 'aria-current': index === crumbs.length - 1 ? 'page' : undefined }, crumb))) : h('span', null, t('panel'))),
            h('button', { type: 'button', className: 'rw-btn', disabled: checkingStatus, onClick: () => { void checkStatus() } }, h(Icon, { name: 'refresh' }), t(checkingStatus ? 'loading' : 'refreshStatus'))),
          h('div', { className: 'rw-content', ref: contentRef, tabIndex: 0, 'aria-busy': pageLoading },
            page === null ? h('div', { className: 'rw-center' },
              h(Icon, { name: pageError ? 'info' : 'book' }),
              h('div', { className: 'rw-centerBody', role: 'status' }, pageLoading ? t('loading') : pageError || t('selectPage')),
              pageError && selected ? h('button', { type: 'button', className: 'rw-btn', onClick: () => { void openPage(selected) } }, t('retry')) : null)
              : h('article', { className: 'rw-article' },
                h('header', { className: 'rw-header' }, h('h1', { className: 'rw-title' }, page.title),
                  h('div', { className: 'rw-meta' },
                    page.updatedAt != null ? h('span', { className: 'rw-metaItem' }, h(Icon, { name: 'clock' }), `${t('updatedAt')} ${page.updatedAt}`) : null,
                    page.size != null ? h('span', null, `${(page.size / 1024).toFixed(1)} KiB`) : null,
                    staleSet?.has(selected) ? h('span', { className: 'rw-badge', 'data-stale': true }, t('stale')) : null)),
                pageError ? h('div', { className: 'rw-statusLine', role: 'alert' }, h(Icon, { name: 'info' }), pageError) : null,
                statusLine !== null ? h('div', { className: 'rw-statusLine', role: 'status' }, h(Icon, { name: 'info' }), statusLine.text) : null,
                h(CiteBlock, { key: selected, files: split.cite, t }),
                h(PageContents, { entries: split.toc, onNavigate: onMarkdownClick, t }),
                canCacheOffline ? h('div', { className: 'rw-documentHost', ref: documentHostRef, 'data-cache-count': markdownViews.length, onClickCapture: onMarkdownClick },
                  markdownViews.map((view) => createPortal(view.element, view.container, view.key))) : markdownViews.map((view) => {
                  const active = view.path === `${workspaceQuery}:${page.path ?? page.title}`
                  return h('div', {
                    key: view.key, className: active ? 'rw-markdown' : 'rw-markdownCache', hidden: !active,
                    ref: active ? markdownRef : undefined, onClickCapture: active ? onMarkdownClick : undefined,
                  }, view.element)
                }),
                previous || next ? h('nav', { className: 'rw-pagination', 'aria-label': t('catalog') }, pageLink(previous, false), pageLink(next, true)) : null))))
    }

    // -------------------------------------------------------------------------
    // registration
    // -------------------------------------------------------------------------

    /** 订阅宿主服务的数据源；服务不可用时使用稳定的空快照。 */
    function useFeed(feed, select = identitySnapshot) {
      const subscribe = useCallback((notify) => feed?.subscribe?.(notify) ?? (() => {}), [feed])
      const getSnapshot = useCallback(() => select(feed?.getSnapshot?.() ?? emptySnapshot), [feed, select])
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
        // 会话流式输出只订阅最终工作区 id；同一工作区的新消息不重绘 Wiki。
        const inferredWorkspaceId = useFeed(ctx.sessions.list, useCallback(
          (state) => props.useWorkspaces != null ? state : resolveWorkspaceId(workspaces, state, props.sessionId),
          [workspaces, props.sessionId, props.useWorkspaces]))
        return h(RepowikiPage, {
          ...props,
          inferredWorkspaceId: props.useWorkspaces == null && props.useSessions == null ? inferredWorkspaceId : undefined,
          useWorkspaces: props.useWorkspaces ?? ((select) => select(workspaces)),
          useSessions: props.useSessions ?? ((select) => select(props.useWorkspaces != null ? inferredWorkspaceId : emptySnapshot)),
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
