# velvet plugin

Agent plugin (`plugin.json` version 1.0.0) that teaches coding agents to keep a Velvet work log with the `velvet` CLI.

## Interface

- `plugin.json` and `.claude-plugin/plugin.json`: manifests. The OpenAI extension sets `onboardingSkill` to `./skills/setup/SKILL.md`.
- Skills:
  - [setup](./skills/setup/SKILL.md): link a repository to one Velvet project.
  - [log-work](./skills/log-work/SKILL.md): `velvet log` after meaningful work.
  - [tickets](./skills/tickets/SKILL.md): find, create, edit, assign, comment, list evidence.
  - [sprints](./skills/sprints/SKILL.md): sprints and milestones.
  - [recap](./skills/recap/SKILL.md): `velvet recap --days N`, reports, mentions.
  - [attach-image](./skills/attach-image/SKILL.md): `velvet upload-image` to one ticket or milestone.
  - [management](./skills/management/SKILL.md): account-wide admin via `velvet admin login`.

## Invariants

- Each repository key reaches only its linked project from `velvet.yaml`.
- Management requires separate consent and never reuses setup, project, or `VELVET_TOKEN` credentials.
- Skills must name only real CLI commands, and every CLI command must appear in some skill. Enforced by `TestPluginSkillsNameOnlyRealCommands` in `cli/cmd/velvet/main_test.go`.

## Verification

```bash
cd cli && go test ./cmd/velvet -run TestPluginSkillsNameOnlyRealCommands
```

## Side effects

- None. Documentation and manifests only.
