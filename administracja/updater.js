'use strict';

// Keep a copy of this file outside program_dir. The app's update button starts
// this process so it remains available while the program directory is replaced.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[++i];
    else out._.push(args[i]);
  }
  return out;
}
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function pidIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function recoverStaleLock(lockPath) {
  let content, stat;
  try {
    stat = fs.statSync(lockPath);
    content = fs.readFileSync(lockPath, 'utf8');
  } catch (error) { return error.code === 'ENOENT'; }
  let owner = null;
  try { owner = JSON.parse(content); } catch {}
  const stale = owner && Number.isSafeInteger(owner.pid)
    ? !pidIsRunning(owner.pid)
    : Date.now() - stat.mtimeMs > 30 * 60 * 1000;
  if (!stale) return false;
  try { if (fs.readFileSync(lockPath, 'utf8') !== content) return false; }
  catch (error) { return error.code === 'ENOENT'; }
  const quarantine = `${lockPath}.${crypto.randomBytes(8).toString('hex')}.stale`;
  try { fs.renameSync(lockPath, quarantine); }
  catch (error) { return error.code === 'ENOENT'; }
  try {
    if (fs.readFileSync(quarantine, 'utf8') !== content) {
      if (!fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath);
      return false;
    }
    fs.unlinkSync(quarantine);
    return true;
  } catch (error) {
    try { if (fs.existsSync(quarantine) && !fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath); } catch {}
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
function acquireUpdateLock(lockPath) {
  const token = crypto.randomBytes(16).toString('hex');
  const contents = JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() });
  let fd;
  try { fd = fs.openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!recoverStaleLock(lockPath)) throw new Error('Trwa inna aktualizacja. Jeśli nie działa żaden aktualizator, sprawdź operations.lock w folderze danych.');
    try { fd = fs.openSync(lockPath, 'wx'); }
    catch (retryError) {
      if (retryError.code === 'EEXIST') throw new Error('Trwa inna aktualizacja. Spróbuj ponownie później.');
      throw retryError;
    }
  }
  try { fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd); }
  catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockPath); } catch {} throw error; }
  fs.closeSync(fd);
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current.token === token) fs.unlinkSync(lockPath);
    } catch {}
  };
}
async function pruneNamedEntries(directory, pattern, keep, kind) {
  try {
    const entries = (await fsp.readdir(directory, { withFileTypes: true }))
      .filter(entry => pattern.test(entry.name) && (kind === 'directory' ? entry.isDirectory() : entry.isFile()))
      .sort((a, b) => {
        const stamp = name => (name.match(/(\d{14})(?:\.sqlite3)?$/) || [])[1] || '';
        return stamp(b.name).localeCompare(stamp(a.name));
      });
    for (const entry of entries.slice(keep)) {
      await fsp.rm(path.join(directory, entry.name), { recursive: kind === 'directory', force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not prune update artifacts in ${directory}: ${error.message}`);
  }
}
async function pruneUpdateArtifacts(config) {
  await pruneNamedEntries(config.releases_dir, /^\d+\.\d+\.\d+-\d{14}$/, 5, 'directory');
  await pruneNamedEntries(config.releases_dir, /^FAILED-\d+\.\d+\.\d+-\d{14}$/, 3, 'directory');
  await pruneNamedEntries(path.join(config.backup_dir, 'przed_aktualizacja'), /^PRE-\d{14}\.sqlite3$/, 10, 'file');
  await pruneNamedEntries(path.join(config.data_dir, 'updates'), /^marand-node-\d+\.\d+\.\d+-[a-f0-9]{12}\.zip$/i, 3, 'file');
}
function versionTuple(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}
function newer(a, b) {
  const left = versionTuple(a), right = versionTuple(b);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
function safeManifestPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/')) return false;
  const parts = name.split('/');
  return parts.every(p => p && p !== '.' && p !== '..');
}
function expandZip(zipPath, destination) {
  if (process.platform !== 'win32') throw new Error('Automatyczny aktualizator wymaga Windows Server.');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MARAND_UPDATE_ZIP -DestinationPath $env:MARAND_UPDATE_DEST -Force'], {
    env: { ...process.env, MARAND_UPDATE_ZIP: zipPath, MARAND_UPDATE_DEST: destination },
    stdio: 'ignore', windowsHide: true, timeout: 120000,
  });
}
function allFiles(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Archiwum zawiera niedozwolone dowiązanie symboliczne.');
    if (entry.isDirectory()) out.push(...allFiles(full));
    else if (entry.isFile()) out.push(full);
    else throw new Error('Archiwum zawiera niedozwolony typ pliku.');
  }
  return out;
}
function verifyPackage(stage, expectedVersion, expectedSha) {
  const zipSha = sha(fs.readFileSync(process.env.MARAND_UPDATE_PACKAGE));
  if (zipSha.toLowerCase() !== String(expectedSha).toLowerCase()) throw new Error('Suma SHA-256 paczki nie jest zgodna.');
  const releasePath = path.join(stage, 'release.json');
  if (!fs.existsSync(releasePath)) throw new Error('Paczka nie zawiera release.json.');
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  if (release.protocol !== 2 || ![1,2].includes(release.schema) || release.version !== expectedVersion || !versionTuple(release.version)) throw new Error('Paczka ma nieobsługiwany protokół, strukturę bazy lub wersję.');
  if (!release.files || typeof release.files !== 'object' || Array.isArray(release.files)) throw new Error('Manifest plików jest nieprawidłowy.');
  for (const [name, digest] of Object.entries(release.files)) {
    if (!safeManifestPath(name) || !/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Manifest zawiera nieprawidłową ścieżkę lub sumę.');
    const target = path.resolve(stage, ...name.split('/'));
    if (!inside(stage, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Brak pliku z manifestu: ${name}`);
    if (sha(fs.readFileSync(target)) !== digest.toLowerCase()) throw new Error(`Niezgodna suma pliku: ${name}`);
  }
  const expected = new Set([...Object.keys(release.files), 'release.json']);
  const actual = new Set(allFiles(stage).map(file => path.relative(stage, file).split(path.sep).join('/')));
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) throw new Error('Archiwum ma pliki spoza manifestu.');
  for (const required of ['server.js', 'views.js', 'manage.js', 'package.json', 'schema.sql', 'modules/archive-cleanup.js', 'static/app.css', 'static/app.js', 'seed/data.json']) {
    if (!Object.hasOwn(release.files, required)) throw new Error(`Manifest nie zawiera pliku programu: ${required}`);
  }
  return release;
}
function powerShellService(config, action, configPath) {
  if (!config.service_name) throw new Error('Brak nazwy usługi w konfiguracji aktualizatora.');
  if (config.service_type === 'scheduled-task') {
    const controller = path.join(path.dirname(configPath), 'control-server.ps1');
    if (!fs.existsSync(controller)) throw new Error('Brak control-server.ps1 obok aktualizatora.');
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', controller,
      '-Action', action, '-ConfigPath', configPath,
    ], { stdio: 'ignore', windowsHide: true, timeout: 90000 });
    return;
  }
  const script = "$ErrorActionPreference='Stop'; $s=Get-Service -Name $env:MARAND_SERVICE_NAME; if ($env:MARAND_SERVICE_ACTION -eq 'stop') { if ($s.Status -ne 'Stopped') { Stop-Service -InputObject $s -ErrorAction Stop; $s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60)) } } else { if ($s.Status -ne 'Running') { Start-Service -InputObject $s -ErrorAction Stop; $s.WaitForStatus('Running',[TimeSpan]::FromSeconds(60)) } }";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MARAND_SERVICE_NAME: config.service_name, MARAND_SERVICE_ACTION: action },
    stdio: 'ignore', windowsHide: true, timeout: 90000,
  });
}
async function backupDatabase(config, filename) {
  const sourcePath = path.join(config.data_dir, 'marand.sqlite3');
  if (!fs.existsSync(sourcePath)) throw new Error('Nie ma bazy do skopiowania.');
  const source = new DatabaseSync(sourcePath, { timeout: 15000, enableForeignKeyConstraints: true });
  try { await backup(source, filename); }
  finally { source.close(); }
  const check = new DatabaseSync(filename, { readOnly: true });
  try {
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Kontrola kopii bazy nie powiodła się.');
  } finally { check.close(); }
}
async function checkHealth(config, version, options = {}) {
  const url = new URL(config.health_url || 'http://127.0.0.1:8765/healthz');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('health_url musi wskazywać lokalny serwer.');
  const expectedTag = sha(Buffer.from(path.resolve(config.data_dir).toLowerCase()));
  const request = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const end = now() + (options.timeoutMs ?? 45000);
  let lastFailure = 'Serwer nie odpowiedział na lokalne sprawdzenie /healthz.';
  while (now() < end) {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(options.requestTimeoutMs ?? 2500) });
      const body = await response.text();
      let result;
      try { result = JSON.parse(body); }
      catch { lastFailure = `Lokalny serwer zwrócił HTTP ${response.status}, ale odpowiedź /healthz nie była prawidłowym JSON-em.`; }
      if (result) {
        if (!response.ok || !result.ok) lastFailure = `Lokalne /healthz zwraca HTTP ${response.status} lub status niezdrowy${result.error?`: ${String(result.error).slice(0,180)}`:'.'}`;
        else if (result.version !== version) lastFailure = `Na porcie aktualizacji działa wersja ${String(result.version || 'nieznana')}, oczekiwano ${version}. Możliwy jest drugi proces programu albo nieudany restart.`;
        else if (result.data_tag !== expectedTag) lastFailure = 'Uruchomiony program wskazuje inny folder danych niż konfiguracja aktualizatora.';
        else return;
      }
    } catch (error) { lastFailure = `Nie można połączyć się z lokalnym /healthz: ${String(error.message || error).slice(0,180)}.`; }
    await sleep(options.pollIntervalMs ?? 1000);
  }
  throw new Error(`Nowa wersja ${version} nie przeszła kontroli uruchomienia. ${lastFailure}`);
}
function rejectSymlinks(directory) { allFiles(directory); }
async function preserveHistoricalSources(program, stage) {
  const oldSources = path.join(program, 'seed', 'sources');
  if (!fs.existsSync(oldSources)) return;
  rejectSymlinks(oldSources);
  for (const file of allFiles(oldSources)) {
    const relative = path.relative(oldSources, file);
    const destination = path.join(stage, 'seed', 'sources', relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
      if (sha(fs.readFileSync(destination)) !== sha(fs.readFileSync(file))) throw new Error(`Próba nadpisania historycznego pliku źródłowego: ${relative}`);
    } else await fsp.copyFile(file, destination);
  }
}
async function update(packagePath, version, expectedSha) {
  if (process.platform !== 'win32') throw new Error('Aktualizacja serwera wymaga Windows.');
  const configPath = process.env.MARAND_UPDATE_CONFIG || path.join(__dirname, 'konfiguracja.json');
  if (!fs.existsSync(configPath)) throw new Error('Brak konfiguracja.json obok aktualizatora.');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const key of ['program_dir', 'data_dir', 'backup_dir', 'releases_dir']) {
    if (!config[key]) throw new Error(`Brak ${key} w konfiguracji.`);
    config[key] = path.resolve(config[key]);
  }
  const updaterPath = path.resolve(__filename);
  if (inside(config.program_dir, updaterPath)) throw new Error('Aktualizator musi działać spoza katalogu programu.');
  if (inside(config.program_dir, config.data_dir) || inside(config.data_dir, config.program_dir)) throw new Error('Folder programu i danych nie mogą być zagnieżdżone.');
  if (!fs.existsSync(path.join(config.program_dir, 'release.json'))) throw new Error('Pierwszą instalację Node.js przygotowuje informatyk.');
  await fsp.mkdir(config.data_dir, { recursive: true });
  if (fs.existsSync(path.join(config.data_dir, 'maintenance.json'))) throw new Error('Jest już aktualizacja w toku albo nieukończona. Sprawdź update_status.json.');
  const oldRelease = JSON.parse(fs.readFileSync(path.join(config.program_dir, 'release.json'), 'utf8'));
  if (!newer(version, oldRelease.version)) throw new Error('Aktualizacja musi mieć wyższą wersję niż zainstalowana.');
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(/[-: ]/g, '');
  const lockPath = path.join(config.data_dir, 'operations.lock');
  const releaseLock = acquireUpdateLock(lockPath);
  let tempRoot = null;
  const previous = path.join(config.releases_dir, `${oldRelease.version}-${stamp}`);
  const backupPath = path.join(config.backup_dir, 'przed_aktualizacja', `PRE-${stamp}.sqlite3`);
  let swapped = false, stopped = false, maintenance = false;
  try {
    tempRoot = await fsp.mkdtemp(path.join(path.dirname(config.program_dir), '.marand-update-'));
    const stage = path.join(tempRoot, 'new');
    await fsp.mkdir(stage, { recursive: true });
    await fsp.mkdir(path.dirname(backupPath), { recursive: true });
    await fsp.mkdir(config.releases_dir, { recursive: true });
    expandZip(packagePath, stage);
    const release = verifyPackage(stage, version, expectedSha);
    const schemaUpgrade = oldRelease.schema === 1 && release.schema === 2;
    if (release.schema !== oldRelease.schema && !schemaUpgrade) throw new Error('Nieobsługiwana migracja struktury bazy.');
    const oldPackage = JSON.parse(fs.readFileSync(path.join(config.program_dir, 'package.json'), 'utf8'));
    const newPackage = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
    if (JSON.stringify(oldPackage.dependencies || {}) !== JSON.stringify(newPackage.dependencies || {})) throw new Error('Zmieniono zależności Node.js. Tę aktualizację musi przygotować informatyk.');
    await preserveHistoricalSources(config.program_dir, stage);
    atomicJson(path.join(config.data_dir, 'maintenance.json'), { since: stamp, target: version }); maintenance = true;
    powerShellService(config, 'stop', configPath); stopped = true;
    await backupDatabase(config, backupPath);
    rejectSymlinks(config.program_dir);
    await fsp.cp(config.program_dir, previous, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const oldWorking = path.join(tempRoot, 'old');
    await fsp.rename(config.program_dir, oldWorking);
    try { await fsp.rename(stage, config.program_dir); }
    catch (error) { await fsp.rename(oldWorking, config.program_dir); throw error; }
    swapped = true;
    powerShellService(config, 'start', configPath); stopped = false;
    await checkHealth(config, version);
    atomicJson(path.join(config.data_dir, 'update_status.json'), { ok: true, version, at: stamp, previous_program: previous, backup: backupPath });
    fs.rmSync(path.join(config.data_dir, 'maintenance.json'), { force: true }); maintenance = false;
    try { fs.rmSync(packagePath, { force: true }); } catch {}
    await pruneUpdateArtifacts(config);
    console.log(`Updated to ${version}`);
  } catch (error) {
    let rollbackError = null;
    try {
      if (swapped) {
        powerShellService(config, 'stop', configPath); stopped = true;
        const failed = path.join(config.releases_dir, `FAILED-${version}-${stamp}`);
        if (fs.existsSync(config.program_dir)) await fsp.rename(config.program_dir, failed);
        await fsp.cp(previous, config.program_dir, { recursive: true, errorOnExist: true, force: false, dereference: false });
        // No user writes were accepted while maintenance was active. Restore
        // the pre-update database for every failed swap, even when release
        // metadata did not announce a schema change.
        const database = path.join(config.data_dir, 'marand.sqlite3');
        await fsp.copyFile(backupPath, database);
        for(const suffix of ['-wal','-shm']) await fsp.rm(database+suffix,{force:true});
      }
      if (stopped || maintenance) {
        powerShellService(config, 'start', configPath);
        stopped = false;
        await checkHealth(config, oldRelease.version);
      }
      if (maintenance) { fs.rmSync(path.join(config.data_dir, 'maintenance.json'), { force: true }); maintenance = false; }
    } catch (restoreError) { rollbackError = restoreError.message; }
    try { atomicJson(path.join(config.data_dir, 'update_status.json'), { ok: false, at: stamp, error: error.message, rollback_error: rollbackError, previous_program: previous, backup: fs.existsSync(backupPath) ? backupPath : null }); } catch {}
    if (inside(path.join(config.data_dir, 'updates'), packagePath)) {
      try { fs.rmSync(packagePath, { force: true }); } catch {}
    }
    await pruneUpdateArtifacts(config);
    if (rollbackError) throw new Error(`Aktualizacja nie powiodła się i nie udało się przywrócić usługi: ${rollbackError}`);
    if (swapped || stopped || maintenance) throw new Error(`Aktualizacja nieudana. Przywrócono poprzedni program. ${error.message}`);
    throw new Error(`Aktualizacja nieudana przed zmianą programu. ${error.message}`);
  } finally {
    if (tempRoot) { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} }
    releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'update' || !args.package || !args.version || !args.sha256) throw new Error('Usage: node updater.js update --package file.zip --version X.Y.Z --sha256 HEX');
  if (!fs.existsSync(args.package)) throw new Error('Nie znaleziono pliku aktualizacji.');
  process.env.MARAND_UPDATE_PACKAGE = path.resolve(args.package);
  await update(path.resolve(args.package), args.version, args.sha256);
}
if (require.main === module) main().catch(error => { console.error(`UPDATE ERROR: ${error.stack || error.message}`); process.exitCode = 1; });

module.exports = { checkHealth };

