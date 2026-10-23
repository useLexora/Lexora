import type { LocalChatIpcContext } from './registrar'
import { shell } from 'electron'
import { taskFilesRpc } from '../../../shared/files/taskFileApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerTaskFilesIpc(context: LocalChatIpcContext): void {
  const { handle, request } = context
  handle(LOCAL_CHAT_IPC_CHANNELS.taskFilesResolve, (_event, input) => request(taskFilesRpc.resolve, taskFilesRpc.resolve.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.taskFilesRead, (_event, input) => request(taskFilesRpc.read, taskFilesRpc.read.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.taskFilesReveal, async (_event, input) => {
    const target = await request(taskFilesRpc.locate, taskFilesRpc.locate.input.parse(input))
    if (target.kind === 'file') {
      shell.showItemInFolder(target.path)
      return
    }
    const error = await shell.openPath(target.path)
    if (error)
      throw new Error(error)
  })
}
