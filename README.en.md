<p align="center">
  <img src="apps/website/src/public/favicon.png" width="112" height="112" alt="Lexora" />
</p>

<h1 align="center">Lexora</h1>

<p align="center"><strong>Think alongside you. Act on your intent.</strong></p>

Lexora is a personal AI agent that evolves through hands-on work on your desktop. Beyond coding, it helps you organize research, refine creative projects, and plan everyday activities. Tell it what you want to accomplish, and it keeps working toward that goal, making words the starting point for work, creativity, and everyday life.

<p align="center">
  <a href="https://github.com/useLexora/Lexora/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/useLexora/Lexora?style=flat&amp;label=release&amp;color=blue" /></a>
  <a href="./LICENSE"><img alt="License: AGPL-3.0-only" src="https://img.shields.io/badge/license-AGPL--3.0--only-green?style=flat" /></a>
  <a href="https://github.com/useLexora/Lexora/releases"><img alt="Total downloads" src="https://img.shields.io/github/downloads/useLexora/Lexora/total?style=flat&amp;label=downloads&amp;color=orange" /></a>
  <a href="https://uselexora.app/en/guide/quick-start"><img alt="Desktop: Windows, macOS, Linux" src="https://img.shields.io/badge/desktop-Windows%20%7C%20macOS%20%7C%20Linux-blueviolet?style=flat" /></a>
</p>

<p align="center">
  <a href="https://github.com/useLexora/Lexora/releases/latest">Download Lexora</a> · <a href="https://uselexora.app/en/">Website</a> · <a href="https://uselexora.app/en/guide/quick-start">Guide</a>
</p>

<p align="center"><a href="./README.md">中文</a> · <strong>English</strong></p>

<p align="center">
  <img src="apps/website/src/public/landing/crew-cover-en.webp" width="1200" alt="Lexora delegates to DeepSeek, Claude, and ChatGPT companions, who can delegate subtasks to four NPCs" />
</p>

## Keep working toward your goals

Organize material for work, refine a creative project, or plan a trip. Start with what you want to accomplish. Lexora works through the steps on your desktop while you add direction and review the results.

Conversations and execution records stay with the task. Return later and pick up where you left off. Keep useful methods and tools for the next task, too.

<table>
<tr>
<td width="50%" valign="top">
<h3>Keep materials and tasks together</h3>
<p>Open tasks, files, and previews side by side. Review and refine results while each task keeps its own context.</p>
<a href="apps/website/src/public/landing/screenshots/workspace-en.webp"><img src="apps/website/src/public/landing/screenshots/workspace-en.webp" width="640" alt="Files and split views" /></a>
</td>
<td width="50%" valign="top">
<h3>Point to what needs changing</h3>
<p>Quote part of a conversation, file, or web page with its source attached, then explain what to do next.</p>
<a href="apps/website/src/public/landing/screenshots/references-en.webp"><img src="apps/website/src/public/landing/screenshots/references-en.webp" width="640" alt="Context references" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>Bring in the right companion</h3>
<p>Work with several companions in one task. Let Lexora coordinate or ask a companion to take over.</p>
<a href="apps/website/src/public/landing/screenshots/collaboration-zh.webp"><img src="apps/website/src/public/landing/screenshots/collaboration-zh.webp" width="640" alt="Companion collaboration" /></a>
</td>
<td width="50%" valign="top">
<h3>Build your own crew</h3>
<p>Choose each companion’s model, instructions, and capabilities. Recruit NPCs to help with subtasks.</p>
<a href="apps/website/src/public/landing/screenshots/companions-en.webp"><img src="apps/website/src/public/landing/screenshots/companions-en.webp" width="640" alt="Your companion crew" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>Turn an idea into a plugin</h3>
<p>Describe it, confirm installation, and keep refining it. Shown here: Moonlight Record, made through conversation.</p>
<a href="apps/website/src/public/landing/screenshots/plugin-moonlight.webp"><img src="apps/website/src/public/landing/screenshots/plugin-moonlight.webp" width="640" alt="Create plugins through chat" /></a>
</td>
<td width="50%" valign="top">
<h3>Keep recurring work on schedule</h3>
<p>Set a time and goal for recurring tasks, then review each run and its results.</p>
<a href="apps/website/src/public/landing/screenshots/schedules-en.webp"><img src="apps/website/src/public/landing/screenshots/schedules-en.webp" width="640" alt="Scheduled tasks" /></a>
</td>
</tr>
</table>

