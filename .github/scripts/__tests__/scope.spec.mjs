import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Scope 在依赖安装前执行。
import test from 'node:test'
import { classifyCiScope, listChangedFiles, resolveCiScope } from '../resolve-ci-scope.mjs'

const none = { workspace: false, integration: false, native: false, website: false, repository: false }
const workspace = { ...none, workspace: true }
const integration = { ...workspace, integration: true }
const native = { ...integration, native: true }
const website = { ...none, website: true }
const repository = { ...none, repository: true }
const full = { workspace: true, integration: true, native: true, website: true, repository: true }
const cases = [
  ['apps/buddy/src/modules/tasks/Chat.vue', workspace],
  ['apps/buddy/src/shared/ui/__tests__/button.spec.ts', workspace],
  ['apps/buddy/service/src/sandbox/runner.ts', integration],
  ['apps/buddy/electron/main/runtime/serviceProcess.ts', integration],
  ['apps/buddy/platform/filesystem/filePaths.ts', integration],
  ['packaging/buddy/release/search-tools.mjs', integration],
  ['.playwright/scripts/__tests__/inference-smoke.spec.mjs', integration],
  ['apps/buddy/native/host/src/lib.rs', native],
  ['apps/buddy/platform/native/searchTools.json', native],
  ['.cargo/config.toml', native],
  ['packages/assets/buddy/pets/default/pet.png', { ...native, repository: true }],
  ['packages/assets/brand/logo.svg', { ...integration, website: true, repository: true }],
  ['apps/buddy/shared/extensions/protocol.ts', full],
  ['apps/buddy/__tests__/temporaryDirectories.ts', full],
  ['apps/buddy/package.json', full],
  ['apps/buddy/vite.config.ts', full],
  ['apps/buddy/vitest.setup.ts', full],
  ['.playwright/scripts/fixtures/electron.mjs', full],
  ['packaging/shared/cli-output.mjs', full],
  ['patches/dependency.patch', full],
  ['package.json', full],
  ['pnpm-lock.yaml', full],
  ['.node-version', full],
  ['.github/workflows/ci.yml', full],
  ['.github/scripts/__tests__/scope.spec.mjs', full],
  ['.github/actions/install-workspace-dependencies/action.yml', full],
  ['apps/website/index.md', website],
  ['.github/workflows/website-pages.yml', website],
  ['infrastructure/scripts/check.mjs', repository],
  ['README.md', none],
  ['apps/web/src/index.ts', none],
  ['apps/api/src/index.ts', none],
  ['legacy/web-stack/index.ts', none],
  ['.playwright/scripts/community/index.mjs', none],
  ['.playwright/scripts/community-extra/index.mjs', integration],
  ['apps/web-extra/index.ts', full],
  ['apps/buddy/src-other/index.ts', full],
  ['new-capability/config.json', full],
]

for (const [path, expected] of cases) {
  test(`选择 ${path} 所需检查`, () => {
    assert.deepEqual(classifyCiScope([path]), expected)
  })
}

test('没有变更路径证据时保守选择全部检查', () => {
  assert.deepEqual(classifyCiScope([]), full)
})

test('路径分隔符和相对前缀不改变范围', () => {
  for (const path of ['apps/buddy/src/Chat.vue', './apps/buddy/src/Chat.vue', '.\\apps\\buddy\\src\\Chat.vue'])
    assert.deepEqual(classifyCiScope([path]), workspace)
})

test('多路径选择取并集，新增已知路径不会移除必需检查', () => {
  for (const [first, a] of cases) {
    for (const [second, b] of cases) {
      const expected = Object.fromEntries(Object.keys(none).map(key => [key, a[key] || b[key]]))
      assert.deepEqual(classifyCiScope([first, second]), expected, `${first} + ${second}`)
    }
  }
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

test('跨产品重命名保留旧路径和新路径用于范围选择', (context) => {
  const source = 'apps/web/src/moved.ts'
  const target = 'apps/website/src/moved.ts'
  const { cwd, git, base } = repositoryFixture(context, [source])
  mkdirSync(dirname(join(cwd, target)), { recursive: true })
  renameSync(join(cwd, source), join(cwd, target))
  git('add', '--all')
  git('commit', '--quiet', '-m', 'move')
  const head = git('rev-parse', 'HEAD')
  assert.deepEqual(listChangedFiles(base, head, cwd).sort(), [source, target])
  assert.deepEqual(resolveCiScope(base, head, cwd), website)
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
  assert.deepEqual(resolveCiScope(base, head, cwd), full)
})
