import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const args = new Map(process.argv.slice(2).reduce((entries, value, index, values) => value.startsWith('--') ? [...entries, [value.slice(2), values[index + 1]]] : entries, []))
for (const key of ['serial', 'package', 'apk', 'output']) assert(args.get(key), `Missing --${key}`)
const appPackage = args.get('package')
assert(appPackage.endsWith('.benchmark'), 'Streaming measurement requires the isolated benchmark application')
const seconds = Number(args.get('seconds') ?? 60)
assert(Number.isInteger(seconds) && seconds >= 10 && seconds <= 180)
const output = args.get('output')
await mkdir(output, { recursive: true })
const adb = (...parameters) => execute(args.get('adb') ?? 'adb', ['-s', args.get('serial'), ...parameters], { maxBuffer: 8 * 1024 * 1024, timeout: 20000 })
const shell = async (...parameters) => (await adb('shell', ...parameters)).stdout
const apkSha256 = createHash('sha256').update(await readFile(args.get('apk'))).digest('hex')
const installed = (await shell('pm', 'path', appPackage)).trim().replace(/^package:/, '')
assert((await shell('sha256sum', installed)).startsWith(apkSha256), 'Installed APK does not match the supplied artifact')
const budgets = { rafFrameP95Ms: 64, totalPssKiB: 262144, minimumFrameSamples: 100 }
await writeFile(path.join(output, 'budgets.json'), JSON.stringify({ ...budgets, frozenAt: new Date().toISOString() }, null, 2))
const remoteResult = `/sdcard/Android/data/${appPackage}/files/reader-benchmark.json`
await shell('am', 'force-stop', appPackage)
await shell('rm', '-f', remoteResult)
const start = await shell('am', 'start', '-W', '-n', `${appPackage}/app.uselexora.mobile.ui.MainActivity`, '--ez', 'fixture', 'true', '--ei', 'readerBenchmarkSeconds', String(seconds))
await writeFile(path.join(output, 'start.txt'), start)
const samples = []
let metrics
let completedAt
const started = Date.now()
while (Date.now() - started < (seconds * 2 + 40) * 1000) {
  const main = (await shell('pidof', appPackage)).trim().split(/\s+/).filter(Boolean)
  assert(main.length, 'Benchmark application exited')
  const services = await shell('dumpsys', 'activity', 'services')
  const processes = new Map(main.map(pid => [pid, appPackage]))
  for (const block of services.split(/(?= {2}\* ServiceRecord\{)/)) {
    if (!block.includes('SandboxedProcessService') || !block.includes(appPackage))
      continue
    const linked = /app=ProcessRecord\{[^ ]+ (\d+):([^/}]+)/.exec(block)
    if (linked)
      processes.set(linked[1], linked[2])
  }
  const memory = []
  for (const [pid, name] of processes) {
    const value = await shell('dumpsys', 'meminfo', pid)
    const pssKiB = Number(/^\s*TOTAL(?: PSS)?:\s*(\d+)/m.exec(value)?.[1])
    assert(Number.isFinite(pssKiB), `Missing process memory: ${name}`)
    memory.push({ pid, name, pssKiB })
  }
  const battery = await shell('dumpsys', 'battery')
  samples.push({ elapsedMs: Date.now() - started, processes: memory, totalPssKiB: memory.reduce((sum, item) => sum + item.pssKiB, 0), battery })
  metrics ??= await shell('cat', remoteResult).then(value => JSON.parse(value), () => null)
  if (metrics) {
    completedAt ??= Date.now()
    if (Date.now() - completedAt >= 10000)
      break
  }
  await delay(2000)
}
const peakPssKiB = Math.max(...samples.map(sample => sample.totalPssKiB))
const device = {
  model: (await shell('getprop', 'ro.product.model')).trim(),
  api: Number((await shell('getprop', 'ro.build.version.sdk')).trim()),
  emulator: (await shell('getprop', 'ro.kernel.qemu')).trim() === '1',
}
const result = {
  device,
  package: appPackage,
  apkSha256,
  metrics,
  peakPssKiB,
  settledPssKiB: samples.at(-1)?.totalPssKiB,
  budgets,
  samples,
  energy: { measured: false, reason: 'USB power and charge state are recorded; these are not a battery-discharge energy measurement' },
  scope: 'Foreground 500-message history and sustained output; total PSS includes WebView processes explicitly bound to this application',
  passed: Boolean(metrics?.completed && metrics.frameSamples >= budgets.minimumFrameSamples && metrics.rafFrameP95Ms <= budgets.rafFrameP95Ms && peakPssKiB <= budgets.totalPssKiB && samples.some(sample => sample.processes.length > 1)),
}
await writeFile(path.join(output, 'measurements.json'), JSON.stringify(result, null, 2))
const image = await execute(args.get('adb') ?? 'adb', ['-s', args.get('serial'), 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
assert(image.stdout.length > 0, 'No visible device screenshot')
await writeFile(path.join(output, 'stream-completed.png'), image.stdout)
process.stdout.write(`${JSON.stringify({ ...result, samples: result.samples.length })}\n`)
assert(result.passed, 'Streaming or complete process memory budget exceeded')
