'use strict';
const fs = require('node:fs');
const path = require('node:path');
const STARTER_ARTICLES = ['M3550', 'PTWZ', 'WT56-21'];

function ensureStarterArticles(db) {
  const insert = db.prepare(`INSERT INTO articles(symbol,symbol_key,created_at,updated_at)
    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM articles WHERE symbol_key=?)`);
  const linked = db.prepare(`SELECT a.id article_id,pa.project_id FROM articles a
    JOIN project_articles pa ON pa.article_id=a.id WHERE a.symbol_key=?`);
  const unlink = db.prepare('DELETE FROM project_articles WHERE project_id=? AND article_id=?');
  const legacyLinks = db.prepare('SELECT id,project_id FROM articles WHERE symbol_key=? AND project_id IS NOT NULL');
  const clearLegacyLink = db.prepare('UPDATE articles SET project_id=NULL,updated_at=? WHERE id=?');
  const audit = db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)');
  const timestamp = new Date().toISOString();
  for (const symbol of STARTER_ARTICLES) {
    const key = symbol.toUpperCase().replace(/\s/g, '');
    insert.run(symbol, key, timestamp, timestamp, key);
    for (const row of linked.all(key)) {
      unlink.run(row.project_id, row.article_id);
      audit.run(timestamp, 'Migracja: odpięto artykuł od projektu', `${symbol} · artykuł #${row.article_id} · projekt #${row.project_id}`);
    }
    for (const row of legacyLinks.all(key)) {
      clearLegacyLink.run(timestamp, row.id);
      audit.run(timestamp, 'Migracja: odpięto artykuł od projektu', `${symbol} · artykuł #${row.id} · projekt #${row.project_id}`);
    }
  }
}
// All schema changes are transactional. The original database is snapshotted
// before changing legacy tables; IDs, approved payloads and issued HTML survive.
function migrate(db, dbPath) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const legacy = db.prepare('PRAGMA table_info(articles)').all();
  if (!legacy.length) { db.exec(schema); ensureStarterArticles(db); return; }
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>3)throw new Error('Baza pochodzi z nowszej wersji programu.');
  if(version===3) { db.exec(schema); ensureStarterArticles(db); return; }
  if (dbPath) {
    const backup = `${dbPath}.before-schema2-${Date.now()}.sqlite3`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    if (!legacy.some(c => c.name === 'category_id')) {
      for (const table of ['articles', 'records']) {
        const create = schema.split('\n').find(line => line.startsWith(`CREATE TABLE IF NOT EXISTS ${table}(`));
        db.exec(create.replace(`IF NOT EXISTS ${table}(`, `${table}_next(`));
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',');
        db.exec(`INSERT INTO ${table}_next(${cols}) SELECT ${cols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_next RENAME TO ${table};`);
      }
    }
    const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
    if (!projectColumns.some(c => c.name === 'archived_at')) db.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
    const recordColumns = db.prepare('PRAGMA table_info(records)').all();
    if (!recordColumns.some(c => c.name === 'archived_at')) db.exec('ALTER TABLE records ADD COLUMN archived_at TEXT');
    db.exec(schema);
    db.exec('CREATE INDEX IF NOT EXISTS projects_archived ON projects(archived_at,id); CREATE INDEX IF NOT EXISTS records_archived ON records(archived_at,id); PRAGMA user_version=3;');
    db.exec(`INSERT OR IGNORE INTO project_articles SELECT project_id,id FROM articles WHERE project_id IS NOT NULL;
      UPDATE articles SET created_at=coalesce((SELECT min(created_at) FROM records WHERE article_id=articles.id),(SELECT created_at FROM projects WHERE id=articles.project_id),strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE created_at='';
      UPDATE articles SET updated_at=coalesce((SELECT max(updated_at) FROM records WHERE article_id=articles.id),created_at) WHERE updated_at='';`);
    ensureStarterArticles(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migracja: niespójne powiązania danych. Cofnięto zmiany.');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
module.exports = { migrate };
