const bridge = window.lexoraExtensionHost
const commands = new Map()
const subscriptions = new Set()
let entry
let manifest
let context
let activated = false
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
      entry = manifest.entry ? await import(`/__package/${manifest.entry}`) : {}
      context = Object.freeze({
        extension: Object.freeze({ id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion }),
        subscriptions: { add: (value) => {
          subscriptions.add(value)
          return value
        } },
        commands: { register(id, callback) {
          if (!manifest.contributes.commands.some(command => command.id === id) || commands.has(id) || typeof callback !== 'function')
            throw new Error('EXTENSION_COMMAND_INVALID')
          commands.set(id, callback)
          return disposable(() => commands.delete(id))
        } },
        views: { open: (type, options = {}) => request('views.open', { type, resource: options.resource ?? null, state: options.state ?? {} }) },
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
      if (manifest.contributes.commands.some(command => !commands.has(command.id)))
        throw new Error('EXTENSION_COMMAND_MISSING')
      activated = true
    }
    else if (method === 'command') {
      if (!activated || !commands.has(params.command))
        throw new Error('EXTENSION_COMMAND_UNAVAILABLE')
      result = await commands.get(params.command)(Object.freeze({ resource: params.resource, arguments: params.arguments ?? null })) ?? null
    }
    else if (method === 'deactivate') {
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
