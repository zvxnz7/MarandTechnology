'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const Database = require('../modules/database');
const Production = require('../modules/production');
const Warehouse = require('../modules/warehouse');

const schema=fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8');
function fixture(baleCount=3){
  const db=new DatabaseSync(':memory:');
  db.exec(schema);
  Database.migrate(db);
  db.prepare("INSERT INTO users(login,name,password,role) VALUES('admin','Admin','x','admin')").run();
  Production.initialize(db);Warehouse.initialize(db);
  const articleId=Number(db.prepare('INSERT INTO articles(project_id,symbol,symbol_key) VALUES(NULL,?,?)').run('TEST-KNIT','TEST-KNIT').lastInsertRowid);
  const insertBale=db.prepare(`INSERT INTO production_bales(local_id,article_id,article_symbol,machine,bale_number,production_date,weight_kg,meters,errors,stops,needs_check,lot,notes,workers_json,local_created_at,uploaded_at)
    VALUES(?,?,?,'M1',?,'2026-10-26',100,120,0,0,0,'L1','','[]',?,?)`);
  const stamp=new Date().toISOString();
  for(let i=1;i<=baleCount;i++){const id=`bale-${i}`;insertBale.run(id,articleId,'TEST-KNIT',id,stamp,stamp);}
  const ctx=(method,p,form={},search='')=>({req:{method,user:{id:1,name:'Admin',role:'admin'},session:{csrf:'csrf'},headers:{}},res:{},p,db,form,url:new URL(`http://localhost${p}${search}`),send(_req,_res,status,body){return {status,body};},redirect(_req,_res,location,message){return {location,message};},role(user,...roles){if(!roles.includes(user.role))throw Object.assign(new Error('Forbidden'),{status:403});},transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},now:()=>stamp,todayWarsaw:()=> '2026-10-26',getFlashes:()=>[],audit(){}});
  return {db,articleId,ctx};
}
function createShipment(f){return Warehouse.handle(f.ctx('POST','/shipments/create'));}
function addBales(f,shipmentId,baleIds,specificationId='',finishingPlantId='1'){
  const plants=f.db.prepare('SELECT id FROM finishing_plants WHERE active=1 ORDER BY id').all();
  const plant=finishingPlantId||plants[0]?.id;
  return Warehouse.handle(f.ctx('POST',`/shipments/${shipmentId}/add`,{article_id:String(f.articleId),bale_ids:baleIds.join(','),finishing_plant_id:String(plant),shipment_article_id:String(specificationId)}));
}

test('robocza wysyłka ma osobne potwierdzenie usunięcia i zwalnia belki',()=>{
  const f=fixture();
  try{
    const created=createShipment(f),id=Number(created.location.split('/').pop());
    addBales(f,id,['bale-1']);
    const historicalAuditId=Number(f.db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)').run(new Date().toISOString(),'Utworzono roboczą wysyłkę',JSON.stringify({shipmentId:id})).lastInsertRowid);
    const confirm=Warehouse.handle(f.ctx('GET',`/shipments/${id}/delete`));
    assert.match(confirm.body,/całkowicie usunie roboczą wysyłkę/);
    assert.throws(()=>Warehouse.handle(f.ctx('POST',`/shipments/${id}/delete`)),{status:400});
    Warehouse.handle(f.ctx('POST',`/shipments/${id}/delete`,{confirm_delete:'1'}));
    assert.equal(f.db.prepare('SELECT 1 FROM shipments WHERE id=?').get(id),undefined);
    assert.ok(f.db.prepare('SELECT id FROM audit WHERE id=?').get(historicalAuditId));
    assert.ok(f.db.prepare("SELECT local_id FROM production_bales WHERE local_id='bale-1'").get());
    const next=createShipment(f);
    assert.equal(next.location,`/shipments/${id}`);
  }finally{f.db.close();}
});

test('inicjalizacja zachowuje anulowane wysyłki i niezmienny rejestr audytu',()=>{
  const f=fixture();
  try{
    const created=createShipment(f),id=Number(created.location.split('/').pop());
    f.db.prepare("UPDATE shipments SET status='cancelled' WHERE id=?").run(id);
    const auditId=Number(f.db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)').run(new Date().toISOString(),'Anulowano wysyłkę',JSON.stringify({shipmentId:id})).lastInsertRowid);
    assert.doesNotThrow(()=>Warehouse.initialize(f.db));
    assert.equal(f.db.prepare('SELECT status FROM shipments WHERE id=?').get(id).status,'cancelled');
    assert.ok(f.db.prepare('SELECT id FROM audit WHERE id=?').get(auditId));
  }finally{f.db.close();}
});

test('anulowanie wymaga osobnego potwierdzenia i czyści roboczy WZ',()=>{
  const f=fixture();
  try{
    const created=createShipment(f),id=Number(created.location.split('/').pop());
    addBales(f,id,['bale-1']);
    const confirm=Warehouse.handle(f.ctx('GET',`/shipments/${id}/cancel`));
    assert.match(confirm.body,/Potwierdź anulowanie/);
    assert.throws(()=>Warehouse.handle(f.ctx('POST',`/shipments/${id}/cancel`)),{status:400});
    Warehouse.handle(f.ctx('POST',`/shipments/${id}/cancel`,{confirm_cancel:'1'}));
    assert.equal(f.db.prepare('SELECT 1 FROM shipments WHERE id=?').get(id),undefined);
    assert.equal(f.db.prepare("SELECT count(*) n FROM shipment_bales WHERE bale_local_id='bale-1'").get().n,0);
  }finally{f.db.close();}
});

