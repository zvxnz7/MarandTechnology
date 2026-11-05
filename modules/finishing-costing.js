'use strict';

const crypto=require('node:crypto');
const XlsxReader=require('./xlsx-reader');

const normalizeSymbol=value=>String(value||'').toLocaleLowerCase('pl-PL').replace(/\/([^/]+)\//g,'($1)').replace(/\//g,'(').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'').trim();
const round2=value=>Math.round((Number(value)||0)*100)/100;

function importWorkbook(db,buffer,sourceName,userId,now){
  const digest=crypto.createHash('sha256').update(buffer).digest('hex');
  if(db.prepare('SELECT id FROM finishing_calculation_imports WHERE digest=?').get(digest))throw Object.assign(new Error('Ten plik kalkulacji został już wczytany.'),{status:409});
  const parsed=XlsxReader.readCalculationWorkbook(buffer),insertRun=db.prepare('INSERT INTO finishing_calculation_imports(source_name,digest,imported_at,imported_by,item_count) VALUES(?,?,?,?,?)');
  const insertPrice=db.prepare(`INSERT INTO finishing_calculation_prices(import_id,raw_symbol,raw_symbol_key,article_name,current_price,theoretical_price,current_error,theoretical_error)
    VALUES(?,?,?,?,?,?,?,?)`);
  const run=insertRun.run(String(sourceName||'kalkulacja.xlsx').slice(0,250),digest,now,userId,parsed.rows.length),id=Number(run.lastInsertRowid);
  for(const row of parsed.rows)insertPrice.run(id,row.raw_symbol,row.raw_symbol_key,row.article_name,row.current_price,row.theoretical_price,row.current_error,row.theoretical_error);
  return {id,source_name:String(sourceName||'kalkulacja.xlsx').slice(0,250),item_count:parsed.rows.length,duplicate_count:parsed.duplicateCount,sheet:parsed.sheet,digest};
}
function latestImport(db){return db.prepare('SELECT * FROM finishing_calculation_imports ORDER BY imported_at DESC,id DESC LIMIT 1').get()||null;}
function priceFor(db,importId,rawSymbol){
  if(!importId||!rawSymbol)return null;
  const key=normalizeSymbol(rawSymbol),direct=db.prepare('SELECT * FROM finishing_calculation_prices WHERE import_id=? AND raw_symbol_key=?').get(importId,key);
  if(direct)return direct;
  return db.prepare('SELECT * FROM finishing_calculation_prices WHERE import_id=?').all(importId).find(row=>normalizeSymbol(row.raw_symbol)===key)||null;
}
function batchRecord(db,batchId){
  return db.prepare(`SELECT b.*,o.raw_symbol,o.trade_symbol,o.client_name,o.status order_status,o.order_type,o.shipment_article_id,
      o.source_shipment_no,fp.name finishing_plant_name,s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence
    FROM finishing_batches b JOIN finishing_orders o ON o.id=b.order_id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id
    LEFT JOIN shipments s ON s.id=sa.shipment_id WHERE b.id=?`).get(batchId)||null;
}
function rootBatch(db,batch){
  let current=batch,seen=new Set();
  while(current?.correction_of_batch_id&&!seen.has(Number(current.id))){seen.add(Number(current.id));current=batchRecord(db,current.correction_of_batch_id)||current;if(current.id===batch.id)break;}
  return current;
}
function receiptTotals(db,batchId){
  const row=db.prepare(`SELECT count(*) receipt_count,coalesce(sum(r.finished_pieces),0) finished_pieces,
      coalesce(sum(r.finished_weight_kg),0) finished_weight_kg,coalesce(sum(r.used_weight_kg),0) used_weight_kg,
      coalesce(sum(r.finished_meters),0) finished_meters
    FROM finishing_receipts r WHERE r.batch_id=?`).get(batchId);
  const bales=db.prepare(`SELECT count(*) n,coalesce(sum(meters),0) meters,coalesce(sum(weight_kg),0) weight
    FROM finishing_return_bales rb JOIN finishing_receipts r ON r.id=rb.receipt_id WHERE r.batch_id=?`).get(batchId);
  if(Number(bales.n)>0){row.finished_meters=Number(bales.meters||0);if(Number(bales.weight)>0)row.finished_weight_kg=Number(bales.weight);}
  row.output_unit=Number(row.finished_meters||0)>0?'mb':'kg';
  row.output_quantity=row.output_unit==='mb'?Number(row.finished_meters||0):Number(row.finished_weight_kg||0);
  return row;
}
function getSettlement(db,batchId){return db.prepare('SELECT * FROM finishing_settlements WHERE batch_id=?').get(batchId)||null;}
function calculationContext(db,batchId){
  const batch=batchRecord(db,batchId);if(!batch)return null;
  const root=rootBatch(db,batch),rootReceipt=receiptTotals(db,root.id),output=receiptTotals(db,batch.id),current=latestImport(db),settlement=getSettlement(db,batch.id);
  const priceImportId=settlement?.calculation_import_id??current?.id??null,price=priceFor(db,priceImportId,root.raw_symbol),priceImport=priceImportId?db.prepare('SELECT * FROM finishing_calculation_imports WHERE id=?').get(priceImportId):null;
  return {batch,root,rootReceipt,output,current,price,priceImport,settlement,usedWeight:Number(settlement?.used_weight_kg??rootReceipt.used_weight_kg??0)||Number(root.raw_weight_kg||0)};
}
function settlementRows(db){
  const rows=db.prepare(`SELECT b.id batch_id,b.order_id,b.correction_of_batch_id,b.complaint_status,b.finishing_lot,b.sent_at,b.raw_weight_kg,b.sent_pieces,b.closed_at,
      o.raw_symbol,o.trade_symbol,o.client_name,o.order_type,o.status order_status,o.source_shipment_no,
      fp.name finishing_plant_name,s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence
    FROM finishing_batches b JOIN finishing_orders o ON o.id=b.order_id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id
    LEFT JOIN shipments s ON s.id=sa.shipment_id
    WHERE o.order_type<>'raw_sale' AND o.status<>'cancelled' AND b.closed_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM finishing_receipts r WHERE r.batch_id=b.id)
    ORDER BY o.created_at DESC,o.id DESC,b.id`).all();
  return rows.map(row=>({row,context:calculationContext(db,row.batch_id)}));
}
function comparableHistory(db,tradeSymbol,unit,excludeBatchId,limit=5){
  if(!String(tradeSymbol||'').trim())return [];
  return db.prepare(`SELECT s.*,b.finishing_lot,b.order_id,b.complaint_status,b.correction_of_batch_id,o.raw_symbol,o.trade_symbol,o.source_shipment_no,
      sh.shipment_year,sh.sequence shipment_sequence,sa.sequence article_sequence
    FROM finishing_settlements s JOIN finishing_batches b ON b.id=s.batch_id JOIN finishing_orders o ON o.id=b.order_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id LEFT JOIN shipments sh ON sh.id=sa.shipment_id
    WHERE s.status='settled' AND s.trade_symbol=? AND s.output_unit=? AND s.batch_id<>?
      AND b.complaint_status NOT IN ('reklamowana','poprawiona')
    ORDER BY s.approved_at DESC,s.id DESC LIMIT ?`).all(String(tradeSymbol).trim(),unit,excludeBatchId,limit);
}

module.exports={normalizeSymbol,round2,importWorkbook,latestImport,priceFor,batchRecord,rootBatch,receiptTotals,getSettlement,calculationContext,settlementRows,comparableHistory};
