const bridge = window.lexoraExtensionHost
const commands = new Map()
const subscriptions = new Set()
let entry
let manifest
let context
let registrationError = null
let activated = false
let panes = Object.freeze([])
const paneListeners = new Set()
const interactions = new Map()
function applyPanes(next) {
  panes = Object.freeze(next.map(pane => Object.freeze({ ...pane, rect: Object.freeze(pane.rect) })))
  for (const listener of paneListeners) listener(panes)
}
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
      applyPanes(params.panes ?? [])
      entry = manifest.entry ? await import(`/__package/${manifest.entry}`) : {}
      context = Object.freeze({
        extension: Object.freeze({ id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion }),
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
          get panes() { return panes },
          onPanesChange: (listener) => {
            paneListeners.add(listener)
            return disposable(() => paneListeners.delete(listener))
          },
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
      activated = true
    }
    else if (method === 'command') {
      if (!activated || !commands.has(params.command))
        throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
      result = await commands.get(params.command)(Object.freeze({ resource: params.resource, arguments: params.arguments ?? null, invocation: params.invocation ?? null })) ?? null
    }
    else if (method === 'panes') {
      applyPanes(params.panes)
    }
    else if (method === 'interactionEnded') {
      interactions.get(params.id)?.abort()
      interactions.delete(params.id)
    }
    else if (method === 'deactivate') {
      for (const controller of interactions.values()) controller.abort()
      interactions.clear()
      paneListeners.clear()
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
