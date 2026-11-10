import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { apply, Config } from '../lib/index.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const apiBase = '/plugins/dsh-plugin-repowiki/api'
const firstPath = '概述/概述'

// 使用正式注册的 handler 和本机 HTTP 边界，不调用内部构树或读取函数。
async function createWiki(t, { registry, markdown = '# 概述\n\n首篇正文。\n' } = {}) {
  const fixtureRoot = path.join(projectRoot, '.research', 'fixtures')
  await fs.mkdir(fixtureRoot, { recursive: true })
  const cwd = await fs.mkdtemp(path.join(fixtureRoot, 'initial-page-'))
  t.after(async () => {
    assert.equal(path.dirname(cwd), fixtureRoot)
    await fs.rm(cwd, { recursive: true, force: true })
  })
  const wikiRoot = path.join(cwd, '.qoder', 'repowiki')
  const contentRoot = path.join(wikiRoot, 'zh', 'content')
  const firstFile = path.join(contentRoot, `${firstPath}.md`)
  for (const pagePath of ['部署/部署', firstPath, '概述/开始']) {
    const filename = path.join(contentRoot, `${pagePath}.md`)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, pagePath === firstPath ? markdown : `# ${pagePath}\n`, 'utf8')
  }
  const metadataFile = path.join(wikiRoot, 'zh', 'meta', 'repowiki-metadata.json')
  await fs.mkdir(path.dirname(metadataFile), { recursive: true })
  await fs.writeFile(metadataFile, JSON.stringify({
    wiki_catalogs: [
      { id: 'deploy', name: '部署', parent_id: null, order: 12 },
      { id: 'start', name: '开始', parent_id: 'overview' },
      { id: 'overview', name: '概述', parent_id: null },
    ],
    wiki_items: [
      { id: 'deploy', catalog_id: 'deploy', title: '部署' },
      { id: 'start', catalog_id: 'start', title: '开始' },
      { id: 'overview', catalog_id: 'overview', title: '概述' },
    ],
  }), 'utf8')
  const routes = new Map()
  const disposers = []
  apply({
    fs: {}, tools: { register() {} }, get(name) { return name === 'workspaceRegistry' ? registry : undefined },
    inject(_names, callback) {
      callback({
        webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
        effect(callback) { disposers.push(callback()) },
      })
    },
  }, Config({ defaultWorkspace: cwd }))
  const server = http.createServer(async (req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (route) await route.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections() })
    for (const dispose of disposers.reverse()) dispose()
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    cwd, wikiRoot, contentRoot, firstFile, metadataFile,
    async request(endpoint = 'wiki', query = '', expectedStatus = 200) {
      const response = await fetch(`${origin}${apiBase}/${endpoint}${query}`)
      assert.equal(response.status, expectedStatus)
      return response.json()
    },
  }
}

function pagePaths(tree) {
  return tree.flatMap((node) => [...(node.page ? [node.page.path] : []), ...pagePaths(node.children ?? [])])
}

test('opt-in 目录响应内联 DFS 首篇正文，与实际 /page 响应一致', async (t) => {
  const app = await createWiki(t)
  const wiki = await app.request('wiki', '?includeFirstPage=1')
  assert.equal(wiki.state, 'ok')
  assert.equal(wiki.pageCount, 3)
  assert.equal(pagePaths(wiki.tree)[0], firstPath)
  assert.equal(wiki.initialPage?.path, firstPath)
  assert.equal(wiki.initialPage.markdown, '# 概述\n\n首篇正文。\n')
  assert.deepEqual(wiki.initialPage, await app.request('page', `?path=${encodeURIComponent(firstPath)}`))
})

test('默认与非 1 参数不读取正文，opt-in 才额外读取首篇', async (t) => {
  const app = await createWiki(t)
  const counts = { open: 0, readFile: 0 }
  const originals = new Map()
  for (const method of ['open', 'readFile']) {
    const original = fs[method]
    originals.set(method, original)
    fs[method] = function (filename, ...args) {
      if (typeof filename === 'string' && filename.startsWith(app.contentRoot) && filename.endsWith('.md')) counts[method]++
      return original.call(this, filename, ...args)
    }
  }
  syncBuiltinESMExports()
  t.after(() => {
    for (const [method, original] of originals) fs[method] = original
    syncBuiltinESMExports()
  })
  assert.equal(Object.hasOwn(await app.request(), 'initialPage'), false)
  assert.equal(Object.hasOwn(await app.request('wiki', '?includeFirstPage=0'), 'initialPage'), false)
  assert.deepEqual(counts, { open: 0, readFile: 0 })
  assert.equal((await app.request('wiki', '?includeFirstPage=1')).initialPage.path, firstPath)
  assert.ok(counts.open + counts.readFile > 0, '正文读取计数器必须在 opt-in 时有正向读数')
})

test('首篇在构树后被删除时仍返回目录，下一次请求可看到删除', async (t) => {
  const app = await createWiki(t)
  const originalOpen = fs.open
  let removed = false
  fs.open = async function (filename, ...args) {
    if (filename === app.firstFile && !removed) {
      removed = true
      await fs.unlink(filename)
    }
    return originalOpen.call(this, filename, ...args)
  }
  syncBuiltinESMExports()
  t.after(() => { fs.open = originalOpen; syncBuiltinESMExports() })
  const wiki = await app.request('wiki', '?includeFirstPage=1')
  assert.equal(removed, true)
  assert.equal(wiki.state, 'ok')
  assert.equal(wiki.pageCount, 3)
  assert.equal(Object.hasOwn(wiki, 'initialPage'), false)
  assert.equal((await app.request()).pageCount, 2)
  assert.equal((await app.request('page', `?path=${encodeURIComponent(firstPath)}`, 404)).state, 'not-found')
})

