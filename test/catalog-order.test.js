import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply, Config } from '../lib/index.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const apiBase = '/plugins/dsh-plugin-repowiki/api'

// 通过正式注册的 HTTP handler 验证目录契约，不直接调用内部构树函数。
async function createWiki(t, { pages, metadata, index } = {}) {
  const fixtureRoot = path.join(projectRoot, '.research', 'fixtures')
  await fs.mkdir(fixtureRoot, { recursive: true })
  const cwd = await fs.mkdtemp(path.join(fixtureRoot, 'catalog-'))
  t.after(async () => {
    assert.equal(path.dirname(cwd), fixtureRoot)
    await fs.rm(cwd, { recursive: true, force: true })
  })
  const wikiRoot = path.join(cwd, '.qoder', 'repowiki')
  const metadataFile = path.join(wikiRoot, 'zh', 'meta', 'repowiki-metadata.json')
  for (const page of pages ?? []) {
    const filename = path.join(wikiRoot, 'zh', 'content', `${page}.md`)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, `# ${page}\n`, 'utf8')
  }
  async function writeMetadata(value) {
    await fs.mkdir(path.dirname(metadataFile), { recursive: true })
    await fs.writeFile(metadataFile, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  }
  if (metadata !== undefined) await writeMetadata(metadata)
  if (index !== undefined) {
    await fs.writeFile(path.join(wikiRoot, '.repowiki-index.json'), JSON.stringify(index), 'utf8')
  }
  const routes = new Map()
  const disposers = []
  const ctx = {
    fs: {},
    tools: { register() {} },
    get() { return undefined },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback({
        webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
        effect(callback) { disposers.push(callback()) },
      })
    },
  }
  t.after(() => { for (const dispose of disposers.reverse()) dispose() })
  apply(ctx, Config({ defaultWorkspace: cwd }))
  return {
    cwd, writeMetadata,
    async request(endpoint = 'wiki', query = '') {
      let status
      let body
      await routes.get(`${apiBase}/${endpoint}`).handler({ url: `${apiBase}/${endpoint}${query}` }, {
        writeHead(code) { status = code },
        end(buffer) { body = JSON.parse(buffer.toString('utf8')) },
      })
      assert.equal(status, 200)
      return body
    },
  }
}

function treeSummary(tree) {
  return tree.map((node) => ({
    name: node.name,
    page: node.page?.path ?? null,
    children: treeSummary(node.children),
  }))
}

function pagePaths(tree) {
  return tree.flatMap((node) => [
    ...(node.page ? [node.page.path] : []),
    ...pagePaths(node.children),
  ])
}

test('Qoder catalog 的 order 和 parent_id 决定顺序，同名目录概述挂在 node.page', async (t) => {
  // 来自真实 Qoder 格式：每组首项省略 order，item.catalog_id 指向自身 catalog。
  const app = await createWiki(t, {
    pages: [
      '部署与运维/部署与运维',
      '移动端应用架构与设计/移动端应用架构与设计',
      '项目概述与快速开始/项目概述与快速开始',
      '项目概述与快速开始/系统总览与技术栈',
    ],
    metadata: {
      wiki_repo: { id: 'repo' },
      wiki_catalogs: [
        { id: 'system', name: '系统总览与技术栈', parent_id: 'overview', order: null },
        { id: 'deploy', name: '部署与运维', parent_id: null, order: 12 },
        { id: 'mobile', name: '移动端应用架构与设计', parent_id: null, order: 1 },
        { id: 'overview', name: '项目概述与快速开始', parent_id: null },
      ],
      wiki_items: [
        { id: 'deploy', catalog_id: 'deploy', title: '部署与运维' },
        { id: 'system', catalog_id: 'system', title: '系统总览与技术栈' },
        { id: 'overview', catalog_id: 'overview', title: '项目概述与快速开始' },
        { id: 'mobile', catalog_id: 'mobile', title: '移动端应用架构与设计' },
      ],
    },
  })
  const wiki = await app.request()
  assert.equal(wiki.pageCount, 4)
  assert.deepEqual(treeSummary(wiki.tree), [
    {
      name: '项目概述与快速开始', page: '项目概述与快速开始/项目概述与快速开始',
      children: [{ name: '系统总览与技术栈', page: '项目概述与快速开始/系统总览与技术栈', children: [] }],
    },
    { name: '移动端应用架构与设计', page: '移动端应用架构与设计/移动端应用架构与设计', children: [] },
    { name: '部署与运维', page: '部署与运维/部署与运维', children: [] },
  ])
})