test('do istniejącej specyfikacji można dopisywać belki, a jedna belka nie trafia do dwóch specyfikacji',()=>{
  const f=fixture();
  try{
    const created=createShipment(f),id=Number(created.location.split('/').pop());
    addBales(f,id,['bale-1']);
    let spec=f.db.prepare('SELECT id FROM shipment_articles WHERE shipment_id=?').get(id).id;
    addBales(f,id,['bale-2'],spec);
    assert.equal(f.db.prepare('SELECT count(*) n FROM shipment_bales WHERE shipment_article_id=? AND removed_at IS NULL').get(spec).n,2);
    assert.throws(()=>addBales(f,id,['bale-1']),{status:409});
    addBales(f,id,['bale-3'],'','2');
    assert.equal(f.db.prepare('SELECT count(*) n FROM shipment_articles WHERE shipment_id=?').get(id).n,2);
    const plants=f.db.prepare('SELECT finishing_plant_id FROM shipment_articles WHERE shipment_id=? ORDER BY sequence').all(id);
    assert.deepEqual(plants.map(row=>row.finishing_plant_id),[1,2]);
    const page=Warehouse.handle(f.ctx('GET',`/shipments/${id}`));
    assert.match(page.body,/Dodaj kolejne belki/);
    assert.match(page.body,/TEST-KNIT/);
  }finally{f.db.close();}
});

test('przycisk dodawania pozostaje w środkowym, sticky panelu przy 200 belkach',()=>{
  const f=fixture(200);
  try{
    const created=createShipment(f),id=Number(created.location.split('/').pop());
    const page=Warehouse.handle(f.ctx('GET',`/shipments/${id}/select`,{},`?article_id=${f.articleId}`));
    assert.equal((page.body.match(/<input type="checkbox" value="bale-/g)||[]).length,200);
    assert.match(page.body,/shipment-picker-controls/);
    assert.match(fs.readFileSync(path.join(__dirname,'..','static','app.css'),'utf8'),/shipment-picker-controls\{position:sticky/);
  }finally{f.db.close();}
});

test('biblioteki pokazują wykończalnie, dziewiarzy, artykuły i przyszły słownik wykończeń',()=>{
  const f=fixture();
  try{
    const page=Warehouse.handle(f.ctx('GET','/settings/libraries'));
    for(const label of ['Wykończalnie','Anfarb','MarkoColor','Femina','Sagan','Dziewiarze','Wykończenia','bibliotekę artykułów'])assert.match(page.body,new RegExp(label,'i'));
    const created=Warehouse.handle(f.ctx('POST','/settings/libraries/workers',{name:'Jan Kowalski',code:'JK'}));
    assert.equal(created.location,'/settings/libraries');
    const worker=f.db.prepare('SELECT employee_uid FROM knitting_workers WHERE name=?').get('Jan Kowalski');
    assert.match(worker.employee_uid,/^[0-9a-f-]{36}$/i);
  }finally{f.db.close();}
});

test('WZ drukuje belki i wykończalnię, bez parametrów technologii wykończenia',()=>{
  const f=fixture();
  try{
    const created=createShipment(f),id=Number(created.location.split('/').pop());
    addBales(f,id,['bale-1']);
    const item=f.db.prepare('SELECT id FROM shipment_articles WHERE shipment_id=?').get(id);
    f.db.prepare('UPDATE shipments SET status=\'closed\' WHERE id=?').run(id);
    const page=Warehouse.handle(f.ctx('GET',`/shipments/${id}/wz/${item.id}`));
    assert.match(page.body,/Wykończalnia \/ odbiorca:<\/b> Anfarb/);
    assert.match(page.body,/TEST-KNIT/);
    assert.doesNotMatch(page.body,/Dane technologiczne artykułu|docelowa/);
  }finally{f.db.close();}
});

test('centralny katalog udostępnia tylko zatwierdzoną, bieżącą technologię',()=>{
  const f=fixture();
  try{
    const approved=Number(f.db.prepare('INSERT INTO records(article_id,kind,symbol,state,payload,created_at,updated_at,approved_at) VALUES(?,\'spec\',?,\'approved\',\'{}\',?,?,?)').run(f.articleId,'TEST-KNIT','now','now','now').lastInsertRowid);
    f.db.prepare('UPDATE articles SET active_spec=? WHERE id=?').run(approved,f.articleId);
    f.db.prepare("INSERT INTO knitting_workers(employee_uid,code,name,created_at,updated_at) VALUES(?,?,?,?,?)").run(crypto.randomUUID(),'TK','Test Knitter','now','now');
    const token='a'.repeat(64);
    f.db.prepare('INSERT INTO production_sync_token(id,token_hash,created_at) VALUES(1,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),'now');
    assert.throws(()=>Production.catalogPayload(f.db,'Bearer '+'b'.repeat(64)),{status:401});
    const result=Production.catalogPayload(f.db,`Bearer ${token}`);
    assert.deepEqual(result.articles.map(row=>row.id),[f.articleId]);
    assert.equal(result.workers[0].code,'TK');
  }finally{f.db.close();}
});
