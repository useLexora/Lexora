---
title: "Quick start: install Lexora and run your first task"
description: "Install Lexora on Windows, macOS, or Linux, connect a model, and complete your first task. Follow a walk-planning exercise, save the result, and keep refining it."
---

# Your first task

This chapter walks through a small weekend walking route: connect a model, send your first message, and save the result as a file. Start with a little text before moving on to your own projects.

## 1. Install Lexora

Visit [GitHub Releases](https://github.com/useLexora/Lexora/releases/latest) and choose the package for your system:

| System | Package |
| --- | --- |
| Windows x64 / ARM64 | .exe for your architecture |
| Ubuntu / Debian x64 / ARM64 | .deb for your architecture |
| Fedora 43 x64 / ARM64 | .rpm for your architecture |
| Arch Linux x64 / Arch Linux ARM aarch64 | .pkg.tar.zst |
| macOS 15+, Apple Silicon (ARM64) | .dmg |

Choose `x64` (`amd64` for .deb, `x86_64` for .rpm) for Intel / AMD computers, or `arm64` (`aarch64` for .rpm and Arch packages) for ARM computers. The native Linux pet is optional company, not a requirement for completing tasks.

Install RPMs with `sudo dnf install ./Lexora-Buddy-<version>-linux-<architecture>.rpm`. Verify a downloaded package using its Release `.sha256` file with `sha256sum -c <package-filename>.sha256`.

### First macOS installation

Open the DMG and drag `lexora-buddy.app` into Applications. The app uses an ad-hoc signature and is not notarized by Apple. After confirming you downloaded it from the official Release above, run this in Terminal:

```bash
xattr -r -d com.apple.quarantine "/Applications/lexora-buddy.app"
```

Then open Lexora from Applications. This command removes the quarantine attribute only from this app. Repeat it after an update if macOS blocks the app again.

## 2. Connect a model

1. Open **Settings → Model services** and choose **Add service**.
2. Select your provider under **Built-in**. For a compatible endpoint or your own server, use **Custom API**.
3. Configure an API key, or complete OAuth authorization if the service offers it.
4. Enable at least one model in the model configuration step, then choose **Finish and enable**.

Back in Tasks, the model selector beside the composer should offer your enabled model. Saving credentials without enabling a model is not enough to start a conversation.

<GuideImage src="/guide/images/model-service-en.webp" alt="The Add service dialog with built-in providers and a Custom API tab" caption="Choose a service, then configure its connection and models." :width="1024" :height="616" />

::: tip Already paying for a chat subscription?
Chat subscriptions and API credits may be billed separately. Use the access method your provider supports. Lexora does not include free model credits. See [Connect a model](./settings-and-models).
:::

## 3. Organize a little text

Open **Tasks**, create a task, select an available model, and send the following. You can copy it or substitute your own notes.

```text
Turn these notes into a relaxed weekend walking route:
- Breakfast at a bakery. I want to photograph the bell by its door.
- A slow walk by the river afterwards.
- A quiet bookshop to rest in during the afternoon.

Organize it by morning, midday, and afternoon.
List what I need to confirm before leaving.
Do not invent shop names, addresses, or opening hours.
```

This request needs neither browsing nor an existing file. Expect a route organized by time of day, plus details to confirm about places, transport, and opening hours. The wording will vary; check whether your requirements survived.

If the composer says “No models found,” check that both the service and a model are enabled. For authentication or quota errors, see [Troubleshooting](./troubleshooting).

## 4. Save the result

Continue in the same task:

```text
Save this route as weekend-route.md in the current working directory.
Keep the “To confirm” section and tell me where the file is saved.
```

This step writes a file. If the task uses local read-only permissions, switch to a mode that allows changes. Choose manual approval if you want to review operations individually. When an approval appears, check its path and action before allowing it.

Open the resulting file from the output entry or working directory. Check its name, location, route, and outstanding questions.

## 5. Keep improving the same result

Continue with: “Keep just one afternoon stop, leave time to rest, and update the file.” You can also open the file, select a passage, and quote it into the composer with your revision request.

The conversation remains when you close and reopen the task. Later, put the route in a travel space and create separate tasks for packing or a journal.

Continue with [Tasks and conversations](./ai-chat) for quotes, queues, and branches, or [Files and spaces](./files-and-spaces) to work with your own materials.
