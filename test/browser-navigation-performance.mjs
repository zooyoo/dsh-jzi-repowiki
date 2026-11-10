// 连续多页导航性能：真实宿主 React/MarkdownText/Mermaid，复用 browser-ui 的只读服务与 owned tab 清理。
// 默认 3 轮、10 个不同真实页面再逆序返回；先跑最小复现可设 ROUNDS=1、PAGES=6。
// REPOWIKI_NAV_LABEL / ROUNDS / PAGES / THINK_MS / BUDGET_MS；所有单位 ms。
// REPOWIKI_CLIENT / BACKEND 可指定冻结双源码；默认使用当前源码。
import path from 'node:path'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url))), env = process.env
const rounds = Number(env.REPOWIKI_NAV_ROUNDS || 3), count = Number(env.REPOWIKI_NAV_PAGES || 10)
const thinkMs = Number(env.REPOWIKI_NAV_THINK_MS || 60), budgetMs = Number(env.REPOWIKI_NAV_BUDGET_MS || 1)
const warmOnly = env.REPOWIKI_NAV_WARM_ONLY === '1', plainDiagnostic = env.REPOWIKI_NAV_PLAIN === '1'
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5 && Number.isInteger(count) && count >= (warmOnly ? 2 : 4) && count <= 12)
env.REPOWIKI_WORKSPACE ||= 'E:/ymt/ymtapp'
if (env.REPOWIKI_NAV_PLAIN === '1') delete env.REPOWIKI_MERMAID_CLIENT
else env.REPOWIKI_MERMAID_CLIENT ||= 'C:/Users/zoyo/.dsh/profiles/desktop/node_modules/dsh-mermaid/lib/client.js'
env.REPOWIKI_UI_ARTIFACTS ||= path.join(repo, '.research/artifacts/browser-ui/navigation', env.REPOWIKI_NAV_LABEL || 'candidate')
const { runBrowserUi } = await import('./browser-ui.mjs')
const quantiles = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y)
  const at = q => a.length ? Math.round(a[Math.max(0, Math.ceil(a.length * q) - 1)] * 100) / 100 : null
  return { count: a.length, p50: at(.5), p95: at(.95), max: at(1) }
}
function sourceMarkers(markdown) {
  const prose = [], headings = [], clean = markdown.replace(/<cite>[\s\S]*?<\/cite>/gi, '')
  let fenced = false, codeBlocks = 0
  for (const line of clean.split(/\r?\n/).map(s => s.trim())) {
    if (/^```/.test(line)) { fenced = !fenced; if (fenced) codeBlocks++; continue }
    if (fenced) continue
    if (/^#{1,6}\s/.test(line)) headings.push(line)
    if (line.length > 35 && !/^(?:[#>|`*\-]|\d+\.|<|\[)/.test(line)) prose.push(line)
  }
  assert.ok(prose.length, '页面缺少可核对的正文片段')
  const plain = s => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s/g, '')
  return { sentinel: plain(prose[0]).slice(0, 20), tailSentinel: plain(prose.at(-1)).slice(-24), expectedCodeBlocks: codeBlocks, expectedHeadings: Math.max(0, headings.length - 2) }
}
const initialPath = env.REPOWIKI_NAV_INITIAL_PATH || '项目概述与快速开始/项目概述与快速开始'
const initialMarkdown = await readFile(path.join(env.REPOWIKI_WORKSPACE, '.qoder/repowiki/zh/content', `${initialPath}.md`), 'utf8')
const initialSpec = { title: path.posix.basename(initialPath), ...sourceMarkers(initialMarkdown) }
function installNavigationProbe(initialSpec) {
  const P = window.__rwNavigation = { rows: [], requests: [], longTasks: [], eventTimings: [], renders: [], diagramTimeline: [], hostCapabilities: {}, mount: null, current: null, prepared: null, initial: { title: initialSpec.title, treeAt: null, domAt: null, paintAt: null, fullDomAt: null, fullPaintAt: null } }
  const nativeFetch = window.fetch
  window.fetch = async (...args) => {
    const u = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href)
    if (!u.pathname.includes('/plugins/dsh-plugin-repowiki/api/')) return nativeFetch(...args)
    const row = { path: u.pathname, pagePath: u.searchParams.get('path'), start: performance.now(), actionId: P.current?.id ?? null }
    P.requests.push(row)
    try {
      const response = await nativeFetch(...args); row.headersAt = performance.now(); row.status = response.status
      for (const method of ['text', 'json']) {
        const original = response[method].bind(response)
        response[method] = async () => { const body = await original(); row.bodyAt = performance.now(); row.durationMs = row.bodyAt - row.start; return body }
      }
      return response
    } catch (error) { row.failedAt = performance.now(); row.error = error.name; throw error }
  }
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) P.longTasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) if (['click', 'pointerdown', 'pointerup'].includes(e.name)) P.eventTimings.push({ name: e.name, start: e.startTime, durationMs: e.duration, processingMs: e.processingEnd - e.processingStart, inputDelayMs: e.processingStart - e.startTime, interactionId: e.interactionId }) }).observe({ type: 'event', buffered: true, durationThreshold: 16 }) } catch {}
  const byEvent = new WeakMap(), originalAdd = EventTarget.prototype.addEventListener, originalRemove = EventTarget.prototype.removeEventListener, wrapped = new WeakMap()
  // 直接计量真实 React 根节点的 click delegate；含该委派内同步 React 工作，不冒称整个可见响应。
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'click' && this instanceof Element && this.id === 'root' && typeof listener === 'function') {
      let measured = wrapped.get(listener)
      if (!measured) {
        measured = function (event) { const start = performance.now(); try { return listener.call(this, event) } finally { const row = byEvent.get(event); if (row) row.delegateMs += performance.now() - start } }
        wrapped.set(listener, measured)
      }
      return originalAdd.call(this, type, measured, options)
    }
    return originalAdd.call(this, type, listener, options)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) { return originalRemove.call(this, type, wrapped.get(listener) || listener, options) }
  originalAdd.call(document, 'click', event => {
    const button = event.target instanceof Element ? event.target.closest('.rw-pageBtn') : null
    if (!button || !P.prepared) return
    const now = performance.now()
    if (P.current && P.current.leftAt === null) P.current.leftAt = now
    const row = { ...P.prepared, id: P.rows.length, start: now, delegateMs: 0, domAt: null, paintAt: null, fullDomAt: null, fullPaintAt: null, diagramAt: null, leftAt: null, svgAtLeave: null, rendersBefore: P.renders.length, mutations: { childListRecords: 0, attributeRecords: 0, attributes: {}, added: { markdown: 0, pre: 0, code: 0, svg: 0 }, removed: { markdown: 0, pre: 0, code: 0, svg: 0 } } }
    P.prepared = null; P.rows.push(row); P.current = row; byEvent.set(event, row)
  }, true)
  const normalize = text => text.replace(/\s/g, '')
  const sample = () => {
    const row = P.current, markdown = document.querySelector('.rw-markdown'), title = document.querySelector('.rw-title')?.textContent.trim()
    if (P.initial.treeAt === null && document.querySelector('.rw-pageBtn')) P.initial.treeAt = performance.now()
    if (!row && markdown && title === initialSpec.title && P.initial.fullPaintAt === null) {
      const text = normalize(markdown.textContent)
      if (P.initial.domAt === null && text.includes(initialSpec.sentinel)) { P.initial.domAt = performance.now(); requestAnimationFrame(() => { P.initial.paintAt ??= performance.now() }) }
      if (P.initial.fullDomAt === null && text.includes(initialSpec.sentinel) && text.includes(initialSpec.tailSentinel) && markdown.querySelectorAll('.md-code-block').length >= initialSpec.expectedCodeBlocks && markdown.querySelectorAll('h1,h2,h3,h4,h5,h6').length >= initialSpec.expectedHeadings) { P.initial.fullDomAt = performance.now(); requestAnimationFrame(() => { P.initial.fullPaintAt ??= performance.now() }) }
    }
    if (row && markdown && title === row.title) {
      const text = (row.domAt === null || row.fullDomAt === null) ? normalize(markdown.textContent) : null
      if (row.domAt === null && text.includes(row.sentinel)) {
        row.domAt = performance.now(); row.rendersAtDom = P.renders.length - row.rendersBefore
        requestAnimationFrame(() => { if (P.current === row) row.paintAt = performance.now() })
      }
      if (row.fullDomAt === null && row.domAt !== null && text.includes(row.tailSentinel)) {
        const codeBlocks = markdown.querySelectorAll('.md-code-block').length, headings = markdown.querySelectorAll('h1,h2,h3,h4,h5,h6').length
        if (codeBlocks >= row.expectedCodeBlocks && headings >= row.expectedHeadings) {
          row.fullDomAt = performance.now(); row.fullStructure = { codeBlocks, headings }
          requestAnimationFrame(() => { if (P.current === row) row.fullPaintAt = performance.now() })
        }
      }
      const blocks = [...markdown.querySelectorAll('.dsh-mmd')], svg = markdown.querySelectorAll('svg[aria-roledescription]').length
      row.svgAtLeave = svg
      if (row.fullDomAt !== null && row.diagramAt === null && (row.expectedDiagrams === 0 || (svg >= row.expectedDiagrams && blocks.length >= row.expectedDiagrams && blocks.every(el => el.dataset.state === 'ok')))) row.diagramAt = performance.now()
    }
  }
  const NativeObserver = window.MutationObserver
  new NativeObserver(entries => {
    const m = P.current?.mutations
    if (m) for (const e of entries) {
      const target = e.target.nodeType === 1 ? e.target : e.target.parentElement
      const related = target?.closest('.rw-article,.rw-markdown,.rw-markdownCache') || [...e.addedNodes, ...e.removedNodes].some(n => n.nodeType === 1 && n.matches('.rw-markdown,.rw-markdownCache'))
      if (!related) continue
      if (e.type === 'attributes') { m.attributeRecords++; m.attributes[e.attributeName] = (m.attributes[e.attributeName] || 0) + 1 }
      if (e.type === 'childList') {
        m.childListRecords++
        for (const [kind, nodes] of [['added', e.addedNodes], ['removed', e.removedNodes]]) for (const n of nodes) if (n.nodeType === 1) {
          for (const [key, selector] of [['markdown', '.rw-markdown,.rw-markdownCache'], ['pre', 'pre'], ['code', 'code'], ['svg', 'svg']]) {
            m[kind][key] += Number(n.matches(selector))
            // 整页移动时另计子树中的 pre/code/svg；这些是包含计数，不冒充额外 MutationRecord。
            if (n.matches('.rw-markdown,.rw-markdownCache')) m[kind][key] += n.querySelectorAll(selector).length
          }
        }
      }
    }
    if (P.current?.domAt === null) sample()
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true })
  let inventoryAt = -Infinity
  const frame = () => {
    sample()
    if (performance.now() - inventoryAt >= 150) {
      inventoryAt = performance.now()
      const containers = [...document.querySelectorAll('.rw-markdown,.rw-markdownCache')], active = containers.filter(el => el.matches('.rw-markdown')), hidden = containers.filter(el => !el.matches('.rw-markdown'))
      const count = (list, selector) => list.reduce((sum, el) => sum + el.querySelectorAll(selector).length, 0)
      P.diagramTimeline.push({ at: inventoryAt, actionId: P.current?.id ?? null, containers: containers.length, activeSvg: count(active, 'svg[aria-roledescription]'), hiddenSvg: count(hidden, 'svg[aria-roledescription]'), activeStates: active.flatMap(el => [...el.querySelectorAll('.dsh-mmd')].map(e => e.dataset.state || '')), hiddenStates: hidden.flatMap(el => [...el.querySelectorAll('.dsh-mmd')].map(e => e.dataset.state || '')) })
    }
    requestAnimationFrame(frame)
  }; requestAnimationFrame(frame)
  window.__rwProbeHost = modules => {
    P.hostCapabilities.reactDomCreatePortal = typeof modules['react-dom']?.createPortal === 'function'
    const React = modules.react, ui = modules['@deepseek-ai/dsh-client-ui-primitives'], original = ui.MarkdownText
    const render = typeof original === 'function' ? original : original.type
    function CountedMarkdown(props) { const start = performance.now(); try { return render(props) } finally { P.renders.push({ at: start, duration: performance.now() - start, actionId: P.current?.id ?? null }) } }
    modules['@deepseek-ai/dsh-client-ui-primitives'] = { ...ui, MarkdownText: typeof original === 'function' ? CountedMarkdown : React.memo(CountedMarkdown, original.compare) }
  }
  P.prepare = spec => { P.prepared = spec }
  P.read = () => ({ ...P, now: performance.now(), mountAt: window.__rwHarnessMountMs ?? null, prepared: undefined, current: P.current?.id ?? null, prepare: undefined, read: undefined, resources: performance.getEntriesByType('resource').map(e => ({ name: new URL(e.name, location.href).pathname, type: e.initiatorType, start: e.startTime, duration: e.duration, fetchStart: e.fetchStart, responseStart: e.responseStart, responseEnd: e.responseEnd, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })) })
}

