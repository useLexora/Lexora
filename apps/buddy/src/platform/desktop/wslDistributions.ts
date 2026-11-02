import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'

// Installed WSL distributions, default first; empty when WSL is missing or this is not Windows.
export async function loadWslDistributions(api: LexoraDesktopApi | undefined = window.lexoraDesktop): Promise<string[]> {
  try {
    return api ? [...await api.localChat.spaces.wslDistributions()] : []
  }
  catch {
    return []
  }
}
