import { createApp } from 'vue'
import App from '@/App.vue'
import { createDesktopRouter } from '@/app/router'
import { initializeDesktopFileIcons } from '@/theme/desktopFileIconState'
import { initializeDesktopTheme } from '@/theme/desktopThemeState'
import { applyDesktopTypography } from '@/theme/desktopTypography'
import '@/theme/index.scss'
import 'virtual:uno.css'

const stopTheme = initializeDesktopTheme()
const stopIcons = initializeDesktopFileIcons()
applyDesktopTypography()
if (import.meta.hot) {
  import.meta.hot.dispose(stopTheme)
  import.meta.hot.dispose(stopIcons)
}

createApp(App)
  .use(createDesktopRouter())
  .mount('#app')
