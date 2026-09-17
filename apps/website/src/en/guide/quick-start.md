# Your first task

Start small and specific. For example: “Turn these meeting notes into an action plan.”

## 1. Install Lexora

Visit [GitHub Releases](https://github.com/useLexora/Lexora/releases/latest) and choose the package for your system:

| System | Package |
| --- | --- |
| Windows x64 / ARM64 | .exe for your architecture |
| Ubuntu / Debian x64 / ARM64 | .deb for your architecture |
| Arch Linux x64 | .pkg.tar.zst |
| macOS 26+, Apple Silicon (ARM64) | .dmg |

Choose `x64` (`amd64` for .deb) for Intel / AMD computers, or `arm64` for ARM computers. The native Linux pet is optional company, not a requirement for completing tasks.

### First macOS installation

Open the DMG and drag `lexora-buddy.app` into Applications. The app uses an ad-hoc signature and is not notarized by Apple. After confirming you downloaded it from the official Release above, run this in Terminal:

```bash
xattr -r -d com.apple.quarantine "/Applications/lexora-buddy.app"
```

Then open Lexora from Applications. This command removes the quarantine attribute only from this app. Repeat it after an update if macOS blocks the app again.

## 2. Connect a model

Open settings, add your model service, and enter its API key or complete account authorization as required. Then choose an available model.

Lexora does not include a free model allowance. Availability and costs depend on your chosen provider.

[About models and tools →](./settings-and-models)

## 3. Start a task

Create a task and describe your goal, source material, and desired output. Choose a working directory or a space if you need to work with local files.

For example:

> Read these meeting notes. Extract confirmed decisions, owners, and open questions. Save a Markdown action plan in the current working directory.

You can also start with a simple conversation that needs no files.

## 4. Follow along and review

Lexora shows its work as it progresses. When asked for permission, check what a tool will access or do before approving.

Open the resulting file or artifact preview and check the facts, format, and location. Then add a follow-up, such as “Sort the actions by priority.”

Back up important files before changing them. AI-generated results need your review.
