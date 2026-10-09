import type { BuiltinPromptCatalog } from '../../../shared/prompts/promptApi'
import { ATTACHMENT_GUIDELINES } from '../agent/context/attachmentGuidelines'
import { BUDDY_MANUAL_APPROVAL_PROMPT, createBuddyExecutionPrompt, LEXORA_BUDDY_BASE_SYSTEM_PROMPT } from '../agent/resources/createBuddySystemPrompt'
import { BUDDY_REVIEW_PROMPT } from '../chat/buddyReviewPrompt'

export function getBuiltinPromptCatalog(platform?: NodeJS.Platform): BuiltinPromptCatalog {
  return {
    system: LEXORA_BUDDY_BASE_SYSTEM_PROMPT,
    execution: {
      read_only: createBuddyExecutionPrompt('read_only', platform),
      workspace_write: createBuddyExecutionPrompt('workspace_write', platform),
      full_access: createBuddyExecutionPrompt('full_access', platform),
    },
    approval: BUDDY_MANUAL_APPROVAL_PROMPT,
    attachments: ATTACHMENT_GUIDELINES,
    review: BUDDY_REVIEW_PROMPT,
  }
}
