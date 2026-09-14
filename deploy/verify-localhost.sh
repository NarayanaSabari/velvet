#!/usr/bin/env bash
# Local alias for the shared onboarding suite, including signed webhooks.
# Polling-only reconciliation is covered by TestReconcileAloneLinksWithoutAnyWebhook.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/verify-setup.sh" "$@"
