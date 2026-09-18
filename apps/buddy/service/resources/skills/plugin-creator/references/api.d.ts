export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface Disposable { dispose: () => void | Promise<void> }
export interface Resource { readonly id: string, readonly name: string }
export interface ResourceApi { readText: (resource: Resource) => Promise<string> }
export interface NetworkApi { get: (url: string) => Promise<{ status: number, text: string }> }
export interface ScheduleInput { id: string, command: string, enabled: boolean, intervalMinutes: number }
export interface Schedule extends ScheduleInput { nextRunAt: number | null }
export interface ScheduleApi {
  get: (id: string) => Promise<Schedule | null>
  set: (schedule: ScheduleInput) => Promise<Schedule>
  remove: (id: string) => Promise<void>
}
export interface ExtensionContext {
  readonly extension: { readonly id: string, readonly version: string, readonly apiVersion: 1 }
  readonly subscriptions: { add: <T extends Disposable>(disposable: T) => T }
  readonly commands: { register: (id: string, execute: (context: { resource: Resource | null, arguments: Json }) => Json | void | Promise<Json | void>) => Disposable }
  readonly views: { open: (type: string, options?: { resource?: Resource | null, state?: Json }) => Promise<string> }
  readonly resources: ResourceApi
  readonly network: NetworkApi
  readonly storage: { get: () => Promise<Json>, set: (value: Json) => Promise<void> }
  readonly notifications: { show: (notification: { title: string, body: string }) => Promise<boolean> }
  readonly schedules: ScheduleApi
}
export interface ViewContext {
  readonly environment: { language: string, colorScheme: 'light' | 'dark', colors: Record<string, string> }
  onEnvironmentChange: (listener: (environment: ViewContext['environment']) => void) => Disposable
  readonly apiVersion: 1
  readonly resource: Resource | null
  readonly state: Json
  readonly stateVersion: number
  readonly expectedStateVersion: number
  readonly signal: AbortSignal
  onActivity: (listener: (event: { readonly type: 'composer-input' }) => void) => Disposable
  readonly resources: ResourceApi
  readonly network: NetworkApi
  readonly commands: { execute: (command: string, args?: Json) => Promise<Json> }
  setState: (state: Json) => Promise<void>
}
export interface ExtensionModule {
  activate: (context: ExtensionContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
  migrate?: (previous: Json, from: number, to: number) => Json | Promise<Json>
}
export interface ViewModule { render: (context: ViewContext, container: HTMLElement) => void | Promise<void> }
