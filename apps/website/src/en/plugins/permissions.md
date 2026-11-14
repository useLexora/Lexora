---
title: "Permissions and compatibility"
description: "Declare permissions and distinguish plugin, protocol and host versions."
---

# Permissions and compatibility

Declare permissions in `extension.json`; users review them during installation. Request only what the feature needs.

## Choose permissions

| Capability | Declaration |
| --- | --- |
| Read the file supplied by the host | `selectedResource: "read"` |
| Let the user pick other files or directories | `localResources: true` |
| Export to a user-selected destination | `resourceExport: true` |
| Edit originals and maintain recovery drafts | `fileEditing: true` |
| Add references and resolve authorized user references in tools | `references: true` |
| Read or write text and HTML clipboard formats | `clipboardRead: true` / `clipboardWrite: true` |
| Register Agent tools or actions | `agent: true` |
| Request models during an invocation | `models: true` |
| Provide a native inference backend | `inference: true` |
| Inference GPU and service requests | `inferenceGpu: true`, separate `inferenceNetwork: ["https://api.example.com"]` |
| Read bound statistics or context usage | `data: ["task.metrics", "context.usage"]`, selecting only needed sources |
| Access the invoking task title or message text | `tasks: "read"` / `"title"`, separate `taskMessages: true` |
| HTTPS GET, downloads and external links | `network: ["https://example.com"]` |
| Window styles, decorations and replacement controls | `windowEffects: true`, `controls: ["model.reasoning"]` |
| Notifications and scheduled commands | `notifications: true`, `schedules: true` |
| Manage user themes or declare shell candidates | `themeManagement: true`, `shells: true` |

Read access does not grant write-back. A tool's `access: "write"` classification does not grant paths or document access. Handles and reference locators are not arbitrary path permissions.

Declaring Skills, MCP connections or NPCs needs neither `agent` nor additional plugin permissions. It does not automatically execute tools, connect services or recruit NPCs; see [Capabilities](./capabilities). Data-source grants do not expose task text or arbitrary tasks; see [View data](./views#read-only-data-and-bound-scope).

## Runtime boundaries

Use network APIs for approved HTTPS origins. Direct external fetches or scripts cannot bypass approval. Browser login state is not shared, and model credentials stay with the host.

Native inference has [separate permissions and platform boundaries](./inference#permissions-and-platform-boundaries): ordinary downloads use `network`, while inference service requests use `inferenceNetwork`. Windows x64 and experimental macOS ARM64 native processes run under the current account with supervision, not OS file or network isolation. Browser backgrounds, views and Workers retain their restrictions.

Clipboard access requires its independent permission and a visible, focused interactive view in the foreground window. This is not a per-call user-gesture check. Backgrounds, decorations, slots and controls have no clipboard access. Document editing also belongs to interactive views.

## Three versions

| Field | Meaning |
| --- | --- |
| `version` | Plugin release version |
| `apiVersion` | Protocol major version; currently 1–5 |
| `engines.lexora` | Host range supporting every required capability |

An incremental API within version 4 may require Lexora 0.17.0. API 4 alone does not make an older host compatible. Check the requirements for [document editing](./files#edit-originals-and-recover) and reference capture. Do not lower the range to bypass installation checks.

Check target-host support for incremental inference, MCP/NPC and view-data APIs too. New data sources, GPU access or supervised inference platforms require renewed review; an earlier grant does not approve an expanded scope.

The application capability catalog describes its running host. An independent SDK catalog describes that SDK snapshot. When an optional API is absent, offer an upgrade or disable the feature instead of reporting success.

## Handle failure explicitly

A cancelled picker, expired view, revoked permission and save conflict are different outcomes. Handle null, false, result states and rejected promises according to each API.

A timeout may leave an outcome unconfirmed. Inspect state or recovery receipts before repeating a write. Diagnostics should include plugin identity, version, method and error code, without credentials or material content.

## Execution lifetime

`executionScope` defaults to `desktop`: the plugin runs while Desktop is open. API 5 plugins can explicitly select `service` to keep serving an active task after Desktop closes. Installation review shows this change, and every runtime dependency must also declare service execution.

A service package needs an `entry` and cannot request `schedules`. API 5 rejects unknown permissions. Activation registers capabilities, reads configuration and initializes private data; model, task and network operations require a current invocation and its cancellation signal. The backend stops when no task or view uses it. Window, picker and selection operations still require Desktop and return `EXTENSION_DESKTOP_REQUIRED` while it is unavailable. This declaration grants neither Node access nor additional system permissions.
