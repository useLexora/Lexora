import type { LocalBuddy } from '../../../shared/buddies/buddyApi'
import type { BuddySettings } from '../../../shared/buddies/buddySettings'
import type { BuddyCapability, BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import type { BuddiesService } from './BuddiesService'
import { extname, resolve } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { z } from 'zod'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { BUDDY_AVATAR_MAX_BYTES } from '../../../shared/buddies/buddyApi'
import { buddySettingsSchema } from '../../../shared/buddies/buddySettings'
import { readLocalChatErrorCode } from '../../../shared/runtime/localChatError'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export const BUDDY_TOOLS = toPiToolGroup({
  name: 'lexora_buddy',
  description: 'Inspect and configure actors and NPCs.',
  tools: [{ name: 'list' }, { name: 'get' }, { name: 'create' }, { name: 'update' }, { name: 'delete' }, { name: 'reset_profile' }, { name: 'set_default' }],
})

const empty = Type.Object({}, { additionalProperties: false })
const target = { buddyId: Type.String({ minLength: 1, maxLength: 256, description: 'Stable companion ID returned by list. Never use the display name as an ID.' }) }
const get = Type.Object(target, { additionalProperties: false })
const expectedRevision = Type.Integer({ minimum: 1, description: 'Profile revision returned by get. On conflict, read again before changing the profile.' })
const fields = {
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 500, description: 'Short profile description; does not change agent instructions.' })),
  avatarPath: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()], { description: 'PNG, JPEG or WebP file up to 2 MiB, relative to cwd or absolute. Null uses the bundled default avatar. Omit to keep the avatar.' })),
}
const create = Type.Object(fields, { additionalProperties: false })
const update = Type.Object({ ...target, expectedRevision, ...fields, name: Type.Optional(fields.name), settings: Type.Optional(Type.Unsafe<BuddySettings>(z.toJSONSchema(buddySettingsSchema, { unrepresentable: 'any' }))) }, { additionalProperties: false })
const mutation = Type.Object({ ...target, expectedRevision }, { additionalProperties: false })
const setDefault = Type.Object({ ...target, expectedCatalogRevision: Type.Integer({ minimum: 1, description: 'Catalog revision returned by list. Read list again on conflict.' }) }, { additionalProperties: false })

