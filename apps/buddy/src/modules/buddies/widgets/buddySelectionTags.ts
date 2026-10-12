import type { SelectRenderTag } from 'naive-ui'
import { NTag } from 'naive-ui'
import { h } from 'vue'

export function createBuddySelectionTagRenderer(disabled: () => boolean): SelectRenderTag {
  return ({ option, handleClose }) => h(NTag, {
    size: 'small',
    closable: !disabled(),
    disabled: disabled(),
    onClose: handleClose,
  }, () => typeof option.label === 'string' ? option.label : String(option.value))
}
