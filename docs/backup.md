# Backup and restore

Nori stores everything in one SQLite database in WAL mode: `.data/nori.sqlite` by default, or the path in `NORI_DATABASE_PATH` (legacy `SAME_DATABASE_PATH` still works). Do not copy the database file alone while the server is running. Recent commits can live in `nori.sqlite-wal`, so a plain copy can be stale or internally inconsistent.

## Online backup while Nori runs

Create a backup directory outside the database directory and use SQLite's online backup mechanisms:

```sh
umask 077
mkdir -p .backups
BACKUP=".backups/nori-$(date +%Y%m%d-%H%M%S).sqlite"
sqlite3 .data/nori.sqlite "VACUUM INTO '$BACKUP'"
```

`VACUUM INTO` writes one consistent database file and does not require stopping Nori. The equivalent SQLite backup API is:

```sh
umask 077
mkdir -p .backups
BACKUP=".backups/nori-$(date +%Y%m%d-%H%M%S).sqlite"
sqlite3 .data/nori.sqlite ".backup '$BACKUP'"
```

The `VACUUM INTO` result is a single file with no `-wal` or `-shm` sidecars. Run this verification in the same shell so `$BACKUP` names the file just produced, before relying on it:

```sh
sqlite3 "$BACKUP" "PRAGMA integrity_check; PRAGMA foreign_key_check;"
```

`PRAGMA integrity_check` should return `ok`; `PRAGMA foreign_key_check` should return no rows. Keep `$BACKUP` available for the restore step below (or record its exact path). Nori applies any pending schema migrations when it opens the database, including assessment and tutor tables.

If you use a custom path, replace `.data/nori.sqlite` with that path in every command. Keep backups private: they contain course sources, learner answers, corrections, assessments and tutor conversations, and Nori has no login.

## Restore with the server stopped

1. Stop the Nori server process first. Never restore or replace the database while it is running.
2. Create a fresh unique recovery directory and move the current database and both WAL sidecars into it with explicit failure checks. Do not reuse fixed `.pre-restore` names, which could overwrite an earlier recovery copy:

   ```sh
   set -e
   RECOVERY_DIR=$(mktemp -d .data/pre-restore.XXXXXX)
   test -d "$RECOVERY_DIR"
   for name in nori.sqlite nori.sqlite-wal nori.sqlite-shm; do
     if [ -e ".data/$name" ]; then
       mv ".data/$name" "$RECOVERY_DIR/$name"
     fi
   done
   test ! -e .data/nori.sqlite
   test ! -e .data/nori.sqlite-wal
   test ! -e .data/nori.sqlite-shm
   echo "Previous database files moved to $RECOVERY_DIR"
   ```

   The `set -e` and post-move `test` checks stop the restore if a file cannot be moved or still remains in the active path. Leaving stale `-wal` or `-shm` files beside a replaced database can apply old frames to the restored file.

3. Copy the intended, verified backup into place, restrict its mode, and start Nori:

   ```sh
   set -e
   BACKUP=".backups/nori-YYYYMMDD-HHMMSS.sqlite"  # the verified path from the backup step
   test -f "$BACKUP"
   cp "$BACKUP" .data/nori.sqlite
   chmod 600 .data/nori.sqlite
   bun run start
   ```

   Run step 3 in the same shell as step 2 (or set `set -e` again, as shown), so a missing backup or copy failure stops the restore before startup.

A `VACUUM INTO` backup needs no sidecars. If you instead copied a live database directory, the database, `-wal` and `-shm` must have been copied together while the server was stopped, or taken with the backup API; a partial copy is not a valid restore source.

## Automated coverage and limits

`src/lib/server/backup.test.ts` creates a scratch database in WAL mode with accepted module content, an attempt and owner correction, an assessment with items/answers/results, and tutor turns/proposals. It takes a `VACUUM INTO` snapshot while the connection is open, confirms the source rows are unchanged, copies the backup to a new path, opens it independently with `openDatabase`, and asserts IDs, content, references, corrections, results and tutor records survive with a clean foreign-key check and `integrity_check = ok`. It never reads or writes `.data/` and does not restart a real server.

This verifies SQLite backup/restore semantics under WAL, not a deployed proxy, a real production restore, or a real-model/provider workflow.
