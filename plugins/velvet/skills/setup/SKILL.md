---
name: setup
description: Connect this repository to Velvet with the velvet CLI. Use when the user installs the Velvet plugin, asks to connect or set up Velvet, or when a velvet command fails because velvet is not installed, the repository is not linked, or the key was revoked.
---

# Connect to Velvet

Agents write to Velvet with the `velvet` command.
Each repository is linked to one Velvet project, and its key can reach only that project.

## 1. Check whether it already works

Run `velvet whoami` in the repository.
If it prints an organisation and a project, setup is done: tell the user which ones, and stop.
If it prints only an account, login is complete but this directory still needs `velvet init`.

What a failure means:

- `command not found`: the CLI is not installed. Go to step 2.
- Exit code 78, "run velvet init": this repository is not linked. Go to step 3.
- Exit code 3: the key is missing on this machine or was revoked. Go to step 3.

## 2. Install the CLI

Ask the user to run this in their terminal, with their Velvet address if it is self-hosted:

```bash
curl -fsSL https://velvet.sabarinarayana.com/install.sh | sh
```

For a self-hosted Velvet: `curl -fsSL https://velvet.example.com/install.sh | VELVET_SERVER=https://velvet.example.com sh`.
It installs to `~/.local/bin`, so that folder must be on `PATH`.
An installed CLI updates itself from the same server with `velvet update`; `velvet update --check` only reports.

## 3. Sign in and link the directory

The user signs in once per server and machine:

```bash
velvet login
```

Add `--server https://velvet.example.com` for a self-hosted Velvet.
Login opens the browser. The user signs in if needed, checks the terminal code, and explicitly approves CLI setup access.
The setup credential is stored in the system keychain, with a private-file fallback when a keychain is unavailable.

Then the user runs this from the directory they want to link:

```bash
velvet init
```

Init stays in the terminal. The user selects or creates an organisation and project, then confirms the directory link.
It writes secret-free `velvet.yaml` in that directory and stores a separate project-scoped key on this machine.
Suggest committing `velvet.yaml`. Teammates run `velvet login` once and `velvet init` locally to obtain their own key.

Never ask for a key in chat, never print one, and never write one into a file.
Never edit `velvet.yaml` to point at another project. Relinking requires the person's explicit approval through `velvet init --relink`.
`velvet logout` revokes the machine login and all project keys issued through it, not only the current directory's key.
The shared YAML files remain intact. Do not run logout without the user's request.

## 4. Verify

Run `velvet whoami` again and report the organisation, project, and role.
A viewer can read but not write, so say that logging work will not be possible.

## 5. Tell future agents (optional)

If the repository has no "Velvet work log" section in `AGENTS.md` or `CLAUDE.md`, offer to add the one Velvet generates under Profile > Agent config.
It names no project or key, so it is safe to commit.
