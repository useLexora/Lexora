---
title: "Skills, MCP and NPCs"
description: "Declare plugin Skills, remote MCP connections and specialist NPCs independently, then compose them through explicit dependencies."
---

# Skills, MCP and NPCs

These contributions solve different problems and may ship independently. All use API 4; purely declarative packages need no background `entry`, `contributes.agent` or additional plugin permissions. Actual use remains subject to host configuration and authorization. Set `engines.lexora` to verified supporting versions: API 4 alone does not establish compatibility.

| Goal | Declaration | What does not happen automatically |
| --- | --- | --- |
| Reusable methods and supporting resources | `contributes.skills` | No tool registration, script execution or permission grants |
| Remote tool service definitions | `contributes.mcpConnectors` | No automatic connection, bundled user credentials or remote-call authorization |
| Delegatable specialist NPCs | `contributes.subagents` | No lead-actor role, automatic recruitment/binding or inheritance of all tools |

For model-callable plugin tools and task-event actions, see [Tools and task actions](./agent). For model backends, see [Models and multimodal capabilities](./inference). Merge the fragments below into your own manifest; they are not complete packages.

## Skills {#skills}

A Skill ID uses the full plugin contribution ID, and `path` points to a standard `SKILL.md` in its own directory:

```json
{
  "contributes": {
    "skills": [{
      "id": "example.research.research",
      "path": "skills/research/SKILL.md"
    }]
  }
}
```

This example assumes plugin ID `example.research`. The directory may include `references/`, `scripts/` and `assets/`. Builds preserve their bytes and relative paths without executing scripts as background entries. Skill directories must not contain one another or background/view entries. A package may declare up to 32 Skills.

```md
---
name: research
description: Check user-specified material and report conclusions with traceable sources.
---

Establish the question and material scope before gathering evidence with available tools.
Distinguish source facts from inference and identify anything that could not be verified.
```

Frontmatter `name` matches its directory, uses lowercase letters, numbers and single hyphens, is at most 64 characters and is unique in the package. Required `description` is at most 1024 characters. Do not put the namespace into name. Use `disable-model-invocation: true` to require manual selection.

Once installed and enabled, Skills appear in the existing search experience. The last segment of the plugin ID supplies the namespace, for example `$research:research`. Users can select explicitly and models can read based on descriptions; installation does not inject every Skill body into conversations. A Skill neither registers tools nor starts MCP or executes bundled scripts. Scripts still require available tools and user authorization.

The plugin owns Skill enablement, updates and uninstall; no independent user installation is created. Updates invalidate old selections, which must be selected again. Disabled sources cannot be discovered as usable capabilities. Text already in a conversation and independently granted file access are not withdrawn retroactively.

## MCP {#mcp}

An MCP connector is an independent service declaration. Its ID is local to the package, without the plugin ID prefix:

```json
{
  "contributes": {
    "mcpConnectors": [{
      "id": "search",
      "name": "Material search",
      "transport": "streamable-http",
      "url": "https://search.example.com/mcp",
      "authentication": "bearer"
    }]
  }
}
```

Replace the example with a real service. Up to 16 connections are allowed. IDs contain 1–64 lowercase letters, numbers, `-` or `_`, begin with a letter or number, and are unique within that contribution kind. Only HTTPS Streamable HTTP is supported, without URL userinfo; `stdio` local-command startup is not supported.

Explicitly declare `authentication` as `none`, `bearer` or `oauth`. This states an authentication requirement; verify OAuth login support on the target host. Do not declare arbitrary headers, credential fields or secrets, or put tokens in URLs, packages or logs. Users configure credentials, enablement and tool discovery in the host. Installation does not connect automatically.

Connection definitions follow plugin updates, while the host manages user authentication and switches. Changed targets or authentication requirements must not reuse old credentials for a new target. Tool execution and side effects remain subject to policy and authorization; a tool name or prompt cannot make a write operation read-only.

## NPC {#npc}

The UI calls them NPCs, while the manifest key remains `subagents`. Plugins cannot currently register lead actors, and the declaration contains neither `kind` nor companion bindings:

```json
{
  "contributes": {
    "subagents": [{
      "id": "reader",
      "name": "Material reader",
      "instructions": "Read user-specified material and return a summary with source evidence.",
      "tools": [{ "source": "builtin", "name": "read" }],
      "fileAccess": "read_only"
    }]
  }
}
```

A package may declare up to 16 NPCs. IDs use the same local format as MCP, but belong to a separate contribution kind and cannot reuse built-in NPC IDs. `name`, `instructions` and `fileAccess` are required. `skills`, `requiredSkills` and `tools` default to empty arrays, not all capabilities.

Built-in tool references allow only `read`, `find`, `grep` and `ls`, not arbitrary management tools, command execution or plugin-tool references. `fileAccess: "inherit"` inherits the current task's permission ceiling without granting directories; `read_only` restricts file access to reads. An NPC cannot relax task or ancestor read-only limits.

Installation only registers the NPC. Users recruit it into a companion and configure enablement and model selection; an unspecified model inherits the caller's actual model. Source definitions follow plugin updates and are not directly editable. Users may create independent NPC copies, but copies do not duplicate MCP credentials or Skill entities, or automatically remove dependencies.

## Compose explicit dependencies

Only references create dependencies. Sharing a package, name or installation order does not automatically bind contributions. Replace the NPC's capability fields with:

```json
{
  "skills": ["example.research.research"],
  "requiredSkills": ["example.research.research"],
  "tools": [{ "source": "mcp", "connector": "search", "name": "search_documents" }],
  "fileAccess": "inherit"
}
```

- `skills` uses this package's full Skill contribution IDs, not frontmatter or invocation names. `requiredSkills` must be a subset of `skills`; an unavailable required Skill prevents readiness.
- MCP `connector` uses this package's local connector ID. `name` is the service's actual original tool name, not a host-generated invocation name. The example service must really provide `search_documents`.
- References cannot target other plugins or user connections. MCP tools require `inherit` and cannot combine with `read_only`, because a declaration cannot guarantee remote side effects.
- An empty tool list is not “all tools”; adding a Skill does not grant tools mentioned in its text. Unavailable dependencies make dependents unavailable rather than expanding access to other connections.

## Lifecycle and verification

Disabling, uninstalling or removing declarations makes those sources unavailable and affects NPCs explicitly depending on them. Ordinary uninstall retains user configuration without converting managed connections or NPCs into user-owned records. Reinstalling MCP contributions does not automatically re-enable them. Configuration and credential cleanup requires an explicit user choice; do not automatically delete independent copies, user Skills or task history.

Verify what you actually ship: Skills can be searched, selected and read with relative resources; users can authenticate, enable/disable, discover and call real MCP tools; NPCs can be recruited, assigned models and delegated to while respecting file permissions and dependencies. Then check old selections after updates, missing dependencies, disabling, uninstall and reinstall. Manifest parsing does not establish a working connection or a ready NPC.

See [API reference](./api) for complete fields and [Build and distribute](./distribution) for packaging requirements.
