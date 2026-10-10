import type { SkillInstallPreview } from '../../../shared/skills/skillApi'
import type { BuddyCapability, BuddyCapabilityContext } from '../agent/extensions/BuddyCapability'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { SkillService } from './SkillService'
import { resolve } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { SkillError } from './skillFiles'

export interface SkillAuthoringServices {
  skills: Pick<SkillService, 'preview' | 'discard'>
  conversations: Pick<ConversationRepository, 'findById'>
  requestReview: (preview: SkillInstallPreview) => void
}

const name = 'lexora_skill_prepare'
const parameters = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 4096, description: 'One skill directory containing SKILL.md, relative to the workspace or absolute. The directory name must match the skill name.' }),
  scope: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('global')], { description: 'Default current: install in this task’s Space, or globally if the task has no Space. Use global only when the user requests it.' })),
  review: Type.Optional(Type.Boolean({ description: 'Request a user installation preview after validation. Defaults to false. Never installs automatically.' })),
}, { additionalProperties: false })

export function createSkillAuthoringCapability(context: BuddyCapabilityContext, services: SkillAuthoringServices): BuddyCapability {
  return {
    classify(event) {
      if (event.toolName !== name)
        return null
      if (!Check(parameters, event.input))
        return { blocked: true, reason: 'VALIDATION_FAILED' }
      return { access: event.input.review ? 'write' : 'read', paths: [{ path: event.input.source, mode: 'existing' }] }
    },
    disclosure: [{ source: { kind: 'builtin', id: 'skills', title: 'Skill authoring' }, exposure: 'on_demand', keywords: 'skill create validate prepare install update 技能 创建 校验 安装 更新', tools: [{ name }] }],
    extension: {
      name: 'lexora-skill-authoring',
      factory(pi) {
        pi.registerTool(defineTool({
          name,
          label: 'Prepare skill',
          parameters,
          description: 'Validate a reusable skill directory and its resource package using Lexora’s installer. Returns metadata, diagnostics and same-scope replacement information. Optionally requests user installation review of the validated snapshot. Does not execute scripts, evaluate skill behavior, install dependencies or install skills. Preserve existing skill names when updating; installation takes effect for subsequent runs.',
          async execute(toolCallId, input, signal) {
            const abort = signal ?? context.signal
            let preview: SkillInstallPreview | undefined
            let requested = false
            try {
              if (!Check(parameters, input))
                return response({ ok: false, code: 'VALIDATION_FAILED' })
              abort.throwIfAborted()
              const conversation = services.conversations.findById(context.conversationId)
              if (!conversation || conversation.deletedAt)
                throw new SkillError('SKILL_CHANGED')
              const spaceId = input.scope === 'global' ? null : conversation.spaceId
              const path = resolve(context.cwd, input.source)
              const grants = () => context.getExecutionGrants?.(toolCallId) ?? context.grants
              const source = await resolveGrantedPath(grants(), path, 'existing')
              preview = await services.skills.preview({ spaceId, source: { kind: 'directory', location: source.canonicalPath } }, 'authoring')
              abort.throwIfAborted()
              const verified = await resolveGrantedPath(grants(), path, 'existing')
              abort.throwIfAborted()
              const current = services.conversations.findById(context.conversationId)
              if (!current || current.deletedAt || current.spaceId !== conversation.spaceId
                || verified.canonicalPath !== source.canonicalPath) {
                throw new SkillError('SKILL_CHANGED')
              }
              const candidate = preview.candidates[0]
              if (!candidate || preview.diagnostics.length)
                return response({ ok: false, code: 'SKILL_INVALID', diagnostics: preview.diagnostics })
              if (candidate.blocked)
                return response({ ok: false, code: 'SKILL_NAME_COLLISION', diagnostics: preview.diagnostics })
              if (input.review) {
                services.requestReview(preview)
                requested = true
              }
              return response({ ok: true, name: candidate.name, description: candidate.description, source: source.canonicalPath, scope: spaceId ? 'space' : 'global', spaceId, revision: candidate.revision, fileCount: candidate.fileCount, bytes: candidate.bytes, replacesExisting: !!candidate.replacesId, diagnostics: preview.diagnostics, installation: requested ? 'review_requested' : 'not_requested', runtimeTested: false })
            }
            catch (error) {
              const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
              return response({ ok: false, code: abort.aborted ? 'SKILL_PREPARE_CANCELLED' : /^[A-Z][A-Z_]+$/.test(code) ? code : 'SKILL_PREPARE_FAILED' })
            }
            finally {
              if (preview && !requested)
                await services.skills.discard(preview.id).catch(() => {})
            }
          },
        }))
        pi.on('tool_result', (event) => {
          if (event.toolName === name && event.details && typeof event.details === 'object' && 'ok' in event.details && event.details.ok === false)
            return { isError: true }
        })
      },
    },
  }
}

function response(value: Record<string, unknown> & { ok: boolean }) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value, isError: !value.ok }
}
