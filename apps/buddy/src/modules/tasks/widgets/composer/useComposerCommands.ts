import type { Editor } from '@tiptap/core'
import type { Ref } from 'vue'
import type { ChatComposerSubmitPayload } from '@/modules/prompt-input'
import { parseBuddyChatCommand } from '@buddy-shared/conversation/buddyChatCommands'
import { getBuddyUserContentResourceIds } from '@buddy-shared/conversation/buddyUserContent'
import { parseSlashInvocation } from '@buddy-shared/workbench/workbenchCommand'
import { computed, shallowRef } from 'vue'
import { useWorkbenchCommands } from '@/shared/ui/contributions/workbenchCommands'
import { useWorkbenchUiScope } from '@/shared/ui/contributions/workbenchUiContext'

export function useComposerCommands(draftId: Readonly<Ref<string>>, choose: (name: string) => void) {
  const port = useWorkbenchCommands()
  const scope = useWorkbenchUiScope()
  const pending = shallowRef(false)
  const entries = computed(() => port?.entries.value ?? [])

  function handles(payload: ChatComposerSubmitPayload): boolean {
    const nodes = payload.userContent?.body.flatMap(paragraph => paragraph.content) ?? []
    return nodes.some(node => node.type === 'prompt_directive' && node.directive === 'slash_command' && !!node.commandId)
      || (payload.content.trimStart().startsWith('/') && !parseBuddyChatCommand(payload.content))
  }

  async function execute(editor: Editor, payload: ChatComposerSubmitPayload): Promise<void> {
    if (pending.value)
      return
    const content = payload.userContent
    const invocation = parseSlashInvocation(payload.content)
    const directives = content?.body.flatMap(paragraph => paragraph.content.filter(node => node.type === 'prompt_directive')) ?? []
    const reference = directives.find(node => node.directive === 'slash_command' && node.commandId)
    const candidates = entries.value.filter(entry => entry.name === invocation?.name && (!reference || (reference.directive === 'slash_command' && entry.id === reference.commandId)))
    if (!port || !content || !invocation || directives.length > (reference ? 1 : 0) || getBuddyUserContentResourceIds(content).length || content.quotes?.length) {
      port?.reportFailure()
      return
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1 && !reference)
        choose(invocation.name)
      else
        port.reportFailure()
      return
    }
    const id = draftId.value
    const instanceId = scope?.instanceId()
    const doc = editor.state.doc
    pending.value = true
    try {
      await port.execute(candidates[0]!.id, invocation.arguments, instanceId)
      if (!editor.isDestroyed && editor.isEditable && id === draftId.value && instanceId === scope?.instanceId() && editor.state.doc.eq(doc))
        editor.commands.clearContent()
    }
    catch {
      port?.reportFailure()
    }
    finally {
      pending.value = false
    }
  }

  return { entries, pending, handles, execute }
}
