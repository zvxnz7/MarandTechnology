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
  the active repository. The prebuilt JSON seed and its source documents are
  the data inputs used by the JavaScript initializer.

## Update flow

Every push to `main` runs `.github/workflows/release.yml`. GitHub Actions builds
a clean release archive from the JavaScript runtime files and selected seed
sources, assigns a monotonically increasing `0.3.N` version, and publishes the
archive as the latest GitHub release. The administrator page checks the
configured repository and offers installation only when a newer release is
available. Before replacing code, the external updater verifies the archive,
backs up SQLite, stops the Windows task, swaps program files, checks `/healthz`,
and restores the previous program if startup fails.

## Data and access safeguards

The runtime keeps SQLite outside the replaceable program directory. It retains
signed HTTP-only sessions, CSRF protection, login throttling, role checks,
parameterized queries, stale-edit detection, audit history, HTML escaping, and
database triggers protecting approved records and issued cards. The installer
limits TCP 8765 to the local subnet on Private or Domain Windows firewall
profiles. Do not expose the HTTP service directly to the Internet.

## Known operational limitation

The screenshot provided on 18 October 2026 shows a generic SQLite save failure.
The source code can verify a save on a clean temporary database, but the
screenshot does not show the corresponding server-side SQLite error. The
server now writes the SQLite error code, message, and stack to its local error
log, so a failure tied to the installed database can be diagnosed from that
log without exposing SQL details to ordinary app users.
