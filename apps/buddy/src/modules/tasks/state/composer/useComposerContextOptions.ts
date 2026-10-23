import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { Ref } from 'vue'
import type { ChatComposerContextOptions, ChatComposerSessionScope, ChatPromptContextOption } from '@/modules/prompt-input'
import { isSkillAvailable, skillInvocationName } from '@buddy-shared/skills/skillApi'
import { onScopeDispose, watch } from 'vue'
import { createActorContextOptions } from '../../model/composer/actorContextOptions'

interface ComposerContextOptions {
  activeBranchId: Readonly<Ref<string | null>>
  activeConversationId: Readonly<Ref<string | null>>
  draftId: Readonly<Ref<string>>
  spaceId: Readonly<Ref<string | null>>
  sessionOptions?: (query: string, scope?: ChatComposerSessionScope) => Promise<readonly ChatPromptContextOption[]>
  listSources: LocalChatApi['composerResources']['listSources']
  listSkills: LocalChatApi['skills']['list']
  listBuddies: LocalChatApi['buddies']['list']
  memberIds: Readonly<Ref<readonly string[]>>
}

export function useComposerContextOptions(options: ComposerContextOptions) {
  let scopeVersion = 0
  watch([options.activeBranchId, options.activeConversationId, options.draftId, options.spaceId], () => {
    scopeVersion += 1
  }, { flush: 'sync' })
  onScopeDispose(() => {
    scopeVersion += 1
  })
  async function listContextOptions(fileQuery: string | null, deepSearch = false, sessionScope?: ChatComposerSessionScope): Promise<ChatComposerContextOptions> {
    const current = scopeVersion
    const spaceId = options.spaceId.value
    const request = {
      branchId: options.activeBranchId.value,
      conversationId: options.activeConversationId.value,
      draftId: options.draftId.value,
      query: fileQuery ?? '',
      deepSearch,
      spaceId,
    }
    const [catalog, sources, sessions, buddies] = await Promise.all([
      fileQuery === null ? options.listSkills(spaceId, true) : null,
      fileQuery === null || sessionScope ? null : options.listSources(request),
      fileQuery === null ? [] : options.sessionOptions?.(fileQuery, sessionScope) ?? [],
      fileQuery === null || sessionScope ? null : options.listBuddies(),
    ])
    if (current !== scopeVersion)
      return { files: [], skills: [] }
    return {
      directory: sources?.directory,
      actors: createActorContextOptions((buddies?.buddies ?? []).filter(buddy => options.memberIds.value.includes(buddy.id)), fileQuery ?? ''),
      sessions: sessions.slice(0, 100),
      hasMoreSessions: sessions.length > 100,
      files: (sources?.files ?? []).map(file => ({
        category: file.category,
        description: null,
        fileName: file.name,
        fileMetadata: {
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          createdAt: file.history?.createdAt,
          messageNumber: file.history?.messageNumber,
          nameSource: file.nameSource,
        },
        kind: 'file' as const,
        entryKind: file.kind,
        label: file.label,
        path: file.path,
        value: JSON.stringify(file.source),
        source: file.source,
      })),
      skills: (catalog?.skills ?? [])
        .filter(isSkillAvailable)
        .map(skill => ({
          description: skill.plugin ? `${skill.plugin.extensionName} · ${skill.plugin.extensionId}\n${skill.description}` : skill.description,
          kind: 'skill' as const,
          label: skillInvocationName(skill),
          path: null,
          value: skillInvocationName(skill),
          skillScope: skill.source,
          skillPlugin: skill.plugin,
          skill: {
            id: skill.id,
            name: skillInvocationName(skill),
            revision: skill.referenceRevision ?? skill.revision,
          },
        })),
    }
  }

  return { listContextOptions }
}
