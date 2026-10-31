import { describe, expect, it } from 'vitest'
import { parseWslDistributions, wslStartDirectory } from '../wslDirectory'

const output = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss
    NatIpAddress    REG_SZ    172.31.143.132
    DefaultDistribution    REG_SZ    {3B49CB51-60CD-49EA-9FC8-7A5F2F89A89A}

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss\{3b49cb51-60cd-49ea-9fc8-7a5f2f89a89a}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    Ubuntu-24.04
    BasePath    REG_SZ    D:\WSL\Ubuntu-24.04

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss\{5f614ddb-e38a-474b-8424-df3771329584}
    DistributionName    REG_SZ    docker-desktop

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss\{0a1b2c3d-0000-4000-8000-000000000001}
    DistributionName    REG_SZ    Debian
`

describe('wsl distributions', () => {
  it('lists user distributions with the default one and skips Docker Desktop', () => {
    expect(parseWslDistributions(output)).toEqual({ names: ['Ubuntu-24.04', 'Debian'], defaultName: 'Ubuntu-24.04' })
  })

  it('puts the default distribution first even when it is registered later', () => {
    const debianDefault = output.replace('{3B49CB51-60CD-49EA-9FC8-7A5F2F89A89A}', '{0A1B2C3D-0000-4000-8000-000000000001}')
    expect(parseWslDistributions(debianDefault)).toEqual({ names: ['Debian', 'Ubuntu-24.04'], defaultName: 'Debian' })
    expect(parseWslDistributions('')).toEqual({ names: [], defaultName: null })
  })

  it('opens a distribution at its home folder', () => {
    expect(wslStartDirectory('Ubuntu-24.04')).toBe(String.raw`\\wsl.localhost\Ubuntu-24.04\home`)
  })
})
