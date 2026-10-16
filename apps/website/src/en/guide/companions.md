---
title: "Companions and multi-agent collaboration"
description: "Choose models, instructions, and capabilities for Lexora companions. Add them to a task, hand off work, and understand the lead, shared participants, and NPC subtasks."
---

# Companions and collaboration

One companion can handle plenty of work. When you need another perspective, bring several into the same task: Lexora organizes the goal, 大肥鱼 researches, 小克 refines the writing, and 小白 checks the result. Names and responsibilities are yours to configure.

## Lead, supporting companions, and NPCs

| Role | How it participates | Where results appear |
| --- | --- | --- |
| Current lead | Receives ordinary input, advances the task, and delegates when useful | In the task conversation |
| Supporting companion | Joins the task and responds to mentions or delegation | Under its own identity in the conversation |
| NPC | Handles a separate subtask for a companion that has recruited it | Returns to its caller; inspect the process in execution details |

The lead-type group in companion management stores roles that can join tasks. Within a task, one is the current lead and the others support it. NPCs are managed separately and do not join the ordinary member list.

## Create a companion

1. Open **Companions** and add a role in the appropriate group.
2. Choose its type, name, description, and a preset or uploaded avatar.
3. Write instructions explaining its responsibilities and deliverables.
4. Choose its default model, direct tools, and Skills.
5. Save it, then add it to tasks where it should participate.

<GuideImage src="/landing/screenshots/companions-en.webp" alt="Lexora companion settings and the NPC team" caption="Configure identity, instructions, models, and capabilities separately. An avatar does not select a model service." :width="1424" :height="968" />

The description helps identify a role; its instructions define the working method. For a researcher:

```text
Find material directly relevant to the current question.
Prefer original sources. Separate confirmed facts, inferences, and gaps.
Return a brief conclusion, sources, and questions still to verify.
Do not edit another companion's draft.
```

## Add companions to a task

Use the task's companion panel to add members. Ordinary input goes to the current lead. Select and mention a companion in the composer to direct a request to it.

After changing the lead, the next ordinary input goes to the new lead. Work already running retains its original executor.

<GuideImage src="/landing/screenshots/collaboration-zh.webp" alt="Chinese task interface showing separate work by Lexora, 大肥鱼, and 小白" caption="The collaboration tree shows who is doing what. This task screenshot uses the Chinese interface." :width="2539" :height="1764" />

Start with two roles: one writes a draft, another reviews it. Be explicit about responsibilities, especially when working on the same file: who edits, and who only makes suggestions?

## Recruit NPCs

Recruit roles in a companion's NPC team settings. Built-in roles include Explorer, Researcher, Executor, and Reviewer. You can create your own NPCs with their own instructions, models, and capabilities.

Give NPCs bounded subtasks such as “Check only the sources for these three places and report questionable entries.” The lead uses the returned result to continue the overall task.

## When collaboration does not work as expected

- **Cannot mention a companion:** add it to the current task, not just the management page.
- **Cannot delegate to an NPC:** check that it is enabled and recruited by the caller.
- **Tools or Skills unavailable:** check installation or connection status and the companion's capability selection.
- **Changing the default did not change an old task:** the default affects new tasks; switch an existing task's lead separately.

Each companion's requests can consume model credits. Validate small, clear divisions of work before scaling up. See [Connect a model](./settings-and-models) and [Execution permissions](./permissions).
