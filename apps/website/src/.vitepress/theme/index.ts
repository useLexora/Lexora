import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import GuideImage from './components/GuideImage.vue'
import SiteLayout from './SiteLayout.vue'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore
import './style.css'

export default {
  extends: DefaultTheme,
  Layout: SiteLayout,
  enhanceApp({ app }) {
    app.component('GuideImage', GuideImage)
  },
} satisfies Theme