await runBrowserUi({
  beforeNavigate: async ({ rpc }) => {
    await rpc('Page.addScriptToEvaluateOnNewDocument', { source: `(${installNavigationProbe.toString()})(${JSON.stringify(initialSpec)});` })
    await rpc('Network.setCacheDisabled', { cacheDisabled: true })
  },
  verify: async ({ evaluate, rpc, report, check, waitFor, pause, click }) => {
    const nav = report.navigationPerformance = { label: env.REPOWIKI_NAV_LABEL || 'candidate', cpuRate: 1, orchestrator: globalThis.Bun ? `Bun ${globalThis.Bun.version}` : `Node ${process.version}`, rounds, distinctPages: count, thinkMs, budgetMs, warmOnly, plainDiagnostic, units: 'milliseconds', method: 'document capture 的真实 click→精确目标标题及源正文片段 DOM→下一 RAF 的近似 paint；React root click delegate 同步时间另列；图表要求实际 dsh-mermaid state=ok。', notes: ['连续导航不等待每页图表完成；离页前未完成的图表标记 superseded，不记为 0ms。', '正文可能被客户端邻页预读；API 请求与渲染分别记录。1ms 目标不以 handler 时间或缺失 EventTiming 替代。', '只保存页面路径、字节和计时；不把真实源码正文片段写入报告。'], runs: [] }
    await waitFor("window.__rwReady&&document.querySelector('.rw-title')&&document.querySelector('.rw-pageBtn')", '宿主初始化未就绪', 30000)
    nav.documentHostPresent = await evaluate("!!document.querySelector('.rw-documentHost')")
    if (env.REPOWIKI_NAV_REQUIRE_PORTAL === '1') check('candidate renders through the portal document host', nav.documentHostPresent)
    const pages = await evaluate("fetch('/plugins/dsh-plugin-repowiki/api/wiki?workspaceId=a').then(r=>r.json()).then(w=>{const pages=[],visit=n=>{if(n.page?.path)pages.push({path:n.page.path,title:n.page.title||n.name});for(const c of n.children||[])visit(c)};for(const n of w.tree||[])visit(n);return pages})")
    const chosen = pages.slice(1, count + 1)
    assert.equal(chosen.length, count, '真实页面数量不足')
    assert.equal(new Set(chosen.map(p => p.title)).size, count, '所选真实页标题需唯一')
    for (const p of chosen) {
      const source = await readFile(path.join(env.REPOWIKI_WORKSPACE, '.qoder/repowiki/zh/content', `${p.path}.md`), 'utf8')
      Object.assign(p, sourceMarkers(source))
      p.sourceDiagrams = [...source.matchAll(/^\s*```mermaid\s*$/gm)].length; p.expectedDiagrams = plainDiagnostic ? 0 : p.sourceDiagrams; p.bytes = Buffer.byteLength(source)
    }
    nav.pages = chosen.map(({ sentinel, tailSentinel, ...p }) => p)
    check(warmOnly ? 'warm diagnostic uses exactly two distinct pages' : 'sequence exceeds the rendered 3-page cache', (warmOnly ? chosen.length === 2 : chosen.length > 3) && new Set(chosen.map(p => p.path)).size === count, { count })
    if (plainDiagnostic) nav.notes.push('诊断模式：Mermaid fence 仅显示为真实 MarkdownText 的代码块，未加载外置增强器，不能作为完整 UI 的图表性能。')
    await click('.rw-catalogHeading button')
    const rawClick = async p => {
      const point = await evaluate(`(()=>{const el=[...document.querySelectorAll('.rw-pageBtn')].find(el=>el.getClientRects().length&&(el.title===${JSON.stringify(p.title)}||el.textContent.trim()===${JSON.stringify(p.title)}));if(!el)return null;el.scrollIntoView({block:'nearest'});const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
      assert.ok(point, `目标按钮不可见：${p.title}`)
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    }
    for (let round = 1; round <= rounds; round++) {
      if (round > 1) {
        const origin = await evaluate('performance.timeOrigin')
        await rpc('Page.reload', { ignoreCache: true })
        await waitFor(`performance.timeOrigin!==${origin}&&window.__rwReady&&document.querySelector('.rw-title')`, '新一轮初始化未就绪', 30000)
        await click('.rw-catalogHeading button')
      }
      const sequence = warmOnly
        ? Array.from({ length: 16 }, (_, index) => ({ ...chosen[index % 2], stage: index < 2 ? 'prime' : 'warm' }))
        : [...chosen.map(p => ({ ...p, stage: 'forward' })), ...chosen.slice(0, -1).reverse().map(p => ({ ...p, stage: 'return' }))]
      for (const [step, p] of sequence.entries()) {
        if (warmOnly && step === 2 && !plainDiagnostic) {
          await waitFor("window.__rwNavigation.current?.diagramAt!==null", '两页暖缓存预热的图表未完成', 30000)
          await pause(200)
        }
        await evaluate(`window.__rwNavigation.prepare(${JSON.stringify(p)})`)
        await rawClick(p)
        await waitFor(`window.__rwNavigation.current?.title===${JSON.stringify(p.title)}&&window.__rwNavigation.current?.fullPaintAt!==null`, `目标正文没有出现：${p.title}`, 30000)
        if (step === 0) await evaluate("window.__rwNavFirstContainer=document.querySelector('.rw-markdown');void 0")
        await pause(thinkMs)
      }
      if (env.REPOWIKI_NAV_BURST !== '0') {
        const burst = chosen.filter((_, index) => index % 2 === 0).slice(0, 5)
        for (const p of burst) { await evaluate(`window.__rwNavigation.prepare(${JSON.stringify({ ...p, stage: 'burst' })})`); await rawClick(p); await pause(35) }
        const last = burst.at(-1)
        await waitFor(`window.__rwNavigation.current?.title===${JSON.stringify(last.title)}&&window.__rwNavigation.current?.fullPaintAt!==null`, '快速连续点击后的最终正文错误', 30000)
        await pause(200)
        check(`round ${round}: final rapid selection is correct`, await evaluate(`document.querySelector('.rw-title')?.textContent.trim()===${JSON.stringify(last.title)}&&document.querySelector('.rw-markdown')?.textContent.replace(/\\s/g,'').includes(${JSON.stringify(last.sentinel)})`))
      }
      let graphValidation = null
      if (!plainDiagnostic) {
        // 冷 runtime 加载期间离开再返回：检查 active 的真实 SVG 与文字尺寸，不能仅凭节点身份通过。
        const first = { ...chosen[0], stage: 'graph-return-validation' }
        await evaluate(`window.__rwNavigation.prepare(${JSON.stringify(first)})`)
        await rawClick(first)
        await waitFor(`window.__rwNavigation.current?.title===${JSON.stringify(first.title)}&&window.__rwNavigation.current?.fullPaintAt!==null`, '图表回访正文未就绪', 30000)
        let completed = true
        try { await waitFor('window.__rwNavigation.current?.diagramAt!==null', '图表回访尚未完成', 20000) } catch { completed = false }
        graphValidation = await evaluate(`(()=>{const container=document.querySelector('.rw-markdown'),svgs=[...container.querySelectorAll('svg[aria-roledescription]')],labels=[];for(const svg of svgs)for(const fo of svg.querySelectorAll('foreignObject')){const b=fo.getBoundingClientRect(),walker=document.createTreeWalker(fo,NodeFilter.SHOW_TEXT);let node,min=Infinity,max=-Infinity;while((node=walker.nextNode())){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const r of range.getClientRects()){min=Math.min(min,r.top);max=Math.max(max,r.bottom)}}labels.push({width:b.width,height:b.height,characters:fo.textContent.trim().length,clipped:Number.isFinite(min)&&(min<b.top-1||max>b.bottom+1)})}return{expected:${first.expectedDiagrams},actual:svgs.length,oldContainerConnected:!!window.__rwNavFirstContainer?.isConnected,sameContainer:window.__rwNavFirstContainer===container,svgBounds:svgs.map(svg=>{const b=svg.getBoundingClientRect();return{width:b.width,height:b.height}}),labels:labels.length,clipped:labels.filter(x=>x.clipped).length,zeroLabelBoxes:labels.filter(x=>x.characters>0&&(x.width<=0||x.height<=0)).length,cachedContainers:document.querySelectorAll('.rw-markdown,.rw-markdownCache').length}})()`)
        graphValidation.completed = completed
        check(`round ${round}: revisited cold diagrams have nonzero geometry`, completed && graphValidation.actual === first.expectedDiagrams && graphValidation.svgBounds.every(b => b.width > 0 && b.height > 0), graphValidation)
        check(`round ${round}: revisited diagram labels are not clipped`, completed && graphValidation.labels > 0 && graphValidation.clipped === 0 && graphValidation.zeroLabelBoxes === 0, graphValidation)
        if (completed && graphValidation.actual === first.expectedDiagrams) {
          await evaluate("window.__rwNavReadySvgs=[...document.querySelectorAll('.rw-markdown svg[aria-roledescription]')];void 0")
          const away = { ...chosen[1], stage: 'graph-ready-away-validation' }
          await evaluate(`window.__rwNavigation.prepare(${JSON.stringify(away)})`)
          await rawClick(away)
          await waitFor(`window.__rwNavigation.current?.title===${JSON.stringify(away.title)}&&window.__rwNavigation.current?.fullPaintAt!==null`, '完整图表离页验证正文未就绪', 30000)
          await evaluate(`window.__rwNavigation.prepare(${JSON.stringify({ ...first, stage: 'graph-ready-return-validation' })})`)
          await rawClick(first)
          await waitFor(`window.__rwNavigation.current?.title===${JSON.stringify(first.title)}&&window.__rwNavigation.current?.fullPaintAt!==null&&window.__rwNavigation.current?.diagramAt!==null`, '完整图表回访未就绪', 20000)
          graphValidation.readyRevisit = await evaluate("(()=>{const current=[...document.querySelectorAll('.rw-markdown svg[aria-roledescription]')],previous=window.__rwNavReadySvgs;return{count:current.length,sameSvg:current.length===previous.length&&current.every((el,index)=>el===previous[index]),markdownRenders:window.__rwNavigation.current.rendersAtDom}})()")
          check(`round ${round}: completed diagrams survive a later page return`, graphValidation.readyRevisit.sameSvg && graphValidation.readyRevisit.count === first.expectedDiagrams, graphValidation.readyRevisit)
        }
      }
      let finalDiagramWait = 'ready'
      if (!plainDiagnostic) {
        try { await waitFor('window.__rwNavigation.current?.diagramAt!==null', '最终页图表尚未完成', Number(env.REPOWIKI_NAV_SETTLE_MS || 12000)) }
        catch { finalDiagramWait = 'pending-at-timeout' }
      }
      await pause(250)
      const data = await evaluate('window.__rwNavigation.read()')
      // 正文哨兵只留在本次页面内存，任何文件均不包含片段。
      const performanceEnd = data.now
      const rows = data.rows.map(({ sentinel, tailSentinel, rendersBefore, ...r }) => ({ ...r, domMs: r.domAt === null ? null : r.domAt - r.start, paintMs: r.paintAt === null ? null : r.paintAt - r.start, fullDomMs: r.fullDomAt === null ? null : r.fullDomAt - r.start, fullPaintMs: r.fullPaintAt === null ? null : r.fullPaintAt - r.start, diagramMs: r.diagramAt === null ? null : r.diagramAt - r.start, diagramStatus: r.diagramAt !== null ? 'ready' : r.leftAt !== null ? 'superseded' : 'pending', longTasks: data.longTasks.filter(t => t.start >= r.start && t.start < (r.leftAt ?? performanceEnd)), api: data.requests.filter(q => q.actionId === r.id) }))
      nav.runs.push({ round, rows, finalDiagramWait, graphValidation, initial: { ...data.initial, mountAt: data.mountAt, mountToTreeMs: data.initial.treeAt - data.mountAt, mountToInitialFullPaintMs: data.initial.fullPaintAt === null ? null : data.initial.fullPaintAt - data.mountAt }, requests: data.requests, resources: data.resources, longTasks: data.longTasks, beforeMountLongTasks: data.longTasks.filter(t => t.start < data.mountAt), afterMountLongTasks: data.longTasks.filter(t => t.start >= data.mountAt), renderCount: data.renders.length, renders: data.renders, eventTimings: data.eventTimings, diagramTimeline: data.diagramTimeline, hostCapabilities: data.hostCapabilities })
      const regular = rows.filter(r => ['forward', 'return', 'prime', 'warm'].includes(r.stage)), summary = { paint: quantiles(regular.map(r => r.fullPaintMs)), dom: quantiles(regular.map(r => r.domMs)), delegate: quantiles(regular.map(r => r.delegateMs)), diagram: quantiles(regular.map(r => r.diagramMs)), longTaskCount: data.longTasks.length, over100ms: regular.filter(r => r.fullPaintMs > 100).length, over1ms: regular.filter(r => r.fullPaintMs > 1).length }
      nav.runs.at(-1).summary = summary
      console.log(`NAV-ROUND ${round}: ${JSON.stringify(summary)}`)
      check(`round ${round}: all sequential targets render the correct body`, regular.every(r => r.fullPaintMs !== null), { count: regular.length })
    }
    const regular = nav.runs.flatMap(run => run.rows).filter(r => ['forward', 'return', 'prime', 'warm'].includes(r.stage))
    nav.summary = { paint: quantiles(regular.map(r => r.fullPaintMs)), dom: quantiles(regular.map(r => r.domMs)), delegate: quantiles(regular.map(r => r.delegateMs)), api: quantiles(nav.runs.flatMap(run => run.requests).filter(r => r.path.endsWith('/page')).map(r => r.durationMs)), diagram: quantiles(regular.map(r => r.diagramMs)) }
    check('continuous multi-page visible navigation stays within 100ms', regular.every(r => r.fullPaintMs !== null && r.fullPaintMs <= 100), { summary: nav.summary.paint })
    check(`continuous multi-page visible navigation meets ${budgetMs}ms target`, regular.every(r => r.fullPaintMs !== null && r.fullPaintMs <= budgetMs), { summary: nav.summary.paint, note: '60Hz 下一 RAF 的近似 paint 单帧约16.7ms；handler/API更快不代表整体1ms。' })
    console.log(`NAV-SUMMARY: ${JSON.stringify(nav.summary)}`)
  },
})