test('首篇正文读取失败只省略 initialPage，关闭句柄后可重试', async (t) => {
  const app = await createWiki(t)
  const originalOpen = fs.open
  let injected = false
  let closed = 0
  fs.open = async function (filename, ...args) {
    const handle = await originalOpen.call(this, filename, ...args)
    if (filename === app.firstFile && !injected) {
      injected = true
      const originalClose = handle.close.bind(handle)
      handle.read = async () => { throw Object.assign(new Error('temporary body read failure'), { code: 'EIO' }) }
      handle.close = async () => { closed++; return originalClose() }
    }
    return handle
  }
  syncBuiltinESMExports()
  t.after(() => { fs.open = originalOpen; syncBuiltinESMExports() })
  const wiki = await app.request('wiki', '?includeFirstPage=1')
  assert.equal(injected, true)
  assert.equal(closed, 1)
  assert.equal(wiki.state, 'ok')
  assert.equal(wiki.pageCount, 3)
  assert.equal(Object.hasOwn(wiki, 'initialPage'), false)
  assert.equal((await app.request('wiki', '?includeFirstPage=1')).initialPage.path, firstPath)
})

test('64 KiB 按 UTF-8 字节计，超限只读上限加 1 字节且 /page 仍返回完整正文', async (t) => {
  const exactMarkdown = `${'中'.repeat(21845)}\n`
  assert.equal(Buffer.byteLength(exactMarkdown, 'utf8'), 64 * 1024)
  const app = await createWiki(t, { markdown: exactMarkdown })
  assert.equal((await app.request('wiki', '?includeFirstPage=1')).initialPage.markdown, exactMarkdown)
  const oversized = '甲'.repeat(200000)
  await fs.writeFile(app.firstFile, oversized, 'utf8')
  const originalOpen = fs.open
  let totalRead = 0
  let closed = 0
  fs.open = async function (filename, ...args) {
    const handle = await originalOpen.call(this, filename, ...args)
    if (filename === app.firstFile) {
      const originalRead = handle.read.bind(handle)
      const originalClose = handle.close.bind(handle)
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs)
        totalRead += result.bytesRead
        return result
      }
      handle.close = async () => { closed++; return originalClose() }
    }
    return handle
  }
  syncBuiltinESMExports()
  t.after(() => { fs.open = originalOpen; syncBuiltinESMExports() })
  const wiki = await app.request('wiki', '?includeFirstPage=1')
  assert.equal(wiki.state, 'ok')
  assert.equal(wiki.pageCount, 3)
  assert.equal(Object.hasOwn(wiki, 'initialPage'), false)
  assert.equal(totalRead, 64 * 1024 + 1)
  assert.equal(closed, 1)
  assert.equal((await app.request('page', `?path=${encodeURIComponent(firstPath)}`)).markdown, oversized)
})

test('metadata 损坏或 schema 错误时沿用磁盘目录，空目录省略 initialPage', async (t) => {
  for (const [label, metadata] of [
    ['invalid JSON', '{'],
    ['invalid schema', JSON.stringify({ wiki_catalogs: { bad: true }, wiki_items: null })],
  ]) {
    await t.test(label, async (t) => {
      const app = await createWiki(t)
      await fs.writeFile(app.metadataFile, metadata, 'utf8')
      const wiki = await app.request('wiki', '?includeFirstPage=1')
      assert.equal(wiki.state, 'ok')
      assert.equal(wiki.pageCount, 3)
      assert.equal(wiki.initialPage?.path, '部署/部署')
      assert.deepEqual(wiki.initialPage, await app.request('page', `?path=${encodeURIComponent('部署/部署')}`))
      await fs.rm(app.contentRoot, { recursive: true })
      const empty = await app.request('wiki', '?includeFirstPage=1')
      assert.equal(empty.state, label === 'invalid JSON' ? 'no-wiki' : 'ok')
      if (empty.state === 'ok') {
        assert.equal(empty.pageCount, 0)
        assert.deepEqual(empty.tree, [])
      }
      assert.equal(Object.hasOwn(empty, 'initialPage'), false)
    })
  }
})

test('同一浏览器 API 的工作区首篇正文相互隔离，正文修改即时可见', async (t) => {
  const workspaces = new Map()
  const registry = { get(id) { return workspaces.get(id) }, list() { return [] } }
  const first = await createWiki(t, { registry, markdown: '# 工作区甲\n' })
  const second = await createWiki(t, { markdown: '# 工作区乙\n' })
  workspaces.set('first', { path: first.cwd })
  workspaces.set('second', { path: second.cwd })
  assert.equal((await first.request('wiki', '?workspaceId=first&includeFirstPage=1')).initialPage.markdown, '# 工作区甲\n')
  assert.equal((await first.request('wiki', '?workspaceId=second&includeFirstPage=1')).initialPage.markdown, '# 工作区乙\n')
  await fs.writeFile(first.firstFile, '# 工作区甲更新\n', 'utf8')
  assert.equal((await first.request('wiki', '?workspaceId=first&includeFirstPage=1')).initialPage.markdown, '# 工作区甲更新\n')
  assert.equal((await first.request('wiki', '?workspaceId=second&includeFirstPage=1')).initialPage.markdown, '# 工作区乙\n')
})
