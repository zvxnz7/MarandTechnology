'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { DatabaseSync, backup } = require('node:sqlite');
const DatabaseSnapshot = require('./modules/database-snapshot');

const ROOT = __dirname;
const DATA = path.resolve(process.env.MARAND_DATA || path.join(ROOT, 'data'));
const DB_PATH = path.resolve(process.env.MARAND_DATABASE || path.join(DATA, 'marand.sqlite3'));
const ROLES = ['viewer', 'technologist', 'approver', 'admin'];
const nodeVersion = process.versions.node.split('.').map(Number);
if (nodeVersion[0] < 24 || (nodeVersion[0] === 24 && nodeVersion[1] < 15)) throw new Error('Wymagany jest Node.js 24.15 lub nowszy.');

function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function saltString() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(password) {
  const salt = saltString();
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return `scrypt:32768:8:1$${salt}$${hash}`;
}

function prompt(promptText, secret = false) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('Do interaktywnego wpisywania danych uruchom polecenie w terminalu.'));
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const previousRaw = input.isRaw;
    let value = '';
    process.stdout.write(promptText);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
      process.stdout.write('\r\n');
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') return finish(new Error('Przerwano.'));
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) { value = value.slice(0, -1); if (!secret) process.stdout.write('\b \b'); }
          continue;
        }
        if (ch >= ' ') { value += ch; if (!secret) process.stdout.write(ch); }
      }
    };
    input.on('data', onData);
  });
}
async function confirmedPassword(label = 'Hasło (min. 12 znaków): ') {
  for (;;) {
    const first = await prompt(label, true);
    if (first.length < 12) { console.log('Hasło musi mieć co najmniej 12 znaków.'); continue; }
    const second = await prompt('Powtórz hasło: ', true);
    if (first !== second) { console.log('Hasła są różne.'); continue; }
    return first;
  }
}
function connect(file = DB_PATH) {
  const db = new DatabaseSync(file, { timeout: 15000, enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;');
  return db;
}
function addUser(db, login, name, role, password) {
  if (password.length < 12) throw new Error('Hasło musi mieć co najmniej 12 znaków.');
  if (!ROLES.includes(role)) throw new Error(`Nieznana rola: ${role}`);
  db.prepare('INSERT INTO users(login,name,role,password) VALUES(?,?,?,?)').run(login.toLowerCase().trim(), name.trim(), role, hashPassword(password));
}
async function init({ seed = true } = {}) {
  await fsp.mkdir(DATA, { recursive: true });
  const secret = path.join(DATA, 'secret.key');
  try { await fsp.writeFile(secret, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const db = connect();
  try {
    db.exec('PRAGMA journal_mode=WAL;');
    require('./modules/database').migrate(db, DB_PATH);
    const projectCount = db.prepare('SELECT count(*) count FROM projects').get().count;
    if (seed && projectCount === 0) {
      const projects = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'data.json'), 'utf8'));
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const p of projects) {
          const pid = Number(db.prepare('INSERT INTO projects(name,description,conflict,created_at) VALUES(?,?,?,?)').run(p.name, p.description || '', p.conflict || '', now()).lastInsertRowid);
          for (const rec of p.records) {
            const v = rec.data;
            let articleId = null;
            if (rec.kind === 'spec') {
              const symbolKey = String(v.symbol).toUpperCase().replace(/\s/g, '');
              db.prepare('INSERT OR IGNORE INTO articles(project_id,symbol,symbol_key) VALUES(?,?,?)').run(pid, v.symbol, symbolKey);
              articleId = db.prepare('SELECT id FROM articles WHERE project_id=? AND symbol_key=?').get(pid, symbolKey).id;
            }
            const rid = Number(db.prepare('INSERT INTO records(project_id,article_id,kind,symbol,number,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(pid, articleId, rec.kind, v.symbol, v.number || '', JSON.stringify(v), now(), now()).lastInsertRowid);
            db.prepare('INSERT INTO audit(at,action,record_id,detail) VALUES(?,?,?,?)').run(now(), 'Import źródła — do sprawdzenia', rid, JSON.stringify(v.sources || []));
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (!db.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get()) {
      console.log('Utwórz konto administratora. Hasło nie będzie widoczne podczas wpisywania.');
      const login = (await prompt('Login [admin]: ')).trim() || 'admin';
      const name = (await prompt('Imię i nazwisko: ')).trim() || 'Administrator';
      addUser(db, login, name, 'admin', await confirmedPassword());
    }
  } finally { db.close(); }
  console.log('Baza gotowa. Istniejące dane nie zostały zastąpione.');
}
async function addUserCommand(options) {
  if (!options.login || !options.name) throw new Error('Podaj --login i --name.');
  const db = connect();
  try { addUser(db, options.login, options.name, options.role || 'viewer', await confirmedPassword('Hasło nowego użytkownika (min. 12 znaków): ')); }
  finally { db.close(); }
  console.log('Dodano użytkownika.');
}
async function backupCommand(outputPath) {
  if (!outputPath) throw new Error('Podaj --output ścieżka.sqlite3.');
  const output = path.resolve(outputPath);
  const photosOutput = `${output}.photos`;
  if (fs.existsSync(output) || fs.existsSync(photosOutput)) throw new Error('Plik docelowy lub jego folder zdjęć już istnieje. Podaj nową nazwę.');
  if (!fs.existsSync(DB_PATH)) throw new Error('Nie ma bazy do skopiowania.');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const stagingSuffix = `.partial-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const stagedDatabase = `${output}${stagingSuffix}`;
  const stagedPhotos = `${stagedDatabase}.photos`;
  let publishedPhotos = false;
  try {
    const source = connect(DB_PATH);
    try { await backup(source, stagedDatabase); }
    finally { source.close(); }
    const verify = connect(stagedDatabase);
    try {
      const result = verify.prepare('PRAGMA integrity_check').get();
      if (result.integrity_check !== 'ok') throw new Error('Kontrola kopii nie powiodła się.');
    } finally { verify.close(); }
    const snapshot = connect(stagedDatabase);
    try {
      if (snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='photos'").get()) {
        const photos = snapshot.prepare('SELECT file FROM photos').all();
        if (photos.length) {
          await fsp.mkdir(stagedPhotos, { recursive: true });
          for (const row of photos) {
            if (typeof row.file !== 'string' || path.basename(row.file) !== row.file) {
              throw new Error(`Nieprawidłowa ścieżka zdjęcia w bazie: ${String(row.file)}.`);
            }
            const sourcePhoto = path.join(DATA, 'photos', row.file);
            try { await fsp.copyFile(sourcePhoto, path.join(stagedPhotos, row.file)); }
            catch (error) {
              if (error.code === 'ENOENT') throw new Error(`Brakuje pliku zdjęcia "${row.file}" w folderze ${path.join(DATA, 'photos')}.`);
              throw error;
            }
          }
        }
      }
    } finally { snapshot.close(); }
    if (fs.existsSync(stagedPhotos)) {
      await fsp.rename(stagedPhotos, photosOutput);
      publishedPhotos = true;
    }
    await fsp.rename(stagedDatabase, output);
  } catch (error) {
    if (publishedPhotos) await fsp.rm(photosOutput, { recursive: true, force: true });
    throw error;
  } finally {
    await fsp.rm(stagedDatabase, { force: true });
    await fsp.rm(stagedPhotos, { recursive: true, force: true });
  }
  console.log(`Kopia bazy gotowa: ${output}. Zdjęcia (jeśli są): ${photosOutput}`);
}
function verifySnapshotCommand(inputPath, photosPath, absentImportHash = '') {
  if (!inputPath) throw new Error('Podaj --input ścieżka.sqlite3.');
  const info = DatabaseSnapshot.inspectSnapshot(inputPath, photosPath ? { photosPath } : {});
  if (absentImportHash && DatabaseSnapshot.containsImportRun(inputPath, absentImportHash)) {
    throw new Error('Kopia zawiera import, który miał zostać cofnięty. Baza nie została zmieniona.');
  }
  console.log(`Kopia sprawdzona: schemat ${info.schema}, zdjęcia: ${info.photoFiles.length}.`);
}
async function restoreSnapshotCommand(inputPath, rollbackPath, absentImportHash = '') {
  if (!inputPath || !rollbackPath) throw new Error('Podaj --input kopia.sqlite3 oraz --rollback kopia-zabezpieczająca.sqlite3.');
  if (absentImportHash && DatabaseSnapshot.containsImportRun(inputPath, absentImportHash)) {
    throw new Error('Kopia zawiera import, który miał zostać cofnięty. Baza nie została zmieniona.');
  }
  const result = await DatabaseSnapshot.restoreSnapshot({ databasePath: DB_PATH, dataDirectory: DATA, sourcePath: inputPath, rollbackPath });
  console.log(`Przywrócono bazę sprzed importu. Zdjęcia: ${result.photoFiles}. Kopia bezpieczeństwa: ${path.resolve(rollbackPath)}`);
}
function optionsFrom(args) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (['empty'].includes(key)) result[key] = true;
      else result[key] = args[++i];
    } else result._.push(args[i]);
  }
  return result;
}
async function main() {
  const o = optionsFrom(process.argv.slice(2));
  const command = o._[0];
  if (command === 'init') await init({ seed: !o.empty });
  else if (command === 'add-user') await addUserCommand(o);
  else if (command === 'backup') await backupCommand(o.output);
  else if (command === 'verify-snapshot') verifySnapshotCommand(o.input, o.photos, o['absent-import-hash']);
  else if (command === 'restore-snapshot') await restoreSnapshotCommand(o.input, o.rollback, o['absent-import-hash']);
  else if (command === 'run') {
    if (!fs.existsSync(DB_PATH)) throw new Error('Najpierw uruchom node manage.js init.');
    if (o.host) process.env.MARAND_HOST = o.host;
    if (o.port) process.env.MARAND_PORT = o.port;
    require('./server');
  } else {
    console.log('Marand Technologia — polecenia Node.js');
    console.log('  node manage.js init [--empty]');
    console.log('  node manage.js add-user --login LOGIN --name NAZWA [--role viewer|technologist|approver|admin]');
    console.log('  node manage.js backup --output ŚCIEŻKA.sqlite3');
    console.log('  node manage.js verify-snapshot --input kopia.sqlite3 [--photos folder-zdjęć]');
    console.log('  node manage.js restore-snapshot --input kopia.sqlite3 --rollback kopia-bieżącego-stanu.sqlite3');
    console.log('  node manage.js run [--host 127.0.0.1] [--port 8765]');
  }
}

main().catch(error => { console.error(`BŁĄD: ${error.message}`); process.exitCode = 1; });

