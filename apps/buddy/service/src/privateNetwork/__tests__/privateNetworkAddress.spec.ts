import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { selectPrivateNetworkAddresses } from '../privateNetworkAddress'

function address(value: string, internal = false): NetworkInterfaceInfo {
  return { address: value, internal, family: value.includes(':') ? 'IPv6' : 'IPv4', netmask: '', mac: '', cidr: null } as NetworkInterfaceInfo
}
describe('automatic mobile connection address', () => {
  it('keeps a LAN address and a recognized Tailscale address', () => {
    expect(selectPrivateNetworkAddresses({ docker0: [address('172.17.0.1')], tailscale0: [address('100.88.0.1')], wlan0: [address('192.168.1.20')] })).toEqual(['192.168.1.20', '100.88.0.1'])
  })
  it('supports a VPN-only host and private IPv6', () => {
    expect(selectPrivateNetworkAddresses({ tailscale0: [address('100.88.0.1')] })).toEqual(['100.88.0.1'])
    expect(selectPrivateNetworkAddresses({ en0: [address('fd00::2')] })).toEqual(['fd00::2'])
  })
  it('recognizes the Tailscale IPv6 prefix on unnamed tunnel interfaces without adding unrelated CGNAT addresses', () => {
    expect(selectPrivateNetworkAddresses({
      en0: [address('192.168.1.20')],
      tun0: [address('100.80.0.1')],
      utun4: [address('fd7a:115c:a1e0::2'), address('100.88.0.1')],
    })).toEqual(['192.168.1.20', '100.88.0.1'])
  })
  it('does not expose a public, wildcard, link-local or loopback listener', () => {
    expect(selectPrivateNetworkAddresses({ lo: [address('127.0.0.1'), address('::1', true)], en0: ['8.8.8.8', '0.0.0.0', '::', 'fe80::1'].map(value => address(value)) })).toEqual([])
    expect(selectPrivateNetworkAddresses({})).toEqual([])
  })
})
