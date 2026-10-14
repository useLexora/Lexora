import { spawn } from 'node:child_process'

export function launchWindowsUpdateInstaller(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['/S', '--updated'], { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
