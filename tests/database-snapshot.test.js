'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const Database = require('../modules/database');
const Snapshot = require('../modules/database-snapshot');
const SourceImport = require('../modules/source-import');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marand-restore-test-'));
  const data = path.join(root, 'data');
  const photos = path.join(data, 'photos');
  fs.mkdirSync(photos, { recursive: true });
  return { root, data, photos, databasePath: path.join(data, 'marand.sqlite3') };
}

function initializeDatabase(databasePath, symbol, photoName, photoContents) {
  const db = new DatabaseSync(databasePath);
  Database.migrate(db, databasePath);
  const stamp = new Date().toISOString();
  const userId = Number(db.prepare('INSERT INTO users(login,name,password,role) VALUES(?,?,?,?)').run('admin', 'Test Admin', 'test-password-hash', 'admin').lastInsertRowid);
  const articleId = Number(db.prepare('INSERT INTO articles(symbol,symbol_key,created_at,updated_at) VALUES(?,?,?,?)').run(symbol, symbol.toUpperCase(), stamp, stamp).lastInsertRowid);
  fs.writeFileSync(path.join(path.dirname(databasePath), 'photos', photoName), photoContents);
  db.prepare('INSERT INTO photos(article_id,file,created_at,created_by) VALUES(?,?,?,?)').run(articleId, photoName, stamp, userId);
  db.close();
  return articleId;
}

function copySnapshot(sourceDatabase, destinationDatabase, photoDirectory) {
  fs.copyFileSync(sourceDatabase, destinationDatabase);
  const db = new DatabaseSync(destinationDatabase, { readOnly: true });
  try {
    const files = db.prepare('SELECT file FROM photos').all().map(row => row.file);
    if (files.length) {
      const destinationPhotos = `${destinationDatabase}.photos`;
      fs.mkdirSync(destinationPhotos, { recursive: true });
      for (const file of files) fs.copyFileSync(path.join(photoDirectory, file), path.join(destinationPhotos, file));
    }
  } finally { db.close(); }
}

