import type { BuddyInputReferenceStore } from '../context/BuddyInputReference'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import {
  BuddyInputReferenceError,
  createBuddyInputReferenceMessage,
  matchesBuddyInputText,
} from '../context/BuddyInputReference'

export function createInputReferenceExtension(
  store: BuddyInputReferenceStore,
): BuddyInProcessExtension {
  return {
    name: 'lexora-input-reference',
    factory(pi) {
      pi.on('message_end', (event) => {
        const input = store.pending
        if (!input || event.message.role !== 'user')
          return
        if (!matchesBuddyInputText(event.message.content, input))
          throw new BuddyInputReferenceError('INPUT_REFERENCE_MISMATCH')
        store.pending = null
        return { message: { ...event.message, ...createBuddyInputReferenceMessage(input, event.message.timestamp) } }
      })
    },
  }
}
