import type { SpaceIconColor } from '../spaces/spaceAppearance'
import { themeFonts } from './themeTokens'

export type BuddyColorScheme = 'light' | 'dark'

export interface BuddyColorTheme {
  colorScheme: BuddyColorScheme
  surface: {
    canvas: string
    raised: string
    muted: string
    userMessage: string
  }
  state: {
    hover: string
    pressed: string
    selected: string
    selectedHover: string
  }
  selection: {
    background: string
    inactive: string
    match: string
  }
  border: {
    subtle: string
    strong: string
  }
  text: {
    strong: string
    primary: string
    secondary: string
    disabled: string
    onAccent: string
  }
  accent: {
    solid: string
    solidHover: string
    solidPressed: string
    text: string
    focus: string
    surfaceSubtle: string
    surface: string
    surfaceHover: string
    surfacePressed: string
    border: string
    borderHover: string
    onOverlay: string
    onSurface: string
  }
  status: {
    success: BuddyStatusColors
    warning: BuddyStatusColors
    danger: BuddyStatusColors
  }
  brand: {
    gold: string
    goldSurface: string
  }
  avatar: {
    background: string
    foreground: string
  }
  data: {
    violet: string
    cyan: string
    blue: string
  }
  spaceIcon: Record<Exclude<SpaceIconColor, 'default'>, string>
  shadow: {
    soft: string
    raised: string
    overlay: string
    window: string
    illustration: string
  }
}

interface BuddyStatusColors {
  solid: string
  solidHover: string
  solidPressed: string
  text: string
  surface: string
  surfaceHover: string
  border: string
}

type BuddyBaseTheme = Omit<BuddyColorTheme, 'state' | 'selection'>

const lightTheme: BuddyBaseTheme = {
  colorScheme: 'light',
  surface: {
    canvas: '#fafaf8',
    raised: '#ffffff',
    muted: 'rgba(32, 37, 34, 0.04)',
    userMessage: '#edf4ff',
  },
  border: {
    subtle: 'rgba(32, 37, 34, 0.1)',
    strong: 'rgb(32 37 34 / 18%)',
  },
  text: {
    strong: '#202522',
    primary: '#414844',
    secondary: '#666e69',
    disabled: '#929994',
    onAccent: '#ffffff',
  },
  accent: {
    solid: '#506b90',
    solidHover: '#5b769c',
    solidPressed: '#40597b',
    text: '#40597b',
    focus: '#506b90',
    surfaceSubtle: 'rgb(80 107 144 / 7%)',
    surface: 'rgb(80 107 144 / 12%)',
    surfaceHover: 'rgb(80 107 144 / 16%)',
    surfacePressed: 'rgb(80 107 144 / 20%)',
    border: 'rgb(80 107 144 / 38%)',
    borderHover: 'rgb(80 107 144 / 54%)',
    onOverlay: '#91abcc',
    onSurface: '#40597b',
  },
  status: {
    success: {
      solid: '#287550',
      solidHover: '#2d8059',
      solidPressed: '#226343',
      text: '#287550',
      surface: '#e8f4ed',
      surfaceHover: '#deede4',
      border: '#a9d6bd',
    },
    warning: {
      solid: '#89591e',
      solidHover: '#936020',
      solidPressed: '#744a18',
      text: '#89591e',
      surface: '#fbf1e3',
      surfaceHover: '#f6e7d1',
      border: '#e4c28e',
    },
    danger: {
      solid: '#b94747',
      solidHover: '#c14d4d',
      solidPressed: '#9f3d3d',
      text: '#b94747',
      surface: '#f9eaea',
      surfaceHover: '#f3dddd',
      border: '#e3adad',
    },
  },
  brand: {
    gold: '#b97a25',
    goldSurface: '#f7eddd',
  },
  avatar: {
    background: '#b7bec5',
    foreground: '#fafaf8',
  },
  data: {
    violet: '#7569a7',
    cyan: '#4f8994',
    blue: '#5d79ad',
  },
  spaceIcon: {
    'gray': '#6c747d',
    'gray-deep': '#354353',
    'red': '#b64b4b',
    'red-bright': '#ef4444',
    'red-deep': '#8e2636',
    'orange': '#a56924',
    'orange-bright': '#df7315',
    'orange-deep': '#854817',
    'yellow': '#9e8731',
    'yellow-bright': '#b98a00',
    'yellow-deep': '#756016',
    'green': '#347a52',
    'green-bright': '#229b52',
    'green-deep': '#1e573a',
    'cyan': '#277d89',
    'cyan-bright': '#0495aa',
    'cyan-deep': '#175361',
    'blue': '#426faa',
    'blue-bright': '#3478f6',
    'blue-deep': '#234b7c',
    'purple': '#7b60aa',
    'purple-bright': '#9754ef',
    'purple-deep': '#563585',
    'pink': '#ab527c',
    'pink-bright': '#df4091',
    'pink-deep': '#802d59',
  },
  shadow: {
    soft: '0 1px 3px rgb(31 37 33 / 9%)',
    raised: '0 10px 28px rgb(31 37 33 / 10%)',
    overlay: '0 1px 2px rgb(31 37 33 / 8%), 0 8px 18px rgb(31 37 33 / 12%)',
    window: 'inset 0 0 0 1px rgb(255 255 255 / 70%), 0 12px 32px rgb(31 37 33 / 10%)',
    illustration: '0 4px 11px rgb(31 37 33 / 10%), 0 18px 42px rgb(31 37 33 / 14%)',
  },
}