test('restores the verified pre-import database and photos, preserving a rollback snapshot', async () => {
  const f = fixture();
  try {
    initializeDatabase(f.databasePath, 'BEFORE-IMPORT', 'before.jpg', 'original photo');
    const beforeImport = path.join(f.root, 'before-import.sqlite3');
    copySnapshot(f.databasePath, beforeImport, f.photos);

    let db = new DatabaseSync(f.databasePath);
    const stamp = new Date().toISOString();
    db.prepare('UPDATE articles SET symbol=?,symbol_key=?,updated_at=?').run('AFTER-IMPORT', 'AFTER-IMPORT', stamp);
    db.prepare('INSERT INTO articles(symbol,symbol_key,created_at,updated_at) VALUES(?,?,?,?)').run('NEW-IMPORT-ARTICLE', 'NEW-IMPORT-ARTICLE', stamp, stamp);
    db.prepare('UPDATE photos SET file=?').run('after.jpg');
    db.close();
    fs.rmSync(path.join(f.photos, 'before.jpg'));
    fs.writeFileSync(path.join(f.photos, 'after.jpg'), 'imported photo');

    const rollback = path.join(f.root, 'current-before-restore.sqlite3');
    copySnapshot(f.databasePath, rollback, f.photos);
    const brokenSnapshot = path.join(f.root, 'broken.sqlite3');
    fs.writeFileSync(brokenSnapshot, crypto.randomBytes(80));
    await assert.rejects(
      Snapshot.restoreSnapshot({ databasePath: f.databasePath, dataDirectory: f.data, sourcePath: brokenSnapshot, rollbackPath: rollback }),
    );
    db = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT symbol FROM articles ORDER BY id DESC LIMIT 1').get().symbol, 'NEW-IMPORT-ARTICLE');
    db.close();

    const restored = await Snapshot.restoreSnapshot({ databasePath: f.databasePath, dataDirectory: f.data, sourcePath: beforeImport, rollbackPath: rollback });
    assert.equal(restored.photoFiles, 1);
    assert.equal(fs.readFileSync(path.join(f.photos, 'before.jpg'), 'utf8'), 'original photo');
    assert.equal(fs.existsSync(path.join(f.photos, 'after.jpg')), false);
    db = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.deepEqual(db.prepare('SELECT symbol FROM articles WHERE symbol_key NOT IN (?,?,?) ORDER BY symbol').all('M3550', 'PTWZ', 'WT56-21').map(row => row.symbol), ['BEFORE-IMPORT']);
    assert.equal(db.prepare('SELECT file FROM photos').get().file, 'before.jpg');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();

    const rollbackDb = new DatabaseSync(rollback, { readOnly: true });
    assert.equal(rollbackDb.prepare("SELECT count(*) n FROM articles WHERE symbol='NEW-IMPORT-ARTICLE'").get().n, 1);
    rollbackDb.close();
    assert.equal(Snapshot.inspectSnapshot(f.databasePath, { photosPath: f.photos }).photoFiles.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a snapshot whose referenced photo is missing before touching the live database', async () => {
  const f = fixture();
  try {
    initializeDatabase(f.databasePath, 'LIVE-ARTICLE', 'live.jpg', 'live photo');
    const rollback = path.join(f.root, 'rollback.sqlite3');
    copySnapshot(f.databasePath, rollback, f.photos);
    const broken = path.join(f.root, 'broken-photo.sqlite3');
    copySnapshot(f.databasePath, broken, f.photos);
    fs.rmSync(path.join(`${broken}.photos`, 'live.jpg'));
    await assert.rejects(
      Snapshot.restoreSnapshot({ databasePath: f.databasePath, dataDirectory: f.data, sourcePath: broken, rollbackPath: rollback }),
      /brakuje poprawnego pliku zdjęcia/i,
    );
    const db = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT symbol FROM articles WHERE symbol_key=?').get('LIVE-ARTICLE').symbol, 'LIVE-ARTICLE');
    db.close();
    assert.equal(fs.readFileSync(path.join(f.photos, 'live.jpg'), 'utf8'), 'live photo');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('restores the exact pre-import state after a source package has been imported', async () => {
  const f = fixture();
  let db = null;
  try {
    initializeDatabase(f.databasePath, 'EXISTING-ARTICLE', 'existing.jpg', 'existing photo');
    const beforeImport = path.join(f.root, 'before-import.sqlite3');
    copySnapshot(f.databasePath, beforeImport, f.photos);

    const packageData = {
      format: 'marand-application-import-v1',
      target_schema_user_version: 9,
      notice: 'UWAGA WYGENEROWANO PRZEZ AI — sprawdź dane ze starym katalogiem „Nowe warunki dziania”.',
      articles: [{ article_key: 'article-smoke', symbol: 'IMPORTED-SMOKE', symbol_key: 'IMPORTED-SMOKE', description: 'Imported test article' }],
      specifications: [{ source_key: 'spec-smoke', article_key: 'article-smoke', kind: 'spec', state: 'draft', payload: { symbol: 'IMPORTED-SMOKE' } }],
      projects: [{
        source_key: 'project-smoke', name: 'Imported test trial', trial_number: '1/2026', created_at: '2026-10-23',
        stage: { stage_no: 1, stage_date: '2026-10-23', article_keys: ['article-smoke'] }, records: [], comments: [],
      }],
    };
    const pkg = SourceImport.readPackageBuffer(Buffer.from(JSON.stringify(packageData)));
    db = new DatabaseSync(f.databasePath);
    const preview = SourceImport.preview(db, pkg);
    assert.deepEqual(preview.conflicts, []);
    const imported = SourceImport.importData(db, pkg, beforeImport);
    assert.equal(imported.imported.articles, 1);
    assert.equal(imported.imported.specifications, 1);
    assert.equal(SourceImport.latestImportRun(db).package_hash, pkg.digest);
    db.close();
    db = null;

    const rollback = path.join(f.root, 'before-restore.sqlite3');
    copySnapshot(f.databasePath, rollback, f.photos);
    assert.equal(Snapshot.containsImportRun(rollback, pkg.digest), true);
    fs.rmSync(path.join(f.photos, 'existing.jpg'));
    fs.writeFileSync(path.join(f.photos, 'interrupted.jpg'), 'partial restore');
    Snapshot.restorePhotosFromSnapshot(f.data, rollback);
    assert.equal(fs.readFileSync(path.join(f.photos, 'existing.jpg'), 'utf8'), 'existing photo');
    assert.equal(fs.existsSync(path.join(f.photos, 'interrupted.jpg')), false);
    await Snapshot.restoreSnapshot({ databasePath: f.databasePath, dataDirectory: f.data, sourcePath: beforeImport, rollbackPath: rollback });

    db = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) n FROM articles').get().n, 4);
    assert.equal(db.prepare('SELECT count(*) n FROM articles WHERE symbol=?').get('EXISTING-ARTICLE').n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM articles WHERE symbol=?').get('IMPORTED-SMOKE').n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
    db = null;
    assert.equal(Snapshot.containsImportRun(f.databasePath, pkg.digest), false);
    assert.equal(fs.readFileSync(path.join(f.photos, 'existing.jpg'), 'utf8'), 'existing photo');

    const rollbackDb = new DatabaseSync(rollback, { readOnly: true });
    assert.equal(rollbackDb.prepare("SELECT count(*) n FROM articles WHERE symbol='IMPORTED-SMOKE'").get().n, 1);
    rollbackDb.close();
  } finally {
    if (db) { try { db.close(); } catch {} }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
