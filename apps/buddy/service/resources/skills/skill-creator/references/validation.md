# Validation and iteration

Choose evidence that matches the skill's promises. A simple formatting convention does not need a large evaluation framework. Skills that modify files in bulk, call external services, or generate complex artifacts need more execution evidence.

## Format and resources

Use `lexora_skill_prepare` to check:

- A root `SKILL.md` in a single directory, valid frontmatter, name and description types and lengths, a matching directory name, and a nonempty body.
- Readable package files, symlinks or paths outside the package, and acceptable file counts and total size.
- Same-name skills in the installation scope, whether they can be updated, and conflicts with built-in skills.

These checks do not verify external links, every Markdown reference, tool availability, or task completion. Read the local resources linked from the entry point and verify external APIs and required dependencies. Test commands in the skill using real, authorized inputs.

Review the source against the authoring-language rule in the entry point. Inspect the instruction prose separately from localized triggers, output labels, literal markers, and example data. Check that templates and examples preserve the user's exact output requirements.

## Representative tasks

Choose a small set of distinguishing scenarios from the user's actual needs and define expected behavior before trying them:

| Scenario | What to observe |
| --- | --- |
| Typical task | Whether the instructions produce the required output, including essential fields and formatting |
| Easily confused neighboring request | Whether the description encourages misuse; for example, a meeting-minutes skill should not handle a general article summary |
| Critical missing input or failure | Whether partial input preserves supported items and marks each required unknown field correctly; whether blocking omissions or unavailable dependencies lead to a useful question or an appropriate stop |
| Known failing example | Whether the revision resolves the problem while preserving working behavior |

Keywords or file counts alone are not evidence of task quality. Inspect important outputs and decisions for fabricated information, missing steps, unauthorized actions, unintended input changes, and templates substituted for completed work.

Check exact-output requirements at each relevant field, not by finding the expected string somewhere in the answer. For example, a missing-value marker in a footnote does not satisfy an empty owner field. Verify factual fidelity and format compliance separately: an answer can avoid invention yet still violate a required format.

When an independent task runner is available and authorized, compare outputs with and without the skill in fresh contexts, keeping inputs and success criteria consistent. Record meaningful differences and observable measurements such as actual elapsed time. Without an independent runner, produce and inspect a concrete trial output in the same conversation when practical; describing expected behavior is only a review. Keep trial artifacts outside the installable package. State that a trial in the same conversation does not establish automatic triggering or independent execution quality.

Test automatic triggering with natural requests that do not name the skill in advance. Explicit `$skill-name` invocation tests manual use only; reading the description is a scope review. To improve triggering, use realistic requests that should and should not trigger the skill. Reserve some expressions for verification instead of tuning every example into the description. Include the user's normal language when it differs from the language of the skill instructions.

## Improve from evidence

Identify the source of the problem first. Revise the description for incorrect selection, the body for missing steps or bad decisions, and the relevant reference for outdated information. Add a script only when an operation is both repetitive and error-prone. After each correction, revisit the failing scenario and the most relevant working scenarios, then validate the package again when needed.

Do not invent success rates, speed improvements, or user approval. Do not turn one incidental failure into a mandatory rule for all tasks. Keep test inputs or checking scripts when they offer lasting value; exclude one-off artifacts and temporary evaluation records from the installation directory.
