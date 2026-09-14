#!/usr/bin/env bash
# Verify email onboarding, invitations and owner-verified GitHub setup against
# the shared disposable stack. Arguments pass through to the browser runner.
# This preserves the stack; it never targets a configured deployment.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../e2e/stack-common.sh"
cd "$root/e2e"
exec env -u NO_COLOR npx --no-install playwright test tests/onboarding.spec.ts "$@"
