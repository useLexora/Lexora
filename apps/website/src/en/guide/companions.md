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

The name and description inform identity and responsibilities; instructions define the working method. None of them expands permissions. For a researcher:

```text
Find material directly relevant to the current question.
Prefer original sources. Separate confirmed facts, inferences, and gaps.
Return a brief conclusion, sources, and questions still to verify.
Do not edit another companion's draft.
```

## Choose a model and reasoning effort

Set a companion's default model, or use the task composer to choose a model for its current recipient. A task selection does not change other companions. Existing tasks also keep their selections when the app's default model changes.

If the model supports it, adjust reasoning effort. Higher effort may take longer and use more tokens without guaranteeing a better answer. Start with the default for simple organization and compare options for harder reasoning. If an option is missing or a saved level is unsupported, choose from the current model's available levels.

Before sending, check that the model selector belongs to the companion you intend to address. Changing a model during work affects later model requests, not completed answers.

## Add companions to a task

Use the task's companion panel to add members. Ordinary input goes to the current lead. Type `@` and choose one joined companion from the suggestions to direct that request without changing the lead. Typing a name as plain text is not a mention. Multiple mentions leave the current lead responsible for receiving and coordinating the request.

After changing the lead, the next ordinary input goes to the new lead. Work already running retains its original executor.

<GuideImage src="/landing/screenshots/collaboration-zh.webp" alt="Chinese task interface showing separate work by Lexora, 大肥鱼, and 小白" caption="The collaboration tree shows who is doing what. This task screenshot uses the Chinese interface." :width="2539" :height="1764" />

Start with two roles: one writes a draft, another reviews it. Be explicit about responsibilities, especially when working on the same file: who edits, and who only makes suggestions?

## Ask the author to revise or continue

To ask the original author for changes, mention that companion alone and quote the answer or name the output and scope: “@Writer Continue revising your opening, keep the bell detail, and update the same draft.” During active work, messages follow the [steer-or-queue setting](./ai-chat#add-instructions-during-a-run).

Without a mention, the current lead coordinates the revision; it does not automatically go to the last speaker. Identify the earlier work and output rather than only saying “continue.” An accepted handoff is not a completed revision: open and check the final file.

## Recruit NPCs

Recruit roles in a companion's NPC team settings. Built-in roles include Explorer, Researcher, Executor, and Reviewer. You can create your own NPCs with their own instructions, models, and capabilities.

Give NPCs bounded subtasks such as “Check only the sources for these three places and report questionable entries.” The lead uses the returned result to continue the overall task.

- NPCs are not ordinary `@` members. A companion that recruited them delegates work; NPCs cannot delegate another level of subtasks.
- New work uses separate context, not an automatic copy of the whole conversation. Specify materials, deliverables, and checks; identify the original work when continuing it.
- NPCs can ask you questions. You can inspect their execution details, but their private process does not automatically become conversation text.
- The team switch, enabled state, and capability selection affect availability. Turning the team off does not cancel work already accepted.
- Companions may work in the same directory. Separate context is not file isolation; assign an editor and reviewers explicitly.

## When collaboration does not work as expected

- **Cannot mention a companion:** add it to the current task, not just the management page.
- **Cannot delegate to an NPC:** check the team switch, the NPC's enabled state, and whether the caller recruited it.
- **Tools or Skills unavailable:** check installation or connection status and the companion's capability selection.
- **Changing the default did not change an old task:** the default affects new tasks; switch an existing task's lead separately.

Each companion's requests can consume model credits. Validate small, clear divisions of work before scaling up. See [Connect a model](./settings-and-models) and [Execution permissions](./permissions).
