import { WslHostPool } from './WslHostPool'

// One pool for the service process: sessions share the helper of a distribution instead of each starting its own.
// BuddyService closes it on shutdown; the helper also exits by itself when the service goes away or sits idle.
export const sharedWslHosts = new WslHostPool()
