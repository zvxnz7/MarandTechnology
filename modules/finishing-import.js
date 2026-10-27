'use strict';

const crypto=require('node:crypto');

const FORMAT='marand-finishing-import-v1';
const MAX_PACKAGE_BYTES=25*1024*1024;
const validKey=value=>typeof value==='string'&&value.trim().length>0&&value.length<=250;
const text=(value,max=3000)=>String(value??'').trim().slice(0,max);
const finite=(value,label,{integerOnly=false,allowZero=true}={})=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  if(!Number.isFinite(n)||(integerOnly&&!Number.isInteger(n))||(allowZero?n<0:n<=0))throw new Error(`${label}: nieprawidłowa wartość.`);
  return n;
};
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&Number.isFinite(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
const keyNorm=value=>String(value||'').toLowerCase().replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'');

function validate(data){
  if(!data||data.format!==FORMAT)throw new Error('To nie jest paczka wykańczania Marand.');
  if(Number(data.target_schema_user_version)!==11)throw new Error('Paczka wykańczania wymaga schematu aplikacji 11.');
  if(!Array.isArray(data.periods)||!data.periods.length||data.periods.some(period=>!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period))||new Set(data.periods).size!==data.periods.length)throw new Error('Paczka musi podawać unikalne okresy w formacie RRRR-MM.');
  if(!Array.isArray(data.recipes)||!Array.isArray(data.orders)||(!data.recipes.length&&!data.orders.length))throw new Error('Paczka powinna zawierać receptury lub zlecenia wykończenia.');
  const recipeKeys=new Set(),orderKeys=new Set(),allKeys=new Set();
  const addKey=(key,kind)=>{if(!validKey(key))throw new Error(`${kind}: brakuje prawidłowego source_key.`);if(allKeys.has(key))throw new Error(`Powtórzony source_key w paczce: ${key}.`);allKeys.add(key);};
  for(const recipe of data.recipes){addKey(recipe.source_key,'Receptura');if(!text(recipe.name,200)||!text(recipe.recipe_text,12000))throw new Error(`Receptura ${recipe.source_key}: nazwa i treść są wymagane.`);recipeKeys.add(recipe.source_key);finite(recipe.target_width_cm,'Szerokość');finite(recipe.target_grammage,'Gramatura');}
  for(const order of data.orders){
    addKey(order.source_key,'Zlecenie');orderKeys.add(order.source_key);
    if(!text(order.raw_symbol,200))throw new Error(`Zlecenie ${order.source_key}: brakuje symbolu dzianiny surowej.`);
    if(!data.periods.includes(String(order.period)))throw new Error(`Zlecenie ${order.source_key}: okres nie znajduje się na liście okresów paczki.`);
    if(order.source_shipment_date&&!date(order.source_shipment_date))throw new Error(`Zlecenie ${order.source_key}: data wysyłki musi mieć format RRRR-MM-DD.`);
    if(order.recipe_source_key&&!recipeKeys.has(order.recipe_source_key))throw new Error(`Zlecenie ${order.source_key}: receptura ${order.recipe_source_key} nie występuje w paczce.`);
    if(!['draft','sent','partial','received','raw_sale','cancelled'].includes(order.status||'sent'))throw new Error(`Zlecenie ${order.source_key}: nieznany status.`);
    finite(order.target_width_cm,'Szerokość');finite(order.target_grammage,'Gramatura');
    if(!Array.isArray(order.batches))throw new Error(`Zlecenie ${order.source_key}: batches musi być listą.`);
    for(const batch of order.batches){
      addKey(batch.source_key,'Partia');
      if(!date(batch.sent_at))throw new Error(`Partia ${batch.source_key}: data wyjścia musi mieć format RRRR-MM-DD.`);
      finite(batch.sent_pieces,`Partia ${batch.source_key}, wysłane sztuki`,{integerOnly:true,allowZero:true});finite(batch.raw_weight_kg,`Partia ${batch.source_key}, masa`);
      if(!Array.isArray(batch.receipts||[]))throw new Error(`Partia ${batch.source_key}: receipts musi być listą.`);
      for(const receipt of (batch.receipts||[])){
        addKey(receipt.source_key,'Przyjęcie');if(!date(receipt.received_at))throw new Error(`Przyjęcie ${receipt.source_key}: data musi mieć format RRRR-MM-DD.`);
        finite(receipt.raw_pieces_received,`Przyjęcie ${receipt.source_key}, odebrane sztuki`,{integerOnly:true});
        finite(receipt.finished_pieces,`Przyjęcie ${receipt.source_key}, gotowe belki`,{integerOnly:true});
        finite(receipt.finished_weight_kg,`Przyjęcie ${receipt.source_key}, kg`);finite(receipt.finished_meters,`Przyjęcie ${receipt.source_key}, metry`);
        if(!Array.isArray(receipt.returned_bales||[]))throw new Error(`Przyjęcie ${receipt.source_key}: returned_bales musi być listą.`);
        for(const [index,bale] of (receipt.returned_bales||[]).entries()){
          finite(bale.meters,`Przyjęcie ${receipt.source_key}, metry belki ${index+1}`,{allowZero:false});
          finite(bale.weight_kg,`Przyjęcie ${receipt.source_key}, kg belki ${index+1}`,{allowZero:false});
        }
      }
    }
  }
  return data;
}

