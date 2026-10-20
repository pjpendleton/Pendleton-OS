# Pendleton OS database backup and retirement

**Current state (October 20, 2026): NO COMPLETE BACKUP HAS YET BEEN CREATED.** Do not delete the database.

The [Pendleton OS repository](https://github.com/pjpendleton/Pendleton-OS) is **public**. Never commit plaintext SQL or JSON exports, database credentials, or encryption private keys. Encrypted archives will remain visible in Git history indefinitely. A private backup destination is preferable.

## Verified read-only inventory
- Supabase project reference: `fqzwkiuxghqcoequcykg`, Pendleton OS Production.
- 13 application tables in the `public` schema, with records.
- 6 applied migrations; four corresponding files on main, two extra schema definitions on `agent/chatgpt-read-bridge` with different migration timestamps.
- At inspection time, `auth.users` contained 0 users; Storage contained 0 buckets and 0 objects. Check these counts again before retirement.
- Existing migration scripts are not a backup of application data.

## Encrypted database export
Use [`scripts/backup-pendleton-os-encrypted.sh`](../scripts/backup-pendleton-os-encrypted.sh), based on the official Supabase CLI export workflow.

1. On a trusted machine or secure CI runner with Supabase CLI, Docker, Git, and `age`, generate an `age` encryption keypair. Keep the private key **outside GitHub** and preserve at least two safe copies. Verify the public recipient key.
2. Obtain the PostgreSQL connection URL privately from the project Dashboard's **Connect** panel. Never paste it into a GitHub file, chat, or build log.
3. Set environment variables securely: `SOURCE_DB_URL`, `AGE_RECIPIENT`, and `AGE_IDENTITY_FILE`. The script refuses a URL that does not include the verified Pendleton OS project reference.
4. Execute `bash scripts/backup-pendleton-os-encrypted.sh`. Set `BACKUP_COMMIT=1 BACKUP_PUSH=1` when the encrypted archive is to be committed and pushed automatically.
5. The script exports `roles.sql`, `schema.sql`, and `data.sql` in a private temporary folder, streams them to one `*.tar.age` encrypted artifact, verifies decryption using the private key, and writes a `*.sha256` integrity checksum. Only the encrypted artifact and checksum are eligible for Git tracking.
6. **Restore-test** the archive in an isolated disposable Supabase/PostgreSQL environment. Check every table's row count, RLS and role permissions, and a representative application workflow. An encrypted artifact is not a verified backup until restoration succeeds.

## Limitations and retirement gates
- A database export may not preserve project-level Auth provider configuration, email settings, secrets, API keys, edge deployments, or external integrations. These need private recovery records.
- Supabase database exports contain Storage *metadata*, not Storage binary objects; there were no Storage objects on inspection, but recheck.
- Recreating the Supabase project changes its URL and keys; dependent services may break even if SQL restores correctly.
- Before deleting anything, verify a full restoration, document necessary settings, disable any live dependencies safely, and confirm the **exact project** to retire. Deletion is irreversible.
- This script **does not delete**, suspend, or modify a Supabase project. No backup or restore test has been run in this session.

References:
- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
