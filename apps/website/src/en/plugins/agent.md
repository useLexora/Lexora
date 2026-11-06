---
title: "Agent tools and task actions"
description: "Register model-callable tools and task actions with bound task context, models and authorized result channels."
---

# Agent tools and task actions {#agent-capabilities}

A plugin can provide tools selected by the main model or independent actions triggered by task events and user menus. Both receive host-created invocation contexts. To provide a model backend, see [Models and multimodal capabilities](./inference). For reusable methods, remote connections or NPCs, see [Skills, MCP and NPCs](./capabilities).

## Register a tool

Declare `agent: true`, a background entry and `contributes.agent.tools`. Each tool has a stable ID, title, description, parameters and read/write classification. This manifest fragment counts Unicode code points:

```json
{
  "permissions": { "agent": true },
  "contributes": {
    "agent": {
      "tools": [{
        "id": "example.counter.length",
        "title": "Count characters",
        "description": "Return the number of Unicode code points in the supplied text.",
        "access": "read",
        "parameters": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"],
          "additionalProperties": false
        }
      }]
    }
  }
}
```

Register it during activate:

```ts
context.subscriptions.add(
  context.agent.registerTool(`${context.extension.id}.length`, (input) => {
    return { count: Array.from(String(input.text)).length }
  }),
)
```

Parameters support bounded nested objects/arrays and string, number and boolean values. Objects are closed; arbitrary JSON Schema and $ref are unsupported. Tools that change content declare access write and separately obtain the required resource capabilities.

## Use the invocation

A tool's second argument provides scope, task, models, references, artifacts, results and signal, each subject to its contract. Do not retain it for future tasks.

`models.generateText` uses configured models while credentials remain in the host. The default model is captured for the invocation; no implicit conversation history is added. Reading task text requires taskMessages; see [References](./references) for user material.

Write tools can publish private files through artifacts.publish. Use results.addImage for native image results instead of base64 in JSON. Background actions do not have these result channels.

## Task actions

Declare actions and register them with agent.registerAction. Exact triggers include task:created, task:run:before, task:reply:started, task:input:committed, task:turn:completed and user.

User means a task-menu action. Other triggers come from host facts, not ordinary event subscriptions. Execution defaults to background; only actions containing exclusively the before-run trigger may be blocking. A failing blocking action can prevent the main run from starting.

Return `{status:'completed'|'skipped',message?}`. Records and usage belong to the action. Main-chat completion does not cancel an independent action; disabling, configuration changes or stale targets revoke relevant invocations. Types describe each cause payload in the [API reference](./api).

## Packaged Skills

Skill declarations, directories, discovery and lifecycle are covered in [Skills, MCP and NPCs](./capabilities#skills). Skills describe reusable methods, not automatic tool registration; declare and register tools separately as described above.

## Verify behavior

Check actual model invocation, invalid parameters, read/write policy, cancellation and disabling. For actions, check trigger identity, stale-result rejection and protection of manual changes; registration alone is not acceptance.
