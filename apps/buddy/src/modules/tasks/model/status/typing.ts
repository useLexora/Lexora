export type ChatBlockerKind = 'runtime' | 'provider' | 'no_models' | 'model'

export interface ChatBlocker {
  dismissible: boolean
  kind: ChatBlockerKind
  reason?: 'unavailable' | 'missing'
}
