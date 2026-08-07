# Pendleton Conversation Runtime v1

Status: Implemented locally; production migration and deployment pending

Version: 1.0.0

Date: 2026-08-07

## Purpose

The Conversation Runtime makes voice, mobile, and web interactions durable conversations rather than isolated commands. It implements the session and transcript foundation required by ADR-003, Voice as a First-Class Interface, and ADR-004, Unified Command and Workflow Layer. Business actions proposed during a conversation must still pass through the unified command gateway, policy evaluation, confirmation, verification, and audit controls defined by the System Design and Voice Operating Contract v1.

## Runtime contract

A session binds one authenticated principal to one project, interface channel, and driving-mode setting. The server controls principal and project identity; clients cannot substitute either value. Each turn records a role, semantic kind, transcript text, idempotency key, optional command linkage, and durable ordering.

Driving mode changes presentation, not authority. A resumed driving session returns `responseStyle: brief`; it does not relax confirmation or policy requirements.

Raw audio is not retained in v1. Only text transcripts and explicit tool/action records are persisted.

## API

- `POST /v1/conversations` starts a session.
- `GET /v1/conversations/{sessionId}` resumes the session with up to 50 recent turns.
- `POST /v1/conversations/{sessionId}/turns` appends an idempotent transcript or action record.
- `POST /v1/conversations/{sessionId}/close` closes the session while retaining its record.

All routes require the existing Pendleton OS bearer credential. Session ownership is verified on every read and write.

## Persistence and security

`conversation_sessions` stores session identity, project scope, channel, driving mode, lifecycle state, and activity timestamps. `conversation_turns` stores ordered turns and optional command/correlation identifiers. Foreign keys, check constraints, unique idempotency keys, and resume indexes enforce the durable contract.

The migration explicitly revokes access from Supabase `anon` and `authenticated` roles. Pendleton OS accesses these internal tables only through its server-side PostgreSQL connection. No browser or mobile client receives direct database credentials.

## Deliberate v1 boundary

This slice does not yet generate assistant responses, transcribe audio, synthesize speech, summarize long sessions, retrieve project knowledge, or execute proposed tools. Those capabilities attach to this runtime in subsequent slices; they do not replace its session, policy, or audit boundaries.
