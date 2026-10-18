export const DESKTOP_NAVIGATION_LAYOUTS = ['full', 'compact', 'immersive'] as const

export type DesktopNavigationLayout = typeof DESKTOP_NAVIGATION_LAYOUTS[number]
