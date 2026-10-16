export interface EntityAvatarProps {
  name: string
  src?: string | null
  alt?: string
  size?: number | string
  shape?: 'circle' | 'rounded'
  kind?: 'user' | 'workspace'
}
