import type { ResolvedTheme } from './resolveTheme'
import type { ThemeArchiveInput, ThemePreview, ThemeRequest, ThemeSnapshot, ThemeValidation } from './themeApi'
import type { describeTheme, ThemeDescriptor, ThemeDocument, ThemeDocumentInput } from './themeDocument'
import type { ThemePreference } from './themePreferences'

export function createThemeClient(request: (input: ThemeRequest) => Promise<unknown>, subscribe: (listener: () => void) => { dispose: () => void }) {
  return Object.freeze({
    list: () => request({ action: 'list' }) as Promise<ThemeDescriptor[]>,
    get: (id: string) => request({ action: 'get', id }) as Promise<{ descriptor: ThemeDescriptor, document: ThemeDocument }>,
    getActive: () => request({ action: 'active' }) as Promise<ThemeSnapshot>,
    describe: () => request({ action: 'describe' }) as Promise<ReturnType<typeof describeTheme>>,
    validate: (document: unknown) => request({ action: 'validate', document }) as Promise<ThemeValidation>,
    resolve: (appearance: 'light' | 'dark', document: ThemeDocumentInput, overrides?: Record<string, string>) => request({ action: 'resolve', appearance, document, ...(overrides === undefined ? {} : { overrides }) }) as Promise<ResolvedTheme>,
    save: (archive: ThemeArchiveInput, id?: string) => request({ action: 'save', archive, ...(id === undefined ? {} : { id }) }) as Promise<ThemeDescriptor>,
    remove: (id: string) => request({ action: 'remove', id }) as Promise<void>,
    setPreference: (preference: ThemePreference) => request({ action: 'preference', preference }) as Promise<ThemeSnapshot>,
    beginPreview: (archive: ThemeArchiveInput) => request({ action: 'beginPreview', archive }) as Promise<ThemePreview>,
    updatePreview: (preview: ThemePreview, archive: ThemeArchiveInput) => request({ action: 'updatePreview', ...preview, archive }) as Promise<ThemePreview>,
    commitPreview: (preview: ThemePreview) => request({ action: 'commitPreview', ...preview }) as Promise<ThemeDescriptor>,
    cancelPreview: (token: string) => request({ action: 'cancelPreview', token }) as Promise<void>,
    import: (content: string) => request({ action: 'import', content }) as Promise<ThemeDescriptor>,
    export: (id: string) => request({ action: 'export', id }) as Promise<string>,
    onDidChange: (listener: (snapshot: ThemeSnapshot) => void) => {
      let revision = -1
      let active = true
      const subscription = subscribe(() => {
        void request({ action: 'active' }).then((value) => {
          const snapshot = value as ThemeSnapshot
          if (active && snapshot.revision > revision) {
            revision = snapshot.revision
            listener(snapshot)
          }
        }).catch(() => {})
      })
      return { dispose() {
        active = false
        subscription.dispose()
      } }
    },
  })
}
