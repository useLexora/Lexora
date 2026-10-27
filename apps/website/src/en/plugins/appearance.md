---
title: "Themes and appearance"
description: "Use declarative themes, file icons, view styles and window decorations."
---

# Themes and appearance

Choose capabilities by scope. Themes manage selected application appearance, view styles affect plugin content, and authorized window styles and decorations target host regions.

## Color and icon themes

API 3 contributes.themes declares one or more themes with colors and optional welcome content and materials. A purely declarative theme needs no script or permission; the user selects it after enabling the plugin.

Icon themes independently map file and directory icons. Package images and preserve their licenses. This does not replace host action-button icons.

Theme editors use context.themes to validate, preview and save user copies with themeManagement permission. Do not modify application configuration files directly.

## View styles

Use regular CSS, or declare `"styles": {"uno": true}` in a source package. The fixed compiler produces lexora-uno.css and the host loads it:

```ts
container.className = 'flex gap-3 p-4 bg-surface text-fg'
```

Use complete class strings or styles.safelist for dynamic cases; plugin UnoCSS configuration is not executed. Variables such as --lexora-background, --lexora-text and --lexora-accent-solid follow theme changes. Canvas rendering can subscribe to onEnvironmentChange.

## Window styles and decorations

WindowEffects permission enables background window.styles.set/remove. Use stable data-lexora-region selectors. Disabling, crashes and upgrades withdraw styles; restore them during activation. This does not expose host DOM scripting.

Animated decorations run in isolated views on declared anchors. Choose event source and display scope separately: window, task workspace, pane, history and composer are different regions. Input activity contains no characters or keys; coordinates are local to the anchor.

Decorations receive no pointer or focus. Keep backgrounds transparent, bound concurrent animation, respect reduced motion and stop drawing when idle. Interactive content belongs in regular views or transient interactions.

## Check the result

Verify light and dark appearance, resizing, navigation, reduced motion and withdrawal on disabling. A screenshot cannot prove cleanup, fallback or animation stopping.
