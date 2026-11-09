// 轻量浏览器复现：插件真实前后端、宿主 React/MarkdownText 和真实 DOM 点击。
// 使用临时 Wiki 及宿主服务替身；宿主应用及工作区上下文未参与。Node.js 22.19+。
// REPOWIKI_WORKSPACE、REPOWIKI_PAGE_LABEL、REPOWIKI_EXPECT 可指定现有 Wiki 页面。
// REPOWIKI_EMPTY_PAGE=1 仅用于临时夹具的负对照；REPOWIKI_HOST_ASSET 可覆盖宿主资源路径。
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { apply as applyBackend, Config } from '../lib/index.js'

const webBase = process.env.REPOWIKI_GUI_URL || 'http://127.0.0.1:53845'
const cdpBase = process.env.REPOWIKI_CDP_URL || 'http://127.0.0.1:9222'
const asset = process.env.REPOWIKI_HOST_ASSET || '/assets/index-BgUyXZcc.js'
const expected = process.env.REPOWIKI_EXPECT || 'Wiki 页面正文可见哨兵'
const pageLabel = process.env.REPOWIKI_PAGE_LABEL || '目录页'
const workspace = process.env.REPOWIKI_WORKSPACE
const requests = []
const errors = []
const plugin = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const assetResponse = await fetch(new URL(asset, webBase))
if (!assetResponse.ok) throw new Error(`宿主资源返回 HTTP ${assetResponse.status}: ${asset}`)
let host = await assetResponse.text()
const hostFactory = host.match(/function ([\w$]+)\(\)\{return\{react:[^,]+,"react\/jsx-runtime":/)
const bootMarker = ';try{const e=document.getElementById("root")'
const bootOffset = host.lastIndexOf(bootMarker)
if (!hostFactory || bootOffset < 0) throw new Error('未识别宿主模块表或启动入口；请为当前宿主更新资源路径')
host = host.slice(0, bootOffset) + `;globalThis.__rwHostModules=${hostFactory[1]}();`
host = host.replace(/from"\.\/(vendor-[^"]+\.js)"/, 'from"/assets/$1"')

const html = `<!doctype html><meta charset="utf-8"><div id="root" style="width:1000px;height:600px"></div>
<script>window.__ModuleLoader__={load({factory}){window.__rwPlugin=factory((name)=>{if(!(name in window.__rwHostModules))throw new Error('missing host module '+name);return window.__rwHostModules[name]})}}</script>
<script type="module">
import '/host.js';
await import('/plugin.js');
const React=window.__rwHostModules.react;
window.__rwHostModules['react-dom/client'].createRoot(document.getElementById('root')).render(React.createElement(window.__rwPlugin.RepowikiPage,{t:(key)=>key}));
</script>`
const routes = new Map()
let fixture
let target
let ws
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    requests.push(url.pathname)
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html) }
    if (url.pathname === '/host.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(host) }
    if (url.pathname === '/plugin.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(plugin) }
    if (routes.has(url.pathname)) return await routes.get(url.pathname).handler(req, res)
    if (url.pathname.startsWith('/assets/')) {
      const response = await fetch(new URL(url.pathname, webBase))
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'text/javascript; charset=utf-8' })
      return res.end(Buffer.from(await response.arrayBuffer()))
    }
    res.writeHead(404); res.end('not found')
  } catch (error) { res.writeHead(500); res.end(String(error.message)) }
})

