import type { ExtensionCapabilityContext } from './extensionAgentHandlers'
import { AsyncLocalStorage } from 'node:async_hooks'

export const extensionInvocationContext = new AsyncLocalStorage<ExtensionCapabilityContext>()
