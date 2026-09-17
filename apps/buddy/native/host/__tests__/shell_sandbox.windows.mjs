/* eslint test/no-import-node-test: off */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import * as nativeTest from 'node:test'

const executable = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Lexora Buddy Sandbox', 'lexora-buddy-sandbox.exe')
const quote = value => `'${value.replaceAll('\'', '\'\'')}'`

async function listener() {
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.end('FIXTURE')
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

async function execute({ command, workspace, grants, port, onReady, onPreparing }) {
  const privateRoot = await mkdtemp(join(dirname(workspace), 'private-'))
  const home = join(privateRoot, 'home')
  const temporary = join(privateRoot, 'tmp')
  await Promise.all([home, temporary].map(path => mkdir(path)))
  const shell = process.env.BUDDY_SANDBOX_TEST_SHELL ?? join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
  const child = spawn(executable, ['run'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const identities = await Promise.all(grants.map(async (grant) => {
    const metadata = await stat(grant.path, { bigint: true })
    return { ...grant, device: String(metadata.dev), inode: String(metadata.ino) }
  }))
  const chunks = []
  let diagnostics = ''
  let ready = false
  let preparing = false
  child.stdout.on('data', data => chunks.push(data))
  child.stderr.on('data', (data) => {
    diagnostics += data
    if (!preparing && diagnostics.includes('"phase":"filesystem_preparing"')) {
      preparing = true
      onPreparing?.(child)
    }
    if (!ready && diagnostics.includes('"type":"ready"')) {
      ready = true
      onReady?.(child)
    }
  })
  child.stdin.on('error', () => {})
  child.stdin.write(`${JSON.stringify({ command, cwd: workspace, shell, privateRoot, proxyPort: port, grants: identities, environment: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, ComSpec: join(process.env.SystemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', PSModulePath: join(dirname(shell), 'Modules'), PATH: `${dirname(shell)};${join(process.env.SystemRoot, 'System32')}`, HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary, APPDATA: home, LOCALAPPDATA: home, POWERSHELL_TELEMETRY_OPTOUT: '1' } })}\n`)
  const timer = setTimeout(() => child.stdin.end(), 60_000)
  const killTimer = setTimeout(() => child.kill(), 75_000)
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const buffer = Buffer.concat(chunks)
    const output = buffer.subarray(0, 128).includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
    return { exitCode, output, diagnostics }
  }
  finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    await rm(privateRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 })
  }
}

nativeTest.test('Windows LPAC enforcement', { skip: process.platform !== 'win32', timeout: 300_000 }, async (t) => {
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
  const other = await listener()
  try {
    await t.test('restricts files, secrets and network destinations', async () => {
      const command = `
$r=@{}
try { $r.outside=[IO.File]::ReadAllText(${quote(outside)}) } catch { $r.outside='denied' }
try { $r.secret=[IO.File]::ReadAllText(${quote(secret)}) } catch { $r.secret='denied' }
[IO.File]::WriteAllText(${quote(join(workspace, 'result.txt'))},'WORKSPACE_WRITE_FIXTURE')
foreach($target in @(@{key='proxy';port=${proxy.port}},@{key='otherPort';port=${other.port}})) {
  try { $c=[Net.Sockets.TcpClient]::new(); $t=$c.ConnectAsync('127.0.0.1',$target.port); if(!$t.Wait(1500)){throw 'timeout'}; $r[$target.key]='connected'; $c.Dispose() }
  catch { $r[$target.key]='denied' }
}
[Console]::Out.Write(($r | ConvertTo-Json -Compress))
`
      const result = await execute({ command, workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
      await writeFile(join(root, 'report.json'), JSON.stringify(result, null, 2))
      assert.equal(result.exitCode, 0, JSON.stringify(result))
      assert.deepEqual(JSON.parse(result.output), { outside: 'denied', secret: 'denied', proxy: 'connected', otherPort: 'denied' })
      assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'WORKSPACE_WRITE_FIXTURE')
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
    await t.test('does not expose ancestor contents or mutation rights to native children', async () => {
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
        const { queryAttributes, readAttributes, ...denied } = probes[path]
        t.diagnostic(`Ancestor attributes ${path}: query=${queryAttributes}, handle=${readAttributes}`)
        assert.equal(queryAttributes, 0, path)
        assert.deepEqual(denied, { listDirectory: 5, addFile: 5, addDirectory: 5, deleteChild: 5, writeAttributes: 5, writeExtendedAttributes: 5, writeDacl: 5, writeOwner: 5, delete: 5 }, path)
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
      const result = await execute({ command: 'Start-Sleep -Seconds 30', workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }], onReady: child => child.kill() })
      assert.notEqual(result.exitCode, 0)
      const recovered = await execute({ command: '[Console]::Out.Write(\'RECOVERED_AFTER_EXIT\')', workspace, port: proxy.port, grants: [{ path: workspace, access: 'write' }, { path: secret, access: 'denyRead' }] })
      assert.equal(recovered.exitCode, 0, JSON.stringify(recovered))
      assert.equal(recovered.output, 'RECOVERED_AFTER_EXIT')
      const metadataDirectory = join(dirname(executable), 'metadata-leases')
      assert.deepEqual(await readdir(metadataDirectory), [])
      assert.deepEqual(await readdir(join(process.env.LOCALAPPDATA, 'Lexora Buddy Sandbox', 'leases')), [])
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
    if (process.env.BUDDY_SANDBOX_TEST_KEEP_FILES !== '1')
      await rm(root, { recursive: true, force: true })
  }
})
