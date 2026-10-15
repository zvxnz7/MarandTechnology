# Code review and Node.js migration

Reviewed the application, database schema, seed importer, management commands,
templates, browser scripts, Windows operations scripts, and the existing test
suite on 15 October 2026.

## Existing system

- `app.py` is a Flask server backed by SQLite. It handles sign-in, roles,
  projects, manufacturing trials, draft specifications, review and approval,
  versioning, audit history, source downloads, and production cards.
- `schema.sql` enforces foreign keys and prevents approved records, issued
  cards, and audit rows from being changed or deleted.
- `manage.py` initializes and seeds the database, creates users, backs up the
  database, and runs the server.
- `administracja/maintenance.py` implements a careful Windows release updater
  and scheduled backup flow. It validates release manifests, keeps data out of
  program swaps, and restores the previous program after a failed health check.
- `build_seed.py` is a one-time importer for source DOCX/ODT files. The
  generated `seed/data.json` and `seed/sources` are sufficient for normal
  application startup; the importer is not needed on the server.
- `templates/` and `static/` render the Polish web interface and print cards.
  `tests/` covers roles, CSRF, stale edits, approval, immutable cards, backup,
  source paths, and larger searches.

## Existing safeguards retained

The Node.js application reuses the same SQLite schema and database file. It
recognizes both Werkzeug scrypt hashes used by this pilot and PBKDF2 hashes,
uses server-side role checks, signed HTTP-only session cookies, CSRF checks,
login throttling, parameterized SQLite queries, revision checks, audit rows,
and the existing database immutability triggers. Source names are confined to
`seed/sources`; user text is HTML-escaped before rendering.

The updater only installs a stable, higher semver GitHub release. It verifies
the release asset SHA-256 and every file digest, rejects unmanifested files
and schema changes, backs up SQLite, keeps the old program, checks `/healthz`,
and attempts rollback if startup fails. It never copies a release over the
live data directory.

## Node.js deployment details

The runtime has no npm package dependencies. It uses Node's built-in
`node:sqlite`, so the server requires Node.js 24.15 or later; the SQLite API is
documented by Node.js as a release candidate. This avoids Python and avoids
platform-specific native npm modules on Windows Server.

`server.js` and `views.js` replace Flask and Jinja at runtime. `manage.js`
replaces the initialization, user creation, backup, and run commands. The
new release workflow packages only the Node runtime, static files, seed JSON,
and historical source cards; it leaves local database files, session keys,
the preview HTML, and Python tools out of the install archive.

The old Python files remain in the source workspace as pilot history and as a
reference for the one-time source importer. The Node release bundle does not
ship or execute them, and the Windows start and operations scripts now invoke
Node.js.

## Deployment items still needed

- The private repository is now connected as `origin/main` in this workspace.
- `INSTALL_SERVER.cmd` installs the Node app as a Windows scheduled task,
  configures daily backups, copies the updater outside the program directory,
  and supports private GitHub read-only access through a DPAPI-protected token.
  See `SERVER_QUICKSTART.md` for initial server setup.
- The Python tests have not been ported or run against the Node.js version.
  The app should be validated against a copy of the existing database before
  using it for production records.
- The Node SQLite API is still marked release candidate by Node.js. Keep the
  server on a supported Node 24 release and recheck the API when upgrading the
  runtime.

## Scope boundaries

This migration does not add user-management screens, automatic schema
migrations, the broader historical archive import, or new attachment upload
flows. Those were not present in the pilot's runtime behavior. The app keeps
the current pilot's database schema and workflow.
