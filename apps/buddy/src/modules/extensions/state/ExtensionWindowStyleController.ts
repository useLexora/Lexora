import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { Ref } from 'vue'
import { watch } from 'vue'

export class ExtensionWindowStyleController {
  readonly #styles = new Map<string, HTMLStyleElement>()
  readonly #stop: () => void
  #order = ''

  constructor(extensions: Readonly<Ref<ExtensionStatus[]>>) {
    this.#stop = watch(extensions, (installed) => {
      const active = new Set<string>()
      for (const extension of [...installed].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
        if (!extension.enabled || extension.state !== 'active')
          continue
        for (const sheet of [...extension.windowStyles ?? []].sort((a, b) => a.id.localeCompare(b.id))) {
          const key = JSON.stringify([extension.manifest.id, sheet.id])
          active.add(key)
          let style = this.#styles.get(key)
          if (!style) {
            style = document.createElement('style')
            style.dataset.extensionStyle = extension.manifest.id
            style.dataset.styleId = sheet.id
            this.#styles.set(key, style)
          }
          if (style.textContent !== sheet.css)
            style.textContent = sheet.css
        }
      }
      for (const [key, style] of this.#styles) {
        if (!active.has(key)) {
          style.remove()
          this.#styles.delete(key)
        }
      }
      const order = JSON.stringify([...active])
      if (order !== this.#order) {
        for (const key of active)
          document.head.append(this.#styles.get(key)!)
        this.#order = order
      }
    }, { immediate: true, flush: 'post' })
  }

  dispose(): void {
    this.#stop()
    for (const style of this.#styles.values())
      style.remove()
    this.#styles.clear()
  }
}
