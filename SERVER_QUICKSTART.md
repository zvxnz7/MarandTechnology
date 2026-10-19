# Put Marand on a Windows Server

This is the one-time setup for the public GitHub repository `zvxnz7/MarandTechnology`.
The installer creates a background Windows scheduled task, keeps the database
outside the replaceable program folder, schedules daily database backups, and
configures the app's GitHub release updater.

## One-time setup

1. On the server, open the latest GitHub release and download the
   `marand-node-release.zip` asset (not GitHub's automatically generated
   `Source code` archive). Extract it to a local drive. This release asset
   contains both the installer and the runtime files.
2. Open that folder and double-click `INSTALL_SERVER.cmd`. Approve the Windows
   administrator prompt. The installer will use `winget` to install/update Node.js
   LTS if needed; it requires Node.js 24.15 or newer. If `winget` is unavailable,
   install Node.js LTS manually, then run the installer again.
3. To import an existing SQLite database, enter the path to its `marand.sqlite3`
   when asked. Keep `secret.key` beside that database if you want existing user
   sessions to keep the same signing key. Press Enter to create a new database;
   this skips importing any database or photos found in the extracted folder.
4. At the first-run prompt, create the app administrator login and password.
5. The repository is public, so no GitHub token is needed during setup. If the
   repository is made private later, use `administracja\SET_GITHUB_TOKEN.cmd`.

The app is installed under `C:\Marand\Technologia`. Its database and session key
are in `dane`, the updater and protected settings are in `administracja`, and
backups go to `D:\Kopie\Marand-Technologia` when D: exists (otherwise to
`C:\Marand\Technologia\kopie`). A verified backup is created during setup and
then daily at 22:00.

The web app starts in the background at Windows startup. On the server itself,
open <http://127.0.0.1:8765>. The installer also prints one or more LAN addresses;
on another computer connected to the same local subnet, open
`http://SERVER-LAN-IP:8765` (replace `SERVER-LAN-IP` with the address it printed).
Use `administracja\STOP_SERVER.cmd`, `START_SERVER.cmd`, and
`STATUS_SERVER.cmd` to control or inspect it.

## Access from other computers

The app listens on the server's network interfaces. The installer adds a Windows
Firewall rule for TCP 8765 that applies only to the **Private** or authenticated
**Domain** network profile and devices on the **local subnet**. If another
computer cannot connect, check that Windows classifies the server's LAN
connection as Private or Domain, then confirm the address with `ipconfig`. Do
not create a router port-forward for 8765 or expose
this HTTP service to the Internet. HTTP does not encrypt passwords or session
cookies on the network; use this only on a trusted LAN. For remote access, use a
VPN or an HTTPS reverse proxy.

## If saving fails

Keep the form open so you can copy your changes. On the server, open
`C:\Marand\Technologia\administracja\logs` and inspect the newest
`server-*.err.log`. It records the SQLite error code and message needed to
diagnose a failure against the server's existing database.

## GitHub updates

The installer copies `updater.js` outside the program folder and configures it
to stop/restart the Windows scheduled task safely. GitHub Actions publishes a
stable release automatically after each push to `main`. Once the action
finishes, an administrator can open **Aktualizacje GitHub** in the app and
install the newer version. You can also run
`C:\Marand\Technologia\administracja\AKTUALIZUJ.cmd`; it fetches the latest
release package from GitHub, verifies GitHub's SHA-256 digest, and installs it
using the same rollback-capable updater. Windows asks for administrator access;
the updater preserves the database. No token is needed while the repository is
public.

Fresh installs start with an empty project list. Existing database contents are
kept when updating or reinstalling the program. The current source tree and new
release packages omit customer records and original source documents. Earlier Git
commits or published releases may still contain them. Do not commit the server's
`dane` folder, SQLite database, session key, backups, or token.
