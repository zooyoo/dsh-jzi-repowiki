// 真实宿主性能/图表验证：只读 Wiki，复用 browser-ui 的独占 tab/server 清理。
// REPOWIKI_PERF_QUICK=1：只跑宽度与图表裁字；完整测量默认 8 轮交互。
// REPOWIKI_CLIENT 可指冻结客户端；REPOWIKI_PERF_LABEL 标识版本。
// REPOWIKI_PERF_CPU=4 只用于额外压力，报告明确记录，不能冒充实机。
// REPOWIKI_PERF_ALLOW_PLAIN=1：若尚未注入图表 provider，明确记录纯 Markdown。
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const env = process.env
const alternateExperiment = env.REPOWIKI_PERF_ALTERNATE === '1'
const compositeExperiment = env.REPOWIKI_PERF_COMPOSITE === '1' || alternateExperiment
const diagnostic = env.REPOWIKI_PERF_DIAGNOSTIC === '1' || compositeExperiment
const rounds = Number(env.REPOWIKI_PERF_ROUNDS || (diagnostic ? 3 : 8))
const quick = env.REPOWIKI_PERF_QUICK === '1'
const cpuRate = Number(env.REPOWIKI_PERF_CPU || 1)
env.REPOWIKI_WORKSPACE ||= 'E:/ymt/ymtapp'
env.REPOWIKI_PAGE_LABEL ||= '系统总览与技术栈'
if (env.REPOWIKI_PERF_ALLOW_PLAIN !== '1') {
  env.REPOWIKI_MERMAID_CLIENT ||= 'C:/Users/zoyo/.dsh/profiles/desktop/node_modules/dsh-mermaid/lib/client.js'
  env.REPOWIKI_PERF_REQUIRE_DIAGRAMS = '1'
}
env.REPOWIKI_UI_ARTIFACTS ||= path.join(repo, '.research/artifacts/browser-ui/performance', env.REPOWIKI_PERF_LABEL || 'candidate')
const pageLabel = env.REPOWIKI_PAGE_LABEL
const { runBrowserUi } = await import('./browser-ui.mjs')
const quantiles = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = q => sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] * 100) / 100 : null
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) }
}

