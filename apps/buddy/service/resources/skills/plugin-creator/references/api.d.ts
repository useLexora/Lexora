export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type ReadonlyJson = string | number | boolean | null | ReadonlyJsonArray | ReadonlyJsonObject
export interface ReadonlyJsonArray extends ReadonlyArray<ReadonlyJson> {}
export interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJson }
export interface Disposable { dispose: () => void | Promise<void> }
export interface EventSubscription { dispose: () => void }
export interface EventSubscriptionOptions { signal?: AbortSignal, once?: boolean }
export type EventName<Events> = Extract<keyof Events, string>
type NamespacePattern<Name extends string> = Name extends `${infer Head}:${infer Tail}` ? `${Head}:*` | `${Head}:**` | `${Head}:${NamespacePattern<Tail>}` : never
export type EventPattern<Events> = EventName<Events> | '*' | '**' | NamespacePattern<EventName<Events>>
type EventMatches<Name extends string, Pattern extends string> = Pattern extends '**' ? true
  : Pattern extends `${infer Prefix}:**` ? Name extends Prefix | `${Prefix}:${string}` ? true : false
    : Pattern extends `${infer Prefix}:*` ? Name extends `${Prefix}:${infer Tail}` ? Tail extends `${string}:${string}` ? false : true : false
      : Pattern extends '*' ? Name extends `${string}:${string}` ? false : true : Name extends Pattern ? true : false
