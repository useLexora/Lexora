/* eslint test/no-import-node-test: off */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import * as nativeTest from 'node:test'
import { promisify } from 'node:util'

const executable = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Lexora Buddy Sandbox', 'lexora-buddy-sandbox.exe')
const quote = value => `'${value.replaceAll('\'', '\'\'')}'`
const execFileAsync = promisify(execFile)

async function setFixtureAcl(path, sddl) {
  const command = `$acl=Get-Acl -LiteralPath ${quote(path)}; $acl.SetSecurityDescriptorSddlForm(${quote(sddl)},[Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath ${quote(path)} -AclObject $acl`
  await execFileAsync(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${command}`], { windowsHide: true, timeout: 15_000 })
}

async function listener(host = '127.0.0.1') {
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.end('FIXTURE')
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve))
  return { server, port: server.address().port }
}

async function execute({ command, workspace, grants, port, onReady, onPreparing, measure = false, prepareOnly = false, denyReadScope = dirname(workspace), synchronizeDenials = false }) {
  const privateRoot = await mkdtemp(join(dirname(workspace), 'private-'))
  const home = join(privateRoot, 'home')
  const temporary = join(privateRoot, 'tmp')
  await Promise.all([home, temporary].map(path => mkdir(path)))
  const shell = process.env.BUDDY_SANDBOX_TEST_SHELL ?? join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
  const startedAt = performance.now()
  let readyAt
  let preparingAt
  let releasedAt
  const child = spawn(executable, [prepareOnly ? 'prepare' : 'run'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const observer = measure ? spawn(process.env.BUDDY_SANDBOX_TEST_ADVERSARY, ['--watch-process', String(child.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] }) : undefined
  let observation = ''
  observer?.stdout.on('data', data => observation += data)
  const observed = observer
    ? new Promise((resolve, reject) => {
        observer.once('error', reject)
        observer.once('close', code => code === 0 ? resolve() : reject(new Error(`Handle observer failed: ${code}`)))
      })
    : Promise.resolve()
  const identities = await Promise.all([{ path: homedir(), access: 'read' }, ...grants].map(async (grant) => {
    const metadata = await stat(grant.path, { bigint: true })
    return { ...grant, device: grant.device ?? String(metadata.dev), inode: grant.inode ?? String(metadata.ino) }
  }))
  const chunks = []
  let diagnostics = ''
  let ready = false
  let preparing = false
  child.stdout.on('data', data => chunks.push(data))
  child.stderr.on('data', (data) => {
    diagnostics += data
    if (releasedAt === undefined && diagnostics.includes('"type":"processesReleased"'))
      releasedAt = performance.now()
    if (!preparing && diagnostics.includes('"phase":"filesystem_preparing"')) {
      preparing = true
      preparingAt = performance.now()
      onPreparing?.(child)
    }
    if (!ready && diagnostics.includes('"type":"ready"')) {
      ready = true
      readyAt = performance.now()
      onReady?.(child)
    }
  })
  child.stdin.on('error', () => {})
  child.stdin.write(`${JSON.stringify(prepareOnly ? { grants: identities, denyReadScope, synchronizeDenials } : { command, cwd: workspace, shell, privateRoot, proxyPort: port, grants: identities, denyReadScope, environment: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, ComSpec: join(process.env.SystemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', PSModulePath: join(dirname(shell), 'Modules'), PATH: `${dirname(shell)};${join(process.env.SystemRoot, 'System32')}`, HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary, APPDATA: home, LOCALAPPDATA: home, POWERSHELL_TELEMETRY_OPTOUT: '1' } })}\n`)
  const timer = setTimeout(() => child.stdin.end(), 60_000)
  const killTimer = setTimeout(() => child.kill(), 75_000)
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const buffer = Buffer.concat(chunks)
    const output = buffer.subarray(0, 128).includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
    await observed
    return { exitCode, output, diagnostics, ...(measure ? { measurements: { ...JSON.parse(observation), startupMs: readyAt - startedAt, prepareMs: readyAt - preparingAt, releaseMs: performance.now() - releasedAt, totalMs: performance.now() - startedAt } } : {}) }
  }
  finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    await rm(privateRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 })
  }
}

nativeTest.test('Windows restricted-token behavior and known limits', { skip: process.platform !== 'win32', timeout: 300_000 }, async (t) => {
  const adversaryExecutable = process.env.BUDDY_SANDBOX_TEST_ADVERSARY
  assert.ok(adversaryExecutable, 'Windows acceptance requires its target-specific adversary executable')
  const state = process.env.BUDDY_SANDBOX_TEST_DIRECTORY ?? tmpdir()
  await mkdir(state, { recursive: true })
  const preparedRoot = process.env.BUDDY_SANDBOX_TEST_ROOT
  if (preparedRoot) {
    assert(isAbsolute(preparedRoot), 'A prepared fixture must be an absolute path')
    assert.equal(process.env.BUDDY_SANDBOX_TEST_KEEP_FILES, '1', 'The preparing supervisor owns fixture cleanup')
    const metadata = await lstat(preparedRoot)
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'A prepared fixture must be a real directory')
    assert.deepEqual(await readdir(preparedRoot), [], 'A prepared fixture must be empty')
  }
  const root = await realpath(preparedRoot ?? await mkdtemp(join(state, 'native-sandbox-')))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const outside = join(root, 'outside.txt')
  const secret = join(workspace, '.env')
  await writeFile(outside, 'OUTSIDE_PRIVATE_FIXTURE')
  await writeFile(secret, 'SECRET_FIXTURE')
  const proxy = await listener()
  const other = await listener('0.0.0.0')
  const ipv6 = await listener('::1')
  const remote = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
  try {
    assert.ok(remote, 'Windows acceptance requires a non-loopback network interface')
    await t.test('reconciles late command and workspace denials without releasing another configuration', async () => {
      const readGrant = { path: workspace, access: 'read' }
      const base = { workspace, port: proxy.port, grants: [readGrant] }
      const initialized = await execute({ ...base, prepareOnly: true, synchronizeDenials: true })
      assert.equal(initialized.exitCode, 0, JSON.stringify(initialized))
      const late = join(root, 'late-credentials')
      await mkdir(late)
      const file = join(late, 'token')
      await writeFile(file, 'LATE_CREDENTIAL_FIXTURE')
      const command = `try {[Console]::Out.Write([IO.File]::ReadAllText(${quote(file)}))} catch {[Console]::Out.Write('DENIED')}`
      const denied = await execute({ ...base, command, grants: [readGrant, { path: late, access: 'denyRead' }] })
      assert.equal(denied.exitCode, 0, JSON.stringify(denied))
      assert.equal(denied.output, 'DENIED')
      const merged = await execute({ ...base, prepareOnly: true })
      assert.equal(merged.exitCode, 0, JSON.stringify(merged))
      const kept = await execute({ ...base, command })
      assert.equal(kept.exitCode, 0, JSON.stringify(kept))
      assert.equal(kept.output, 'DENIED')
      const otherScope = join(root, 'other-profile')
      const shared = await execute({ ...base, prepareOnly: true, denyReadScope: otherScope, grants: [readGrant, { path: late, access: 'denyRead' }] })
      assert.equal(shared.exitCode, 0, JSON.stringify(shared))
      const reconciled = await execute({ ...base, prepareOnly: true, synchronizeDenials: true })
      assert.equal(reconciled.exitCode, 0, JSON.stringify(reconciled))
      const sharedRead = await execute({ ...base, command })
      assert.equal(sharedRead.exitCode, 0, JSON.stringify(sharedRead))
      assert.equal(sharedRead.output, 'DENIED')
      const released = await execute({ ...base, prepareOnly: true, denyReadScope: otherScope, synchronizeDenials: true })
      assert.equal(released.exitCode, 0, JSON.stringify(released))
      const readable = await execute({ ...base, command })
      assert.equal(readable.exitCode, 0, JSON.stringify(readable))
      assert.equal(readable.output, 'LATE_CREDENTIAL_FIXTURE')
    })
    await t.test('records the known ACL limit for host-owned Everyone-writable files outside current capabilities', async () => {
      const file = join(root, 'host-owned-public.txt')
      await writeFile(file, 'HOST_OWNED')
      await setFixtureAcl(file, 'D:P(A;;FA;;;OW)(A;;FRFW;;;WD)')
      const observations = []
      for (const access of ['read', 'write']) {
        const command = `$r=@{}; foreach($target in @(@{key='public';path=${quote(file)}},@{key='private';path=${quote(outside)}})){try{[IO.File]::WriteAllText($target.path,'CHANGED');$r[$target.key]='allowed'}catch{$r[$target.key]='denied'}}; [Console]::Out.Write(($r|ConvertTo-Json -Compress))`
        const result = await execute({ command, workspace, port: proxy.port, grants: [{ path: workspace, access }] })
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        observations.push({ access, ...JSON.parse(result.output) })
      }
      t.diagnostic(`Known native ACL write limit, not strict confinement: ${JSON.stringify(observations)}`)
      assert.deepEqual(observations, [{ access: 'read', public: 'allowed', private: 'denied' }, { access: 'write', public: 'allowed', private: 'denied' }])
      assert.equal(await readFile(file, 'utf8'), 'CHANGED')
      assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_PRIVATE_FIXTURE')
    })
    await t.test('records the known inherited-deny limit while enforcing ordinary and explicit credential denies', async () => {
      const credentials = join(root, 'credentials')
      await mkdir(credentials)
      const entries = ['inherited', 'explicit-public', 'protected-public', 'protected-private', 'direct-public']
      for (const entry of entries)
        await writeFile(join(credentials, entry), 'SYNTHETIC_CREDENTIAL')
      await setFixtureAcl(join(credentials, 'explicit-public'), 'D:(A;;FA;;;OW)(A;;FR;;;WD)')
      await setFixtureAcl(join(credentials, 'protected-public'), 'D:P(A;;FA;;;OW)(A;;FR;;;WD)')
      await setFixtureAcl(join(credentials, 'protected-private'), 'D:P(A;;FA;;;OW)')
      await setFixtureAcl(join(credentials, 'direct-public'), 'D:P(A;;FA;;;OW)(A;;FR;;;WD)')
      const command = `$r=@{}; ${entries.map(entry => `try{$r[${quote(entry)}]=[IO.File]::ReadAllText(${quote(join(credentials, entry))})}catch{$r[${quote(entry)}]='denied'}`).join('; ')}; [Console]::Out.Write(($r|ConvertTo-Json -Compress))`
      const result = await execute({ command, workspace, port: proxy.port, grants: [{ path: workspace, access: 'read' }, { path: credentials, access: 'denyRead' }, { path: join(credentials, 'direct-public'), access: 'denyRead' }] })
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      const observations = JSON.parse(result.output)
      t.diagnostic(`Known native ACL read limit, not complete credential isolation: ${JSON.stringify(observations)}`)
      assert.deepEqual(observations, { 'inherited': 'denied', 'explicit-public': 'SYNTHETIC_CREDENTIAL', 'protected-public': 'SYNTHETIC_CREDENTIAL', 'protected-private': 'denied', 'direct-public': 'denied' })
    })
    await t.test('bounds preparation handles and reuses ACLs for large workspaces and toolchains', async () => {
      const tools = join(root, 'toolchain')
      const large = join(root, 'large-workspace')
      await Promise.all([tools, large].map(path => mkdir(path)))
      for (const [path, files] of [[tools, 50_000], [large, 5_000]]) {
        for (let offset = 0; offset < files; offset += 100)
          await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(path, `fixture-${offset + index}`), 'fixture')))
      }
      const command = `[IO.File]::WriteAllText(${quote(join(large, 'result'))},'SCALE_OK'); [Console]::Out.Write([IO.File]::ReadAllText(${quote(join(tools, 'fixture-49999'))}))`
      const prepared = await execute({ command, workspace: large, port: proxy.port, grants: [{ path: large, access: 'write' }], measure: true, prepareOnly: true })
      assert.equal(prepared.exitCode, 0, JSON.stringify(prepared))
      assert.equal(prepared.output, '')
      assert(prepared.measurements.peakHandles < 300, JSON.stringify(prepared.measurements))
      assert(prepared.measurements.startupMs < 30_000, JSON.stringify(prepared.measurements))
      const results = []
      for (let iteration = 0; iteration < 3; iteration++) {
        const result = await execute({ command, workspace: large, port: proxy.port, grants: [{ path: large, access: 'write' }], measure: true })
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        assert.equal(result.output, 'fixture')
        assert(result.measurements.peakHandles < 300, JSON.stringify(result.measurements))
        assert(result.measurements.samples > 0, JSON.stringify(result.measurements))
        assert(result.measurements.startupMs < 5_000, JSON.stringify(result.measurements))
        results.push(result.measurements)
      }
      t.diagnostic(`50000 toolchain files and 5000 workspace files: ${JSON.stringify({ initialization: prepared.measurements, commands: results })}`)
    })
    await t.test('protects files and permits loopback TCP while denying direct non-loopback access', async () => {
      const command = `
$r=@{}
try { $r.outside=[IO.File]::ReadAllText(${quote(outside)}) } catch { $r.outside='denied' }
try { $r.secret=[IO.File]::ReadAllText(${quote(secret)}) } catch { $r.secret='denied' }
[IO.File]::WriteAllText(${quote(join(workspace, 'result.txt'))},'WORKSPACE_WRITE_FIXTURE')
foreach($target in @(@{key='proxy';host='127.0.0.1';port=${proxy.port}},@{key='otherPort';host='127.0.0.1';port=${other.port}},@{key='ipv6';host='::1';port=${ipv6.port}},@{key='nonLoopback';host=${quote(remote)};port=${other.port}})) {
  try { $c=[Net.Sockets.TcpClient]::new(); $t=$c.ConnectAsync($target.host,$target.port); if(!$t.Wait(1500)){throw 'timeout'}; $r[$target.key]='connected'; $c.Dispose() }
  catch { $r[$target.key]='denied' }
}
[Console]::Out.Write(($r | ConvertTo-Json -Compress))
`
      const result = await execute({ command, workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
      await writeFile(join(root, 'report.json'), JSON.stringify(result, null, 2))
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      assert.deepEqual(JSON.parse(result.output), { outside: 'OUTSIDE_PRIVATE_FIXTURE', secret: 'denied', proxy: 'connected', otherPort: 'connected', ipv6: 'connected', nonLoopback: 'denied' })
      assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'WORKSPACE_WRITE_FIXTURE')
    })
    await t.test('enforces ordinary write roots and records the shared-owner revocation limit', async () => {
      const permissionsProbe = join(workspace, 'permissions-probe.exe')
      await copyFile(adversaryExecutable, permissionsProbe)
      const previous = join(root, 'previous-workspace')
      await mkdir(previous)
      const hostFile = join(previous, 'host.txt')
      await writeFile(hostFile, 'HOST')
      const variants = [[workspace, [{ path: workspace, access: 'write' }]], [previous, [{ path: previous, access: 'read' }]]]
      for (const [index, [cwd, grants]] of variants.entries()) {
        const childFile = join(previous, `child-${index}.txt`)
        const first = await execute({ command: `[IO.File]::WriteAllText(${quote(childFile)},'CHILD')`, workspace: previous, port: proxy.port, grants: [{ path: previous, access: 'write' }] })
        assert.equal(first.exitCode, 0, JSON.stringify(first))
        const command = `$r=@{}; foreach($path in @(${quote(hostFile)},${quote(childFile)},${quote(join(previous, 'new.txt'))})){try{[IO.File]::WriteAllText($path,'ESCAPED');$r[$path]='written'}catch{$r[$path]='denied'}}; $r.read=[IO.File]::ReadAllText(${quote(childFile)}); $r.writeDacl=(& ${quote(permissionsProbe)} --volume-metadata ${quote(childFile)} | ConvertFrom-Json).writeDacl; $r.aclWrite=(& ${quote(permissionsProbe)} --rewrite-dacl-write ${quote(childFile)} | ConvertFrom-Json); [Console]::Out.Write(($r|ConvertTo-Json -Compress))`
        const next = await execute({ command, workspace: cwd, port: proxy.port, grants })
        assert.equal(next.exitCode, 0, JSON.stringify(next))
        const { writeDacl, aclWrite, ...ordinary } = JSON.parse(next.output)
        assert.deepEqual(ordinary, { [hostFile]: 'denied', [childFile]: 'denied', [join(previous, 'new.txt')]: 'denied', read: 'CHILD' })
        t.diagnostic(`Shared-owner ACL revocation limit: ${JSON.stringify({ readOnly: index === 1, writeDacl, aclWrite })}`)
        assert.deepEqual({ writeDacl, aclWrite }, { writeDacl: 0, aclWrite: { rewriteDacl: 0, write: 0 } })
        assert.equal(await readFile(childFile, 'utf8'), 'ESCAPED')
      }
    })
    await t.test('preserves explicit workspace and resource exceptions beneath application-private data', async () => {
      const parent = join(root, 'application-private')
      const current = join(parent, 'workspace')
      const resource = join(parent, 'skill')
      await Promise.all([current, resource].map(path => mkdir(path, { recursive: true })))
      await writeFile(join(parent, 'private.txt'), 'PRIVATE')
      await writeFile(join(resource, 'resource.txt'), 'RESOURCE')
      const command = `$r=@{}; [IO.File]::WriteAllText('workspace.txt','WRITABLE'); $r.resource=[IO.File]::ReadAllText(${quote(join(resource, 'resource.txt'))}); try{$r.private=[IO.File]::ReadAllText(${quote(join(parent, 'private.txt'))})}catch{$r.private='denied'}; try{[IO.File]::WriteAllText(${quote(join(resource, 'resource.txt'))},'changed');$r.write='allowed'}catch{$r.write='denied'}; [Console]::Out.Write(($r|ConvertTo-Json -Compress))`
      const result = await execute({ command, workspace: current, port: proxy.port, grants: [{ path: current, access: 'write' }, { path: resource, access: 'read' }, { path: parent, access: 'denyRead', exceptions: [current, resource] }] })
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      assert.deepEqual(JSON.parse(result.output), { resource: 'RESOURCE', private: 'denied', write: 'denied' })
      assert.equal(await readFile(join(current, 'workspace.txt'), 'utf8'), 'WRITABLE')
    })
    await t.test('rejects a directory identity replaced after authorization', async () => {
      const current = join(root, 'replaceable')
      await mkdir(current)
      const metadata = await stat(current, { bigint: true })
      await rename(current, `${current}-retired`)
      await mkdir(current)
      const result = await execute({ command: '[IO.File]::WriteAllText(\'must-not-run\',\'changed\')', workspace: current, port: proxy.port, grants: [{ path: current, access: 'write', device: String(metadata.dev), inode: String(metadata.ino) }] })
      assert.notEqual(result.exitCode, 0, JSON.stringify(result))
      assert(!result.diagnostics.includes('"type":"ready"'), result.diagnostics)
      await assert.rejects(access(join(current, 'must-not-run')))
    })
    await t.test('supports PowerShell paths, file operations and native children', async () => {
      await writeFile(join(workspace, 'result.txt'), 'delete-fixture')
      const compatibility = await execute({ command: `
$ErrorActionPreference='Stop'
$r=@{}
$r.cwd=$PWD.Path
$r.native=(& $env:ComSpec /d /c 'echo NATIVE_FIXTURE')
$r.nativeExit=$LASTEXITCODE
$r.list=@(Get-ChildItem -LiteralPath ${quote(workspace)} -Name)
Set-Content -LiteralPath ${quote(join(workspace, 'roundtrip.txt'))} -Value 'ROUNDTRIP_FIXTURE'
$r.read=(Get-Content -LiteralPath ${quote(join(workspace, 'roundtrip.txt'))} -Raw).Trim()
try { Remove-Item -LiteralPath ${quote(join(workspace, 'result.txt'))}; $r.removed=$true } catch { $r.removed=$false; $r.removeError=$_.Exception.Message }
[Console]::Out.Write(($r | ConvertTo-Json -Compress))
`, workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
      await writeFile(join(root, 'compatibility.json'), JSON.stringify(compatibility, null, 2))
      assert.equal(compatibility.exitCode, 0, JSON.stringify(compatibility))
      const tools = JSON.parse(compatibility.output)
      assert.equal(tools.cwd?.toLowerCase(), workspace.toLowerCase(), JSON.stringify(tools))
      assert.equal(tools.native?.trim(), 'NATIVE_FIXTURE')
      assert.equal(tools.nativeExit, 0)
      assert.equal(tools.read, 'ROUNDTRIP_FIXTURE')
      assert.equal(tools.removed, true)
    })
    await t.test('supports IPv4 and IPv6 loopback listeners while denying wildcard binding in both modes', async () => {
      const command = `
$ErrorActionPreference='Stop'
$r=@{}
foreach($address in @('127.0.0.1','::1')) {
  $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($address),0)
  $l.Start()
  $c=[Net.Sockets.TcpClient]::new()
  $c.Connect($address,$l.LocalEndpoint.Port)
  $peer=$l.AcceptTcpClient()
  $peer.GetStream().WriteByte(85)
  $r[$address]=$c.GetStream().ReadByte()
  $peer.Dispose(); $c.Dispose(); $l.Stop()
}
foreach($address in @('0.0.0.0','::')) {
  $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($address),0)
  try { $l.Start(); $r[$address]='bound' } catch { $r[$address]='denied' }
  finally { $l.Stop() }
}
[Console]::Out.Write(($r | ConvertTo-Json -Compress))
`
      for (const access of ['read', 'write']) {
        const result = await execute({ command, workspace, port: proxy.port, grants: [{ path: workspace, access }, { path: secret, access: 'denyRead' }] })
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        assert.deepEqual(JSON.parse(result.output), { '127.0.0.1': 85, '::1': 85, '0.0.0.0': 'denied', '::': 'denied' })
      }
    })
    await t.test('supports Node children with ignored streams and private named pipes', async () => {
      const node = join(workspace, 'node.exe')
      const script = join(workspace, 'private-ipc.cjs')
      await copyFile(process.execPath, node)
      await writeFile(script, String.raw`
const net = require('node:net')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const timer = setTimeout(() => process.exit(40), 8000)
if (process.argv[2] === 'child') {
  const socket = net.connect(process.argv[3])
  socket.on('error', () => process.exit(41))
  socket.once('data', data => {
    if (data.toString() !== 'PRIVATE_PIPE') process.exit(42)
    socket.end('ACK')
    clearTimeout(timer)
  })
} else {
  const pipe = '\\\\.\\pipe\\LOCAL\\lexora-' + randomUUID()
  let acknowledged = false
  const server = net.createServer(socket => {
    socket.write('PRIVATE_PIPE')
    socket.once('data', data => { acknowledged = data.toString() === 'ACK' })
    socket.on('error', () => process.exit(43))
  })
  server.on('error', error => { console.error(error.code); process.exit(44) })
  server.listen(pipe, () => {
    const child = spawn(process.execPath, [__filename, 'child', pipe], { stdio: 'ignore', windowsHide: true })
    child.on('error', error => { console.error(error.code); process.exit(45) })
    child.once('exit', code => {
      clearTimeout(timer)
      server.close()
      console.log(JSON.stringify({ code, acknowledged }))
      if (code !== 0 || !acknowledged) process.exitCode = 46
    })
  })
}
`)
      const result = await execute({ command: `& ${quote(node)} ${quote(script)}; exit $LASTEXITCODE`, workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }] })
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      assert.deepEqual(JSON.parse(result.output), { code: 0, acknowledged: true })
    })
    await t.test('does not let descendants discard the enforcement identity', async () => {
      const adversary = join(workspace, 'sandbox-adversary.exe')
      await copyFile(adversaryExecutable, adversary)
      const attack = await execute({ command: `$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=${quote(adversary)};$info.Arguments=${quote(`"${secret}"`)};$info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.CreateNoWindow=$true;try {$child=[Diagnostics.Process]::Start($info);$output=$child.StandardOutput.ReadToEnd();$errors=$child.StandardError.ReadToEnd();$child.WaitForExit();$r=@{output=$output;code=$child.ExitCode;errors=$errors}}catch{$r=@{errors=$_.Exception.ToString()}};[Console]::Out.Write(($r|ConvertTo-Json -Compress))`, workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
      await writeFile(join(root, 'token-restriction.json'), JSON.stringify(attack, null, 2))
      assert.equal(attack.exitCode, 0, JSON.stringify(attack))
      const probe = JSON.parse(attack.output)
      assert.equal(probe.code, 0, attack.output)
      assert.match(probe.output.trim(), /^(token|restriction|impersonation|file)-denied$/, 'A descendant must not discard a required denial identity')
    })
    await t.test('preserves child write grants beneath additional parent read grants', async () => {
      const changed = join(workspace, 'overlap.txt')
      const result = await execute({
        command: `[IO.File]::WriteAllText(${quote(changed)},'OVERLAP_WRITE'); try { [IO.File]::WriteAllText(${quote(outside)},'changed'); throw 'unexpected-write' } catch [UnauthorizedAccessException] {}; [Console]::Out.Write('OVERLAP_OK')`,
        workspace,
        port: proxy.port,
        grants: [{ path: root, access: 'read' }, { path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }],
      })
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      assert.match(result.output, /OVERLAP_OK/)
      assert.equal(await readFile(changed, 'utf8'), 'OVERLAP_WRITE')
      assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_PRIVATE_FIXTURE')
    })
    await t.test('allows ordinary ancestor reads without granting mutation rights', async () => {
      const adversary = join(workspace, 'volume-probe.exe')
      await copyFile(adversaryExecutable, adversary)
      const ancestors = []
      for (let current = dirname(workspace); ; current = dirname(current)) {
        ancestors.push(current)
        if (dirname(current) === current)
          break
      }
      const result = await execute({
        command: `$r=@{}; foreach($path in @(${ancestors.map(quote).join(',')})) { $r[$path]=(& ${quote(adversary)} --volume-metadata $path | ConvertFrom-Json); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }; [Console]::Out.Write(($r | ConvertTo-Json -Depth 4 -Compress))`,
        workspace,
        port: proxy.port,
        grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }],
      })
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      const probes = JSON.parse(result.output)
      await writeFile(join(root, 'ancestor-access.json'), JSON.stringify(probes, null, 2))
      for (const path of ancestors) {
        const { queryAttributes, readAttributes, listDirectory, ...denied } = probes[path]
        t.diagnostic(`Ancestor attributes ${path}: query=${queryAttributes}, handle=${readAttributes}`)
        assert.equal(queryAttributes, 0, path)
        assert.equal(listDirectory, 0, path)
        assert.deepEqual(denied, { addFile: 5, addDirectory: 5, deleteChild: 5, writeAttributes: 5, writeExtendedAttributes: 5, writeDacl: 5, writeOwner: 5, delete: 5 }, path)
      }
    })
    await t.test('keeps concurrent command leases independent until both finish', async () => {
      const release = join(workspace, 'release')
      let ready = 0
      const onReady = () => {
        if (++ready === 2)
          void writeFile(release, 'ready')
      }
      const command = `for($i=0;$i -lt 200 -and !(Test-Path -LiteralPath ${quote(release)});$i++){Start-Sleep -Milliseconds 50}; if(!(Test-Path -LiteralPath ${quote(release)})){throw 'barrier'}; [Console]::Out.Write('CONCURRENT_OK')`
      const results = await Promise.all([0, 1].map(() => execute({ command, workspace, port: proxy.port, onReady, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })))
      for (const result of results) {
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        assert.equal(result.output, 'CONCURRENT_OK')
      }
    })
    await t.test('recovers after a supervisor exits without releasing its lease', async () => {
      const journalDirectory = join(process.env.LOCALAPPDATA, 'Lexora Buddy Sandbox', 'leases')
      const denials = await readFile(join(journalDirectory, 'denials-v1.json'))
      const result = await execute({ command: 'Start-Sleep -Seconds 30', workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }], onReady: child => child.kill() })
      assert.notEqual(result.exitCode, 0)
      const recovered = await execute({ command: '[Console]::Out.Write(\'RECOVERED_AFTER_EXIT\')', workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
      assert.equal(recovered.exitCode, 0, JSON.stringify(recovered))
      assert.equal(recovered.output, 'RECOVERED_AFTER_EXIT')
      const metadataDirectory = join(dirname(executable), 'metadata-leases')
      assert.deepEqual(await readdir(metadataDirectory).catch((error) => {
        if (error.code === 'ENOENT')
          return []
        throw error
      }), [])
      assert.deepEqual(await readdir(journalDirectory), ['denials-v1.json'])
      assert.deepEqual(await readFile(join(journalDirectory, 'denials-v1.json')), denials)
    })
    await t.test('cancels preparation before resuming any task command', async () => {
      const large = join(root, 'preparation')
      await mkdir(large)
      for (let batch = 0; batch < 50; batch++)
        await Promise.all(Array.from({ length: 64 }, (_, item) => writeFile(join(large, `fixture-${batch}-${item}`), '')))
      const marker = join(large, 'must-not-run')
      const started = performance.now()
      const result = await execute({
        command: `[IO.File]::WriteAllText(${quote(marker)},'EXECUTED')`,
        workspace: large,
        port: proxy.port,
        grants: [{ path: large, access: 'write' }],
        onPreparing: child => child.stdin.end(),
      })
      assert.notEqual(result.exitCode, 0, JSON.stringify(result))
      assert(!result.diagnostics.includes('"type":"ready"'), result.diagnostics)
      await assert.rejects(access(marker))
      t.diagnostic(`Preparation cancellation completed in ${Math.round(performance.now() - started)} ms`)
      const completed = performance.now()
      const largeResult = await execute({ command: `[IO.File]::WriteAllText(${quote(marker)},'COMPLETED')`, workspace: large, port: proxy.port, grants: [{ path: large, access: 'write' }] })
      assert.equal(largeResult.exitCode, 0, JSON.stringify(largeResult))
      assert.equal(await readFile(marker, 'utf8'), 'COMPLETED')
      t.diagnostic(`3200-file workspace command and cleanup completed in ${Math.round(performance.now() - completed)} ms`)
    })
    await t.test('recovers an interrupted journal publication before the next command', async () => {
      const journalDirectory = join(process.env.LOCALAPPDATA, 'Lexora Buddy Sandbox', 'leases')
      const pending = join(journalDirectory, `Lexora.Buddy.Sandbox.${randomUUID().replaceAll('-', '')}.pending`)
      await mkdir(journalDirectory, { recursive: true })
      await writeFile(pending, '{"profile":', { flag: 'wx' })
      try {
        const result = await execute({ command: '[Console]::Out.Write(\'RECOVERED\')', workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        assert.equal(result.output, 'RECOVERED')
        await assert.rejects(access(pending))
      }
      finally { await rm(pending, { force: true }) }
    })
  }
  finally {
    proxy.server.close()
    other.server.close()
    ipv6.server.close()
    const reconciled = await execute({ workspace, grants: [], prepareOnly: true, synchronizeDenials: true })
    assert.equal(reconciled.exitCode, 0, JSON.stringify(reconciled))
    if (process.env.BUDDY_SANDBOX_TEST_KEEP_FILES !== '1')
      await rm(root, { recursive: true, force: true })
  }
})
