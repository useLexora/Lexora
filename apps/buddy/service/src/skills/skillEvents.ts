export interface SkillEventIdentity {
  readonly sourceId: string
  readonly sequence: number
  readonly generation: number
  readonly spaceId: string | null
}
export type SkillEventDetails
  = | { readonly type: 'installation', readonly reason: 'discovered' | 'enabled' | 'installed' | 'removed', readonly installationIds: readonly string[], readonly operationId: string }
    | { readonly type: 'catalog', readonly mode: 'discovery' | 'management', readonly catalogRevision: string, readonly skillIds: readonly string[] }
    | { readonly type: 'resources', readonly resourceRevision: string, readonly previousRevision: string | null, readonly skillIds: readonly string[] }
    | { readonly type: 'cleanup', readonly status: 'pending' | 'completed' | 'cancelled' | 'failed', readonly installationId: string, readonly error?: 'SKILL_CLEANUP_FAILED' }
export type SkillEvent = SkillEventIdentity & SkillEventDetails