export type EventMessage<Events, Pattern extends string = '**'> = Pattern extends unknown ? {
  [Name in EventName<Events>]: EventMatches<Name, Pattern> extends true ? Readonly<{ type: Name, data: Events[Name] }> : never
}[EventName<Events>] : never
export interface EventSubscriber<Events> {
  on: <const Pattern extends EventPattern<Events>>(patterns: Pattern | readonly Pattern[], listener: (event: EventMessage<Events, Pattern>) => unknown, options?: EventSubscriptionOptions) => EventSubscription
}
export type EventSnapshot<Value> = Value extends object ? { readonly [Key in keyof Value]: EventSnapshot<Value[Key]> } : Value
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
export interface CommandInvocation {
  readonly target: 'composer.actions' | 'task.actions' | 'resource.actions' | 'message.actions' | 'view' | 'slash'
  readonly instanceId: string | null
  readonly content?: string
}
export interface Rect { readonly x: number, readonly y: number, readonly width: number, readonly height: number }
export interface PaneSnapshot { readonly id: string, readonly active: boolean, readonly visible: boolean, readonly rect: Rect }
export interface Interaction { readonly id: string, readonly signal: AbortSignal, end: () => Promise<void> }
export interface PlacementOptions { instanceId?: string, interactionId?: string }
export interface HitRegion { id: string, label: string, rect: Rect }
export interface ModelSelection { providerId: string, modelId: string }
export type SettingValue = boolean | string | number | ModelSelection | null
export interface ConfigurationEvents {
  'configuration:changed': { readonly configuration: EventSnapshot<Record<string, SettingValue>>, readonly changedKeys: readonly string[] }
}
export interface WorkbenchPaneEvents {
  'workbench:panes:changed': { readonly panes: readonly PaneSnapshot[] }
}
export interface ExtensionEvents extends ConfigurationEvents, WorkbenchPaneEvents {}
export interface TaskTitle {
  id: string
  title: string | null
  titleSource: 'legacy' | 'manual' | 'fallback' | 'generated'
}
export interface AgentToolContext {
  readonly signal: AbortSignal
  readonly task: {
    get: () => Promise<TaskTitle>
    messages: () => Promise<{ role: 'user' | 'assistant', text: string }[]>
    rename: (input: { title: string }) => Promise<{ applied: boolean }>
  }
  readonly models: {
    generateText: (input: { prompt: string, system?: string, model?: ModelSelection | null, maxTokens?: number }) => Promise<{ text: string, model: ModelSelection }>
  }
}
export interface TaskActionEvents {
  'task:input:committed': { readonly conversationId: string, readonly branchId: string, readonly runId: string, readonly messageId: string, readonly commitId: string }
  'task:turn:completed': { readonly conversationId: string, readonly branchId: string, readonly runId: string, readonly triggeringMessageId: string, readonly completedAt: string }
}
export interface AgentActionContext extends AgentToolContext {
  readonly cause: EventMessage<TaskActionEvents> | Readonly<{ type: 'user' }>
}
export interface AgentActionResult { status: 'completed' | 'skipped', message?: string }
export type ConditionInput = 'configuration' | 'runtime.models' | 'runtime.task' | 'workbench' | 'form'
export interface ConditionReference { condition: string, params?: ReadonlyJsonObject }
export interface ConditionResult { value: boolean, reason?: string }
export type ConfigurationScope = { kind: 'global' } | { kind: 'space', spaceId: string } | { kind: 'task', taskId: string }
export type ConditionInvocationScope = { kind: 'settings', moduleId: string, groupId: string } | { kind: 'task', taskId: string, runId: string | null }
export type ConditionData<T> = EventSnapshot<{ status: 'available', revision: string } & T> | Readonly<{ status: 'not_requested' | 'no_context' | 'denied' | 'unsupported' | 'loading' | 'invalid' }>
export interface ConditionContext {
  readonly version: 1
  readonly signal: AbortSignal
  readonly scope: EventSnapshot<{ key: string, configuration: ConfigurationScope, invocation: ConditionInvocationScope }>
  readonly target: Readonly<{ kind: 'setting' | 'agent' | 'action', id: string }>
  readonly configuration: ConditionData<{ values: Record<string, SettingValue>, sources: Record<string, ConfigurationScope> }>
  readonly runtime: Readonly<{
    models: ConditionData<{ selection: ModelSelection | null, models: { providerId: string, modelId: string, name: string, available: boolean, capabilities: string[] }[] }>
    task: ConditionData<{ id: string, spaceId: string | null, branchId: string, title: string | null, titleSource: 'fallback' | 'generated' | 'manual' | 'legacy', activity: 'idle' | 'running' | 'awaiting_approval', modelSelection: ModelSelection | null }>
  }>
  readonly workbench: ConditionData<{ panes: { id: string, active: boolean, visible: boolean }[] }>
  readonly form: ConditionData<{ values: Record<string, SettingValue>, dirtyKeys: string[] }>
}
export interface ConditionApi {
  register: (id: string, evaluate: (context: ConditionContext, params: ReadonlyJsonObject) => boolean | ConditionResult | Promise<boolean | ConditionResult>) => Disposable
  invalidate: (input?: { condition?: string, scopeKey?: string }) => Promise<void>
}
export interface ExtensionContext {
  readonly extension: { readonly id: string, readonly version: string, readonly apiVersion: 1 | 2 | 3 }
  readonly events: EventSubscriber<ExtensionEvents>
  readonly configuration: {
    get: () => Promise<Record<string, SettingValue>>
    onChange: (listener: (configuration: Readonly<Record<string, SettingValue>>) => void | Promise<void>) => Disposable
  }
  readonly conditions: ConditionApi
  readonly agent: {
    registerTool: (id: string, execute: (input: Record<string, string | number | boolean>, context: AgentToolContext) => Json | void | Promise<Json | void>) => Disposable
    registerAction: (id: string, execute: (context: AgentActionContext) => AgentActionResult | Promise<AgentActionResult>) => Disposable
  }
  readonly subscriptions: { add: <T extends Disposable>(disposable: T) => T }
  readonly commands: { register: (id: string, execute: (context: { resource: Resource | null, arguments: Json, invocation: CommandInvocation | null }) => Json | void | Promise<Json | void>) => Disposable }
  readonly placements: { show: (id: string, options?: string | PlacementOptions) => Promise<string>, hide: (id: string, options?: string | PlacementOptions) => Promise<string | null> }
  readonly workbench: { readonly panes: readonly PaneSnapshot[], onPanesChange: (listener: (panes: readonly PaneSnapshot[]) => void) => Disposable }
  readonly interactions: { start: (title: string) => Promise<Interaction> }
  readonly views: { broadcast: (message: Json) => Promise<void>, open: (type: string, options?: { resource?: Resource | null, state?: Json }) => Promise<string> }
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
export type MountTarget = 'workbench' | 'app.sidebar' | 'workbench.sidebar' | 'workbench.pane'
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
  readonly instanceId?: string
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
  readonly events: EventSubscriber<ViewEvents>
  readonly interaction: {
    readonly id: string
    setRegions: (regions: readonly HitRegion[]) => Promise<void>
    onActivate: (listener: (event: { readonly id: string, readonly x: number, readonly y: number }) => void) => Disposable
  } | null
  onMessage: (listener: (message: Json) => void) => Disposable
  readonly instanceId: string | null
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
  readonly environment: ViewEnvironment
  onEnvironmentChange: (listener: (environment: ViewContext['environment']) => void) => Disposable
  readonly apiVersion: 1 | 2 | 3
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
  setActive: (active: boolean) => Promise<void>
}
export interface ViewEnvironment {
  readonly language: string
  readonly colorScheme: 'light' | 'dark'
  readonly colors: Readonly<Record<string, string>>
}
export interface ViewStateEvents {
  'view:visibility:changed': { readonly visible: boolean }
  'view:environment:changed': { readonly environment: ViewEnvironment }
}
export interface ViewGeometryEvents {
  'view:mount:changed': { readonly mount: MountGeometry }
  'view:anchor:changed': { readonly anchor: AnchorGeometry }
}
export interface ViewMessageEvents {
  'view:message:received': { readonly message: ReadonlyJson }
}
export interface WorkbenchContextEvents {
  'workbench:context:changed': { readonly context: WorkbenchContextSnapshot }
}
export interface ControlEvents {
  'control:changed': { readonly control: ControlSnapshot }
}
export interface InteractionEvents {
  'interaction:activated': { readonly regionId: string, readonly x: number, readonly y: number }
}
export interface ComposerEvents {
  'composer:input:received': { readonly caret?: Rect | null }
}
export interface ViewEvents extends ViewStateEvents, ViewGeometryEvents, ViewMessageEvents, WorkbenchContextEvents, ControlEvents, InteractionEvents, ComposerEvents {}
export interface ExtensionModule {
  activate: (context: ExtensionContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
  migrate?: (previous: Json, from: number, to: number) => Json | Promise<Json>
}
export interface ViewModule { render: (context: ViewContext, container: HTMLElement) => void | Promise<void> }
