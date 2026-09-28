import { ExtensionViewState } from './ExtensionViewState'

const token = location.hostname
const pending = new Map()
const state = new ExtensionViewState(() => request('events.snapshot'))
const events = state.events
let overlay = false
let interactionId = null
function applyEnvironment(next) {
  document.documentElement.lang = next.language
  document.documentElement.style.colorScheme = next.colorScheme
  for (const [name, value] of Object.entries(next.colors))
    document.documentElement.style.setProperty(`--lexora-${name}`, value)
}
events.on('view:environment:changed', event => applyEnvironment(event.data.environment))
function request(method, params = null) {
  return new Promise((resolve, reject) => {
    if (pending.size >= 64)
      return reject(new Error('EXTENSION_REQUEST_LIMIT'))
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('EXTENSION_REQUEST_TIMEOUT'))
    }, ['resources.pickFiles', 'resources.pickDirectory', 'resources.beginSave'].includes(method) ? 125000 : 15000)
    pending.set(id, { resolve, reject, timer })
    parent.postMessage({ channel: 'lexora-extension', token, id, method, params }, '*')
  })
}
addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.channel !== 'lexora-extension' || event.data.token !== token)
    return
  const data = event.data
  if (typeof data.ping === 'string') {
    parent.postMessage({ channel: 'lexora-extension', token, pong: data.ping }, '*')
    return
  }
  if (data.event) {
    state.acceptUpdate(data)
    return
  }
  const item = pending.get(data.id)
  if (!item)
    return
  pending.delete(data.id)
  clearTimeout(item.timer)
  if (data.ok)
    item.resolve(data.value)
  else item.reject(new Error(data.value))
})
addEventListener('keydown', (event) => {
  if (interactionId && event.isTrusted && event.key === 'Escape') {
    event.preventDefault()
    parent.postMessage({ channel: 'lexora-extension', token, endInteraction: true }, '*')
  }
  if (state.snapshot.control && event.isTrusted && event.key === 'Escape')
    parent.postMessage({ channel: 'lexora-extension', token, dismiss: true }, '*')
})
addEventListener('pagehide', () => {
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(new Error('EXTENSION_VIEW_CLOSED'))
  }
  pending.clear()
  state.dispose()
})
async function initialize() {
  try {
    const initial = await request('bootstrap')
    interactionId = initial.interactionId
    overlay = initial.presentation === 'decoration'
    state.initialize({ workbench: initial.workbench, visible: initial.visible, environment: initial.environment, anchor: initial.anchor ?? null, mount: initial.mount ?? null, control: initial.control }, overlay, initial.eventCursor, !!interactionId)
    if (overlay || initial.presentation === 'control' || initial.presentation === 'slot' || initial.location === 'mount') {
      const style = document.createElement('style')
      style.textContent = 'html,body{height:100%;background:transparent}body>main{height:100%;box-sizing:border-box;padding:0}'
      document.head.append(style)
    }
    if (overlay) {
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'
    }
    applyEnvironment(state.snapshot.environment)
    const entry = await import(`/__package/${initial.entry}`)
    const controller = new AbortController()
    addEventListener('pagehide', () => controller.abort(), { once: true })
    const api = Object.freeze({
      apiVersion: initial.apiVersion,
      events,
      instanceId: initial.instanceId,
      interaction: interactionId ? Object.freeze({ id: interactionId, setRegions: regions => request('interaction.setRegions', regions), onActivate: listener => events.on('interaction:activated', ({ data }) => listener({ id: data.regionId, x: data.x, y: data.y })) }) : null,
      onMessage: listener => events.on('view:message:received', event => listener(event.data.message)),
      get workbench() { return state.snapshot.workbench },
      onWorkbenchChange: listener => events.on('workbench:context:changed', event => listener(event.data.context)),
      get visible() { return state.snapshot.visible },
      onVisibilityChange: listener => events.on('view:visibility:changed', event => listener(event.data.visible)),
      get environment() { return state.snapshot.environment },
      onEnvironmentChange: listener => events.on('view:environment:changed', event => listener(event.data.environment)),
      get mount() { return state.snapshot.mount },
      onMountChange: listener => events.on('view:mount:changed', event => listener(event.data.mount)),
      get anchor() { return state.snapshot.anchor },
      onAnchorChange: (listener) => {
        if (!overlay)
          throw new Error('EXTENSION_METHOD_DENIED')
        return events.on('view:anchor:changed', event => listener(event.data.anchor))
      },
      control: initial.presentation === 'control'
        ? Object.freeze({
            get snapshot() { return state.snapshot.control },
            onChange: listener => events.on('control:changed', event => listener(event.data.control)),
            propose: (value, revision = state.snapshot.control?.revision) => request('control.propose', { value, revision }),
          })
        : null,
      resource: initial.resource,
      state: initial.state,
      stateVersion: initial.stateVersion,
      expectedStateVersion: initial.expectedStateVersion,
      signal: controller.signal,
      onActivity: (listener) => {
        if (!overlay)
          throw new Error('EXTENSION_METHOD_DENIED')
        return events.on('composer:input:received', event => listener({ type: 'composer-input', ...event.data }))
      },
      setState: state => request('view.setState', state),
      setActive: active => request('view.setActive', { active }),
      setPresentation: presentation => request('view.setPresentation', presentation),
      resources: {
        readText: resource => request('resources.readText', { id: resource.id }),
        readBytes: async (resource, options = {}) => {
          const result = await request('resources.readBytes', { id: resource.id, offset: options.offset ?? 0, length: options.length ?? 65536 })
          return { data: Uint8Array.from(atob(result.base64), byte => byte.charCodeAt(0)), size: result.size, eof: result.eof }
        },
        pickFiles: (options = {}) => request('resources.pickFiles', options),
        listFiles: () => request('resources.listFiles'),
        getUrl: resource => request('resources.getUrl', { id: resource.id }),
        revokeFile: resource => request('resources.revokeFile', { id: resource.id }),
        pickDirectory: () => request('resources.pickDirectory'),
        listDirectories: () => request('resources.listDirectories'),
        scanDirectory: (directory, options = {}) => request('resources.scanDirectory', { id: directory.id, ...options }),
        revokeDirectory: directory => request('resources.revokeDirectory', { id: directory.id }),
        saveFile: async ({ name, data }) => {
          const blob = data instanceof Blob ? data : new Blob([data])
          const id = await request('resources.beginSave', { name, size: blob.size })
          if (!id)
            return false
          try {
            for (let offset = 0; offset < blob.size; offset += 96 * 1024) {
              const bytes = new Uint8Array(await blob.slice(offset, offset + 96 * 1024).arrayBuffer())
              const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
              await request('resources.writeChunk', { id, offset, base64 })
            }
            await request('resources.commitSave', { id })
            return true
          }
          catch (error) {
            await request('resources.cancelSave', { id }).catch(() => {})
            throw error
          }
        },
      },
      network: { get: url => request('network.get', { url }) },
      commands: { execute: (command, args = null) => request('commands.execute', { command, arguments: args }) },
    })
    if (typeof entry.render !== 'function')
      throw new Error('EXTENSION_VIEW_ENTRY_INVALID')
    await entry.render(api, document.querySelector('main'))
    await request('view.ready')
  }
  catch (error) {
    document.querySelector('main').textContent = overlay ? '' : 'This extension view could not be loaded.'
    void request('view.failed', { code: /^EXTENSION_[A-Z_]+$/.test(error?.message) ? error.message : 'EXTENSION_VIEW_FAILED' }).catch(() => {})
  }
}
void initialize()
