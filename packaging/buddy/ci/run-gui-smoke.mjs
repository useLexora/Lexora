import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { resolveBuddyOutputPaths } from '../release/output-paths.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const outputPaths = resolveBuddyOutputPaths(repoRoot)
const nativePetShutdownTimeoutMs = 3_000
async function main() {
  const desktopOnly = process.argv.includes('--desktop-only')
  const desktopPath = resolve(
    process.env.LEXORA_DESKTOP_EXECUTABLE_PATH
    ?? resolve(outputPaths.package.desktop, 'linux-unpacked/lexora-buddy'),
  )
  const binaryPath = resolve(
    process.env.LEXORA_BUDDY_PET_PATH
    ?? resolve(outputPaths.build.native, 'release/lexora-buddy-pet'),
  )
  const smokeRoot = mkdtempSync(join(tmpdir(), 'lexora-desktop-smoke-'))
  try {
    const lexoraHome = join(smokeRoot, 'home')
    await mkdir(lexoraHome, { mode: 0o700, recursive: true })
    await writeFile(join(lexoraHome, 'config.toml'), '[pet]\nenabled = false\n', { mode: 0o600 })
    const smokeEnv = {
      ...process.env,
      LEXORA_BUDDY_PET_SOCKET: join(smokeRoot, 'native-pet.sock'),
      LEXORA_HOME: lexoraHome,
    }

    await runDesktopSmoke(desktopPath, smokeEnv)
    if (!desktopOnly) {
      const petFixture = await prepareStandalonePetSmokeFixture(smokeRoot)
      await runNativePetSmoke(binaryPath, 12_000, {
        ...smokeEnv,
        LEXORA_BUDDY_PET_SOCKET: petFixture.socketPath,
        LEXORA_HOME: petFixture.lexoraHome,
      })
    }
    writeOutput(desktopOnly
      ? 'Lexora Buddy Desktop GUI smoke passed'
      : 'Lexora Buddy Desktop and standalone pet GUI smoke passed')
  }
  finally {
    await rm(smokeRoot, { force: true, recursive: true })
  }
}

export async function prepareStandalonePetSmokeFixture(smokeRoot) {
  const lexoraHome = join(smokeRoot, 'pet-home')
  await mkdir(lexoraHome, { mode: 0o700, recursive: true })
  await writeFile(
    join(lexoraHome, 'config.toml'),
    '[pet]\nenabled = true\nalways_on_top = false\nremember_position = false\n',
    { mode: 0o600 },
  )
  return {
    lexoraHome,
    socketPath: join(smokeRoot, 'standalone-native-pet.sock'),
  }
}

export function runDesktopSmoke(executablePath, env, timeoutMs = 30_000) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawnGui(executablePath, {
      ...env,
      LEXORA_DESKTOP_SMOKE_TEST: '1',
    }, env.LEXORA_GUI_SMOKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectSmoke(new Error(`Desktop smoke did not exit within ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      rejectSmoke(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolveSmoke()
        return
      }

      rejectSmoke(new Error(`Desktop smoke failed: ${signal ?? code}; ${stderr.trim()}`))
    })
  })
}

export function runNativePetSmoke(runtimePath, timeoutMs = 12_000, env = process.env) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawnGui(runtimePath, env, ['--native-pet'], 'pipe')
    const query = {
      protocolVersion: 1,
      messageId: 'message_019f4900-0000-7000-8000-000000000105',
      type: 'queryState',
      requestId: 'state_019f4900-0000-7000-8000-000000000105',
    }
    let settled = false
    let ready = false
    let receivedState = false
    let terminationError
    let stdout = ''
    let stderr = ''
    let shutdownTimeout
    const responseTimeout = setTimeout(() => {
      terminate(new Error(`native pet did not ${ready ? 'return state' : 'become ready'} within ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdin.on('error', terminate)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 8_192) {
        terminate(new Error('native pet smoke response exceeds 8192 characters'))
        return
      }
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        handleLine(line)
        newline = stdout.indexOf('\n')
      }
    })
    function handleLine(line) {
      if (receivedState || terminationError)
        return
      if (line === 'event:ready' && !ready) {
        ready = true
        child.stdin.write(`${JSON.stringify(query)}\n`)
        return
      }
      if (!ready || !line.startsWith('{'))
        return
      let response
      try {
        response = JSON.parse(line)
      }
      catch {
        terminate(new Error('native pet returned invalid JSON'))
        return
      }
      if (response.type !== 'stateSnapshot')
        return
      if (response.protocolVersion !== query.protocolVersion
        || response.correlationId !== query.messageId
        || response.requestId !== query.requestId
        || !Number.isInteger(response.position?.x)
        || !Number.isInteger(response.position?.y)) {
        terminate(new Error('native pet returned an invalid state snapshot'))
        return
      }
      receivedState = true
      clearTimeout(responseTimeout)
      child.kill('SIGTERM')
      shutdownTimeout = setTimeout(() => {
        terminate(new Error(`native pet did not exit within ${nativePetShutdownTimeoutMs}ms after state query`))
      }, nativePetShutdownTimeoutMs)
    }
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_048)
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => {
      if (!settled) {
        finish(terminationError ?? (receivedState && (code === 0 || signal === 'SIGTERM')
          ? undefined
          : new Error(`native pet smoke failed: ${signal ?? code}; ready=${ready}; state=${receivedState}; ${stderr.trim()}`)))
      }
    })

    function terminate(error) {
      terminationError ??= error
      child.kill('SIGKILL')
    }

    function finish(error) {
      if (settled)
        return

      settled = true
      clearTimeout(responseTimeout)
      clearTimeout(shutdownTimeout)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      if (error)
        rejectSmoke(error)
      else
        resolveSmoke()
    }
  })
}

function spawnGui(executablePath, env, args = [], stdin = 'ignore') {
  return spawn(executablePath, args, {
    cwd: repoRoot,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
