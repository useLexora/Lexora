export interface EventSubscription { dispose: () => void }
export interface EventSubscriptionOptions { signal?: AbortSignal, once?: boolean }
export type EventName<Events> = Extract<keyof Events, string>
type NamespacePattern<Name extends string> = Name extends `${infer Head}:${infer Tail}` ? `${Head}:*` | `${Head}:**` | `${Head}:${NamespacePattern<Tail>}` : never
export type EventPattern<Events> = EventName<Events> | '*' | '**' | NamespacePattern<EventName<Events>>
type Matches<Name extends string, Pattern extends string> = Pattern extends '**' ? true
  : Pattern extends `${infer Prefix}:**` ? Name extends Prefix | `${Prefix}:${string}` ? true : false
    : Pattern extends `${infer Prefix}:*` ? Name extends `${Prefix}:${infer Tail}` ? Tail extends `${string}:${string}` ? false : true : false
      : Pattern extends '*' ? Name extends `${string}:${string}` ? false : true : Name extends Pattern ? true : false
export type EventMessage<Events, Pattern extends string = '**'> = Pattern extends unknown ? {
  [Name in EventName<Events>]: Matches<Name, Pattern> extends true ? Readonly<{ type: Name, data: Events[Name] }> : never
}[EventName<Events>] : never
export interface EventSubscriber<Events> {
  on: <const Pattern extends EventPattern<Events>>(patterns: Pattern | readonly Pattern[], listener: (event: EventMessage<Events, Pattern>) => unknown, options?: EventSubscriptionOptions) => EventSubscription
}
export type EventSnapshot<Value> = Value extends (...args: never[]) => unknown ? Value : Value extends object ? { readonly [Key in keyof Value]: EventSnapshot<Value[Key]> } : Value
