// Monaco's public addAction API cannot contribute native submenus.
// Keep the small internal API surface used by resource quoting isolated here.
declare module 'monaco-editor/platform/actions/common/actions.js' {
  interface MenuItem {
    command?: { id: string, title: string, precondition?: unknown }
    submenu?: MenuId
    title?: string
    when?: unknown
    group?: string
    order?: number
  }
  export class MenuId {
    constructor(id: string)
    readonly id: string
    static EditorContext: MenuId
  }
  export const MenuRegistry: {
    appendMenuItem: (menu: MenuId, item: MenuItem) => { dispose: () => void }
    getMenuItems: (menu: MenuId) => MenuItem[]
  }
}
declare module 'monaco-editor/platform/commands/common/commands.js' {
  export const CommandsRegistry: {
    registerCommand: (id: string, handler: () => void) => { dispose: () => void }
    getCommand: (id: string) => { handler: () => void } | undefined
  }
}
declare module 'monaco-editor/platform/contextkey/common/contextkey.js' {
  export const ContextKeyExpr: {
    deserialize: (expression: string) => unknown
  }
}
