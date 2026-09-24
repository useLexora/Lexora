import type { EventContext } from '../../../shared/observability/ApplicationEvents'
import { AsyncLocalStorage } from 'node:async_hooks'

export const diagnosticContext = new AsyncLocalStorage<EventContext>()
