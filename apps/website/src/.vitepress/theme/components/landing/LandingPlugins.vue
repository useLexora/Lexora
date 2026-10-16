<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import LandingIcon from './LandingIcon.vue'
import LandingImagePreview from './LandingImagePreview.vue'

defineProps<{ content: LandingContent['plugins'], preview: LandingContent['workbench'], english: boolean }>()
</script>

<template>
  <section id="plugins" class="plugins" aria-labelledby="plugins-title">
    <div class="site-container">
      <div class="plugin-heading">
        <div>
          <h2 id="plugins-title">
            {{ content.title }}
          </h2>
        </div><p>{{ content.description }}</p>
      </div>
      <ol class="creation-steps">
        <li v-for="(step, index) in content.steps" :key="step">
          <span>0{{ index + 1 }}</span>{{ step }}<LandingIcon v-if="index < content.steps.length - 1" name="arrow" />
        </li>
      </ol>
      <div class="plugin-examples">
        <figure class="plugin-example game-example">
          <div class="example-label">
            <span>01 / PLAY</span><h3>{{ english ? 'A desktop mini-game' : '桌面小游戏' }}</h3>
          </div><LandingImagePreview src="/landing/screenshots/plugin-game.webp" :alt="english ? 'A desktop game plugin with characters, a hammer and score effects' : '桌面小游戏插件，显示角色、锤子和得分特效'" :title="english ? 'Desktop mini-game' : '桌面小游戏'" :enlarge="preview.enlarge" :close="preview.close" :original="preview.original" :width="946" :height="336" /><figcaption>{{ english ? 'Mini-game plugin · v0.9.2 · Chinese UI' : '小游戏插件 · v0.9.2' }}</figcaption>
        </figure>
        <figure class="plugin-example music-example">
          <div class="example-label">
            <span>02 / LISTEN</span><h3>{{ english ? 'Moonlight Record' : '月光唱片' }}</h3>
          </div><LandingImagePreview src="/landing/screenshots/plugin-moonlight.webp" :alt="english ? 'Moonlight Record plugin delivery and an expanded player' : '月光唱片插件的交付与展开的播放器'" :title="english ? 'Moonlight Record' : '月光唱片'" :enlarge="preview.enlarge" :close="preview.close" :original="preview.original" :width="1152" :height="680" /><figcaption>{{ english ? 'An expanded player, refined in conversation · Chinese UI' : '从播放器到迷你模式，在同一任务里继续打磨' }}</figcaption>
        </figure>
      </div>
      <div class="host-capabilities">
        <div><h3>{{ content.hostTitle }}</h3><p>{{ content.hostDescription }}</p></div><ul>
          <li v-for="capability in content.capabilities" :key="capability">
            <LandingIcon name="check" />{{ capability }}
          </li>
        </ul>
      </div>
      <div class="extension-note">
        <div><h3>{{ content.extensionTitle }}</h3><p>{{ content.extensionDescription }}</p><a class="methods-link" :href="withBase(english ? '/en/guide/skills-and-mcp' : '/guide/skills-and-mcp')">{{ english ? 'Use Skills and MCP' : '使用 Skills 与 MCP' }}<LandingIcon name="arrow" /></a></div><a :href="withBase(english ? '/en/guide/plugins' : '/guide/plugins')">{{ content.more }}<LandingIcon name="arrow" /></a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plugins { padding: 76px 0 68px; background: var(--crew-deep); color: var(--crew-paper); margin-bottom: 92px; }
.plugins .section-label { color: var(--crew-gold); }
.plugin-heading { display: grid; grid-template-columns: 1fr 1fr; gap: 80px; align-items: end; }
.plugin-heading > p { font-size: 15px; line-height: 1.9; color: var(--crew-light); max-width: 520px; }
.creation-steps { list-style: none; display: grid; grid-template-columns: repeat(4, 1fr); padding: 0; margin: 38px 0 30px; border-block: 1px solid #6884bd65; }
.creation-steps li { display: flex; align-items: center; gap: 16px; min-height: 64px; font-size: 13px; padding-right: 25px; }
.creation-steps li > span { font: 500 10px var(--site-mono); color: var(--crew-gold); }
.creation-steps svg { margin-left: auto; width: 17px; color: #9bafd6; }
.plugin-examples { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; }
.plugin-example { padding: 22px 22px 15px; border: 1px solid #7790c47a; background: #263d6e; }
.music-example { margin-top: 39px; background: #293b61; }
.example-label { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
.example-label > span { font: 500 10px var(--site-mono); color: var(--crew-gold); letter-spacing: .09em; }
.example-label h3 { font-size: 16px; font-weight: 500; }
.plugin-example :deep(.preview-trigger) { border-radius: 4px; }
.plugin-example figcaption { margin-top: 13px; font-size: 10px; color: var(--crew-light); }
.host-capabilities { display: grid; grid-template-columns: 1fr 1.3fr; gap: 75px; align-items: start; border-bottom: 1px solid #6884bd65; margin-top: 45px; padding-bottom: 35px; }
.host-capabilities h3, .extension-note h3 { font-size: 18px; font-weight: 500; letter-spacing: -.02em; }
.host-capabilities p, .extension-note p { font-size: 12px; line-height: 1.9; color: var(--crew-light); margin-top: 12px; max-width: 620px; }
.host-capabilities ul { display: flex; flex-wrap: wrap; gap: 15px 24px; list-style: none; padding-top: 3px; }
.host-capabilities li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--crew-light); }
.host-capabilities svg { color: var(--crew-gold); width: 15px; height: 15px; }
.extension-note { display: flex; justify-content: space-between; gap: 50px; padding-top: 31px; align-items: center; }
.extension-note > a { display: flex; align-items: center; gap: 20px; min-height: 44px; font-size: 13px; color: var(--crew-gold); white-space: nowrap; }
.extension-note > a svg { width: 18px; height: 18px; }
.methods-link { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; font-size: 12px; color: var(--crew-gold); }
.methods-link svg { width: 15px; height: 15px; }
.plugins :focus-visible { outline-color: var(--crew-gold); }
@media (max-width: 1000px) { .plugin-heading, .host-capabilities { gap: 40px; } .creation-steps li { gap: 10px; padding-right: 12px; font-size: 12px; } .plugin-examples { gap: 18px; } .plugin-example { padding: 16px; } }
@media (max-width: 760px) {
  .plugins { padding: 49px 0 43px; margin-bottom: 60px; } .plugin-heading { grid-template-columns: 1fr; gap: 22px; } .plugin-heading > p { font-size: 13px; }
  .creation-steps { grid-template-columns: 1fr 1fr; margin: 27px 0 24px; } .creation-steps li { min-height: 49px; font-size: 11px; } .creation-steps svg { width: 14px; } .creation-steps li:nth-child(2) svg { display: none; }
  .plugin-examples { grid-template-columns: 1fr; gap: 19px; } .music-example { margin-top: 0; } .example-label { margin-bottom: 15px; } .example-label h3 { font-size: 14px; }
  .host-capabilities { grid-template-columns: 1fr; gap: 20px; margin-top: 31px; padding-bottom: 28px; } .host-capabilities h3, .extension-note h3 { font-size: 17px; } .host-capabilities ul { gap: 14px 20px; } .host-capabilities li { font-size: 11px; }
  .extension-note { flex-direction: column; align-items: flex-start; gap: 14px; padding-top: 27px; }
}
</style>
