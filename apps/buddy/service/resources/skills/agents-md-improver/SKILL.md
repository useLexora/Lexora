---
name: agents-md-improver
description: Audit, revise, and improve AGENTS.md, CLAUDE.md, and README.md files as lightweight project memory indexes. Use when user asks to update, revise, check, audit, or sync AGENTS.md, CLAUDE.md, or README.md, or capture session learnings into project memory. Also responds to $agents-md-improver.
tools: Read, Glob, Grep, Bash, Edit, Write
---

# Project Memory Improver (AGENTS.md / CLAUDE.md & README.md)

Maintain `AGENTS.md` (or `CLAUDE.md`) and `README.md` so the workspace keeps an accurate, lightweight memory index across sessions.

**Index-Layer Rule (Critical):**
- **`README.md`** is the **human index**: brief overview, current status/milestones, and a table/list of links to topic files.
- **`AGENTS.md` / `CLAUDE.md`** is the **agent index**: standing instructions, non-obvious gotchas/red lines, and on-demand routing rules ("when working on X, read Y", including a link to `README.md`).
- **Never dump long content into either file.** Write detailed analyses, notes, or specs into dedicated topic files (`docs/...` or topic `.md` files), then add only a one-line link in `README.md` and `AGENTS.md`.

## Workflow

Choose the flow that matches the request:
- **Session Revision (Default for update commands)**: Capture learnings and changes from the current session directly without a full scoring report.
- **Full Audit (When asked to check/audit/score)**: Evaluate existing files against [references/quality-criteria.md](references/quality-criteria.md) and output a quality report first.

---

### Mode 1: Session Revision (Lightweight Update)

1. **Reflect**: Extract durable changes from this session:
   - Status, progress, or new topic files -> route to `README.md`.
   - New commands, conventions, gotchas, or reading routes -> route to `AGENTS.md` / `CLAUDE.md`.
   - Substantial new content -> save/update in a dedicated topic `.md` file first, not in root index files.
2. **Locate or create files**: Check for root `AGENTS.md` (or `CLAUDE.md`) and `README.md`. If either file is missing, create it with `Write` using the minimal sections in [references/templates.md](references/templates.md) and link `README.md` from `AGENTS.md`.
3. **Update in place**:
   - One line per concept; avoid obvious info, verbose prose, or one-off fixes.
   - Replace obsolete status items or broken links in place instead of only appending.
4. **Show diff & apply**: Show a brief `Why` + `diff` for each file and apply changes (`Write` for missing files, `Edit` for existing files).

---

### Mode 2: Full Audit & Improvement

#### Phase 1: Discovery

Find memory and index files in the workspace:

```bash
find . -maxdepth 3 \( -name "AGENTS.md" -o -name "CLAUDE.md" -o -name ".claude.local.md" -o -name "README.md" \) 2>/dev/null | head -50
```

| File | Purpose |
|------|---------|
| `./README.md` | Human-facing overview, current status, and authoritative index of topic files |
| `./AGENTS.md` / `./CLAUDE.md` | Agent instructions, gotchas, commands, and on-demand routing (checked into git) |
| `./.claude.local.md` | Personal/local settings (gitignored, not shared) |
| `./packages/*/...` | Module-level context in monorepos |

#### Phase 2: Quality Assessment

Evaluate against [references/quality-criteria.md](references/quality-criteria.md):

| Criterion | Weight | Check |
|-----------|--------|-------|
| Commands/workflows/routing | High (20) | Are essential commands and file-reading routes clear? |
| Architecture/index clarity | High (20) | Does the index map where key files and topic docs live? |
| Non-obvious patterns | Medium (15) | Are gotchas, constraints, and quirks documented? |
| Conciseness & separation | Medium (15) | Are root files kept lean as indexes without duplicating long text? |
| Currency | High (15) | Do paths, status items, and commands match current files? |
| Actionability | High (15) | Are instructions concrete and paths real? |

**Quality Scores:** **A** (90-100), **B** (70-89), **C** (50-69), **D** (30-49), **F** (0-29).

#### Phase 3: Quality Report Output

Output the quality report before applying broad audit changes:

```markdown
## Memory Index Quality Report

### Summary
- Files evaluated: X | Average score: X/100 | Files needing update: X

#### 1. ./AGENTS.md & ./README.md
**Score: XX/100 (Grade: X)**
- **Issues:** [Stale status, missing file links, bloated inline sections, or outdated commands]
- **Recommended updates:** [Specific additions, in-place replacements, or sections to extract into topic files]
```

#### Phase 4: Targeted Updates

1. **Keep root files as lean indexes**: Extract overloaded inline sections into topic files and leave a one-line link.
2. **Update in place**: Replace outdated status, commands, or renamed file links rather than appending duplicates.
3. **Show diffs**: Show target file, one-line **Why**, and `diff` block, then apply with `Edit` while preserving existing structure.

## Templates

See [references/templates.md](references/templates.md) for section templates.
