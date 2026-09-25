const token = location.hostname
const pending = new Map()
let environment = { language: 'zh-CN', colorScheme: 'light', colors: {} }
let workbench = Object.freeze({ values: Object.freeze({}), pages: Object.freeze([]) })
let visible = false
const workbenchListeners = new Set()
const visibilityListeners = new Set()
function applyWorkbench(next) {
  workbench = Object.freeze({ values: Object.freeze(next.values), pages: Object.freeze(next.pages.map(page => Object.freeze(page))) })
  for (const listener of workbenchListeners) listener(workbench)
}
let mount = null
let anchor = null
let control = null
let overlay = false
const environmentListeners = new Set()
const mountListeners = new Set()
const anchorListeners = new Set()
const controlListeners = new Set()
const activityListeners = new Set()
function applyEnvironment(next) {
  environment = Object.freeze(next)
  document.documentElement.lang = next.language
  document.documentElement.style.colorScheme = next.colorScheme
  for (const [name, value] of Object.entries(next.colors))
    document.documentElement.style.setProperty(`--lexora-${name}`, value)
  for (const listener of environmentListeners) listener(environment)
}
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
  if (data.workbench) {
    applyWorkbench(data.workbench)
    return
  }
  if (typeof data.visible === 'boolean') {
    if (visible !== data.visible) {
      visible = data.visible
      for (const listener of visibilityListeners) listener(visible)
    }
    return
  }
  if (data.environment) {
    applyEnvironment(data.environment)
    return
  }
  if (data.mount) {
    mount = Object.freeze(data.mount)
    for (const listener of mountListeners) listener(mount)
    return
  }
  if (data.anchor) {
    anchor = Object.freeze(data.anchor)
    for (const listener of anchorListeners) listener(anchor)
    return
  }
  if (data.control) {
    control = Object.freeze(data.control)
    for (const listener of controlListeners) listener(control)
    return
  }
  if (overlay && data.activity?.type === 'composer-input') {
    for (const listener of activityListeners) listener(Object.freeze(data.activity))
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
  if (control && event.isTrusted && event.key === 'Escape')
    parent.postMessage({ channel: 'lexora-extension', token, dismiss: true }, '*')
})
addEventListener('pagehide', () => {
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(new Error('EXTENSION_VIEW_CLOSED'))
  }
  pending.clear()
})
async function initialize() {
  try {
    const initial = await request('bootstrap')
    overlay = initial.presentation === 'decoration'
    anchor = initial.anchor ?? anchor
    mount = initial.mount ?? mount
    control = initial.control
    if (overlay || initial.presentation === 'control' || initial.location === 'mount') {
      const style = document.createElement('style')
      style.textContent = 'html,body{height:100%;background:transparent}body>main{height:100%;box-sizing:border-box;padding:0}'
      document.head.append(style)
    }
    if (overlay) {
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'
    }
    applyWorkbench(initial.workbench)
    visible = initial.visible
    applyEnvironment(initial.environment)
    const entry = await import(`/__package/${initial.entry}`)
    const controller = new AbortController()
    addEventListener('pagehide', () => controller.abort(), { once: true })
    const subscribe = (listeners, listener) => {
      listeners.add(listener)
      const dispose = () => listeners.delete(listener)
      controller.signal.addEventListener('abort', dispose, { once: true })
      return { dispose }
    }
    const api = Object.freeze({
      apiVersion: initial.apiVersion,
      get workbench() { return workbench },
      onWorkbenchChange: listener => subscribe(workbenchListeners, listener),
      get visible() { return visible },
      onVisibilityChange: listener => subscribe(visibilityListeners, listener),
      get environment() { return environment },
      onEnvironmentChange: listener => subscribe(environmentListeners, listener),
      get mount() { return mount },
      onMountChange: listener => subscribe(mountListeners, listener),
      get anchor() { return anchor },
      onAnchorChange: (listener) => {
        if (!overlay)
          throw new Error('EXTENSION_METHOD_DENIED')
        return subscribe(anchorListeners, listener)
      },
      control: initial.presentation === 'control'
        ? Object.freeze({
            get snapshot() { return control },
            onChange: listener => subscribe(controlListeners, listener),
            propose: (value, revision = control?.revision) => request('control.propose', { value, revision }),
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
        return subscribe(activityListeners, listener)
      },
      setState: state => request('view.setState', state),
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
