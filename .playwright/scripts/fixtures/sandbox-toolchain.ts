import type { MessagePort } from 'node:worker_threads'
import type { SandboxHostOptions } from '../../../apps/buddy/electron/main/sandbox/registerSandboxHostRpc'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import childProcess, { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { MessageChannel } from 'node:worker_threads'
import { registerSandboxHostRpc } from '../../../apps/buddy/electron/main/sandbox/registerSandboxHostRpc'
import { RuntimeRpcPeer } from '../../../apps/buddy/platform/ipc/runtimeRpcPeer'
import { createToolchainEnvironment } from '../../../apps/buddy/platform/process/toolchainEnvironment'
import { ShellSandboxClient } from '../../../apps/buddy/service/src/sandbox/ShellSandboxClient'

type Scenario = 'xdg' | 'explicit' | 'empty-home'

interface CommandResult {
  name: string
  command: string
  readOnly?: boolean
  exitCode: number | null
  output: string
  elapsedMs: number
}

const quote = (value: string) => `'${value.replaceAll('\'', '\'\'')}'`
const setup = promisify(execFile)

export async function verifyWindowsMise(options: SandboxHostOptions, input: { mise: string, node: string, scenario: Scenario }) {
  const report = {
    scenario: input.scenario,
    passed: false,
    error: undefined as string | undefined,
    layout: {} as Record<string, string>,
    identity: {} as Record<string, unknown>,
    setup: [] as CommandResult[],
    commands: [] as CommandResult[],
    checks: [] as string[],
    nativeDiagnostics: '',
  }
  const originalEnvironment = { ...process.env }
  const originalSpawn = childProcess.spawn
  childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args)
    if (String(args[0]).endsWith('lexora-buddy-sandbox.exe'))
      child.stderr?.on('data', data => report.nativeDiagnostics = `${report.nativeDiagnostics}${data}`.slice(-16_384))
    return child
  }) as typeof originalSpawn
  syncBuiltinESMExports()
  let directory: string | undefined
  let disposeRpc: (() => Promise<void>) | undefined
  try {
    assert.equal(process.platform, 'win32')
    assert(isAbsolute(input.mise) && isAbsolute(input.node), 'mise and Node must be absolute paths')
    assert(options.windowsShell, 'PowerShell 7 is required')
    const shell = options.windowsShell
    const identity = await setup(shell, ['-NoLogo', '-NoProfile', '-Command', '$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($id); @{ administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); sid = $id.User.Value; priority = [Diagnostics.Process]::GetCurrentProcess().PriorityClass.ToString() } | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15_000 })
    report.identity = JSON.parse(identity.stdout)
    assert.equal(report.identity.administrator, false, 'Run this fixture with a non-elevated user token')
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lexora-mise-')))
    await setup(shell, ['-NoLogo', '-NoProfile', '-Command', `$acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false); foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) { $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath ${quote(directory)} -AclObject $acl -ErrorAction Stop`], { windowsHide: true, timeout: 15_000 })

    const home = join(directory, '主目录 HOME')
    const profile = join(directory, '用户 Profile')
    const local = join(profile, 'AppData', 'Local')
    const workspace = join(directory, '工作区 Space')
    const runtime = join(home, 'Node runtime')
    const hostTemp = join(directory, '宿主 Temp')
    const custom = input.scenario === 'explicit'
    const data = custom ? join(home, 'mise 数据') : join(local, 'mise')
    const config = custom ? join(home, 'mise 配置') : join(profile, '.config', 'mise')
    const state = custom ? join(home, 'mise 状态') : join(profile, '.local', 'state', 'mise')
    const cache = custom ? join(home, 'mise 缓存') : join(hostTemp, 'mise')
    const mise = join(home, 'mise bin', 'mise.exe')
    const node = join(runtime, 'node.exe')
    const environment = {
      SystemRoot: originalEnvironment.SystemRoot!,
      WINDIR: originalEnvironment.SystemRoot!,
      ComSpec: join(originalEnvironment.SystemRoot!, 'System32', 'cmd.exe'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      HOME: input.scenario === 'empty-home' ? '' : home,
      USERPROFILE: profile,
      HOMEDRIVE: parse(profile).root.slice(0, 2),
      HOMEPATH: profile.slice(2),
      APPDATA: join(profile, 'AppData', 'Roaming'),
      LOCALAPPDATA: local,
      TEMP: hostTemp,
      TMP: hostTemp,
      PATH: [join(data, 'shims'), dirname(mise), join(originalEnvironment.SystemRoot!, 'System32')].join(';'),
      MISE_SYSTEM_CONFIG_DIR: join(home, 'mise system'),
      ...(!custom ? { XDG_CONFIG_HOME: dirname(config), XDG_STATE_HOME: dirname(state) } : {}),
      MISE_OFFLINE: '1',
      MISE_HIDE_UPDATE_WARNING: '1',
      ...(custom ? { MISE_DATA_DIR: data, MISE_CONFIG_DIR: config, MISE_CACHE_DIR: cache, MISE_STATE_DIR: state } : {}),
    }
    report.layout = { directory, home, profile, workspace, runtime, data, config, state, cache, mise, node, hostTemp }
    for (const path of [home, profile, local, workspace, runtime, hostTemp, data, config, state, cache, dirname(mise), environment.APPDATA, environment.MISE_SYSTEM_CONFIG_DIR])
      await mkdir(path, { recursive: true })
    await copyFile(input.node, node)
    await copyFile(input.mise, mise)
    await copyFile(join(dirname(input.mise), 'mise-shim.exe'), join(dirname(mise), 'mise-shim.exe'))
    const nodeIdentity = JSON.parse((await setup(node, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron??null})'], { env: environment, timeout: 15_000 })).stdout)
    assert.equal(nodeIdentity.electron, null, 'Pass Playwright Node, not Electron, as the linked runtime')
    report.identity.node = nodeIdentity.node
    const ceiling = `ceiling_paths = [${JSON.stringify(directory.replaceAll('\\', '/'))}]\n`
    for (const root of [home, workspace])
      await writeFile(join(root, '.miserc.toml'), ceiling)
    await writeFile(join(config, 'config.toml'), '[settings]\nparanoid = true\nauto_install = false\noffline = true\n')
    const project = join(workspace, 'mise.toml')
    await writeFile(project, '[tools]\nnode = "fixture"\n[env]\nLEXORA_TOOLCHAIN_FIXTURE = "MISE_ENV_OK"\n')
    const credentials = [...new Set([environment.HOME || profile, profile])].map(root => join(root, '.ssh', 'id_ed25519'))
    for (const credential of credentials) {
      await mkdir(dirname(credential), { recursive: true })
      await writeFile(credential, 'SYNTHETIC_MISE_CREDENTIAL')
    }
    for (const args of [['--version'], ['link', 'node@fixture', runtime], ['trust', project], ['reshim'], ['settings', 'get', 'paranoid'], ['settings', 'get', 'auto_install']]) {
      const start = performance.now()
      const record: CommandResult = { name: args.join(' '), command: args.join(' '), exitCode: null, output: '', elapsedMs: 0 }
      report.setup.push(record)
      try {
        const result = await setup(mise, args, { cwd: home, env: environment, windowsHide: true, timeout: 30_000 })
        Object.assign(record, { exitCode: 0, output: result.stdout + result.stderr })
        if (args[2] === 'paranoid')
          assert.equal(result.stdout.trim(), 'true')
        if (args[2] === 'auto_install')
          assert.equal(result.stdout.trim(), 'false')
      }
      catch (error) {
        const failure = error as Error & { code?: number, stdout?: string, stderr?: string }
        Object.assign(record, { exitCode: typeof failure.code === 'number' ? failure.code : null, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message}` })
        throw error
      }
      finally { record.elapsedMs = performance.now() - start }
    }
    const shimNames = (await readdir(join(data, 'shims'))).filter(file => /^node\.(?:exe|cmd)$/i.test(file))
    assert(shimNames.length > 0, 'Real mise reshim must produce node.exe or node.cmd')
    report.layout.shims = shimNames.join(';')

    const cleared = new Set(Object.keys(createToolchainEnvironment(process.env, 'win32')))
    for (const key of Object.keys(process.env)) {
      if (cleared.has(key.toUpperCase()) || /^(?:MISE_|XDG_|__MISE|NODE_|ELECTRON_RUN_AS_NODE$)/i.test(key))
        delete process.env[key]
    }
    Object.assign(process.env, environment)
    const channel = new MessageChannel()
    const peer = (port: MessagePort) => new RuntimeRpcPeer({
      transport: {
        postMessage: message => port.postMessage(message),
        subscribe(listener) {
          port.on('message', listener)
          return () => port.off('message', listener)
        },
      },
    })
    const host = peer(channel.port1)
    const runtimePeer = peer(channel.port2)
    const disposeHost = registerSandboxHostRpc(host, options)
    const client = new ShellSandboxClient(runtimePeer)
    disposeRpc = async () => {
      try {
        await client.dispose()
      }
      finally {
        try {
          await disposeHost.dispose()
        }
        finally {
          host.close(new Error('Mise verification completed'))
          runtimePeer.close(new Error('Mise verification completed'))
          channel.port1.close()
          channel.port2.close()
        }
      }
    }
    const execute = async (name: string, command: string, readOnly = false) => {
      command = `$env:MISE_OFFLINE = '1'; $env:MISE_HIDE_UPDATE_WARNING = '1'; ${command}`
      const record: CommandResult = { name, command, readOnly, exitCode: null, output: '', elapsedMs: 0 }
      report.commands.push(record)
      const start = performance.now()
      try {
        const output: Buffer[] = []
        const result = await client.exec({ command, cwd: workspace, roots: [workspace], workspaceRoots: [workspace], resourceReadRoots: [directory!], additionalDirectories: [], readOnly, timeout: 30 }, {
          onData: data => output.push(data),
        }, async () => false)
        record.exitCode = result.exitCode
        record.output = Buffer.concat(output).toString('utf8')
        return record
      }
      catch (error) {
        record.output += error instanceof Error ? error.message : String(error)
        throw error
      }
      finally { record.elapsedMs = performance.now() - start }
    }
    const succeeded = (result: CommandResult) => assert.equal(result.exitCode, 0, JSON.stringify(result))
    await client.prepare([workspace])
    const configRead = await execute('configuration-readable', `Get-Content -LiteralPath ${quote(join(config, 'config.toml'))} -Raw -ErrorAction Stop`)
    succeeded(configRead)
    await execute('mise-directories', `& ${quote(mise)} doctor --json | ConvertFrom-Json | Select-Object dirs,config_files | ConvertTo-Json -Depth 5 -Compress`)
    const shellIdentity = await execute('no-profile', '$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($id); @{ administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); noProfile = [Environment]::GetCommandLineArgs() -contains "-NoProfile" } | ConvertTo-Json -Compress')
    succeeded(shellIdentity)
    const sandboxIdentity = JSON.parse(shellIdentity.output)
    assert.equal(sandboxIdentity.administrator, false)
    assert.equal(sandboxIdentity.noProfile, true)
    report.identity.sandbox = sandboxIdentity
    const version = await execute('mise-version', `& ${quote(mise)} --version; exit $LASTEXITCODE`)
    succeeded(version)
    assert.match(version.output, /\d{4}\.\d+\.\d+/)
    for (const setting of ['paranoid', 'auto_install']) {
      const result = await execute(setting, `& ${quote(mise)} settings get ${setting}; exit $LASTEXITCODE`)
      succeeded(result)
      assert.equal(result.output.trim(), setting === 'paranoid' ? 'true' : 'false')
    }
    const expression = 'JSON.stringify({marker:process.env.LEXORA_TOOLCHAIN_FIXTURE,execPath:process.execPath,home:process.env.HOME,profile:process.env.USERPROFILE,data:process.env.MISE_DATA_DIR??null,config:process.env.MISE_CONFIG_DIR??null,cache:process.env.MISE_CACHE_DIR??null,state:process.env.MISE_STATE_DIR??null})'
    const invocations = [
      ['mise-exec', `& ${quote(mise)} exec -- node -p ${quote(expression)}`],
      ...shimNames.map(name => [`shim-${name}`, `& ${quote(join(data, 'shims', name))} -p ${quote(expression)}`]),
      ['path-node', `node -p ${quote(expression)}`],
    ]
    for (const readOnly of [false, false, true]) {
      for (const [name, command] of invocations) {
        const result = await execute(name!, `${command}; exit $LASTEXITCODE`, readOnly)
        succeeded(result)
        const records = result.output.split(/\r?\n/).filter(line => line.startsWith('{"marker":'))
        assert.equal(records.length, 1, result.output)
        const value = JSON.parse(records[0]!)
        assert.equal(value.marker, 'MISE_ENV_OK')
        assert.equal((await realpath(value.execPath)).toLowerCase(), (await realpath(node)).toLowerCase())
        assert.notEqual((await realpath(value.execPath)).toLowerCase(), (await realpath(input.node)).toLowerCase())
        assert.equal(value.home, environment.HOME || profile)
        assert.equal(value.profile, profile)
        for (const key of ['data', 'config', 'cache', 'state'] as const)
          assert.equal(value[key], custom ? report.layout[key] : null)
      }
    }
    report.checks.push('read-only-toolchain-resources', 'mise-exec-and-real-shims', 'repeat', 'read-only-toolchain', 'home-and-directory-environment', 'no-profile')
    for (const readOnly of [false, true]) {
      for (const root of [home, profile, data, ...(readOnly ? [workspace] : [])]) {
        const forbidden = join(root, `forbidden-${readOnly}.txt`)
        const result = await execute('outside-write-denied', `Set-Content -LiteralPath ${quote(forbidden)} -Value forbidden -ErrorAction Stop`, readOnly)
        assert.equal(result.exitCode, 1, JSON.stringify(result))
        await assert.rejects(readFile(forbidden), { code: 'ENOENT' })
      }
      for (const credential of credentials) {
        const result = await execute('credential-read-denied', `Get-Content -LiteralPath ${quote(credential)} -ErrorAction Stop`, readOnly)
        assert.equal(result.exitCode, 1, JSON.stringify(result))
        assert(!result.output.includes('SYNTHETIC_MISE_CREDENTIAL'), JSON.stringify(result))
      }
      const temporary = await execute('private-temp-write', '$file = Join-Path $env:TEMP "mise-private.txt"; Set-Content -LiteralPath $file -Value "PRIVATE_TEMP_OK" -NoNewline -ErrorAction Stop; @{ marker = (Get-Content -LiteralPath $file -Raw -ErrorAction Stop); temp = $env:TEMP } | ConvertTo-Json -Compress', readOnly)
      succeeded(temporary)
      const value = JSON.parse(temporary.output)
      assert.equal(value.marker, 'PRIVATE_TEMP_OK')
      assert.notEqual(value.temp.toLowerCase(), hostTemp.toLowerCase())
    }
    report.checks.push('outside-home-and-data-write-denied', credentials.length === 2 ? 'both-home-credentials-denied' : 'fallback-home-credentials-denied', 'private-temp-writable')
    report.passed = true
  }
  catch (error) {
    report.error = error instanceof Error ? `${error.stack ?? error.message}\n${JSON.stringify({ code: Reflect.get(error, 'code'), data: Reflect.get(error, 'data') })}` : String(error)
  }
  finally {
    try {
      await disposeRpc?.()
    }
    catch (error) {
      report.passed = false
      report.error = `${report.error ?? ''}\nRPC cleanup: ${String(error)}`
    }
    finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnvironment))
          delete process.env[key]
      }
      Object.assign(process.env, originalEnvironment)
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true })
        }
        catch (error) {
          report.passed = false
          report.error = `${report.error ?? ''}\nFixture cleanup: ${String(error)}`
        }
      }
    }
  }
  return report
}