export function createBuddiesCapability(context: BuddyCapabilityContext, service: BuddiesService, getCurrentBuddyId: () => string | null): BuddyCapability {
  return {
    classify(event) {
      if (event.toolName === BUDDY_TOOLS.list.name)
        return Check(empty, event.input) ? { access: 'read' } : { blocked: true, reason: 'VALIDATION_FAILED' }
      if (event.toolName === BUDDY_TOOLS.get.name)
        return Check(get, event.input) ? { access: 'read' } : { blocked: true, reason: 'VALIDATION_FAILED' }
      if (event.toolName === BUDDY_TOOLS.delete.name || event.toolName === BUDDY_TOOLS.reset_profile.name)
        return Check(mutation, event.input) ? { access: 'write', paths: [] } : { blocked: true, reason: 'VALIDATION_FAILED' }
      if (event.toolName === BUDDY_TOOLS.set_default.name)
        return Check(setDefault, event.input) ? { access: 'write', paths: [] } : { blocked: true, reason: 'VALIDATION_FAILED' }
      if (event.toolName === BUDDY_TOOLS.create.name) {
        if (!Check(create, event.input))
          return { blocked: true, reason: 'VALIDATION_FAILED' }
      }
      else if (event.toolName === BUDDY_TOOLS.update.name) {
        if (!Check(update, event.input) || (event.input.name === undefined && event.input.avatarPath === undefined && event.input.description === undefined && event.input.settings === undefined))
          return { blocked: true, reason: 'VALIDATION_FAILED' }
      }
      else {
        return null
      }
      return { access: 'write', paths: event.input.avatarPath ? [{ path: event.input.avatarPath, mode: 'existing' }] : [] }
    },
    disclosure: [{
      source: { kind: 'builtin', id: 'buddies', title: 'Companions' },
      exposure: 'on_demand',
      keywords: 'buddy companion profile name avatar create delete default capabilities 伙伴 名称 名字 改名 头像 新增 删除 默认 资料 能力',
      tools: Object.values(BUDDY_TOOLS),
    }],
    extension: {
      name: 'lexora-buddy',
      factory(pi) {
        pi.registerTool(defineTool({
          ...BUDDY_TOOLS.list,
          label: 'List companions',
          description: 'List selectable companions, stable IDs, the default companion ID, catalog revision and currentBuddyId for the calling run. Use currentBuddyId when the user asks to edit you or the current companion; it can differ from the default or the next-turn selection. Deleted profiles remain readable by ID. Profiles do not own all tasks or automations.',
          parameters: empty,
          async execute(_id, input) {
            return respond(() => {
              if (!Check(empty, input))
                throw new BuddyServiceError('VALIDATION_FAILED')
              const catalog = service.list()
              return { ...catalog, currentBuddyId: getCurrentBuddyId(), buddies: catalog.buddies.map(profile) }
            })
          },
        }))
        pi.registerTool(defineTool({
          ...BUDDY_TOOLS.get,
          label: 'Read companion profile',
          description: 'Read one companion profile and its current revision before making changes. Avatar bytes are omitted.',
          parameters: get,
          async execute(_id, input) {
            return respond(() => {
              if (!Check(get, input))
                throw new BuddyServiceError('VALIDATION_FAILED')
              return profile(service.get(input.buddyId))
            })
          },
        }))
        pi.registerTool(defineTool({
          ...BUDDY_TOOLS.update,
          label: 'Update companion profile',
          description: 'Update an actor or NPC as requested by the user. Read the current revision first. Only supplied fields change. Instructions, model, tools, skills and NPC bindings apply to new executions. Host permissions remain authoritative.',
          parameters: update,
          async execute(id, input, signal) {
            return respond(async () => {
              if (!Check(update, input))
                throw new BuddyServiceError('VALIDATION_FAILED')
              const abort = signal ? AbortSignal.any([signal, context.signal]) : context.signal
              abort.throwIfAborted()
              const avatar = await readAvatar(context, id, input.avatarPath, abort)
              return profile(await service.update({ buddyId: input.buddyId, expectedRevision: input.expectedRevision, ...(input.name === undefined ? {} : { name: input.name }), ...(input.description === undefined ? {} : { description: input.description }), ...(avatar === undefined ? {} : { avatar }), ...(input.settings === undefined ? {} : { settings: input.settings }) }, abort))
            })
          },
        }))
        pi.registerTool(defineTool({
          ...BUDDY_TOOLS.create,
          label: 'Create companion',
          description: 'Create a configurable local actor when requested. The default actor is unchanged.',
          parameters: create,
          async execute(id, input, signal) {
            return respond(async () => {
              if (!Check(create, input))
                throw new BuddyServiceError('VALIDATION_FAILED')
              const abort = signal ? AbortSignal.any([signal, context.signal]) : context.signal
              const avatar = await readAvatar(context, id, input.avatarPath, abort)
              return profile(await service.create({ name: input.name, description: input.description, avatar }, abort))
            })
          },
        }))
        for (const operation of [
          { tool: BUDDY_TOOLS.delete, method: 'delete', label: 'Delete companion', description: 'Remove a companion from selection when requested. Preserves its profile and avatar. The built-in companion cannot be deleted. Choose another default before deleting the current default.' },
          { tool: BUDDY_TOOLS.reset_profile, method: 'resetProfile', label: 'Restore built-in profile', description: 'Restore the built-in companion (ID default) to its original name, avatar and description when requested. Does not change the default selection. Unavailable for user-created companions.' },
        ] as const) {
          pi.registerTool(defineTool({
            ...operation.tool,
            label: operation.label,
            description: operation.description,
            parameters: mutation,
            async execute(_id, input, signal) {
              return respond(() => {
                if (!Check(mutation, input))
                  throw new BuddyServiceError('VALIDATION_FAILED')
                return profile(service[operation.method](input, signal ? AbortSignal.any([signal, context.signal]) : context.signal))
              })
            },
          }))
        }
        pi.registerTool(defineTool({
          ...BUDDY_TOOLS.set_default,
          label: 'Set default companion',
          description: 'Save the default companion selection when requested. Requires the catalog revision from list; does not reassign existing conversations.',
          parameters: setDefault,
          async execute(_id, input, signal) {
            return respond(() => {
              if (!Check(setDefault, input))
                throw new BuddyServiceError('VALIDATION_FAILED')
              const catalog = service.setDefault(input, signal ? AbortSignal.any([signal, context.signal]) : context.signal)
              return { ...catalog, currentBuddyId: getCurrentBuddyId(), buddies: catalog.buddies.map(profile) }
            })
          },
        }))
      },
    },
  }
}

async function readAvatar(context: BuddyCapabilityContext, id: string, avatarPath: string | null | undefined, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!avatarPath)
    return avatarPath
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(avatarPath).toLowerCase()]
  if (!mime)
    throw new BuddyServiceError('VALIDATION_FAILED')
  const path = await resolveGrantedPath(context.getExecutionGrants?.(id) ?? context.grants, resolve(context.cwd, avatarPath), 'existing')
  const bytes = await readBoundedFile(path.root, path.canonicalPath, BUDDY_AVATAR_MAX_BYTES, signal)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function profile(buddy: LocalBuddy) {
  const { avatar, ...value } = buddy
  return { ...value, hasCustomAvatar: avatar !== null }
}

async function respond(operation: () => unknown): Promise<{ content: { type: 'text', text: string }[], details: { ok: boolean, code?: string }, isError: boolean }> {
  try {
    const value = await operation()
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: { ok: true }, isError: false }
  }
  catch (error) {
    const code = readLocalChatErrorCode(error) ?? 'LOCAL_CHAT_OPERATION_FAILED'
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: { code } }) }], details: { ok: false, code }, isError: true }
  }
}
