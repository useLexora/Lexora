import { describe, expect, it } from 'vitest'
import { parseWslPath } from '../wslPath'

describe('wsl path', () => {
  it.each([
    [String.raw`\\wsl.localhost\Ubuntu-24.04\home\lenovo\code\测试`, { distribution: 'Ubuntu-24.04', linuxPath: '/home/lenovo/code/测试' }],
    ['\\\\WSL$\\Debian\\var\\log\\', { distribution: 'Debian', linuxPath: '/var/log' }],
    ['//wsl.localhost/Ubuntu/home/me', { distribution: 'Ubuntu', linuxPath: '/home/me' }],
    [String.raw`\\wsl.localhost\Ubuntu`, { distribution: 'Ubuntu', linuxPath: '/' }],
  ])('reads %s', (path, expected) => {
    expect(parseWslPath(path)).toEqual(expected)
  })

  it.each([String.raw`C:\Users\me`, String.raw`\\server\share\dir`, '\\\\wsl.localhost\\', '/home/me', ''])('ignores %s', (path) => {
    expect(parseWslPath(path)).toBeNull()
  })
})
