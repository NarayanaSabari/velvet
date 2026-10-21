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

## 3. Link the repository

The user runs this from the repository, because it opens their browser:

```bash
velvet init
```

Add `--server https://velvet.example.com` for a self-hosted Velvet.
In the browser they confirm the code shown in the terminal and pick the organisation and project.

`velvet init` writes `velvet.yaml` and stores the key in the system keychain.
Suggest committing `velvet.yaml`: it holds no secret, and teammates run `velvet init` to get their own key.

Never ask for a key in chat, never print one, and never write one into a file.
Never edit `velvet.yaml` to point at another project; the key would be refused there anyway.
To disconnect this repository, the user runs `velvet logout`, which revokes its key and removes it from the machine.

## 4. Verify

Run `velvet whoami` again and report the organisation, project, and role.
A viewer can read but not write, so say that logging work will not be possible.

## 5. Tell future agents (optional)

If the repository has no "Velvet work log" section in `AGENTS.md` or `CLAUDE.md`, offer to add the one Velvet generates under Profile > Agent config.
It names no project or key, so it is safe to commit.
