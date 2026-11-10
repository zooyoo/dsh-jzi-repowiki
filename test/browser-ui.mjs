// 浏览器 UI 验证：真实宿主 React/MarkdownText/CSS、当前插件和只读浏览器路由。
// 运行：node test/browser-ui.mjs --baseline；UI 就绪后去掉 --baseline。
// REPOWIKI_GUI_URL / REPOWIKI_CDP_URL：复用现有宿主静态服务及 Chrome CDP。
// REPOWIKI_HOST_ASAR：宿主 app.asar；REPOWIKI_THEME_CSS：可选的真实主题 CSS 文件。
// REPOWIKI_CLIENT / REPOWIKI_BACKEND：覆盖客户端与后端快照，并在报告记录各自 SHA256。
// REPOWIKI_HOST_ASSET / REPOWIKI_HOST_CSS：覆盖真实宿主模块及 CSS。
// REPOWIKI_MERMAID_CLIENT：只读载入已安装图表增强器及其 localhost runtime，不安装插件。
// REPOWIKI_WORKSPACE：现有工作区，只通过 GET 读取 Wiki；绝不调用任何工具或写真实 Wiki。
// REPOWIKI_PAGE_LABEL / REPOWIKI_EXPECT / REPOWIKI_SEARCH_QUERY：真实页面及可见文字哨兵。
// REPOWIKI_UI_URL：已有的独立测试服务；设置后不创建或关闭该服务，也不创建 fixture。
// REPOWIKI_UI_ARTIFACTS：默认 .research/artifacts/browser-ui（已有 .research/ 忽略规则）。
// REPOWIKI_UI_PHASE=baseline 只记录新功能缺失；默认 updated 要求新功能验证通过。
// REPOWIKI_EXPECT_ROOTS：用 | 分隔的预期根目录前缀；真实 Wiki 截图默认折叠非选中章节。
// REPOWIKI_UI_CAPTURE_TREE=all：真实 Wiki 截图仍展示全部展开目录。
// 所有新 tab、临时 server 及 fixture 均有明确所有权；finally 仅清理本次创建的资源。
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { open, readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(testDir)
const env = process.env
const phase = process.argv.includes('--baseline') ? 'baseline' : (env.REPOWIKI_UI_PHASE || 'updated')
assert.ok(['baseline', 'updated'].includes(phase), 'REPOWIKI_UI_PHASE 必须是 baseline 或 updated')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const artifactDir = path.resolve(env.REPOWIKI_UI_ARTIFACTS || path.join(repo, '.research/artifacts/browser-ui'), `${phase}-${stamp}`)
const gui = loopback(env.REPOWIKI_GUI_URL || 'http://127.0.0.1:53845')
const cdp = loopback(env.REPOWIKI_CDP_URL || 'http://127.0.0.1:9222')
const hostAsar = env.REPOWIKI_HOST_ASAR || 'C:/Users/zoyo/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const frontend = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/'
const clientFile = path.resolve(env.REPOWIKI_CLIENT || path.join(repo, 'lib/client.js'))
const backendFile = path.resolve(env.REPOWIKI_BACKEND || path.join(repo, 'lib/index.js'))
const { apply: applyBackend, Config } = await import(pathToFileURL(backendFile).href)
const realWorkspace = env.REPOWIKI_WORKSPACE ? path.resolve(env.REPOWIKI_WORKSPACE) : null
const externalUrl = env.REPOWIKI_UI_URL ? loopback(env.REPOWIKI_UI_URL) : null
const expected = env.REPOWIKI_EXPECT || (realWorkspace || externalUrl ? null : '浏览器验证正文哨兵')
const pageLabel = env.REPOWIKI_PAGE_LABEL || (realWorkspace || externalUrl ? '项目概述' : '事件总线')
const searchQuery = env.REPOWIKI_SEARCH_QUERY || pageLabel
const report = {
  phase, startedAt: new Date().toISOString(), source: realWorkspace ? 'existing-wiki-read-only' : externalUrl ? 'external-ui' : 'synthetic-fixture',
  clientFile, backendFile, clientSha256: null, backendSha256: null, artifactDir, host: {}, checks: [], screenshots: [], snapshots: [],
  consoleErrors: [], exceptions: [], networkFailures: [], serverErrors: [], apiRequests: [], cleanup: {},
}
const stop = new AbortController()
const handlers = []
const routeDisposers = []
let fixture, fixtureHold, server, target, socket, rpc, asarHandle, asarTree, asarOffset, beforeTargets = []
let interrupted = false
for (const name of ['SIGINT', 'SIGTERM']) {
  const handler = () => { interrupted = true; stop.abort(new Error(`收到 ${name}`)) }
  handlers.push([name, handler]); process.once(name, handler)
}

function loopback(input) {
  const url = new URL(input)
  assert.ok(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '浏览器验证只连接本地 loopback 地址')
  return url.href.replace(/\/$/, '')
}
async function localFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(12000)]) })
}
function check(name, ok, details = {}, feature = false) {
  const status = ok ? 'pass' : feature && phase === 'baseline' ? 'baseline-gap' : 'fail'
  report.checks.push({ name, status, ...details })
  console.log(`${status.toUpperCase()}: ${name}${ok ? '' : ` ${JSON.stringify(details)}`}`)
}
async function pause(ms = 80) {
  stop.signal.throwIfAborted()
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function waitFor(expression, message, timeout = 15000) {
  const until = Date.now() + timeout
  let value
  do {
    stop.signal.throwIfAborted()
    value = await evaluate(`Boolean(${expression})`)
    if (value) return value
    await pause()
  } while (Date.now() < until)
  throw new Error(message)
}
async function readAsar(relative) {
  if (!asarHandle) {
    asarHandle = await open(hostAsar, 'r')
    const prefix = Buffer.alloc(8)
    await asarHandle.read(prefix, 0, 8, 0)
    const header = Buffer.alloc(prefix.readUInt32LE(4))
    await asarHandle.read(header, 0, header.length, 8)
    asarTree = JSON.parse(header.toString('utf8', 8, 8 + header.readUInt32LE(4)))
    asarOffset = 8 + header.length
  }
  assert.ok(!relative.split('/').includes('..'), 'ASAR 路径必须在宿主包内')
  let node = asarTree
  for (const part of relative.split('/')) node = node?.files?.[part]
  assert.ok(node && !node.files && !node.link, `宿主资源不存在或不是普通文件：${relative}`)
  if (node.unpacked) return readFile(path.join(`${hostAsar}.unpacked`, relative))
  const data = Buffer.alloc(node.size)
  await asarHandle.read(data, 0, data.length, asarOffset + Number(node.offset))
  return data
}
async function discoverHost() {
  // 首页可能需要认证；从本机安装包读取静态 HTML，不读取用户认证数据。
  const html = (await readAsar(`${frontend}index.html`)).toString('utf8')
  const script = env.REPOWIKI_HOST_ASSET || html.match(/<script[^>]+src="\.([^\"]+\.js)"/)?.[1]
  assert.ok(script, '无法从宿主 HTML 找到入口；请设置 REPOWIKI_HOST_ASSET')
  const styles = env.REPOWIKI_HOST_CSS ? env.REPOWIKI_HOST_CSS.split(',') : [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.([^\"]+)"/g)].map(m => m[1])
  assert.ok(styles.length > 0, '没有找到真实宿主 CSS')
  const response = await localFetch(new URL(script, `${gui}/`))
  assert.ok(response.ok, `宿主 JS HTTP ${response.status}`)
  const source = await response.text()
  const factory = source.match(/function ([\w$]+)\(\)\{return\{react:[^,]+,"react\/jsx-runtime":/)
  const offset = source.lastIndexOf(';try{const e=document.getElementById("root")')
  assert.ok(factory && offset > 0, '无法识别宿主模块表或启动入口；本 harness 不使用 React/Markdown 替身')
  const moduleSource = source.slice(0, offset) + `;globalThis.__rwHostModules=${factory[1]}();`
  let themeCss
  if (env.REPOWIKI_THEME_CSS) themeCss = await readFile(env.REPOWIKI_THEME_CSS, 'utf8')
  else {
    const themeBundle = (await readAsar('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')).toString('utf8')
    themeCss = [...themeBundle.matchAll(/(?:const|let|var) [\w$]+ = ("(?:\\.|[^"\\])*");/g)]
      .map(m => { try { return JSON.parse(m[1]) } catch { return '' } })
      .filter(css => css.includes('--dsw-alias-link:') && css.includes('body[data-ds-dark-theme]')).join('\n')
  }
  assert.ok(themeCss?.includes('--dsw-alias-link:') && themeCss.includes('body[data-ds-dark-theme]'), '必须加载真实宿主的深浅色 token；可设置 REPOWIKI_THEME_CSS')
  report.host = { gui, cdp, script, styles, themeSource: env.REPOWIKI_THEME_CSS || '@deepseek-ai/dsh-client-ui-theme/lib/client.js', moduleFactory: factory[1] }
  return { script, styles, moduleSource, themeCss }
}
async function makeFixture() {
  fixture = await mkdtemp(path.join(testDir, '.browser-ui-fixture-'))
  const roots = ['ui-demo', 'other-demo'].map(name => path.join(fixture, name))
  const demo = [
    '# 事件总线', '', '<cite>', '[event-bus.ts](file://src/example/event-bus.ts)', '[navigation.md](file://docs/example/navigation.md)', '</cite>', '',
    '浏览器验证正文哨兵：这份内容只用于界面验证，不包含真实项目代码。', '',
    '## 目录', '', '1. [Navigation target](#navigation-target)', '2. [目录职责](#目录职责)', '', '## 目录职责', '',
    '目录应保留元数据顺序，搜索后可以找到深层页面。选中当前页面时应给出可识别的导航反馈。', '',
    '| 检查项 | 预期行为 |', '| --- | --- |', '| 引用文件 | 默认收起，可以展开 |', '| 阅读列 | 大屏控制宽度，窄屏仍可阅读 |', '',
    '> 提示：引用文件、页内导航和正文使用真实宿主的 MarkdownText。', '',
    '```text', 'synthetic-example-long-line-for-contained-code-overflow-check-'.repeat(5), '```', '',
    ...Array.from({ length: 8 }, (_, index) => `### 阅读段落 ${index + 1}\n\n这是一段用于验证页内滚动和阅读宽度的合成文字。内容应自然换行，正文不应被目录挤压到无法阅读。\n`),
    '## Navigation target', '', '页内锚点目标哨兵。', '', '### 子章节', '', '滚动到章节后仍应保留当前目录选中态。',
  ].join('\n')
  const pages = {
    '项目概述': '# 项目概述\n\n合成 Wiki 目录入口，方便验证元数据顺序。\n',
    '快速开始': '# 快速开始\n\n先打开目录，再选择正文。\n',
    '核心架构': '# 核心架构\n\n这是一个可选的章节首页。\n',
    '核心架构/事件总线': demo,
    '核心架构/深入机制/调度策略': '# 调度策略\n\n深层搜索结果哨兵。\n',
    '参考资料/附录': '# 附录\n\n附录页面。\n',
  }
  for (const [index, root] of roots.entries()) {
    const wiki = path.join(root, '.qoder/repowiki')
    const metadata = {
      wiki_repo: { id: 'repo-ui', name: 'UI fixture', gmt_modified: '2026-11-01' },
      // 数组刻意打乱；省略 order 的真实 Qoder 首页应按 0 排在最前面。
      wiki_catalogs: [
        { id: 'catalog-start', name: '快速开始', parent_id: null, order: 2 },
        { id: 'catalog-reference', name: '参考资料', parent_id: null, order: 3 },
        { id: 'catalog-overview', name: '项目概述', parent_id: null },
        { id: 'catalog-bus', name: '事件总线', parent_id: 'catalog-core', order: 0 },
        { id: 'catalog-core', name: '核心架构', parent_id: null, order: 1 },
        { id: 'catalog-deep', name: '深入机制', parent_id: 'catalog-core', order: 1 },
        { id: 'catalog-scheduler', name: '调度策略', parent_id: 'catalog-deep', order: 0 },
        { id: 'catalog-appendix', name: '附录', parent_id: 'catalog-reference', order: 0 },
      ],
      wiki_items: [
        { id: 'overview', title: '项目概述', catalog_id: 'catalog-overview' },
        { id: 'start', title: '快速开始', catalog_id: 'catalog-start' },
        { id: 'core-home', title: '核心架构', catalog_id: 'catalog-core' },
        { id: 'bus', title: '事件总线', catalog_id: 'catalog-bus' },
        { id: 'scheduler', title: '调度策略', catalog_id: 'catalog-scheduler' },
        { id: 'appendix', title: '附录', catalog_id: 'catalog-appendix' },
      ],
    }
    const selectedPages = index === 0 ? pages : {
      '另一工作区': '# 另一工作区\n\n工作区切换正文哨兵。\n',
      // 同路径、同标题的不同正文可以检测渲染缓存是否串工作区。
      '核心架构/事件总线': '# 事件总线\n\n另一工作区同名页隔离哨兵。\n',
    }
    const pageIndex = {}
    for (const [name, markdown] of Object.entries(selectedPages)) {
      const file = path.join(wiki, 'zh/content', `${name}.md`)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, markdown, 'utf8')
      pageIndex[name] = { title: path.posix.basename(name), updatedAt: '2026-11-01', size: Buffer.byteLength(markdown), sources: [], sourceStats: {} }
    }
    await mkdir(path.join(wiki, 'zh/meta'), { recursive: true })
    await writeFile(path.join(wiki, 'zh/meta/repowiki-metadata.json'), JSON.stringify(metadata), 'utf8')
    await writeFile(path.join(wiki, '.repowiki-index.json'), JSON.stringify({ generatedAt: '2026-11-01', pages: pageIndex, sources: {} }), 'utf8')
  }
  return roots
}
async function createServer(host) {
  const roots = realWorkspace ? [realWorkspace] : await makeFixture()
  const routes = new Map()
  const registry = {
    get(id) { const index = ['a', 'b'].indexOf(id); return index >= 0 && roots[index] ? { path: roots[index] } : null },
    list() { return roots.map(root => ({ path: root })) },
  }
  const ctx = {
    // 工具只注册，不调用；fs 写方法显式拒绝，浏览器只允许读取下面的三个 GET 路由。
    fs: { writeText() { throw new Error('UI harness 禁止写 Wiki') } },
    tools: { register() {} }, get(name) { return name === 'workspaceRegistry' ? registry : undefined },
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') routeDisposers.push(disposer) },
    inject(_names, callback) { callback({ webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }, effect(callback) { const disposer = callback(); if (typeof disposer === 'function') routeDisposers.push(disposer) } }) },
  }
  const config = Config({})
  config.defaultWorkspace = roots[0]
  applyBackend(ctx, config)
  const plugin = await readFile(clientFile, 'utf8')
  const diagramPlugin = env.REPOWIKI_MERMAID_CLIENT ? await readFile(path.resolve(env.REPOWIKI_MERMAID_CLIENT), 'utf8') : null
  if (diagramPlugin) report.host.diagramPlugin = { file: path.resolve(env.REPOWIKI_MERMAID_CLIENT), sha256: createHash('sha256').update(diagramPlugin).digest('hex') }
  report.clientSha256 = createHash('sha256').update(plugin).digest('hex')
  report.backendSha256 = createHash('sha256').update(await readFile(backendFile)).digest('hex')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repo Wiki UI verification</title>${host.styles.map(css => `<link rel="stylesheet" href="${css}">`).join('')}<style>${host.themeCss}</style><style>html,body,#root{width:100%;height:100%;margin:0;min-width:0}body{font-family:system-ui,"Microsoft YaHei",sans-serif}#root{position:relative}</style></head><body><div id="root"></div><script>
window.__rwPlugins={};window.__ModuleLoader__={load({id,factory}){const plugin=factory(name=>{if(!(name in window.__rwHostModules))throw new Error('missing host module '+name);return window.__rwHostModules[name]});window.__rwPlugins[id]=plugin;window.__rwPlugin=plugin}};
window.__rwSetTheme=theme=>{document.body.toggleAttribute('data-ds-dark-theme',theme==='dark');document.documentElement.style.colorScheme=theme;document.body.style.colorScheme=theme};
window.__rwSetTheme('light');
</script><script type="module">
import ${JSON.stringify(host.script)};window.__rwProbeHost?.(window.__rwHostModules);await import('/plugin.js');const wikiPlugin=window.__rwPlugin;${diagramPlugin ? "await import('/diagram-plugin.js');" : ''}
const React=window.__rwHostModules.react;
if(window.__rwHostModules['@deepseek-ai/dsh-client-ui-primitives']?.MarkdownText==null)throw new Error('missing real MarkdownText');
function store(data){const listeners=new Set();return {getSnapshot:()=>data,subscribe:listener=>(listeners.add(listener),()=>listeners.delete(listener)),set:value=>{data=value;for(const listener of listeners)listener()}}}
const workspaceList=store({items:${JSON.stringify(roots.map((root, index) => ({ workspaceId: index === 0 ? 'a' : 'b', path: root, sessionIds: [index === 0 ? 'sa' : 'sb'] })))},recentWorkspaceId:'a'});
const sessionList=store({byId:{sa:{id:'sa',retainedBy:{mainView:1},updatedAt:2},sb:{id:'sb',retainedBy:{mainView:0},updatedAt:1}}});
window.__rwHarnessStores={workspaceList,sessionList};
const dictionaries={};const t=(key,values)=>{let value=dictionaries.zh?.[key]??key;for(const [name,replacement] of Object.entries(values??{}))value=value.replaceAll('{'+name+'}',String(replacement));return value};
let main;const ctx={workspaces:{list:workspaceList},sessions:{list:sessionList},locale:{bind:()=>t,register:(_ns,dict)=>{Object.assign(dictionaries,dict);return ()=>{}}},effect:callback=>callback(),slots:{inject:(_slot,callback)=>callback(),register:(options,component)=>{if(options.name==='main')main=component;return ()=>{}}}};
wikiPlugin.apply(ctx);${diagramPlugin ? "window.__rwPlugins['dsh-mermaid'].apply({effect(callback){const dispose=callback();if(typeof dispose==='function')window.addEventListener('pagehide',dispose,{once:true})}});" : ''}if(!main)throw new Error('missing Repo Wiki main slot');
window.__rwHarnessMountMs=performance.now();window.__rwHostModules['react-dom/client'].createRoot(document.getElementById('root')).render(React.createElement(main,{t}));window.__rwReady=true;
</script></body></html>`
  const cache = new Map()
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Connection', 'close')
      if (req.method !== 'GET') { res.writeHead(405); return res.end('Read-only UI harness') }
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html) }
      if (url.pathname === host.script) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(host.moduleSource) }
      if (url.pathname === '/plugin.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(plugin) }
      if (url.pathname === '/diagram-plugin.js' && diagramPlugin) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(diagramPlugin) }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
      if (url.pathname.startsWith('/plugins/dsh-plugin-repowiki/api/')) {
        report.apiRequests.push({ path: url.pathname, page: url.searchParams.get('path'), workspaceId: url.searchParams.get('workspaceId'), refresh: url.searchParams.get('refresh') })
        if (!realWorkspace && fixtureHold && !fixtureHold.captured && url.pathname.endsWith('/page') && url.searchParams.get('workspaceId') === 'a' && url.searchParams.get('path') === fixtureHold.path) {
          // 专用合成 race：在读取旧正文后暂停响应，让后续点击得到更新的正文。
          const hold = fixtureHold
          const markdown = await readFile(hold.file, 'utf8')
          hold.captured = true
          hold.body = JSON.stringify({ state: 'ok', path: hold.path, title: path.posix.basename(hold.path), markdown, sources: [], sourceStats: {}, updatedAt: null, size: Buffer.byteLength(markdown) })
          await hold.readyToRelease
          if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(hold.body) }
          hold.sent = true
          return
        }
        if (realWorkspace && url.pathname.endsWith('/status')) {
          // 真实模式不对源码做 stat，只读元数据及页面；不把受限状态伪装成有效 freshness 结果。
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ state: 'no-index', incrementalBaseline: false, reason: 'UI harness: source freshness inspection disabled in read-only real Wiki mode.' }))
        }
        const route = routes.get(url.pathname)
        if (route) return await route.handler(req, res)
      }
      if (url.pathname.startsWith('/assets/') || (diagramPlugin && url.pathname.startsWith('/dsh-mermaid/'))) {
        if (!cache.has(url.pathname)) {
          const upstream = await localFetch(new URL(url.pathname, `${gui}/`))
          cache.set(url.pathname, { status: upstream.status, type: upstream.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await upstream.arrayBuffer()) })
        }
        const asset = cache.get(url.pathname)
        res.writeHead(asset.status, { 'Content-Type': asset.type }); return res.end(asset.body)
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
      report.serverErrors.push(error.message)
      if (!res.headersSent) res.writeHead(500)
      res.end('UI harness resource error')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(env.REPOWIKI_UI_PORT || 0), '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}/`
}
async function connect(url, beforeNavigate) {
  const created = await localFetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })
  assert.ok(created.ok, `CDP 创建 tab HTTP ${created.status}`)
  target = await created.json()
  assert.ok(target.id && !beforeTargets.includes(target.id), 'CDP 没有返回独占的新 tab')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 超时')), 10000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')) }
  })
  let sequence = 0
  const pending = new Map(), networkRequests = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request, type } = message.params
      const url = new URL(request.url)
      // 仅留本地资源路径与 Wiki 页面参数，避免记录宿主认证和无关查询参数。
      networkRequests.set(requestId, { path: url.pathname, pagePath: url.searchParams.get('path'), type })
    }
    if (message.method === 'Runtime.exceptionThrown') report.exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') report.consoleErrors.push(message.params.args.map(arg => arg.description ?? arg.value ?? '').join(' '))
    if (message.method === 'Network.loadingFailed' && !message.params.canceled) report.networkFailures.push({ error: message.params.errorText, type: message.params.type, requestId: message.params.requestId, ...networkRequests.get(message.params.requestId) })
    if (['Network.loadingFailed', 'Network.loadingFinished'].includes(message.method)) networkRequests.delete(message.params.requestId)
    if (message.method === 'LayerTree.layerTreeDidChange' && message.params.layers) report.layerTree = message.params.layers
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) report.networkFailures.push({ status: message.params.response.status, url: message.params.response.url, type: message.params.type })
    if (message.id && pending.has(message.id)) { const callback = pending.get(message.id); pending.delete(message.id); callback(message) }
  }
  socket.onclose = () => { for (const callback of pending.values()) callback({ error: { message: 'CDP WebSocket closed' } }); pending.clear() }
  rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (stop.signal.aborted) return reject(stop.signal.reason)
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 15000)
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await rpc('Runtime.enable'); await rpc('Page.enable'); await rpc('Network.enable')
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  if (beforeNavigate) await beforeNavigate({ rpc, evaluate, report })
  await rpc('Page.navigate', { url })
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function click(selector, label = null) {
  const location = await evaluate(`(()=>{const elements=[...document.querySelectorAll(${JSON.stringify(selector)})];const element=elements.find(el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&${label === null ? 'true' : `(el.title===${JSON.stringify(label)}||el.textContent.trim()===${JSON.stringify(label)})`});if(!element)return null;element.scrollIntoView({block:'nearest',inline:'nearest'});const rect=element.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()`)
  if (!location) return false
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...location })
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...location, button: 'left', clickCount: 1 })
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...location, button: 'left', clickCount: 1 })
  await pause(100)
  return true
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
}
async function inputSearch(text) {
  const found = await click('.rw-tree input[type="search"],.rw-tree input[placeholder],.rw-search input')
  if (!found) return false
  await key('a', 'KeyA', 65, 2)
  await key('Backspace', 'Backspace', 8)
  if (text) await rpc('Input.insertText', { text })
  await pause(180)
  return true
}
async function openDirectories() {
  for (let depth = 0; depth < 8; depth++) {
    const controls = await evaluate(`(()=>{return [...document.querySelectorAll('.rw-tree button[aria-expanded="false"],.rw-tree .rw-dir')].filter(el=>!el.matches('.rw-pageBtn')||!el.parentElement.querySelector('.rw-toggle')).filter(el=>el.getAttribute('aria-expanded')==='false'||(!el.hasAttribute('aria-expanded')&&/^▸/.test(el.textContent.trim()))).map((el,index)=>{el.dataset.rwHarnessExpand=String(index);return index})})()`)
    if (!controls.length) return
    for (const index of controls) await click(`[data-rw-harness-expand="${index}"]`)
    await evaluate("document.querySelectorAll('[data-rw-harness-expand]').forEach(el=>delete el.dataset.rwHarnessExpand)")
  }
}
async function snapshot(name) {
  const value = await evaluate(`(()=>{const visible=el=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&(!el.closest('details:not([open])')||!!el.closest('summary'));const rect=el=>{if(!el)return null;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {width:Math.round(r.width),height:Math.round(r.height),clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,maxWidth:s.maxWidth,color:s.color,background:s.backgroundColor}};const root=document.querySelector('.rw-root'),tree=document.querySelector('.rw-tree'),content=document.querySelector('.rw-content');const h1=[...document.querySelectorAll('.rw-content h1')].filter(visible);const title=[...document.querySelectorAll('.rw-content h1,.rw-content .rw-title')].filter(visible);const active=[...document.querySelectorAll('.rw-pageBtn[data-active="true"],.rw-pageBtn[aria-current="page"]')];const article=document.querySelector('.rw-article,.rw-reading,.rw-markdown')||h1[0]?.parentElement;const over=[...document.querySelectorAll('.rw-root *')].filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.right>innerWidth+2||r.left<-2}).slice(0,8).map(el=>({tag:el.tagName,className:typeof el.className==='string'?el.className:'svg',width:Math.round(el.getBoundingClientRect().width)}));return {name:${JSON.stringify(name)},viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,root:rect(root),tree:rect(tree),content:rect(content),article:rect(article),h1Count:h1.length,titleLabels:title.map(el=>el.textContent.trim()),active:active.map(el=>({title:el.title,text:el.textContent.trim(),ariaCurrent:el.getAttribute('aria-current'),...rect(el)})),treeRows:[...document.querySelectorAll('.rw-tree .rw-dir,.rw-tree .rw-pageBtn')].filter(visible).map(el=>({title:el.title,text:el.textContent.trim(),expanded:el.getAttribute('aria-expanded')})),overflowElements:over,theme:{dark:document.body.hasAttribute('data-ds-dark-theme'),link:getComputedStyle(document.body).getPropertyValue('--dsw-alias-link').trim(),brand:getComputedStyle(document.body).getPropertyValue('--dsw-alias-brand-primary').trim(),primary:getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim()}}})()`)
  report.snapshots.push(value)
  return value
}
async function capture(name, width, height, theme) {
  await rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
  await evaluate(`window.__rwSetTheme?window.__rwSetTheme(${JSON.stringify(theme)}):(document.body.toggleAttribute('data-ds-dark-theme',${JSON.stringify(theme)}==='dark'),document.documentElement.style.colorScheme=${JSON.stringify(theme)})`)
  await evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))")
  // 截图前移开上次操作留下的悬停，避免把无关树节点拍成第二个选中项。
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 12, y: height - 12 })
  await pause(150)
  if (env.REPOWIKI_MERMAID_CLIENT && await evaluate("document.querySelectorAll('.rw-markdown .dsh-mmd').length>0")) {
    // 主题变更会异步重绘图表，截图必须等实际增强器完成而不是拍旧主题 SVG。
    await pause(180)
    let stable = 0
    for (let attempt = 0; attempt < 60 && stable < 2; attempt++) {
      await evaluate("window.__rwCaptureSvg=[...document.querySelectorAll('.rw-markdown svg[aria-roledescription]')];void 0")
      await pause(100)
      const ready = await evaluate("(()=>{const blocks=[...document.querySelectorAll('.rw-markdown .dsh-mmd')],now=[...document.querySelectorAll('.rw-markdown svg[aria-roledescription]')],previous=window.__rwCaptureSvg;return blocks.length>0&&blocks.every(el=>el.dataset.state==='ok')&&previous.length===now.length&&previous.every((el,index)=>el===now[index]&&el.isConnected)})()")
      stable = ready ? stable + 1 : 0
    }
    assert.ok(stable >= 2, `截图 ${name} 的图表未稳定`)
  }
  const state = await snapshot(name)
  const image = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
  const file = path.join(artifactDir, `${name}.png`)
  await writeFile(file, Buffer.from(image.data, 'base64'))
  report.screenshots.push(file)
  const overflow = state.documentWidth > width + 2 || ['root', 'tree', 'content'].some(key => state[key] && state[key].scrollWidth > state[key].clientWidth + 2)
  check(`${name}: no horizontal overflow`, !overflow, { documentWidth: state.documentWidth, viewportWidth: width, regions: { root: state.root, tree: state.tree, content: state.content }, overflowElements: state.overflowElements }, true)
  check(`${name}: visible content`, state.content?.width > 160 && state.content?.height > 100, { content: state.content }, true)
  console.log(`SCREENSHOT: ${file}`)
  return state
}
async function verifyInPageNavigation() {
  const toc = await evaluate("(()=>{const nav=document.querySelector('nav.rw-toc'),markdown=document.querySelector('.rw-markdown');const items=[...nav?.querySelectorAll('a[href^=\"#\"]')??[]].map(link=>{const href=link.getAttribute('href');let id;try{id=decodeURIComponent(href.slice(1))}catch{id=href.slice(1)}const target=document.getElementById(id);return {href,id,label:link.textContent.trim(),hasTarget:!!target&&!!markdown?.contains(target)}});return {present:!!nav,items}})()")
  report.pageNavigation = toc
  check('page-local table of contents is available', toc.present && toc.items.length > 0, toc, true)
  check('every page-local TOC item has a rendered heading target', toc.items.length > 0 && toc.items.every(item => item.hasTarget), { items: toc.items }, true)
  const chosen = realWorkspace || externalUrl ? toc.items.at(-1) : toc.items.find(item => item.id === 'navigation-target')
  if (!chosen?.hasTarget) return
  const beforeUrl = await evaluate('location.href')
  await evaluate(`(()=>{const link=[...document.querySelectorAll('nav.rw-toc a')].find(el=>el.getAttribute('href')===${JSON.stringify(chosen.href)});if(link)link.dataset.rwHarnessAnchor='true';document.querySelector('.rw-content').scrollTop=0})()`)
  await click('[data-rw-harness-anchor="true"]')
  await pause(200)
  const anchored = await evaluate(`(()=>{const target=document.getElementById(${JSON.stringify(chosen.id)}),content=document.querySelector('.rw-content'),r=target.getBoundingClientRect(),c=content.getBoundingClientRect();return {target:${JSON.stringify(chosen.id)},top:r.top,containerTop:c.top,containerBottom:c.bottom,scrollTop:content.scrollTop,visible:r.top>=c.top-2&&r.top<c.bottom,url:location.href}})()`)
  report.pageNavigation.clicked = anchored
  check('in-page TOC scrolls within reading area', anchored.visible && anchored.scrollTop > 0, anchored, true)
  check('in-page TOC preserves the host route', anchored.url === beforeUrl, { beforeUrl, afterUrl: anchored.url }, true)
  await evaluate("document.querySelectorAll('[data-rw-harness-anchor]').forEach(el=>delete el.dataset.rwHarnessAnchor)")
}
async function prepareCaptureTree() {
  if (!realWorkspace || env.REPOWIKI_UI_CAPTURE_TREE === 'all') return
  const controls = await evaluate("(()=>{const controls=[...document.querySelectorAll('.rw-treeList>.rw-treeItem>.rw-treeRow>.rw-toggle[aria-expanded=\"true\"]')].filter(el=>el.parentElement.dataset.active!=='true'&&el.parentElement.dataset.trail!=='true');return controls.map((el,index)=>{el.dataset.rwHarnessCapture=String(index);return index})})()")
  for (const index of controls) await click(`[data-rw-harness-capture="${index}"]`)
  await evaluate("document.querySelectorAll('[data-rw-harness-capture]').forEach(el=>delete el.dataset.rwHarnessCapture)")
  const nested = await evaluate("(()=>{return [...document.querySelectorAll('.rw-treeChildren .rw-toggle[aria-expanded=\"true\"]')].map((el,index)=>{el.dataset.rwHarnessCapture=String(index);return index})})()")
  for (const index of nested.reverse()) await click(`[data-rw-harness-capture="${index}"]`)
  await evaluate("document.querySelectorAll('[data-rw-harness-capture]').forEach(el=>delete el.dataset.rwHarnessCapture);const tree=document.querySelector('.rw-treeScroll');if(tree)tree.scrollTop=0")
}
async function focusState() {
  return evaluate("(()=>{const el=document.activeElement,s=el?getComputedStyle(el):null;return {tag:el?.tagName,className:typeof el?.className==='string'?el.className:'',label:el?.getAttribute('aria-label')||el?.title||'',inTree:!!el?.closest('.rw-tree'),visible:!!el?.getClientRects().length,body:el===document.body,outlineStyle:s?.outlineStyle,outlineWidth:s?.outlineWidth,outlineColor:s?.outlineColor}})()")
}
async function verifyDrawer() {
  const width = Number(env.REPOWIKI_UI_NARROW_WIDTH || 390)
  const opener = '.rw-content .rw-menuBtn,.rw-topbar .rw-menuBtn'
  const opened = await click(opener)
  check('narrow catalog has a visible menu button', opened, {}, true)
  if (!opened) return
  report.focus = { afterOpen: await focusState(), tabSequence: [] }
  check('opening narrow catalog moves focus into navigation', report.focus.afterOpen.inTree && report.focus.afterOpen.visible, report.focus.afterOpen, true)
  await capture('narrow-light-navigation', width, 844, 'light')
  await capture('narrow-dark-navigation', width, 844, 'dark')
  // 从抽屉内开始遍历一整圈，确认背景内容不会抢走 Tab 焦点。
  const count = await evaluate("(()=>{const tree=document.querySelector('.rw-tree');const focusable=[...tree.querySelectorAll('button,input,select,a[href],[tabindex]')].filter(el=>el.getClientRects().length>0&&!el.disabled&&el.tabIndex>=0);focusable[0]?.focus();return focusable.length})()")
  for (let index = 0; index < count + 2; index++) {
    await key('Tab', 'Tab', 9)
    report.focus.tabSequence.push(await focusState())
  }
  check('narrow catalog keeps Tab focus inside navigation', report.focus.tabSequence.length > 0 && report.focus.tabSequence.every(item => item.inTree && item.visible && !item.body), { sequence: report.focus.tabSequence }, true)
  await evaluate("document.querySelector('.rw-tree input')?.focus()")
  await key('Escape', 'Escape', 27)
  await pause(100)
  report.focus.afterEscape = await focusState()
  const closedAfterEscape = await evaluate("document.querySelector('.rw-root').getAttribute('data-nav-open')!=='true'")
  check('Escape closes narrow catalog and restores menu focus', closedAfterEscape && report.focus.afterEscape.visible && !report.focus.afterEscape.body && !report.focus.afterEscape.inTree, report.focus.afterEscape, true)
  if (!closedAfterEscape) await click('.rw-content .rw-menuBtn')
  await click(opener)
  await openDirectories()
  const selected = await click('.rw-tree .rw-pageBtn', pageLabel)
  await pause(100)
  report.focus.afterSelect = await focusState()
  const closedAfterSelect = await evaluate("document.querySelector('.rw-root').getAttribute('data-nav-open')!=='true'")
  check('selecting a page closes narrow catalog', selected && closedAfterSelect, {}, true)
  check('selecting a page preserves a visible keyboard focus', report.focus.afterSelect.visible && !report.focus.afterSelect.body && !report.focus.afterSelect.inTree, report.focus.afterSelect, true)
}
async function verify() {
  await waitFor("document.querySelector('.rw-tree')&&document.querySelector('.rw-content')", 'Repo Wiki 主区域未出现')
  check('real host renderer', await evaluate("window.__rwHostModules?.['@deepseek-ai/dsh-client-ui-primitives']?.MarkdownText!=null"), {}, !!externalUrl)
  await openDirectories()
  const initial = await snapshot('initial-tree')
  report.rootRows = await evaluate("[...document.querySelectorAll('.rw-treeList>.rw-treeItem>.rw-treeRow>.rw-pageBtn')].map(el=>el.title||el.textContent.trim())")
  if (env.REPOWIKI_EXPECT_ROOTS) {
    const expectedRoots = env.REPOWIKI_EXPECT_ROOTS.split('|')
    check('expected root directory order is visible', expectedRoots.every((name, index) => report.rootRows[index] === name), { expected: expectedRoots, actual: report.rootRows }, true)
  }
  if (!realWorkspace && !externalUrl) {
    const names = initial.treeRows.map(row => row.title || row.text.replace(/^[▾▸]\s*/, ''))
    const overview = names.indexOf('项目概述'), start = names.indexOf('快速开始'), core = names.indexOf('核心架构')
    check('metadata order in rendered tree', overview >= 0 && overview < core && core < start, { names }, true)
  }
  const clicked = await click('.rw-pageBtn', pageLabel)
  check('page button is reachable', clicked, { pageLabel })
  if (!clicked) return
  await waitFor(`(()=>{const content=document.querySelector('.rw-content'),title=content?.querySelector('.rw-title,h1');return title?.textContent.trim()===${JSON.stringify(pageLabel)}&&${expected ? `content.innerText.includes(${JSON.stringify(expected)})` : "content.querySelector('h1,h2,p')"}})()`, '所选页面正文未出现')
  await evaluate("document.querySelector('.rw-content').scrollTop=0")
  const selected = await snapshot('selected-page')
  report.rendering = await evaluate(`(()=>{const style=el=>{if(!el)return null;const s=getComputedStyle(el);return {tag:el.tagName,className:typeof el.className==='string'?el.className:'',fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,whiteSpace:s.whiteSpace,overflowWrap:s.overflowWrap,overflowX:s.overflowX,display:s.display}};const body=getComputedStyle(document.body);const placeholder=[...document.querySelectorAll('.rw-markdown *')].find(el=>el.children.length===0&&el.textContent.trim()==='跳转到页内章节');return {fonts:Object.fromEntries(['body','.rw-root','.rw-markdown','.rw-markdown p'].map(selector=>[selector,style(document.querySelector(selector))])),fontTokens:[...body].filter(name=>name.startsWith('--')&&/font.*family|family.*font|font-sans/i.test(name)).slice(0,20).map(name=>({name,value:body.getPropertyValue(name).trim()})),headings:[...document.querySelectorAll('.rw-markdown h1,.rw-markdown h2,.rw-markdown h3')].slice(0,14).map(el=>({tag:el.tagName,id:el.id,name:el.getAttribute('name'),text:el.textContent.trim()})),links:[...document.querySelectorAll('.rw-markdown a,.rw-markdown [role="link"]')].slice(0,12).map(el=>({tag:el.tagName,href:el.getAttribute('href'),role:el.getAttribute('role'),text:el.textContent.trim().slice(0,80)})),anchorPlaceholder:${!realWorkspace && !externalUrl ? "placeholder?.outerHTML??null" : 'null'},code:[...document.querySelectorAll('.rw-markdown pre,.rw-markdown code')].slice(0,4).map(el=>({self:style(el),parent:style(el.parentElement),grandparent:style(el.parentElement?.parentElement)}))}})()`)
  check('selected page state', selected.active.length === 1 && (selected.active[0].title === pageLabel || selected.active[0].text.includes(pageLabel)), { active: selected.active })
  check('single visible article title', selected.h1Count === 1 && selected.titleLabels.filter(title => title === pageLabel).length === 1, { h1Count: selected.h1Count, titleLabels: selected.titleLabels }, true)
  check('desktop article fills available reading width', selected.article?.width >= selected.content?.width * 0.96, { article: selected.article, content: selected.content, fillRatio: selected.article?.width / selected.content?.width }, true)
  const detail = await evaluate("(()=>{const cite=document.querySelector('.rw-cite');const details=cite?.matches('details')?cite:cite?.querySelector('details');return {present:!!cite,semantic:!!details,open:details?.open,count:cite?.querySelectorAll('li').length??0,raw:document.querySelector('.rw-content').innerText.includes('<cite>')}})()")
  if (!realWorkspace && !externalUrl || detail.present) {
    check('citations are collapsed by default', detail.present && detail.semantic && detail.open === false && detail.count > 0 && !detail.raw, detail, true)
    if (detail.semantic) {
      await click('.rw-cite summary')
      check('citations expand', await evaluate("document.querySelector('.rw-cite')?.open===true||document.querySelector('.rw-cite details')?.open===true"), {}, true)
      await click('.rw-cite summary')
    }
  }
  const hasSearch = await inputSearch(searchQuery)
  check('search input is available', hasSearch, {}, true)
  if (hasSearch) {
    const search = await snapshot('search-match')
    const matches = search.treeRows.filter(row => row.title === pageLabel || row.text.includes(pageLabel))
    check('search finds selected title', matches.length > 0, { query: searchQuery, rows: search.treeRows }, true)
    if (!realWorkspace && !externalUrl) {
      await inputSearch('调度')
      const deep = await snapshot('search-deep-page')
      check('search expands a deeply nested result', deep.treeRows.some(row => row.title === '调度策略'), { rows: deep.treeRows }, true)
      const toggle = '.rw-tree button[aria-expanded="true"]'
      const before = await evaluate("document.querySelectorAll('.rw-tree .rw-pageBtn').length")
      if (await click(toggle)) {
        const after = await evaluate("document.querySelectorAll('.rw-tree .rw-pageBtn').length")
        check('search results can be manually collapsed', after < before, { before, after }, true)
      } else check('search results can be manually collapsed', false, {}, true)
    }
    await inputSearch('no-such-page-ui-verification-9f23')
    const empty = await snapshot('search-empty')
    check('search has an empty result state', empty.treeRows.length === 0, { rows: empty.treeRows }, true)
    await inputSearch('')
    await openDirectories()
    check('clearing search restores tree', (await snapshot('search-cleared')).treeRows.length >= initial.treeRows.length, {}, true)
  }
  if (!realWorkspace && !externalUrl) {
    const collapseSelector = '.rw-tree button[aria-expanded="true"]'
    const toggles = await evaluate(`document.querySelectorAll(${JSON.stringify(collapseSelector)}).length`)
    check('directory has an accessible toggle', toggles > 0, { toggles }, true)
    if (toggles > 0) {
      const before = await evaluate("document.querySelectorAll('.rw-pageBtn').length")
      await click(collapseSelector)
      const after = await evaluate("document.querySelectorAll('.rw-pageBtn').length")
      check('directory collapses and restores', after < before, { before, after }, true)
      await openDirectories()
    }
    const home = await click('.rw-pageBtn', '核心架构')
    check('optional chapter home is reachable', home, {}, true)
    if (home) {
      await waitFor("document.querySelector('.rw-content')?.innerText.includes('这是一个可选的章节首页')", '章节首页未显示')
      const count = await evaluate("[...document.querySelectorAll('.rw-tree .rw-pageBtn')].filter(el=>el.title==='核心架构').length")
      check('chapter home is not duplicated', count === 1, { count }, true)
      await click('.rw-pageBtn', pageLabel)
      await waitFor(`document.querySelector('.rw-content')?.innerText.includes(${JSON.stringify(expected)})`, '切回正文失败')
    }
  }
  await verifyInPageNavigation()
  await evaluate("document.querySelector('.rw-tree .rw-pageBtn')?.focus()")
  await key('Tab', 'Tab', 9)
  const desktopFocus = await focusState()
  report.desktopFocus = desktopFocus
  check('desktop keyboard focus is visible', desktopFocus.visible && !desktopFocus.body && desktopFocus.outlineStyle !== 'none' && Number.parseFloat(desktopFocus.outlineWidth) > 0, desktopFocus, true)
  await prepareCaptureTree()
  await evaluate("document.querySelector('.rw-content').scrollTop=0;document.querySelector('.rw-tree').scrollTop=0;const scroll=document.querySelector('.rw-treeScroll');if(scroll)scroll.scrollTop=0")
  for (const theme of ['light', 'dark']) await capture(`desktop-${theme}`, 1440, 1000, theme)
  for (const theme of ['light', 'dark']) await capture(`narrow-${theme}`, Number(env.REPOWIKI_UI_NARROW_WIDTH || 390), 844, theme)
  await verifyDrawer()
  if (!realWorkspace && !externalUrl) {
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await verifyCacheIsolationAndRefresh()
  }
}

