export const CLOSE_PREPARATION_TIMEOUT_MS = 30_000
export const QUIT_PREPARATION_TIMEOUT_MS = CLOSE_PREPARATION_TIMEOUT_MS + 5_000

export interface ClosePreparation {
  validate: () => boolean
}
