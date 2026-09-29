import type { ExtensionConditionContext, ExtensionConditionInvocationScope, ExtensionConditionRuntime } from '../../shared/extensions/extensionConditionContext'
import type { ExtensionConditionInput, ExtensionConditionReference, ExtensionConditionState } from '../../shared/extensions/extensionConditions'
import type { ExtensionConfiguration } from '../../shared/extensions/extensionSettings'
import type { ExtensionPackage } from './ExtensionPackageStore'
import type { ExtensionHost } from './ExtensionService'
import { extensionConditionContextSchema, extensionConditionRuntimeSchema } from '../../shared/extensions/extensionConditionContext'
import { conditionRevision, ExtensionConditionEvaluator } from './ExtensionConditionEvaluator'

interface Options {
  package: (id: string) => Promise<ExtensionPackage>
  packages: () => readonly ExtensionPackage[]
  configuration: (id: string) => Promise<{ values: ExtensionConfiguration, invalidKeys: string[] }>
  activate: (id: string) => Promise<{ generation: string, host: ExtensionHost, signal: AbortSignal }>
  runtime?: (input: { models: boolean, task: boolean, taskId: string | null, runId: string | null }, signal: AbortSignal) => Promise<ExtensionConditionRuntime>
  workbench: () => Array<{ id: string, active: boolean, visible: boolean }>
}

export class ExtensionConditions {
  readonly #options: Options
  readonly #evaluator = new ExtensionConditionEvaluator()
  readonly onDidInvalidate = this.#evaluator.onDidInvalidate

  constructor(options: Options) { this.#options = options }

  async settings(id: string, items: readonly string[], form?: ExtensionConfiguration): Promise<Record<string, ExtensionConditionState>> {
    const pkg = await this.#options.package(id)
    if (form && Object.keys(form).some(key => !pkg.manifest.contributes.settings.items.some(item => item.key === key)))
      throw new Error('EXTENSION_CONDITION_INVALID')
    return Object.fromEntries(await Promise.all(items.map(async (itemId) => {
      const item = pkg.manifest.contributes.settings.items.find(item => item.id === itemId)
      if (!item)
        throw new Error('EXTENSION_CONDITION_INVALID')
      const group = pkg.manifest.contributes.settings.groups.find(group => group.id === item.group)
      const state = item.enabledWhen
        ? await this.evaluate(pkg, item.enabledWhen, { kind: 'setting', id: item.id }, { kind: 'settings', groupId: item.group, moduleId: group?.module ?? item.group.slice(0, item.group.lastIndexOf('.')) }, { form, cache: true })
        : { status: 'ready' as const, value: true }
      return [itemId, state]
    })))
  }

  evaluate(pkg: ExtensionPackage, reference: ExtensionConditionReference, target: ExtensionConditionContext['target'], invocation: ExtensionConditionInvocationScope, options: { cache: boolean, signal?: AbortSignal, form?: ExtensionConfiguration }): Promise<ExtensionConditionState> {
    const definition = pkg.manifest.contributes.conditions.find(condition => condition.id === reference.condition)
    if (!definition)
      return Promise.resolve({ status: 'unavailable', value: false })
    const scopeKey = conditionRevision(invocation)
    return this.#evaluator.evaluate({
      extensionId: pkg.manifest.id,
      definition,
      reference,
      scopeKey,
      cache: options.cache,
      signal: options.signal,
      ...(invocation.kind === 'task' ? { taskId: invocation.taskId } : {}),
      snapshot: async (signal) => {
        const active = await this.#options.activate(pkg.manifest.id)
        signal.throwIfAborted()
        const current = await this.#options.package(pkg.manifest.id)
        if (current.revision !== pkg.revision)
          throw new Error('EXTENSION_CONDITION_STALE')
        const uses = (input: ExtensionConditionInput) => definition.inputs.includes(input)
        const configuration = await this.#options.configuration(pkg.manifest.id)
        signal.throwIfAborted()
        const runtime: ExtensionConditionRuntime = { models: { status: 'not_requested' }, task: { status: 'not_requested' } }
        const models = uses('runtime.models') && pkg.manifest.permissions.models
        const task = uses('runtime.task') && pkg.manifest.permissions.tasks !== 'none'
        if (models || task) {
          const value = this.#options.runtime
            ? await this.#options.runtime({ models, task, taskId: invocation.kind === 'task' ? invocation.taskId : null, runId: invocation.kind === 'task' ? invocation.runId : null }, signal).catch(() => ({ models: { status: 'loading' as const }, task: { status: 'loading' as const } }))
            : { models: { status: 'unsupported' as const }, task: { status: 'unsupported' as const } }
          const parsed = extensionConditionRuntimeSchema.parse(value)
          if (models)
            runtime.models = parsed.models
          if (task)
            runtime.task = parsed.task
        }
        if (uses('runtime.models') && !models)
          runtime.models = { status: 'denied' }
        if (uses('runtime.task') && !task)
          runtime.task = { status: 'denied' }
        const panes = uses('workbench') ? this.#options.workbench() : []
        const formValues = { ...configuration.values, ...options.form }
        const context = extensionConditionContextSchema.parse({
          version: 1,
          scope: { key: scopeKey, configuration: { kind: 'global' }, invocation },
          target,
          configuration: !uses('configuration')
            ? { status: 'not_requested' }
            : configuration.invalidKeys.length
              ? { status: 'invalid' }
              : {
                  status: 'available',
                  revision: conditionRevision(configuration.values),
                  values: configuration.values,
                  sources: Object.fromEntries(Object.keys(configuration.values).map(key => [key, { kind: 'global' }])),
                },
          runtime,
          workbench: uses('workbench') ? { status: 'available', revision: conditionRevision(panes), panes } : { status: 'not_requested' },
          form: !uses('form') ? { status: 'not_requested' } : invocation.kind !== 'settings' ? { status: 'no_context' } : { status: 'available', revision: conditionRevision(formValues), values: formValues, dirtyKeys: Object.keys(options.form ?? {}) },
        })
        signal.throwIfAborted()
        return { ...active, context }
      },
    })
  }

  invalidate(input: { extensionId?: string, condition?: string, scopeKey?: string, taskId?: string, inputs?: readonly ExtensionConditionInput[] }): void {
    if (!input.inputs) {
      this.#evaluator.invalidate(input)
      return
    }
    for (const pkg of this.#options.packages()) {
      if (input.extensionId && pkg.manifest.id !== input.extensionId)
        continue
      for (const definition of pkg.manifest.contributes.conditions) {
        if (definition.inputs.some(source => input.inputs!.includes(source)))
          this.#evaluator.invalidate({ ...input, extensionId: pkg.manifest.id, condition: definition.id })
      }
    }
  }

  dispose(): void { this.#evaluator.dispose() }
}
