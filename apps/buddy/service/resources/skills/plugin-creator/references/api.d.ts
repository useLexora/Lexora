export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface Disposable { dispose: () => void | Promise<void> }
export interface Resource { readonly id: string, readonly name: string }
export interface ResourceApi { readText: (resource: Resource) => Promise<string> }
export interface LocalFile extends Resource { readonly mimeType: string, readonly size: number, readonly relativePath?: string }
export interface LocalDirectory extends Resource {}
export interface LocalResourceApi extends ResourceApi {
  pickFiles: (options?: { filters?: { name: string, extensions: string[] }[], multiple?: boolean }) => Promise<LocalFile[]>
  listFiles: () => Promise<LocalFile[]>
  getUrl: (resource: Pick<LocalFile, 'id'>) => Promise<string>
  readBytes: (resource: Pick<LocalFile, 'id'>, options?: { offset?: number, length?: number }) => Promise<{ data: Uint8Array, size: number, eof: boolean }>
  revokeFile: (resource: Pick<LocalFile, 'id'>) => Promise<void>
  pickDirectory: () => Promise<LocalDirectory | null>
  listDirectories: () => Promise<LocalDirectory[]>
  scanDirectory: (directory: Pick<LocalDirectory, 'id'>, options?: { extensions?: string[], recursive?: boolean }) => Promise<LocalFile[]>
  revokeDirectory: (directory: Pick<LocalDirectory, 'id'>) => Promise<void>
  saveFile: (options: { name: string, data: Blob | ArrayBuffer | Uint8Array }) => Promise<boolean>
}
export interface NetworkApi { get: (url: string) => Promise<{ status: number, text: string }> }
export interface ScheduleInput { id: string, command: string, enabled: boolean, intervalMinutes: number }
export interface Schedule extends ScheduleInput { nextRunAt: number | null }
export interface ScheduleApi {
  get: (id: string) => Promise<Schedule | null>
  set: (schedule: ScheduleInput) => Promise<Schedule>
  remove: (id: string) => Promise<void>
}
export interface ExtensionContext {
  readonly extension: { readonly id: string, readonly version: string, readonly apiVersion: 1 | 2 }
  readonly subscriptions: { add: <T extends Disposable>(disposable: T) => T }
  readonly commands: { register: (id: string, execute: (context: { resource: Resource | null, arguments: Json }) => Json | void | Promise<Json | void>) => Disposable }
  readonly placements: { show: (id: string) => Promise<string>, hide: (id: string) => Promise<string | null> }
  readonly views: { open: (type: string, options?: { resource?: Resource | null, state?: Json }) => Promise<string> }
  readonly resources: ResourceApi
  readonly network: NetworkApi
  readonly storage: { get: () => Promise<Json>, set: (value: Json) => Promise<void> }
  readonly notifications: { show: (notification: { title: string, body: string }) => Promise<boolean> }
  readonly schedules: ScheduleApi
}
export interface AnchorGeometry {
  readonly kind: 'app.sidebar' | 'workbench.sidebar' | 'workbench.pane' | 'composer.input'
  readonly visible: boolean
  readonly width: number
  readonly height: number
}
export interface ControlSnapshot {
  readonly revision: string
  readonly value: string | null
  readonly options: readonly { readonly value: string, readonly label: string }[]
  readonly disabled: boolean
}
export type MountTarget = 'workbench' | 'app.sidebar' | 'workbench.sidebar'
export type MountLength = number | `${number}%` | null
export interface ViewPresentation {
  target?: MountTarget
  position?: 'static' | 'absolute'
  order?: number
  zIndex?: number
  width?: MountLength
  height?: MountLength
  top?: MountLength
  right?: MountLength
  bottom?: MountLength
  left?: MountLength
}
export interface MountGeometry {
  readonly target: MountTarget
  readonly visible: boolean
  readonly width: number
  readonly height: number
  readonly rect: { readonly x: number, readonly y: number, readonly width: number, readonly height: number }
}
export type WorkbenchContextValues = Readonly<Record<string, string | number | boolean>>
export type WorkbenchCondition = Record<string, string | number | boolean | (string | number | boolean)[]>
export interface WorkbenchContextSnapshot {
  readonly values: WorkbenchContextValues
  readonly pages: readonly { readonly id: string, readonly title: string }[]
}
export interface ViewContext {
  readonly workbench: WorkbenchContextSnapshot
  onWorkbenchChange: (listener: (snapshot: WorkbenchContextSnapshot) => void) => Disposable
  readonly visible: boolean
  onVisibilityChange: (listener: (visible: boolean) => void) => Disposable
  readonly mount: MountGeometry | null
  onMountChange: (listener: (mount: MountGeometry) => void) => Disposable
  readonly anchor: AnchorGeometry | null
  onAnchorChange: (listener: (anchor: AnchorGeometry) => void) => Disposable
  readonly control: {
    readonly snapshot: ControlSnapshot
    onChange: (listener: (snapshot: ControlSnapshot) => void) => Disposable
    propose: (value: string, revision?: string) => Promise<void>
  } | null
  readonly environment: { language: string, colorScheme: 'light' | 'dark', colors: Record<string, string> }
  onEnvironmentChange: (listener: (environment: ViewContext['environment']) => void) => Disposable
  readonly apiVersion: 1 | 2
  readonly resource: Resource | null
  readonly state: Json
  readonly stateVersion: number
  readonly expectedStateVersion: number
  readonly signal: AbortSignal
  onActivity: (listener: (event: { readonly type: 'composer-input', readonly caret?: { readonly x: number, readonly y: number, readonly width: number, readonly height: number } | null }) => void) => Disposable
  readonly resources: LocalResourceApi
  readonly network: NetworkApi
  readonly commands: { execute: (command: string, args?: Json) => Promise<Json> }
  setPresentation: (presentation: ViewPresentation) => Promise<void>
  setState: (state: Json) => Promise<void>
}
export interface ExtensionModule {
  activate: (context: ExtensionContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
  migrate?: (previous: Json, from: number, to: number) => Json | Promise<Json>
}
export interface ViewModule { render: (context: ViewContext, container: HTMLElement) => void | Promise<void> }
