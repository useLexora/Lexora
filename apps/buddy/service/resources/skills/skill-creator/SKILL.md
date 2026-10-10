---
name: skill-creator
description: Create, update, and improve reusable Agent Skills, including turning workflows from the current conversation into skills, writing SKILL.md and supporting resources, validating existing skills, and previewing installation in Lexora. Also responds to $skill-creator. Excludes ordinary task execution, merely using or installing an existing skill, and Lexora desktop plugin development.
---

# Create a reusable skill

Turn a recurring workflow into real skill files. Complete a version that handles a representative task, then improve it using execution results and user feedback.

Communicate with the user in their language. For a new skill, write the description, instruction prose, and supporting guidance in English unless the user explicitly requests another authoring language. A conversation in Chinese or a request for Chinese deliverables does not change this default. Preserve an existing skill's instruction language unless asked to change it.

Define the skill's output language separately. Keep required output headings, literal values, localized trigger phrases, and example input/output in the appropriate language; do not translate exact strings required by the user. English instructions can produce Chinese deliverables.

## Identify the workflow to reuse

Use the current conversation to establish the trigger, inputs, deliverables, essential steps, required tools, and success criteria. Proceed when enough information is available. Ask only for missing information that would change the scope or delivery; do not require a technical questionnaire.

- Create a new skill: start with a concrete recurring task. If the request is vague, use a representative input and expected output to narrow the scope.
- Capture a conversation: extract methods, corrections, and acceptance criteria the user actually accepted. Remove one-off data, temporary paths, failed attempts, and unconfirmed preferences. Do not turn permission for one task into standing authorization for future tasks.
- Improve an existing skill: read its source, supporting resources, and failing examples first. Locate problems in its trigger description, steps, resources, or runtime requirements. Preserve its name and working behavior; rename it only when the user wants a separate copy.

A skill supplies instructions and resources; it does not add tools, permissions, or product features. Use plugin authoring for workbench interfaces, persistent controls, or plugin commands. State missing external dependencies instead of inventing callable interfaces.

## Write the source

Read [Authoring guidance](references/authoring.md), then create a dedicated directory in the current writable workspace, such as `skills/meeting-summary/`. Put `SKILL.md` at its root and match the directory name to the frontmatter `name`. Inspect existing files before editing and preserve user content.

Start with one clear entry point. Carry the user's acceptance criteria into explicit output requirements using the authoring guidance. Add `references/`, `scripts/`, or `assets/` only when needed. Do not generate empty directories, placeholder scripts, generic READMEs, or a fixed evaluation project. A Markdown-only skill needs no Python, Node, or dependency installation.

Prefer the original source when editing an existing skill. Built-in skills and installed copies are not writable source directories. If the source is unavailable, use files supplied by the user or already authorized for reading and maintain a copy in the workspace. Do not bypass file permissions to access private application directories.

## Validate and try the skill

Read [Validation and iteration](references/validation.md) and choose checks proportional to the risk. Discover `lexora_skill_prepare` through `lexora_tool_search`, then validate the format and resources of one skill directory:

```json
{ "source": "skills/meeting-summary" }
```

Fix issues using the returned `code` and `diagnostics`, then validate again. The tool checks document format, resource packaging, and installation conflicts. It does not run scripts, install dependencies, or prove that the skill can complete a real task. `runtimeTested: false` indicates neither a passed nor a failed behavior test.

Try the workflow on a representative task and inspect the actual output against the acceptance criteria. Run newly added executable scripts on permitted, isolated inputs. External communication, publishing, payments, and data changes remain subject to the current task's authorization. Distinguish static review, a trial in the same conversation, and independent execution; report what actually ran and what remains untested. Do not invent evaluation scores or multi-agent results.

## Preview installation and deliver

Before delivery or an installation preview, review the actual source for the authoring language and output requirements above; fix known mismatches instead of offering to repair them after delivery. When the skill is intended for use in Lexora, request an installation preview for the validated source with the same tool:

```json
{ "source": "skills/meeting-summary", "review": true }
```

The default scope is the current task's Space, or global if the task has no Space. Pass `"scope": "global"` when the user explicitly requests global reuse. Do not treat a skill name, tool name, or platform-specific setting as an installation scope.

The preview shows the name, purpose, scope, and whether an existing installation will be updated. Installation happens only after the user confirms in the preview. `installation: "review_requested"` means a preview was requested; it does not establish that installation completed. Keep the default `review: false` for source-only requests. Do not modify application data, enablement state, or installation directories to bypass this flow.

A preview captures a snapshot at the time of the call. Later edits are not included in an earlier preview. After editing, prepare a new preview and have the user cancel the old one and confirm the new version. A user-installed skill with the same name in the same scope updates the existing installation and preserves its enabled state. Global built-in skills cannot be replaced. If related tasks are running or installation state has changed, follow the error and prepare again; do not rename the skill to bypass update checks.

Present the source directory through `lexora_output_present`. Lexora currently installs from folders or public GitHub sources, so no `.skill` archive is needed. Briefly explain the purpose, a trigger example, source location, completed checks, and remaining validation. Installed skills take effect in subsequent task runs. After user feedback, edit the same source and verify the affected scenario instead of creating unrelated copies.
