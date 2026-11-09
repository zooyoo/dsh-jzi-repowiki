import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { apply, Config } from '../lib/index.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const apiBase = '/plugins/dsh-plugin-repowiki/api'

async function createWiki(t, { locale = 'zh', registry } = {}) {
  const fixtureRoot = path.join(projectRoot, '.research', 'fixtures')
  await fs.mkdir(fixtureRoot, { recursive: true })
  const cwd = await fs.mkdtemp(path.join(fixtureRoot, 'backend-performance-'))
  t.after(async () => {
    assert.equal(path.dirname(cwd), fixtureRoot)
    await fs.rm(cwd, { recursive: true, force: true })
  })
  const wikiRoot = path.join(cwd, '.qoder', 'repowiki')
  const contentRoot = path.join(wikiRoot, locale, 'content')
  const metadataFile = path.join(wikiRoot, locale, 'meta', 'repowiki-metadata.json')
  const indexFile = path.join(wikiRoot, '.repowiki-index.json')
  await fs.mkdir(path.join(contentRoot, '章节'), { recursive: true })
  await fs.mkdir(path.dirname(metadataFile), { recursive: true })
  await fs.writeFile(path.join(contentRoot, '章节', '章节.md'), '# 章节\n', 'utf8')
  await fs.writeFile(path.join(contentRoot, '章节', '条目.md'), '# 条目\n', 'utf8')
  await fs.writeFile(metadataFile, JSON.stringify({
    wiki_catalogs: [
      { id: 'root', name: '章节', parent_id: null },
      { id: 'item', name: '条目', parent_id: 'root' },
    ],
    wiki_items: [
      { id: 'root', catalog_id: 'root', title: '章节' },
      { id: 'item', catalog_id: 'item', title: '条目' },
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
  }, Config({ defaultWorkspace: cwd, locale }))
  t.after(() => { for (const dispose of disposers.reverse()) dispose() })
  return {
    cwd, wikiRoot, contentRoot, metadataFile, indexFile,
    async request(endpoint = 'wiki', query = '', expectedStatus = 200) {
      let status
      let body
      await routes.get(`${apiBase}/${endpoint}`).handler({ url: `${apiBase}/${endpoint}${query}` }, {
        writeHead(code) { status = code }, end(buffer) { body = JSON.parse(buffer.toString('utf8')) },
      })
      assert.equal(status, expectedStatus)
      return body
    },
  }
}

// 只计量真实文件系统边界的 I/O，不替换返回值，也不调用任何内部构树函数。
function measureIo(t, app) {
  const counts = { readFile: 0, readdir: 0, stat: 0, treeScans: 0, metadataReads: 0, indexReads: 0 }
  const originals = new Map()
  for (const method of ['readFile', 'readdir', 'stat']) {
    const original = fs[method]
    originals.set(method, original)
    fs[method] = function (filename, ...args) {
      const target = typeof filename === 'string' ? path.resolve(filename) : ''
      if (target.startsWith(app.wikiRoot)) {
        counts[method]++
        if (method === 'readdir' && target === app.contentRoot) counts.treeScans++
        if (method === 'readFile' && target === app.metadataFile) counts.metadataReads++
        if (method === 'readFile' && target === app.indexFile) counts.indexReads++
      }
      return original.call(this, filename, ...args)
    }
  }
  syncBuiltinESMExports()
  t.after(() => {
    for (const [method, original] of originals) fs[method] = original
    syncBuiltinESMExports()
  })
  return { counts, reset() { for (const key of Object.keys(counts)) counts[key] = 0 } }
}

test('Wiki 未修改时，切页和重复目录请求复用已解析目录，不重复遍历或重读 JSON', async (t) => {
  const app = await createWiki(t)
  const io = measureIo(t, app)
  assert.equal((await app.request()).pageCount, 2)
  io.reset()
  for (const pagePath of ['章节/章节', '章节/条目', '章节/章节', '章节/条目']) {
    const page = await app.request('page', `?path=${encodeURIComponent(pagePath)}`)
    assert.equal(page.path, pagePath)
    assert.match(page.markdown, /^# /)
  }
  assert.equal((await app.request()).pageCount, 2)
  assert.equal((await app.request()).pageCount, 2)
  assert.equal(io.counts.treeScans, 0, `热请求重复构树：${JSON.stringify(io.counts)}`)
  assert.equal(io.counts.readdir, 0)
  assert.equal(io.counts.indexReads, 0)
  assert.equal(io.counts.metadataReads, 0)
})

test('缓存不遮蔽正文、metadata 或私有索引的磁盘修改及索引删除', async (t) => {
  const app = await createWiki(t)
  const metadata = JSON.parse(await fs.readFile(app.metadataFile, 'utf8'))
  assert.equal((await app.request()).incrementalBaseline, false)
  const query = `?path=${encodeURIComponent('章节/条目')}`
  assert.equal((await app.request('page', query)).title, '条目')

  await fs.writeFile(path.join(app.contentRoot, '章节', '条目.md'), '# 已修改正文\n', 'utf8')
  assert.equal((await app.request('page', query)).markdown, '# 已修改正文\n')
  metadata.wiki_items[1].title = '新的正文标题'
  metadata.wiki_items[1].gmt_modified = '2026-11-10'
  await fs.writeFile(app.metadataFile, JSON.stringify(metadata), 'utf8')
  const updated = await app.request('page', query)
  assert.equal(updated.title, '新的正文标题')
  assert.equal(updated.updatedAt, '2026-11-10')
  assert.equal((await app.request()).tree[0].children[0].page.title, updated.title)
  const version = await fs.stat(app.metadataFile)
  metadata.wiki_items[1].title = '变更后的标题'
  await fs.writeFile(app.metadataFile, JSON.stringify(metadata), 'utf8')
  await fs.utimes(app.metadataFile, version.atime, new Date(version.mtimeMs + 2000))
  assert.equal((await fs.stat(app.metadataFile)).size, version.size)
  assert.equal((await app.request('page', query)).title, '变更后的标题')

  await fs.writeFile(app.indexFile, JSON.stringify({
    generatedAt: '2026-11-11',
    pages: { '章节/条目': { title: '来自私有索引', sources: ['src/app.js'], updatedAt: '2026-11-11' } },
  }), 'utf8')
  const indexed = await app.request('page', query)
  assert.equal(indexed.title, '来自私有索引')
  assert.deepEqual(indexed.sources, ['src/app.js'])
  assert.equal((await app.request()).incrementalBaseline, true)
  await fs.unlink(app.indexFile)
  assert.equal((await app.request()).incrementalBaseline, false)
  assert.equal((await app.request('page', query)).title, '变更后的标题')
})

test('已知目录版本变化使新增、嵌套新增和删除页面立即可见', async (t) => {
  const app = await createWiki(t)
  assert.equal((await app.request()).pageCount, 2)
  await fs.writeFile(path.join(app.contentRoot, '章节', '新增.md'), '# 新增\n', 'utf8')
  const added = await app.request('page', `?path=${encodeURIComponent('章节/新增')}`)
  assert.equal(added.title, '新增')
  assert.equal((await app.request()).pageCount, 3)

  await fs.mkdir(path.join(app.contentRoot, '新增目录', '嵌套'), { recursive: true })
  await fs.writeFile(path.join(app.contentRoot, '新增目录', '嵌套', '新页.md'), '# 嵌套新页\n', 'utf8')
  assert.equal((await app.request()).pageCount, 4)
  await fs.unlink(path.join(app.contentRoot, '章节', '条目.md'))
  assert.equal((await app.request()).pageCount, 3)
  assert.equal((await app.request('page', `?path=${encodeURIComponent('章节/条目')}`, 404)).state, 'not-found')
  await fs.rm(path.join(app.contentRoot, '新增目录'), { recursive: true })
  assert.equal((await app.request()).pageCount, 2)
})

test('refresh=1 即使版本未变化也重读 metadata 并重建快照', async (t) => {
  const app = await createWiki(t)
  const io = measureIo(t, app)
  await app.request()
  io.reset()
  const refreshed = await app.request('wiki', '?refresh=1')
  assert.equal(refreshed.pageCount, 2)
  assert.equal(io.counts.treeScans, 1)
  assert.equal(io.counts.metadataReads, 1)
  io.reset()
  await app.request('page', `?path=${encodeURIComponent('章节/条目')}&refresh=1`)
  assert.equal(io.counts.treeScans, 1)
  assert.equal(io.counts.metadataReads, 1)
})

test('同一 Wiki 的并发冷请求只解析和构树一次', async (t) => {
  const app = await createWiki(t)
  const io = measureIo(t, app)
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    index % 2 === 0 ? app.request() : app.request('page', `?path=${encodeURIComponent('章节/条目')}`)
  )))
  assert.equal(responses[0].pageCount, 2)
  assert.equal(responses[1].title, '条目')
  assert.equal(io.counts.treeScans, 1)
  assert.equal(io.counts.metadataReads, 1)
})

