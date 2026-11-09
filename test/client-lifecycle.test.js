import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

test('等待工作区与会话服务就绪后再注册页面', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let plugin
  const react = { createElement() {}, Fragment: 'fragment' }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(module) {
    plugin = module.factory((name) => {
      if (name === 'react') return react
      throw new Error(`unavailable module: ${name}`)
    })
  } } } })

  const ctx = new Context()
  let mainRegistrations = 0
  ctx.provide('locale', { bind: () => (key) => key, register: () => () => {} })
  ctx.provide('slots', {
    inject: (_name, callback) => callback(),
    register: ({ name }) => {
      if (name === 'main') mainRegistrations++
      return () => {}
    },
  })
  const fiber = ctx.plugin(plugin)
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
  await flush()
  assert.equal(mainRegistrations, 0, '工作区与会话服务尚未就绪时不能注册页面')

  ctx.provide('workspaces', { list: { getSnapshot: () => ({}), subscribe: () => () => {} } })
  ctx.provide('sessions', { list: { getSnapshot: () => ({}), subscribe: () => () => {} } })
  await fiber
  assert.equal(mainRegistrations, 1)
  await fiber.dispose()
})
