# AGENTS.md / CLAUDE.md & README.md Quality Criteria

## Scoring Rubric

### 1. Commands / Workflows / Routing (20 points)

**20 points**: All essential commands, workflows, or document reading routes documented with context
- Build/test/lint commands (for code) or task workflows & file routing rules (for general projects) present
- Working workflow clear
- Common operations documented

**15 points**: Most commands/workflows present, some missing context

**10 points**: Basic commands or file list only, no workflow

**5 points**: Few commands/workflows, many missing

**0 points**: No commands, workflows, or routing documented

### 2. Architecture / Structure Clarity (20 points)

**20 points**: Clear workspace map
- Key directories and files explained
- Module or document relationships documented
- Entry points and core index identified
- Information flow described where relevant

**15 points**: Good structure overview, minor gaps

**10 points**: Basic directory listing only

**5 points**: Vague or incomplete

**0 points**: No architecture info

### 3. Non-Obvious Patterns (15 points)

**15 points**: Gotchas and quirks captured
- Known issues documented
- Workarounds explained
- Edge cases noted
- "Why we do it this way" for unusual patterns

**10 points**: Some patterns documented

**5 points**: Minimal pattern documentation

**0 points**: No patterns or gotchas

### 4. Conciseness (15 points)

**15 points**: Dense, valuable content
- No filler or obvious info
- Each line adds value
- No redundancy with code comments

**10 points**: Mostly concise, some padding

**5 points**: Verbose in places

**0 points**: Mostly filler or restates obvious code

### 5. Currency (15 points)

**15 points**: Reflects current workspace
- Commands and routes work as documented
- File references and status items accurate
- Project state current

**10 points**: Mostly current, minor staleness

**5 points**: Several outdated references

**0 points**: Severely outdated

### 6. Actionability (15 points)

**15 points**: Instructions are executable
- Commands can be copy-pasted
- Steps are concrete
- Paths are real

**10 points**: Mostly actionable

**5 points**: Some vague instructions

**0 points**: Vague or theoretical

## Assessment Process

1. Read the `AGENTS.md` / `CLAUDE.md` and `README.md` files completely
2. Cross-reference with actual workspace files:
   - Verify documented commands or workflows
   - Check if referenced files exist
   - Verify directory and index descriptions
3. Score each criterion
4. Calculate total and assign grade
5. List specific issues found
6. Propose concrete improvements

## Red Flags

- Commands or links that would fail (wrong paths, missing files)
- References to deleted files/folders
- Outdated status or versions
- Copy-paste from templates without customization
- Generic advice not specific to the project
- "TODO" items never completed
- Duplicate long text across `AGENTS.md`, `CLAUDE.md`, and `README.md`
