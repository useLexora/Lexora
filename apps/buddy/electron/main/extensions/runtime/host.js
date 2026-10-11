import { copyEventSnapshot } from '../../../../shared/events/eventSnapshot'
import { createThemeClient } from '../../../../shared/theme/themeClient'
import { ExtensionHostEvents } from './ExtensionHostEvents'

const bridge = window.lexoraExtensionHost
const commands = new Map()
const agentTools = new Map()
const agentActions = new Map()
const conditions = new Map()
const conditionEvaluations = new Map()
const agentInvocations = new Map()
const source = new ExtensionHostEvents()
const events = source.events
const subscriptions = new Set()
const themeListeners = new Set()
let entry
let manifest
let context
let registrationError = null
let activated = false
const interactions = new Map()
const code = error => /^EXTENSION_[A-Z_]+$/.test(error?.message) ? error.message : 'EXTENSION_ACTIVATION_FAILED'
const request = (method, params = null) => bridge.request(method, params)
function disposable(cleanup) {
  let disposed = false
  const value = { dispose() {
    if (disposed)
      return
    disposed = true
    subscriptions.delete(value)
    cleanup()
  } }
  subscriptions.add(value)
  return value
}
bridge.subscribe(async ({ id, method, params }) => {
  try {
    let result = null
    if (method === 'activate') {
      manifest = params.manifest
      source.updatePanes(params.panes ?? [])
      entry = manifest.entry ? await import(`/__package/${manifest.entry}`) : {}
      context = Object.freeze({
        extension: Object.freeze({ id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion }),
        events,
        themes: createThemeClient(input => request('themes.request', input), (listener) => {
          themeListeners.add(listener)
          return disposable(() => themeListeners.delete(listener))
        }),
        subscriptions: { add: (value) => {
          subscriptions.add(value)
          return value
        } },
        commands: { register(id, callback) {
          if (activated || !manifest.contributes.commands.some(command => command.id === id) || commands.has(id) || typeof callback !== 'function') {
            registrationError = new Error('EXTENSION_COMMAND_INVALID')
            throw registrationError
          }
          commands.set(id, callback)
          return disposable(() => commands.delete(id))
        } },
        workbench: {
          get panes() { return source.panes },
          onPanesChange: listener => events.on('workbench:panes:changed', event => listener(event.data.panes)),
        },
        interactions: { start: async (title) => {
          const id = crypto.randomUUID()
          const controller = new AbortController()
          interactions.set(id, controller)
          try {
            await request('interactions.start', { id, title })
            if (controller.signal.aborted)
              throw new Error('EXTENSION_INTERACTION_ENDED')
            return Object.freeze({ id, signal: controller.signal, end: () => request('interactions.end', { id }) })
          }
          catch (error) {
            controller.abort()
            interactions.delete(id)
            throw error
          }
        } },
        views: { broadcast: message => request('views.broadcast', message), open: (type, options = {}) => request('views.open', { type, resource: options.resource ?? null, state: options.state ?? {} }) },
        placements: { show: (id, options) => request('placements.show', { id, ...(typeof options === 'string' ? { instanceId: options } : options ?? {}) }), hide: (id, options) => request('placements.hide', { id, ...(typeof options === 'string' ? { instanceId: options } : options ?? {}) }) },
        resources: { readText: resource => request('resources.readText', { id: resource.id }) },
        storage: { get: () => request('storage.get'), set: value => request('storage.set', { value, version: manifest.dataVersion }) },
        conditions: {
          register(id, callback) {
            if (activated || !manifest.contributes.conditions?.some(condition => condition.id === id) || conditions.has(id) || typeof callback !== 'function') {
              registrationError = new Error('EXTENSION_CONDITION_INVALID')
              throw registrationError
            }
            conditions.set(id, callback)
            return disposable(() => conditions.delete(id))
          },
          invalidate: (input = {}) => request('conditions.invalidate', input),
        },
        configuration: {
          get: () => request('configuration.get'),
          onChange: listener => source.registerConfigurationApplier(listener),
        },
        agent: { registerTool(id, callback) {
          if (activated || !manifest.contributes.agent?.tools.some(tool => tool.id === id) || agentTools.has(id) || typeof callback !== 'function') {
            registrationError = new Error('EXTENSION_TOOL_INVALID')
            throw registrationError
          }
          agentTools.set(id, callback)
          return disposable(() => agentTools.delete(id))
        }, registerAction(id, callback) {
          if (activated || !manifest.contributes.agent?.actions.some(action => action.id === id) || agentActions.has(id) || typeof callback !== 'function') {
            registrationError = new Error('EXTENSION_ACTION_INVALID')
            throw registrationError
          }
          agentActions.set(id, callback)
          return disposable(() => agentActions.delete(id))
        } },
        network: { get: url => request('network.get', { url }) },
        notifications: { show: notification => request('notifications.show', notification) },
        schedules: {
          get: id => request('schedules.get', { id }),
          set: schedule => request('schedules.set', schedule),
          remove: id => request('schedules.remove', { id }),
        },
      })
      const stored = await request('storage.read')
      if (stored.version !== manifest.dataVersion) {
        if (stored.version !== 0 && typeof entry.migrate !== 'function')
          throw new Error('EXTENSION_DATA_MIGRATION_REQUIRED')
        const value = stored.version === 0 ? {} : await entry.migrate(stored.value, stored.version, manifest.dataVersion)
        await request('storage.set', { value, version: manifest.dataVersion })
      }
      if (manifest.entry) {
        if (typeof entry.activate !== 'function')
          throw new Error('EXTENSION_ENTRY_INVALID')
        await entry.activate(context)
      }
      if (registrationError)
        throw registrationError
      if (manifest.contributes.commands.some(command => !commands.has(command.id)))
        throw new Error('EXTENSION_COMMAND_MISSING')
      if (manifest.contributes.agent?.tools.some(tool => !agentTools.has(tool.id)))
        throw new Error('EXTENSION_TOOL_MISSING')
      if (manifest.contributes.agent?.actions.some(action => !agentActions.has(action.id)))
        throw new Error('EXTENSION_ACTION_MISSING')
      if (manifest.contributes.conditions?.some(condition => !conditions.has(condition.id)))
        throw new Error('EXTENSION_CONDITION_MISSING')
      activated = true
    }
    else if (method === 'themes.changed') {
      for (const listener of themeListeners) listener()
    }
    else if (method === 'configuration.changed') {
      if (!activated)
        throw new Error('EXTENSION_HOST_STOPPED')
      try {
        const applied = await source.updateConfiguration({ configuration: params.configuration, changedKeys: params.changedKeys })
        result = { operationId: params.operationId, generation: params.generation, configurationRevision: params.configurationRevision, applied }
      }
      catch { throw new Error('EXTENSION_CONFIGURATION_UPDATE_FAILED') }
    }
    else if (method === 'conditions.evaluate') {
      if (!activated || !conditions.has(params.condition) || conditionEvaluations.size >= 32)
        throw new Error('EXTENSION_CONDITION_UNAVAILABLE')
      const controller = new AbortController()
      conditionEvaluations.set(params.evaluationId, controller)
      const timeout = setTimeout(() => controller.abort(), 2000)
      let cancel
      try {
        const cancelled = new Promise((_, reject) => {
          cancel = () => reject(new Error('EXTENSION_CONDITION_CANCELLED'))
          controller.signal.addEventListener('abort', cancel, { once: true })
        })
        result = await Promise.race([
          Promise.resolve().then(() => conditions.get(params.condition)(Object.freeze({ ...copyEventSnapshot(params.context), signal: controller.signal }), copyEventSnapshot(params.params))),
          cancelled,
        ])
        controller.signal.throwIfAborted()
      }
      catch { throw new Error('EXTENSION_CONDITION_FAILED') }
      finally {
        clearTimeout(timeout)
        controller.signal.removeEventListener('abort', cancel)
        conditionEvaluations.delete(params.evaluationId)
      }
    }
    else if (method === 'conditions.cancel') {
      conditionEvaluations.get(params.evaluationId)?.abort()
    }
    else if (method === 'agent.invoke') {
      if (!activated || !(params.action ? agentActions.has(params.action) : agentTools.has(params.tool)))
        throw new Error('EXTENSION_AGENT_UNAVAILABLE')
      const controller = new AbortController()
      agentInvocations.set(params.invocationId, controller)
      const call = (method, value = null) => {
        controller.signal.throwIfAborted()
        return request('agent.request', { invocationId: params.invocationId, method, params: value })
      }
      try {
        const invocation = Object.freeze({
          signal: controller.signal,
          task: Object.freeze({ get: () => call('task.get'), messages: () => call('task.messages'), rename: value => call('task.rename', value) }),
          models: Object.freeze({ generateText: value => call('models.generateText', value) }),
        })
        result = (params.action ? await agentActions.get(params.action)(Object.freeze({ ...invocation, cause: copyEventSnapshot(params.cause) })) : await agentTools.get(params.tool)(params.input, invocation)) ?? null
      }
      finally { agentInvocations.delete(params.invocationId) }
    }
    else if (method === 'agent.cancel') {
      agentInvocations.get(params.invocationId)?.abort()
    }
    else if (method === 'command') {
      if (!activated || !commands.has(params.command))
        throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
      result = await commands.get(params.command)(Object.freeze({ resource: params.resource, arguments: params.arguments ?? null, invocation: params.invocation ?? null })) ?? null
    }
    else if (method === 'panes') {
      source.updatePanes(params.panes)
    }
    else if (method === 'interactionEnded') {
      interactions.get(params.id)?.abort()
      interactions.delete(params.id)
    }
    else if (method === 'deactivate') {
      for (const controller of conditionEvaluations.values()) controller.abort()
      conditionEvaluations.clear()
      for (const controller of agentInvocations.values()) controller.abort()
      agentInvocations.clear()
      for (const controller of interactions.values()) controller.abort()
      interactions.clear()
      source.dispose()
      activated = false
      try {
        await entry?.deactivate?.()
      }
      finally {
        for (const item of [...subscriptions].reverse()) {
          try {
            await item.dispose()
          }
          catch {}
        }
        subscriptions.clear()
        commands.clear()
      }
    }
    else {
      throw new Error('EXTENSION_METHOD_DENIED')
    }
    bridge.reply(id, true, result)
  }
  catch (error) {
    bridge.reply(id, false, code(error))
  }
})
void request('ready').catch(() => {})