async function verifyCacheIsolationAndRefresh() {
  const aMarker = '浏览器验证正文哨兵'
  const bMarker = '另一工作区同名页隔离哨兵'
  const visibleMarkdown = marker => `document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(marker)})`
  const switchTo = async workspaceId => evaluate(`(()=>{const select=document.querySelector('.rw-workspace select');if(!select)return false;select.value=${JSON.stringify(workspaceId)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await openDirectories()
  await click('.rw-pageBtn', '事件总线')
  await waitFor(visibleMarkdown(aMarker), 'A 工作区原正文未显示')
  const switcher = await switchTo('b')
  check('workspace selector exists', switcher)
  if (!switcher) return
  await waitFor("[...document.querySelectorAll('.rw-pageBtn')].some(el=>el.title==='另一工作区')", 'B 工作区目录未更新')
  check('workspace change refreshes the tree', true)
  await openDirectories()
  await click('.rw-pageBtn', '事件总线')
  await waitFor(visibleMarkdown(bMarker), '同路径的 B 正文未显示')
  const inB = await evaluate(`({workspace:document.querySelector('.rw-workspace select').value,body:document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(bMarker)}),leaked:document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(aMarker)})})`)
  check('same-path cached page belongs to workspace B', inB.workspace === 'b' && inB.body && !inB.leaked, inB)
  await switchTo('a')
  await waitFor("[...document.querySelectorAll('.rw-pageBtn')].some(el=>el.title==='项目概述')", '切回 A 的目录未更新')
  await openDirectories()
  await click('.rw-pageBtn', '事件总线')
  await waitFor(visibleMarkdown(aMarker), '切回 A 后正文仍是 B')
  const inA = await evaluate(`({workspace:document.querySelector('.rw-workspace select').value,body:document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(aMarker)}),leaked:document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(bMarker)})})`)
  check('A to B to A restores the correct cached page', inA.workspace === 'a' && inA.body && !inA.leaked, inA)
  // 仅修改 mkdtemp 创建的合成页面，真实 Wiki 与外部服务均不走此分支。
  assert.ok(fixture && path.dirname(fixture) === testDir && path.basename(fixture).startsWith('.browser-ui-fixture-'))
  const pageFile = path.join(fixture, 'ui-demo/.qoder/repowiki/zh/content/核心架构/事件总线.md')
  const original = await readFile(pageFile, 'utf8')
  const second = '缓存内容修改版本二哨兵'
  await writeFile(pageFile, `${original}\n\n${second}。\n`, 'utf8')
  await click('.rw-pageBtn', '快速开始')
  await waitFor("document.querySelector('.rw-title')?.textContent.trim()==='快速开始'", '切换到其他页面失败')
  await click('.rw-pageBtn', '事件总线')
  await waitFor(visibleMarkdown(second), '重选后没有加载修改后的正文')
  check('selecting a changed page replaces its stale cached body', await evaluate(visibleMarkdown(second)))
  await evaluate("document.querySelector('.rw-content').scrollTop=300")
  await click('.rw-pageBtn', '事件总线')
  await pause(220)
  const samePageScroll = await evaluate("document.querySelector('.rw-content').scrollTop")
  check('revalidating the same page preserves the reading position', samePageScroll >= 280, { scrollTop: samePageScroll })
  const third = '强制刷新版本三正文哨兵'
  await writeFile(pageFile, `${original}\n\n${third}。\n`, 'utf8')
  const requestStart = report.apiRequests.length
  const refreshClicked = await click('.rw-tree button[title="刷新"],.rw-tree button[aria-label="刷新"],.rw-tree button[title="Refresh"],.rw-tree button[aria-label="Refresh"]')
  check('force refresh control is reachable', refreshClicked, {}, true)
  if (refreshClicked) {
    await waitFor("document.querySelector('.rw-title')&&document.querySelector('.rw-tree .rw-pageBtn')&&!document.querySelector('.rw-tree .rw-loading')", '强制刷新后正文未恢复')
    await openDirectories()
    await click('.rw-pageBtn', '事件总线')
    await waitFor(visibleMarkdown(third), '强制刷新后仍保留旧正文')
    const requests = report.apiRequests.slice(requestStart)
    check('refresh requests bypass the Wiki metadata cache', requests.some(row => row.path.endsWith('/wiki') && row.refresh === '1'), { requests })
    const current = await evaluate(`({third:${visibleMarkdown(third)},stale:${visibleMarkdown(second)}})`)
    check('force refresh displays updated content without stale cached body', current.third && !current.stale, current)
  }
  if (phase !== 'baseline') await verifyDelayedPrefetch(pageFile, original)
}

async function verifyDelayedPrefetch(pageFile, original) {
  const heldPath = '核心架构/事件总线'
  fixtureHold = { path: heldPath, file: pageFile, captured: false, sent: false }
  fixtureHold.readyToRelease = new Promise(resolve => { fixtureHold.release = resolve })
  // 第一笔目标请求忽略 abort，用更苛刻的“旧请求仍完成”验证缓存不会被倒写。
  await evaluate(`(()=>{const original=window.fetch;window.__rwRestoreRaceFetch=()=>{window.fetch=original};let pending=true;window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(pending&&url.pathname.endsWith('/api/page')&&url.searchParams.get('path')===${JSON.stringify(heldPath)}){pending=false;return original(input,{...options,signal:undefined})}return original(input,options)}})()`)
  try {
    await click('.rw-tree button[title="刷新"],.rw-tree button[aria-label="刷新"]')
    await waitFor("document.querySelector('.rw-title')?.textContent.trim()==='项目概述'", 'race 刷新后首篇未出现')
    await openDirectories()
    await click('.rw-pageBtn', '核心架构')
    await waitFor("document.querySelector('.rw-markdown')?.textContent.includes('这是一个可选的章节首页')", 'race 前置页未出现')
    for (let attempt = 0; !fixtureHold.captured && attempt < 60; attempt++) await pause(100)
    check('the previous adjacent-page preload is held after reading old content', fixtureHold.captured, { path: heldPath, captured: fixtureHold.captured })
    if (!fixtureHold.captured) return
    const marker = '点击重验击败延迟旧预读正文哨兵'
    await writeFile(pageFile, `${original}\n\n${marker}。\n`, 'utf8')
    await click('.rw-pageBtn', '事件总线')
    await waitFor(`document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(marker)})`, '点击 B 没有展示更新后的内容')
    fixtureHold.release()
    for (let attempt = 0; !fixtureHold.sent && attempt < 30; attempt++) await pause(30)
    await pause(180)
    const stayedFresh = await evaluate(`document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(marker)})`)
    const oldResponseSent = fixtureHold.sent
    await click('.rw-pageBtn', '快速开始')
    await waitFor("document.querySelector('.rw-title')?.textContent.trim()==='快速开始'", 'race 后离开目标页失败')
    // 暂停下一次重验，确保此时看到的是缓存本身，不能被快到的网络响应掩盖旧缓存闪现。
    fixtureHold = { path: heldPath, file: pageFile, captured: false, sent: false }
    fixtureHold.readyToRelease = new Promise(resolve => { fixtureHold.release = resolve })
    await click('.rw-pageBtn', '事件总线')
    for (let attempt = 0; !fixtureHold.captured && attempt < 30; attempt++) await pause(30)
    await waitFor(`document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(marker)})`, '旧预读污染了后续选择的正文缓存', 3000)
    check('newly clicked content survives completion of the old prefetch', stayedFresh, { oldResponseSent, currentContentIsFresh: stayedFresh })
    check('late preload cannot poison later cached page selections', fixtureHold.captured && await evaluate(`document.querySelector('.rw-markdown')?.textContent.includes(${JSON.stringify(marker)})`), { nextRevalidationIsHeld: fixtureHold.captured })
  } finally {
    fixtureHold.release()
    await evaluate('window.__rwRestoreRaceFetch?.();delete window.__rwRestoreRaceFetch')
  }
}

// 性能探针复用同一宿主、只读服务和资源所有权；默认 CLI 行为保持不变。
export async function runBrowserUi({ beforeNavigate, verify: verifyOverride } = {}) {
try {
  await mkdir(artifactDir, { recursive: true })
  // 先确认已有浏览器/端口；失败即说明限制，不关闭或启动任何用户浏览器。
  const versionResponse = await localFetch(`${cdp}/json/version`)
  assert.ok(versionResponse.ok, `CDP 不可用 HTTP ${versionResponse.status}；请启动可用 CDP 或设置 REPOWIKI_CDP_URL`)
  const version = await versionResponse.json()
  beforeTargets = (await (await localFetch(`${cdp}/json/list`)).json()).map(item => item.id)
  report.host.browser = version.Browser
  let url = externalUrl
  if (!url) {
    const host = await discoverHost()
    report.host.browser = version.Browser
    url = await createServer(host)
  }
  report.url = url
  console.log(`UI ${phase}: ${url}; ${version.Browser}; source=${report.source}`)
  await connect(url, beforeNavigate)
  if (verifyOverride) await verifyOverride({ evaluate, rpc, report, artifactDir, check, capture, waitFor, pause, click, key, inputSearch, openDirectories })
  else await verify()
} catch (error) {
  report.fatal = error.stack || String(error)
  console.error(`FAIL: ${report.fatal}`)
  if (rpc && !interrupted) {
    try {
      const image = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
      const file = path.join(artifactDir, 'failure.png')
      await writeFile(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file)
    } catch {}
  }
} finally {
  fixtureHold?.release?.()
  // 关闭范围只包含本次返回的新 target ID 和本脚本 server；绝不 Browser.close。
  if (target?.id && !beforeTargets.includes(target.id)) {
    try {
      const response = await fetch(`${cdp}/json/close/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(5000) })
      report.cleanup.ownedTabClosed = response.ok
    } catch (error) { report.cleanup.ownedTabCloseError = error.message }
  }
  socket?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.cleanup.ownedServerClosed = true }
  for (const dispose of routeDisposers.reverse()) { try { dispose() } catch {} }
  if (asarHandle) await asarHandle.close()
  if (fixture && path.dirname(fixture) === testDir && path.basename(fixture).startsWith('.browser-ui-fixture-')) {
    await rm(fixture, { recursive: true, force: true }); report.cleanup.fixtureRemoved = true
  }
  for (const [name, handler] of handlers) process.removeListener(name, handler)
  try {
    // CDP close 的响应可能早于 target 从列表删除；只重读列表，绝不重复关闭或碰旧 tab。
    const started = Date.now()
    for (let attempt = 0; attempt < 24; attempt++) {
      const afterTargets = (await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(5000) })).json()).map(item => item.id)
      report.cleanup.preexistingTabsPreserved = beforeTargets.every(id => afterTargets.includes(id))
      report.cleanup.ownedTabAbsent = target?.id ? !afterTargets.includes(target.id) : true
      report.cleanup.tabAuditAttempts = attempt + 1
      if (report.cleanup.ownedTabAbsent) break
      await new Promise(resolve => setTimeout(resolve, 70))
    }
    report.cleanup.tabCloseWaitMs = Date.now() - started
  } catch (error) { report.cleanup.tabAuditError = error.message }
  if (target?.id) check('owned tab is closed', report.cleanup.ownedTabClosed === true && report.cleanup.ownedTabAbsent === true, report.cleanup)
  if (server) check('owned server is closed', report.cleanup.ownedServerClosed === true, report.cleanup)
  if (fixture) check('temporary fixture is removed', report.cleanup.fixtureRemoved === true, report.cleanup)
  if (beforeTargets.length) check('preexisting browser tabs are preserved', report.cleanup.preexistingTabsPreserved === true, report.cleanup)
  check('no browser console errors', report.consoleErrors.length === 0 && report.exceptions.length === 0, { consoleErrors: report.consoleErrors, exceptions: report.exceptions })
  check('no resource failures', report.networkFailures.length === 0 && report.serverErrors.length === 0, { networkFailures: report.networkFailures, serverErrors: report.serverErrors })
  report.finishedAt = new Date().toISOString()
  report.passed = !interrupted && !report.fatal && !report.checks.some(item => item.status === 'fail')
  await mkdir(artifactDir, { recursive: true })
  const reportFile = path.join(artifactDir, 'report.json')
  await writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8')
  console.log(`REPORT: ${reportFile}`)
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${phase}; screenshots=${report.screenshots.length}; checks=${report.checks.length}; cleanup=${JSON.stringify(report.cleanup)}`)
  if (!report.passed) process.exitCode = 1
}
return report
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await runBrowserUi()
