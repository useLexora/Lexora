export function createProxyEnvironment(proxyUrl: string): Record<string, string> {
  const httpsProxy = new URL(proxyUrl)
  httpsProxy.username = httpsProxy.username.replace(/-http$/, '')
  const httpProxy = new URL(httpsProxy)
  httpProxy.username += '-http'
  return {
    HTTP_PROXY: httpProxy.href,
    HTTPS_PROXY: httpsProxy.href,
    ALL_PROXY: httpsProxy.href,
    http_proxy: httpProxy.href,
    https_proxy: httpsProxy.href,
    all_proxy: httpsProxy.href,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: '1',
  }
}
