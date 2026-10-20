#!/usr/bin/env bash
# Back up the Pendleton OS Supabase database into ENCRYPTED Git artifacts.
# Requires source DB URL and age keypair; never put plaintext or keys in Git.
# Usage: SOURCE_DB_URL=... AGE_RECIPIENT=age1... AGE_IDENTITY_FILE=/safe/path \
#   BACKUP_COMMIT=1 BACKUP_PUSH=1 bash scripts/backup-pendleton-os-encrypted.sh
set -eo pipefail
umask 077

EXPECTED_REF='fqzwkiuxghqcoequcykg'
ROOT="$(git rev-parse --show-toplevel)"
if [[ -z "$SOURCE_DB_URL" || "$SOURCE_DB_URL" != *"$EXPECTED_REF"* ]]; then
  echo 'Refusing: SOURCE_DB_URL must identify Pendleton OS.' >&2; exit 1
fi
if [[ -z "$AGE_RECIPIENT" || "$AGE_RECIPIENT" != age1* ]]; then
  echo 'Refusing: a verified age recipient public key is required.' >&2; exit 1
fi
if [[ ! -f "$AGE_IDENTITY_FILE" || "$AGE_IDENTITY_FILE" == "$ROOT/"* ]]; then
  echo 'Refusing: the private age identity must exist OUTSIDE this Git repo.' >&2; exit 1
fi
for executable in supabase docker age tar git; do
  command -v "$executable" >/dev/null || { echo "Missing $executable" >&2; exit 1; }
done
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
# Stream only encrypted ciphertext into the public Git checkout.
tar -C "$WORK" -cf - roles.sql schema.sql data.sql | age -r "$AGE_RECIPIENT" -o "$ARCHIVE"
age -d -i "$AGE_IDENTITY_FILE" "$ARCHIVE" | tar -tf - > "$WORK/archive-list"
for f in roles.sql schema.sql data.sql; do
  grep -Fxq "$f" "$WORK/archive-list" || { echo "Cannot verify $f" >&2; exit 1; }
done
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

if [[ "$BACKUP_COMMIT" == '1' ]]; then
  git -C "$ROOT" add -- "backups/database/$BASE" "backups/database/$BASE.sha256"
  git -C "$ROOT" commit -m "backup: encrypted Pendleton OS SQL snapshot $STAMP"
  if [[ "$BACKUP_PUSH" == '1' ]]; then git -C "$ROOT" push; fi
fi