### More capabilities

- **Spaces and tasks**: Organize work by project or topic, pin frequent destinations, and search for existing tasks.
- **Talk while work continues**: Add instructions during a run, queue them for later, or send them into the current run.
- **Conversation branches**: Explore different directions from an existing conversation. View and continue each attempt on the branch canvas.
- **Model choice**: Connect your own model services and choose models for different companions and tasks.
- **Skills**: Reuse writing guidelines, research workflows, and project conventions across tasks.
- **MCP**: Bring tools from local or remote services into your work.
- **Changes and execution records**: Inspect tool activity, command output, and recorded file changes.
- **Usage tracking**: View token usage by task and model to understand where your quota goes.
- **Permissions**: Choose read-only, manual approval, smart approval, or full access. Adjust permissions or stop the task during execution.

## Plugins that fit the way you work

Build a file-analysis panel for research, a custom tool for creative work, or a player for your breaks. Something you need once can become a tool you reach for again.

Install from the plugin marketplace, or describe what you need in a conversation. Your companion can generate the source and install package. Confirm installation, try it, and keep refining it. The source stays in your task workspace to maintain and share.

A plugin can combine these capabilities:

- **Interface and appearance**: Pages, split panels, widgets, full themes, and window effects put tools within reach.
- **Interaction and data**: Menus, input commands, authorized local files, settings, and private storage let a tool remember how you use it.
- **Companions and models**: Add agent instructions and custom tools, call configured models, and return summaries, conversions, or analysis to the task.
- **Events and schedules**: React to task progress, schedule commands, and send system notifications to connect repeatable steps.

Plugins use host capabilities within declared permissions. Scheduled commands need Lexora running and the computer awake.

[Explore plugins](https://uselexora.app/en/guide/settings-and-models#plugins-extend-the-workspace) · [Browse plugin source](https://github.com/useLexora/plugins)

## Local first

**Lexora open-sources its own code. Yours stays yours.**

Lexora does not bundle your entire project and upload it to our servers in the background. Here is where data stays and where requests go:

| Data | Storage or destination |
| --- | --- |
| Project files | Read and written in your local directories |
| Tasks, companions, and settings | Stored on your computer, with backup and restore |
| API keys and login credentials | Encrypted locally using your operating system’s encryption facilities |
| Model requests | Sent from your computer to the model endpoint you configure, without a Lexora cloud relay |
| External tool calls | Sent to MCP services you enable or addresses a plugin is allowed to access |
| Remote backups | Configured and enabled by you, using your chosen WebDAV or S3 storage |

When you use a remote model, conversations, quoted material, and code or file contents read by tools and included in context are sent to that model service. External tools also receive the data their calls require. The services you choose determine how that data is handled.

## Get started

1. [Download the app](https://github.com/useLexora/Lexora/releases/latest): available for Windows, Ubuntu / Debian, Fedora, and Arch Linux on x64 / ARM64, and macOS 15+ on Apple Silicon.
2. Connect a model service in settings using its API key or account authorization.
3. Start a task and give Lexora a goal. Choose a working directory when you want to work with files.

No Lexora account is required. Model credits are not included; providers have their own terms and charges.

See the [guide](https://uselexora.app/en/guide/quick-start) for a walkthrough. The first macOS installation requires the `xattr` command shown in the guide. Scheduled tasks need Lexora running and the computer awake.

## Development and contributions

### Local development

Requires Node.js 26+, pnpm 12.5.1+, and Rust. See the [build instructions](packaging/buddy/README.md) for platform dependencies. From the repository root:

```bash
pnpm --filter @uselexora/lexora --filter '@uselexora/lexora-buddy...' --filter @uselexora/lexora-website install --frozen-lockfile
pnpm dev
```

### Contributing

[Open an issue](https://github.com/useLexora/Lexora/issues) if you find a problem. If you have already put an idea into practice, we welcome a PR following the [contribution guide](CONTRIBUTING.md)—share what you have built with everyone.

## License

[AGPL-3.0-only](LICENSE)

## Friendly links

[LINUX DO — A new ideal community](https://linux.do/)
