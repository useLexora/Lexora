import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint, Linter } from 'eslint'
import { it } from 'vitest'
import rule from '../dependency-boundaries.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const eslint = new ESLint()
const tsConfig = await eslint.calculateConfigForFile(path.join(root, 'src/main.ts'))
const vueConfig = await eslint.calculateConfigForFile(path.join(root, 'src/App.vue'))
const linter = new Linter()

function lint(filename, code) {
  const configuration = filename.endsWith('.vue') ? vueConfig : tsConfig
  return linter.verify(code, {
    files: ['**/*.{ts,js,mjs,cjs,vue}'],
    languageOptions: {
      ...configuration.languageOptions,
      parserOptions: { ...configuration.languageOptions.parserOptions, project: false, projectService: false },
    },
    plugins: { buddy: { rules: { boundaries: rule } } },
    rules: { 'buddy/boundaries': 'error' },
  }, { filename: path.join(root, filename) })
}

const cases = [
  ['workbench cannot depend on app composition', 'src/workbench/browser/View.ts', 'import { root } from \'@/app/bootstrap/root\'', 'workbenchToBusiness'],
  ['workbench cannot depend on contributions', 'src/workbench/common/Resource.ts', 'import type { Task } from \'@/modules/tasks\'', 'workbenchToBusiness'],
  ['workbench services cannot depend on Vue', 'src/workbench/services/Controller.ts', 'import { ref } from \'vue\'', 'workbenchCoreHost'],
  ['workbench services cannot depend on browser components', 'src/workbench/services/Controller.ts', 'import { Pane } from \'../browser/Pane\'', 'workbenchCoreHost'],
  ['workbench services cannot depend on host APIs', 'src/workbench/services/Controller.ts', 'import type { API } from \'@buddy-electron/shared/desktopApi\'', 'workbenchCoreHost'],
  ['module cannot import app through alias', 'src/modules/tasks/state/useTasks.ts', 'import { app } from \'@/app/desktopAppContext\'', 'moduleToApp'],
  ['module cannot import app through relative path', 'src/modules/tasks/state/useTasks.ts', 'import { app } from \'../../../app/desktopAppContext\'', 'moduleToApp'],
  ['normalized alias cannot bypass boundary', 'src/modules/tasks/state/useTasks.ts', 'import { app } from \'@/modules/tasks/../../app/desktopAppContext\'', 'moduleToApp'],
  ['app cannot reach module private state', 'src/app/bootstrap/start.ts', 'import { state } from \'@/modules/tasks/state/useTasks\'', 'privateModule'],
  ['cross module type imports respect public entry', 'src/modules/settings/state/settings.ts', 'import type { Task } from \'../../tasks/state/useTasks\'', 'privateModule'],
  ['nested index is private', 'src/modules/settings/state/settings.ts', 'export { task } from \'@/modules/tasks/state/index.ts\'', 'privateModule'],
  ['export all respects boundary', 'src/modules/settings/state/settings.ts', 'export * from \'@/modules/tasks/widgets/private\'', 'privateModule'],
  ['dynamic imports respect boundary', 'src/app/router/index.ts', 'const page = import(\'@/modules/tasks/pages/TasksPage.vue\')', 'privateModule'],
  ['static template imports respect boundary', 'src/app/router/index.ts', 'const page = import(`@/modules/tasks/pages/TasksPage.vue`)', 'privateModule'],
  ['require respects boundary in mjs', 'src/app/shell/action.mjs', 'const task = require(\'@/modules/tasks/state/useTasks\')', 'privateModule'],
  ['import type expressions respect boundary', 'src/modules/settings/state/settings.ts', 'type Task = import(\'@/modules/tasks/state/useTasks\').Task', 'privateModule'],
  ['TypeScript import equals respects boundary', 'src/modules/settings/state/settings.ts', 'import task = require(\'@/modules/tasks/state/useTasks\')', 'privateModule'],
  ['model cannot import state types', 'src/modules/tasks/model/rows.ts', 'import type { State } from \'../state/run\'', 'modelToPresentation'],
  ['model cannot import a state directory', 'src/modules/tasks/model/rows.ts', 'import { state } from \'../state\'', 'modelToPresentation'],
  ['model cannot import widgets', 'src/modules/tasks/model/rows.ts', 'import { rows } from \'../widgets/transcript/rows\'', 'modelToPresentation'],
  ['model cannot import a public UI entry', 'src/modules/tasks/model/rows.ts', 'import { ModelSelector } from \'@/modules/models/ui\'', 'modelToPresentation'],
  ['model cannot import a public routes entry', 'src/modules/tasks/model/rows.ts', 'import { routes } from \'@/modules/settings/routes.ts\'', 'modelToPresentation'],
  ['model cannot import Vue runtime', 'src/modules/tasks/model/rows.ts', 'import { computed } from \'vue\'', 'modelRuntime'],
  ['state cannot import widget types', 'src/modules/tasks/state/tasks.ts', 'import type { Resource } from \'../widgets/composer/typing\'', 'stateToPresentation'],
  ['state cannot load component runtime', 'src/modules/tasks/state/tasks.ts', 'const Icon = import(\'@/shared/ui/icon/DesktopIcon.vue\')', 'stateToPresentation'],
  ['state cannot load public UI entry', 'src/modules/tasks/state/tasks.ts', 'import { Selector } from \'@/modules/models/ui\'', 'stateToPresentation'],
  ['state cannot re-export routes', 'src/modules/tasks/state/tasks.ts', 'export * from \'../routes.ts\'', 'stateToPresentation'],
  ['model cannot re-export Vue runtime', 'src/modules/tasks/model/rows.ts', 'export { computed } from \'vue\'', 'modelRuntime'],
  ['model cannot import mixed Vue values and types', 'src/modules/tasks/model/rows.ts', 'import { type Ref, computed } from \'vue\'', 'modelRuntime'],
  ['model cannot load Naive runtime', 'src/modules/tasks/model/rows.ts', 'const ui = import(\'naive-ui\')', 'modelRuntime'],
  ['model cannot load editor runtime', 'src/modules/prompt-input/model/content.ts', 'import { Editor } from \'@tiptap/core\'', 'modelRuntime'],
  ['domain shared cannot import Node', 'shared/contract.ts', 'import type { Buffer } from \'node:buffer\'', 'sharedHost'],
  ['domain shared cannot import bare builtins', 'shared/contract.mjs', 'import { readFile } from \'fs/promises\'', 'sharedHost'],
  ['domain shared cannot import Electron', 'shared/contract.ts', 'import type { BrowserWindow } from \'electron\'', 'sharedHost'],
  ['domain shared cannot import platform files', 'shared/contract.ts', 'import definitions from \'../platform/definitions.json\'', 'sharedHost'],
  ['domain shared cannot import service files', 'shared/contract.ts', 'export type { Run } from \'../service/runtime/run\'', 'sharedHost'],
  ['domain shared cannot import Electron alias', 'shared/contract.ts', 'export type { Api } from \'@buddy-electron/shared/desktopApi\'', 'sharedHost'],
  ['domain shared cannot import renderer alias', 'shared/contract.ts', 'import { helper } from \'@/shared/lib/helper\'', 'sharedHost'],
  ['platform cannot import renderer', 'platform/process/process.ts', 'import { state } from \'@/shared/state\'', 'platformToHost'],
  ['platform cannot import Electron host', 'platform/ipc/transport.ts', 'import type { Host } from \'../../electron/main/host\'', 'platformToHost'],
  ['platform cannot import runtime service', 'platform/filesystem/file.ts', 'export { files } from \'../../service/files\'', 'platformToHost'],
  ['platform cannot load Electron runtime', 'platform/native/host.mjs', 'const electron = require(\'electron\')', 'platformToHost'],
  ['Vue SFC imports respect module boundary', 'src/modules/tasks/widgets/Task.vue', '<script setup lang="ts">import { app } from "@/app/desktopAppContext"</script><template><div /></template>', 'moduleToApp'],
]

