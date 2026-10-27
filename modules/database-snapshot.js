'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const REQUIRED_TABLES = ['users', 'projects', 'articles', 'records', 'cards', 'audit', 'photos'];

function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function safePhotoName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
    && path.basename(name) === name;
}

function inspectSnapshot(snapshotPath, options = {}) {
  const fullPath = path.resolve(snapshotPath);
  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Kopia bazy nie jest zwykłym plikiem.');

  const db = new DatabaseSync(fullPath, { readOnly: true, enableForeignKeyConstraints: true });
  let photoFiles, version;
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Kopia bazy nie przeszła kontroli integralności SQLite.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Kopia bazy zawiera nieprawidłowe powiązania.');

    version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (![9, 10, 11].includes(version)) throw new Error(`Kopia wymaga nieobsługiwanego schematu bazy (${version}).`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const missing = REQUIRED_TABLES.filter(name => !tables.has(name));
    if (missing.length) throw new Error(`W kopii brakuje wymaganych tabel: ${missing.join(', ')}.`);

    photoFiles = db.prepare('SELECT file FROM photos ORDER BY file').all().map(row => row.file);
    const names = new Set();
    for (const name of photoFiles) {
      if (!safePhotoName(name) || names.has(name.toLowerCase())) throw new Error('Kopia bazy zawiera nieprawidłową lub powtórzoną nazwę zdjęcia.');
      names.add(name.toLowerCase());
    }
  } finally { db.close(); }

  const photosPath = path.resolve(options.photosPath || `${fullPath}.photos`);
  let photoDirectory = null;
  if (exists(photosPath)) {
    const photosStat = fs.lstatSync(photosPath);
    if (!photosStat.isDirectory() || photosStat.isSymbolicLink()) throw new Error('Folder zdjęć kopii ma nieprawidłowy format.');
    photoDirectory = photosPath;
  }
  if (photoFiles.length && !photoDirectory) throw new Error('Kopia bazy zawiera zdjęcia, ale brakuje ich folderu w kopii.');
  if (photoDirectory) {
    for (const name of photoFiles) {
      const filePath = path.join(photoDirectory, name);
      let fileStat;
      try { fileStat = fs.lstatSync(filePath); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Brakuje poprawnego pliku zdjęcia w kopii: ${name}.`);
        throw error;
      }
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Brakuje poprawnego pliku zdjęcia w kopii: ${name}.`);
    }
  }
  return { path: fullPath, photosPath: photoDirectory, photoFiles, schema: version };
}

