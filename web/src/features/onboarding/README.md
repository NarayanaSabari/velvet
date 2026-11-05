# onboarding

## Overview
First-run flow, repository setup, and agent/CLI connection instructions.

## Interface
- `Onboarding({ navigate })` (`Onboarding.tsx`).
- `RepoSetup({ workspace, baseUrl })`, `NewProject({ slug, onCancel, onCreated })` (`RepoSetup.tsx`).
- `RepoFileTabs`, `LinkedRepositories`, `CopyField` (`AgentSetup.tsx`).
- `ConnectAgentCard({ slug })` (`ConnectAgentCard.tsx`).
- `onboardingQuery`, `OnboardingPayload` (`onboardingQuery.ts`).
- `RepoFileId`, `RepoFile`, `projectKeyFrom`, `installCommand`, `loginCommand`, `initCommand`, `repoInstructions`, `repoFiles` (`repoFiles.ts`).

## Invariants
- `RepoFileId` is `'agents' | 'claude' | 'cursor'`.
- Query keys `['onboarding']`, `['my-invites']`, `['projects', slug, ...]`.

## Side Effects
- `api.get/post` for onboarding, invites, and project creation. Invalidates `['session']` and `['projects', slug]`.
- `ConnectAgentCard` persists dismissal in `window.localStorage`.
- `Onboarding` navigates after workspace setup.
- `LinkedRepositories` reads account API tokens and polls every three seconds until a project-bound key for this workspace has `last_used_at`; it then stops polling and invalidates onboarding state (`AgentSetup.tsx`).
- `CopyField` writes its value to the clipboard on request. Copy failure shows a manual-selection/copy message (`AgentSetup.tsx`).

## Verification
- Run: `cd web && pnpm exec vitest run src/features/onboarding`
