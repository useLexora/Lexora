import type * as Sdk from '../../../../../service/resources/skills/plugin-creator/references/api'
import type { TaskActionEvents } from '../../../../../shared/conversation/taskEvents'
import type { EventMessage, EventPattern, EventSnapshot, EventSubscriber } from '../../../../../shared/events/eventTypes'
import type { ExtensionActionCause } from '../../../../../shared/extensions/extensionAgent'
import type { ExtensionConditionContext } from '../../../../../shared/extensions/extensionConditionContext'
import type { ExtensionHostEvents, ExtensionViewEvents } from '../../../../../shared/extensions/extensionEvents'
import { deferred } from '@buddy-tests/deferred'
import { expect, expectTypeOf, it } from 'vitest'
import { ExtensionHostEvents as HostSource } from '../ExtensionHostEvents'
import { ExtensionViewState } from '../ExtensionViewState'

it('keeps the self-contained public SDK and internal event contracts equivalent', () => {
  expectTypeOf<Omit<Sdk.ConditionContext, 'signal'>>().toEqualTypeOf<EventSnapshot<ExtensionConditionContext>>()
  expectTypeOf<Sdk.ExtensionEvents>().toEqualTypeOf<ExtensionHostEvents>()
  expectTypeOf<Sdk.TaskActionEvents>().toEqualTypeOf<TaskActionEvents>()
  expectTypeOf<Sdk.AgentActionContext['cause']>().toEqualTypeOf<ExtensionActionCause>()
  expectTypeOf<Sdk.ViewEvents>().toEqualTypeOf<ExtensionViewEvents>()
  expectTypeOf<Sdk.EventPattern<Sdk.ViewEvents>>().toEqualTypeOf<EventPattern<ExtensionViewEvents>>()
  expectTypeOf<Sdk.EventMessage<Sdk.ViewEvents, 'view:**' | 'control:changed'>>().toEqualTypeOf<EventMessage<ExtensionViewEvents, 'view:**' | 'control:changed'>>()
  expectTypeOf<Sdk.EventSubscriber<Sdk.ViewEvents>>().toExtend<EventSubscriber<ExtensionViewEvents>>()
  expectTypeOf<EventSubscriber<ExtensionViewEvents>>().toExtend<Sdk.EventSubscriber<Sdk.ViewEvents>>()
})

it('keeps passive configuration observers independent of explicit hot-apply participants', async () => {
  const source = new HostSource()
  const change = { configuration: { enabled: true, model: { providerId: 'test', modelId: 'text' } }, changedKeys: ['enabled'] }
  expect(await source.updateConfiguration(change)).toBe(false)
  const seen: unknown[] = []
  source.events.on(['configuration:*', 'configuration:changed'], ({ data }) => {
    seen.push(data)
    expect(Object.isFrozen(data.configuration.model)).toBe(true)
    expect(Object.isFrozen(data.changedKeys)).toBe(true)
  })
  expect(await source.updateConfiguration(change)).toBe(false)
  expect(seen).toEqual([change])
  const pending = deferred<void>()
  const participant = source.registerConfigurationApplier(async (configuration) => {
    expect(configuration).toEqual(change.configuration)
    expect(Object.isFrozen(configuration.model)).toBe(true)
    await pending.promise
  })
  const applying = source.updateConfiguration(change)
  pending.resolve()
  expect(await applying).toBe(true)
  participant.dispose()
  expect(await source.updateConfiguration(change)).toBe(false)
  source.dispose()
  expect(await source.updateConfiguration(change)).toBe(false)
})

it('fails explicit configuration application and fences a late result after disposal', async () => {
  const change = { configuration: { enabled: true }, changedKeys: ['enabled'] }
  const source = new HostSource()
  const failed = source.registerConfigurationApplier(() => {
    throw new Error('apply failed')
  })
  await expect(source.updateConfiguration(change)).rejects.toThrow('apply failed')
  failed.dispose()
  const pending = deferred<void>()
  source.registerConfigurationApplier(() => pending.promise)
  const applying = source.updateConfiguration(change)
  source.dispose()
  pending.resolve()
  expect(await applying).toBe(false)
})

it('updates snapshots before notifying, keeps frames isolated and gates restricted event domains', () => {
  const state = new ExtensionViewState()
  const other = new ExtensionViewState()
  const initial = { workbench: { values: {}, pages: [] }, environment: { language: 'en-US', colorScheme: 'light' as const, colors: {} }, visible: false, mount: null, anchor: null, control: null }
  state.initialize(initial, false)
  const seen: string[] = []
  state.events.on(['view:**', 'workbench:**', 'control:**', 'composer:**'], (event) => {
    seen.push(event.type)
    if (event.type === 'view:visibility:changed')
      expect(state.snapshot.visible).toBe(event.data.visible)
    if (event.type === 'workbench:context:changed') {
      expect(state.snapshot.workbench).toBe(event.data.context)
      expect(Object.isFrozen(event.data.context.values)).toBe(true)
    }
  })
  other.events.on('**', () => seen.push('wrong-instance'))
  state.accept({ type: 'view:visibility:changed', data: { visible: true } })
  state.accept({ type: 'view:visibility:changed', data: { visible: true } })
  state.accept({ type: 'workbench:context:changed', data: { context: { values: { page: 'tasks' }, pages: [] } } })
  state.accept({ type: 'composer:input:received', data: {} })
  state.accept({ type: 'control:changed', data: { control: { revision: '1', value: null, disabled: false, options: [] } } })
  state.accept({ type: 'view:anchor:changed', data: { anchor: { kind: 'composer.input', visible: true, width: 100, height: 40 } } })
  expect(seen).toEqual(['view:visibility:changed', 'workbench:context:changed'])
  expect(initial.visible).toBe(false)
  state.initialize(initial, true)
  state.accept({ type: 'composer:input:received', data: { caret: null } })
  expect(seen.at(-1)).toBe('composer:input:received')
  state.dispose()
  state.accept({ type: 'view:message:received', data: { message: { ignored: true } } })
  expect(seen).toHaveLength(3)
})
