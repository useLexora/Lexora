import type { AuditUserSummary } from '@haohaoxue/lexora-contracts'
import type { Prisma } from '@prisma/client'

export const auditUserSummarySelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect

type PersistedAuditUserSummary = Prisma.UserGetPayload<{
  select: typeof auditUserSummarySelect
}>

export function toAuditUserSummary(user: PersistedAuditUserSummary | null | undefined): AuditUserSummary | null {
  if (!user) {
    return null
  }

  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  }
}
