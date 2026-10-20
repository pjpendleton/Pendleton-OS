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
if ! PENDLETON_OS_REF="$EXPECTED_REF" node -e '
  try {
    const u = new URL(process.env.SOURCE_DB_URL);
    const ref = process.env.PENDLETON_OS_REF;
    const user = decodeURIComponent(u.username);
    const direct = u.hostname === `db.${ref}.supabase.co` && user === "postgres";
    const pooled = u.hostname.endsWith(".pooler.supabase.com") && user === `postgres.${ref}`;
    if ((u.protocol !== "postgresql:" && u.protocol !== "postgres:") || (!direct && !pooled)) process.exit(1);
  } catch { process.exit(1); }
'; then
  echo 'Refusing: URL host and username do not match the Pendleton OS project.' >&2
  exit 1
fi
if [[ ! -f "$AGE_IDENTITY_FILE" ]]; then
  echo 'Refusing: the private age identity file does not exist.' >&2; exit 1
fi
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
IDENTITY_DIR_REAL="$(cd "$(dirname "$AGE_IDENTITY_FILE")" && pwd -P)"
IDENTITY_REAL="$IDENTITY_DIR_REAL/$(basename "$AGE_IDENTITY_FILE")"
if [[ "$IDENTITY_REAL" == "$ROOT_REAL" || "$IDENTITY_REAL" == "$ROOT_REAL/"* ]]; then
  echo 'Refusing: the private age identity must exist OUTSIDE this Git repo.' >&2; exit 1
fi
for executable in supabase docker age age-keygen tar cmp git; do
  command -v "$executable" >/dev/null || { echo "Missing $executable" >&2; exit 1; }
done
DERIVED_RECIPIENT="$(age-keygen -y "$IDENTITY_REAL")"
if [[ -z "${AGE_RECIPIENT:-}" ]]; then
  AGE_RECIPIENT="$DERIVED_RECIPIENT"
elif [[ "$AGE_RECIPIENT" != "$DERIVED_RECIPIENT" ]]; then
  echo 'Refusing: AGE_RECIPIENT does not match the supplied private identity.' >&2; exit 1
fi
docker info >/dev/null 2>&1 || { echo 'Docker engine must be running.' >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo 'Exporting roles, schema and data into private temporary files...'
supabase db dump --db-url "$SOURCE_DB_URL" -f "$WORK/roles.sql" --role-only
supabase db dump --db-url "$SOURCE_DB_URL" -f "$WORK/schema.sql"
supabase db dump --db-url "$SOURCE_DB_URL" -f "$WORK/data.sql" --use-copy --data-only \
  -x 'storage.buckets_vectors' -x 'storage.vector_indexes'
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
