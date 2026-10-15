# Put Marand on a Windows Server

This is the one-time setup for the private GitHub repository `zvxnz7/MarandTechnology`.
The installer creates a background Windows scheduled task, keeps the database
outside the replaceable program folder, schedules daily database backups, and
configures the app's GitHub release updater.

## One-time setup

1. On the server, sign in to GitHub and download the repository as a ZIP. Extract
   the full project folder to a local drive.
2. Open that folder and double-click `INSTALL_SERVER.cmd`. Approve the Windows
   administrator prompt. The installer will use `winget` to install/update Node.js
   LTS if needed; it requires Node.js 24.15 or newer. If `winget` is unavailable,
   install Node.js LTS manually, then run the installer again.
3. If you already have a live SQLite database, enter the path to its
   `marand.sqlite3` when asked. Keep `secret.key` beside that database if you want
   existing user sessions to keep the same signing key. Press Enter to make a new
   seeded database instead.
4. At the first-run prompt, create the app administrator login and password.
5. When asked, paste a GitHub fine-grained personal access token restricted to
   this repository with **Contents: Read-only**. The installer stores it encrypted
   with Windows DPAPI outside the program folder. Press Enter to configure this
   later; run `administracja/SET_GITHUB_TOKEN.cmd` and restart the server task.

The app is installed under `C:\Marand\Technologia`. Its database and session key
are in `dane`, the updater and protected settings are in `administracja`, and
backups go to `D:\Kopie\Marand-Technologia` when D: exists (otherwise to
`C:\Marand\Technologia\kopie`). A verified backup is created during setup and
then daily at 22:00.

The web app starts in the background at Windows startup. On the server itself,
open <http://127.0.0.1:8765>. Use `administracja\STOP_SERVER.cmd`,
`START_SERVER.cmd`, and `STATUS_SERVER.cmd` to control or inspect it.

## Access from other computers

The installer binds the app to localhost. That keeps the login and data private
while the server is first set up. To use it from staff devices, put it behind
HTTPS or a trusted VPN first. Do not change the host to `0.0.0.0` or open port
8765 to the public Internet. Once the HTTPS/VPN endpoint is known, set
`https` to `true` in `C:\Marand\Technologia\administracja\server-settings.json`
when TLS terminates at a reverse proxy, then restart the task.

## GitHub updates

The installer copies `updater.js` outside the program folder and configures it
to stop/restart the Windows scheduled task safely. The update page can install
stable GitHub releases published by the repository workflow. After installing
version 0.2.0, a later version such as `v0.2.1` must be published before the
button can install an update. The private-repository token must remain valid and
have read-only contents access.

The GitHub repository contains code, not production data. Do not commit the
server's `dane` folder, SQLite database, session key, backups, or token.
