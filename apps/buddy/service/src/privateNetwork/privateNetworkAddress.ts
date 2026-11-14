import type { NetworkInterfaceInfo } from 'node:os'
import { networkInterfaces } from 'node:os'
import { isPrivateNetworkAddress } from './PrivateNetworkTlsIdentity'

export function selectPrivateNetworkAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | null {
  return Object.entries(interfaces)
    .filter(([name]) => !/^(?:docker\d*|veth|br-|virbr|vmnet|vboxnet)/i.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter(item => !item.internal && !item.address.startsWith('127.') && item.address !== '::1' && isPrivateNetworkAddress(item.address))
    .sort((a, b) => Number(a.family !== 'IPv4') - Number(b.family !== 'IPv4')
      || Number(/^100\./.test(a.address)) - Number(/^100\./.test(b.address)))[0]
    ?.address ?? null
}
