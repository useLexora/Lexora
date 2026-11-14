import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const args = new Map(process.argv.slice(2).reduce((entries, value, index, values) => value.startsWith('--') ? [...entries, [value.slice(2), values[index + 1]]] : entries, []))
for (const key of ['serial', 'package', 'activity', 'apk', 'output']) assert(args.get(key), `Missing --${key}`)
const output = args.get('output')
const recoveryMarker = `Recovery${randomUUID().replaceAll('-', '')}`
await mkdir(output, { recursive: true })
const adb = args.get('adb') ?? 'adb'
const invoke = async (...parameters) => (await execute(adb, ['-s', args.get('serial'), ...parameters], { maxBuffer: 8 * 1024 * 1024 })).stdout
const shell = (...parameters) => invoke('shell', ...parameters)
const start = () => shell('am', 'start', '-W', '-n', `${args.get('package')}/${args.get('activity')}`, ...(args.has('fixture') ? ['--ez', 'fixture', 'true'] : []))
async function dump() {
  await shell('uiautomator', 'dump', '/sdcard/lexora-acceptance.xml')
  const xml = await shell('cat', '/sdcard/lexora-acceptance.xml')
  assert(xml.includes(`package="${args.get('package')}"`), 'Another application owns the focused UI')
  return xml
}
const bounds = node => [...node.matchAll(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][0]?.slice(1).map(Number)
const center = value => [Math.round((value[0] + value[2]) / 2), Math.round((value[1] + value[3]) / 2)]
const device = {
  emulator: (await shell('getprop', 'ro.kernel.qemu')).trim() === '1',
  model: (await shell('getprop', 'ro.product.model')).trim(),
  android: (await shell('getprop', 'ro.build.version.release')).trim(),
  api: Number((await shell('getprop', 'ro.build.version.sdk')).trim()),
  abi: (await shell('getprop', 'ro.product.cpu.abi')).trim(),
  display: (await shell('wm', 'size')).trim(),
  density: (await shell('wm', 'density')).trim(),
}
const budgets = { environment: device.emulator ? 'emulator' : 'physical', coldStartP95Ms: 2500, frameP95Ms: 64, pssKiB: 262144, apkBytes: 40 * 1024 * 1024 }
await writeFile(join(output, 'device.json'), JSON.stringify(device, null, 2))
await writeFile(join(output, 'budgets.json'), JSON.stringify({ ...budgets, frozenAt: new Date().toISOString() }, null, 2))
await invoke('install', '-r', args.get('apk'))
const times = []
for (let index = 0; index < 5; index++) {
  await shell('am', 'force-stop', args.get('package'))
  const result = await start()
  await writeFile(join(output, `cold-start-${index + 1}.txt`), result)
  const value = /TotalTime:\s*(\d+)/.exec(result)
  assert(value, 'No successful Activity startup measurement')
  times.push(Number(value[1]))
  assert((await shell('pidof', args.get('package'))).trim(), 'Application exited during startup')
  const xml = await dump()
  assert(xml.includes('Lexora'), 'Application did not render its interface')
}
async function openTasks() {
  let xml = await dump()
  const search = xml.match(/<node\b[^>]+content-desc="搜索任务"[^>]*>/)?.[0]
  if (search) {
    await shell('input', 'tap', ...center(bounds(search)).map(String))
    xml = await dump()
  }
  return xml
}
async function openFixtureTask() {
  const xml = await openTasks()
  const task = xml.match(/<node\b[^>]+(?:text|content-desc)="任务 1 ·[^>]*>/)?.[0]
  assert(task, 'First fixture task unavailable')
  await shell('input', 'tap', ...center(bounds(task)).map(String))
  return dump()
}
await writeFile(join(output, 'initial.xml'), await openTasks())
await shell('dumpsys', 'gfxinfo', args.get('package'), 'reset')
const taskList = (await dump()).match(/<node\b[^>]+scrollable="true"[^>]*>/)?.[0]
assert(taskList, 'Task list unavailable')
const [left, top, right, bottom] = bounds(taskList)
const x = Math.round((left + right) / 2)
const upper = Math.round(top + (bottom - top) * 0.2)
const lower = Math.round(top + (bottom - top) * 0.8)
for (let index = 0; index < 10; index++) await shell('input', 'swipe', String(x), String(index % 2 ? upper : lower), String(x), String(index % 2 ? lower : upper), '350')
const frames = await shell('dumpsys', 'gfxinfo', args.get('package'), 'framestats')
const memory = await shell('dumpsys', 'meminfo', args.get('package'))
const flutterTimings = args.get('renderer') === 'flutter' ? await shell('cat', `/sdcard/Android/data/${args.get('package')}/files/frame-times.json`) : null
await writeFile(join(output, 'frames.txt'), frames)
await writeFile(join(output, 'memory.txt'), memory)
const editing = await openFixtureTask()
const input = editing.match(/<node\b[^>]+class="android.widget.EditText"[^>]*>/)?.[0]
assert(input, 'Native text input unavailable')
await shell('input', 'tap', ...center(bounds(input)).map(String))
await shell('input', 'keyevent', 'KEYCODE_MOVE_END')
await shell('input', 'text', recoveryMarker)
const keyboard = await shell('dumpsys', 'input_method')
if (/mInputShown=true|mIsInputViewShown=true/.test(keyboard))
  await shell('input', 'keyevent', 'KEYCODE_BACK')
assert((await dump()).includes(recoveryMarker), 'Typed input missing')
await shell('am', 'force-stop', args.get('package'))
await start()
let recovered = await dump()
if (!recovered.includes(recoveryMarker))
  recovered = await openFixtureTask()
assert(recovered.includes(recoveryMarker), 'Process death lost the locally saved draft')
await writeFile(join(output, 'recovered.xml'), recovered)
const screenshot = await execute(adb, ['-s', args.get('serial'), 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
await writeFile(join(output, '01-input-recovered.png'), screenshot.stdout)
const apk = await readFile(args.get('apk'))
const p95 = times.toSorted((a, b) => a - b).at(-1)
let frameP95 = Number(/95th percentile:\s*(\d+)ms/.exec(frames)?.[1] ?? NaN)
let frameMetric = 'Android HWUI'
if (args.get('renderer') === 'flutter') {
  const timings = flutterTimings
  await writeFile(join(output, 'flutter-frame-times.json'), timings)
  const values = JSON.parse(timings).map(value => value / 1000).sort((a, b) => a - b)
  assert(values.length >= 30, 'Insufficient Flutter FrameTiming samples')
  frameP95 = values[Math.ceil(values.length * 0.95) - 1]
  frameMetric = 'Flutter FrameTiming totalSpan (separate renderer instrumentation)'
}
const pss = Number(/^\s*TOTAL(?: PSS)?:\s*(\d+)/m.exec(memory)?.[1] ?? NaN)
const result = { package: args.get('package'), apkSha256: createHash('sha256').update(apk).digest('hex'), apkBytes: apk.length, coldStartMs: times, coldStartP95Ms: p95, frameP95Ms: frameP95, frameMetric, pssKiB: pss, recovery: 'passed', emulatorOnly: device.emulator, device, scope: 'Five cold starts, 1000-task list scrolling, main-process memory snapshot and draft recovery; excludes WebView process memory, sustained streaming, peak memory and energy', budgets, pass: p95 <= budgets.coldStartP95Ms && frameP95 <= budgets.frameP95Ms && pss <= budgets.pssKiB && apk.length <= budgets.apkBytes }
await writeFile(join(output, 'measurements.json'), JSON.stringify(result, null, 2))
await shell('rm', '-f', '/sdcard/lexora-acceptance.xml')
process.stdout.write(`${JSON.stringify(result)}\n`)
assert(result.pass, 'Android baseline performance budget exceeded')
