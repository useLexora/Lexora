const token = location.hostname
const pending = new Map()
let environment = { language: 'zh-CN', colorScheme: 'light', colors: {} }
const environmentListeners = new Set()
const activityListeners = new Set()
let overlay = false
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
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    parent.postMessage({ channel: 'lexora-extension', token, id, method, params }, '*')
  })
}
addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.channel !== 'lexora-extension' || event.data.token !== token)
    return
  if (event.data.environment) {
    applyEnvironment(event.data.environment)
    return
  }
  if (overlay && event.data.activity?.type === 'composer-input') {
    for (const listener of activityListeners) listener(Object.freeze({ type: 'composer-input' }))
    return
  }
  const request = pending.get(event.data.id)
  if (!request)
    return
  pending.delete(event.data.id)
  clearTimeout(request.timer)
  if (event.data.ok)
    request.resolve(event.data.value)
  else request.reject(new Error(event.data.value))
})
addEventListener('pagehide', () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(new Error('EXTENSION_VIEW_CLOSED'))
  }
  pending.clear()
})
async function initialize() {
  try {
    const initial = await request('bootstrap')
    overlay = initial.location === 'window-overlay'
    if (overlay) {
      document.documentElement.style.background = 'transparent'
      document.body.style.background = 'transparent'
      document.querySelector('main').style.padding = '0'
    }
    applyEnvironment(initial.environment)
    const entry = await import(`/__package/${initial.entry}`)
    const controller = new AbortController()
    addEventListener('pagehide', () => controller.abort(), { once: true })
    const api = Object.freeze({
      apiVersion: 1,
      get environment() { return environment },
      onEnvironmentChange: (listener) => {
        environmentListeners.add(listener)
        const dispose = () => environmentListeners.delete(listener)
        controller.signal.addEventListener('abort', dispose, { once: true })
        return { dispose }
      },
      resource: initial.resource,
      state: initial.state,
      stateVersion: initial.stateVersion,
      expectedStateVersion: initial.expectedStateVersion,
      signal: controller.signal,
      onActivity: (listener) => {
        if (!overlay)
          throw new Error('EXTENSION_METHOD_DENIED')
        activityListeners.add(listener)
        const dispose = () => activityListeners.delete(listener)
        controller.signal.addEventListener('abort', dispose, { once: true })
        return { dispose }
      },
      setState: state => request('view.setState', state),
      resources: { readText: resource => request('resources.readText', { id: resource.id }) },
      network: { get: url => request('network.get', { url }) },
      commands: { execute: (command, args = null) => request('commands.execute', { command, arguments: args }) },
    })
    if (typeof entry.render !== 'function')
      throw new Error('EXTENSION_VIEW_ENTRY_INVALID')
    await entry.render(api, document.querySelector('main'))
  }
  catch (error) {
    document.querySelector('main').textContent = overlay ? '' : 'This extension view could not be loaded.'
    void request('view.failed', { code: /^EXTENSION_[A-Z_]+$/.test(error?.message) ? error.message : 'EXTENSION_VIEW_FAILED' }).catch(() => {})
  }
}
void initialize()
