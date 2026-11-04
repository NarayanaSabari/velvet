# ui

## Overview
Shared presentational primitives. Reuse these instead of creating parallel conventions.

## Interface
- `Button`, `ButtonProps` (`Button.tsx`), `buttonClassName`, `ButtonVariant` (`buttonStyles.ts`).
- `List`, `ListProps` (`List.tsx`), `EmptyState` (`EmptyState.tsx`), `PageHeader`, `SectionHeader` (`PageHeader.tsx`).
- `LoadingState`, `ErrorState`, `NotFoundState` (`QueryState.tsx`).
- `StatusBadge`, `STATUS_LABELS` (`StatusBadge.tsx`), `Avatar`, `Icon`, `IconName`, `RelativeTime`, `Wordmark`.
- `Markdown` (`Markdown.tsx`), `MermaidDiagram` (`MermaidDiagram.tsx`), `renderDiagram`, `diagramDocument` (`mermaid.ts`).

## Invariants
- `ButtonVariant` is `primary | secondary | danger | ghost`.
- Visual tokens come from `../index.css` and `design.md`.
- `Markdown` sanitizes parsed HTML with DOMPurify and removes user-supplied `data-mermaid-index` placeholder attributes before creating renderer-owned placeholders (`Markdown.tsx`).
- `renderDiagram` rejects sources over 20,000 characters, configuration blocks, and external-image syntax. Mermaid uses strict security and a 500-edge cap; returned SVG is sanitized. `diagramDocument` emits a network-blocking CSP (`default-src 'none'`), and `MermaidDiagram` uses empty-sandbox iframes (`mermaid.ts`, `MermaidDiagram.tsx`).
- `List` selects with `j`/ArrowDown and `k`/ArrowUp, activates with Enter, and exposes selection through `aria-activedescendant` and option `aria-selected` (`List.tsx`).

## Side Effects
- Mermaid renders SVG client-side, subscribes to system color-scheme changes with cleanup, and writes source text to the clipboard on explicit copy actions. Copy failures expose source for manual copying (`MermaidDiagram.tsx`).

## Verification
- Run: `cd web && npx vitest run src/ui`