try {
  const testDir = fileURLToPath(new URL('.', import.meta.url))
  if (!workspace) {
    fixture = await mkdtemp(path.join(testDir, '.rw-fixture-'))
    const content = path.join(fixture, '.qoder', 'repowiki', 'zh', 'content')
    await mkdir(content, { recursive: true })
    await writeFile(path.join(content, '目录页.md'), `# 目录页\n\n<cite>\n[client.js](file://lib/client.js)\n</cite>\n\n${process.env.REPOWIKI_EMPTY_PAGE ? '' : expected}\n\n\`\`\`js\nconst example = 1\n\`\`\`\n`, 'utf8')
  }
  const config = Config({})
  config.defaultWorkspace = workspace || fixture
  const ctx = {
    fs: {},
    tools: { register() {} },
    get() { return undefined },
    effect(callback) { callback() },
    inject(_names, callback) {
      callback({
        webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
        effect(callback) { callback() },
      })
    },
  }
  applyBackend(ctx, config)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`
  const created = await fetch(`${cdpBase}/json/new?${encodeURIComponent(fixtureUrl)}`, { method: 'PUT' })
  if (!created.ok) throw new Error(`创建浏览器页失败: HTTP ${created.status}`)
  target = await created.json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) }, 5000)
    pending.set(id, (message) => { clearTimeout(timeout); message.error ? reject(new Error(message.error.message)) : resolve(message.result) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  await call('Runtime.enable')
  let button
  for (let i = 0; i < 100; i++) {
    button = await evaluate(`(()=>{const b=[...document.querySelectorAll('.rw-pageBtn')].find(x=>x.title===${JSON.stringify(pageLabel)});if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,text:b.innerText}})()`)
    if (button) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(button, `目录按钮未出现；浏览器异常: ${JSON.stringify(errors)}；请求: ${requests.join(', ')}`)
  console.log(`目录按钮可见: ${button.text}`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y })
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y, button: 'left', clickCount: 1 })
  let snapshot
  for (let i = 0; i < 100; i++) {
    snapshot = await evaluate(`(()=>{
      const content=document.querySelector('.rw-content');
      if(!content)return {text:'',visible:false};
      const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);
      let node; while((node=walker.nextNode()))if(node.nodeValue.includes(${JSON.stringify(expected)})&&!node.parentElement.closest('.rw-header,.rw-cite,.rw-statusLine,.rw-center'))break;
      if(!node)return {text:content.innerText,visible:false};
      const range=document.createRange();range.selectNodeContents(node);
      const rect=range.getBoundingClientRect();const box=content.getBoundingClientRect();
      let shown=true;for(let el=node.parentElement;el;el=el.parentElement){const s=getComputedStyle(el);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)shown=false}
      const left=Math.max(rect.left,box.left,0),top=Math.max(rect.top,box.top,0),right=Math.min(rect.right,box.right,innerWidth),bottom=Math.min(rect.bottom,box.bottom,innerHeight);
      const hit=right>left&&bottom>top?document.elementFromPoint((left+right)/2,(top+bottom)/2):null;
      return {text:content.innerText,visible:shown&&!!hit&&node.parentElement.contains(hit),rect:{width:rect.width,height:rect.height}};
    })()`)
    if (snapshot.visible) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const pageHits = requests.filter((path) => path.endsWith('/api/page')).length
  console.log(`页面 API 请求数: ${pageHits}`)
  console.log(`正文区域文字: ${JSON.stringify(snapshot.text.slice(0, 600))}`)
  console.log(`正文哨兵可见: ${snapshot.visible}`)
  console.log(`浏览器异常: ${JSON.stringify(errors)}`)
  assert.ok(pageHits > 0, '点击未触发页面 API 请求')
  assert.ok(snapshot.visible, `点击后正文没有可见的“${expected}”`)
  assert.equal(errors.length, 0, '页面渲染产生浏览器异常')
  const sourceCount = await evaluate("document.querySelectorAll('.rw-citeList li').length")
  assert.ok(sourceCount > 0, '标题后的引用块未被识别')
  assert.ok(!snapshot.text.includes('<cite>'), '正文中出现了原始引用标记')
  console.log(`来源文件数: ${sourceCount}`)
  console.log('PASS: 点击目录后显示页面正文和来源')
} catch (error) {
  console.error('FAIL: ' + error.message)
  process.exitCode = 1
} finally {
  if (ws) ws.close()
  if (target?.id) await fetch(`${cdpBase}/json/close/${target.id}`).catch(() => {})
  await new Promise((resolve) => server.close(resolve))
  if (fixture && path.dirname(fixture) === fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '')) {
    await rm(fixture, { recursive: true, force: true })
  }
}
