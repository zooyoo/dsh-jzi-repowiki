import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply, Config } from '../lib/index.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const apiBase = '/plugins/dsh-plugin-repowiki/api'

// 用严格的宿主接口替身验证插件行为；依赖包仍使用实际安装的版本。
async function createHarness(t, { web = true } = {}) {
  const fixtureRoot = path.join(projectRoot, '.research', 'fixtures')
  await fs.mkdir(fixtureRoot, { recursive: true })
  const cwd = await fs.mkdtemp(path.join(fixtureRoot, 'compat-'))
  t.after(async () => {
    assert.equal(path.dirname(cwd), fixtureRoot)
    await fs.rm(cwd, { recursive: true, force: true })
  })

  const tools = new Map()
  const observed = []
  const writes = []
  const resolutions = []
  const warnings = []
  const parentEffects = []
  const policy = { mode: 'workspace-write', workspaceRoot: cwd }
  const intent = { source: 'test-write-intent' }
  const signal = new AbortController().signal
  const exec = { signal, agent: { session: { header: { cwd } } } }
  const config = Config({})
  const targetFor = (filename) => ({ displayPath: filename })
  const stat = async (target, abortSignal) => {
    abortSignal?.throwIfAborted()
    const info = await fs.stat(target.displayPath)
    return {
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      version: `${info.mtimeMs}:${info.size}`,
    }
  }
  const ctx = {
    fs: {
      sandboxMode: 'workspace-write',
      async resolve(filename, options) {
        assert.equal(arguments.length, 2)
        assert.equal(options.signal instanceof AbortSignal, true)
        resolutions.push({ filename, ...options })
        options.signal.throwIfAborted()
        return targetFor(path.resolve(options.cwd, filename))
      },
      stat,
      async readText(target, abortSignal) {
        return fs.readFile(target.displayPath, { encoding: 'utf8', signal: abortSignal })
      },
      async writeText(target, content, writeIntent, abortSignal, writePolicy) {
        assert.equal(writeIntent, intent)
        assert.equal(writePolicy, policy)
        abortSignal.throwIfAborted()
        const exists = await fs.stat(target.displayPath).then(() => true, () => false)
        await fs.mkdir(path.dirname(target.displayPath), { recursive: true })
        await fs.writeFile(target.displayPath, content, { encoding: 'utf8', signal: abortSignal })
        writes.push(target.displayPath)
        return { operation: exists ? 'update' : 'create', ...(await stat(target, abortSignal)) }
      },
      async listDir(target, abortSignal) {
        abortSignal.throwIfAborted()
        const entries = await fs.readdir(target.displayPath, { withFileTypes: true })
        return Promise.all(entries.map(async (entry) => {
          const child = targetFor(path.join(target.displayPath, entry.name))
          return { name: entry.name, target: child, ...(await stat(child, abortSignal)) }
        }))
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    get(name) {
      if (name === 'workspaceRegistry') return ctx.workspaceRegistry
      assert.equal(name, 'sandboxPolicy')
      return { resolve({ session }) { assert.equal(session, exec.agent.session); return policy } }
    },
    emit(...args) { observed.push(args) },
    async waterfall(event, _target, actor) {
      assert.equal(event, 'fs/write-intent')
      assert.equal(actor, exec)
      return intent
    },
    effect(callback) { parentEffects.push(callback()) },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      mountCallback = callback
    },
  }

  let mountCallback
  let activeEffects = []
  let routes = new Map()
  let disposals = 0
  function unmount() {
    for (const dispose of activeEffects.splice(0).reverse()) dispose()
  }
  function mount({ failAt = Infinity } = {}) {
    assert.equal(activeEffects.length, 0)
    routes = new Map()
    let registrations = 0
    mountCallback({
      webServer: {
        register(route) {
          if (++registrations === failAt) throw new Error('route registration failed')
          assert.equal(routes.has(route.path), false)
          routes.set(route.path, route)
          return () => { disposals++; routes.delete(route.path) }
        },
      },
      effect(callback) { activeEffects.push(callback()) },
      logger: { warn(message) { warnings.push(message) } },
    })
  }
  apply(ctx, config)
  if (web) mount()
  t.after(() => { unmount(); for (const dispose of parentEffects.reverse()) dispose() })

  return {
    cwd, config, ctx, exec, tools, writes, resolutions, observed, warnings, mount, unmount,
    get routes() { return routes },
    get disposals() { return disposals },
    run(name, args = {}, execution = exec) { return tools.get(name).execute(args, execution) },
    async request(endpoint, query = '') {
      let status
      let headers
      let body
      await routes.get(`${apiBase}/${endpoint}`).handler({ url: `${apiBase}/${endpoint}${query}` }, {
        writeHead(code, values) { status = code; headers = values },
        end(value) { body = JSON.parse(value.toString('utf8')) },
      })
      return { status, headers, body }
    },
  }
}

test('初始化、扫描、写入和浏览沿用目标宿主的工具及文件接口', async (t) => {
  const app = await createHarness(t)
  assert.deepEqual([...app.tools.keys()].sort(), [
    'repowiki_init', 'repowiki_scan', 'repowiki_status',
    'repowiki_write_knowledge', 'repowiki_write_page',
  ])
  assert.equal((await app.request('wiki')).body.state, 'no-wiki')
  const initialized = await app.run('repowiki_init')
  assert.equal(initialized.adopted, false)
  assert.equal(initialized.created.length, 4)
  assert.equal((await app.run('repowiki_init')).created.length, 0)

  await fs.mkdir(path.join(app.cwd, 'src'))
  await fs.writeFile(path.join(app.cwd, 'src', 'main.js'), 'export const value = 1\n', 'utf8')
  await app.run('repowiki_scan')
  const result = await app.run('repowiki_write_page', {
    path: '核心架构/入口', title: '入口', markdown: '# 入口\n\n工作区说明。\n', sources: ['src/main.js'],
  })
  assert.equal(result.operation, 'create')
  const page = await app.request('page', `?path=${encodeURIComponent('核心架构/入口')}`)
  assert.equal(page.status, 200)
  assert.equal(page.body.title, '入口')
  assert.match(page.body.markdown, /^\s*<cite>/)
  assert.deepEqual(page.body.sources, ['src/main.js'])
  assert.equal(page.headers['Cache-Control'], 'no-store')
  assert.equal((await app.request('wiki')).body.pageCount, 2)

  const knowledge = await app.run('repowiki_write_knowledge', {
    title: '入口知识', markdown: '# 入口知识\n', scope: ['src/main.js'],
  })
  assert.equal(knowledge.files.length, 2)
  assert.match(await fs.readFile(path.join(app.cwd, '.qoder', 'repowiki', 'knowledge', 'zh', '_index.yaml'), 'utf8'), /入口知识/)
  for (const filename of knowledge.files) {
    assert.ok((await fs.readFile(path.resolve(app.cwd, filename), 'utf8')).length > 0)
  }
  await fs.writeFile(path.join(app.cwd, 'src', 'main.js'), 'export const value = 12345\n', 'utf8')
  const status = await app.run('repowiki_status')
  assert.deepEqual(status.changedSources, ['src/main.js'])
  assert.ok(status.stalePages.some((row) => row.path === '核心架构/入口'))
  assert.equal((await app.request('status')).body.pages[0].stale, true)
  assert.equal((await app.request('page', '?path=../package.json')).status, 400)
  assert.ok(app.observed.some(([event]) => event === 'fs/observed'))
  assert.ok(app.resolutions.every((row) => row.cwd === app.cwd && row.signal === app.exec.signal))
})

test('取消信号通过 resolve 的 options 传递，已取消调用不写文件', async (t) => {
  const app = await createHarness(t)
  const aborted = AbortSignal.abort(new Error('cancelled by test'))
  await assert.rejects(app.run('repowiki_init', {}, { ...app.exec, signal: aborted }), /cancelled by test/)
  assert.equal(app.writes.length, 0)
  assert.equal(app.resolutions[0].signal, aborted)
})

test('卸载 webServer 清理路由，重新注入后仍可浏览', async (t) => {
  const app = await createHarness(t)
  const firstRoutes = app.routes
  assert.equal(firstRoutes.size, 3)
  app.unmount()
  assert.equal(firstRoutes.size, 0)
  assert.equal(app.disposals, 3)
  app.mount()
  assert.equal(app.routes.size, 3)
  assert.equal((await app.request('wiki')).body.state, 'no-wiki')
  app.unmount()
  app.unmount()
  assert.equal(app.disposals, 6)
})

test('路由注册中途失败会立即回滚，销毁时不会重复撤销', async (t) => {
  const app = await createHarness(t, { web: false })
  app.mount({ failAt: 2 })
  assert.equal(app.routes.size, 0)
  assert.equal(app.disposals, 1)
  assert.match(app.warnings[0], /route registration failed/)
  app.unmount()
  assert.equal(app.disposals, 1)
  app.mount()
  assert.equal(app.routes.size, 3)
})

test('Qoder Wiki 没有私有索引时按磁盘页面统计并标明无增量基线', async (t) => {
  const app = await createHarness(t)
  const content = path.join(app.cwd, '.qoder', 'repowiki', 'zh', 'content')
  await fs.mkdir(path.join(content, '架构'), { recursive: true })
  await fs.writeFile(path.join(content, '概述.md'), '# 概述\n', 'utf8')
  await fs.writeFile(path.join(content, '架构', '入口.md'), '# 入口\n', 'utf8')
  app.config.defaultWorkspace = app.cwd
  const wiki = (await app.request('wiki')).body
  assert.equal(wiki.state, 'ok')
  assert.equal(wiki.pageCount, 2)
  assert.equal(wiki.incrementalBaseline, false)
  const status = (await app.request('status')).body
  assert.equal(status.state, 'no-index')
  assert.equal(status.incrementalBaseline, false)
  assert.match(status.reason, /baseline/i)
})

test('注册表允许冷启动识别，显式工作区不被最近工具调用覆盖', async (t) => {
  const app = await createHarness(t)
  await app.run('repowiki_init')
  app.ctx.workspaceRegistry = {
    list: () => [{ id: 'current', path: app.cwd }],
    get: (id) => id === 'current' ? { id, path: app.cwd } : undefined,
  }
  assert.equal((await app.request('wiki', '?workspaceId=current')).body.state, 'ok')
  assert.equal((await app.request('wiki', '?workspaceId=unknown')).body.state, 'no-wiki')
  assert.equal((await app.request('page', '?workspaceId=current&path=项目概述')).body.state, 'ok')
  const fresh = await createHarness(t)
  fresh.ctx.workspaceRegistry = app.ctx.workspaceRegistry
  assert.equal((await fresh.request('wiki')).body.state, 'ok')
  assert.equal((await fresh.request('wiki', '?workspaceId=current')).body.pageCount, 1)
})

test('没有可选 webServer 时仍可初始化和写入 Wiki', async (t) => {
  const app = await createHarness(t, { web: false })
  assert.equal(app.tools.size, 5)
  assert.equal((await app.run('repowiki_init')).adopted, false)
  assert.equal((await app.run('repowiki_write_page', {
    path: '项目概述', title: '项目概述', markdown: '# 项目概述\n',
  })).operation, 'update')
})
