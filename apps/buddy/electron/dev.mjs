import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BUDDY_DEVELOPMENT_RESTART_EXIT_CODE } from '../shared/runtime/profile.ts'

const cli = join(dirname(fileURLToPath(import.meta.resolve('electron-vite/package.json'))), 'bin/electron-vite.js')
let child
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])]) {
  process.on(signal, () => {
    stopping = true
    child?.kill(signal)
  })
}
async function run() {
  let restart = true
  while (restart) {
    if (stopping)
      return
    child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, LEXORA_BUDDY_DEV_LAUNCHER: '1' },
    })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    child = undefined
    restart = !stopping && code === BUDDY_DEVELOPMENT_RESTART_EXIT_CODE
    if (!restart)
      process.exitCode = code
  }
}
void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