async function copySnapshotPhotos(snapshotInfo, destination) {
  for (const name of snapshotInfo.photoFiles) {
    await fsp.copyFile(path.join(snapshotInfo.photosPath, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
}

async function installSnapshotPhotos(snapshotInfo, photosDirectory, dataRoot, restoreId) {
  const stagedPhotos = path.join(dataRoot, `.photos-restore-${restoreId}`);
  try {
    await fsp.mkdir(stagedPhotos, { recursive: true });
    await copySnapshotPhotos(snapshotInfo, stagedPhotos);
    inspectSnapshot(snapshotInfo.path, { photosPath: stagedPhotos });

    if (exists(photosDirectory)) {
      const stat = fs.lstatSync(photosDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bieżący folder zdjęć ma nieprawidłowy format.');
    } else {
      await fsp.mkdir(photosDirectory, { recursive: true });
    }
    const wanted = new Set(snapshotInfo.photoFiles.map(name => name.toLowerCase()));
    for (const name of snapshotInfo.photoFiles) {
      await fsp.copyFile(path.join(stagedPhotos, name), path.join(photosDirectory, name));
    }
    for (const entry of await fsp.readdir(photosDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Bieżący folder zdjęć zawiera niedozwolony element.');
      if (!wanted.has(entry.name.toLowerCase())) await fsp.rm(path.join(photosDirectory, entry.name), { force: true });
    }
    inspectSnapshot(snapshotInfo.path, { photosPath: photosDirectory });
    return { photoFiles: snapshotInfo.photoFiles.length };
  } finally {
    await fsp.rm(stagedPhotos, { recursive: true, force: true });
  }
}

async function replaceDatabaseFromSnapshot(snapshotPath, databasePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) await fsp.rm(`${databasePath}${suffix}`, { force: true });
  const sourceDb = new DatabaseSync(snapshotPath, { readOnly: true, enableForeignKeyConstraints: true });
  try { await backup(sourceDb, databasePath); }
  finally { sourceDb.close(); }
}

async function restoreSnapshot({ databasePath, dataDirectory, sourcePath, rollbackPath }) {
  const liveDatabase = path.resolve(databasePath);
  const dataRoot = path.resolve(dataDirectory);
  const source = path.resolve(sourcePath);
  const rollback = path.resolve(rollbackPath);
  if (source === liveDatabase || rollback === liveDatabase || source === rollback) throw new Error('Ścieżki kopii i bazy bieżącej muszą być różne.');
  if (!exists(liveDatabase)) throw new Error('Nie znaleziono bieżącej bazy do zabezpieczenia.');

  const sourceInfo = inspectSnapshot(source);
  const rollbackInfo = inspectSnapshot(rollback);
  const photosDirectory = path.join(dataRoot, 'photos');
  const restoreId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  let databaseTouched = false;

  try {
    await fsp.mkdir(dataRoot, { recursive: true });
    await installSnapshotPhotos(sourceInfo, photosDirectory, dataRoot, restoreId);

    databaseTouched = true;
    await replaceDatabaseFromSnapshot(source, liveDatabase);
    inspectSnapshot(liveDatabase, { photosPath: photosDirectory });

    return { restored: source, rollback: rollback, photoFiles: sourceInfo.photoFiles.length };
  } catch (error) {
    let rollbackError = null;
    try {
      if (databaseTouched) await replaceDatabaseFromSnapshot(rollback, liveDatabase);
      await installSnapshotPhotos(rollbackInfo, photosDirectory, dataRoot, `${restoreId}-rollback`);
      inspectSnapshot(liveDatabase, { photosPath: photosDirectory });
    } catch (restoreError) { rollbackError = restoreError; }
    if (rollbackError) throw new Error(`Przywracanie przerwano: ${error.message} Nie udało się odtworzyć poprzedniego stanu: ${rollbackError.message}`);
    throw new Error(`Przywracanie przerwano; poprzednia baza została zachowana. ${error.message}`);
  }
}

function restorePhotosFromSnapshot(dataDirectory, snapshotPath) {
  const dataRoot = path.resolve(dataDirectory);
  const photosDirectory = path.join(dataRoot, 'photos');
  const repairId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const stagedPhotos = path.join(dataRoot, `.photos-repair-${repairId}`);
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(stagedPhotos, { recursive: true });
    const info = inspectSnapshot(snapshotPath);
    for (const name of info.photoFiles) {
      const source = path.join(info.photosPath, name);
      const target = path.join(stagedPhotos, name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
    inspectSnapshot(snapshotPath, { photosPath: stagedPhotos });

    if (exists(photosDirectory)) {
      const stat = fs.lstatSync(photosDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bieżący folder zdjęć ma nieprawidłowy format.');
    } else {
      fs.mkdirSync(photosDirectory, { recursive: true });
    }
    const wanted = new Set(info.photoFiles.map(name => name.toLowerCase()));
    for (const name of info.photoFiles) fs.copyFileSync(path.join(stagedPhotos, name), path.join(photosDirectory, name));
    for (const entry of fs.readdirSync(photosDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Bieżący folder zdjęć zawiera niedozwolony element.');
      if (!wanted.has(entry.name.toLowerCase())) fs.rmSync(path.join(photosDirectory, entry.name), { force: true });
    }
    inspectSnapshot(snapshotPath, { photosPath: photosDirectory });
    return { photoFiles: info.photoFiles.length };
  } finally {
    fs.rmSync(stagedPhotos, { recursive: true, force: true });
  }
}

function containsImportRun(snapshotPath, packageHash) {
  const db = new DatabaseSync(path.resolve(snapshotPath), { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='marand_source_import_runs'").get();
    return exists ? Boolean(db.prepare('SELECT 1 FROM marand_source_import_runs WHERE package_hash=?').get(packageHash)) : false;
  } finally { db.close(); }
}

module.exports = { inspectSnapshot, restoreSnapshot, restorePhotosFromSnapshot, containsImportRun };