const darkTheme: BuddyBaseTheme = {
  colorScheme: 'dark',
  surface: {
    canvas: '#202422',
    raised: '#2a2f2b',
    muted: 'rgba(255, 255, 255, 0.05)',
    userMessage: '#29384a',
  },
  border: {
    subtle: 'rgba(255, 255, 255, 0.11)',
    strong: 'rgb(255 255 255 / 20%)',
  },
  text: {
    strong: '#f2f4f0',
    primary: '#d5dad5',
    secondary: '#aab1ab',
    disabled: '#737a74',
    onAccent: '#ffffff',
  },
  accent: {
    solid: '#506b90',
    solidHover: '#5b769c',
    solidPressed: '#40597b',
    text: '#91abcc',
    focus: '#91abcc',
    surfaceSubtle: 'rgb(145 171 204 / 8%)',
    surface: 'rgb(145 171 204 / 13%)',
    surfaceHover: 'rgb(145 171 204 / 18%)',
    surfacePressed: 'rgb(145 171 204 / 24%)',
    border: 'rgb(145 171 204 / 38%)',
    borderHover: 'rgb(145 171 204 / 54%)',
    onOverlay: '#91abcc',
    onSurface: '#a9bed8',
  },
  status: {
    success: {
      solid: '#287550',
      solidHover: '#2d8059',
      solidPressed: '#226343',
      text: '#70ce9c',
      surface: '#21362b',
      surfaceHover: '#294334',
      border: '#3f7559',
    },
    warning: {
      solid: '#89591e',
      solidHover: '#936020',
      solidPressed: '#744a18',
      text: '#e2ad64',
      surface: '#3b3022',
      surfaceHover: '#483a28',
      border: '#7d623b',
    },
    danger: {
      solid: '#b94747',
      solidHover: '#c14d4d',
      solidPressed: '#9f3d3d',
      text: '#ef9898',
      surface: '#3d2929',
      surfaceHover: '#4b3030',
      border: '#865050',
    },
  },
  brand: {
    gold: '#dda64f',
    goldSurface: '#3c3223',
  },
  avatar: {
    background: '#59616b',
    foreground: '#f2f4f0',
  },
  data: {
    violet: '#9a8bd1',
    cyan: '#68adb8',
    blue: '#7795c7',
  },
  spaceIcon: {
    'gray': '#aeb8c4',
    'gray-deep': '#7c8998',
    'red': '#e79797',
    'red-bright': '#ff676b',
    'red-deep': '#c96065',
    'orange': '#e1b477',
    'orange-bright': '#ffa044',
    'orange-deep': '#b77a39',
    'yellow': '#d9c57a',
    'yellow-bright': '#f5d34c',
    'yellow-deep': '#9a872b',
    'green': '#89c99e',
    'green-bright': '#49d187',
    'green-deep': '#329a64',
    'cyan': '#79c3cd',
    'cyan-bright': '#35c7de',
    'cyan-deep': '#26969f',
    'blue': '#8eb2e3',
    'blue-bright': '#579dff',
    'blue-deep': '#5b85d6',
    'purple': '#b6a0de',
    'purple-bright': '#b983ff',
    'purple-deep': '#9267ca',
    'pink': '#db9abd',
    'pink-bright': '#f171bd',
    'pink-deep': '#b65b8f',
  },
  shadow: {
    soft: '0 1px 3px rgb(0 0 0 / 18%)',
    raised: '0 10px 28px rgb(0 0 0 / 28%)',
    overlay: '0 1px 2px rgb(0 0 0 / 22%), 0 8px 18px rgb(0 0 0 / 30%)',
    window: 'inset 0 0 0 1px rgb(255 255 255 / 5%), 0 12px 32px rgb(0 0 0 / 30%)',
    illustration: '0 4px 11px rgb(0 0 0 / 20%), 0 18px 42px rgb(0 0 0 / 32%)',
  },
}

export function withAccentInteractionStates(theme: BuddyBaseTheme): BuddyColorTheme {
  return {
    ...theme,
    selection: {
      background: `${theme.accent.text}40`,
      inactive: `${theme.accent.text}26`,
      match: `${theme.accent.text}1f`,
    },
    state: {
      hover: theme.accent.surfaceSubtle,
      selected: theme.accent.surface,
      selectedHover: theme.accent.surfaceHover,
      pressed: theme.accent.surfacePressed,
    },
  }
}

export const buddyColorThemes = {
  dark: withAccentInteractionStates(darkTheme),
  light: withAccentInteractionStates(lightTheme),
} as const

