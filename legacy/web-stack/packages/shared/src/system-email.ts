import type { SystemEmailProvider } from '@haohaoxue/lexora-contracts'
import { SYSTEM_EMAIL_PROVIDER_LABELS } from '@haohaoxue/lexora-contracts/system-admin'

export function formatSystemEmailProvider(value: SystemEmailProvider): string {
  return SYSTEM_EMAIL_PROVIDER_LABELS[value]
}