function installProbe() {
  const P = window.__rwPerf = { start: performance.now(), markdownRenders: 0, renderMs: [], requests: [], longTasks: [], observerCallbacks: 0, observerMs: [], contentMutations: 0, svgMutations: 0, diagramTimeline: [], eventTimings: [], firstTreeMs: null, firstContentMs: null, events: [], active: null }
  const nativeFetch = window.fetch
  window.fetch = async (...args) => {
    const pathname = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname
    if (!pathname.includes('/plugins/dsh-plugin-repowiki/api/')) return nativeFetch(...args)
    const row = { path: pathname, query: new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).search, start: performance.now() }
    P.requests.push(row)
    const response = await nativeFetch(...args); row.headersAt = performance.now(); row.status = response.status
    const json = response.json.bind(response), text = response.text.bind(response)
    response.json = async () => { const value = await json(); row.parsedAt = performance.now(); row.durationMs = row.parsedAt - row.start; row.markdownBytes = typeof value.markdown === 'string' ? value.markdown.length : undefined; return value }
    response.text = async () => { const value = await text(); row.parsedAt = performance.now(); row.durationMs = row.parsedAt - row.start; row.responseBytes = value.length; return value }
    return response
  }
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) P.longTasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
  // 浏览器 Event Timing 仅报告达到最小 16ms 门槛的 entry，不能用缺失样本声称同步处理达标。
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) P.eventTimings.push({ name: e.name, start: e.startTime, durationMs: e.duration, processingMs: e.processingEnd - e.processingStart, inputDelayMs: e.processingStart - e.startTime, interactionId: e.interactionId }) }).observe({ type: 'event', buffered: true, durationThreshold: 16 }) } catch {}
  const NativeObserver = window.MutationObserver
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super((entries, observer) => { const start = performance.now(); P.observerCallbacks++; try { callback(entries, observer) } finally { P.observerMs.push(performance.now() - start) } }) }
  }
  new NativeObserver(entries => {
    let changedSvg = false
    for (const row of entries) {
      const el = row.target.nodeType === 1 ? row.target : row.target.parentElement
      if (el?.closest('.rw-markdown') || [...row.addedNodes, ...row.removedNodes].some(n => n.nodeType === 1 && (n.matches('.rw-markdown') || n.querySelector('.rw-markdown')))) P.contentMutations++
      if (el?.closest('svg') || [...row.addedNodes, ...row.removedNodes].some(n => n.nodeType === 1 && (n.matches('svg') || n.querySelector('svg')))) { P.svgMutations++; changedSvg = true }
    }
    if (changedSvg) {
      const count = document.querySelectorAll('.rw-markdown svg[aria-roledescription]').length
      const title = document.querySelector('.rw-title')?.textContent.trim() || ''
      const previous = P.diagramTimeline.at(-1)
      if (count && (!previous || previous.count !== count || previous.title !== title)) P.diagramTimeline.push({ at: performance.now(), title, count })
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })
  const first = () => {
    if (P.firstTreeMs === null && document.querySelector('.rw-pageBtn')) P.firstTreeMs = performance.now()
    if (P.firstContentMs === null && (document.querySelector('.rw-markdown')?.textContent.trim().length || 0) > 20) {
      requestAnimationFrame(() => { P.firstContentMs = performance.now() })
    }
    if (P.firstContentMs === null) requestAnimationFrame(first)
  }
  requestAnimationFrame(first)
  window.__rwProbeHost = modules => {
    const React = modules.react, ui = modules['@deepseek-ai/dsh-client-ui-primitives'], original = ui.MarkdownText
    const render = typeof original === 'function' ? original : original.type
    if (typeof render !== 'function') { P.wrapperError = 'MarkdownText render function unavailable'; return }
    function CountedMarkdown(props) { const start = performance.now(); P.markdownRenders++; try { return render(props) } finally { P.renderMs.push(performance.now() - start) } }
    const wrapped = typeof original === 'function' ? CountedMarkdown : React.memo(CountedMarkdown, original.compare)
    modules['@deepseek-ai/dsh-client-ui-primitives'] = { ...ui, MarkdownText: wrapped }
    P.wrapperInstalled = modules['@deepseek-ai/dsh-client-ui-primitives'].MarkdownText === wrapped
  }
  P.arm = (label, eventType, condition) => {
    if (P.active) throw new Error('Previous performance action is still active')
    const active = P.active = { label, eventType, start: null, beforeRenders: P.markdownRenders, beforeTasks: P.longTasks.length, beforeRequests: P.requests.length, beforeObservers: P.observerCallbacks, beforeMutations: P.contentMutations }
    const test = new Function(`return (${condition})`)
    const finish = error => {
      if (P.active !== active) return
      const end = performance.now()
      P.events.push({ label, start: active.start, end, durationMs: active.start === null ? null : end - active.start, error, markdownRenders: P.markdownRenders - active.beforeRenders, longTasks: P.longTasks.slice(active.beforeTasks), apiRequests: P.requests.slice(active.beforeRequests), observerCallbacks: P.observerCallbacks - active.beforeObservers, contentMutations: P.contentMutations - active.beforeMutations })
      P.active = null; clearTimeout(timer)
    }
    const frame = () => { if (P.active !== active) return; if (test()) requestAnimationFrame(() => finish(null)); else requestAnimationFrame(frame) }
    const begin = () => { active.start = performance.now(); requestAnimationFrame(frame) }
    const timer = setTimeout(() => finish('Action did not reach its visible state in 15000ms'), 15000)
    document.addEventListener(eventType, begin, { capture: true, once: true })
  }
  P.read = () => ({ ...P, harnessMountMs: window.__rwHarnessMountMs ?? null, arm: undefined, read: undefined, active: P.active ? { label: P.active.label } : null })
}

