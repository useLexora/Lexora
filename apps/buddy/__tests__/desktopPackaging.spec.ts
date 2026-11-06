import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const configuration = fileURLToPath(new URL('../electron-builder.config.cjs', import.meta.url))

it.each([
  ['linux', 'x64', true],
  ['win32', 'x64', true],
  ['darwin', 'arm64', true],
  ['linux', 'arm64', false],
  ['win32', 'arm64', false],
] as const)('enables the packaged Node runtime only for supported inference targets: %s-%s', (platform, architecture, enabled) => {
  const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    Object.defineProperty(process, 'arch', { value: ${JSON.stringify(architecture)} });
    process.stdout.write(JSON.stringify(require(${JSON.stringify(configuration)}).electronFuses));
  `], {
    encoding: 'utf8',
    env: { ...process.env, LEXORA_BUDDY_PACKAGE_FORMAT: platform === 'win32' ? 'nsis' : platform === 'darwin' ? 'dmg' : 'deb', LEXORA_MACOS_SIGNING: 'ad-hoc' },
    timeout: 15_000,
  })
  expect(JSON.parse(output)).toMatchObject({
    runAsNode: enabled,
    enableCookieEncryption: true,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
    onlyLoadAppFromAsar: true,
  })
})