function readPackageBuffer(bytes,sourceName='paczka wykańczania'){
  const buffer=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  if(buffer.length>MAX_PACKAGE_BYTES)throw new Error('Paczka wykańczania przekracza limit 25 MB.');
  let data;try{data=JSON.parse(buffer.toString('utf8'));}catch{throw new Error('Nie można odczytać JSON paczki wykańczania.');}
  validate(data);
  return {data,digest:crypto.createHash('sha256').update(buffer).digest('hex'),sourceName:text(sourceName,250)};
}

function preview(db,pkg){
  validate(pkg.data);
  const periods=pkg.data.periods.slice().sort(),runs=db.prepare('SELECT period,digest FROM finishing_import_runs').all();
  const already=Boolean(db.prepare('SELECT 1 FROM finishing_import_runs WHERE digest=?').get(pkg.digest))
    ||Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='marand_source_import_runs'").get()&&db.prepare('SELECT 1 FROM marand_source_import_runs WHERE package_hash=?').get(pkg.digest));
  const overlaps=runs.filter(run=>run.period.split(',').some(period=>periods.includes(period)));
  const conflicts=[];
  if(already)conflicts.push({message:'Ta paczka została już wcześniej zaimportowana.'});
  for(const run of overlaps)if(run.digest!==pkg.digest)conflicts.push({message:`Okres ${run.period.split(',').filter(period=>periods.includes(period)).join(', ')} ma już wcześniejszy import. Najpierw przywróć bazę sprzed tamtego importu.`});
  return {
    package_type:'finishing',package_sha256:pkg.digest,periods,
    existing:{finishing_recipes:Number(db.prepare('SELECT count(*) n FROM finishing_recipes').get().n),finishing_orders:Number(db.prepare('SELECT count(*) n FROM finishing_orders').get().n),finishing_batches:Number(db.prepare('SELECT count(*) n FROM finishing_batches').get().n),finishing_receipts:Number(db.prepare('SELECT count(*) n FROM finishing_receipts').get().n)},
    incoming:{finishing_recipes:pkg.data.recipes.length,finishing_orders:pkg.data.orders.length,finishing_batches:pkg.data.orders.reduce((n,order)=>n+order.batches.length,0),finishing_receipts:pkg.data.orders.reduce((n,order)=>n+order.batches.reduce((k,batch)=>k+(batch.receipts||[]).length,0),0),returned_bales:pkg.data.orders.reduce((n,order)=>n+order.batches.reduce((k,batch)=>k+(batch.receipts||[]).reduce((j,receipt)=>j+(receipt.returned_bales||[]).length,0),0),0)},
    will_archive:{active_projects:0,unapproved_records_without_issued_cards:0,unmatched_articles:0},
    preserved:['artykuły i kartoteka','projekty oraz specyfikacje','istniejące zlecenia i receptury wykończenia','koszty — nie są importowane'],
    conflicts,ai_notice:'Paczka zawiera dane historyczne/testowe. Import tworzy osobne zlecenia bez wiązania zwróconych belek z konkretnymi belkami surowymi. Wartości kosztów są pomijane.',
  };
}

