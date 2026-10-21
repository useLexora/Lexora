import { describe, expect, it } from 'vitest'
import { createToolchainEnvironment } from '../toolchainEnvironment'

describe('toolchain environment', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('preserves explicit tool locations without accepting arbitrary tool-prefixed values on %s', (platform) => {
    const locations = {
      XDG_CONFIG_HOME: '/fixture/config',
      XDG_DATA_HOME: '/fixture/data',
      XDG_CACHE_HOME: '/fixture/cache',
      XDG_STATE_HOME: '/fixture/state',
      MISE_DATA_DIR: '/fixture/mise',
      MISE_CONFIG_DIR: '/fixture/mise-config',
      MISE_INSTALLS_DIR: '/fixture/installs',
      MISE_CONFIG_FILE: '/fixture/config.toml',
      MISE_ENV: 'development',
      NVM_DIR: '/fixture/nvm',
      FNM_DIR: '/fixture/fnm',
      VOLTA_HOME: '/fixture/volta',
      ASDF_DATA_DIR: '/fixture/asdf',
      CARGO_HOME: '/fixture/cargo',
      RUSTUP_HOME: '/fixture/rustup',
      GOPATH: '/fixture/go',
      JAVA_HOME: '/fixture/java',
      PYENV_ROOT: '/fixture/pyenv',
      VIRTUAL_ENV: '/fixture/venv',
      PNPM_HOME: '/fixture/pnpm',
      NPM_CONFIG_USERCONFIG: '/fixture/npmrc',
    }
    const source = Object.freeze({
      ...locations,
      MISE_API_TOKEN: 'synthetic-secret',
      MISE_UNKNOWN_SECRET: 'synthetic-secret',
      UNRELATED_SECRET: 'synthetic-secret',
      NODE_OPTIONS: '--require=/fixture/inject.js',
      BASH_ENV: '/fixture/startup.sh',
      SHELLOPTS: 'xtrace',
      LD_PRELOAD: '/fixture/inject.so',
      SSH_AUTH_SOCK: '/fixture/ssh.sock',
      DISPLAY: ':1',
      HTTP_PROXY: 'http://host.invalid:8080',
    })

    expect(createToolchainEnvironment(source, platform)).toEqual(locations)
  })

  it.each(['linux', 'darwin', 'win32'] as const)('rejects empty, undefined, function-shaped and NUL tool values on %s', (platform) => {
    expect(createToolchainEnvironment({
      MISE_DATA_DIR: '() { synthetic; }',
      MISE_CONFIG_DIR: '/fixture/config\0suffix',
      CARGO_HOME: '',
      RUSTUP_HOME: undefined,
      PNPM_HOME: '/fixture/pnpm',
    }, platform)).toEqual({ PNPM_HOME: '/fixture/pnpm' })
  })

  it.each(['linux', 'darwin', 'win32'] as const)('normalizes tool variable spelling only on Windows (%s)', (platform) => {
    expect(createToolchainEnvironment({ mise_data_dir: '/fixture/mise', Cargo_Home: '/fixture/cargo' }, platform))
      .toEqual(platform === 'win32' ? { MISE_DATA_DIR: '/fixture/mise', CARGO_HOME: '/fixture/cargo' } : {})
  })
})
