import type { ServiceLaunch } from '../../shared/service/localServiceProtocol'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { createChildProcessEnvironment } from '../process/childProcessEnvironment'

const execute = promisify(execFile)
export interface ServiceSession { userId: string, sessionId: string }
const unsafeEnvironment = ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV']
const displayEnvironment = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'KDE_SESSION_VERSION']

async function run(command: string, args: string[]) {
  return (await execute(command, args, { env: createChildProcessEnvironment({ source: process.env }), timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim()
}

export async function readServiceSession(): Promise<ServiceSession> {
  if (process.platform === 'win32') {
    const result = await run(windowsSystem('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `[pscustomobject]@{userId=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;sessionId=[string][Diagnostics.Process]::GetProcessById(${process.pid}).SessionId}|ConvertTo-Json -Compress`])
    return z.object({ userId: z.string().regex(/^S-1-[\d-]+$/), sessionId: z.string().regex(/^\d+$/) }).strict().parse(JSON.parse(result))
  }
  const userId = String(process.getuid?.())
  if (!/^\d+$/.test(userId) || userId === '0')
    throw new Error('SERVICE_USER_SESSION_REQUIRED')
  if (process.platform === 'linux') {
    const session = process.env.XDG_SESSION_ID
    if (!session || !/^[\w.-]{1,128}$/.test(session))
      throw new Error('SERVICE_USER_SESSION_REQUIRED')
    const owner = await run('/usr/bin/loginctl', ['show-session', session, '--property=User', '--value'])
    if (owner !== userId)
      throw new Error('SERVICE_SESSION_OWNER_CHANGED')
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    return { userId, sessionId: `${boot}:${session}` }
  }
  if (process.platform === 'darwin') {
    await run('/bin/launchctl', ['print', `gui/${userId}`])
    const boot = await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])
    return { userId, sessionId: `${boot}:gui/${userId}` }
  }
  throw new Error('SERVICE_PLATFORM_UNSUPPORTED')
}

export class SessionServiceRegistration {
  readonly name: string
  readonly #launch: ServiceLaunch
  readonly #configPath: string
  readonly #launcher: string

  constructor(launch: ServiceLaunch, configPath: string, launcher: string) {
    this.#launch = launch
    this.#configPath = configPath
    this.#launcher = launcher
    this.name = `lexora-core-${createHash('sha256').update(`${launch.defaultRoot ?? launch.profileRoot}\0${launch.sessionId}`).digest('hex').slice(0, 24)}`
  }

  async start(): Promise<void> {
    const session = await readServiceSession()
    if (session.userId !== this.#launch.userId || session.sessionId !== this.#launch.sessionId)
      throw new Error('SERVICE_SESSION_CHANGED')
    if (process.platform === 'linux') {
      const unit = `${this.name}.service`
      const state = await run('/usr/bin/systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value'])
      if (state === 'active' || state === 'activating')
        return
      const environment = displayEnvironment.flatMap(key => process.env[key] !== undefined ? [`--setenv=${key}=${process.env[key]}`] : [])
      await run('/usr/bin/systemd-run', ['--user', '--collect', `--unit=${unit}`, '--property=Type=exec', '--property=PartOf=graphical-session.target', '--property=After=graphical-session.target', '--property=Restart=on-failure', '--property=RestartSec=2s', '--property=StartLimitBurst=3', '--property=StartLimitIntervalSec=60s', '--property=KillMode=mixed', '--property=TimeoutStopSec=30s', `--property=UnsetEnvironment=${unsafeEnvironment.join(' ')}`, ...environment, '--', this.#launcher, '--launch-service', this.#configPath])
      return
    }
    if (process.platform === 'win32') {
      const task = `\\Lexora\\${this.name}`
      const xmlPath = join(dirname(this.#configPath), `${this.name}.xml`)
      const query = await run(windowsSystem('schtasks.exe'), ['/Query', '/TN', task, '/XML']).catch(() => null)
      if (query && /<Enabled>false<\/Enabled>/i.test(query))
        throw new Error('SERVICE_SESSION_ENTRY_DISABLED')
      if (!query) {
        await writeFile(xmlPath, windowsServiceTask(this.#launch.userId, this.#launcher, this.#configPath), { mode: 0o600 })
        await run(windowsSystem('schtasks.exe'), ['/Create', '/TN', task, '/XML', xmlPath])
      }
      await run(windowsSystem('schtasks.exe'), ['/Run', '/TN', task])
      return
    }
    if (process.platform === 'darwin') {
      const domain = `gui/${this.#launch.userId}`
      const label = `app.uselexora.${this.name}`
      const path = join(dirname(this.#configPath), `${label}.plist`)
      const disabled = await run('/bin/launchctl', ['print-disabled', domain])
      if (disabled.includes(`"${label}" => true`))
        throw new Error('SERVICE_SESSION_ENTRY_DISABLED')
      const loaded = await run('/bin/launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false)
      if (!loaded) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, macosServiceAgent(label, this.#launcher, this.#configPath), { mode: 0o600 })
        await run('/bin/launchctl', ['bootstrap', domain, path])
      }
      await run('/bin/launchctl', ['kickstart', `${domain}/${label}`])
      return
    }
    throw new Error('SERVICE_PLATFORM_UNSUPPORTED')
  }
}

function windowsSystem(path: string): string {
  if (!process.env.SystemRoot)
    throw new Error('SERVICE_SYSTEM_DIRECTORY_UNAVAILABLE')
  return join(process.env.SystemRoot, 'System32', path)
}
function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;')
}
function quoteWindows(value: string) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}
export function windowsServiceTask(userId: string, executable: string, config: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="User"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>${xml(executable)}</Command><Arguments>--launch-service ${xml(quoteWindows(config))}</Arguments></Exec></Actions></Task>`
}
export function macosServiceAgent(label: string, executable: string, config: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string><string>--launch-service</string><string>${xml(config)}</string></array><key>LimitLoadToSessionType</key><string>Aqua</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>30</integer></dict></plist>`
}
