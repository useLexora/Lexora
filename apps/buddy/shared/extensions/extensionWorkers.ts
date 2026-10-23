import { extensionPathSchema } from './extensionPath'

export interface ExtensionWorkerOptions {
  type?: 'classic' | 'module'
  name?: string
  signal?: AbortSignal
}

export interface ExtensionWorkerInstance extends EventTarget {
  terminate: () => void
}

export interface ExtensionWorkerConstructor<T extends ExtensionWorkerInstance> {
  new (url: string, options: { type: 'classic' | 'module', name?: string, credentials: 'omit' }): T
}

export interface ExtensionWorkerApi<T extends ExtensionWorkerInstance> {
  create: (entry: string | URL, options?: ExtensionWorkerOptions) => Promise<T>
}

function workerEntry(entry: string | URL, root: URL): URL {
  try {
    const url = new URL(entry, root)
    const path = decodeURIComponent(url.pathname)
    if (url.protocol !== root.protocol || url.host !== root.host || url.username || url.password || url.search || url.hash || !path.startsWith(root.pathname))
      throw new Error('Invalid worker URL')
    const name = path.slice(root.pathname.length)
    if (!extensionPathSchema.safeParse(name).success || !/\.m?js$/.test(name))
      throw new Error('Invalid worker path')
    return url
  }
  catch {
    throw new Error('EXTENSION_WORKER_ENTRY_INVALID')
  }
}

export function createExtensionWorkers<T extends ExtensionWorkerInstance>(root: URL, owner: AbortSignal, NativeWorker: ExtensionWorkerConstructor<T>): ExtensionWorkerApi<T> {
  return Object.freeze({
    async create(entry: string | URL, options: ExtensionWorkerOptions = {}): Promise<T> {
      const signal = options.signal ? AbortSignal.any([owner, options.signal]) : owner
      signal.throwIfAborted()
      const url = workerEntry(entry, root)
      const type = options.type ?? 'classic'
      let source: string
      if (type === 'module') {
        source = `const queued = [];
const channel = new MessageChannel();
const nativeAdd = EventTarget.prototype.addEventListener;
const handler = Object.getOwnPropertyDescriptor(self, 'onmessage');
let listening = false;
let replaying = false;
const finish = () => {
  self.removeEventListener('message', buffer, true);
  channel.port1.close();
  channel.port2.close();
};
const ready = () => {
  if (listening) return;
  listening = true;
  EventTarget.prototype.addEventListener = nativeAdd;
  Object.defineProperty(self, 'onmessage', handler);
  if (queued.length) channel.port2.postMessage(null);
  else finish();
};
const buffer = event => {
  if (replaying) return;
  event.stopImmediatePropagation();
  queued.push(event);
};
nativeAdd.call(self, 'message', buffer, true);
EventTarget.prototype.addEventListener = function(type, listener, options) {
  nativeAdd.call(this, type, listener, options);
  if (this === self && type === 'message' && listener && !options?.signal?.aborted) ready();
};
Object.defineProperty(self, 'onmessage', {
  configurable: true,
  enumerable: true,
  get() { return handler.get.call(this); },
  set(listener) {
    handler.set.call(this, listener);
    if (handler.get.call(this)) ready();
  },
});
channel.port1.onmessage = () => {
  const event = queued.shift();
  replaying = true;
  try {
    self.dispatchEvent(new MessageEvent(event.type, {
      data: event.data, origin: event.origin, lastEventId: event.lastEventId, source: event.source, ports: event.ports,
    }));
  } finally {
    replaying = false;
    if (queued.length) channel.port2.postMessage(null);
    else finish();
  }
};
import(${JSON.stringify(url.href)}).then(ready, error => { setTimeout(() => { throw error; }); });`
      }
      else {
        const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' })
        if (!response.ok)
          throw new Error('EXTENSION_WORKER_LOAD_FAILED')
        source = `${await response.text()}\n//# sourceURL=${url.href}`
      }
      signal.throwIfAborted()
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      let worker: T
      try {
        worker = new NativeWorker(blobUrl, { type: 'classic', name: options.name, credentials: 'omit' })
      }
      catch (error) {
        URL.revokeObjectURL(blobUrl)
        throw error
      }
      const terminate = worker.terminate.bind(worker)
      let stopped = false
      const stop = () => {
        if (stopped)
          return
        stopped = true
        signal.removeEventListener('abort', stop)
        worker.removeEventListener('error', stop)
        URL.revokeObjectURL(blobUrl)
        terminate()
      }
      worker.terminate = stop
      signal.addEventListener('abort', stop, { once: true })
      worker.addEventListener('error', stop, { once: true })
      if (signal.aborted) {
        stop()
        signal.throwIfAborted()
      }
      return worker
    },
  })
}
