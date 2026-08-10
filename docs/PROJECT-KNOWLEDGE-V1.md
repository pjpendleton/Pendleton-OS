# Pendleton OS Project Knowledge Retrieval v1

Status: Implementation verified; production deployment pending

Version: 1.0.0

Date: 2026-08-09

## Purpose

Project Knowledge Retrieval lets an authenticated Pendleton OS conversation answer questions from
the active project's governed sources. It is an on-demand retrieval service, not a bulk copy or a
shadow document store. Google Drive remains the system of record for project documents, and Gmail
and Outlook remain the systems of record for email.

This capability implements the project-awareness requirement in the System Design, ADR-003, and
ADR-004. Voice is only an interface: it invokes the same authenticated application endpoint used by
web and mobile clients.

## Version 1 boundary

Version 1 searches three read-only providers concurrently:

- Native Google Docs located anywhere beneath the registered Google Drive knowledge root.
- Gmail through the existing `gmail.readonly` delegated grant.
- Outlook through the existing Microsoft Graph `Mail.Read` delegated grant.

The Google authorization retains `drive.file` for previously approved verified mutations and adds
`drive.readonly` for project retrieval. Search results are bounded to 12 combined items and contain
only the source identifier, title or subject, a limited excerpt, source label, optional sender and
date, and a canonical Google Docs URL when available.

The service does not copy entire projects, download attachments, retain full email bodies, index
local desktop folders from production, create embeddings, or search across inactive projects.

## Project and policy controls

Every request requires an authenticated administrator or paired device. The selected project must
exist, be active, and authorize the server-bound actor. Candidate and archived projects fail before
any provider is queried.

The Google Drive adapter verifies that every returned document is a direct or nested descendant of
the project's registered read-only knowledge root. A document that cannot be proven to belong to
that hierarchy is discarded. The knowledge root is distinct from the verified-write project root,
so broad read access never expands the folder in which workflows may create or update artifacts.
When no dedicated knowledge root is registered, retrieval falls back to the verified-write project
root. Email searches use the same active-project and actor checks as EMAIL-001.

One unavailable provider does not make the other sources unusable. The response identifies each
source as `ready` or `unavailable`, and the conversational interface must disclose material gaps
instead of inventing project facts.

## API

`POST /v1/knowledge/search`

```json
{
  "projectId": "pendleton-os",
  "query": "voice operating contract",
  "maxResults": 5
}
```

The permanent bearer credential never reaches the phone. A paired mobile device authenticates with
its signed, secure, HTTP-only cookie. The server controls the default project and actor.

## Voice contract

Realtime sessions expose `search_project_knowledge`. The model uses it when Peter asks about a
project, document, email, decision, status, risk, or prior communication. Spoken answers must name
the supporting source titles naturally, stay brief in driving mode, and state when a provider was
unavailable.

## Audit contract

Every aggregate search appends `knowledge.search.completed`. The event contains the project, actor,
read-only permission mode, result count, provider status and counts, and a SHA-256 query hash. It
does not contain the query text, titles, senders, excerpts, message content, document content, access
tokens, or refresh tokens.

Successful underlying mailbox searches continue to append their provider-specific
`email.search.completed` events. This gives the audit trail both one conversational retrieval event
and the exact provider reads that supported it.
