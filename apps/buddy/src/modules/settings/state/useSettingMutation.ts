import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import { readonly, shallowRef } from 'vue'

export function useSettingMutation<Field extends string>(
  update: (patch: LexoraConfigPatch) => Promise<boolean>,
  onFailure?: (field: Field) => void,
) {
  const pending = shallowRef<ReadonlySet<Field>>(new Set())
  const failed = shallowRef<ReadonlySet<Field>>(new Set())
  async function save(field: Field, patch: LexoraConfigPatch): Promise<boolean> {
    if (pending.value.has(field))
      return false
    pending.value = new Set([...pending.value, field])
    failed.value = new Set([...failed.value].filter(item => item !== field))
    let succeeded = false
    try {
      succeeded = await update(patch)
      return succeeded
    }
    finally {
      pending.value = new Set([...pending.value].filter(item => item !== field))
      if (!succeeded) {
        failed.value = new Set([...failed.value, field])
        onFailure?.(field)
      }
    }
  }
  return { pending: readonly(pending), failed: readonly(failed), save }
}
