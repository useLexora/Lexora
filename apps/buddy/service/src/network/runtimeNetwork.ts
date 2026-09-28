import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici'

export function startRuntimeNetwork(): () => Promise<void> {
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false, proxyTunnel: true })
  setGlobalDispatcher(dispatcher)
  install()
  return () => dispatcher.destroy()
}
