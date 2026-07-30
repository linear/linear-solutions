# Skills

Claude Code skills built for working with Linear. Each skill is a self-contained folder with a `SKILL.md` file that Claude Code loads when the skill is invoked.

## Installing a skill

Skills are loaded from `~/.claude/skills/` (user-level) or `.claude/skills/` (project-level). To install a skill from this directory:

```bash
# user-level (available in every project)
cp -r Skills/<skill-name> ~/.claude/skills/

# or project-level (committed to a specific repo)
cp -r Skills/<skill-name> /path/to/your/repo/.claude/skills/
```

Restart Claude Code (or open a new session) so the skill list is re-scanned. Invoke a skill with `/<skill-name>` or by naming it in a request.

## Skills in this directory

| Skill | What it does |
|---|---|
| [stale-labels](./stale-labels/SKILL.md) | Audits a Linear team's labels and produces a tiered cleanup report (unused / low-use & stale / legacy) based on issue count and most-recent application date. Read-only. |
| [triage-plugin](./triage-plugin/README.md) | A Claude Code plugin that polls a Linear triage queue for issues labeled "Claude Code" and implements each end-to-end — worktree, draft PR, tests, and status updates posted back to the issue. Auth is delegated to the `gh` CLI and the Linear MCP; no secrets are stored in the plugin. |

## Contributing a new skill

1. Create a folder named after the skill: `Skills/<your-skill-name>/`
2. Add a `SKILL.md` file with YAML frontmatter:

   ```markdown
   ---
   name: your-skill-name
   description: One-sentence description of what triggers the skill and what it produces.
   ---

   Skill body — step-by-step instructions Claude follows when invoked.
   ```

3. Keep skills focused: one clear job per skill, read-only by default. If a skill takes destructive actions, gate them behind explicit user confirmation.
4. Add a row to the table above and open a PR.
