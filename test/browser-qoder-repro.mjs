// 诊断专用：使用真实宿主 React/MarkdownText、插件浏览器端及后端路由。
// 默认页面取自本仓库 README，附加 Qoder 风格的 cite 和 mermaid；不是截图中的真实 Wiki。
// 环境变量 REPOWIKI_INPUT_PAGE 可指定真实 Wiki 页面，REPOWIKI_EXPECT 指定正文哨兵。
// REPOWIKI_CLIENT 可指定安装版，REPOWIKI_BAD_TITLE=1 注入错误索引 title 作为负控。
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { apply as applyBackend, Config } from '../lib/index.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const base = process.env.REPOWIKI_GUI_URL || 'http://127.0.0.1:53845'
const cdp = process.env.REPOWIKI_CDP_URL || 'http://127.0.0.1:9222'
const asset = process.env.REPOWIKI_HOST_ASSET || '/assets/index-BgUyXZcc.js'
const client = process.env.REPOWIKI_CLIENT || path.join(testDir, '..', 'lib', 'client.js')
const expected = process.env.REPOWIKI_EXPECT || 'Qoder 风格的'
const requests = []
const exceptions = []
let fixture, target, ws, server
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  const plugin = await readFile(client, 'utf8')
  const input = await readFile(process.env.REPOWIKI_INPUT_PAGE || path.join(testDir, '..', 'README.md'), 'utf8')
  const markdown = process.env.REPOWIKI_INPUT_PAGE ? input : `<cite>\n[client.js](file://lib/client.js)\n</cite>\n\n${input}\n\n\`\`\`mermaid\ngraph LR\n  A[目录] --> B[页面]\n\`\`\`\n`
  assert.ok(markdown.includes(expected), '页面不包含预期哨兵；请设置 REPOWIKI_EXPECT')
  fixture = await mkdtemp(path.join(testDir, '.qoder-repro-'))
  const workspaces = ['a', 'b'].map(name => path.join(fixture, name))
  for (const [i, root] of workspaces.entries()) {
    if (i === 0 && process.env.REPOWIKI_A_EMPTY) continue
    const wiki = path.join(root, '.qoder', 'repowiki')
    const content = path.join(wiki, 'zh', 'content')
    const meta = path.join(wiki, 'zh', 'meta')
    await mkdir(content, { recursive: true })
    await mkdir(meta, { recursive: true })
    const label = i === 0 ? '目录页' : '另一目录页'
    await writeFile(path.join(content, `${label}.md`), markdown, 'utf8')
    await writeFile(path.join(meta, 'repowiki-metadata.json'), JSON.stringify({wiki_repo:{gmt_modified:'2026-01-01'},wiki_catalogs:[],wiki_items:[]}), 'utf8')
    const title = process.env.REPOWIKI_BAD_TITLE ? { unexpected: 'object' } : label
    await writeFile(path.join(wiki, '.repowiki-index.json'), JSON.stringify({pages:{[label]:{title,updatedAt:'2026-01-01',size:Buffer.byteLength(markdown)}}}), 'utf8')
  }
  const response = await fetch(new URL(asset, base))
  assert.ok(response.ok, `宿主资源 HTTP ${response.status}`)
  let host = await response.text()
  const factory = host.match(/function ([\w$]+)\(\)\{return\{react:[^,]+,"react\/jsx-runtime":/)
  const offset = host.lastIndexOf(';try{const e=document.getElementById("root")')
  assert.ok(factory && offset >= 0, '宿主模块表或启动入口无法识别')
  host = host.slice(0, offset) + `;globalThis.__rwHostModules=${factory[1]}();`
  host = host.replace(/from"\.\/(vendor-[^"]+\.js)"/, 'from"/assets/$1"')
  const html = `<!doctype html><meta charset="utf-8"><div id="root" style="width:1000px;height:600px"></div>
<script>window.__ModuleLoader__={load({factory}){window.__rwPlugin=factory(name=>{if(!(name in window.__rwHostModules))throw new Error('missing host module '+name);return window.__rwHostModules[name]})}}</script>
<script type="module">
import '/host.js'; await import('/plugin.js');
const React=window.__rwHostModules.react;
function store(value){let data=value;const listeners=new Set();return {getSnapshot:()=>data,subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),set:v=>{data=v;for(const f of listeners)f()}}}
const workspaces=store({items:[{workspaceId:'a',path:${JSON.stringify(workspaces[0])},sessionIds:['sa']},{workspaceId:'b',path:${JSON.stringify(workspaces[1])},sessionIds:['sb']}],recentWorkspaceId:'a'});
const sessions=store({byId:{sa:{id:'sa',retainedBy:{mainView:1},updatedAt:2},sb:{id:'sb',retainedBy:{mainView:0},updatedAt:1}}});
window.__rwSwitch=()=>sessions.set({byId:{sa:{id:'sa',retainedBy:{mainView:0},updatedAt:2},sb:{id:'sb',retainedBy:{mainView:1},updatedAt:3}}});
const t=key=>key;
let mainPage;
const ctx={workspaces:{list:workspaces},sessions:{list:sessions},locale:{bind:()=>t,register:()=>{}},effect:f=>f(),slots:{inject:(_name,f)=>f(),register:(options,component)=>{if(options.name==='main')mainPage=component;return ()=>{}}}};
window.__rwPlugin.apply(ctx);
if(!mainPage)throw new Error('未注册主页面');
const hook=(s,select)=>select(React.useSyncExternalStore(s.subscribe,s.getSnapshot));
const props={t,...(${process.env.REPOWIKI_NO_HOOKS ? 'false' : 'true'}?{useWorkspaces:select=>hook(workspaces,select),useSessions:select=>hook(sessions,select)}:{})};
window.__rwHostModules['react-dom/client'].createRoot(document.getElementById('root')).render(React.createElement(mainPage,props));
</script>`
  const routes = new Map()
  const registry = { get(id) { const i = ['a','b'].indexOf(id); return i < 0 ? null : {path:workspaces[i]} }, list() { return workspaces.map(p => ({path:p})) } }
  const ctx = { fs:{}, tools:{register(){}}, get(name){return name === 'workspaceRegistry' ? registry : undefined}, effect(f){f()}, inject(_names,callback){callback({webServer:{register(route){routes.set(route.path,route);return ()=>routes.delete(route.path)}},effect(f){f()}})} }
  const config = Config({}); config.defaultWorkspace = workspaces[0]
  applyBackend(ctx, config)
  server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'); requests.push(url.pathname + url.search)
      res.setHeader('Connection','close')
      if (url.pathname === '/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(html) }
      if (url.pathname === '/host.js') { res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'}); return res.end(host) }
      if (url.pathname === '/plugin.js') { res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'}); return res.end(plugin) }
      if (routes.has(url.pathname)) return await routes.get(url.pathname).handler(req,res)
      if (url.pathname.startsWith('/assets/')) { const upstream=await fetch(new URL(url.pathname,base)); res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type') || 'text/javascript'}); return res.end(Buffer.from(await upstream.arrayBuffer())) }
      res.writeHead(404); res.end('not found')
    } catch(error) { if(!res.headersSent)res.writeHead(500); res.end(String(error)) }
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const create = await fetch(`${cdp}/json/new?about:blank`,{method:'PUT'}); assert.ok(create.ok,`CDP HTTP ${create.status}`); target=await create.json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  let id=0; const pending=new Map()
  ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')exceptions.push(m.params.args.map(a=>a.description ?? a.value ?? '').join(' '));if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error(`CDP 超时: ${method}`))},5000);pending.set(n,m=>{clearTimeout(timer);m.error?reject(new Error(m.error.message)):resolve(m.result)});ws.send(JSON.stringify({id:n,method,params}))})
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);return r.result.value}
  await call('Runtime.enable'); await call('Page.enable'); await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`})
  if (process.env.REPOWIKI_A_EMPTY) {
    let empty = false
    for(let i=0;i<80;i++){empty=await evaluate("document.querySelector('.rw-centerTitle')?.textContent==='noWikiTitle'");if(empty)break;await delay(50)}
    assert.ok(empty,'缺少工作区 A 的空状态')
    const changed=await evaluate("(()=>{const s=document.querySelector('.rw-workspace select');if(!s)return false;s.value='b';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
    assert.ok(changed,'空状态缺少工作区选择器')
  }
  const pageLabel = process.env.REPOWIKI_A_EMPTY ? '另一目录页' : '目录页'
  let button
  for(let i=0;i<80;i++){button=await evaluate(`(()=>{const b=[...document.querySelectorAll('.rw-pageBtn')].find(x=>x.title===${JSON.stringify(pageLabel)});if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(button)break;await delay(50)}
  assert.ok(button,`点击前目录未出现；异常：${JSON.stringify(exceptions)}`)
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...button}); await call('Input.dispatchMouseEvent',{type:'mousePressed',...button,button:'left',clickCount:1}); await call('Input.dispatchMouseEvent',{type:'mouseReleased',...button,button:'left',clickCount:1})
  let state
  for(let i=0;i<80;i++){state=await evaluate(`(()=>{const root=document.querySelector('.rw-root'),tree=document.querySelector('.rw-tree'),content=document.querySelector('.rw-content');const text=content?.innerText??'';const r=content?.getBoundingClientRect();return {root:!!root,tree:!!tree,text,visible:!!r&&r.width>0&&r.height>0&&text.includes(${JSON.stringify(expected)})}})()`);if(state.visible||(!state.root&&exceptions.length))break;await delay(50)}
  console.log('客户端:', client)
  console.log('页面来源:', process.env.REPOWIKI_INPUT_PAGE || '本仓库 README.md + 合成 cite/mermaid')
  console.log('点击后:', JSON.stringify({...state,text:state.text.slice(0,400)}))
  console.log('浏览器异常:', JSON.stringify(exceptions))
  console.log('Wiki 请求:', JSON.stringify(requests.filter(s=>s.includes('/api/'))))
  assert.ok(requests.some(s=>s.includes('/api/page')), '点击未触发页面 API')
  assert.ok(state.root && state.tree && state.visible, '点击后主区域或正文不可见')
  assert.deepEqual(exceptions, [], '页面出现浏览器异常')
  if(process.env.REPOWIKI_SWITCH){
    await evaluate('window.__rwSwitch()')
    let switched=false
    for(let i=0;i<80;i++){switched=await evaluate(`!![...document.querySelectorAll('.rw-pageBtn')].find(x=>x.title==='另一目录页')`);if(switched)break;await delay(50)}
    console.log('切换工作区后目录更新:',switched)
    console.log('切换后的 Wiki 请求:',JSON.stringify(requests.filter(s=>s.includes('/api/'))))
    assert.ok(switched,'切换工作区后目录未更新')
  }
  console.log('PASS: 点击后目录和正文可见')
} catch(error) {
  console.error('FAIL:',error.stack || String(error)); process.exitCode=1
} finally {
  if(ws)ws.close()
  if(target?.id)await fetch(`${cdp}/json/close/${target.id}`).catch(()=>{})
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  if(fixture && path.dirname(fixture)===testDir && path.basename(fixture).startsWith('.qoder-repro-'))await rm(fixture,{recursive:true,force:true})
}