await runBrowserUi({
  beforeNavigate: async ({ rpc }) => {
    await rpc('Page.addScriptToEvaluateOnNewDocument', { source: `(${installProbe.toString()})();` })
    if (cpuRate !== 1) await rpc('Emulation.setCPUThrottlingRate', { rate: cpuRate })
    await rpc('Network.setCacheDisabled', { cacheDisabled: true })
  },
  verify: async ctx => {
    const { evaluate, rpc, report, check, capture, waitFor, pause, artifactDir } = ctx
    const perf = report.performance = { label: env.REPOWIKI_PERF_LABEL || 'candidate', orchestrator: globalThis.Bun ? `Bun ${Bun.version}` : `Node ${process.version}`, cpuRate, units: 'milliseconds', rounds, method: '真实 CDP 输入事件→可见 DOM 条件→下一 RAF，近似已 paint；不等同仅 fetch 响应。冷启动含导航/宿主模块，切页为应用缓存语义。', samples: {}, summary: {}, notes: [] }
    if (compositeExperiment) {
      // 只连现有浏览器的只读 SystemInfo，结束时只关本连接，绝不关闭浏览器。
      let browserSocket
      try {
        const version = await (await fetch(`${env.REPOWIKI_CDP_URL || 'http://127.0.0.1:9222'}/json/version`)).json()
        browserSocket = new WebSocket(version.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { browserSocket.onopen = resolve; browserSocket.onerror = reject })
        let id = 0
        const browserCall = (method) => new Promise((resolve, reject) => {
          const requestId = ++id, timer = setTimeout(() => reject(new Error(`${method} timeout`)), 5000)
          browserSocket.onmessage = event => { const data = JSON.parse(event.data); if (data.id !== requestId) return; clearTimeout(timer); data.error ? reject(new Error(data.error.message)) : resolve(data.result) }
          browserSocket.send(JSON.stringify({ id: requestId, method }))
        })
        const info = await browserCall('SystemInfo.getInfo'), gpu = info.gpu || {}
        perf.gpu = { devices: gpu.devices, featureStatus: gpu.featureStatus, auxAttributes: Object.fromEntries(Object.entries(gpu.auxAttributes || {}).filter(([key]) => /glRenderer|glVendor|glVersion|passthrough|directRendering|initialized/i.test(key))) }
        try { const command = await browserCall('Browser.getBrowserCommandLine'); perf.gpu.relevantFlags = command.arguments.filter(arg => /^--(?:disable-gpu|use-gl|use-angle|headless|enable-gpu|disable-software-rasterizer|ozone-platform)/.test(arg)) } catch (error) { perf.gpu.commandLineUnavailable = error.message }
      } catch (error) { perf.notes.push(`GPU diagnostics unavailable: ${error.message}`) }
      finally { browserSocket?.close() }
    }
    const rawClick = async (selector, label) => {
      const point = await evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length&&${label ? `(el.title===${JSON.stringify(label)}||el.textContent.trim()===${JSON.stringify(label)})` : 'true'});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      if (!point) throw new Error(`Target control unavailable: ${selector}${label ? ` ${label}` : ''}`)
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    }
    const arm = (label, event, condition) => evaluate(`window.__rwPerf.arm(${JSON.stringify(label)},${JSON.stringify(event)},${JSON.stringify(condition)})`)
    const completed = async () => {
      await waitFor('window.__rwPerf?.active===null', '性能动作未完成', 17000)
      const value = await evaluate('window.__rwPerf.events.at(-1)')
      if (value?.error) throw new Error(`${value.label}: ${value.error}`)
      return value
    }
    const action = async (label, selector, condition, exactLabel) => { await arm(label, 'click', condition); await rawClick(selector, exactLabel); return completed() }
    const selectPage = async (label, metric) => action(metric, '.rw-pageBtn', `document.querySelector('.rw-title')?.textContent.trim()===${JSON.stringify(label)}&&(document.querySelector('.rw-markdown')?.textContent.trim().length||0)>20`, label)
    const settleDiagrams = async label => {
      await waitFor(`document.querySelectorAll('.rw-markdown .dsh-mmd[data-state="ok"]').length>=${perf.expectedDiagrams}&&!document.querySelector('.rw-markdown .dsh-mmd:not([data-state="ok"])')`, `${label} 图表增强器尚未完成`, 30000)
      let consecutive = 0, latest
      for (let attempt = 0; attempt < 30; attempt++) {
        await evaluate("window.__rwPerfSvgSample=[...document.querySelectorAll('.rw-markdown svg[aria-roledescription]')];void 0")
        await pause(150)
        latest = await evaluate("(()=>{const now=[...document.querySelectorAll('.rw-markdown svg[aria-roledescription]')],previous=window.__rwPerfSvgSample;return {stable:previous.length===now.length&&previous.every((svg,index)=>svg===now[index]&&svg.isConnected),count:now.length,ids:now.map(svg=>svg.id),states:[...document.querySelectorAll('.rw-markdown .dsh-mmd')].map(el=>el.dataset.state),at:performance.now()}})()")
        consecutive = latest.stable && latest.count >= perf.expectedDiagrams && latest.states.every(state => state === 'ok') ? consecutive + 1 : 0
        if (consecutive >= 2) return { ...latest, consecutive, intervalMs: 150 }
      }
      throw new Error(`${label} 的 SVG 节点持续变化：${JSON.stringify(latest)}`)
    }
    await waitFor("window.__rwReady&&document.querySelector('.rw-markdown')", '冷启动正文未出现', 30000)
    await pause(30)
    let startup = await evaluate('window.__rwPerf.read()')
    const startupRow = data => ({ treeMs: data.firstTreeMs, firstContentPaintMs: data.firstContentMs, harnessMountMs: data.harnessMountMs, mountToContentPaintMs: data.harnessMountMs !== null && data.firstContentMs !== null ? data.firstContentMs - data.harnessMountMs : null, requests: data.requests, markdownRenders: data.markdownRenders })
    perf.coldNavigation = startupRow(startup)
    perf.coldNavigationSamples = [perf.coldNavigation]
    check('actual MarkdownText render counter is installed', startup.wrapperInstalled === true && startup.markdownRenders > 0, { wrapperError: startup.wrapperError, markdownRenders: startup.markdownRenders })
    if (!quick && !diagnostic) {
      for (let round = 1; round < Number(env.REPOWIKI_PERF_COLD_ROUNDS || 3); round++) {
        const previousOrigin = await evaluate('performance.timeOrigin')
        await rpc('Page.reload', { ignoreCache: true })
        await waitFor(`performance.timeOrigin!==${previousOrigin}&&window.__rwPerf?.firstContentMs!==null&&window.__rwPerf?.firstContentMs!==undefined`, '冷启动重复样本未就绪', 30000)
        startup = await evaluate('window.__rwPerf.read()')
        perf.coldNavigationSamples.push(startupRow(startup))
      }
      perf.coldNavigationSummary = { firstTree: quantiles(perf.coldNavigationSamples.map(row => row.treeMs)), firstContentPaint: quantiles(perf.coldNavigationSamples.map(row => row.firstContentPaintMs)), mountToContentPaint: quantiles(perf.coldNavigationSamples.map(row => row.mountToContentPaintMs)) }
      console.log(`COLD-NAVIGATION: ${JSON.stringify(perf.coldNavigationSummary)}`)
    }
    // 第一章默认展开；用真实按钮选页，不调用 openPage 内部函数。
    perf.samples.coldSelect = [await selectPage(pageLabel, 'cold target page')]
    const realPage = path.join(env.REPOWIKI_WORKSPACE, '.qoder/repowiki/zh/content/项目概述与快速开始', `${pageLabel}.md`)
    const text = await readFile(realPage, 'utf8')
    perf.expectedDiagrams = [...text.matchAll(/^\s*```mermaid\s*$/gm)].length
    perf.layout = await evaluate(`(()=>{
      const content=document.querySelector('.rw-content'),article=document.querySelector('.rw-article'),r=el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return {width:b.width,height:b.height,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,maxWidth:s.maxWidth}};
      return {content:r(content),article:r(article),fillRatio:article.getBoundingClientRect().width/content.getBoundingClientRect().width};
    })()`)
    check('reading article fills available content width', perf.layout.fillRatio >= 0.96, { contentWidth: perf.layout.content.width, articleWidth: perf.layout.article.width, fillRatio: perf.layout.fillRatio })
    console.log(`WIDTH: content=${perf.layout.content.width}px article=${perf.layout.article.width}px fill=${(perf.layout.fillRatio * 100).toFixed(1)}%`)
    await evaluate("document.querySelector('.rw-content').scrollTop=0")
    if (!alternateExperiment) await capture('reading-width-light', 1440, 1000, 'light')

    const inventory = "({svg:[...document.querySelectorAll('.rw-markdown svg')].filter(s=>s.querySelector('foreignObject')||s.hasAttribute('aria-roledescription')).length,plainBlocks:document.querySelectorAll('.rw-markdown .md-code-block').length})"
    perf.diagramInventoryBeforeWait = perf.diagramInventory = await evaluate(inventory)
    if (perf.diagramInventory.svg || env.REPOWIKI_PERF_REQUIRE_DIAGRAMS === '1') {
      const started = await evaluate('performance.now()')
      await evaluate("document.querySelector('.rw-markdown .md-code-block')?.scrollIntoView({block:'start'})")
      await waitFor("document.querySelector('.rw-markdown svg foreignObject')", '首个 Mermaid 图表未渲染', 20000)
      perf.firstDiagramReadyMs = await evaluate(`performance.now()-${started}`)
      const fullHeight = await evaluate("document.querySelector('.rw-content').scrollHeight")
      for (let top = 0; top < fullHeight; top += 720) { await evaluate(`document.querySelector('.rw-content').scrollTop=${top}`); await pause(35) }
      await waitFor(`document.querySelectorAll('.rw-markdown svg[aria-roledescription]').length>=${perf.expectedDiagrams}`, 'Mermaid 图表未全部就绪', 25000)
      perf.allDiagramsAfterScrollReadyMs = await evaluate(`performance.now()-${started}`)
      perf.diagramInventory = await evaluate(inventory)
      perf.diagramTimeline = await evaluate(`window.__rwPerf.diagramTimeline.filter(row=>row.title===${JSON.stringify(pageLabel)})`)
      const firstDiagram = perf.diagramTimeline.find(row => row.count > 0)
      const allDiagrams = perf.diagramTimeline.find(row => row.count >= perf.expectedDiagrams)
      perf.diagramReadyFromAction = { firstMs: firstDiagram ? firstDiagram.at - perf.samples.coldSelect[0].start : null, allMs: allDiagrams ? allDiagrams.at - perf.samples.coldSelect[0].start : null }
      perf.labels = await evaluate(`(()=>{
        const diagrams=[...document.querySelectorAll('.rw-markdown svg')].filter(s=>s.querySelector('foreignObject'));
        return diagrams.flatMap((svg,diagram)=>[...svg.querySelectorAll('foreignObject')].map((fo,index)=>{
          const b=fo.getBoundingClientRect(),box=fo.firstElementChild,s=getComputedStyle(fo),html=box?getComputedStyle(box):null,paragraphs=[...fo.querySelectorAll('p')].map(p=>{const c=getComputedStyle(p);return {clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,lineHeight:c.lineHeight,marginTop:c.marginTop,marginBottom:c.marginBottom,fontSize:c.fontSize}});
          const rects=[],walker=document.createTreeWalker(fo,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const rr of range.getClientRects())rects.push({top:rr.top,bottom:rr.bottom})}
          const minTop=Math.min(...rects.map(v=>v.top)),maxBottom=Math.max(...rects.map(v=>v.bottom));
          return {diagram,index,characters:fo.textContent.trim().length,attributes:{x:fo.getAttribute('x'),y:fo.getAttribute('y'),width:fo.getAttribute('width'),height:fo.getAttribute('height')},bounds:{top:b.top,bottom:b.bottom,width:b.width,height:b.height},overflow:s.overflow,box:box?{clientHeight:box.clientHeight,scrollHeight:box.scrollHeight,offsetHeight:box.offsetHeight,lineHeight:html.lineHeight,display:html.display}:null,paragraphs,textBounds:{top:minTop,bottom:maxBottom},clipped:rects.length>0&&(maxBottom>b.bottom+1||minTop<b.top-1)};
        }));
      })()`)
      const clipped = perf.labels.filter(label => label.clipped)
      check('Mermaid label text fits foreignObject bounds', clipped.length === 0, { totalLabels: perf.labels.length, clippedLabels: clipped.length, examples: clipped.slice(0, 4) })
      await evaluate("document.querySelector('.rw-markdown svg[aria-roledescription]')?.scrollIntoView({block:'start'})")
      // 性能采样完成前保持主题稳定，避免增强器延迟的主题重绘污染 SVG 身份。
      if (quick) { await capture('chart-light', 1440, 1000, 'light'); await capture('chart-dark', 1440, 1000, 'dark') }
      else perf.captureChartsAtEnd = true
    } else {
      perf.notes.push('当前独立 harness 尚未载入宿主图表增强 provider，5 个 Mermaid fence 为 plain code；图表裁字与ready未验证，下面正文性能为纯 Markdown。')
      if (env.REPOWIKI_PERF_ALLOW_PLAIN === '1') report.checks.push({ name: 'real diagram provider and label clipping', status: 'skip', reason: perf.notes.at(-1) })
      else check('real diagram provider is present', false, { expectedDiagrams: perf.expectedDiagrams, actual: perf.diagramInventory, limitation: '未注入实际图表 provider，不把零图当裁字通过' })
      console.log(`DIAGRAM-LIMITATION: ${perf.notes.at(-1)}`)
    }
    if (quick) return

    if (perf.expectedDiagrams && env.REPOWIKI_PERF_REQUIRE_DIAGRAMS === '1') {
      perf.beforeWarmDiagramStability = await settleDiagrams('暖切页前')
      perf.beforeWarmSvg = await evaluate("(()=>{const svg=window.__rwPerfRetainedSvg=document.querySelector('.rw-markdown svg[aria-roledescription]');window.__rwPerfRetainedContainer=svg?.closest('.rw-markdown');window.__rwPerfRetainedWrapper=svg?.closest('.dsh-mmd');return {id:svg?.id,connected:svg?.isConnected,containerClass:window.__rwPerfRetainedContainer?.className,wrapperState:window.__rwPerfRetainedWrapper?.dataset.state,title:document.querySelector('.rw-title')?.textContent.trim()}})()")
      perf.beforeWarmSvg.pagePath = new URLSearchParams(perf.samples.coldSelect[0].apiRequests.find(row => row.path.endsWith('/page'))?.query || '').get('path')
    }
    perf.samples.coldOther = [await selectPage('目录结构与模块边界', 'cold alternate page')]
    perf.samples.warmSelect = []
    for (let index = 0; index < rounds; index++) {
      perf.samples.warmSelect.push(await selectPage(pageLabel, `warm target ${index + 1}`))
      perf.samples.warmSelect.push(await selectPage('目录结构与模块边界', `warm alternate ${index + 1}`))
    }
    await selectPage(pageLabel, 'restore stable target')
    if (perf.expectedDiagrams && env.REPOWIKI_PERF_REQUIRE_DIAGRAMS === '1') {
      perf.afterWarmDiagramStability = await settleDiagrams('暖切页后')
    }
    perf.warmDomReuse = await evaluate("(()=>{const current=document.querySelector('.rw-markdown svg[aria-roledescription]'),old=window.__rwPerfRetainedSvg,container=window.__rwPerfRetainedContainer,wrapper=window.__rwPerfRetainedWrapper;return {sameSvg:old?old===current:null,oldSvgId:old?.id,newSvgId:current?.id,oldSvgConnected:old?.isConnected,oldContainerConnected:container?.isConnected,oldContainerCurrent:container===document.querySelector('.rw-markdown'),oldContainerClass:container?.className,oldContainerHidden:container?.hidden,oldWrapperConnected:wrapper?.isConnected,oldWrapperState:wrapper?.dataset.state,oldWrapperContainsOriginal:wrapper?.contains(old),cachedContainers:document.querySelectorAll('.rw-markdown,.rw-markdownCache').length,cacheCount:Number(document.querySelector('.rw-documentHost')?.dataset.cacheCount??document.querySelectorAll('.rw-markdown,.rw-markdownCache').length)}})()")
    check('warm page switches do not render cached Markdown', perf.samples.warmSelect.every(row => row.markdownRenders === 0), { renders: perf.samples.warmSelect.reduce((sum, row) => sum + row.markdownRenders, 0), samples: perf.samples.warmSelect.length })
    if (env.REPOWIKI_PERF_REQUIRE_DIAGRAMS === '1') check('warm page switches retain the rendered SVG node', perf.warmDomReuse.sameSvg === true, perf.warmDomReuse)
    check('rendered Markdown cache has at most 12 entries', perf.warmDomReuse.cacheCount <= 12, perf.warmDomReuse)
    perf.samples.toggleAll = []
    for (let index = 0; index < rounds; index++) {
      const before = await evaluate("document.querySelector('.rw-catalogHeading button')?.getAttribute('aria-label')")
      perf.samples.toggleAll.push(await action(`toggle all ${index + 1}`, '.rw-catalogHeading button', `document.querySelector('.rw-catalogHeading button')?.getAttribute('aria-label')!==${JSON.stringify(before)}`))
    }
    // 搜索输入使用真实焦点、Ctrl+A、Backspace 和 insertText 事件。
    await rawClick('.rw-search input')
    perf.samples.searchInput = []
    let input = ''
    for (const word of ['系', '统', '总', '览']) {
      input += word
      await arm(`search ${input.length}`, 'input', `document.querySelector('.rw-search input')?.value===${JSON.stringify(input)}&&document.querySelector('.rw-tree').innerText.includes(${JSON.stringify(pageLabel)})`)
      await rpc('Input.insertText', { text: word }); perf.samples.searchInput.push(await completed())
    }
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await arm('clear search', 'input', "document.querySelector('.rw-search input')?.value===''&&document.querySelectorAll('.rw-pageBtn').length>5")
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    perf.samples.clearSearch = [await completed()]
    const previousRequests = await evaluate('window.__rwPerf.requests.length')
    perf.samples.checkStatus = [await action('check status', '.rw-topbar>.rw-btn', `window.__rwPerf.requests.slice(${previousRequests}).some(r=>r.path.endsWith('/status')&&r.parsedAt)&&!document.querySelector('.rw-topbar>.rw-btn').disabled`)]

    perf.sessionTicks = await evaluate(`(async()=>{
      const p=window.__rwPerf,store=window.__rwHarnessStores.sessionList,before={renders:p.markdownRenders,callbacks:p.observerCallbacks,mutations:p.contentMutations,svg:p.svgMutations,tasks:p.longTasks.length},start=performance.now();
      for(let tick=0;tick<20;tick++){await new Promise(r=>setTimeout(r,100));const data=store.getSnapshot();store.set({...data,byId:{...data.byId,sa:{...data.byId.sa,updatedAt:Date.now()}}})}
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return {hz:10,ticks:20,elapsedMs:performance.now()-start,markdownRenders:p.markdownRenders-before.renders,observerCallbacks:p.observerCallbacks-before.callbacks,contentMutations:p.contentMutations-before.mutations,svgMutations:p.svgMutations-before.svg,longTasks:p.longTasks.slice(before.tasks)};
    })()`)
    check('same-workspace session ticks do not render stable Markdown', perf.sessionTicks.markdownRenders === 0, perf.sessionTicks)
    const irrelevant = [...perf.samples.toggleAll, ...perf.samples.searchInput, ...perf.samples.clearSearch, ...perf.samples.checkStatus]
    check('navigation controls do not render stable Markdown', irrelevant.every(row => row.markdownRenders === 0), { count: irrelevant.length, renders: irrelevant.reduce((sum, row) => sum + row.markdownRenders, 0) })
    // 各组只在本脚本的独占 tab 改临时 style；RAF 环内只记时间戳。
    await rpc('Performance.enable')
    if (compositeExperiment) { try { await rpc('LayerTree.enable'); await pause(100); perf.originalLayers = report.layerTree || [] } catch (error) { perf.notes.push(`LayerTree unavailable: ${error.message}`) } }
    const metricNames = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration']
    const measureFrames = async (name, { wheel = false, css = '', profile = false } = {}) => {
      await evaluate(`(()=>{document.querySelector('#rw-perf-experiment')?.remove();const style=document.createElement('style');style.id='rw-perf-experiment';style.textContent=${JSON.stringify(css)};document.head.append(style);document.querySelector('.rw-content').scrollTop=0})()`)
      await pause(200)
      const before = Object.fromEntries((await rpc('Performance.getMetrics')).metrics.map(row => [row.name, row.value]))
      if (profile) { await rpc('Profiler.enable'); await rpc('Profiler.setSamplingInterval', { interval: 1000 }); await rpc('Profiler.start') }
      await evaluate("(()=>{const p=window.__rwPerf;p.scroll={frames:[],start:performance.now(),last:null,active:true,beforeTasks:p.longTasks.length,beforeObservers:p.observerCallbacks,beforeMutations:p.contentMutations,beforeSvg:p.svgMutations};const frame=t=>{const s=p.scroll;if(!s.active)return;if(s.last!==null)s.frames.push(t-s.last);s.last=t;requestAnimationFrame(frame)};requestAnimationFrame(frame)})()")
      const position = await evaluate("(()=>{const r=document.querySelector('.rw-content').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
      if (wheel) { for (let index = 0; index < 36; index++) { await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...position, deltaX: 0, deltaY: 180 }); await pause(16) }; await pause(180) }
      else await pause(1400)
      const sample = await evaluate("(()=>{const p=window.__rwPerf,s=p.scroll;s.active=false;return {...s,end:performance.now(),scrollTop:document.querySelector('.rw-content').scrollTop,longTasks:p.longTasks.slice(s.beforeTasks),observerCallbacks:p.observerCallbacks-s.beforeObservers,contentMutations:p.contentMutations-s.beforeMutations,svgMutations:p.svgMutations-s.beforeSvg}})()")
      const after = Object.fromEntries((await rpc('Performance.getMetrics')).metrics.map(row => [row.name, row.value]))
      sample.name = name; sample.wheel = wheel; sample.profiled = profile; sample.summary = quantiles(sample.frames)
      sample.metricsDelta = Object.fromEntries(metricNames.map(key => [key, Math.round(((after[key] || 0) - (before[key] || 0)) * 100000) / 100000]))
      if (profile) {
        const { profile: cpu } = await rpc('Profiler.stop')
        const filename = path.join(artifactDir, `${name}.cpuprofile`)
        await writeFile(filename, JSON.stringify(cpu), 'utf8')
        const nodes = new Map(cpu.nodes.map(node => [node.id, node])), time = new Map()
        for (let index = 0; index < (cpu.samples || []).length; index++) { const id = cpu.samples[index]; time.set(id, (time.get(id) || 0) + (cpu.timeDeltas?.[index] || 0)) }
        sample.cpuProfile = { file: filename, durationMs: (cpu.endTime - cpu.startTime) / 1000, samples: cpu.samples?.length, topSelfTime: [...time].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, micros]) => { const frame = nodes.get(id)?.callFrame || {}; return { functionName: frame.functionName || '(anonymous)', url: frame.url, line: frame.lineNumber + 1, selfMs: micros / 1000 } }) }
        await rpc('Profiler.disable')
      }
      if (compositeExperiment) {
        sample.layers = []
        for (const layer of (report.layerTree || [])) {
          let reasons
          try { reasons = await rpc('LayerTree.compositingReasons', { layerId: layer.layerId }) } catch {}
          let node
          if (layer.backendNodeId) { try { const result = await rpc('DOM.describeNode', { backendNodeId: layer.backendNodeId }); node = { name: result.node.nodeName, attributes: result.node.attributes } } catch {} }
          sample.layers.push({ ...layer, reasons, node })
        }
      }
      await evaluate("document.querySelector('#rw-perf-experiment')?.remove()")
      console.log(`FRAME-CONTROL: ${name} ${JSON.stringify({ summary: sample.summary, longTasks: sample.longTasks, metricsDelta: sample.metricsDelta })}`)
      return sample
    }
    perf.scrollDiagnostics = [await measureFrames('real-idle')]
    perf.scroll = await measureFrames('real-wheel', { wheel: true })
    perf.scrollDiagnostics.push(perf.scroll)
    if (diagnostic) {
      perf.scrollDiagnostics.push(await measureFrames('blank-idle', { css: '.rw-reader{visibility:hidden!important}' }))
      perf.scrollDiagnostics.push(await measureFrames('blank-wheel', { wheel: true, css: '.rw-reader{visibility:hidden!important}' }))
      if (compositeExperiment) {
        const contentCss = '.rw-content{background:var(--rw-bg);transform:translateZ(0)}'
        const svgCss = '.rw-markdown .dsh-mmd-pane>svg{will-change:transform;transform:translateZ(0)}'
        if (alternateExperiment) {
          perf.alternating = []
          for (let round = 0; round < 3; round++) {
            perf.alternating.push(await measureFrames(`A-original-${round + 1}`, { wheel: true }))
            perf.alternating.push(await measureFrames(`B-combined-${round + 1}`, { wheel: true, css: contentCss + svgCss }))
          }
          perf.scrollDiagnostics.push(...perf.alternating)
        } else {
          perf.scrollDiagnostics.push(await measureFrames('content-layer-wheel', { wheel: true, css: contentCss }))
          perf.scrollDiagnostics.push(await measureFrames('svg-layer-wheel', { wheel: true, css: svgCss }))
          perf.scrollDiagnostics.push(await measureFrames('combined-layer-wheel', { wheel: true, css: contentCss + svgCss }))
        }
      } else {
        const css = '.rw-markdown .dsh-mmd{content-visibility:auto;contain-intrinsic-block-size:auto 440px}'
        perf.scrollDiagnostics.push(await measureFrames('diagram-containment-idle', { css }))
        perf.scrollDiagnostics.push(await measureFrames('diagram-containment-wheel', { wheel: true, css }))
        perf.scrollDiagnostics.push(await measureFrames('profiled-real-wheel', { wheel: true, profile: true }))
      }
      perf.notes.push('scrollDiagnostics 的 blank/CSS 只作用于独占 tab，测后移除；profiled 组单列且不用于正式 FPS 门槛。RAF 是 headless 调度观测，需同时对照 idle/blank。')
    }
    const totals = await evaluate('window.__rwPerf.read()')
    perf.probe = { wrapperInstalled: totals.wrapperInstalled, markdownRenders: totals.markdownRenders, renderMs: quantiles(totals.renderMs), observerCallbacks: totals.observerCallbacks, observerMs: quantiles(totals.observerMs), contentMutations: totals.contentMutations, svgMutations: totals.svgMutations, longTasks: totals.longTasks }
    perf.eventTiming = { browserMinimumDurationMs: 16, observedEntries: totals.eventTimings, processing: quantiles(totals.eventTimings.map(entry => entry.processingMs)), duration: quantiles(totals.eventTimings.map(entry => entry.durationMs)), note: 'Event Timing 的同步 processing 与输入→可见 paint 分列；仅含浏览器报告的 >=16ms 事件，缺失项不等于 <1ms。60Hz 单帧约16.7ms。' }
    for (const [name, samples] of Object.entries(perf.samples)) { perf.summary[name] = { ...quantiles(samples.map(s => s.durationMs)), api: quantiles(samples.flatMap(s => s.apiRequests?.map(r => r.durationMs) || [])), renders: samples.reduce((sum, s) => sum + s.markdownRenders, 0) }; console.log(`PERF: ${name} ${JSON.stringify(perf.summary[name])}`) }
    console.log(`SCROLL: ${JSON.stringify(perf.scroll.summary)}; longTasks=${totals.longTasks.length}; sessionTicksRenders=${perf.sessionTicks.markdownRenders}`)
    check('warm page and control paint stay within 100ms', [...perf.samples.warmSelect, ...irrelevant].every(row => row.durationMs <= 100), { summary: perf.summary })
    check('scroll RAF p95 stays within 25ms', perf.scroll.summary.p95 <= 25, perf.scroll.summary)
    report.apiTiming = totals.requests
    if (perf.captureChartsAtEnd && !alternateExperiment) {
      await evaluate("document.querySelector('.rw-markdown svg[aria-roledescription]')?.scrollIntoView({block:'start'})")
      await capture('chart-light', 1440, 1000, 'light')
      await capture('chart-dark', 1440, 1000, 'dark')
    }
  },
})
