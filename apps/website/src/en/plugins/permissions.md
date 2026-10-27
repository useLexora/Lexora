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
| Access the invoking task title or message text | `tasks: "read"` / `"title"`, separate `taskMessages: true` |
| HTTPS GET, downloads and external links | `network: ["https://example.com"]` |
| Window styles, decorations and replacement controls | `windowEffects: true`, `controls: ["model.reasoning"]` |
| Notifications and scheduled commands | `notifications: true`, `schedules: true` |
| Manage user themes or declare shell candidates | `themeManagement: true`, `shells: true` |

Read access does not grant write-back. A tool's `access: "write"` classification does not grant paths or document access. Handles and reference locators are not arbitrary path permissions.

## Runtime boundaries

Use network APIs for approved HTTPS origins. Direct external fetches or scripts cannot bypass approval. Browser login state is not shared, and model credentials stay with the host.

Clipboard access requires its independent permission and a visible, focused interactive view in the foreground window. This is not a per-call user-gesture check. Backgrounds, decorations, slots and controls have no clipboard access. Document editing also belongs to interactive views.

## Three versions

| Field | Meaning |
| --- | --- |
| `version` | Plugin release version |
| `apiVersion` | Protocol major version; currently 1–4 |
| `engines.lexora` | Host range supporting every required capability |

An incremental API within version 4 may require Lexora 0.17.0. API 4 alone does not make an older host compatible. Check the requirements for [document editing](./files#edit-originals-and-recover) and reference capture. Do not lower the range to bypass installation checks.

The application capability catalog describes its running host. An independent SDK catalog describes that SDK snapshot. When an optional API is absent, offer an upgrade or disable the feature instead of reporting success.

## Handle failure explicitly

A cancelled picker, expired view, revoked permission and save conflict are different outcomes. Handle null, false, result states and rejected promises according to each API.

A timeout may leave an outcome unconfirmed. Inspect state or recovery receipts before repeating a write. Diagnostics should include plugin identity, version, method and error code, without credentials or material content.
