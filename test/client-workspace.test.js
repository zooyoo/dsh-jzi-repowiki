import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

function createClient({ sessionId, recentWorkspaceId = 'workspace-b', sessions = {}, wikiByWorkspace = {} }) {
  const values = []
  let hook = 0
  let effects = []
  const requests = []
  const pending = []
  let nextDelay = null
  const react = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) {
      const index = hook++
      if (!(index in values)) values[index] = initial
      return [values[index], (value) => { values[index] = typeof value === 'function' ? value(values[index]) : value }]
    },
    useRef(initial) {
      const index = hook++
      if (!(index in values)) values[index] = { current: initial }
      return values[index]
    },
    useEffect(callback) { effects.push(callback) },
    useCallback(callback) { return callback },
    useMemo(callback) { return callback() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
  const workspaces = {
    items: [
      { workspaceId: 'workspace-a', path: '/workspace/a', sessionIds: ['session-a'], createdAt: '2024-01-01' },
      { workspaceId: 'workspace-b', path: '/workspace/b', sessionIds: ['session-b'], createdAt: '2024-01-02' },
    ],
    recentWorkspaceId,
  }
  let client
  const sandbox = {
    window: { __ModuleLoader__: { load(module) { client = module.factory((name) => {
      if (name === 'react') return react
      throw new Error(`unavailable module: ${name}`)
    }) } } },
    fetch(url) {
      const workspace = new URL(url, 'http://localhost').searchParams.get('workspaceId')
      requests.push(workspace)
      const body = wikiByWorkspace[workspace] ?? { state: 'no-wiki' }
      const delay = nextDelay
      nextDelay = null
      const response = (delay ?? Promise.resolve()).then(() => ({ ok: true, text: async () => JSON.stringify(body) }))
      pending.push(response)
      return response
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  const props = {
    t: (key) => key,
    sessionId,
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector({ byId: sessions }),
  }
  function render() { hook = 0; effects = []; return client.RepowikiPage(props) }
  async function settle() {
    await Promise.all(pending.splice(0))
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  async function mount() {
    render()
    for (const effect of effects) effect()
    await settle()
    return render()
  }
  function runEffects() { for (const effect of effects) effect() }
  function delayNext() {
    let release
    nextDelay = new Promise((resolve) => { release = resolve })
    return release
  }
  return { requests, wikiByWorkspace, render, settle, mount, runEffects, delayNext }
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    for (const item of Array.isArray(child) ? child : [child]) {
      const result = find(item, predicate)
      if (result) return result
    }
  }
  return null
}

const wiki = (workspace) => ({ state: 'ok', workspace, pageCount: 1, tree: [] })

test('显式会话所属工作区优先于最近工作区', async () => {
  const app = createClient({
    sessionId: 'session-a',
    sessions: { 'session-b': { id: 'session-b', retainedBy: { mainView: 1 }, updatedAt: 10 } },
    wikiByWorkspace: { 'workspace-a': wiki('workspace-a') },
  })
  const tree = await app.mount()
  assert.equal(app.requests[0], 'workspace-a')
  assert.ok(find(tree, (node) => node.props?.className === 'rw-tree'))
})

test('主视图保留的会话用于定位工作区', async () => {
  const app = createClient({
    sessions: { 'session-a': { id: 'session-a', retainedBy: { mainView: 1 }, updatedAt: 1 } },
    wikiByWorkspace: { 'workspace-a': wiki('workspace-a') },
  })
  await app.mount()
  assert.equal(app.requests[0], 'workspace-a')
})

test('没有活动会话时使用最近工作区', async () => {
  const app = createClient({ wikiByWorkspace: { 'workspace-b': wiki('workspace-b') } })
  await app.mount()
  assert.equal(app.requests[0], 'workspace-b')
})

test('可以从空状态切换到已有 Wiki 的工作区', async () => {
  const app = createClient({ sessionId: 'session-a', wikiByWorkspace: { 'workspace-b': wiki('workspace-b') } })
  const empty = await app.mount()
  const select = find(empty, (node) => node.type === 'select')
  assert.ok(select, '缺少工作区选择入口')
  select.props.onChange({ target: { value: 'workspace-b' } })
  app.render()
  app.runEffects()
  await app.settle()
  assert.equal(app.requests.at(-1), 'workspace-b')
  assert.ok(find(app.render(), (node) => node.props?.className === 'rw-tree'))
})

test('切换工作区后，较晚返回的旧请求不能覆盖当前结果', async () => {
  const app = createClient({
    sessionId: 'session-a',
    wikiByWorkspace: { 'workspace-a': wiki('workspace-a'), 'workspace-b': wiki('workspace-b') },
  })
  await app.mount()
  const release = app.delayNext()
  find(app.render(), (node) => node.type === 'select').props.onChange({ target: { value: 'workspace-b' } })
  app.render()
  app.runEffects()
  find(app.render(), (node) => node.type === 'select').props.onChange({ target: { value: 'workspace-a' } })
  app.render()
  app.runEffects()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  release()
  await app.settle()
  const stats = find(app.render(), (node) => node.props?.className === 'rw-treeStats')
  assert.match(stats.children.join(''), /workspace-a/)
})

test('无法定位工作区时不误报缺少 Wiki', async () => {
  const app = createClient({
    sessionId: 'session-a',
    wikiByWorkspace: { 'workspace-a': { state: 'no-wiki', reason: 'Run repowiki_init in a session workspace first.' } },
  })
  const tree = await app.mount()
  const title = find(tree, (node) => node.props?.className === 'rw-centerTitle')
  assert.equal(title.children[0], 'noWorkspaceTitle')
})

test('没有 Wiki 时可以刷新并显示随后创建的 Wiki', async () => {
  const app = createClient({ sessionId: 'session-a' })
  const empty = await app.mount()
  const refresh = find(empty, (node) => node.type === 'button' && node.children.includes('refresh'))
  assert.ok(refresh, '缺少刷新按钮')
  app.wikiByWorkspace['workspace-a'] = wiki('workspace-a')
  refresh.props.onClick()
  await app.settle()
  assert.ok(find(app.render(), (node) => node.props?.className === 'rw-tree'))
  assert.deepEqual(app.requests, ['workspace-a', 'workspace-a'])
})
