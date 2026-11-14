import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const args = new Map(process.argv.slice(2).reduce((entries, value, index, values) => value.startsWith('--') ? [...entries, [value.slice(2), values[index + 1]]] : entries, []))
for (const key of ['serial', 'output']) assert(args.get(key), `Missing --${key}`)
const output = args.get('output')
await mkdir(output, { recursive: true })
const packageName = 'app.uselexora.mobile.dev'
const token = randomUUID()
const marker = `files/process-recovery-${token}.json`
const adb = (...parameters) => execute(args.get('adb') ?? 'adb', ['-s', args.get('serial'), ...parameters], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
const instrument = phase => adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.uselexora.mobile.ProcessRecoveryInstrumentedTest', '-e', 'processRecoveryToken', token, '-e', 'processRecoveryPhase', phase, '-e', 'processRecoveryPairing', String(Boolean(args.get('pairing'))), `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`)
let preparing
try {
  if (args.get('pairing'))
    await adb('push', args.get('pairing'), `/data/local/tmp/lexora-recovery-${token}.json`)
  let preparationFinished = false
  preparing = instrument('prepare').then(result => ({ result }), error => ({ error })).then(async (outcome) => {
    await writeFile(join(output, 'preparation.txt'), outcome.result?.stdout ?? String(outcome.error))
    preparationFinished = true
    return outcome
  })
  let checkpoint
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    assert(!preparationFinished, 'Preparation ended before its checkpoint; see preparation.txt')
    try {
      checkpoint = JSON.parse((await adb('shell', 'run-as', packageName, 'cat', marker)).stdout)
      break
    }
    catch {}
    await setTimeout(200)
  }
  assert(checkpoint?.pid > 0, 'Preparation did not persist its checkpoint')
  assert.equal((await adb('shell', 'pidof', packageName)).stdout.trim(), String(checkpoint.pid))
  await adb('shell', 'am', 'force-stop', packageName)
  const interrupted = await preparing
  await writeFile(join(output, 'interrupted.txt'), interrupted.result?.stdout ?? String(interrupted.error))
  assert.match(interrupted.result?.stdout ?? '', /Process crashed|INSTRUMENTATION_FAILED|shortMsg=Process crashed/, 'Instrumentation was not interrupted by process termination')
  const recovered = await instrument('verify')
  await writeFile(join(output, 'recovered.txt'), recovered.stdout)
  assert.match(recovered.stdout, /OK \(1 test\)/)
  assert.doesNotMatch(recovered.stdout, /INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES/)
  const screenshot = await execute(args.get('adb') ?? 'adb', ['-s', args.get('serial'), 'exec-out', 'run-as', packageName, 'cat', `files/process-recovery-${token}.png`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
  await writeFile(join(output, 'android-recovered.png'), screenshot.stdout)
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, action: 'am force-stop', terminatedPid: checkpoint.pid, inputPreserved: true, nativeDraftRestored: true, currentInputPreserved: true, executionSettingsPreserved: true, originalCommandReconciled: true, serverPrefixResumed: true, duplicateAdoptionPrevented: true }, null, 2))
}
finally {
  await adb('shell', 'am', 'force-stop', packageName)
  await preparing
  await adb('shell', 'rm', '-f', `/data/local/tmp/lexora-recovery-${token}.json`)
  await adb('shell', 'run-as', packageName, 'rm', '-f', marker, `files/process-recovery-${token}.png`)
}
