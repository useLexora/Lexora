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
2. Enter a name and prompt. Choose the space, companion, and model configuration you need.
3. Select a frequency and time.
4. Check the next execution time in the schedule preview, then save.

<GuideImage src="/landing/screenshots/schedules-en.webp" alt="Friday review automation with its prompt, time, and schedule preview" caption="Check the actual upcoming dates and times before saving." :width="1424" :height="968" />

Without a space, each run creates a separate task and uses its local working directory. Attach a prepared space when repeated runs need the same materials.

## Choose a frequency

| Frequency | Useful for |
| --- | --- |
| Calendar | Daily, weekly, monthly, or yearly routines such as a Friday review |
| Interval | Work repeated every few hours or days |
| Once | A single execution at a specified time |

You can also set an active date range. After changing the frequency, recheck the preview so that “every Friday” does not accidentally become “every day.”

## Verify with Run now

After saving, choose **Run now** from the schedule's action menu. This runs the task once without changing the schedule.

Open the resulting task in run history. Check its state and output files. If it waits for approval, resolve that before deciding whether it suits unattended use.

## Keep the app running

Schedules execute on your computer. Lexora can trigger them while it remains in the system tray. It cannot run on time after the app fully exits or the computer shuts down or sleeps. This is not a hosted cloud service, and missed times are not guaranteed to be replayed.

Automations use model credits and depend on networking, model availability, paths, and permissions. Check the run history for important work instead of relying only on an enabled switch.

## Pause, edit, or delete

- **Pause:** stop future triggers while keeping the schedule for later.
- **Edit:** change the prompt, space, model, or time; save and check the preview.
- **Delete a schedule:** stop future triggers without cancelling work already started.
- **Delete a run record:** also delete that run's corresponding task and notification; confirm you no longer need them.

If a space or fixed model becomes unavailable, repair it before resuming. See [Troubleshooting](./troubleshooting).
