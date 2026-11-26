import type { startLocalServiceSupervisor } from './LocalServiceSupervisor'
import process from 'node:process'
import { writeServiceStderr } from './writeServiceStderr'

async function main() {
  if (process.argv[2] === '--verify-install' || process.argv[2]?.startsWith('--verify-install=')) {
    if (process.argv.length !== 3)
      throw new Error('SERVICE_INSTALL_ARGUMENTS_INVALID')
    const full = process.argv[2] === '--verify-install=full'
    const { verifyInstalledRelease } = await import('./validateServiceRelease')
    process.stdout.write(`${await verifyInstalledRelease({ inventory: full })}\n`)
    return
  }
  if (process.argv[2] === '--config' && process.argv.length !== 4)
    throw new Error('SERVICE_CONFIG_ARGUMENTS_INVALID')
  if (process.argv[2] !== '--config') {
    const core = await import('./index')
    if (process.argv[2] === '--check-runtime' && process.argv.length === 3) {
      await Promise.all([import('./LocalServiceSupervisor'), import('./localServiceRuntime')])
      process.stdout.write('Lexora Server runtime ready\n')
    }
    else {
      core.startInheritedService()
    }
    return
  }
  const path = process.argv[3]!
  let supervisor: ReturnType<typeof startLocalServiceSupervisor> | undefined
  let stopping = false
  const stop = () => {
    if (stopping)
      return
    stopping = true
    void supervisor?.stop().catch(() => {
      process.exitCode = 1
      writeServiceStderr('SERVICE_STOP_FAILED\n')
    })
  }
  // Remain a signal owner while shutdown drains, including during runtime dependency evaluation.
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const { readValidatedServiceLaunch } = await import('./validateServiceRelease')
  const initial = await readValidatedServiceLaunch(path)
  if (stopping)
    return
  const { startLocalServiceSupervisor: start } = await import('./LocalServiceSupervisor')
  if (stopping)
    return
  supervisor = start(path, initial)
  await supervisor.ready
}

void main().catch(() => {
  process.exitCode = 1
  writeServiceStderr('SERVICE_START_FAILED\n')
})
