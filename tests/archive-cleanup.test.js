'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { purgeExpired, RETENTION_MS } = require('../modules/archive-cleanup');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  db.prepare('INSERT INTO users(id,login,name,password,role) VALUES(1,?,?,?,?)').run('user', 'Test User', 'x', 'admin');
  db.prepare('INSERT INTO projects(id,name,created_at) VALUES(1,?,?)').run('Project', '2026-01-01T00:00:00Z');
  const photosDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'marand-archive-photos-'));
  const insertArticle = db.prepare('INSERT INTO articles(symbol,symbol_key,created_at,updated_at) VALUES(?,?,?,?)');
  const article = symbol => Number(insertArticle.run(symbol, symbol, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z').lastInsertRowid);
  const insertRecord = db.prepare(`INSERT INTO records(project_id,article_id,kind,symbol,state,payload,created_at,updated_at,archived_at,base_id)
    VALUES(1,?,'spec',?,'draft','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?,?)`);
  const record = (symbol, articleId, archivedAt, baseId = null) => Number(insertRecord.run(articleId, symbol, archivedAt, baseId).lastInsertRowid);
  const addPhoto = (kind, id, file) => {
    fs.writeFileSync(path.join(photosDirectory, file), 'photo');
    db.prepare(`INSERT INTO photos(${kind === 'article' ? 'article_id' : 'record_id'},file,created_at,created_by) VALUES(?,?,?,1)`)
      .run(id, file, '2026-01-01T00:00:00Z');
  };
  return { db, photosDirectory, article, record, addPhoto };
}

test('purges expired drafts and their own photos while retaining articles, article photos and child drafts', () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-19T00:00:00Z');
    const expiredAt = new Date(now - RETENTION_MS - 1000).toISOString();
    const recentAt = new Date(now - RETENTION_MS + 1000).toISOString();
    const articleId = f.article('A');
    const expiredId = f.record('A', articleId, expiredAt);
    const childId = f.record('A child', articleId, null, expiredId);
    const recentId = f.record('A recent', articleId, recentAt);
    f.addPhoto('record', expiredId, 'draft.jpg');
    f.addPhoto('article', articleId, 'article.jpg');

    assert.equal(purgeExpired(f.db, f.photosDirectory, { now }), 1);
    assert.equal(f.db.prepare('SELECT id FROM records WHERE id=?').get(expiredId), undefined);
    assert.equal(f.db.prepare('SELECT base_id FROM records WHERE id=?').get(childId).base_id, null);
    assert.ok(f.db.prepare('SELECT id FROM records WHERE id=?').get(recentId));
    assert.equal(f.db.prepare('SELECT id FROM photos WHERE record_id=?').get(expiredId), undefined);
    assert.ok(f.db.prepare('SELECT id FROM photos WHERE article_id=?').get(articleId));
    assert.equal(fs.existsSync(path.join(f.photosDirectory, 'draft.jpg')), false);
    assert.equal(fs.existsSync(path.join(f.photosDirectory, 'article.jpg')), true);
    assert.ok(f.db.prepare('SELECT id FROM articles WHERE id=?').get(articleId));
  } finally {
    f.db.close();
    fs.rmSync(f.photosDirectory, { recursive: true, force: true });
  }
});

test('does not purge a draft linked to an issued card or active technology', () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-19T00:00:00Z');
    const expiredAt = new Date(now - RETENTION_MS - 1000).toISOString();
    const cardArticle = f.article('CARD');
    const cardRecord = f.record('CARD', cardArticle, expiredAt);
    f.db.prepare('INSERT INTO cards(record_id,machine,instructions,created_at,created_by,token,snapshot,html) VALUES(?,?,?,?,?,?,?,?)')
      .run(cardRecord, 'M5', '', '2026-01-01T00:00:00Z', 1, 'token', '{}', 'issued');
    const activeArticle = f.article('ACTIVE');
    const activeRecord = f.record('ACTIVE', activeArticle, expiredAt);
    f.db.prepare('UPDATE articles SET active_spec=? WHERE id=?').run(activeRecord, activeArticle);
    const historyArticle = f.article('HISTORY');
    const historicalBase = f.record('HISTORY base', historyArticle, expiredAt);
    const approvedChild = f.record('HISTORY approved', historyArticle, null, historicalBase);
    f.db.prepare("UPDATE records SET state='approved' WHERE id=?").run(approvedChild);

    assert.equal(purgeExpired(f.db, f.photosDirectory, { now }), 0);
    assert.ok(f.db.prepare('SELECT id FROM records WHERE id=?').get(cardRecord));
    assert.ok(f.db.prepare('SELECT id FROM records WHERE id=?').get(activeRecord));
    assert.ok(f.db.prepare('SELECT id FROM records WHERE id=?').get(historicalBase));
    assert.ok(f.db.prepare('SELECT id FROM records WHERE id=?').get(approvedChild));
  } finally {
    f.db.close();
    fs.rmSync(f.photosDirectory, { recursive: true, force: true });
  }
});
