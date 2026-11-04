# dashboard

## Overview
Workspace home dashboard.

## Interface
- `Dashboard({ slug })` (`Dashboard.tsx`).

## Invariants
- Query key `['dashboard', slug]` (also invalidated by `mentions`).

## Side Effects
- `api.get` dashboard payload, `api.post` issue creation (`/w/{slug}/issues`) that invalidates the dashboard query.

## Verification
- Run: `cd web && npm run test`