test('仅修改 metadata 的 order 与 parent_id 就改变展示顺序和归属，page.path 仍指向实际文件', async (t) => {
  const metadata = {
    wiki_catalogs: [
      { id: 'core', name: '核心架构', parent_id: null, order: 1 },
      { id: 'guide', name: '开发指南', parent_id: null, order: null },
      { id: 'bus', name: '事件总线', parent_id: 'core', order: null },
    ],
    wiki_items: [
      { id: 'core', catalog_id: 'core', title: '核心架构' },
      { id: 'guide', catalog_id: 'guide', title: '开发指南' },
      { id: 'bus', catalog_id: 'bus', title: '事件总线' },
    ],
  }
  const app = await createWiki(t, {
    pages: ['核心架构/核心架构', '核心架构/事件总线', '开发指南/开发指南'], metadata,
  })
  const before = await app.request()
  assert.deepEqual(before.tree.map((node) => node.name), ['开发指南', '核心架构'])
  assert.deepEqual(before.tree[1].children.map((node) => node.name), ['事件总线'])

  metadata.wiki_catalogs[0].order = null
  metadata.wiki_catalogs[1].order = 1
  metadata.wiki_catalogs[2].parent_id = 'guide'
  await app.writeMetadata(metadata)
  const after = await app.request()
  assert.deepEqual(treeSummary(after.tree), [
    { name: '核心架构', page: '核心架构/核心架构', children: [] },
    {
      name: '开发指南', page: '开发指南/开发指南',
      children: [{ name: '事件总线', page: '核心架构/事件总线', children: [] }],
    },
  ])
  assert.equal(after.pageCount, 3)
  assert.deepEqual(pagePaths(after.tree).sort(), pagePaths(before.tree).sort())
  assert.equal(after.tree[1].children[0].path, '开发指南/事件总线')
  const page = await app.request('page', `?path=${encodeURIComponent(after.tree[1].children[0].page.path)}`)
  assert.match(page.markdown, /事件总线/)
})

test('缺失、损坏或不可用的元数据回退到稳定磁盘树，两种目录首页布局都合并', async (t) => {
  const pages = ['核心架构/事件总线', '核心架构', '快速开始', '附录/附录', '未登记说明']
  for (const [name, metadata] of [
    ['缺失', undefined],
    ['损坏 JSON', '{'],
    ['错误字段类型', { wiki_catalogs: {}, wiki_items: 'invalid' }],
    ['循环与孤立节点', {
      wiki_catalogs: [
        null,
        { id: 'bad', name: 42 },
        { id: 'cycle-a', name: '附录', parent_id: 'cycle-b' },
        { id: 'cycle-b', name: '核心架构', parent_id: 'cycle-a' },
        { id: 'orphan', name: '快速开始', parent_id: 'missing-parent' },
      ],
      wiki_items: [null, { catalog_id: 'cycle-a', title: 42 }],
    }],
  ]) {
    await t.test(name, async (t) => {
      const app = await createWiki(t, { pages, metadata })
      const wiki = await app.request()
      assert.equal(wiki.pageCount, 5)
      assert.deepEqual(treeSummary(wiki.tree), [
        { name: '附录', page: '附录/附录', children: [] },
        {
          name: '核心架构', page: '核心架构',
          children: [{ name: '事件总线', page: '核心架构/事件总线', children: [] }],
        },
        { name: '快速开始', page: '快速开始', children: [] },
        { name: '未登记说明', page: '未登记说明', children: [] },
      ])
      assert.deepEqual(pagePaths(wiki.tree).sort(), [...pages].sort())
    })
  }
})

test('部分或过期 metadata 不隐藏未登记页、孤立页面，也不创建缺失文件的虚假页', async (t) => {
  const pages = ['核心架构/核心架构', '核心架构/未登记小节', '附录', '孤立页面', '手写说明']
  const app = await createWiki(t, {
    pages,
    metadata: {
      wiki_catalogs: [
        { id: 'core', name: '核心架构', parent_id: null, order: null },
        { id: 'deleted', name: '已删除章节', parent_id: null, order: 1 },
        { id: 'orphan', name: '孤立页面', parent_id: 'missing-parent', order: null },
      ],
      wiki_items: [{ id: 'deleted', catalog_id: 'deleted', title: '已删除章节' }],
    },
  })
  const wiki = await app.request()
  assert.equal(wiki.pageCount, 5)
  assert.deepEqual(treeSummary(wiki.tree), [
    {
      name: '核心架构', page: '核心架构/核心架构',
      children: [{ name: '未登记小节', page: '核心架构/未登记小节', children: [] }],
    },
    { name: '附录', page: '附录', children: [] },
    { name: '孤立页面', page: '孤立页面', children: [] },
    { name: '手写说明', page: '手写说明', children: [] },
  ])
  assert.deepEqual(pagePaths(wiki.tree).sort(), [...pages].sort())
})

