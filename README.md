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

KRN-005 resolves authenticated principals, active actors, authorized projects, and project-owned
targets before policy evaluation. Unresolved, disabled, ambiguous, archived, or unauthorized
context returns a typed rejection and cannot enter the execution path.

KRN-006 evaluates the approved Policy Matrix as deterministic, versioned rules. Every material
operation returns allow, deny, confirm, or escalate together with rule identifiers, reason codes,
notification and review requirements, and explicit driving-mode handling.

KRN-007 provides durable workflow state machines behind a repository port. Workflows execute
ordered steps, pause and resume for confirmation, retry within explicit limits, time out stalled
work, fail deterministically, and resume from persisted state after orchestrator replacement.

KRN-008 provides a Google Drive adapter behind a provider client port. It scopes every operation to
the resolved project root, preserves native document identity, requires revision-safe updates, and
returns content, revision, parent, and hash evidence for later verification.

KRN-009 independently reads back artifact state and classifies evidence as verified, mismatch,
unavailable, or partial. Required verification can no longer be collapsed into provider success.

KRN-010 records immutable, correlated events with recursive secret redaction. The event store can
reconstruct activity by correlation, command, or workflow without treating diagnostic logs as audit.

KRN-011 exposes one HTTP command entry point that composes context resolution, intake, policy, and
workflow dispatch in mandatory order. Transport channels cannot directly invoke provider adapters.

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
