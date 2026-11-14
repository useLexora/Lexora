import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { selectPrivateNetworkAddress } from '../privateNetworkAddress'

function address(value: string, internal = false): NetworkInterfaceInfo {
  return { address: value, internal, family: value.includes(':') ? 'IPv6' : 'IPv4', netmask: '', mac: '', cidr: null } as NetworkInterfaceInfo
}
describe('automatic mobile connection address', () => {
  it('prefers a LAN address over VPN and container interfaces', () => {
    expect(selectPrivateNetworkAddress({ docker0: [address('172.17.0.1')], tailscale0: [address('100.88.0.1')], wlan0: [address('192.168.1.20')] })).toBe('192.168.1.20')
  })
  it('supports a VPN-only host and private IPv6', () => {
    expect(selectPrivateNetworkAddress({ tailscale0: [address('100.88.0.1')] })).toBe('100.88.0.1')
    expect(selectPrivateNetworkAddress({ en0: [address('fd00::2')] })).toBe('fd00::2')
  })
  it('does not expose a public, wildcard, link-local or loopback listener', () => {
    expect(selectPrivateNetworkAddress({ lo: [address('127.0.0.1'), address('::1', true)], en0: ['8.8.8.8', '0.0.0.0', '::', 'fe80::1'].map(value => address(value)) })).toBeNull()
    expect(selectPrivateNetworkAddress({})).toBeNull()
  })
})
