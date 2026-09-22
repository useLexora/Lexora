import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { Ref } from 'vue'
import type { ChatComposerContextOptions } from '@/modules/prompt-input'
import { isSkillAvailable } from '@buddy-shared/skills/skillApi'
import { onScopeDispose, watch } from 'vue'

interface ComposerContextOptions {
  activeBranchId: Readonly<Ref<string | null>>
  activeConversationId: Readonly<Ref<string | null>>
  draftId: Readonly<Ref<string>>
  spaceId: Readonly<Ref<string | null>>
  listSources: LocalChatApi['composerResources']['listSources']
  listSkills: LocalChatApi['skills']['list']
}

export function useComposerContextOptions(options: ComposerContextOptions) {
  let scopeVersion = 0
  watch([options.activeBranchId, options.activeConversationId, options.draftId, options.spaceId], () => {
    scopeVersion += 1
  }, { flush: 'sync' })
  onScopeDispose(() => {
    scopeVersion += 1
  })
  async function listContextOptions(fileQuery: string | null, deepSearch = false): Promise<ChatComposerContextOptions> {
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
    const catalog = fileQuery === null ? await options.listSkills(spaceId) : null
    const sources = fileQuery === null ? null : await options.listSources(request)
    if (current !== scopeVersion)
      return { files: [], skills: [] }
    return {
      directory: sources?.directory,
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
          description: skill.description,
          kind: 'skill' as const,
          label: skill.name,
          path: null,
          value: skill.name,
          skillScope: skill.source,
          skill: { id: skill.id, name: skill.name, revision: skill.revision },
        })),
    }
  }

  return { listContextOptions }
}
