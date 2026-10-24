import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { BUDDY_QUOTE_TEXT_LIMIT } from '../../conversation/buddyUserContent'
import { extensionToolSchema } from '../extensionAgent'
import { extensionAgentCapabilities } from '../extensionAgentCapabilities'
import { extensionManagementSchema, parseExtensionRequestParams } from '../extensionApi'
import { addedExtensionPermissions, extensionManifestSchema, extensionPermissionsSchema } from '../extensionManifest'
import { extensionReferenceInputSchema, extensionReferenceTargetSchema } from '../extensionReferences'

const content = { kind: 'content', title: 'Paragraph', text: 'Selected text', locator: { version: 1, data: { range: [1, 2] } } }

it('strictly validates reference inputs and the shared text and opaque locator budgets', () => {
  expect(extensionReferenceInputSchema.parse(content)).toEqual(content)
  expect(extensionReferenceInputSchema.parse({ ...content, source: 'view' })).toEqual({ ...content, source: 'view' })
  expect(extensionReferenceInputSchema.parse({ kind: 'resource', resource: { id: randomUUID() } }).kind).toBe('resource')
  for (const input of [
    { ...content, provider: 'extension:another.plugin' },
    { ...content, source: 'resource' },
    { ...content, source: { kind: 'artifact', artifactId: 'another-file' } },
    { ...content, source: '/outside/file' },
    { kind: 'resource', resource: { id: randomUUID() }, source: 'view' },
    { ...content, taskId: 'another-task' },
    { ...content, title: ' ' },
    { ...content, text: ' ' },
    { ...content, locator: { version: 1, data: {}, path: '/outside' } },
    { ...content, locator: { version: 0, data: null } },
    { kind: 'resource', resource: { id: randomUUID(), path: '/outside' } },
    { kind: 'resource', resource: { id: 'not-a-handle' } },
  ]) {
    expect(extensionReferenceInputSchema.safeParse(input).success).toBe(false)
  }
})

it('accepts only owned opening target fields, with no command or arbitrary path shortcuts', () => {
  const input = { extensionId: 'tests.reader', viewId: randomUUID(), viewType: 'tests.reader.view', source: null }
  expect(extensionManagementSchema.parse({ action: 'prepareReferenceOpening', input })).toEqual({ action: 'prepareReferenceOpening', input })
  for (const invalid of [
    { ...input, command: 'tests.reader.execute' },
    { ...input, provider: 'builtin:file' },
    { ...input, source: { kind: 'local', path: '/outside' } },
    { ...input, source: { kind: 'space', target: { path: '/outside' } } },
    { ...input, source: { kind: 'artifact', artifactId: 'artifact', path: '/outside' } },
  ]) {
    expect(extensionReferenceTargetSchema.safeParse(invalid).success).toBe(false)
  }
})

it('keeps references opt-in, API 4-only and visible in added permission review', () => {
  const previous = extensionPermissionsSchema.parse({})
  const next = extensionPermissionsSchema.parse({ references: true })
  expect(previous.references).toBe(false)
  expect(addedExtensionPermissions(previous, next)).toEqual(['references'])
  expect(addedExtensionPermissions(next, next)).toEqual([])
  const input = { schemaVersion: 1, id: 'tests.reader', name: 'Reader', version: '1.0.0', apiVersion: 4, engines: { lexora: '*' }, permissions: { references: true }, contributes: {} }
  expect(extensionManifestSchema.parse(input).permissions.references).toBe(true)
  for (const apiVersion of [1, 2, 3])
    expect(extensionManifestSchema.safeParse({ ...input, apiVersion }).success).toBe(false)
})

it('scopes reference RPC to the independent references permission and validates tool effects', () => {
  const disabled = extensionPermissionsSchema.parse({ agent: true, tasks: 'read', taskMessages: true })
  const enabled = extensionPermissionsSchema.parse({ agent: true, references: true })
  for (const name of ['references.list', 'references.resolve'] as const) {
    expect(extensionAgentCapabilities[name].permitted(disabled)).toBe(false)
    expect(extensionAgentCapabilities[name].permitted(enabled)).toBe(true)
  }
  const resolve = extensionAgentCapabilities['references.resolve'].input
  expect(resolve.safeParse({ referenceId: randomUUID() }).success).toBe(true)
  expect(resolve.safeParse({ referenceId: randomUUID(), taskId: 'another-task' }).success).toBe(false)
  expect(resolve.safeParse({ referenceId: '1' }).success).toBe(false)
  const tool = { id: 'tests.office.edit', title: 'Edit', description: 'Edit a referenced selection', parameters: { type: 'object', properties: {} } }
  expect(extensionToolSchema.parse(tool).access).toBeUndefined()
  expect(extensionToolSchema.parse({ ...tool, access: 'write' }).access).toBe('write')
  expect(extensionToolSchema.safeParse({ ...tool, access: 'execute' }).success).toBe(false)
})

it('accepts bounded long Unicode references without increasing ordinary plugin message budgets', () => {
  const input = { ...content, text: '字'.repeat(BUDDY_QUOTE_TEXT_LIMIT) }
  expect(parseExtensionRequestParams('references.add', input)).toEqual(input)
  expect(() => parseExtensionRequestParams('view.message', { text: input.text })).toThrow()
  expect(() => parseExtensionRequestParams('references.add', { ...input, text: `${input.text}字` })).toThrow()
  expect(() => parseExtensionRequestParams('references.add', { ...input, locator: { version: 1, data: { text: '字'.repeat(9000) } } })).toThrow()
})
