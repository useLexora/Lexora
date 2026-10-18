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
    if (!port || !content || !invocation || directives.length > (reference ? 1 : 0) || getBuddyUserContentResourceIds(content).length || content.quotes?.length || content.resourceQuotes?.length || content.sessionReferences?.length) {
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
    await runCommand(editor, candidates[0]!.id, invocation.arguments, () => editor.commands.clearContent())
  }

  function executeAction(editor: Editor, commandId: string, range: { from: number, to: number }): boolean {
    if (!port || pending.value || !entries.value.some(command => command.id === commandId))
      return false
    void runCommand(editor, commandId, '', () => editor.chain().focus().deleteRange(range).run())
    return true
  }

  async function runCommand(editor: Editor, commandId: string, argumentsText: string, consume: () => boolean): Promise<void> {
    const id = draftId.value
    const instanceId = scope?.instanceId()
    const doc = editor.state.doc
    if (!consume())
      return
    pending.value = true
    const consumed = editor.state.doc
    try {
      await port!.execute(commandId, argumentsText, instanceId)
    }
    catch {
      if (!editor.isDestroyed && editor.isEditable && id === draftId.value && instanceId === scope?.instanceId() && editor.state.doc.eq(consumed))
        editor.commands.setContent(doc.toJSON())
      port?.reportFailure()
    }
    finally {
      pending.value = false
    }
  }

  return { entries, pending, handles, execute, executeAction }
}
