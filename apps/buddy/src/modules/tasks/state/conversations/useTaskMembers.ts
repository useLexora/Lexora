import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { Ref } from 'vue'
import type { ChatDrafts } from '../drafts/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

export function useTaskMembers(options: {
  api: Pick<LocalChatApi['conversations'], 'listMembers' | 'addMember' | 'removeMember' | 'onChanged'>
  conversationId: Readonly<Ref<string | null>>
  leaderId: Readonly<Ref<string | null>>
  ready: Readonly<Ref<boolean>>
  language: Readonly<Ref<BuddyLocale>>
  drafts: Pick<ChatDrafts, 'participants' | 'setParticipants' | 'draftId'>
  persist: () => Promise<boolean>
}) {
  const stored = shallowRef<readonly string[]>([])
  const busy = shallowRef(false)
  const error = shallowRef('')
  let revision = 0
  let disposed = false
  const memberIds = computed(() => options.conversationId.value
    ? stored.value
    : options.drafts.participants.value?.actorIds ?? (options.leaderId.value ? [options.leaderId.value] : []))

  async function refresh() {
    const request = ++revision
    const id = options.conversationId.value
    if (!id || !options.ready.value) {
      stored.value = []
      return
    }
    try {
      const members = await options.api.listMembers(id)
      if (!disposed && request === revision && id === options.conversationId.value) {
        stored.value = members.map(member => member.actorId)
        error.value = ''
      }
    }
    catch (reason) {
      if (!disposed && request === revision)
        error.value = resolveLocalChatErrorMessage(reason, options.language.value)
    }
  }

  async function change(id: string, action: 'add' | 'remove') {
    if (busy.value || !options.ready.value || (action === 'remove' && id === options.leaderId.value))
      return false
    const conversationId = options.conversationId.value
    const draftId = options.drafts.draftId.value
    const isCurrent = () => !disposed && conversationId === options.conversationId.value && draftId === options.drafts.draftId.value
    busy.value = true
    error.value = ''
    revision++
    try {
      if (!conversationId) {
        const leaderId = options.leaderId.value
        if (!leaderId)
          return false
        options.drafts.setParticipants({ leaderId, actorIds: action === 'add' ? [...new Set([...memberIds.value, id])] : memberIds.value.filter(member => member !== id) })
        return await options.persist()
      }
      const members = await options.api[action === 'add' ? 'addMember' : 'removeMember'](conversationId, id)
      if (isCurrent())
        stored.value = members.map(member => member.actorId)
      return isCurrent()
    }
    catch (reason) {
      if (isCurrent())
        error.value = resolveLocalChatErrorMessage(reason, options.language.value)
      return false
    }
    finally {
      busy.value = false
    }
  }

  const stop = options.api.onChanged((conversation) => {
    if (conversation.id === options.conversationId.value)
      void refresh()
  })
  watch([options.conversationId, options.ready], () => {
    stored.value = []
    error.value = ''
    void refresh()
  }, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    revision++
    stop()
  })
  return { memberIds: readonly(memberIds), busy: readonly(busy), error: readonly(error), refresh, add: (id: string) => change(id, 'add'), remove: (id: string) => change(id, 'remove') }
}
