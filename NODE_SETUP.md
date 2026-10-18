# Marand Technology — Node.js deployment

The application now runs on Node.js and reuses the existing SQLite database schema. It does not need Python or npm packages on the server.

For the easiest Windows Server install, run `INSTALL_SERVER.cmd` from the
repository root and follow `SERVER_QUICKSTART.md`. The manual steps below are
for an engineer-managed installation.

## Requirements

- Windows Server with Node.js 24.15 or newer installed.
- A local program directory and a separate writable data directory.
- HTTPS or a trusted VPN/reverse proxy before allowing remote access.

## First start

1. Copy the application files to the program directory. Keep `data` outside it.
2. Set `MARAND_DATA` to the data directory and, for HTTPS, set `MARAND_HTTPS=1`.
3. Run `node manage.js init` once. It keeps an existing database and creates an administrator only if one is missing.
4. Start the app with `node manage.js run --host 127.0.0.1 --port 8765`.
5. Run it as a Windows service or scheduled task using a wrapper that keeps the process alive. The included installer creates a scheduled task at Windows startup.

The application preserves the existing SQLite schema, records, user rows, and password hashes. Fresh databases start with no projects, ready for data entry. Existing users sign in with their current passwords. Node.js uses its own signed session cookie, so users sign in again after changing runtimes.

## Backups

Create and verify a consistent SQLite backup with:

```powershell
node manage.js backup --output D:\Kopie\marand-2026-10-15.sqlite3
```

Use a new output filename each time. Keep backups outside both the program and live data directories.

## GitHub updates

After each push to `main`, GitHub Actions creates a versioned release containing `marand-node-release.zip`. The administrator page has an **Aktualizacje GitHub** link and an update button when a newer release is available. It downloads the package from the configured repository, checks GitHub's SHA-256 digest and the per-file manifest, then hands it to the external updater outside the replaceable program directory.

Set these environment variables for the app process (the included installer sets them through `run-server.ps1`):

- `MARAND_GITHUB_REPO=owner/repository`
- `MARAND_GITHUB_TOKEN` only for a private repository; this repository is public, so no token is needed.
- `MARAND_UPDATER` to the absolute path of the external `updater.js` copy.
- `MARAND_UPDATE_CONFIG` to the absolute path of the external updater JSON configuration.

The workflow assigns increasing release versions automatically. The updater refuses a release with a changed database schema or invalid file hashes. It takes a SQLite backup before replacing code and restores the previous program if the app fails its health check.

The current source tree and newly built release packages contain no customer
records or original source documents. Earlier Git commits or already-published
releases may still contain data removed from the current tree. Do not publish
production data, `data/secret.key`, live SQLite files, or user passwords to
GitHub. Keep `data/` and `seed/sources/` out of the repository.
