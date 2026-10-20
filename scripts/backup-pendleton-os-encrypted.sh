#!/usr/bin/env bash
# Back up the Pendleton OS Supabase database into ENCRYPTED Git artifacts.
# Requires source DB URL and age keypair; never put plaintext or keys in Git.
# Usage: bash scripts/backup-pendleton-os-encrypted.sh
# The script prompts privately for secrets when they are not already set.
set -euo pipefail
umask 077

if [[ -z "${SOURCE_DB_URL:-}" ]]; then
  read -rsp 'Pendleton OS PostgreSQL connection URL (input hidden): ' SOURCE_DB_URL
  printf '\n'
fi
if [[ -z "${AGE_IDENTITY_FILE:-}" ]]; then
  read -rp 'Absolute path to age private identity (outside this repo): ' AGE_IDENTITY_FILE
fi

EXPECTED_REF='fqzwkiuxghqcoequcykg'
ROOT="$(git rev-parse --show-toplevel)"
# Parse the URL rather than merely searching for the expected project ref
# anywhere (where it could otherwise occur in a password or query string).
command -v node >/dev/null || { echo 'Node.js is required for connection validation.' >&2; exit 1; }
mapfile -d '' -t CONNECTION < <(PENDLETON_OS_REF="$EXPECTED_REF" node -e '
  try {
    const u = new URL(process.env.SOURCE_DB_URL);
    const ref = process.env.PENDLETON_OS_REF;
    const user = decodeURIComponent(u.username);
    const direct = u.hostname === `db.${ref}.supabase.co` && user === "postgres";
    const pooled = u.hostname.endsWith(".pooler.supabase.com") && user === `postgres.${ref}`;
    if ((u.protocol !== "postgresql:" && u.protocol !== "postgres:") || (!direct && !pooled)) process.exit(1);
    for (const value of [u.hostname, u.port || "5432", user, decodeURIComponent(u.password), u.pathname.slice(1) || "postgres"])
      process.stdout.write(value + "\0");
  } catch { process.exit(1); }
');
if [[ "${#CONNECTION[@]}" -ne 5 || -z "${CONNECTION[3]}" ]]; then
  echo 'Refusing: URL host and username do not match the Pendleton OS project.' >&2
  exit 1
fi
unset SOURCE_DB_URL
export PGHOST="${CONNECTION[0]}" PGPORT="${CONNECTION[1]}" PGUSER="${CONNECTION[2]}"
export PGPASSWORD="${CONNECTION[3]}" PGDATABASE="${CONNECTION[4]}" PGSSLMODE=require
unset CONNECTION
if [[ ! -f "$AGE_IDENTITY_FILE" ]]; then
  echo 'Refusing: the private age identity file does not exist.' >&2; exit 1
fi
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
IDENTITY_DIR_REAL="$(cd "$(dirname "$AGE_IDENTITY_FILE")" && pwd -P)"
IDENTITY_REAL="$IDENTITY_DIR_REAL/$(basename "$AGE_IDENTITY_FILE")"
if [[ "$IDENTITY_REAL" == "$ROOT_REAL" || "$IDENTITY_REAL" == "$ROOT_REAL/"* ]]; then
  echo 'Refusing: the private age identity must exist OUTSIDE this Git repo.' >&2; exit 1
fi
for executable in pg_dump pg_dumpall age age-keygen tar sed uniq cmp git; do
  command -v "$executable" >/dev/null || { echo "Missing $executable" >&2; exit 1; }
done
DERIVED_RECIPIENT="$(age-keygen -y "$IDENTITY_REAL")"
if [[ -z "${AGE_RECIPIENT:-}" ]]; then
  AGE_RECIPIENT="$DERIVED_RECIPIENT"
elif [[ "$AGE_RECIPIENT" != "$DERIVED_RECIPIENT" ]]; then
  echo 'Refusing: AGE_RECIPIENT does not match the supplied private identity.' >&2; exit 1
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo 'Exporting roles, schema and data into private temporary files...'
pg_dumpall --roles-only --role postgres --quote-all-identifiers --no-role-passwords --no-comments \
  | sed -E 's/^\\(un)?restrict .*$/-- &/' \
  | sed -E 's/^CREATE ROLE "(anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin)"/-- &/' \
  | sed -E 's/^ALTER ROLE "(anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin)"/-- &/' \
  | sed -E 's/ (NOSUPERUSER|NOREPLICATION)//g' \
  | sed -E 's/^-- (.* SET "(pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing)" .*)/\1/' \
  | sed -E 's/GRANT ".*" TO "(anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin)"/-- &/' \
  | sed -E '/^--/d' | uniq > "$WORK/roles.sql"
printf 'RESET ALL;\n' >> "$WORK/roles.sql"

INTERNAL_SCHEMAS='information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault'
pg_dump --schema-only --quote-all-identifiers --role postgres --exclude-schema "$INTERNAL_SCHEMAS" \
  | sed -E 's/^\\(un)?restrict .*$/-- &/' \
  | sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' \
  | sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' \
  | sed -E 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/' \
  | sed -E 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/' \
  | sed -E 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/' \
  | sed -E 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/' \
  | sed -E 's/^CREATE PUBLICATION "supabase_realtime/-- &/' \
  | sed -E 's/^CREATE EVENT TRIGGER /-- &/' \
  | sed -E 's/^         WHEN TAG IN /-- &/' \
  | sed -E 's/^   EXECUTE FUNCTION /-- &/' \
  | sed -E 's/^ALTER EVENT TRIGGER /-- &/' \
  | sed -E 's/^ALTER PUBLICATION "supabase_realtime_/-- &/' \
  | sed -E 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/' \
  | sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' \
  | sed -E 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/' \
  | sed -E "s/^GRANT (.+) ON (.+) \"($INTERNAL_SCHEMAS)\"/-- &/" \
  | sed -E "s/^REVOKE (.+) ON (.+) \"($INTERNAL_SCHEMAS)\"/-- &/" \
  | sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "(pg_tle|pgsodium|pgmq)").+/\1;/' \
  | sed -E 's/^COMMENT ON EXTENSION (.+)/-- &/' \
  | sed -E 's/^CREATE POLICY "cron_job_/-- &/' \
  | sed -E 's/^ALTER TABLE "cron"/-- &/' \
  | sed -E 's/^SET transaction_timeout = 0;/-- &/' \
  | sed -E '/^--/d' > "$WORK/schema.sql"

printf 'SET session_replication_role = replica;\n\n' > "$WORK/data.sql"
pg_dump --data-only --quote-all-identifiers --role postgres \
  --exclude-schema 'information_schema|pg_*|graphql|graphql_public|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault|etl|extensions|pgbouncer|realtime|supabase_migrations|_analytics|_realtime|_supavisor' \
  --exclude-table auth.schema_migrations --exclude-table storage.migrations \
  --exclude-table supabase_functions.migrations --exclude-table storage.buckets_vectors \
  --exclude-table storage.vector_indexes --schema '*' \
  | sed -E 's/^\\(un)?restrict .*$/-- &/' >> "$WORK/data.sql"
printf '\nRESET ALL;\n' >> "$WORK/data.sql"
for f in roles.sql schema.sql data.sql; do
  [[ -s "$WORK/$f" ]] || { echo "Incomplete export: $f" >&2; exit 1; }
done

DEST="$ROOT/backups/database"
mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="pendleton-os-$STAMP.tar.age"
ARCHIVE="$DEST/$BASE"
PARTIAL="$ARCHIVE.partial"
# Stream only encrypted ciphertext into the public Git checkout.
tar -C "$WORK" -cf - roles.sql schema.sql data.sql | age -r "$AGE_RECIPIENT" -o "$PARTIAL"
mkdir "$WORK/verified"
age -d -i "$IDENTITY_REAL" "$PARTIAL" | tar -C "$WORK/verified" -xf -
for f in roles.sql schema.sql data.sql; do
  cmp -s "$WORK/$f" "$WORK/verified/$f" || { echo "Cannot verify $f" >&2; exit 1; }
done
mv "$PARTIAL" "$ARCHIVE"
(
  cd "$DEST"
  if command -v sha256sum >/dev/null; then
    sha256sum "$BASE"
  else
    shasum -a 256 "$BASE"
  fi
) > "$ARCHIVE.sha256"
echo "Encrypted and decrypted successfully: $ARCHIVE"
echo 'NOTE: A fresh-database RESTORE verification is still required.'
echo 'The artifact was not committed or uploaded. Do that only after the restore test passes.'
