# MarandTechnology

The application, database tools, backups, and GitHub release updater run on
Node.js 24.15 or later. The server does not need Python or npm dependencies.

For a fresh Windows Server installation, download the latest release asset
`marand-node-release.zip`, extract it, and run `INSTALL_SERVER.cmd`. The release
package includes the installer and runtime files. Follow
[SERVER_QUICKSTART.md](SERVER_QUICKSTART.md).
After each push to `main`, GitHub Actions publishes a versioned update that an
administrator can install from the app's **Aktualizacje GitHub** page or by
running `administracja\AKTUALIZUJ.cmd` from the installed administration folder.
