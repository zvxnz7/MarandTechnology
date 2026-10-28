'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const Database = require('../modules/database');
const Production = require('../modules/production');

const schema=fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(schema);
  Database.migrate(db);
  db.prepare("INSERT INTO users(login,name,password,role) VALUES('admin','Admin','x','admin')").run();
  Production.initialize(db);
  const articleId=Number(db.prepare('INSERT INTO articles(project_id,symbol,symbol_key) VALUES(NULL,?,?)').run('WT 56-21 (5)','WT56-21(5)').lastInsertRowid);
  const token=crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO production_sync_token(id,token_hash,created_at) VALUES(1,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),new Date().toISOString());
  const helpers={
    todayWarsaw:()=> '2026-10-28',
    now:()=> '2026-10-28T06:15:00.000Z',
    transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
    makeArticle(){throw new Error('Fixture article should already exist.');},
    audit(){},
  };
  const bale=(id,production_date,number)=>({
    id,symbol:'WT 56-21 (5)',machine:'M1',number,production_date,
    weight_kg:10,meters:100,errors:0,stops:0,workers:[],created_at:'2026-10-28T06:10:00.000Z'
  });
  return {db,token,helpers,bale};
}

test('production upload snapshots use production days and move when a bale date is corrected',()=>{
  const f=fixture();
  try{
    const id=crypto.randomUUID();
    Production.receiveUpload(f.db,`Bearer ${f.token}`,{bales:[
      f.bale(id,'2026-10-27','M1/1'),
      f.bale(crypto.randomUUID(),'2026-10-28','M1/2'),
    ]},f.helpers);
    let days=f.db.prepare('SELECT snapshot_date,pieces,weight_kg FROM production_stock_snapshots ORDER BY snapshot_date').all();
    assert.deepEqual(days.map(row=>[row.snapshot_date,row.pieces,row.weight_kg]),[
      ['2026-10-27',1,10],['2026-10-28',1,10]
    ]);

    f.db.prepare('INSERT INTO production_stock_snapshots(snapshot_date,article_id,pieces,weight_kg,uploaded_at) VALUES(?,?,?,?,?)')
      .run('2026-10-26',f.db.prepare('SELECT id FROM articles WHERE symbol=?').get('WT 56-21 (5)').id,2,20,'2026-10-28T06:15:00.000Z');
    Production.initialize(f.db);
    days=f.db.prepare('SELECT snapshot_date,pieces,weight_kg FROM production_stock_snapshots ORDER BY snapshot_date').all();
    assert.deepEqual(days.map(row=>[row.snapshot_date,row.pieces,row.weight_kg]),[
      ['2026-10-27',1,10],['2026-10-28',1,10]
    ]);

    Production.receiveUpload(f.db,`Bearer ${f.token}`,{bales:[f.bale(id,'2026-10-28','M1/1')]},f.helpers);
    days=f.db.prepare('SELECT snapshot_date,pieces,weight_kg FROM production_stock_snapshots ORDER BY snapshot_date').all();
    assert.deepEqual(days.map(row=>[row.snapshot_date,row.pieces,row.weight_kg]),[
      ['2026-10-28',2,20]
    ]);
  }finally{f.db.close();}
});

test('stan bieżący pokazuje pięć dni roboczych ze stanem narastającym po przyjęciach i wysyłkach',async()=>{
  const f=fixture();
  try{
    const Warehouse=require('../modules/warehouse');
    Warehouse.initialize(f.db);
    const shippedId=crypto.randomUUID(), receivedId=crypto.randomUUID();
    Production.receiveUpload(f.db,`Bearer ${f.token}`,{bales:[
      f.bale(shippedId,'2026-10-22','M1/1'),
      f.bale(receivedId,'2026-10-28','M1/2'),
    ]},f.helpers);
    const articleId=f.db.prepare('SELECT id FROM articles WHERE symbol=?').get('WT 56-21 (5)').id;
    const shipmentId=Number(f.db.prepare(`INSERT INTO shipments(shipment_year,sequence,status,shipment_date,created_at)
      VALUES(2026,1,'closed','2026-10-27','2026-10-27T10:00:00.000Z')`).run().lastInsertRowid);
    const shipmentArticleId=Number(f.db.prepare(`INSERT INTO shipment_articles(shipment_id,article_id,sequence,closed_snapshot)
      VALUES(?,?,1,'')`).run(shipmentId,articleId).lastInsertRowid);
    f.db.prepare('INSERT INTO shipment_bales(shipment_article_id,bale_local_id,added_at) VALUES(?,?,?)')
      .run(shipmentArticleId,shippedId,'2026-10-27T09:00:00.000Z');
    f.db.prepare('DELETE FROM production_stock_snapshots').run();
    const response=await Production.handle({
      req:{method:'GET',user:{id:1,name:'Admin',role:'admin'},session:{csrf:'csrf'}},
      p:'/production',db:f.db,url:new URL('http://localhost/production'),getFlashes:()=>[],
      now:f.helpers.now,
      send(_req,_res,status,body){return {status,body};}
    });
    assert.equal(response.status,200);
    for(const date of ['2026-10-22','2026-10-23','2026-10-26','2026-10-27','2026-10-28']) assert.match(response.body,new RegExp(`data-stock-date="${date}"`));
    assert.match(response.body,/data-stock-date="2026-10-22" data-pieces="1"/);
    assert.match(response.body,/data-stock-date="2026-10-23" data-pieces="1"/);
    assert.match(response.body,/data-stock-date="2026-10-26" data-pieces="1"/);
    assert.match(response.body,/data-stock-date="2026-10-27" data-pieces="0"/);
    assert.match(response.body,/data-stock-date="2026-10-28" data-pieces="1"/);
    assert.match(response.body,/data-stock-date="2026-10-27" data-weight-kg="0"/);
    assert.match(response.body,/data-stock-date="2026-10-28" data-weight-kg="10/);
    assert.match(response.body,/Łączna waga: 10,00 kg/);
    assert.doesNotMatch(response.body,/Aktualne sztuki|Aktualna waga/);
    assert.doesNotMatch(response.body,/Brak artykułów z niezerowym stanem/);
  }finally{f.db.close();}
});