function ensureSharedRuns(db){db.exec(`CREATE TABLE IF NOT EXISTS marand_source_import_runs(package_hash TEXT PRIMARY KEY,imported_at TEXT NOT NULL,backup_path TEXT NOT NULL,result_json TEXT NOT NULL);`);}
function plantId(db,name,userId,stamp){
  const clean=text(name,200);if(!clean)return null;
  const key=keyNorm(clean),found=db.prepare('SELECT id FROM finishing_plants WHERE name_key=?').get(key);if(found)return Number(found.id);
  return Number(db.prepare('INSERT INTO finishing_plants(name,name_key,active,created_at,created_by) VALUES(?,?,1,?,?)').run(clean,key,stamp,userId).lastInsertRowid);
}
function importData(db,pkg,backupPath,{userId,now,audit}){
  const report=preview(db,pkg);if(report.conflicts.length)throw new Error(report.conflicts.map(item=>item.message).join(' '));
  const stamp=now(),recipeIds=new Map();db.exec('BEGIN IMMEDIATE');
  try{
    ensureSharedRuns(db);
    const lockedReport=preview(db,pkg);if(lockedReport.conflicts.length)throw new Error(lockedReport.conflicts.map(item=>item.message).join(' '));
    const insertRecipe=db.prepare(`INSERT INTO finishing_recipes(name,finishing_plant_id,raw_symbol,recipe_text,target_color,target_stiffening,target_width_cm,target_grammage,notes,active,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?)`);
    for(const recipe of pkg.data.recipes){
      const id=Number(insertRecipe.run(text(recipe.name,200),plantId(db,recipe.finishing_plant_name,userId,stamp),text(recipe.raw_symbol,200),text(recipe.recipe_text,12000),text(recipe.target_color,160),text(recipe.target_stiffening,160),finite(recipe.target_width_cm,'Szerokość'),finite(recipe.target_grammage,'Gramatura'),text(recipe.notes,3000),stamp,userId,stamp,userId).lastInsertRowid);
      recipeIds.set(recipe.source_key,id);
    }
    const insertOrder=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_id,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,notes,status,created_at,created_by,updated_at,updated_by) VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertBatch=db.prepare(`INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,closed_at,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertReceipt=db.prepare(`INSERT INTO finishing_receipts(batch_id,received_at,raw_pieces_received,finished_pieces,finished_weight_kg,finished_meters,actual_color,actual_stiffening,actual_width_cm,actual_grammage,rubbing_status,notes,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertBale=db.prepare('INSERT INTO finishing_return_bales(receipt_id,sequence,meters,weight_kg) VALUES(?,?,?,?)');
    const imported={finishing_recipes:recipeIds.size,finishing_orders:0,finishing_batches:0,finishing_receipts:0,returned_bales:0};
    for(const order of pkg.data.orders){
      const recipeId=recipeIds.get(order.recipe_source_key)||null;
      let snapshot=order.recipe_snapshot||{};if(recipeId){const source=pkg.data.recipes.find(item=>item.source_key===order.recipe_source_key);snapshot={name:source.name,finishingPlant:source.finishing_plant_name||'',rawSymbol:source.raw_symbol||'',recipeText:source.recipe_text||'',targetColor:source.target_color||'',targetStiffening:source.target_stiffening||'',targetWidthCm:source.target_width_cm??'',targetGrammage:source.target_grammage??'',notes:source.notes||''};}
      const status=order.status||'sent';
      const id=Number(insertOrder.run(plantId(db,order.finishing_plant_name,userId,stamp),text(order.source_shipment_no,120),order.source_shipment_date||'',text(order.raw_symbol,200),text(order.client_name,200),text(order.trade_symbol,200),recipeId,JSON.stringify(snapshot),text(order.target_color,160),text(order.target_stiffening,160),finite(order.target_width_cm,'Szerokość'),finite(order.target_grammage,'Gramatura'),text(order.notes,3000),status,stamp,userId,stamp,userId).lastInsertRowid);
      imported.finishing_orders++;
      for(const batch of order.batches){
        const closeBatch=Boolean(batch.closed||status==='received');
        const batchId=Number(insertBatch.run(id,text(batch.finishing_lot,120),batch.sent_at,finite(batch.sent_pieces,'Wysłane sztuki',{integerOnly:true}),finite(batch.raw_weight_kg,'Wysłana masa'),text(batch.yarn_lot,250),closeBatch?(batch.closed_at||stamp):null,text(batch.notes,3000),stamp,userId,stamp,userId).lastInsertRowid);imported.finishing_batches++;
        for(const receipt of (batch.receipts||[])){
          const bales=receipt.returned_bales||[];const baleMeters=bales.reduce((sum,bale)=>sum+Number(bale.meters),0);
          const meters=receipt.finished_meters===undefined?baleMeters:finite(receipt.finished_meters,'Metry odebrane');
          const finishedPieces=receipt.finished_pieces===undefined?(bales.length||0):finite(receipt.finished_pieces,'Odebrane belki',{integerOnly:true});
          const receiptId=Number(insertReceipt.run(batchId,receipt.received_at,finite(receipt.raw_pieces_received,'Odebrane sztuki',{integerOnly:true})??0,finishedPieces,finite(receipt.finished_weight_kg,'Odebrana masa')??0,meters??0,text(receipt.actual_color,160),text(receipt.actual_stiffening,160),finite(receipt.actual_width_cm,'Szerokość faktyczna'),finite(receipt.actual_grammage,'Gramatura faktyczna'),['ok','not_ok'].includes(receipt.rubbing_status)?receipt.rubbing_status:'',text(receipt.notes,3000),stamp,userId).lastInsertRowid);imported.finishing_receipts++;
          bales.forEach((bale,index)=>insertBale.run(receiptId,index+1,Number(bale.meters),Number(bale.weight_kg)));imported.returned_bales+=bales.length;
        }
      }
      if(!order.batches.length&&status==='received')db.prepare('UPDATE finishing_orders SET status=\'received\' WHERE id=?').run(id);
      audit({id:userId},'Zaimportowano zlecenie wykończenia',null,JSON.stringify({orderId:id,sourceKey:order.source_key,packageHash:pkg.digest}),null);
    }
    const period=pkg.data.periods.slice().sort().join(','),result={status:'import wykańczania zakończony',package_sha256:pkg.digest,backup:backupPath,periods:pkg.data.periods,imported};
    db.prepare('INSERT INTO finishing_import_runs(period,digest,source_name,imported_count,imported_at,imported_by) VALUES(?,?,?,?,?,?)').run(period,pkg.digest,text(pkg.data.source_name||pkg.sourceName,250),imported.finishing_orders,stamp,userId);
    db.prepare('INSERT INTO marand_source_import_runs(package_hash,imported_at,backup_path,result_json) VALUES(?,?,?,?)').run(pkg.digest,stamp,backupPath,JSON.stringify(result));
    db.exec('COMMIT');return result;
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}

module.exports={readPackageBuffer,preview,importData,format:FORMAT};
