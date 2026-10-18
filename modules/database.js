'use strict';
const fs = require('node:fs');
const path = require('node:path');
// All schema changes are transactional. The original database is snapshotted
// before changing legacy tables; IDs, approved payloads and issued HTML survive.
function migrate(db, dbPath) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const legacy = db.prepare('PRAGMA table_info(articles)').all();
  if (!legacy.length) { db.exec(schema); seedCategories(db); return; }
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>2)throw new Error('Baza pochodzi z nowszej wersji programu.');
  if(version===2)return;
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
    db.exec(schema);
    db.exec(`INSERT OR IGNORE INTO project_articles SELECT project_id,id FROM articles WHERE project_id IS NOT NULL;
      UPDATE articles SET created_at=coalesce((SELECT min(created_at) FROM records WHERE article_id=articles.id),(SELECT created_at FROM projects WHERE id=articles.project_id),strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE created_at='';
      UPDATE articles SET updated_at=coalesce((SELECT max(updated_at) FROM records WHERE article_id=articles.id),created_at) WHERE updated_at='';`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migracja: niespójne powiązania danych. Cofnięto zmiany.');
    seedCategories(db);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
function seedCategories(db) {
  const groups = {
    Poliamid: ['Ażury','Dzianina elastyczna','Hafty','Inne','Lamówka','Lureks','Markizeta','Małociągliwa','Szermeza','Szyfon','Tiul','Trykot','Welur'],
    Poliester: ['Ażury','Barkówka','DBT','Dzianina elastyczna','Dzianina gładka','Fartuchowa','Flagowa','Lamówka','Markizeta','Małociągliwa','Nośnikowa','Pętelkowe','Szermeza','Szyfon','Tiul','Trykot','Welur'],
    'Dzianiny dystansowe': [],
  };
  for (const [name, children] of Object.entries(groups)) {
    db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(name);
    const pid=db.prepare('SELECT id FROM categories WHERE parent_id IS NULL AND name=?').get(name).id;
    for(const child of children) db.prepare('INSERT OR IGNORE INTO categories(parent_id,name) VALUES(?,?)').run(pid,child);
  }
}
module.exports = { migrate };