export function createBuddyColorVariables(theme: BuddyColorTheme): Record<string, string> {
  return {
    '--buddy-font-ui': themeFonts.ui,
    '--buddy-font-mono': themeFonts.mono,
    ...Object.fromEntries(Object.entries(theme.spaceIcon).map(([color, value]) => [`--buddy-space-icon-${color}`, value])),
    '--buddy-surface-canvas': theme.surface.canvas,
    '--buddy-surface-app-sidebar': theme.surface.canvas,
    '--buddy-surface-workspace-sidebar': theme.surface.canvas,
    '--buddy-surface-base': theme.surface.canvas,
    '--buddy-surface-raised': theme.surface.raised,
    '--buddy-surface-subtle': theme.surface.muted,
    '--buddy-user-message-surface': theme.surface.userMessage,
    '--buddy-state-hover': theme.state.hover,
    '--buddy-state-pressed': theme.state.pressed,
    '--buddy-state-selected': theme.state.selected,
    '--buddy-state-selected-hover': theme.state.selectedHover,
    '--buddy-text-selection': theme.selection.background,
    '--buddy-text-selection-inactive': theme.selection.inactive,
    '--buddy-text-selection-match': theme.selection.match,
    '--buddy-nav-hover': theme.accent.surfaceSubtle,
    '--buddy-nav-selected': theme.accent.surface,
    '--buddy-nav-selected-hover': theme.state.selectedHover,
    '--buddy-nav-pressed': theme.state.pressed,
    '--buddy-nav-foreground': theme.accent.onSurface,
    '--buddy-border-subtle': theme.border.subtle,
    '--buddy-border-strong': theme.border.strong,
    '--buddy-text-strong': theme.text.strong,
    '--buddy-text-primary': theme.text.primary,
    '--buddy-text-secondary': theme.text.secondary,
    '--buddy-text-muted': theme.text.secondary,
    '--buddy-text-disabled': theme.text.disabled,
    '--buddy-text-on-accent': theme.text.onAccent,
    '--buddy-accent-solid': theme.accent.solid,
    '--buddy-accent-solid-hover': theme.accent.solidHover,
    '--buddy-accent-solid-pressed': theme.accent.solidPressed,
    '--buddy-accent-text': theme.accent.text,
    '--buddy-focus-ring': theme.accent.focus,
    '--buddy-accent-surface-subtle': theme.accent.surfaceSubtle,
    '--buddy-accent-surface': theme.accent.surface,
    '--buddy-accent-surface-hover': theme.accent.surfaceHover,
    '--buddy-accent-surface-pressed': theme.accent.surfacePressed,
    '--buddy-accent-border': theme.accent.border,
    '--buddy-accent-border-hover': theme.accent.borderHover,
    '--buddy-accent-on-surface': theme.accent.onSurface,
    '--buddy-status-success-solid': theme.status.success.solid,
    '--buddy-status-success-text': theme.status.success.text,
    '--buddy-status-success-surface': theme.status.success.surface,
    '--buddy-status-success-surface-hover': theme.status.success.surfaceHover,
    '--buddy-status-success-border': theme.status.success.border,
    '--buddy-status-warning-solid': theme.status.warning.solid,
    '--buddy-status-warning-text': theme.status.warning.text,
    '--buddy-status-warning-surface': theme.status.warning.surface,
    '--buddy-status-warning-surface-hover': theme.status.warning.surfaceHover,
    '--buddy-status-warning-border': theme.status.warning.border,
    '--buddy-status-danger-solid': theme.status.danger.solid,
    '--buddy-status-danger-text': theme.status.danger.text,
    '--buddy-status-danger-surface': theme.status.danger.surface,
    '--buddy-status-danger-surface-hover': theme.status.danger.surfaceHover,
    '--buddy-status-danger-border': theme.status.danger.border,
    '--buddy-brand-gold': theme.brand.gold,
    '--buddy-brand-gold-surface': theme.brand.goldSurface,
    '--buddy-avatar-background': theme.avatar.background,
    '--buddy-avatar-foreground': theme.avatar.foreground,
    '--buddy-data-violet': theme.data.violet,
    '--buddy-data-cyan': theme.data.cyan,
    '--buddy-data-blue': theme.data.blue,
    '--buddy-shadow-soft': theme.shadow.soft,
    '--buddy-shadow-raised': theme.shadow.raised,
    '--buddy-shadow-overlay': theme.shadow.overlay,
    '--buddy-shadow-window': theme.shadow.window,
    '--buddy-shadow-illustration': theme.shadow.illustration,
    '--buddy-media-overlay-background': 'rgb(29 33 31 / 88%)',
    '--buddy-media-overlay-border': 'rgb(255 255 255 / 14%)',
    '--buddy-media-overlay-divider': 'rgb(255 255 255 / 16%)',
    '--buddy-media-overlay-text': 'rgb(255 255 255 / 82%)',
    '--buddy-media-overlay-hover': `color-mix(in srgb, ${theme.accent.onOverlay} 18%, transparent)`,
    '--buddy-media-overlay-focus': theme.accent.onOverlay,
    '--buddy-media-overlay-danger-hover': 'rgb(185 71 71 / 72%)',
    '--buddy-media-overlay-shadow': '0 8px 22px rgb(0 0 0 / 18%), 0 2px 6px rgb(0 0 0 / 12%)',
  }
}