test('相同页面路径在不同工作区和 locale 中不共享旧快照', async (t) => {
  const workspaces = new Map()
  const registry = { get(id) { return workspaces.get(id) }, list() { return [] } }
  const first = await createWiki(t, { registry })
  const second = await createWiki(t)
  workspaces.set('first', { path: first.cwd })
  workspaces.set('second', { path: second.cwd })
  const metadata = JSON.parse(await fs.readFile(second.metadataFile, 'utf8'))
  metadata.wiki_items[1].title = '另一工作区的标题'
  await fs.writeFile(second.metadataFile, JSON.stringify(metadata), 'utf8')
  await fs.writeFile(path.join(second.contentRoot, '章节', '条目.md'), '# 另一工作区\n', 'utf8')
  const pageQuery = `&path=${encodeURIComponent('章节/条目')}`
  await first.request('wiki', '?workspaceId=first')
  const other = await first.request('page', `?workspaceId=second${pageQuery}`)
  assert.equal(other.title, '另一工作区的标题')
  assert.equal(other.markdown, '# 另一工作区\n')
  assert.equal((await first.request('page', `?workspaceId=first${pageQuery}`)).title, '条目')

  const english = await createWiki(t, { locale: 'en', registry })
  const englishRoot = path.join(first.wikiRoot, 'en')
  await fs.cp(path.join(english.wikiRoot, 'en'), englishRoot, { recursive: true })
  const englishMetadataFile = path.join(englishRoot, 'meta', 'repowiki-metadata.json')
  const englishMetadata = JSON.parse(await fs.readFile(englishMetadataFile, 'utf8'))
  englishMetadata.wiki_items[1].title = 'English title'
  await fs.writeFile(englishMetadataFile, JSON.stringify(englishMetadata), 'utf8')
  const localized = await english.request('page', `?workspaceId=first${pageQuery}`)
  assert.equal(localized.title, 'English title')
  assert.equal((await english.request('wiki', '?workspaceId=first')).locale, 'en')
  assert.equal((await first.request('page', `?workspaceId=first${pageQuery}`)).title, '条目')
})

test('临时磁盘读取失败不会缓存残缺快照，下一次请求可重试', async (t) => {
  const app = await createWiki(t)
  const original = fs.readFile
  let fail = true
  fs.readFile = function (filename, ...args) {
    if (filename === app.metadataFile && fail) {
      fail = false
      return Promise.reject(Object.assign(new Error('temporary metadata read failure'), { code: 'EIO' }))
    }
    return original.call(this, filename, ...args)
  }
  syncBuiltinESMExports()
  t.after(() => { fs.readFile = original; syncBuiltinESMExports() })
  assert.equal((await app.request('wiki', '', 500)).state, 'error')
  const recovered = await app.request()
  assert.equal(recovered.pageCount, 2)
  assert.equal(recovered.tree[0].children[0].page.title, '条目')
})
