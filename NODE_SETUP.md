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

The application uses the same `schema.sql`, seed data, user rows, and password hashes as the Python pilot. Existing users sign in with their current passwords. The first Node login creates a Node-specific signed session cookie, so users will sign in again after changing runtimes.

## Backups

Create and verify a consistent SQLite backup with:

```powershell
node manage.js backup --output D:\Kopie\marand-2026-10-15.sqlite3
```

Use a new output filename each time. Keep backups outside both the program and live data directories.

## GitHub release updates

The administrator page offers an update button for stable GitHub releases. It downloads the `marand-node-release.zip` asset from the latest release, checks GitHub's SHA-256 asset digest, then hands the package to the external updater. The updater must be copied outside the replaceable program directory and configured with the task/service, data, and backup paths.

Set these environment variables for the app process (the included installer sets them through `run-server.ps1`):

- `MARAND_GITHUB_REPO=owner/repository`
- `MARAND_GITHUB_TOKEN` only for a private repository; use a read-only token with repository contents access.
- `MARAND_UPDATER` to the absolute path of the external `updater.js` copy.
- `MARAND_UPDATE_CONFIG` to the absolute path of the external updater JSON configuration.

Push a tag such as `v0.2.1` to build and publish an update release. The workflow attaches `marand-node-release.zip`; the updater refuses a release with a changed database schema or invalid file hashes. It takes a SQLite backup before replacing code and restores the previous program if the app fails its health check.

Do not publish production data, `data/secret.key`, live SQLite files, or user passwords to GitHub. Keep `data/` out of the repository.
