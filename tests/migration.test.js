'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');const {execFileSync}=require('node:child_process');const {migrate}=require('../modules/database');
test('migration preserves approved records, cards, IDs and links, and is idempotent',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marand-migration-'));const file=path.join(dir,'db.sqlite3');const db=new DatabaseSync(file);
 try {
  const schema=fs.readFileSync(path.join(__dirname,'fixtures','schema-v1.sql'),'utf8');db.exec(schema);
  db.exec(`INSERT INTO users(id,login,name,password,role) VALUES(1,'x','x','x','admin');INSERT INTO projects(id,name,created_at) VALUES(8,'Old','2020-01-01');INSERT INTO articles(id,project_id,symbol,symbol_key,active_spec) VALUES(12,8,'M','M',25);INSERT INTO records(id,project_id,article_id,kind,symbol,state,payload,created_at,updated_at,version) VALUES(25,8,12,'spec','M','approved','{"gb":[]}', '2020-01-02','2021-01-01',1);INSERT INTO cards(id,record_id,machine,instructions,created_at,created_by,token,snapshot,html) VALUES(4,25,'1','x','2021-01-02',1,'token','{}','EXACT ORIGINAL HTML');`);
  db.prepare('INSERT INTO audit(at,action,record_id,detail) VALUES(?,?,?,?)').run('2021-01-02','Zapisano zmiany',25,'legacy edit');
  const before=db.prepare('SELECT * FROM records').get();migrate(db,file);
  const stageId=db.prepare('SELECT id FROM project_stages WHERE project_id=8').get().id;
  db.prepare('UPDATE project_stages SET comment=?,updated_at=? WHERE id=?').run('Zachować wcześniejszy komentarz etapu','2021-02-03T12:00:00Z',stageId);
  db.exec('PRAGMA user_version=8;');migrate(db,file);migrate(db,file);
  assert.deepEqual({...db.prepare('SELECT * FROM records').get()},{...before,archived_at:null});assert.equal(db.prepare('SELECT html FROM cards').get().html,'EXACT ORIGINAL HTML');
  assert.equal(db.prepare('SELECT article_id FROM project_articles WHERE project_id=8').get().article_id,12);assert.equal(db.prepare('SELECT created_at FROM articles').get().created_at,'2020-01-02');
  assert.equal(db.prepare('SELECT article_id FROM audit_articles WHERE audit_id=(SELECT id FROM audit WHERE record_id=25)').get().article_id,12);assert.equal(db.prepare('SELECT trial_number FROM projects WHERE id=8').get().trial_number,'1/2020');assert.equal(db.prepare('SELECT stage_no FROM project_stages WHERE project_id=8').get().stage_no,1);assert.equal(db.prepare('SELECT comment FROM project_stages WHERE id=?').get(stageId).comment,'');assert.equal(db.prepare('SELECT content FROM project_stage_comments WHERE stage_id=?').get(stageId).content,'Zachować wcześniejszy komentarz etapu');assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);assert.throws(()=>db.exec('DELETE FROM records WHERE id=25'),/immutable/);
  assert.equal(fs.readdirSync(dir).filter(n=>n.includes('before-schema2')).length,1);
  const original=new DatabaseSync(path.join(dir,fs.readdirSync(dir).find(n=>n.includes('before-schema2'))));assert.equal(original.prepare('PRAGMA user_version').get().user_version,0);original.close();
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
