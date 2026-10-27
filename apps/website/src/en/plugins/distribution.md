---
title: "Build and distribute"
description: "Use repository tools or the independent SDK to build, debug and distribute packages."
---

# Build and distribute

Source and installation packages are different artifacts. Keep source and verify the final .lexora-extension package on a target host before distributing it.

## Repository CLI

After preparing repository dependencies, run from apps/buddy:

```sh
node extensions/tools.mjs check /path/to/plugin
node extensions/tools.mjs build /path/to/plugin .output/extensions/my-plugin
node extensions/tools.mjs pack .output/extensions/my-plugin .output/extensions/my-plugin.lexora-extension
```

Check validates compatibility and package contents, build creates the artifact, and pack reports size and SHA-256. Place output outside source to avoid packaging generated files recursively.

## Independent SDK

Export-sdk exports authoring tools and a type snapshot. If you already have an independent Lexora Plugin SDK, install its dependencies using its declared package manager and run:

```sh
pnpm check /path/to/plugin-repository my-plugin
pnpm run package /path/to/plugin-repository my-plugin
pnpm run package:source /path/to/plugin-repository my-plugin
pnpm dev /path/to/plugin-repository my-plugin
```

Sources live in repository/plugins/name, packages in the SDK's .output/packages. Packaging incrementally updates catalog/v1/index.json by plugin ID without uploading. The repository license is attached during packaging; retain third-party notices.

Copy sdk/index.d.ts into the plugin as lexora.d.ts. Generate a new identity with authoring.mjs createExtensionId when appropriate, and preserve an existing identity through upgrades.

## Development and debugging

The application can load a development directory. Repository dev needs a prior Electron build and uses a separate temporary profile; rebuild and reload after changes. The independent SDK's dev command follows its own watch workflow.

Inspect active and pending versions, entry loading and diagnostics. Build, permission and runtime failures need different fixes. Successful loading does not prove saving, tool invocation or interaction.

## Package contents

Source packages use the fixed host compiler. Compiled packages preserve already-built browser modules and assets, including Workers, WASM and styles.

Current limits are 64 MiB per file, 128 MiB compressed and 256 MiB expanded; up to 4096 files, 512 non-image files and 8192 archive entries. Do not force model weights or other oversized data into the installation archive; loading external content depends on available resource APIs.

## Before distribution

1. Verify stable identity, author, plugin version, permissions and minimum host version.
2. Build and install the final package, then exercise its actual entries and main functions.
3. Verify cancellation, closing, disabling, updating and restoration of existing data.
4. Preserve source, licenses, package size and SHA-256.
5. For the current marketplace, follow [Lexora Plugins](https://github.com/useLexora/plugins) publication instructions.

Building or updating a local catalog is not publication. The URL, version and checksum must describe the same downloadable artifact. Account and submission workflows depend on the channel actually available.