for (const layer of ['shared', 'platform', 'i18n', 'theme']) {
  cases.push([`${layer} cannot depend on modules`, `src/${layer}/test.ts`, 'import { tasks } from \'@/modules/tasks\'', 'foundationToBusiness'])
  cases.push([`${layer} cannot depend on app`, `src/${layer}/test.ts`, 'import type { App } from \'@/app/desktopAppContext\'', 'foundationToBusiness'])
}

for (const [name, filename, code, messageId] of cases) {
  it(name, () => {
    const messages = lint(filename, code)
    assert.equal(messages.length, 1, JSON.stringify(messages))
    assert.equal(messages[0].messageId, messageId, JSON.stringify(messages))
  })
}

it('module public entries permit app and cross module consumers', () => {
  for (const entry of ['', '/index', '/index.ts', '/contracts.ts', '/ui', '/routes.ts']) {
    const code = `import { value } from '@/modules/tasks${entry}'`
    assert.deepEqual(lint('src/app/bootstrap/start.ts', code), [])
    assert.deepEqual(lint('src/modules/settings/widgets/Settings.ts', code), [])
  }
})

it('module can use its own private implementation', () => {
  assert.deepEqual(lint('src/modules/tasks/state/useTasks.ts', 'import { rows } from \'../model/rows\''), [])
  assert.deepEqual(lint('src/modules/tasks/widgets/Task.ts', 'import { tasks } from \'@/modules/tasks/state/useTasks\''), [])
})

it('state can use reactive owners, domain types and public state entries', () => {
  for (const dependency of ['vue', '@/modules/models', '@/modules/settings/contracts', '../composer/typing', '../model/typing'])
    assert.deepEqual(lint('src/modules/tasks/state/useTasks.ts', `import { value } from '${dependency}'`), [])
})

it('model can use Vue and Tiptap type-only imports', () => {
  for (const code of [
    'import type { Ref } from \'vue\'',
    'import { type Ref } from \'vue\'',
    'export { type Ref } from \'vue\'',
    'type Ref = import(\'vue\').Ref',
    'import type { JSONContent } from \'@tiptap/core\'',
  ]) {
    assert.deepEqual(lint('src/modules/tasks/model/rows.ts', code), [])
  }
})

it('shared domain contracts can depend on each other and neutral libraries', () => {
  assert.deepEqual(lint('shared/content.ts', 'import { schema } from \'./contract\'; import { z } from \'zod\''), [])
  assert.deepEqual(lint('shared/content.ts', 'import { schema } from \'@buddy-shared/contract\''), [])
})

it('test fixtures may exercise another layer without changing production boundaries', () => {
  assert.deepEqual(lint('shared/__tests__/content.spec.ts', 'import { readFile } from \'node:fs\''), [])
})

it('platform can use Node, domain shared and its own implementation', () => {
  assert.deepEqual(lint('platform/filesystem/paths.ts', 'import path from \'node:path\'; import { space } from \'@buddy-shared/space\'; import { kind } from \'../currentPlatform\''), [])
})
