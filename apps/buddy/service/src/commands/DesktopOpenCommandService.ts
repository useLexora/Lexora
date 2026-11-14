import type { DatabaseSync } from 'node:sqlite'
import type { RuntimePlatform } from '../platform/RuntimePlatform'
import type { CommandAdmissionService } from './CommandAdmissionService'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { desktopOpenResultSchema } from '../../../shared/service/localServiceProtocol'

interface Options { database: DatabaseSync, admission: CommandAdmissionService, openDesktop: RuntimePlatform['openDesktop'] }

export class DesktopOpenCommandService {
  readonly options: Options
  constructor(options: Options) {
    this.options = options
  }

  execute(input: unknown) {
    return this.options.admission.execute('desktop.open', input, {
      prepare: async (intent, signal) => {
        if (intent.kind === 'tasks' && intent.conversationId && !this.options.database.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(intent.conversationId))
          throw new ProductProtocolError('OBJECT_DELETED')
        if (!this.options.openDesktop)
          throw new ProductProtocolError('DESKTOP_UNAVAILABLE')
        return { intent, result: desktopOpenResultSchema.parse(await this.options.openDesktop(intent, signal)) }
      },
      validate: prepared => prepared.result.accepted ? null : { errorCode: 'DESKTOP_UNAVAILABLE', target: {}, result: { desktop: prepared.result } },
      commit: (prepared) => {
        const target: Record<string, string> = {}
        if (prepared.intent.kind === 'tasks' && prepared.intent.conversationId)
          target.conversationId = prepared.intent.conversationId
        return { target, result: { desktop: prepared.result } }
      },
      reject: error => error instanceof ProductProtocolError && (error.code === 'OBJECT_DELETED' || error.code === 'DESKTOP_UNAVAILABLE') ? { errorCode: error.code, target: {}, result: {} } : null,
    })
  }
}
