import { createReadStream } from 'node:fs'
import { connectLocalService } from '../../../platform/service/connectLocalService'
import { ServiceRpcChannel } from '../../../platform/service/ServiceRpcChannel'
import { serviceHostBootstrapSchema } from '../../../shared/service/localServiceProtocol'

export async function connectPlatformHost() {
  const input = createReadStream('', { fd: 3, autoClose: true, encoding: 'utf8' })
  const timeout = setTimeout(() => input.destroy(new Error('PLATFORM_HOST_BOOTSTRAP_TIMEOUT')), 10000)
  let data = ''
  try {
    for await (const chunk of input) {
      data += chunk
      if (data.length > 65536)
        throw new Error('PLATFORM_HOST_BOOTSTRAP_INVALID')
    }
  }
  finally {
    clearTimeout(timeout)

    input.destroy()
  }
  const bootstrap = serviceHostBootstrapSchema.parse(JSON.parse(data))
  const connected = await connectLocalService(bootstrap.endpoint, { ...bootstrap.identity, type: 'hello', role: 'host', secret: bootstrap.secret })
  return { bootstrap, peer: new ServiceRpcChannel(connected.frames) }
}
export type PlatformHostConnection = Awaited<ReturnType<typeof connectPlatformHost>>
