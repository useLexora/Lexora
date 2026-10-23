import { deferred } from '@buddy-tests/deferred'
import { expect, it, onTestFinished } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { ContributionRegistry } from '../../services/ContributionRegistry'
import { WorkbenchController } from '../../services/WorkbenchController'
import { useWorkbenchLaunchers } from '../useWorkbenchLaunchers'

it('projects registered launchers in stable order and rechecks live visibility and enabled state on dispatch', async () => {
  const registry = new ContributionRegistry()
  const controller = new WorkbenchController(registry)
  const context = controller.contextKeys
  const scope = effectScope()
  onTestFinished(() => scope.stop())
  const canOpen = shallowRef(true)
  const language = shallowRef('Open')
  const opened: string[] = []
  const release = registry.register('tools', (scope) => {
    scope.command({ id: 'extra.open', label: 'Open', enabled: () => canOpen.value, execute: () => opened.push('extra') })
    scope.launcher({ id: 'extra', label: () => language.value, command: 'extra.open', order: 20, when: values => values.page === 'tasks' })
    scope.command({ id: 'base.open', label: 'Base', execute: () => opened.push('base') })
    scope.launcher({ id: 'base', command: 'base.open', label: 'Base', order: 10 })
  })
  const launchers = scope.run(() => useWorkbenchLaunchers(controller))!
  expect(launchers.actions.value.map(action => action.id)).toEqual(['base'])
  expect(await launchers.launch('extra')).toBe(false)
  const page = context.bind({ page: 'tasks' })
  expect(launchers.actions.value.map(action => action.id)).toEqual(['base', 'extra'])
  language.value = '打开'
  canOpen.value = false
  expect(launchers.actions.value[1]).toMatchObject({ label: '打开', disabled: true })
  expect(await launchers.launch('extra')).toBe(false)
  canOpen.value = true
  expect(await launchers.launch('extra')).toBe(true)
  page.dispose()
  expect(await launchers.launch('extra')).toBe(false)
  release()
  expect(launchers.actions.value).toEqual([])
  expect(await launchers.launch('base')).toBe(false)
  expect(opened).toEqual(['extra'])
})

it('disables duplicate preparation, restores availability after failure and refuses a disposed host', async () => {
  const registry = new ContributionRegistry()
  const controller = new WorkbenchController(registry)
  const scope = effectScope()
  onTestFinished(() => scope.stop())
  const gate = deferred<void>()
  registry.register('tools', (scope) => {
    scope.command({ id: 'pending.open', label: 'Pending', execute: () => gate.promise })
    scope.launcher({ id: 'pending', command: 'pending.open', label: 'Pending' })
    scope.launcher({ id: 'alias', command: 'pending.open', label: 'Alias' })
  })
  const launchers = scope.run(() => useWorkbenchLaunchers(controller))!
  const first = launchers.launch('pending')
  expect(launchers.actions.value[0]?.disabled).toBe(true)
  expect(await launchers.launch('pending')).toBe(false)
  expect(await launchers.launch('alias')).toBe(false)
  gate.reject(new Error('prepare failed'))
  await expect(first).rejects.toThrow('prepare failed')
  expect(launchers.actions.value[0]?.disabled).toBe(false)
  scope.stop()
  expect(await launchers.launch('pending')).toBe(false)
})