test('旧 DSH 仓库根 catalog 透明展开，父目录 item 和私有索引字段保持兼容', async (t) => {
  const app = await createWiki(t, {
    pages: ['核心架构/事件总线', '核心架构', '项目概述'],
    metadata: {
      wiki_repo: { id: 'repo', name: 'fixture' },
      wiki_catalogs: [
        { id: 'wrapper', name: 'fixture', parent_id: 'repo' },
        { id: 'overview', name: '项目概述', parent_id: 'wrapper' },
        { id: 'core', name: '核心架构', parent_id: 'wrapper' },
        { id: 'bus', name: '事件总线', parent_id: 'core' },
      ],
      wiki_items: [
        { id: 'overview-item', catalog_id: 'wrapper', title: '项目概述' },
        { id: 'core-item', catalog_id: 'wrapper', title: '核心架构' },
        { id: 'bus-item', catalog_id: 'core', title: '事件总线' },
      ],
    },
    index: {
      pages: {
        核心架构: {
          path: '过期索引路径', title: '架构正文标题', sources: ['src/main.js'],
          sourceStats: { 'src/main.js': { size: 42 } }, updatedAt: '2026-01-02',
        },
      },
    },
  })
  const wiki = await app.request()
  assert.equal(wiki.incrementalBaseline, true)
  assert.equal(wiki.pageCount, 3)
  assert.deepEqual(treeSummary(wiki.tree), [
    { name: '项目概述', page: '项目概述', children: [] },
    {
      name: '核心架构', page: '核心架构',
      children: [{ name: '事件总线', page: '核心架构/事件总线', children: [] }],
    },
  ])
  assert.equal(wiki.tree[1].page.title, '架构正文标题')
  assert.equal(wiki.tree[1].page.updatedAt, '2026-01-02')
  assert.deepEqual(wiki.tree[1].page.sources, ['src/main.js'])
  assert.deepEqual(wiki.tree[1].page.sourceStats, { 'src/main.js': { size: 42 } })
})

test('同名叶页按父 catalog 区分，含斜杠的 Qoder 标题关联到安全文件名', async (t) => {
  const app = await createWiki(t, {
    pages: [
      '外部系统集成/外部系统集成', '外部系统集成/Oracle_MES集成', '外部系统集成/配置',
      '开发指南/开发指南', '开发指南/配置',
    ],
    metadata: {
      wiki_catalogs: [
        { id: 'oracle', name: 'Oracle/MES集成', parent_id: 'external', order: 1 },
        { id: 'guide', name: '开发指南', parent_id: null, order: 1 },
        { id: 'external-config', name: '配置', parent_id: 'external', order: null },
        { id: 'guide-config', name: '配置', parent_id: 'guide', order: null },
        { id: 'external', name: '外部系统集成', parent_id: null, order: null },
      ],
      wiki_items: [
        { id: 'oracle', catalog_id: 'oracle', title: 'Oracle/MES集成', gmt_modified: '2026-01-03' },
        { id: 'external-config', catalog_id: 'external-config', title: '配置' },
        { id: 'guide-config', catalog_id: 'guide-config', title: '配置' },
      ],
    },
  })
  const wiki = await app.request()
  assert.equal(wiki.pageCount, 5)
  assert.equal(wiki.incrementalBaseline, false)
  assert.deepEqual(treeSummary(wiki.tree), [
    {
      name: '外部系统集成', page: '外部系统集成/外部系统集成',
      children: [
        { name: '配置', page: '外部系统集成/配置', children: [] },
        { name: 'Oracle/MES集成', page: '外部系统集成/Oracle_MES集成', children: [] },
      ],
    },
    {
      name: '开发指南', page: '开发指南/开发指南',
      children: [{ name: '配置', page: '开发指南/配置', children: [] }],
    },
  ])
  assert.equal(wiki.tree[0].children[1].page.title, 'Oracle/MES集成')
  assert.equal(wiki.tree[0].children[1].page.updatedAt, '2026-01-03')
  assert.equal(new Set(pagePaths(wiki.tree)).size, 5)
  const page = await app.request('page', `?path=${encodeURIComponent('外部系统集成/Oracle_MES集成')}`)
  assert.equal(page.title, wiki.tree[0].children[1].page.title)
  assert.equal(page.updatedAt, '2026-01-03')
})
