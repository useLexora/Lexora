---
title: "Automations: scheduled tasks and run history"
description: "Schedule Lexora tasks with a companion, model, and space. Test a manual run, inspect the schedule and results, and learn the local runtime requirements and pause controls."
---

# Automations

Use automations for recurring summaries, research updates, or drafts to review. Complete the work manually once before scheduling it, so you can discover missing materials or permissions.

## Run the same task manually first

For a Friday weekly review, confirm where notes live, which model and tools are needed, where the result goes, and whether execution waits for approval.

Instead of only saying “Write my report,” use a more complete request:

```text
Read this week's notes in the current space's work-records folder.
Summarize completed work, unresolved questions, and next week's actions.
Save it in weekly-reports with today's date in the filename.
Keep original notes unchanged. Mark missing owners or dates as
unconfirmed rather than inventing them.
```

## Create a schedule

1. Open **Automations** and choose **Add automation**.
2. Enter a name and prompt. Choose the space, companion, model, and execution permissions.
3. Select a frequency and time using your computer's local time.
4. Check the next execution time in the schedule preview, then save.

<GuideImage src="/landing/screenshots/schedules-en.webp" alt="Friday review automation with its prompt, time, and schedule preview" caption="Check the actual upcoming dates and times before saving." :width="1424" :height="968" />

Every run creates a separate task rather than automatically continuing the previous conversation. Without a space, it uses the new task's own working directory. To reuse materials or accumulate outputs, attach a prepared space and name the input and output paths in the prompt.

## Choose a frequency

| Frequency | Useful for |
| --- | --- |
| Calendar | Daily, weekly, monthly, or yearly routines such as a Friday review |
| Interval | Work repeated every few hours or days |
| Once | A single execution at a specified time |

You can also set an active date range. After changing the frequency, recheck the preview so that “every Friday” does not accidentally become “every day.”

## Verify with Run now

After saving, choose **Run now** from the schedule's action menu. This runs the task once without changing the schedule.

Open the resulting task in run history. Check its files, dates, save location, and state. **Run now** is still background automation and cannot wait for human approval; operations needing approval fail. Prepare the necessary persistent directory or domain access through an ordinary task or space settings, then try again. Do not wait for an automation approval card.

Automations have their own execution permissions and default to controlled execution; they do not inherit temporary full access from an ordinary task. An enabled schedule does not authorize every operation. Do not widen access blindly to remove permission errors. If the previous run of the same schedule has not ended, another occurrence may be skipped; inspect the records.

## Keep the app running

Schedules execute on your computer. Lexora can trigger them while it remains in the system tray. It cannot run on time after the app fully exits or the computer shuts down or sleeps. This is not a hosted cloud service.

On resuming, missed schedules receive only limited catch-up: the current window is 24 hours, with multiple due times inside it combined into the latest occurrence. Schedules beyond that window are skipped or expire, not replayed one by one. Failed tasks and interrupted operations that may already have side effects are not guaranteed to retry automatically. Inspect important runs before choosing to run them manually.

Automations use model credits and depend on networking, model availability, paths, and permissions. Check the run history for important work instead of relying only on an enabled switch.

## Pause, edit, or delete

- **Pause:** stop future triggers while keeping the schedule for later.
- **Edit:** change the prompt, space, model, or time; save and check the preview. Already accepted runs retain their original configuration.
- **Delete a schedule:** stop future triggers without cancelling work already started.
- **Delete a run record:** also delete that run's corresponding task and notification; confirm you no longer need them.

If a space or fixed model becomes unavailable, repair it before resuming. See [Troubleshooting](./troubleshooting).
