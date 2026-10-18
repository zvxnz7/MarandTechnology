# Server handoff checklist

This checklist is for the next contributor working on the Windows Server deployment.
Use it with the latest code on `main`.

## Deploy and verify

- [ ] Wait for GitHub Actions to publish a release for the latest `main` commit.
- [ ] On Windows Server, update from the app and confirm the existing SQLite
  database, users, and session key remain intact.
- [ ] Confirm historical source attachments on an existing server still open after
  updating; new installs and release packages should contain no customer records
  or source documents.
- [ ] Check the app's update status and server logs after the update.

## Windows coverage

- [ ] Add a Windows CI job or a documented smoke-check script for installer
  startup, release packaging, update, health verification, and rollback.
- [ ] Exercise updater failures: invalid checksum, updater launch failure, service
  restart failure, and stale update lock recovery.
- [ ] Confirm updater cleanup retains the newest five program snapshots, ten
  pre-update database backups, and only a few downloaded update packages.

## Public GitHub history

- [ ] Review older commits and published release assets. They may still contain
  records and source documents removed from the current source tree.
- [ ] Coordinate with the repository owner before rewriting Git history or deleting
  old releases, since that can disrupt existing clones and forks.

## Access for collaborators

- [ ] Add collaborators who need to push to the repository. Public visibility gives
  people read access; pushing requires collaborator write access or a fork and PR.
