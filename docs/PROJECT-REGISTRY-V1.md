# Pendleton OS Project Registry v1

Status: Production deployed and verified

Version: 1.0.0

Date: 2026-08-08

## Purpose

The Project Registry gives Pendleton OS a durable, governed identity for every project and a verified map to the resources that belong to it. It replaces production's hard-coded project directory and Drive-root mapping without moving or duplicating source files.

## Operating model

A project has one stable `projectId`, a display name, aliases, environment, lifecycle status, authorized members, and registered resources. Resources are references to systems of record such as Google Drive, a desktop-only local folder, Gmail, or Microsoft Graph. Registering a resource never copies or deletes its source content.

Discovered projects enter as `candidate`. Candidate projects are visible for review but cannot be used for commands or voice actions. An explicit administrative status change is required to make a project `active`. Archived projects remain identifiable but cannot receive commands.

## API

- `GET /v1/projects` lists projects, optionally filtered by `candidate`, `active`, or `archived`.
- `GET /v1/projects/{projectId}` returns one project and its registered resources.
- `POST /v1/projects/import` imports up to 100 bounded candidates without activating them.
- `PATCH /v1/projects/{projectId}` changes lifecycle status.

Reads require an authenticated administrator or paired device. Imports and lifecycle changes require the administrator bearer credential; a paired mobile cookie alone cannot mutate the registry.

## Persistence and security

`projects` stores stable project identity and lifecycle. `project_aliases` provides case-insensitive natural-language resolution. `project_members` binds authorized actors to projects. `project_resources` stores provider references, types, external identifiers, availability status, and bounded metadata.

All four tables have row-level security enabled. Only the dedicated `pendleton_runtime` server role receives `SELECT`, `INSERT`, and `UPDATE`. Supabase `anon` and `authenticated` roles have no table grants. No service-role key or database credential is exposed to the browser or mobile client.

## Candidate discovery

`npm run projects:import` inventories `D:\Projects` and `G:\My Drive\AI\Projects` in dry-run mode. `npm run projects:import -- --apply` writes discovered directories as candidate projects through the server database role. `_ARCHIVE`, `_SECRETS`, hidden directories, and files are excluded. Each folder is registered as a desktop-only resource reference; content is not uploaded.

## Email boundary

The registry can represent Gmail and Microsoft Graph mailboxes. The separate EMAIL-001 service begins with on-demand read-only search, stores credentials only in the production secret store, and requires an active project plus an auditable access event. Sending, deletion, filing, and other mailbox mutations remain out of scope until separately approved and policy-gated.
