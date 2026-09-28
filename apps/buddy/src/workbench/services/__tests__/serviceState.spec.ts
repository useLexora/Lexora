import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { computed, ref } from 'vue'
import { commandLabel } from '../../common/workbench'
import { CommandService } from '../CommandService'
import { ConfigurationService } from '../ConfigurationService'
import { ContextKeyService } from '../ContextKeyService'
import { ContributionRegistry } from '../ContributionRegistry'

describe('service state ownership', () => {
  it('publishes effective context batches and protects replacement leases', () => {
    const parent = new ContextKeyService()
    const parentLease = parent.bind({ language: 'zh', mode: 'task' })
    const child = parent.child()
    const events: unknown[] = []
    child.onDidChange(change => events.push(change))
    const previous = child.bind({ language: 'en', ready: true })
    const replacement = child.bind({ language: 'en' })
    previous.dispose()
    expect(child.snapshot()).toEqual({ language: 'en', mode: 'task' })
    parentLease.update({ language: 'fr', mode: 'file' })
    expect(child.snapshot()).toEqual({ language: 'en', mode: 'file' })
    expect(events).toHaveLength(3)
    replacement.dispose()
    expect(child.snapshot()).toEqual({ language: 'fr', mode: 'file' })
    const snapshot = child.snapshot()
    expect(Reflect.set(snapshot, 'language', 'mutated')).toBe(false)
    child.dispose()
    parentLease.update({ language: 'zh' })
    expect(child.snapshot()).toBe(snapshot)
  })

  it('separates raw configuration from late contribution defaults and withdrawal', () => {
    const registry = new ContributionRegistry()
    const configuration = new ConfigurationService(registry)
    configuration.restore({ size: 4 })
    expect(configuration.get('size')).toBeUndefined()
    const remove = registry.register('settings', scope => scope.configuration({ id: 'size', defaultValue: 2, validate: value => typeof value === 'number' }))
    expect(configuration.get('size')).toBe(4)
    configuration.set('size', 2)
    const effectiveRevision = configuration.effectiveRevision
    configuration.restore({})
    expect(configuration.get('size')).toBe(2)
    expect(configuration.effectiveRevision).toBe(effectiveRevision)
    remove()
    expect(configuration.get('size')).toBeUndefined()
    expect(configuration.snapshot()).toEqual({})
  })

  it('delivers raw/effective commit pairs before reentrant changes and rolls back failed preparation', () => {
    const registry = new ContributionRegistry()
    registry.register('settings', scope => scope.configuration({ id: 'size', defaultValue: 1, validate: (value) => {
      if (value === 'invalid')
        throw new Error('Rejected')
      return typeof value === 'number'
    } }))
    const configuration = new ConfigurationService(registry)
    const events: string[] = []
    configuration.onDidChangeRaw((change) => {
      events.push(`raw:${change.values.size}`)
      if (change.values.size === 2)
        configuration.set('size', 3)
    })
    configuration.onDidChangeEffective(change => events.push(`effective:${change.values.size}`))
    configuration.set('size', 2)
    expect(events).toEqual(['raw:2', 'effective:2', 'raw:3', 'effective:3'])
    const revision = configuration.revision
    expect(() => configuration.restore({ size: 'invalid' })).toThrow('Rejected')
    expect(configuration.snapshot()).toEqual({ size: 3 })
    expect(configuration.get('size')).toBe(3)
    expect(configuration.revision).toBe(revision)
  })

  it('keeps command presentation reactive after registration without making registry state writable', () => {
    const language = ref('zh')
    const label = computed(() => language.value === 'zh' ? '保存' : 'Save')
    const registry = new ContributionRegistry()
    registry.register('commands', scope => scope.command({ id: 'save', label: () => label.value, execute: () => null }))
    const displayed = computed(() => commandLabel(registry.commands.get('save')!))
    expect(displayed.value).toBe('保存')
    language.value = 'en'
    expect(displayed.value).toBe('Save')
    expect(Reflect.set(registry.commands.get('save')!, 'label', 'corrupted')).toBe(false)
  })

  it('preserves command results, isolates observers and drains accepted execution before disposal', async () => {
    const registry = new ContributionRegistry()
    const complete = deferred<string>()
    registry.register('commands', scope => scope.command({ id: 'save', label: 'Save', execute: () => complete.promise }))
    const errors: unknown[] = []
    const commands = new CommandService(registry, () => ({ pane: null, view: null, values: {} }), error => errors.push(error))
    const stages: string[] = []
    commands.onDidExecute(() => {
      throw new Error('Observer')
    })
    commands.onDidExecute(event => stages.push(event.stage))
    const execution = commands.execute('save')
    const disposing = commands.dispose()
    expect(await commands.execute('save')).toEqual({ status: 'unavailable' })
    complete.resolve('actual-result')
    expect(await execution).toEqual({ status: 'completed', result: 'actual-result' })
    await disposing
    expect(stages).toEqual(['started', 'completed'])
    expect(errors).toHaveLength(2)
  })
})
