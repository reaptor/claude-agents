# claude-agents

Reusable GitHub workflows that run [Claude Code](https://claude.com/claude-code)
agents for reaptor's repositories (Kontera and Arnold), built on
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action).
Claude authenticates with a Claude Max subscription token
(`CLAUDE_CODE_OAUTH_TOKEN`, made with `claude setup-token`) and acts on GitHub as the
Claude GitHub App (`claude[bot]`).

| Workflow | Called on | What it does |
|---|---|---|
| [`issue-agent.yml`](.github/workflows/issue-agent.yml) | an issue labeled `claude`; a comment or review with `@claude` | Implements the issue as a PR on `claude/issue-N`, or acts on the comment on the PR's branch. With a `prompt` + `pr` it runs a task for the other workflows. |
| [`conflicts.yml`](.github/workflows/conflicts.yml) | a push to `main` | Every open `claude/` PR that now conflicts with main gets a run that resolves it. |
| [`security-review.yml`](.github/workflows/security-review.yml) | a pull request | Read-only security review; a `security-review` commit status, a comment with findings, and on a `claude/` branch a fix run. |
| [`security-audit.yml`](.github/workflows/security-audit.yml) | by hand | Read-only audit of the whole codebase, filed as one issue; reply `@claude` to act on it. |

The agent's shared instructions are [`prompts/issue-agent.md`](prompts/issue-agent.md);
each repository adds its own (`instructions:`), appended to the system prompt. Both are
always read from the default branch, so a pull request cannot change them.

## Using it from a repository

Each repository has thin workflows that call these with its own runner, setup command and
instructions, for example:

```yaml
on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]
jobs:
  claude:
    permissions: { contents: write, pull-requests: write, issues: write, actions: read, id-token: write }
    uses: reaptor/claude-agents/.github/workflows/issue-agent.yml@main
    with:
      runs-on: '["self-hosted","kontera-mac"]'
      instructions: .github/claude/kontera.md
      setup: scripts/agents/prepare-env.sh
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

One-time setup per repository: install the [Claude GitHub App](https://github.com/apps/claude),
add the `CLAUDE_CODE_OAUTH_TOKEN` secret, and on a public repository require approval for
workflows from outside contributors (Settings → Actions → General).

## Safety

- Only people with write access can start a run (the action checks it); comments by bots,
  Claude's own included, never start one. On public repositories set
  `include-comments-by-actor` so other people's comments never reach the prompt.
- Reviews and audits only read: `--restricted --tools Read,Glob,Grep`, `dontAsk`, no `.git`.
- Fork pull requests are never reviewed or worked on: they get no secrets, and the
  workflows check `isCrossRepository`.
- Self-hosted runners run on someone's own computer: use them only for private repositories.

## Development

```bash
npm ci
npm run typecheck
npm test
actionlint
```
