import type { NetworkInterfaceInfo } from 'node:os'
import { networkInterfaces } from 'node:os'
import { isPrivateNetworkAddress } from './PrivateNetworkTlsIdentity'

export function selectPrivateNetworkAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), preferredAddress?: string | null): string[] {
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !/^(?:docker\d*|veth|br-|virbr|vmnet|vboxnet)/i.test(name))
    .flatMap(([name, addresses]) => {
      const tailscale = /\btailscale/i.test(name) || addresses?.some(item => isTailscaleIPv6(item.address))
      return (addresses ?? []).map(item => ({ ...item, tailscale: !!tailscale && (item.address.startsWith('100.') || isTailscaleIPv6(item.address)) }))
    })
    .filter(item => !item.internal && !item.address.startsWith('127.') && item.address !== '::1' && isPrivateNetworkAddress(item.address))
    .sort((a, b) => Number(b.address === preferredAddress) - Number(a.address === preferredAddress)
      || Number(a.family !== 'IPv4') - Number(b.family !== 'IPv4'))
  const lan = candidates.find(item => !item.tailscale && !item.address.startsWith('100.'))
  const tailscale = candidates.find(item => item.tailscale)
  return [lan?.address, tailscale?.address].filter((address): address is string => !!address).concat(!lan && !tailscale && candidates[0] ? [candidates[0].address] : [])
}

function isTailscaleIPv6(address: string): boolean {
  return /^fd7a:115c:a1e0:/i.test(address)
}
