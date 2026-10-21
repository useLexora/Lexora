import process from 'node:process'

const TOOLCHAIN_ENVIRONMENT_NAMES = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'MISE_DATA_DIR',
  'MISE_CONFIG_DIR',
  'MISE_CACHE_DIR',
  'MISE_STATE_DIR',
  'MISE_INSTALLS_DIR',
  'MISE_INSTALL_STORE_DIR',
  'MISE_PLUGINS_DIR',
  'MISE_DOWNLOADS_DIR',
  'MISE_SHIMS_DIR',
  'MISE_SYSTEM_CONFIG_DIR',
  'MISE_SYSTEM_DIR',
  'MISE_SYSTEM_DATA_DIR',
  'MISE_SYSTEM_INSTALLS_DIR',
  'MISE_SYSTEM_SHIMS_DIR',
  'MISE_CONFIG_FILE',
  'MISE_GLOBAL_CONFIG_FILE',
  'MISE_ENV',
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  'FNM_DIR',
  'FNM_MULTISHELL_PATH',
  'VOLTA_HOME',
  'ASDF_DATA_DIR',
  'ASDF_CONFIG_FILE',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'JAVA_HOME',
  'JDK_HOME',
  'SDKMAN_DIR',
  'SDKMAN_CANDIDATES_DIR',
  'GRADLE_USER_HOME',
  'MAVEN_USER_HOME',
  'PYENV_ROOT',
  'PYENV_VERSION',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'UV_CACHE_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'PNPM_HOME',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_USERCONFIG',
] as const

export function createToolchainEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const names = new Set<string>(TOOLCHAIN_ENVIRONMENT_NAMES)
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    const key = platform === 'win32' ? name.toUpperCase() : name
    if (names.has(key) && value && !value.startsWith('()') && !value.includes('\0'))
      environment[key] = value
  }
  return environment
}
