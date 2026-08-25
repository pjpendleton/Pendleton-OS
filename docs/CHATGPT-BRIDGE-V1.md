# Pendleton OS ChatGPT Business Read Bridge v1

Status: Implemented locally; production migration, deployment, and first user capture pending

Version: 1.0.0

Date: 2026-08-25

## Purpose

The bridge creates an auditable inventory of ChatGPT Business projects, visible conversations, and
visible source metadata so that selected material can later be imported into Pendleton OS. Pendleton
OS is the canonical content system; ChatGPT is an AI provider and an import source, not the permanent
system of record.

OpenAI does not expose a supported API for enumerating ChatGPT Business sidebar projects and their
uploaded sources. The v1 bridge therefore uses an explicitly invoked browser companion operating in
the user's authenticated ChatGPT session. It sends only the bounded metadata contract below.

## Security boundary

- The companion never sends ChatGPT cookies, browser storage, chat bodies, file contents, passwords,
  OpenAI API keys, or the Pendleton OS administrator token.
- Ingestion requires a distinct `PENDLETON_CHATGPT_BRIDGE_TOKEN` using the `Bridge` authorization
  scheme. The administrator bearer token is deliberately rejected by the ingestion route.
- Readback uses the existing administrator or paired-device authorization boundary.
- Every accepted inventory produces an immutable correlated event.
- The v1 bridge cannot create, edit, delete, download, or import ChatGPT content.

## Contract and endpoints

Contract version `1.0.0` supports two scopes:

- `project-list` observes the projects visible on the ChatGPT Projects page.
- `project-detail` observes either visible conversations or visible source metadata for one project.

`observedCollections` controls stale marking. A missing item becomes stale only when its collection
was actually observed, preventing an empty or unrelated page from erasing known inventory.

- `POST /v1/connectors/chatgpt/inventory` accepts a scoped metadata snapshot.
- `GET /v1/connectors/chatgpt/projects` lists the stored inventory.
- `GET /v1/connectors/chatgpt/projects/{sourceProjectKey}` returns one project with observations.

Snapshot replay is idempotent by workspace label and snapshot key. Source keys without a provider ID
are deterministic SHA-256 locators and are explicitly classified as `derived-name` or metadata-only.

## Deployment sequence

1. Apply `packages/persistence/migrations/0006_chatgpt_read_bridge.sql` (or the matching Supabase
   migration).
2. Set a distinct random `PENDLETON_CHATGPT_BRIDGE_TOKEN` of at least 32 characters.
3. Deploy the API and verify its readiness endpoint.
4. Load `apps/chatgpt-bridge-extension` as an unpacked Chrome extension.
5. Capture the Projects page, then each selected project's Chats and Sources tabs.
6. Verify the inventory through the authenticated read endpoint and the audit event store.

## Deferred work

Explicit selection, content download where technically available, integrity hashing, malware checks,
canonical Pendleton OS project creation, and provenance-preserving import are the next contract. They
must not be implied by a successful v1 inventory scan.
