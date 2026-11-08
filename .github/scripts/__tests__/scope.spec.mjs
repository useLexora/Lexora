import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Scope 在依赖安装前执行。
import test from 'node:test'
import { classifyCiScope, listChangedFiles, resolveCiScope } from '../resolve-ci-scope.mjs'

test('仅 Renderer 变化不准备原生环境，混入运行时变化后必须执行集成检查', () => {
  const renderer = 'apps/buddy/src/modules/tasks/widgets/transcript/BuddyChatTranscriptViewport.vue'
  const fast = classifyCiScope([renderer])
  assert.equal(fast.workspace, true)
  assert.equal(fast.integration, false)
  assert.equal(classifyCiScope([renderer, 'apps/buddy/service/src/sandbox/ShellSandboxClient.ts']).integration, true)
})

test('混合变更不因路径顺序或无关文档而丢失必需检查', () => {
  const files = ['apps/buddy/native/host/src/lib.rs', 'apps/website/index.md', 'README.md']
  for (const paths of [files, files.toReversed()]) {
    const scope = classifyCiScope(paths)
    assert.equal(scope.workspace, true)
    assert.equal(scope.integration, true)
    assert.equal(scope.native, true)
    assert.equal(scope.website, true)
  }
})

test('缺少路径证据、未知路径和近似 Renderer 前缀不能误入快速分支', () => {
  for (const files of [[], ['new-capability/config.json'], ['apps/buddy/src-other/index.ts']])
    assert.ok(Object.values(classifyCiScope(files)).every(Boolean))
})

function repositoryFixture(context, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'lexora-ci-scope-'))
  context.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('config', 'user.email', 'ci@example.com')
  git('config', 'user.name', 'CI')
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), 'fixture\n')
  }
  git('add', '--all')
  git('commit', '--quiet', '-m', 'source')
  return { cwd, git, base: git('rev-parse', 'HEAD') }
}

test('文件移出原生目录后仍按旧路径执行原生检查', (context) => {
  const source = 'apps/buddy/native/host/src/moved.rs'
  const target = 'apps/web/src/moved.rs'
  const { cwd, git, base } = repositoryFixture(context, [source])
  mkdirSync(dirname(join(cwd, target)), { recursive: true })
  renameSync(join(cwd, source), join(cwd, target))
  git('add', '--all')
  git('commit', '--quiet', '-m', 'move')
  const head = git('rev-parse', 'HEAD')
  assert.deepEqual(listChangedFiles(base, head, cwd).sort(), [source, target])
  assert.equal(resolveCiScope(base, head, cwd).native, true)
})

test('保留删除、文件类型变更及包含中文和换行的路径', (context) => {
  const files = ['.cargo/config.toml', 'apps/buddy/shared/deleted.ts', 'apps/buddy/native/中文\n name.rs']
  const { cwd, git, base } = repositoryFixture(context, files)
  rmSync(join(cwd, files[1]))
  writeFileSync(join(cwd, files[2]), 'changed\n')
  git('add', '--all')
  const link = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: 'fixture-target', encoding: 'utf8' }).trim()
  git('update-index', '--cacheinfo', `120000,${link},${files[0]}`)
  git('commit', '--quiet', '-m', 'change')
  const head = git('rev-parse', 'HEAD')
  assert.deepEqual(listChangedFiles(base, head, cwd).sort(), files.toSorted())
  assert.ok(Object.values(resolveCiScope(base, head, cwd)).every(Boolean))
})
