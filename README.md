# Pendleton OS

Pendleton OS is a specification-driven executive operating system. This repository implements
the Foundation Roadmap and ADR-005 as a contract-first TypeScript modular monolith.

## Current milestone

Milestone 1 proves the canonical kernel path:

`Command -> Policy -> Workflow -> Google Drive Adapter -> Verification -> Event Log`

KRN-002 establishes this repository and its delivery controls. KRN-003 publishes the initial
machine-readable core schemas in `packages/contracts/schemas`.

KRN-004 implements framework-independent command intake in `packages/application`. It validates
and normalizes submissions, assigns command and correlation identifiers, resolves command support,
classifies ambiguous targets, and reserves idempotency keys behind a replaceable persistence port.

## Prerequisites

- Node.js 24 LTS
- TypeScript 6.0.2 compatibility release
- pnpm 11.16.0 through Corepack
- Docker-compatible container runtime for PostgreSQL integration work

## Local verification

```text
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

No provider mutation is permitted until identity, project context, policy, idempotency,
workflow state, verification, and event persistence are operational.
