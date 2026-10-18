# Marand Technology codebase review

## Runtime

- `server.js` and `views.js` implement the web application and HTML interface.
- `manage.js` initializes and seeds SQLite, creates users, makes verified
  backups, and starts the server. Node's built-in `node:sqlite` is the only
  database dependency.
- `administracja/updater.js` verifies GitHub release archives and their
  per-file SHA-256 manifest, backs up the live database, swaps program files,
  checks application health, and rolls back a failed update.
- The Windows installer and PowerShell scripts only configure Node.js,
  scheduled tasks, DPAPI-protected settings, backups, and the LAN firewall.
  They do not run Python.
- Python pilot application files and Jinja templates have been removed from
  the active repository. Fresh installs start with an empty project list;
  current releases do not include customer records or original source documents.

## Update flow

Every push to `main` runs `.github/workflows/release.yml`. GitHub Actions builds
a clean release archive from the JavaScript runtime files and empty seed,
assigns a monotonically increasing `0.3.N` version, and publishes the
archive as the latest GitHub release. The administrator page checks the
configured repository and offers installation only when a newer release is
available. Before replacing code, the external updater verifies the archive,
backs up SQLite, stops the Windows task, swaps program files, checks `/healthz`,
and restores the previous program if startup fails. It preserves source files
already stored on installed servers, retains the newest five program snapshots
and ten pre-update database backups, and removes stale downloaded packages.

## Data and access safeguards

The runtime keeps SQLite outside the replaceable program directory. It retains
signed HTTP-only sessions, CSRF protection, login throttling, role checks,
parameterized queries, stale-edit detection, audit history, HTML escaping, and
database triggers protecting approved records and issued cards. The installer
limits TCP 8765 to the local subnet on Private or Domain Windows firewall
profiles. Do not expose the HTTP service directly to the Internet.

## Save failure handling

The JavaScript save route now preserves valid submitted edit values if SQLite
rejects a write, so the editor remains available for a retry. It distinguishes
database-busy, read-only, disk-full, and constraint errors in the page and logs
a short reference code with the SQLite details in
`administracja/logs/server-*.err.log`. SQL details stay out of the browser.
For a persistent failure, match the reference code to that server log to find
the installed database's specific cause.

Earlier Git commits or already-published releases may still contain records and
source documents removed from the current tree. Treat those historical copies
as public until the GitHub history and old releases are separately cleaned up.
