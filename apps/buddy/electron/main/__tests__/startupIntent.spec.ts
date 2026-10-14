import { describe, expect, it } from 'vitest'
import { isInstallerExitRequest } from '../startupIntent'

describe('installer exit intent', () => {
  it('addresses only the original installation and requires the explicit exit argument', () => {
    const executable = 'C:\\Apps\\Lexora Buddy.exe'
    expect(isInstallerExitRequest(['--quit-for-install'], { executablePath: executable.toUpperCase() }, executable)).toBe(true)
    expect(isInstallerExitRequest([], { executablePath: executable }, executable)).toBe(false)
    expect(isInstallerExitRequest(['--quit-for-install'], { executablePath: 'C:\\Other\\Lexora Buddy.exe' }, executable)).toBe(false)
    expect(isInstallerExitRequest(['--quit-for-install'], null, executable)).toBe(false)
  })
})
