# Authoring guidance

## Metadata and triggers

A minimal entry point:

```markdown
---
name: meeting-summary
description: Turn meeting notes into decisions, open questions, and action items with owners. Use when the user asks to summarize a meeting, prepare minutes, or extract follow-up tasks. Excludes general article summaries.
---

# Prepare meeting minutes

Read the supplied notes and distinguish decisions, proposals, and open questions. Follow the user's requested output format and language. Otherwise, use a meeting summary, decisions, and action items in the user's language.

For each action item, include the work, owner, and deadline. Keep follow-up work visible even when its owner or deadline is missing. Use the user's exact missing-value marker when specified; otherwise label each missing field as unconfirmed in the output language. Do not infer ownership or promised dates. Preserve disagreements that affect decisions and list outstanding questions at the end.

Before replying, check that every action item includes those fields, every unknown field uses the required marker, and proposals remain distinct from decisions. Correct the result before delivering it.
```

- Use at most 64 lowercase ASCII letters, digits, and single hyphens for `name`, matching the directory name. Choose a name that expresses the responsibility. Preserve existing names and do not add version numbers to them.
- Keep `description` within 1024 characters. Explain what the skill handles and when to use it, including easily confused neighboring tasks where useful. Use natural task language instead of broad claims such as "use for everything" or keyword stuffing. Trigger guidance in the body does not replace the description.
- Quote YAML strings containing special syntax, such as colons, or use block scalars. Ensure they parse as strings.
- Use `license`, `compatibility`, and a string-to-string `metadata` map when needed. State required tools, environments, or file formats without adding nonexistent dependencies.
- Lexora supports `disable-model-invocation: true` for manual invocation only. Set it only when the user wants that behavior. Declarations such as `allowed-tools` do not grant permissions or bypass host authorization.

## Instructions and resources

Write for an agent without access to the current conversation. Include steps that affect decisions, decision criteria, output requirements, failure handling, and necessary stopping conditions. Avoid repeating general knowledge the model already has.

Separate reusable methods from example data. Do not embed customer information, tokens, personal file contents, host-specific paths, one-off deadlines, or conversation secrets in a distributable skill. Explain required inputs and use fictional or redacted examples.

Match the amount of prescription to the task. Fixed format conversions benefit from precise commands and checks; research, writing, and design need room for judgment with clear quality goals. Explain why essential constraints matter instead of adding a checklist every task must follow.

## Output requirements

Turn the user's acceptance criteria into observable rules in the generated `SKILL.md`. State required fields, exact literals, ordering, and missing-information behavior when the task depends on them. Keep these essential rules in the entry point, even when a detailed template lives in a reference. Broad instructions such as "be accurate" do not replace a required format.

When the user specifies a missing-value marker, preserve it verbatim and define where it belongs. Apply it to each required unknown field, including fields described outside a table. Do not omit an otherwise relevant item, move it to free-form prose, or substitute a synonym to avoid filling a required field. Distinguish an unknown value from an item the input does not support; do not invent items to fill a template.

Include a compact input/output example when it resolves a real ambiguity. Cover the relevant missing or partial information, and ensure the example obeys the same rules as the prose. Use fictional data and keep the example out of the default answer.

For tasks with strict output requirements, instruct the consuming agent to check the completed result against those requirements and correct mismatches before delivery. Keep this check internal unless the user requests validation evidence; an appended claim of compliance is not a substitute for a conforming result.

## Resource packaging

| Resource | When to add it | How to organize it |
| --- | --- | --- |
| `references/` | Protocols, domain material, or conditional workflows that would crowd the entry point | State when to read each file, use package-relative links, and avoid chains of nested references |
| `scripts/` | Repeated operations that benefit from deterministic code | Specify parameters, inputs, outputs, dependencies, errors, and side effects; verify by running them |
| `assets/` | Templates, fonts, or images reused in the final output | Include usable resources and state relevant usage restrictions |

Do not force scripts into text-only workflows. Scripts should not install software, transmit data, or modify user files by default. Describe necessary side effects and follow the task's authorization. Package only delivery resources; remove dependency caches, generated output, secrets, and temporary material. Installation rejects symlinks and resources outside the package. Copy external resources only when redistribution is permitted, or explain how to obtain them.

## Sources and maintenance

Verify software APIs, product behavior, and changing facts against current official documentation or actual source code. Put necessary source links and version conditions in the relevant reference. Describe a lookup step for information that needs refreshing rather than turning one observed result into a permanent fact. State uncertainty when reliable evidence is unavailable.

Learn from other skills and organize the material around the current task. Check licensing and attribution requirements before directly copying code, assets, or substantial text. Do not assume one host's CLI, tool names, approval conventions, or directory structure are universal standards.
