'use strict';

const V = require('../views');
const Costing = require('./finishing-costing');
const LabelRenderer = require('../static/finishing-label-renderer');

const editableRoles = ['admin','approver','technologist'];
const hidden = (name,value) => `<input type="hidden" name="${V.esc(name)}" value="${V.esc(value)}">`;
const text = (form,key,max=500) => String(form[key]||'').trim().slice(0,max);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const number = value => {
  const raw=String(value??'').trim().replace(',','.');
  if(!raw)return null;
  const n=Number(raw);
  return Number.isFinite(n)?n:null;
};
const integer = value => {
  const n=number(value);
  return Number.isInteger(n)?n:null;
};
const money = value => Number(value||0).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2});
const qty = value => Number(value||0).toLocaleString('pl-PL',{maximumFractionDigits:2});
const dateOnlyPl = value => String(V.datepl(value)||'—').split(',')[0];
const normalizeSearch = value => String(value||'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'');
const RECIPE_NOTES_FORMAT='marand-finishing-notes-v1';
const RECIPE_NOTES_SIZES=[14,16,18,20,24,28];
const migratedRecipeTradeSymbolDbs=new WeakSet();
function recipeNoteText(value) {
  if(typeof value==='string'||typeof value==='number')return String(value).replace(/\[object Object\]/g,'').replace(/UWAGA:\s*INNY LOT PRZĘDZY NIŻ W ZLECENI[EA] FARBIARSKIEGO\s*(?:-\s*zmienna w ostatniej partii\s*)?NR\s*([\d./-]+)/giu,'UWAGA: INNY LOT PRZĘDZY NIŻ W ZLECENIU FARBIARSKIM NR $1');
  if(Array.isArray(value))return value.map(recipeNoteText).join('');
  if(value&&typeof value==='object'){
    if(typeof value.text==='string')return recipeNoteText(value.text);
    if(typeof value.value==='string')return recipeNoteText(value.value);
    if(Array.isArray(value.runs))return value.runs.map(run=>recipeNoteText(run?.text??run)).join('');
  }
  return '';
}
function recipeNotesData(value='') {
  let parsed=value&&typeof value==='object'?value:undefined;try{if(!parsed)parsed=JSON.parse(String(value||''));}catch{}
  if(parsed?.format!==RECIPE_NOTES_FORMAT||!Array.isArray(parsed.runs))parsed={runs:[{text:recipeNoteText(value),underline:false,italic:false,size:16}]};
  let remaining=5000;
  const runs=parsed.runs.slice(0,1000).map(run=>{
    const text=recipeNoteText(run?.text).slice(0,remaining);remaining-=text.length;
    return {text,bold:Boolean(run?.bold),underline:Boolean(run?.underline),italic:Boolean(run?.italic),size:RECIPE_NOTES_SIZES.includes(Number(run?.size))?Number(run.size):16};
  }).filter(run=>run.text);
  return {format:RECIPE_NOTES_FORMAT,runs};
}
function recipeNotesText(value='') {
  const data=recipeNotesData(value);
  return data.runs.map(run=>run.text).join('').trim();
}
function appendRecipeNote(value,note) {
  const data=recipeNotesData(value),addition=String(note||'').trim();
  if(!addition)return data;
  if(data.runs.length)data.runs.push({text:'\n',underline:false,italic:false,size:16});
  data.runs.push({text:addition,underline:false,italic:false,size:16});
  return recipeNotesData(JSON.stringify(data));
}
function recipeNotesHtml(value='') {
  return recipeNotesData(value).runs.map(run=>{
    let html=V.esc(run.text).replace(/\n/g,'<br>');
    if(run.italic)html=`<em>${html}</em>`;
    if(run.underline)html=`<u>${html}</u>`;
    if(run.bold)html=`<strong>${html}</strong>`;
    return `<span${run.size!==16?` style="font-size:${run.size}px"`:''}>${html}</span>`;
  }).join('');
}
function recipeNotesEditorHtml(value='') { return recipeNotesHtml(value); }
function notesEditorField({name='notes',label='Uwagi dodatkowe',ariaLabel='Uwagi dodatkowe',value='',hint='Kliknij formatowanie, aby pisać z nim dalej; zaznacz tekst, aby zmienić istniejący.'}={}) {
  const sizes=RECIPE_NOTES_SIZES.map(size=>`<option value="${size}"${size===16?' selected':''}>${size} px</option>`).join('');
  const packed=JSON.stringify(recipeNotesData(value));
  return `<div class="finishing-notes-editor-label"><span class="finishing-notes-field-label">${V.esc(label)}</span><div class="finishing-notes-editor" data-finishing-notes-editor><div class="finishing-notes-toolbar" role="toolbar" aria-label="Formatowanie uwag"><button type="button" data-finishing-notes-bold aria-pressed="false" title="Włącz lub wyłącz pogrubienie"><strong>B</strong></button><button type="button" data-finishing-notes-underline aria-pressed="false" title="Włącz lub wyłącz podkreślenie"><u>U</u></button><button type="button" data-finishing-notes-italic aria-pressed="false" title="Włącz lub wyłącz kursywę"><em>I</em></button><label>Rozmiar<select data-finishing-notes-size>${sizes}</select></label><span class="muted small">${V.esc(hint)}</span></div><div class="finishing-notes-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${V.esc(ariaLabel)}" data-finishing-notes-content>${recipeNotesEditorHtml(value)}</div><input type="hidden" name="${V.esc(name)}" value="${V.esc(packed)}" data-finishing-notes-value></div></div>`;
}
const shipmentNo = row => `${String(row.sequence).padStart(2,'0')}/${row.shipment_year}`;
// PM sequences restart every shipment year, so the year is part of the displayed identifier.
const articleNo = (shipment,item) => `${String(shipment.sequence).padStart(2,'0')}-${String(item.sequence).padStart(2,'0')}/${String(shipment.shipment_year).slice(-2)}`;
const manualPm = order => String(order?.manual_reference||`PMR ${order?.id||'—'}`);
function nextManualReference(db,stamp) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit'}).formatToParts(new Date(stamp)).map(part=>[part.type,part.value]));
  const year=parts.year,month=parts.month,yearShort=year.slice(-2),suffix=`/${month}/${yearShort}`;
  const existing=db.prepare("SELECT manual_reference FROM finishing_orders WHERE manual_entry=1 AND manual_reference LIKE ?").all(`%${suffix}`);
  const sequence=existing.reduce((max,row)=>Math.max(max,Number(String(row.manual_reference).match(/^PMR\s+(\d+)\//)?.[1]||0)),0)+1;
  return `PMR ${sequence}${suffix}`;
}
const pmReference = order => order.manual_entry?manualPm(order):order.article_sequence?`PM ${articleNo({sequence:order.shipment_sequence,shipment_year:order.shipment_year},{sequence:order.article_sequence})}`:`PM ${order.source_shipment_no||'—'}`;
const finishingOrderNo = row => {
  const lot=String(row?.finishing_lot||'').trim();
  if(!lot)return '';
  const year=String(row?.sent_at||row?.received_at||row?.created_at||row?.order_created_at||row?.source_shipment_date||'').slice(0,4);
  if(!/^\d{4}$/.test(year))return lot;
  const qualified=lot.match(/^(.*)\/(\d{4})$/);
  if(qualified)return `${qualified[1]}/${qualified[2].slice(-2)}`;
  return `${lot}/${year.slice(-2)}`;
};

function recipeRecord(db,id) {
  return db.prepare(`SELECT r.*,p.name finishing_plant_name FROM finishing_recipes r
    LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id WHERE r.id=?`).get(id);
}
const LABEL_TEMPLATE_FIELDS=['symbol','color','lot','width','grammage','raw-symbol','client','weight','extra-text','distance'];
function labelTemplate(raw) {
  let value={};try{value=typeof raw==='string'?JSON.parse(raw||'{}'):(raw||{});}catch{}
  const defaults={symbol:true,color:true,lot:true,width:true,grammage:true,'raw-symbol':false,client:false,weight:false,'extra-text':false,distance:false};
  const savedFields=value.fields&&typeof value.fields==='object'?value.fields:{};
  const fields=Object.fromEntries(LABEL_TEMPLATE_FIELDS.map(field=>[field,Object.prototype.hasOwnProperty.call(savedFields,field)?Boolean(savedFields[field]):defaults[field]]));
  const logoCandidate=String(value.clientLogo||''),logoMatch=logoCandidate.length<480000&&logoCandidate.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/),logoBytes=logoMatch?Buffer.from(logoMatch[2],'base64'):null;
  const validLogo=logoMatch&&logoBytes.length<=350*1024&&(logoMatch[1]==='png'?logoBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):logoBytes[0]===255&&logoBytes[1]===216&&logoBytes[2]===255);
  const clientLogo=validLogo?logoCandidate:'';
  const brandMode=['logo','text','client-logo','none'].includes(value.brandMode)?value.brandMode:'logo';
  return {fields,brandMode:brandMode==='client-logo'&&!clientLogo?'logo':brandMode,brandText:String(value.brandText||'').slice(0,80),clientLogo,colorText:String(value.colorText||'').slice(0,100),extraText:String(value.extraText||'').slice(0,100),distance:String(value.distance||'').slice(0,30),language:value.language==='en'?'en':'pl',quantityUnit:value.quantityUnit==='weight'?'weight':'meters',includeMeters:Boolean(value.includeMeters)};
}
function labelTemplateFromForm(form) {
  const checked=name=>form[name]==='1'||form[name]==='on'||form[name]===true;
  const fields=Object.fromEntries(LABEL_TEMPLATE_FIELDS.map(field=>[field,checked(`label_field_${field.replace(/-/g,'_')}`)]));
  const clientLogo=String(form.label_client_logo_data||'').slice(0,480000),brandMode=checked('label_brand_text')?'text':checked('label_brand_client_logo')?'client-logo':checked('label_brand_logo')?'logo':'none';
  return JSON.stringify(labelTemplate({fields,brandMode,brandText:text(form,'label_brand_text_value',80),clientLogo,colorText:text(form,'label_color_text',100),extraText:text(form,'label_extra_text',100),distance:text(form,'label_distance',30),language:form.label_language,quantityUnit:form.label_quantity_unit,includeMeters:checked('label_include_meters')}));
}
function sourceSpec(db,id) {
  return db.prepare(`SELECT sa.id shipment_article_id,sa.sequence article_sequence,sa.finishing_plant_id,
      s.id shipment_id,s.shipment_year,s.sequence shipment_sequence,s.shipment_date,s.status,
      a.id article_id,a.symbol,count(sb.id) raw_bales,round(coalesce(sum(b.weight_kg),0),2) raw_weight_kg,
      fp.name finishing_plant_name
    FROM shipment_articles sa JOIN shipments s ON s.id=sa.shipment_id
    JOIN articles a ON a.id=sa.article_id
    LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id
    LEFT JOIN finishing_plants fp ON fp.id=sa.finishing_plant_id
    WHERE sa.id=? GROUP BY sa.id`).get(id);
}
function shipmentSpecUsed(db,id) {
  return Boolean(db.prepare("SELECT 1 FROM finishing_orders WHERE shipment_article_id=? AND status<>'cancelled' LIMIT 1").get(id));
}
function sourcePieces(db,id) {
  return db.prepare(`SELECT b.local_id bale_local_id,b.bale_number,b.production_date,b.machine,b.weight_kg,b.meters,b.errors,b.stops,b.lot,b.notes
    FROM shipment_bales sb JOIN production_bales b ON b.local_id=sb.bale_local_id
    WHERE sb.shipment_article_id=? AND sb.removed_at IS NULL
    ORDER BY b.production_date,b.machine COLLATE NOCASE,b.bale_number COLLATE NOCASE,sb.id`).all(id);
}
function receiptCapacity(db,order,batch) {
  const correctionBatch=Boolean(batch.correction_of_batch_id||batch.correction_parent_batch_id);
  const orderTotals=order.manual_entry
    ?db.prepare(`SELECT coalesce(sum(r.raw_pieces_received),0) pieces,coalesce(sum(r.used_weight_kg),0) kg FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id
      WHERE b.order_id=? AND b.cancelled_at IS NULL AND b.correction_parent_batch_id IS NULL AND b.correction_of_batch_id IS NULL`).get(order.id)
    :db.prepare(`SELECT coalesce(sum(r.raw_pieces_received),0) pieces,coalesce(sum(r.used_weight_kg),0) kg FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id
      JOIN finishing_orders o ON o.id=b.order_id WHERE o.shipment_article_id=? AND b.cancelled_at IS NULL AND b.correction_parent_batch_id IS NULL AND b.correction_of_batch_id IS NULL`).get(order.shipment_article_id);
  const batchTotals=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(used_weight_kg),0) kg FROM finishing_receipts WHERE batch_id=?').get(batch.id);
  let sourcePiecesTotal=0,sourceWeightTotal=0;
  if(order.manual_entry){
    const totals=db.prepare(`SELECT coalesce(sum(sent_pieces),0) pieces,coalesce(sum(raw_weight_kg),0) kg FROM finishing_batches
      WHERE order_id=? AND cancelled_at IS NULL AND correction_parent_batch_id IS NULL AND correction_of_batch_id IS NULL`).get(order.id);
    sourcePiecesTotal=Number(totals.pieces||0);sourceWeightTotal=Number(totals.kg||0);
  }else if(order.shipment_article_id){
    const pieces=sourcePieces(db,order.shipment_article_id);sourcePiecesTotal=pieces.length;sourceWeightTotal=pieces.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0);
  }
  const orderRemainingPieces=Math.max(0,sourcePiecesTotal-Number(orderTotals.pieces||0));
  const orderRemainingKg=Math.max(0,Math.round((sourceWeightTotal-Number(orderTotals.kg||0))*100)/100);
  const sentPieces=Number(batch.sent_pieces||0),sentKg=Number(batch.raw_weight_kg||0);
  const batchRemainingPieces=correctionBatch?Math.max(0,sentPieces-Number(batchTotals.pieces||0)):sentPieces>0?Math.max(0,sentPieces-Number(batchTotals.pieces||0)):orderRemainingPieces;
  const batchRemainingKg=correctionBatch?Math.max(0,Math.round((sentKg-Number(batchTotals.kg||0))*100)/100):sentKg>0?Math.max(0,Math.round((sentKg-Number(batchTotals.kg||0))*100)/100):orderRemainingKg;
  const suggestedPieces=correctionBatch?batchRemainingPieces:Math.min(batchRemainingPieces,orderRemainingPieces);
  const suggestedKg=correctionBatch?batchRemainingKg:Math.min(batchRemainingKg,orderRemainingKg);
  return {batchTotals,orderTotals,sourcePiecesTotal,sourceWeightTotal,orderRemainingPieces,orderRemainingKg,
    suggestedPieces,suggestedKg,effectiveBatchPieces:Number(batchTotals.pieces||0)+suggestedPieces,effectiveBatchKg:Math.round((Number(batchTotals.kg||0)+suggestedKg)*100)/100,
    remainingAfterBatchKg:Math.max(0,Math.round((orderRemainingKg-suggestedKg)*100)/100)};
}
function isMainPmBatch(db,order,batch) {
  if(!order||order.manual_entry||order.order_type==='raw_sale'||batch.correction_parent_batch_id||batch.correction_of_batch_id)return false;
  const mainId=db.prepare(`SELECT min(id) id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL
    AND correction_parent_batch_id IS NULL AND correction_of_batch_id IS NULL`).get(order.id)?.id;
  return Number(mainId)===Number(batch.id);
}
function isAdditionalPmBatch(db,order,batch) {
  if(!order||order.manual_entry||order.order_type==='raw_sale'||batch.correction_parent_batch_id||batch.correction_of_batch_id)return false;
  const mainId=db.prepare(`SELECT min(id) id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL
    AND correction_parent_batch_id IS NULL AND correction_of_batch_id IS NULL`).get(order.id)?.id;
  return Boolean(mainId)&&Number(mainId)!==Number(batch.id);
}
function finishingBatchStatusLabel(db,order,batch) {
  if(batch.cancelled_at)return 'Anulowana';
  if(batch.workflow_status==='do_poprawy'){
    const activeCorrection=db.prepare('SELECT 1 FROM finishing_batches WHERE cancelled_at IS NULL AND (correction_parent_batch_id=? OR correction_of_batch_id=?) LIMIT 1').get(batch.id,batch.id);
    return activeCorrection?'Wys. do poprawy':'Do poprawy';
  }
  if(batch.workflow_status==='poprawka')return `Poprawa${batch.closed_at?' · Przyjęte':batch.receipt_count?' · Częściowo przyjęte':''}`;
  if(isAdditionalPmBatch(db,order,batch)&&batch.receipt_count)return 'Przyjęta';
  if(isMainPmBatch(db,order,batch)&&batch.closed_at&&Number(batch.lost_pieces||0)>0)return 'Przyjęta z brakiem';
  if(isMainPmBatch(db,order,batch)&&batch.receipt_count&&!batch.closed_at)return 'Częściowo przyjęta';
  if(batch.closed_at)return 'Przyjęta';
  if(batch.receipt_count)return 'Częściowo przyjęta';
  return String(batch.finishing_lot||'').trim()?'W farbiarni':'W drodze';
}
function finishingBatchStatusClass(db,order,batch) {
  const label=finishingBatchStatusLabel(db,order,batch);
  if(label==='Wys. do poprawy')return 'finishing-correction-sent';
  if(label==='Przyjęta'||label==='Przyjęta z brakiem'||label.includes('· Przyjęte'))return 'approved';
  if(label==='Częściowo przyjęta')return 'approved';
  return ['Anulowana','Do poprawy'].includes(label)?'archived':label==='W drodze'?'status-in-transit':'status-finishing';
}
function activeCorrectionOrderNumber(db,batchId) {
  const correction=db.prepare(`SELECT finishing_lot,sent_at,created_at FROM finishing_batches
    WHERE cancelled_at IS NULL AND (correction_parent_batch_id=? OR correction_of_batch_id=?) ORDER BY id DESC LIMIT 1`).get(batchId,batchId);
  return correction?finishingOrderNo(correction):'';
}
function pieceListView(pieces,summary='Sztuki w zleceniu') {
  const totalWeight=pieces.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0),totalMeters=pieces.reduce((sum,piece)=>sum+Number(piece.meters||0),0);
  const pieceRows=pieces.map((piece,index)=>`<li><strong>${index+1}. ${V.esc(piece.bale_number)}</strong><span>${V.esc(piece.machine||'—')} · ${V.datepl(piece.production_date)} · ${qty(piece.meters)} m · ${money(piece.weight_kg)} kg${piece.lot?` · LOT ${V.esc(piece.lot)}`:''}</span></li>`).join('');
  return `<details class="finishing-source-pieces"><summary><span class="finishing-source-pieces-arrow" aria-hidden="true">›</span><span class="finishing-source-pieces-title">${summary}</span><span>${pieces.length} szt · ${qty(totalMeters)} m · ${money(totalWeight)} kg</span></summary>${pieces.length?`<ol class="finishing-source-piece-list">${pieceRows}</ol>`:'<p class="muted">Brak aktywnych sztuk w tej specyfikacji.</p>'}</details>`;
}
function sourceDetailsView(db,source) {
  const pieces=sourcePieces(db,source.shipment_article_id),totalWeight=pieces.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0);
  return `<div class="finishing-source-summary"><strong>PM ${articleNo({sequence:source.shipment_sequence,shipment_year:source.shipment_year},{sequence:source.article_sequence})} · ${V.esc(source.symbol)}</strong><span>${pieces.length} szt · ${money(totalWeight)} kg · WZ ${shipmentNo({sequence:source.shipment_sequence,shipment_year:source.shipment_year})} · ${V.datepl(source.shipment_date)}</span></div>${pieceListView(pieces)}`;
}
function orderPiecesView(db,order) {
  if(!order.shipment_article_id)return '';
  let pieces=db.prepare('SELECT bale_local_id,bale_number,production_date,machine,weight_kg,meters,lot FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(order.id);
  if(!pieces.length)pieces=sourcePieces(db,order.shipment_article_id);
  return pieceListView(pieces,'Sztuki załadowane do zlecenia');
}
function saveOrderPieces(db,orderId,shipmentArticleId) {
  return db.prepare(`INSERT INTO finishing_order_bales(order_id,bale_local_id,bale_number,machine,production_date,weight_kg,meters,lot)
    SELECT ?,b.local_id,b.bale_number,b.machine,b.production_date,b.weight_kg,b.meters,b.lot
    FROM shipment_bales sb JOIN production_bales b ON b.local_id=sb.bale_local_id
    WHERE sb.shipment_article_id=? AND sb.removed_at IS NULL`).run(orderId,shipmentArticleId).changes;
}
function createRawSaleReceipt(db,orderId,pieces,actorId,stamp,receivedAt) {
  const count=pieces.length,weight=Costing.round2(pieces.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0)),meters=Costing.round2(pieces.reduce((sum,piece)=>sum+Number(piece.meters||0),0));
  const year=String(receivedAt||'').slice(0,4),existing=db.prepare(`SELECT b.finishing_lot FROM finishing_batches b JOIN finishing_orders o ON o.id=b.order_id WHERE o.order_type='raw_sale' AND substr(b.sent_at,1,4)=?`).all(year),next=existing.reduce((max,row)=>Math.max(max,Number(String(row.finishing_lot||'').match(/^PMS(\d+)$/)?.[1]||0)),0)+1;
  const batchId=Number(db.prepare(`INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,closed_at,created_at,created_by,updated_at,updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(orderId,`PMS${next}`,receivedAt,count,weight,stamp,stamp,actorId,stamp,actorId).lastInsertRowid);
  const receiptId=Number(db.prepare(`INSERT INTO finishing_receipts(batch_id,received_at,raw_pieces_received,finished_pieces,finished_weight_kg,used_weight_kg,settlement_unit,finished_meters,created_at,created_by)
    VALUES(?,?,?,?,?,?,'mb',?,?,?)`).run(batchId,receivedAt,count,count,weight,weight,meters,stamp,actorId).lastInsertRowid);
  const insertBale=db.prepare('INSERT INTO finishing_return_bales(receipt_id,sequence,meters,weight_kg) VALUES(?,?,?,?)');
  pieces.forEach((piece,index)=>insertBale.run(receiptId,index+1,piece.meters,piece.weight_kg));
  return {batchId,receiptId,count,weight,meters};
}
function orderRecord(db,id) {
  return db.prepare(`SELECT o.*,fp.name finishing_plant_name,
      s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence
    FROM finishing_orders o LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id
    LEFT JOIN shipments s ON s.id=sa.shipment_id WHERE o.id=?`).get(id);
}
function orderBatches(db,orderId) {
  return db.prepare(`SELECT b.*,count(DISTINCT r.id) receipt_count,
      coalesce(sum(r.raw_pieces_received),0) raw_received_pieces,
      coalesce(sum(r.used_weight_kg),0) raw_received_weight_kg,
      coalesce(sum(r.finished_pieces),0) finished_pieces,
      coalesce((SELECT sum(i.lost_pieces) FROM finishing_incidents i WHERE i.batch_id=b.id AND i.auto_generated=1 AND i.incident_type='lost'),0) lost_pieces,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_receipts rr WHERE rr.batch_id=b.id AND rr.finished_weight_kg>0) THEN round(sum(r.finished_weight_kg),2) ELSE NULL END finished_weight_kg,
      (SELECT round(sum(CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=rr.id) THEN (SELECT sum(rb.meters) FROM finishing_return_bales rb WHERE rb.receipt_id=rr.id) ELSE rr.finished_meters END),2) FROM finishing_receipts rr WHERE rr.batch_id=b.id) finished_meters
    FROM finishing_batches b LEFT JOIN finishing_receipts r ON r.batch_id=b.id
    WHERE b.order_id=? GROUP BY b.id ORDER BY b.id DESC`).all(orderId);
}
function orderReceipts(db,orderId) {
  return db.prepare(`SELECT r.*,b.finishing_lot,o.raw_symbol,o.trade_symbol,o.client_name,o.target_color,o.target_stiffening,o.target_width_cm,o.target_grammage,
      coalesce((SELECT count(*) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id),0) bale_count,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id) THEN (SELECT round(sum(rb.meters),2) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id) ELSE r.finished_meters END meters_sum
    FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id
    JOIN finishing_orders o ON o.id=b.order_id WHERE o.id=? ORDER BY r.received_at DESC,r.id DESC`).all(orderId);
}
function clientNames(db) {
  const names=new Set(db.prepare("SELECT client_name name FROM projects WHERE trim(client_name)<>''").all().map(row=>row.name));
  for(const row of db.prepare("SELECT payload FROM records WHERE trim(payload)<>''").all()) {
    try{const value=JSON.parse(row.payload||'{}').client;if(value)names.add(String(value).trim());}catch{}
  }
  for(const row of db.prepare("SELECT DISTINCT client_name name FROM finishing_orders WHERE trim(client_name)<>''").all()) names.add(row.name);
  return [...names].filter(Boolean).sort((a,b)=>a.localeCompare(b,'pl'));
}
function plants(db) { return db.prepare('SELECT id,name FROM finishing_plants WHERE active=1 ORDER BY name COLLATE NOCASE').all(); }
function recipes(db,plantId=0,activeOnly=true) {
  const activeClause=activeOnly?'r.active=1':'1=1';
  return plantId
    ? db.prepare(`SELECT r.*,p.name finishing_plant_name FROM finishing_recipes r LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id WHERE ${activeClause} AND (r.finishing_plant_id IS NULL OR r.finishing_plant_id=?) ORDER BY r.name COLLATE NOCASE,r.id`).all(plantId)
    : db.prepare(`SELECT r.*,p.name finishing_plant_name FROM finishing_recipes r LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id WHERE ${activeClause} ORDER BY r.name COLLATE NOCASE,r.id`).all();
}
function snapshotRecipe(recipe) {
  if(!recipe)return {};
  return {name:recipe.name,finishingPlant:recipe.finishing_plant_name||'',rawSymbol:recipe.raw_symbol||'',recipeText:recipeTextFor(recipe),details:readRecipeDetails(recipe),targetColor:recipe.target_color||'',targetStiffening:recipe.target_stiffening||'',targetWidthCm:recipe.target_width_cm??'',targetGrammage:recipe.target_grammage??'',notes:recipe.notes||''};
}
function recipePreviewText(recipe) {
  const instructions=recipeTextFor(recipe),notes=recipeNotesText(recipe?.notes||'');
  return [instructions,notes?`Informacje dodatkowe:\n${notes}`:''].filter(Boolean).join('\n\n');
}
function readRecipeDetails(recipe) {
  try{return JSON.parse(recipe?.recipe_details||'{}')||{};}catch{return {};}
}
function recipeProcessRequirements(details={}) {
  return [
    ['brushing','Drapanie',''],
    ['brushingForVelcro','Drapanie pod rzep',''],
    ['stiffeningEnabled','Usztywnienie',details.stiffeningDescription||''],
    ['softeningEnabled','Zmiękczenie',details.softeningDescription||''],
    ['trimEdges','Obcinanie brzegów',''],
    ['bondEdges','Podklejanie brzegów',''],
    ['trimSygnits','Obcinanie sygnitów',''],
  ].filter(([key])=>details[key]==='yes').map(([key,label,description])=>({key,label,description}));
}
function orderRecipeDetails(db,order,snapshot={}) {
  if(snapshot.details&&Object.keys(snapshot.details).length)return snapshot.details;
  const recipe=order?.recipe_id?recipeRecord(db,order.recipe_id):null;
  return recipe?readRecipeDetails(recipe):{};
}
function receiptProcessSummary(receipt,details={}) {
  let checks={};try{checks=JSON.parse(receipt.process_checks||'{}')||{};}catch{}
  return recipeProcessRequirements(details).map(item=>{
    const status=checks[item.key]||(item.key==='brushing'||item.key==='brushingForVelcro'?receipt.rubbing_status:item.key==='stiffeningEnabled'?receipt.stiffening_status:'');
    return ['ok','not_ok'].includes(status)?`${item.label}: ${status==='ok'?'OK':'NOK'}`:'';
  }).filter(Boolean).join(' · ');
}
function parameterStatus(actual,target,minus,plus) {
  if(actual===null||actual===undefined||target===null||target===undefined)return '';
  const measured=Number(actual),planned=Number(target);
  if(!Number.isFinite(measured)||!Number.isFinite(planned)||planned<=0)return '';
  const lower=planned-(Number(minus)||0),upper=planned+(Number(plus)||0);
  if(measured>=lower&&measured<=upper)return 'ok';
  return 'danger';
}
function parameterStatusHtml(status) {
  const label=status==='ok'?'W tolerancji':status==='warning'||status==='danger'?'Poza tolerancją':'—';
  const colorClass=status==='warning'?'danger':status;
  return status?`<span class="finishing-param-result is-${colorClass}">${label}</span>`:'—';
}
function splitLegacyTradeSymbol(value,plantName='',recipeName='') {
  const raw=String(value||'').trim(),slash=raw.indexOf('/');
  if(slash<0)return {symbol:raw,color:''};
  let symbol=raw.slice(0,slash).trim(),color=raw.slice(slash+1).trim();
  const name=String(recipeName||'').trim();if(name)symbol=symbol.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*[–—-]\\s*`,'i'),'').trim();
  const plant=String(plantName||'').trim();
  if(plant){const escaped=plant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');color=color.replace(new RegExp(`\\s*[–—-]\\s*${escaped}\\s*$`,'i'),'').trim();}
  // A size in parentheses belongs to the base symbol, while a numeric code after the slash is its color.
  const size=color.match(/^(\d{2}-\d{2})\s*(\([^)]*\))$/);
  if(size){symbol=`${symbol} ${size[2]}`.trim();color=size[1];}
  return {symbol,color};
}
function recipeTradeSymbolParts(recipe) {
  const details=readRecipeDetails(recipe),saved=details.tradeSymbol||details.trade_symbol||recipe?.trade_symbol||String(recipe?.recipe_text||'').match(/^\s*Symbol handlowy\s*:\s*(.+?)\s*$/im)?.[1]||'';
  const explicitColor=details.tradeColorSymbol||details.trade_color_symbol;
  if(explicitColor!==undefined)return {symbol:String(saved||'').trim(),color:String(explicitColor||'').trim()};
  return splitLegacyTradeSymbol(saved,recipe?.finishing_plant_name||'',recipe?.name||'');
}
function migrateRecipeTradeSymbols(db) {
  if(migratedRecipeTradeSymbolDbs.has(db))return;
  migratedRecipeTradeSymbolDbs.add(db);
  try {
    const rows=db.prepare(`SELECT r.id,r.name,r.recipe_details,r.recipe_text,p.name finishing_plant_name FROM finishing_recipes r LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id`).all();
    const update=db.prepare('UPDATE finishing_recipes SET recipe_details=? WHERE id=?');
    for(const row of rows){let details={};try{details=JSON.parse(row.recipe_details||'{}')||{}}catch{}if(!Object.keys(details).length||details.tradeColorSymbol!==undefined||details.trade_color_symbol!==undefined)continue;
      const saved=details.tradeSymbol||details.trade_symbol||'';
      if(!saved)continue;
      const parts=splitLegacyTradeSymbol(saved,row.finishing_plant_name,row.name);details.tradeSymbol=parts.symbol;details.tradeColorSymbol=parts.color;delete details.trade_symbol;update.run(JSON.stringify(details),row.id);
    }
  } catch (error) { migratedRecipeTradeSymbolDbs.delete(db); throw error; }
}
function recipeTradeSymbol(recipe) {
  const parts=recipeTradeSymbolParts(recipe);
  return [parts.symbol,parts.color].filter(Boolean).join(' / ');
}
function recipeTextFor(recipe) {
  const details=readRecipeDetails(recipe);
  if(Object.keys(details).length)return recipeSummary(details,{targetColor:recipe.target_color,targetStiffening:recipe.target_stiffening,targetWidthCm:recipe.target_width_cm,targetGrammage:recipe.target_grammage});
  const negativeOption=/^(?:Drapanie|Drapanie pod rzep|Usztywnienie|Zmiękczenie|Obcinanie brzegów|Podklejanie brzegów|Obcinanie sygnitów)\s*:\s*(?:nie|no)(?:\s|$)/i;
  return String(recipe?.recipe_text||'').split(/\r?\n/).filter(line=>!negativeOption.test(line.trim())).join('\n').trim();
}
function recipeDetailsFromForm(form) {
  const selected=key=>form[key]==='yes'?'yes':undefined;
  const details={
    trialRecipe:selected('trial_recipe'),tradeSymbol:text(form,'trade_symbol',200),tradeColorSymbol:text(form,'trade_color_symbol',200),rawMaterial:text(form,'raw_material',1000),
    grammagePlus:number(form.target_grammage_plus),grammageMinus:number(form.target_grammage_minus),
    widthMode:form.width_between_needles==='yes'?'needles':'exact',widthPlus:number(form.target_width_plus),widthMinus:number(form.target_width_minus),
    widthMinimum:number(form.target_width_minimum),widthMaximum:number(form.target_width_maximum),
    widthNeedles:text(form,'target_width_needles',100),
    brushing:selected('brushing'),brushingForVelcro:selected('brushing_for_velcro'),
    stiffeningEnabled:selected('stiffening_enabled'),stiffeningDescription:text(form,'stiffening_description',2000),
    softeningEnabled:selected('softening_enabled'),softeningDescription:text(form,'softening_description',2000),
    trimEdges:selected('trim_edges'),bondEdges:selected('bond_edges'),trimSygnits:selected('trim_sygnits'),
    winding:[text(form,'winding_1',1000),text(form,'winding_2',1000),text(form,'winding_3',1000)],
    shrinkage:text(form,'shrinkage',2000),
  };
  for(const key of ['brushing','brushingForVelcro','trimEdges','bondEdges','trimSygnits'])if(details[key]!=='yes')delete details[key];
  for(const [enabled,description] of [['stiffeningEnabled','stiffeningDescription'],['softeningEnabled','softeningDescription']])if(details[enabled]!=='yes'){delete details[enabled];delete details[description];}
  return details;
}
function recipeSummary(details,base={}) {
  const lines=[];
  if(details.tradeSymbol)lines.push(`Symbol handlowy: ${details.tradeSymbol}`);
  if(details.tradeColorSymbol)lines.push(`Symbol koloru handlowego: ${details.tradeColorSymbol}`);
  if(details.rawMaterial)lines.push(`Surowiec: ${details.rawMaterial}`);
  if(base.targetColor)lines.push(`Kolor: ${base.targetColor}`);
  if(base.targetGrammage!==null&&base.targetGrammage!==undefined)lines.push(`Gramatura: ${base.targetGrammage} g/m²${details.grammagePlus!==null||details.grammageMinus!==null?` (+${details.grammagePlus??'—'} / −${details.grammageMinus??'—'})`:''}`);
  if(details.widthMode==='range')lines.push(`Szerokość: ${details.widthMinimum??'—'}–${details.widthMaximum??'—'} cm`);
  else if(details.widthMode==='minimum')lines.push(`Szerokość: nie mniej niż ${details.widthMinimum??'—'} cm`);
  else if(details.widthMode==='needles')lines.push(`Szerokość między igłami: ${base.targetWidthCm??details.widthNeedles??'—'}${base.targetWidthCm!==null&&base.targetWidthCm!==undefined?' cm':''}${details.widthPlus!==null||details.widthMinus!==null?` (+${details.widthPlus??'—'} / −${details.widthMinus??'—'})`:''}`);
  else if(base.targetWidthCm!==null&&base.targetWidthCm!==undefined)lines.push(`Szerokość: ${base.targetWidthCm} cm${details.widthPlus!==null||details.widthMinus!==null?` (+${details.widthPlus??'—'} / −${details.widthMinus??'—'})`:''}`);
  if(details.brushing==='yes')lines.push('Drapanie: tak');
  if(details.brushingForVelcro==='yes')lines.push('Drapanie pod rzep: tak');
  if(details.stiffeningEnabled==='yes')lines.push(`Usztywnienie: tak${details.stiffeningDescription?` — ${details.stiffeningDescription}`:''}`);
  if(details.softeningEnabled==='yes')lines.push(`Zmiękczenie: tak${details.softeningDescription?` — ${details.softeningDescription}`:''}`);
  if(details.trimEdges==='yes')lines.push('Obcinanie brzegów: tak');
  if(details.bondEdges==='yes')lines.push('Podklejanie brzegów: tak');
  if(details.trimSygnits==='yes')lines.push('Obcinanie sygnitów: tak');
  for(const instruction of details.winding||[])if(instruction)lines.push(`Nawijanie: ${instruction}`);
  if(details.shrinkage)lines.push(`Kurczliwości: ${details.shrinkage}`);
  return lines.join('\n');
}
function prepareRecipe(form,fail) {
  const details=recipeDetailsFromForm(form),name=text(form,'name',200),rawSymbol=text(form,'raw_symbol',200),plantId=Number(form.finishing_plant_id)||null;
  const grammage=number(form.target_grammage),widthInput=number(form.target_width_cm);
  if(!name)fail(400,'Wpisz nazwę receptury.');
  if(!rawSymbol)fail(400,'Wpisz symbol dzianiny surowej.');
  for(const [label,value] of [['Gramatura',grammage],['Szerokość',widthInput]])if(value!==null&&value<=0)fail(400,`${label} musi być większa od zera.`);
  for(const [label,value] of [['Tolerancja gramatury +',details.grammagePlus],['Tolerancja gramatury −',details.grammageMinus],['Tolerancja szerokości +',details.widthPlus],['Tolerancja szerokości −',details.widthMinus]])if(value!==null&&value<0)fail(400,`${label} nie może być ujemna.`);
  for(const [label,value] of [['Szerokość minimalna',details.widthMinimum],['Szerokość maksymalna',details.widthMaximum]])if(value!==null&&value<=0)fail(400,`${label} musi być większa od zera.`);
  if(details.widthMode==='minimum'&&details.widthMinimum===null)fail(400,'Podaj minimalną szerokość.');
  if(details.widthMode==='range'&&(details.widthMinimum===null||details.widthMaximum===null||details.widthMinimum>details.widthMaximum))fail(400,'Podaj prawidłowy zakres szerokości.');
  const width=widthInput??(details.widthMode==='minimum'?details.widthMinimum:null);
  const color=text(form,'target_color',160);
  const stiffening=details.stiffeningEnabled==='yes'?`Tak${details.stiffeningDescription?` — ${details.stiffeningDescription}`:''}`:'';
  const notes=JSON.stringify(recipeNotesData(text(form,'notes',100000))),summary=recipeSummary(details,{targetColor:color,targetWidthCm:width,targetGrammage:grammage});
  const labelSettings=labelTemplateFromForm(form);
  return {name,rawSymbol,details,plantId,width,grammage,color,stiffening,notes,labelSettings,recipeText:summary};
}
function unassignedOrderPieces(db,order,batches=null) {
  if(!order||order.manual_entry||!order.shipment_article_id)return 0;
  const currentBatches=batches||db.prepare(`SELECT b.sent_pieces,b.correction_parent_batch_id,b.correction_of_batch_id,
      (SELECT count(*) FROM finishing_receipts r WHERE r.batch_id=b.id) receipt_count,
      coalesce((SELECT sum(r.raw_pieces_received) FROM finishing_receipts r WHERE r.batch_id=b.id),0) raw_received_pieces
    FROM finishing_batches b WHERE b.order_id=? AND b.cancelled_at IS NULL`).all(order.id);
  const allocated=currentBatches.filter(batch=>!batch.correction_parent_batch_id&&!batch.correction_of_batch_id).reduce((sum,batch)=>sum+(Number(batch.receipt_count||0)>0?Number(batch.raw_received_pieces??batch.raw_received??0):Number(batch.sent_pieces||0)),0);
  return Math.max(0,sourcePieces(db,order.shipment_article_id).length-allocated);
}
function orderStatus(db,orderId) {
  const order=orderRecord(db,orderId);
  if(!order)return;
  if(order.status==='raw_sale'||order.status==='cancelled')return;
  const batches=db.prepare('SELECT id,closed_at,finishing_lot,cancelled_at,sent_pieces,correction_parent_batch_id,correction_of_batch_id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL').all(orderId),unassigned=unassignedOrderPieces(db,order,batches);
  const status=!batches.length?'draft':batches.every(batch=>batch.closed_at)&&unassigned===0?'received':batches.some(batch=>String(batch.finishing_lot||'').trim())?'sent':'draft';
  db.prepare('UPDATE finishing_orders SET status=?,updated_at=? WHERE id=?').run(status,new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),orderId);
}
function orderStatusLabel(status) {
  return {draft:'W drodze',sent:'W farbiarni',partial:'W farbiarni',received:'Przyjęta',raw_sale:'PMS — Przesunięcie magazynowe surowej',do_poprawy:'Do poprawy',poprawka:'Poprawa',cancelled:'Anulowana'}[status]||status;
}
function orderTypeLabel(type) {
  return {standard:'Wykończenie standard',raw_sale:'PMS — Przesunięcie magazynowe surowej',trial:'Próba',manual:'Zlecenie ręczne'}[type]||'Wykończenie standard';
}
function statusBadge(status) {
  return `<span class="badge ${orderStatusBadgeClass(status)}">${V.esc(orderStatusLabel(status))}</span>`;
}
function orderStatusBadgeClass(status) {
  return {draft:'status-in-transit',sent:'status-finishing',partial:'status-finishing',received:'approved',raw_sale:'archived',do_poprawy:'archived',poprawka:'status-finishing',cancelled:'archived'}[status]||'submitted';
}
function lastProductionPreview(db,source,recipe) {
  const currentLots=[...new Set(sourcePieces(db,source.shipment_article_id).map(piece=>String(piece.lot||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pl'));
  const recipeSymbol=String(recipe?.raw_symbol||readRecipeDetails(recipe).rawSymbol||readRecipeDetails(recipe).raw_symbol||'').trim();
  const symbolMismatch=Boolean(recipeSymbol&&normalizeSearch(recipeSymbol)!==normalizeSearch(source.symbol));
  const symbolIssue=symbolMismatch?`Symbol z PM (${source.symbol}) różni się od symbolu receptury (${recipeSymbol}).`:!recipeSymbol?'Brak symbolu dzianiny w recepturze — nie można porównać go z PM.':'';
  const previous=db.prepare(`SELECT o.id,o.source_shipment_no,o.source_shipment_date,o.recipe_snapshot,o.target_color,o.target_grammage,o.manual_entry,o.manual_reference,
      s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence,
      r.received_at,r.actual_grammage,r.actual_width_cm,r.actual_color,r.color_status,r.stiffening_status,r.rubbing_status,r.process_checks,r.notes receipt_notes,b.finishing_lot,b.sent_at,b.yarn_lot,b.notes batch_notes,o.notes order_notes
    FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id JOIN finishing_orders o ON o.id=b.order_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id LEFT JOIN shipments s ON s.id=sa.shipment_id
    WHERE o.recipe_id=? AND o.status NOT IN ('cancelled','raw_sale') AND r.finished_pieces>0
    ORDER BY r.received_at DESC,r.id DESC LIMIT 1`).get(recipe?.id||0);
  const lotParts=value=>String(value||'').split(/[,;]+/).map(part=>normalizeSearch(part)).filter(Boolean).sort();
  const compareLots=(current,previousLot)=>{
    if(!current.length||!String(previousLot||'').trim())return 'Brak danych LOT do porównania';
    return lotParts(current.join(',')).join('|')===lotParts(previousLot).join('|')?'Ten sam LOT':'LOT się zmienił';
  };
  const currentLot=currentLots.join(', ')||'Brak LOT-u w PM';
  if(!previous)return {found:false,recipeName:recipe?.name||'',currentLot,sourceSymbol:source.symbol,recipeSymbol,symbolMismatch,symbolIssue,issues:[...(symbolIssue?[symbolIssue]:[]),'Brak wcześniejszej produkcji tej receptury do porównania.']};
  let snapshot={};try{snapshot=JSON.parse(previous.recipe_snapshot||'{}')}catch{}
  const details=recipe?readRecipeDetails(recipe):(snapshot.details||{}),expectedGrammage=recipe?.target_grammage??snapshot.targetGrammage??null;
  const actualGrammage=previous.actual_grammage;
  let grammageResult='Brak danych do oceny gramatury';
  if(actualGrammage!==null&&actualGrammage!==undefined&&expectedGrammage!==null&&expectedGrammage!==undefined){
    const min=Number(expectedGrammage)-Number(details.grammageMinus||0),max=Number(expectedGrammage)+Number(details.grammagePlus||0);
    grammageResult=Number(actualGrammage)>=min&&Number(actualGrammage)<=max?`OK, w tolerancji ${qty(min)}–${qty(max)} g/m²`:`Poza tolerancją ${qty(min)}–${qty(max)} g/m²`;
  }
  const expectedWidth=recipe?.target_width_cm??snapshot.targetWidthCm??null,actualWidth=previous.actual_width_cm;
  let widthResult='Brak danych do oceny szerokości';
  if(actualWidth!==null&&actualWidth!==undefined&&expectedWidth!==null&&expectedWidth!==undefined){
    const min=Number(expectedWidth)-Number(details.widthMinus||0),max=Number(expectedWidth)+Number(details.widthPlus||0);
    widthResult=Number(actualWidth)>=min&&Number(actualWidth)<=max?`OK, w tolerancji ${qty(min)}–${qty(max)} cm`:`Poza tolerancją ${qty(min)}–${qty(max)} cm`;
  }
  const expectedColor=recipe?.target_color||'';
  let colorResult='Brak koloru docelowego';
  if(previous.color_status==='ok')colorResult='Kolor zgodny';
  else if(previous.color_status==='not_ok')colorResult='Kolor różni się od receptury';
  else if(expectedColor&&previous.actual_color)colorResult=normalizeSearch(expectedColor)===normalizeSearch(previous.actual_color)?'Kolor zgodny':'Kolor różni się od receptury';
  else if(previous.actual_color)colorResult=`Brak koloru docelowego (uzyskano: ${previous.actual_color})`;
  let previousProcessChecks={};try{previousProcessChecks=JSON.parse(previous.process_checks||'{}')||{};}catch{}
  const processChecks=recipeProcessRequirements(details).map(item=>{
    const saved=previousProcessChecks[item.key],status=saved==='ok'||saved==='not_ok'?saved:saved===true?'ok':'';
    return {label:item.label,status};
  });
  const comments=[previous.receipt_notes,previous.batch_notes,previous.order_notes].map(recipeNotesText).filter(Boolean);
  const pm=pmReference(previous);
  const finishingOrder=finishingOrderNo(previous);
  const previousOrderReference=finishingOrder?`zlecenia farbiarskiego nr ${finishingOrder}`:'ostatniego zlecenia farbiarskiego';
  const lotComparison=compareLots(currentLots,previous.yarn_lot);
  const issues=[];
  if(symbolIssue)issues.push(symbolIssue);
  if(grammageResult.startsWith('Poza'))issues.push(`Gramatura z ostatniej produkcji (${qty(actualGrammage)} g/m²) była ${grammageResult.toLocaleLowerCase('pl-PL')}.`);
  else if(grammageResult.startsWith('Brak danych')&&expectedGrammage!==null&&expectedGrammage!==undefined)issues.push('Brak zmierzonej gramatury w ostatniej produkcji — nie można potwierdzić tolerancji.');
  else if(expectedGrammage===null||expectedGrammage===undefined)issues.push('Brak gramatury zadanej w recepturze — nie można ocenić tolerancji.');
  if(widthResult.startsWith('Poza'))issues.push(`Szerokość z ostatniej produkcji (${qty(actualWidth)} cm) była ${widthResult.toLocaleLowerCase('pl-PL')}.`);
  else if(widthResult.startsWith('Brak danych')&&expectedWidth!==null&&expectedWidth!==undefined)issues.push('Brak zmierzonej szerokości w ostatniej produkcji — nie można potwierdzić tolerancji.');
  else if(expectedWidth===null||expectedWidth===undefined)issues.push('Brak szerokości zadanej w recepturze — nie można ocenić tolerancji.');
  if(colorResult==='Kolor różni się od receptury')issues.push(`Kolor z ostatniej produkcji był niezgodny${previous.actual_color?` (uzyskano: ${previous.actual_color})`:''}.`);
  else if(expectedColor&&!previous.actual_color&&!previous.color_status)issues.push('Brak oceny koloru w ostatniej produkcji — nie można potwierdzić zgodności z recepturą.');
  else if(!expectedColor)issues.push('Brak koloru zadanego w recepturze — nie można ocenić zgodności.');
  for(const item of processChecks){if(item.status==='not_ok')issues.push(`Wymaganie receptury „${item.label}” oceniono jako NOK w ostatniej produkcji.`);else if(!item.status)issues.push(`Brak oceny OK/NOK wymagania receptury „${item.label}” w ostatniej produkcji.`);}
  if(!processChecks.some(item=>item.label==='Usztywnienie')&&previous.stiffening_status==='not_ok')issues.push('Usztywnienie oceniono jako NOK w ostatniej produkcji.');
  if(!processChecks.some(item=>item.label==='Drapanie'||item.label==='Drapanie pod rzep')&&previous.rubbing_status==='not_ok')issues.push('Wydrapanie oceniono jako NOK w ostatniej produkcji.');
  if(lotComparison==='LOT się zmienił')issues.push(`Zmieniono LOT przędzy względem ${previousOrderReference}. Wykonać korektę koloru.`);
  else if(lotComparison==='Brak danych LOT do porównania')issues.push('Brak kompletnych danych LOT przędzy — nie można porównać z ostatnią produkcją.');
  return {found:true,recipeName:recipe?.name||snapshot.name||'',pm,date:V.datepl(previous.received_at),finishingOrder,sourceSymbol:source.symbol,recipeSymbol,symbolMismatch,symbolIssue,grammage:actualGrammage===null||actualGrammage===undefined?'Brak wpisu':`${qty(actualGrammage)} g/m²`,grammageResult,width:actualWidth===null||actualWidth===undefined?'Brak wpisu':`${qty(actualWidth)} cm`,widthResult,color:previous.color_status?previous.color_status==='ok'?'OK':'NOK':previous.actual_color||'Brak wpisu',colorResult,processChecks,comments:comments.join(' · ')||'Brak komentarzy',previousLot:previous.yarn_lot||'',currentLot,lotComparison,lotChanged:lotComparison==='LOT się zmienił',issues};
}
function header({user,csrf,flashes,title,body}) { return V.layout({user,csrf,flashes,title:`${title} · Wykańczanie`,body}); }
function navTabs(active,db) {
  const unresolved=Number(db.prepare("SELECT count(*) count FROM finishing_incidents WHERE auto_generated=1 AND incident_type='lost' AND found_at IS NULL AND settled_at IS NULL").get()?.count||0);
  return `<nav class="finishing-tabs" aria-label="Wykańczanie"><a class="${active==='orders'?'selected':''}" href="/finishing/orders">Zlecenia wykańczania</a><a class="${active==='receipts'?'selected':''}" href="/finishing/receipts">Przyjęcia i rozliczenia</a><a class="finishing-lost-tab ${active==='lost'?'selected':''}" href="/finishing/lost">Zagubione/zniszczone${unresolved?`<span class="finishing-lost-count" aria-label="${unresolved} niezałatwionych spraw">${unresolved}</span>`:''}</a><a class="${active==='recipes'?'selected':''}" href="/finishing/recipes">Biblioteka receptur wykańczania</a><a class="${active==='labels'?'selected':''}" href="/finishing/labels">Drukowanie etykiet</a></nav>`;
}
function shipmentOptions(db,selectedId=0) {
  const rows=db.prepare(`SELECT sa.id,sa.sequence article_sequence,s.shipment_year,s.sequence shipment_sequence,s.shipment_date,
      a.symbol,sa.finishing_plant_id,count(sb.id) raw_bales,round(coalesce(sum(b.weight_kg),0),2) raw_weight_kg
    FROM shipment_articles sa JOIN shipments s ON s.id=sa.shipment_id
    JOIN articles a ON a.id=sa.article_id LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id WHERE s.status='closed'
      AND NOT EXISTS(SELECT 1 FROM finishing_orders fo WHERE fo.shipment_article_id=sa.id AND fo.status<>'cancelled')
      AND EXISTS(SELECT 1 FROM shipment_bales active_sb WHERE active_sb.shipment_article_id=sa.id AND active_sb.removed_at IS NULL)
    GROUP BY sa.id ORDER BY s.shipment_year DESC,s.sequence DESC,sa.sequence DESC`).all();
  return rows.map(row=>`<option value="${row.id}" data-plant="${row.finishing_plant_id||''}"${Number(selectedId)===row.id?' selected':''}>PM ${articleNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year},{sequence:row.article_sequence})} · ${V.esc(row.symbol)} · ${row.raw_bales} szt · ${money(row.raw_weight_kg)} kg · WZ ${shipmentNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year})} · ${V.datepl(row.shipment_date)}</option>`).join('');
}
function orderForm(ctx, selectedSource=0) {
  const db=ctx.db,source=selectedSource&&!shipmentSpecUsed(db,selectedSource)?sourceSpec(db,selectedSource):null,plantList=plants(db);
  const eligibleSource=source&&source.status==='closed'&&Number(source.raw_bales)>0?source:null;
  const clientOptions=clientNames(db).map(name=>`<option value="${V.esc(name)}"></option>`).join('');
  const orderNotes=notesEditorField({label:'Uwagi do zlecenia',ariaLabel:'Uwagi dodatkowe do zlecenia'});
  const sourceDetails=eligibleSource?sourceDetailsView(db,eligibleSource):'<p class="muted finishing-source-placeholder" data-finishing-source-placeholder>Po wybraniu specyfikacji zostaną załadowane sztuki z tej wysyłki.</p>';
  const recipePicker=`<div class="finishing-recipe-picker"><div class="finishing-recipe-search-row"><div class="finishing-recipe-search-control"><label for="finishing-recipe-search">Receptura wykańczania</label><div class="finishing-recipe-search-box"><input id="finishing-recipe-search" type="search" role="combobox" data-finishing-recipe-search data-search-url="/finishing/orders/new?partial=recipes" autocomplete="off" placeholder="Wpisz nazwę lub symbol receptury" aria-autocomplete="list" aria-expanded="false" aria-controls="finishing-recipe-results"><div id="finishing-recipe-results" class="finishing-recipe-live-results" data-finishing-recipe-results role="listbox" aria-label="Pasujące receptury"></div></div></div><div class="finishing-recipe-search-actions"><a class="finishing-recipe-edit-shortcut" href="/finishing/recipes" target="_blank" rel="noopener" data-finishing-recipe-edit-shortcut aria-label="Otwórz bibliotekę receptur do edycji" title="Otwórz bibliotekę receptur do edycji"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20Z"/></svg></a><a class="finishing-recipe-add-shortcut" href="/finishing/recipes/new" target="_blank" rel="noopener" aria-label="Dodaj nową recepturę" title="Dodaj nową recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>Nowa receptura</span></a></div></div><input type="hidden" name="recipe_id" data-finishing-recipe><p class="finishing-recipe-selected" data-finishing-recipe-selected aria-live="polite"></p><details class="finishing-selected-recipe" data-finishing-selected-recipe hidden><summary><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><span>Podgląd całej receptury wykańczania</span></summary><pre class="preline" data-finishing-selected-recipe-text></pre></details><input type="hidden" name="last_production_note" value="" data-finishing-last-production-note></div>`;
  const orderTypes=`<div class="finishing-order-type-inline" role="radiogroup" aria-label="Rodzaj zlecenia"><label class="finishing-order-type-option"><input type="radio" name="order_type" value="standard" checked><span class="finishing-type-check" aria-hidden="true"></span><strong>Wykończenie standard</strong></label><label class="finishing-order-type-option"><input type="radio" name="order_type" value="raw_sale"><span class="finishing-type-check" aria-hidden="true"></span><strong>Sprzedaż surowej</strong></label><label class="finishing-order-type-option"><input type="radio" name="order_type" value="trial"><span class="finishing-type-check" aria-hidden="true"></span><strong>Próba</strong></label></div>`;
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Nowe zlecenie wykańczania</h1><p class="muted">Utwórz czytelne zlecenie z pozycją PM, recepturą i kompletem informacji dla wykończalni.</p></div></div>
    <form method="post" action="/finishing/orders" class="panel padded finishing-form" data-finishing-order-form data-source-url="/finishing/orders/new?partial=source" data-production-check-url="/finishing/orders/new?partial=last-production">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_last_production','')}
    <section class="finishing-order-section"><header class="finishing-order-section-heading"><span>01</span><div><h2>Specyfikacja i sztuki</h2><p>Wybierz PM z zamkniętej WZ. Sztuki zostaną załadowane do zlecenia.</p></div></header><label>PM ze specyfikacji wysyłkowej / WZ<select name="shipment_article_id" data-finishing-source required><option value="">Wybierz PM z WZ</option>${shipmentOptions(db,eligibleSource?.shipment_article_id||0)}</select></label><div class="finishing-source-details" data-finishing-source-details aria-live="polite">${sourceDetails}</div>${orderTypes}</section>
    <section class="finishing-order-section finishing-order-details"><header class="finishing-order-section-heading"><span>02</span><div><h2>Dane zlecenia</h2><p>Receptura wykańczania, wykańczalnia, klient i symbol handlowy.</p></div></header>${recipePicker}<div class="finishing-order-data-grid"><label>Wykańczalnia<select name="finishing_plant_id" data-finishing-plant><option value="">Wybierz wykańczalnię</option>${plantList.map(plant=>`<option value="${plant.id}"${eligibleSource?.finishing_plant_id===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><label>Klient (opcjonalnie)<input name="client_name" list="finishing-clients" maxlength="200"><datalist id="finishing-clients">${clientOptions}</datalist></label><label>Symbol handlowy<input name="trade_symbol" maxlength="200" data-finishing-trade-symbol></label><div class="finishing-additional-notes">${orderNotes}</div></div></section><div class="finishing-form-actions"><button type="submit" class="primary finishing-order-submit">Utwórz zlecenie</button></div></form>
    <dialog class="form-dialog finishing-production-check" data-finishing-production-check aria-labelledby="finishing-production-check-title"><div class="dialog-head"><strong id="finishing-production-check-title">Ostatnia produkcja</strong><button type="button" class="dialog-close" data-finishing-production-check-close aria-label="Zamknij">×</button></div><div class="dialog-body" data-finishing-production-check-content><p>Sprawdzam dane ostatniej produkcji…</p></div><div class="actions"><button type="button" data-finishing-production-check-cancel>Wróć do zlecenia</button><button type="button" class="primary" data-finishing-production-check-confirm disabled>Potwierdź i utwórz zlecenie</button></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Nowe zlecenie',body});
}
function recipeSearchView(db,query,plantId=0) {
  const terms=String(query||'').trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
  if(!terms.length)return '<p class="finishing-recipe-search-hint">Wpisz co najmniej 1 znak, np. fragment symbolu lub koloru.</p>';
  const matches=recipes(db,plantId).map(recipe=>({recipe,tradeSymbol:recipeTradeSymbol(recipe)})).filter(({recipe,tradeSymbol})=>{
    const details=readRecipeDetails(recipe),fields=[recipe.name,recipe.raw_symbol,tradeSymbol,recipe.recipe_text,recipe.target_color,details.rawMaterial,recipe.notes].map(normalizeSearch);
    return terms.every(term=>fields.some(field=>field.includes(term)));
  }).slice(0,30);
  const buttons=matches.map(({recipe,tradeSymbol})=>{
    const label=`${recipe.name}${recipe.raw_symbol?` · ${recipe.raw_symbol}`:''}`;
    const tradeParts=recipeTradeSymbolParts(recipe);
    return `<button type="button" id="finishing-recipe-option-${recipe.id}" role="option" aria-selected="false" class="finishing-recipe-result" data-finishing-recipe-option data-recipe-id="${recipe.id}" data-recipe-label="${V.esc(label)}" data-recipe-name="${V.esc(recipe.name)}" data-raw-symbol="${V.esc(recipe.raw_symbol||'')}" data-recipe-instruction="${V.esc(recipeTextFor(recipe))}" data-recipe-notes="${V.esc(recipe.notes||'')}" data-recipe-text="${V.esc(recipePreviewText(recipe))}" data-plant="${recipe.finishing_plant_id||''}" data-color="${V.esc(recipe.target_color||'')}" data-stiffening="${V.esc(recipe.target_stiffening||'')}" data-width="${recipe.target_width_cm??''}" data-grammage="${recipe.target_grammage??''}" data-trade-symbol="${V.esc(tradeParts.symbol)}" data-trade-color-symbol="${V.esc(tradeParts.color)}"><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Bez symbolu')}${tradeSymbol?` · ${V.esc(tradeSymbol)}`:''}${recipe.target_color?` · ${V.esc(recipe.target_color)}`:''}${recipe.finishing_plant_name?` · ${V.esc(recipe.finishing_plant_name)}`:''}</span></button>`;
  }).join('');
  return buttons?`<div class="finishing-recipe-result-list" role="group">${buttons}</div>`:'';
}
function ordersPage(ctx) {
  cleanupCorrectionRemainderPmrs(ctx.db);
  const q=String(ctx.url.searchParams.get('q')||'').trim(),status=String(ctx.url.searchParams.get('status')||'');
  const filters=['draft','sent','received','raw_sale','cancelled'];
  const all=ctx.db.prepare(`SELECT o.*,fp.name finishing_plant_name,a.description article_description,
      s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence,
      min(b.sent_at) sent_at,count(DISTINCT b.id) batch_count,
      coalesce((SELECT count(*) FROM shipment_bales psb WHERE psb.shipment_article_id=o.shipment_article_id AND psb.removed_at IS NULL),0) source_pm_pieces,
      round(coalesce((SELECT sum(pb.weight_kg) FROM shipment_bales psb JOIN production_bales pb ON pb.local_id=psb.bale_local_id WHERE psb.shipment_article_id=o.shipment_article_id AND psb.removed_at IS NULL),0),2) source_pm_weight_kg,
      min(CASE WHEN b.closed_at IS NULL AND trim(coalesce(b.finishing_lot,''))<>'' THEN b.id END) open_batch_id,
      '' finishing_lots,
      count(DISTINCT CASE WHEN trim(coalesce(b.finishing_lot,''))<>'' THEN b.id END) lot_batch_count,
      count(DISTINCT r.id) receipt_count,
      coalesce((SELECT count(*) FROM finishing_incidents i WHERE i.order_id=o.id AND i.status='open'),0) open_incidents,
      coalesce((SELECT group_concat(CASE i.incident_type
        WHEN 'lost' THEN 'Zagubiona belka' WHEN 'wrong_order' THEN 'Pomyłka w zamówieniu'
        WHEN 'correction' THEN 'Poprawa / zwrot' WHEN 'count_difference' THEN 'Różnica ilości'
        ELSE 'Inne' END || ': ' || trim(i.description), char(10))
        FROM finishing_incidents i WHERE i.order_id=o.id AND i.status='open'),'') open_incident_descriptions
    FROM finishing_orders o LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id LEFT JOIN articles a ON a.id=sa.article_id LEFT JOIN shipments s ON s.id=sa.shipment_id
    LEFT JOIN finishing_batches b ON b.order_id=o.id LEFT JOIN finishing_receipts r ON r.batch_id=b.id
    GROUP BY o.id ORDER BY o.created_at DESC,o.id DESC`).all();
  const batchesByOrder=new Map();
  for(const batch of ctx.db.prepare(`SELECT b.id,b.order_id,b.finishing_lot,b.sent_at,b.created_at,b.closed_at,b.sent_pieces,b.raw_weight_kg,b.workflow_status,b.cancelled_at,b.correction_parent_batch_id,b.correction_of_batch_id,b.correction_instruction,b.correction_notes,b.correction_trade_symbol,b.correction_target_color,b.correction_target_width_cm,b.correction_target_grammage,
      (SELECT count(*) FROM finishing_receipts r WHERE r.batch_id=b.id) receipt_count,
      coalesce((SELECT sum(r.raw_pieces_received) FROM finishing_receipts r WHERE r.batch_id=b.id),0) raw_received,
      coalesce((SELECT sum(i.lost_pieces) FROM finishing_incidents i WHERE i.batch_id=b.id AND i.auto_generated=1 AND i.incident_type='lost'),0) lost_pieces
    FROM finishing_batches b ORDER BY b.id`).all()) {
    if(!batchesByOrder.has(batch.order_id))batchesByOrder.set(batch.order_id,[]);
    batchesByOrder.get(batch.order_id).push(batch);
  }
  for(const order of all)order.finishing_lots=(batchesByOrder.get(order.id)||[]).map(batch=>finishingOrderNo(batch)||'Do uzupełnienia').join(', ');
  const query=normalizeSearch(q);
  const orderFullyReceived=order=>{
    if(order.order_type==='raw_sale'||order.status==='received')return true;
    const activeBatches=(batchesByOrder.get(order.id)||[]).filter(batch=>!batch.cancelled_at);
    return activeBatches.length>0&&activeBatches.every(batch=>Boolean(batch.closed_at));
  };
  const receiveDialogs=[];
  const rows=all.filter(order=>(!status||(status==='not_received'?!orderFullyReceived(order):order.status===status||(status==='sent'&&order.status==='partial')))&&(!query||[order.source_shipment_no,order.raw_symbol,order.article_description,order.manual_input_description,order.client_name,order.trade_symbol,order.finishing_plant_name,order.finishing_lots,order.manual_entry||order.article_sequence?pmReference(order):''].map(normalizeSearch).join(' ').includes(query))).map(order=>{
    const canReceive=editableRoles.includes(ctx.req.user.role)&&order.open_batch_id&&!['raw_sale','cancelled','received'].includes(order.status);
    const canEditLots=editableRoles.includes(ctx.req.user.role);
    const pm=pmReference(order);
    const batches=batchesByOrder.get(order.id)||[];
    const canDelete=editableRoles.includes(ctx.req.user.role);
    const remainderBatch=order.source_remainder_batch_id?batches.find(batch=>!batch.cancelled_at):null,remainderSettlement=remainderBatch?Costing.getSettlement(ctx.db,remainderBatch.id):null;
    const remainderSettlementBadge=remainderSettlement?`<span class="badge ${remainderSettlement.status==='settled'?'approved':'status-finishing'}" title="PMR ${remainderSettlement.status==='settled'?'rozliczona':'wysłana do rozliczenia'}">${remainderSettlement.status==='settled'?'Rozliczona':'W rozliczeniu'}</span>`:'';
    const remainderAction=order.source_remainder_batch_id&&remainderBatch&&canDelete&&!remainderSettlement?`<form method="post" action="/finishing/orders/${order.id}/send-to-settlement" class="finishing-row-action-form">${hidden('csrf',ctx.req.session.csrf)}<button class="finishing-row-action is-send-settlement" aria-label="Wyślij ${V.esc(pm)} do rozliczenia" title="Wyślij do rozliczenia"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg></button></form>`:'';
    const activeBatches=batches.filter(batch=>!batch.cancelled_at);
    const correctionState=activeBatches.length&&activeBatches.every(batch=>batch.workflow_status==='do_poprawy')?'do_poprawy':activeBatches.some(batch=>batch.workflow_status==='poprawka')?'poprawka':null;
    const pmPieces=order.manual_entry?activeBatches.reduce((sum,batch)=>sum+Number(batch.sent_pieces||0),0):Number(order.source_pm_pieces||0),pmWeight=order.manual_entry?activeBatches.reduce((sum,batch)=>sum+Number(batch.raw_weight_kg||0),0):Number(order.source_pm_weight_kg||0),pmTooltip=`PM: ${pmPieces} szt. · ${money(pmWeight)} kg`;
    const baseBatch=activeBatches.find(batch=>!batch.correction_parent_batch_id&&!batch.correction_of_batch_id),unassignedPieces=unassignedOrderPieces(ctx.db,order,activeBatches);
    const canAddSpec=editableRoles.includes(ctx.req.user.role)&&order.order_type!=='raw_sale'&&!['raw_sale','cancelled'].includes(order.status)&&(!['received'].includes(order.status)||unassignedPieces>0)&&(order.receipt_count===0||unassignedPieces>0)&&batches.length>0&&baseBatch&&Number(baseBatch.sent_pieces)>0;
    const canReceiveBatch=editableRoles.includes(ctx.req.user.role)&&!['raw_sale','cancelled'].includes(order.status);
    const receiveActionsByBatch=new Map();
    const addBatchAction=(batchId,action)=>{if(!action)return;if(!receiveActionsByBatch.has(batchId))receiveActionsByBatch.set(batchId,[]);receiveActionsByBatch.get(batchId).push(action);};
    const receiveButtonForBatch=(batch,inline=false)=>{
      if(!canReceiveBatch||batch.cancelled_at||batch.closed_at||batch.workflow_status==='do_poprawy'||(isAdditionalPmBatch(ctx.db,order,batch)&&batch.receipt_count>0))return '';
      const dialogId=`finishing-receive-${batch.id}`;
      const receiptOrder={...order,trade_symbol:batch.correction_trade_symbol||order.trade_symbol,target_color:batch.correction_target_color||order.target_color,target_width_cm:batch.correction_target_width_cm??order.target_width_cm,target_grammage:batch.correction_target_grammage??order.target_grammage};
      receiveDialogs.push(receiptDialog(ctx,receiptOrder,batch,pm));
      const correctionBatch=Boolean(batch.correction_parent_batch_id||batch.correction_of_batch_id),openDialog=correctionBatch?`finishing-correction-info-${batch.id}`:dialogId;
      const button=`<button type="button" class="finishing-row-action is-receive" data-batch-receive="${batch.id}" data-correction-batch="${correctionBatch?'1':'0'}" data-open-dialog="${openDialog}" aria-label="Przyjmij sztuki ${V.esc(pm)} · ${V.esc(batch.finishing_lot||'bez numeru')}" title="${String(batch.finishing_lot||'').trim()?'Przyjmij':'Najpierw wpisz nr zlecenia barwiarskiego'}"${String(batch.finishing_lot||'').trim()?'':' disabled'}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>`;
      if(inline)return button;
      addBatchAction(batch.id,button);
      return '';
    };
    const lotCell=batches.length?`<div class="finishing-order-lot-list">${batches.map((batch,index)=>{
      const canRemoveThisSpec=canEditLots&&isAdditionalPmBatch(ctx.db,order,batch)&&!batch.cancelled_at&&batch.workflow_status!=='poprawka';
      const removeSpec=canRemoveThisSpec?(Number(batch.receipt_count)>0?`<span class="finishing-disabled-spec-delete" title="Aby usunąć dodatkowe zlecenie, najpierw cofnij jego przyjęcie." aria-label="Aby usunąć dodatkowe zlecenie, najpierw cofnij jego przyjęcie." tabindex="0"><button type="button" class="finishing-remove-spec-button" aria-label="Nie można usunąć przyjętej partii" disabled><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></span>`:`<form method="post" action="/finishing/orders/${order.id}/batches" class="finishing-order-remove-spec-form" data-finishing-batch-delete data-batch-label="${V.esc(batch.finishing_lot||'bez numeru')}">${hidden('csrf',ctx.req.session.csrf)}${hidden('return_to','orders')}${hidden('remove_batch_id',batch.id)}<button type="submit" class="finishing-remove-spec-button" aria-label="Usuń dodatkowe zlecenie ${V.esc(batch.finishing_lot||'bez numeru')}" title="Usuń dodatkowe zlecenie"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></form>`):'';
      const undoCorrectionChild=batch.workflow_status==='do_poprawy'?ctx.db.prepare(`SELECT id FROM finishing_batches b WHERE b.correction_parent_batch_id=? AND b.cancelled_at IS NULL AND b.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM finishing_receipts r WHERE r.batch_id=b.id) AND NOT EXISTS(SELECT 1 FROM finishing_batches child WHERE child.correction_parent_batch_id=b.id OR child.correction_of_batch_id=b.id) ORDER BY b.id DESC LIMIT 1`).get(batch.id):null;
      const undoCorrection=undoCorrectionChild&&canEditLots?`<form method="post" action="/finishing/batches/${batch.id}/undo-send-to-correction" class="finishing-order-remove-spec-form">${hidden('csrf',ctx.req.session.csrf)}${hidden('return_to','orders')}<button type="submit" class="finishing-remove-spec-button finishing-undo-correction-button" aria-label="Usuń poprawę" title="Usuń poprawę"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></form>`:'';
      const addSpec=canAddSpec&&index===batches.length-1&&batch.workflow_status==='normal'?`<form method="post" action="/finishing/orders/${order.id}/batches" class="finishing-order-add-spec-form">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="return_to" value="orders"><button type="submit" class="finishing-add-spec-button" aria-label="Dodaj kolejną partię" title="Dodaj kolejną partię"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></form>`:'';
      if(batch.cancelled_at)return `<div class="finishing-order-lot-entry"><span class="badge archived">Anulowana</span>${String(batch.finishing_lot||'').trim()?`<strong class="finishing-order-lot">${V.esc(finishingOrderNo(batch))}</strong>`:'<span class="muted">Próba anulowana</span>'}${removeSpec}</div>`;
      if(canEditLots&&batch.workflow_status!=='do_poprawy'){
        if(batch.workflow_status==='poprawka'){
          const correctionPrint=`<a class="finishing-row-action" href="/finishing/orders/${order.id}/print?batch_id=${batch.id}" target="_blank" rel="noopener" aria-label="Drukuj poprawkę ${V.esc(pm)}" title="Drukuj"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5h-2"/><path d="M7 14h10v7H7zM18 11h.01"/></svg></a>`;
          addBatchAction(batch.id,`${correctionPrint}${receiveButtonForBatch(batch,true)}`);
        }else receiveButtonForBatch(batch);
        return `<div class="finishing-order-lot-entry${batch.workflow_status==='poprawka'?' is-correction-attempt':''}"><form method="post" action="/finishing/orders/${order.id}/lot" class="finishing-order-lot-inline" data-finishing-lot-autosave>${hidden('csrf',ctx.req.session.csrf)}${hidden('batch_id',batch.id)}${hidden('return_to','orders')}<input name="finishing_lot" maxlength="120" value="${V.esc(batch.finishing_lot||'')}" placeholder="Wpisz nr zlecenia" aria-label="Nr zlecenia"></form>${removeSpec}${addSpec}</div>`;
      }
      receiveButtonForBatch(batch);
      const lotDisplay=String(batch.finishing_lot||'').trim()?`<strong class="finishing-order-lot">${V.esc(finishingOrderNo(batch))}</strong>`:'<span class="muted">W drodze</span>';
      return `<div class="finishing-order-lot-entry${batch.workflow_status==='do_poprawy'?' is-correction-requested':''}">${lotDisplay}${batch.workflow_status==='do_poprawy'?undoCorrection:removeSpec}${addSpec}</div>`;
    }).join('')}</div>`:'—';
    const receiveActionStack=batches.length>1?`<div class="finishing-order-receive-actions">${batches.slice(1).map(batch=>`<div class="finishing-order-batch-actions-row">${(receiveActionsByBatch.get(batch.id)||[]).join('')}</div>`).join('')}</div>`:'';
    const incidentTooltip=String(order.open_incident_descriptions||'').trim();
    const incidentBadge=order.open_incidents?` <span class="badge archived finishing-problem-tooltip" title="${V.esc(incidentTooltip)}" aria-label="Problemy: ${order.open_incidents}. ${V.esc(incidentTooltip)}" tabindex="0">Problemy: ${order.open_incidents}</span>`:'';
    const batchStatusLabel=batch=>finishingBatchStatusLabel(ctx.db,order,batch);
    const batchStatusClass=batch=>finishingBatchStatusClass(ctx.db,order,batch);
    const batchStatusBadge=batch=>{const label=batchStatusLabel(batch),correctionNumber=label==='Wys. do poprawy'?activeCorrectionOrderNumber(ctx.db,batch.id):'',displayLabel=label==='Wys. do poprawy'?`Poprawa spec.${correctionNumber?`: ${V.esc(correctionNumber)}`:''}`:label;return `<span class="badge ${batchStatusClass(batch)}">${displayLabel}</span>`;};
    const trialStatusBadge=order.order_type==='trial'?'<span class="badge finishing-trial-status">Próba</span>':'';
    const statusCellContent=order.source_remainder_batch_id?`<div class="finishing-order-batch-status-row" data-batch-status="${remainderBatch?.id||''}">${trialStatusBadge}${String(remainderBatch?.finishing_lot||'').trim()?statusBadge('sent'):'<span class="badge finishing-remainder-status" title="PMR utworzona z brakującej ilości po przyjęciu">Braki z wykańczalni</span>'}${remainderSettlementBadge}</div>${incidentBadge}`:batches.length?`<div class="finishing-order-batch-status-list">${batches.map((batch,index)=>`<div class="finishing-order-batch-status-row" data-batch-status="${batch.id}">${index===0?trialStatusBadge:''}${batchStatusBadge(batch)}${index===0?incidentBadge:''}</div>`).join('')}</div>`:`${trialStatusBadge}${statusBadge(correctionState||order.status)}${incidentBadge}`;
    const statusCell=statusCellContent;
    return `<tr class="${correctionState==='do_poprawy'?'finishing-order-needs-correction':''}"><td>${dateOnlyPl(order.sent_at||order.created_at)}</td><td>${V.esc(order.finishing_plant_name||'—')}</td><td><strong>${V.esc(order.raw_symbol)}</strong></td><td>${V.esc(order.client_name||'—')}</td><td>${V.esc(order.trade_symbol||'—')}</td><td><a class="finishing-order-pm${order.manual_entry?' is-manual':''}" href="/finishing/orders/${order.id}" title="${V.esc(pmTooltip)}" aria-label="${V.esc(pm)} · ${V.esc(pmTooltip)}">${V.esc(pm)}</a></td><td>${lotCell}</td><td>${statusCell}</td><td class="finishing-row-actions finishing-order-actions-cell"><div class="finishing-order-actions-inline">${correctionState==='do_poprawy'&&editableRoles.includes(ctx.req.user.role)?`<a class="finishing-row-action" href="/finishing/orders/${order.id}/edit" aria-label="Edytuj PM ${V.esc(pm)}" title="Edytuj PM">✎</a>`:''}${remainderAction}${batches.length?(receiveActionsByBatch.get(batches[0].id)||''):''}<a class="finishing-row-action" href="/finishing/orders/${order.id}/print" target="_blank" rel="noopener" aria-label="Drukuj pierwotne zlecenie ${V.esc(pm)}" title="Drukuj pierwotne zlecenie"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M7 14h10v7H7zM18 11h.01"/></svg></a>${canDelete?`<a class="finishing-row-action is-delete" href="/finishing/orders/${order.id}/delete" aria-label="Usuń zlecenie ${V.esc(pm)}" title="Usuń zlecenie"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></a>`:''}</div>${receiveActionStack}</td></tr>`;
  }).join('');
  const body=`${navTabs('orders',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Zlecenia wykańczania</h1><p class="muted">Zlecenie oznacza wyjście PM do farbiarni. Przyjęcie belek rozpoczniesz z listy przyciskiem „+”.</p></div><div class="actions"><a class="button" href="/finishing/orders/outstanding-report">Raport zaległości</a><a class="button" href="/finishing/orders/manual">+ Zlecenie ręczne</a><a class="button primary" href="/finishing/orders/new">+ Nowe zlecenie</a></div></div>
    <form method="get" action="/finishing/orders" class="shipment-list-filters" data-live-search data-live-search-min="2"><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Wpisz co najmniej 2 znaki: symbol, opis, klient, PM"></label><label>Status<select name="status"><option value="">Wszystkie</option><option value="not_received"${status==='not_received'?' selected':''}>Wszystkie bez przyjętych</option>${filters.map(value=>`<option value="${value}"${status===value?' selected':''}>${orderStatusLabel(value)}</option>`).join('')}</select></label></form>
    <div data-live-results><div class="panel scroll"><table class="listing compact finishing-orders-list"><thead><tr><th>Data wysyłki</th><th>Farbiarnia</th><th>Symbol dzianiny (surowej)</th><th>Klient</th><th>Symbol handlowy</th><th>PM</th><th>Nr zlecenia barw.</th><th>Status</th><th>Akcje</th></tr></thead><tbody>${rows||`<tr><td colspan="9">${all.length?'Brak zleceń dla wybranych filtrów.':'Brak zleceń wykańczania.'}</td></tr>`}</tbody></table></div>${receiveDialogs.join('')}</div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Zlecenia wykańczania',body});
}
function outstandingReportPage(ctx,asOf){
  const rows=ctx.db.prepare(`SELECT o.raw_symbol,b.id batch_id,b.sent_pieces,b.raw_weight_kg,
      coalesce((SELECT sum(r.raw_pieces_received) FROM finishing_receipts r WHERE r.batch_id=b.id AND substr(r.received_at,1,10)<=?),0) received_pieces,
      coalesce((SELECT sum(r.used_weight_kg) FROM finishing_receipts r WHERE r.batch_id=b.id AND substr(r.received_at,1,10)<=?),0) received_kg,
      coalesce((SELECT sum(i.lost_pieces) FROM finishing_incidents i WHERE i.batch_id=b.id AND i.auto_generated=1 AND i.incident_type='lost'
        AND substr(i.created_at,1,10)<=? AND (i.found_at IS NULL OR substr(i.found_at,1,10)>?) AND (i.settled_at IS NULL OR substr(i.settled_at,1,10)>?)),0) lost_pieces,
      coalesce((SELECT sum(i.lost_weight_kg) FROM finishing_incidents i WHERE i.batch_id=b.id AND i.auto_generated=1 AND i.incident_type='lost'
        AND substr(i.created_at,1,10)<=? AND (i.found_at IS NULL OR substr(i.found_at,1,10)>?) AND (i.settled_at IS NULL OR substr(i.settled_at,1,10)>?)),0) lost_kg
    FROM finishing_batches b JOIN finishing_orders o ON o.id=b.order_id
    WHERE o.status<>'cancelled' AND o.source_remainder_batch_id IS NULL AND b.cancelled_at IS NULL AND substr(coalesce(nullif(b.sent_at,''),b.created_at),1,10)<=?
      AND (coalesce(b.raw_weight_kg,0)>0 OR coalesce(b.sent_pieces,0)>0)
    ORDER BY o.raw_symbol COLLATE NOCASE,b.id`).all(asOf,asOf,asOf,asOf,asOf,asOf,asOf,asOf,asOf);
  const bySymbol=new Map();
  for(const item of rows){
    const symbol=String(item.raw_symbol||'Nieznany surowiec').trim()||'Nieznany surowiec';
    if(!bySymbol.has(symbol))bySymbol.set(symbol,{symbol,plantPieces:0,plantKg:0,lostPieces:0,lostKg:0});
    const target=bySymbol.get(symbol),sentPieces=Number(item.sent_pieces||0),sentKg=Number(item.raw_weight_kg||0),receivedPieces=Number(item.received_pieces||0),receivedKg=Number(item.received_kg||0),lostPieces=Number(item.lost_pieces||0),lostKg=Number(item.lost_kg||0);
    target.plantPieces+=Math.max(0,sentPieces-receivedPieces-lostPieces);target.plantKg+=Math.max(0,sentKg-receivedKg-lostKg);target.lostPieces+=lostPieces;target.lostKg+=lostKg;
  }
  const reportRows=[];
  for(const value of bySymbol.values()){
    if(value.plantPieces>0||value.plantKg>0)reportRows.push({...value,kind:'W wykańczalni',pieces:value.plantPieces,kg:value.plantKg});
    if(value.lostPieces>0||value.lostKg>0)reportRows.push({...value,kind:'Zagubione / zniszczone',pieces:value.lostPieces,kg:value.lostKg});
  }
  const totalKg=reportRows.reduce((sum,row)=>sum+row.kg,0),dateLabel=V.datepl(asOf);
  const body=`${navTabs('orders',ctx.db)}<article class="finishing-outstanding-report"><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Raport zaległości wykańczalni</h1><p class="muted">Stan na ${V.esc(dateLabel)} · grupowanie według symbolu surowego.</p></div><button type="button" data-print-page>Drukuj raport</button></div><form method="get" action="/finishing/orders/outstanding-report" class="shipment-list-filters"><label>Stan na dzień<input type="date" name="date" value="${V.esc(asOf)}" required></label><button class="primary">Pokaż raport</button></form><div class="panel scroll"><table class="listing compact"><thead><tr><th>Symbol surowy</th><th>Pozycja</th><th>Liczba sztuk</th><th>Masa kg</th></tr></thead><tbody>${reportRows.map(row=>`<tr class="${row.kind==='Zagubione / zniszczone'?'finishing-outstanding-lost':''}"><td><strong>${V.esc(row.symbol)}</strong></td><td>${row.kind}</td><td>${qty(row.pieces)} szt.</td><td>${money(row.kg)} kg</td></tr>`).join('')||'<tr><td colspan="4">Brak zaległości dla wybranego dnia.</td></tr>'}<tr class="finishing-outstanding-total"><th colspan="3">Łącznie w wykańczalni i braki</th><th>${money(totalKg)} kg</th></tr></tbody></table></div><p class="muted small">Wiersz „W wykańczalni” pokazuje wysłane kg i sztuki pomniejszone o przyjęcia oraz braki. Zagubione i zniszczone sztuki są wykazane osobno.</p></article>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Raport zaległości wykańczalni',body});
}
function deleteOrderConfirmPage(ctx,order) {
  const cancelUrl='/finishing/orders';
  const pm=pmReference(order);
  const isRemainderPmr=Boolean(order.source_remainder_batch_id);
  const explanation=isRemainderPmr
    ?'Usunięte zostanie tylko automatyczne PMR wraz z jego przyjęciami i rozliczeniem. Brakująca ilość pozostanie zapisana na pierwotnym zleceniu w „Zagubione/zniszczone” i będzie można ponownie utworzyć dla niej PMR.'
    :'Usunięte zostaną zlecenie barwiarskie, jego poprawki, przyjęcia, zgłoszenia zagubień i rozliczenia. Pozycja PM i jej belki wrócą do dostępnych wysyłek.';
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="${cancelUrl}">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Usuń zlecenie wykańczania</h1></div></div><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Potwierdź usunięcie zlecenia</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrane zlecenie:</p><h2 class="delete-confirm-object">${V.esc(pm)} · ${V.esc(order.raw_symbol)} · ${V.esc(order.client_name||'—')}</h2><div class="shipment-cancel-details"><div class="shipment-cancel-detail-row"><strong>Skutek</strong><span>${explanation}</span></div><div class="shipment-cancel-detail-row"><strong>Historia</strong><span>Wpis audytowy pozostanie zachowany.</span></div></div><form method="post" action="/finishing/orders/${order.id}/delete" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_order','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Usuń ${V.esc(pm)}</button></form></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Usuń zlecenie',body});
}
function manualOrderCreatePage(ctx) {
  const db=ctx.db,plants=db.prepare('SELECT id,name FROM finishing_plants WHERE active=1 ORDER BY name COLLATE NOCASE').all();
  const plantOptions=plants.map(plant=>`<option value="${plant.id}">${V.esc(plant.name)}</option>`).join('');
  const body=`${navTabs('orders',db)}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE · PMR</span><h1>Nowe zlecenie ręczne</h1><p class="muted">Wpisz znane dane. Pozostałe pola możesz uzupełnić później. PMR zostanie utworzona dopiero po zapisaniu formularza.</p></div></div>
  <form method="post" action="/finishing/orders/manual" class="panel padded finishing-order-edit-form">${hidden('csrf',ctx.req.session.csrf)}
    <section class="finishing-order-section"><h2>Dane zlecenia</h2><div class="finishing-batch-summary-row finishing-manual-create-summary"><div class="finishing-manual-date-recipe"><label>Data wysyłki<input name="sent_at" type="date" value="${V.todayInput()}"></label><div class="finishing-manual-recipe-picker" data-finishing-manual-recipe-picker data-search-url="/finishing/orders/new?partial=recipes"><label for="manual-recipe-search">Receptura barwiarska (opcjonalnie)</label><div class="finishing-recipe-search-box"><input id="manual-recipe-search" type="search" role="combobox" data-finishing-manual-recipe-search placeholder="Wpisz nazwę lub symbol" autocomplete="off" aria-autocomplete="list" aria-expanded="false"><div class="finishing-recipe-live-results" data-finishing-manual-recipe-results role="listbox" aria-label="Pasujące receptury"></div></div><input type="hidden" name="recipe_id" value="" data-finishing-manual-recipe><small class="muted" data-finishing-manual-recipe-selected>Nie wybrano receptury</small></div></div><label>Sztuki wysłane<input name="sent_pieces" type="number" min="0" step="1" placeholder="Możesz uzupełnić później"></label><label>Masa wysłana kg<input name="raw_weight_kg" type="number" min="0" step="0.01" placeholder="Możesz uzupełnić później"></label><label>LOT przędzy<input name="yarn_lot" maxlength="250"></label></div>
    <div class="form-grid"><label>Symbol surowca<input name="raw_symbol" maxlength="200"></label><label>Symbol handlowy<input name="trade_symbol" maxlength="200"></label><label>Klient<input name="client_name" maxlength="200"></label><label>Wykańczalnia<select name="finishing_plant_id"><option value="">Nie wybrano</option>${plantOptions}</select></label><label>Kolor zadany<input name="target_color" maxlength="160"></label><label>Usztywnienie<input name="target_stiffening" maxlength="2000"></label><label>Gramatura g/m²<input name="target_grammage" type="number" min="0.1" step="0.1"></label><label>Szerokość cm<input name="target_width_cm" type="number" min="0.1" step="0.1"></label></div>
    <label>Źródła / opis materiału<textarea name="manual_input_description" rows="3" maxlength="3000"></textarea></label>${notesEditorField({label:'Uwagi do zlecenia',ariaLabel:'Uwagi do zlecenia'})}</section>
    <section class="finishing-order-section"><h2>Receptura zapisana przy zleceniu</h2><div class="form-grid"><label>Nazwa receptury<input name="recipe_name" maxlength="200"></label><label>Receptura / instrukcja<textarea name="recipe_text" rows="8" maxlength="20000"></textarea></label></div>${notesEditorField({name:'recipe_notes',label:'Uwagi receptury',ariaLabel:'Uwagi receptury'})}</section>
    <div class="actions"><a class="button" href="/finishing/orders">Wróć</a><button class="primary">Zapisz zlecenie ręczne</button></div>
  </form>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Nowe zlecenie ręczne',body});
}
function manualLabelsPage(ctx) {
  const options=[['symbol','Symbol handlowy',true],['color','Kolor',true],['lot','Nr partii / zlecenie barwiarskie',true],['width','Szerokość',true],['grammage','Gramatura',true],['raw','Symbol surowy',false],['client','Klient',false],['distance','Dystans [mm]',false],['extra','Dodatkowy tekst',false]];
  const rows=options.map(([key,label,checked])=>`<label class="finishing-label-option"><input type="checkbox" data-manual-field="${key}"${checked?' checked':''}><span>${label}</span></label>`).join('');
  const fields=options.map(([key,label,checked])=>`<label class="manual-label-input" data-input-for="${key}"${checked?'':' hidden'}>${label}<input type="text" data-label-input="${key}" maxlength="120"${key==='distance'?' inputmode="decimal"':''}></label>`).join('');
  const body=`${navTabs('labels',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Drukowanie etykiet</h1><p class="muted">Wprowadź dane i wydrukuj etykietę według wzorca standardowego. Dane są używane tylko do tego wydruku i nie są zapisywane.</p></div></div>
    <section class="panel manual-label-workspace"><div class="manual-label-preview-panel"><div class="labels manual-label-preview-list" data-manual-labels><article class="label finishing-label-preview" data-manual-label><img class="label-logo" data-label-brand src="/static/marand-label-logo.png" alt="MARAND Technical textiles"><div class="label-content" data-manual-label-content></div></article></div><small data-label-count>Podgląd etykiety · 50 × 74 mm</small><fieldset class="finishing-label-language manual-label-language"><legend>Język etykiety</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="manual_language" value="pl" checked><span>Polski</span></label><label class="finishing-label-option"><input type="radio" name="manual_language" value="en"><span>English</span></label></div></fieldset></div>
    <div class="manual-label-controls"><fieldset><legend>Górna część etykiety</legend><div class="manual-label-brand-options"><label><input type="radio" name="manual_brand_mode" value="logo" checked> Logo MARAND</label><label><input type="radio" name="manual_brand_mode" value="text"> Własny tekst</label></div><label class="manual-label-input" data-brand-text-field hidden>Tekst u góry<input type="text" maxlength="80" data-label-input="brand"></label></fieldset><fieldset><legend>Pola etykiety</legend>${rows}<div class="manual-label-values">${fields}</div></fieldset><fieldset><legend>Ilość belek</legend><div class="manual-label-quantities"><label>Metry [mb] (np.: 100,101,102)<input type="text" inputmode="decimal" data-label-input="meters" placeholder="100,101,102"></label><label>Waga [kg] w tej samej kolejności (np.: 22,1,22,2,22,3)<input type="text" inputmode="decimal" data-label-input="weight" placeholder="22,1,22,2,22,3"></label></div><p class="muted small manual-label-list-hint">Każda wartość tworzy osobną etykietę. Wagi wpisuj parami z przecinkiem dziesiętnym albo rozdzielaj średnikiem (np.: 22,1;22,2;22,3).</p><div class="manual-label-quantity-options"><label><input type="radio" name="manual_quantity_unit" value="meters" checked> MB</label><label><input type="radio" name="manual_quantity_unit" value="weight"> KG</label><label><input type="checkbox" data-label-secondary checked> Pokaż też drugą jednostkę mniejszą czcionką</label></div><p class="manual-label-validation" data-label-validation hidden role="alert"></p></fieldset><div class="manual-label-actions"><button type="button" class="primary" data-label-print>Drukuj etykiety</button><span class="muted small">Liczbę kopii wybierzesz w oknie drukowania.</span></div></div></section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Drukowanie etykiet',body:`<div class="manual-label-page">${body}</div><link rel="stylesheet" href="/static/finishing-label-generator.css"><link rel="stylesheet" href="/static/finishing-labels.css"><script src="/static/finishing-labels.js" defer></script><script src="/static/finishing-label-generator.js" defer></script>`});
}
function labelPage(ctx,receiptId) {
  const receipt=ctx.db.prepare(`SELECT r.*,b.finishing_lot,b.sent_at,o.recipe_id,o.recipe_snapshot,o.raw_symbol,o.trade_symbol,o.client_name,o.target_color,o.target_width_cm,o.target_grammage FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id JOIN finishing_orders o ON o.id=b.order_id WHERE r.id=?`).get(receiptId);
  if(!receipt)throw Object.assign(new Error('Nie znaleziono przyjęcia.'),{status:404});
  const params=ctx.url.searchParams,bales=ctx.db.prepare('SELECT * FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receiptId),applied=params.has('settings_applied'),recipe=receipt.recipe_id?recipeRecord(ctx.db,receipt.recipe_id):null,defaults=labelTemplate(recipe?.label_settings),fields=Object.fromEntries(LABEL_TEMPLATE_FIELDS.map(key=>[key,applied?params.get(`label_field_${key.replace(/-/g,'_')}`)==='1':defaults.fields[key]]));
  fields.client=false;
  const requestedBrand=params.get('brand_mode'),brandMode=applied?(['logo','text','client-logo','none'].includes(requestedBrand)?requestedBrand:'none'):(defaults.brandMode||'logo');
  const settings=labelTemplate({fields,brandMode,brandText:applied?(params.get('brand_text')||''):defaults.brandText,clientLogo:defaults.clientLogo,colorText:applied?(params.get('color_text')||''):defaults.colorText,extraText:applied?(params.get('extra_text')||''):defaults.extraText,distance:applied?(params.get('distance')||''):defaults.distance,language:applied?(params.get('lang')||'pl'):defaults.language,quantityUnit:applied?(params.get('quantity_unit')||'meters'):defaults.quantityUnit,includeMeters:applied?params.get('include_meters')==='1':defaults.includeMeters});
  let recipeSnapshot={};try{recipeSnapshot=JSON.parse(receipt.recipe_snapshot||'{}')}catch{};
  const recipeDetails=recipeSnapshot.details||{},tradeParts=recipeTradeSymbolParts({name:recipeSnapshot.name,finishing_plant_name:recipeSnapshot.finishingPlant,trade_symbol:receipt.trade_symbol,recipe_details:JSON.stringify(recipeDetails)}),client=String(params.get('client_name')||receipt.client_name||'').slice(0,200),parts=String(receipt.trade_symbol||'').split('/'),symbol=tradeParts.symbol||((parts.shift()||'').trim())||receipt.raw_symbol||'—',colorMatch=parts.join('/').match(/^\s*(\d{2}-\d{2})/),color=settings.colorText||tradeParts.color||receipt.actual_color||colorMatch?.[1]||receipt.target_color||'—',lot=String(receipt.finishing_lot||'').trim().replace(/^(.*\/.*)\/(?:\d{2}|\d{4})$/,'$1'),words=settings.language==='en'?{symbol:'INDEX',raw:'GREIGE INDEX',color:'COLOR',lot:'BATCH NO.',width:'WIDTH',grammage:'WEIGHT',client:'CLIENT',weight:'WEIGHT [kg]',distance:'DISTANCE',meters:'QUANTITY [m]',kg:'QUANTITY [kg]',extraMeters:'LENGTH [m]'}:{symbol:'SYMBOL',raw:'SYMBOL SUROWY',color:'KOLOR',lot:'NR PARTII',width:'SZEROKOŚĆ',grammage:'GRAMATURA',client:'KLIENT',weight:'WAGA [kg]',distance:'DYSTANS',meters:'ILOŚĆ [mb]',kg:'ILOŚĆ [kg]',extraMeters:'DŁUGOŚĆ [m]'};
  const labelFor=(b,preview=false)=>{
    const definitions=[['symbol',words.symbol,symbol,''],['raw-symbol',words.raw,receipt.raw_symbol||'—',''],['color',words.color,color,''],['lot',words.lot,lot||'—',''],['width',words.width,receipt.actual_width_cm??receipt.target_width_cm??'—',' cm'],['grammage',words.grammage,receipt.actual_grammage??receipt.target_grammage??'—',' g/m²'],['distance',words.distance,settings.distance||'—',' mm'],['weight',words.weight,b.weight_kg==null?'—':qty(b.weight_kg),' kg'],['extra-text','',settings.extraText||'','']];
    const fields=definitions.map(([key,label,value,unit])=>({key,label,value,unit,show:Boolean(settings.fields[key]&&(key!=='extra-text'||settings.extraText))}));
    const main=settings.quantityUnit==='weight'?b.weight_kg:b.meters,quantityWord=settings.quantityUnit==='weight'?words.kg:words.meters;
    return LabelRenderer.render({language:settings.language,brandMode:settings.brandMode,brandText:settings.brandText,clientLogo:settings.clientLogo,fields,preview,rootClass:preview?'finishing-label-preview':'',quantity:{label:quantityWord,value:main===null?'—':qty(main),meters:b.meters===null?'—':qty(b.meters),kg:b.weight_kg===null?'—':qty(b.weight_kg),secondaryLabel:words.extraMeters,secondaryValue:settings.quantityUnit==='weight'&&settings.includeMeters&&b.meters!==null?qty(b.meters):''}});
  };
  const labels=bales.map(b=>labelFor(b)).join(''),preview=labelFor(bales[0]||{meters:null,weight_kg:null},true);
  const fieldOption=(key,label,control='')=>key==='client'?'':`<div class="finishing-label-option-with-input"><label class="finishing-label-option"><input type="checkbox" name="label_field_${key.replace(/-/g,'_')}" value="1"${settings.fields[key]?' checked':''}><span>${label}</span></label>${control}</div>`;
  const languageOptions=`<fieldset class="finishing-label-language"><legend>Język etykiety</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="lang" value="pl"${settings.language==='pl'?' checked':''}><span>Polski</span></label><label class="finishing-label-option"><input type="radio" name="lang" value="en"${settings.language==='en'?' checked':''}><span>English</span></label></div></fieldset>`;
  const html=`<!doctype html><html lang="${settings.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Etykiety partii ${V.esc(lot||receiptId)}</title><link rel="icon" type="image/png" href="/static/favicon.png?v=${V.FAVICON_CACHE_VERSION}"><link rel="stylesheet" href="/static/app.css"><script src="/static/finishing-labels.js" defer></script><style>@page{size:50mm 74mm;margin:0}body{margin:0;background:#f3f5f6;color:#17212b;font:14px Arial,sans-serif}.toolbar{display:flex;gap:10px;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #dce1e5;position:sticky;top:0;z-index:2}.labels{display:flex;gap:12px;flex-wrap:wrap;padding:18px}.label{width:50mm;height:74mm;padding:2.5mm 3mm;overflow:hidden;page-break-after:always;break-after:page;position:relative;display:flex;flex-direction:column;background:#fff;color:#111;font:8pt/1.18 Arial,sans-serif}.label-logo{display:block;max-width:44mm;width:auto;height:auto;max-height:13mm;object-fit:contain;object-position:center;margin:0 auto 2mm}.label-custom-brand{min-height:12mm;display:flex;align-items:center;font-size:12pt;font-weight:700;margin:0 0 2mm}.label-content{display:flex;flex:1;flex-direction:column;gap:1.1mm;min-height:0;position:relative;padding-bottom:13mm;overflow:hidden}.label-row{display:flex;flex:0 0 auto;flex-wrap:nowrap;justify-content:space-between;align-items:baseline;gap:2mm;border-bottom:.2mm solid #d5d8da;padding-bottom:.6mm}.label-row-before-quantity{border-bottom:0;padding-bottom:0}.label-row span{font-size:6.2pt;color:#525a62;flex:0 0 auto;white-space:nowrap}.label-row strong{font-size:calc(10.5pt * var(--label-data-scale,1) * var(--label-row-scale,1));line-height:1.05;text-align:right;white-space:nowrap;overflow-wrap:normal;min-width:0}.label-extra-text{justify-content:flex-start;white-space:nowrap;overflow-wrap:normal}.label-quantity{position:absolute;left:0;right:0;bottom:0;margin:0;padding-top:2mm;display:flex;flex:0 0 auto;flex-wrap:nowrap;justify-content:space-between;align-items:baseline;border-top:.5mm solid #222}.label-quantity>div{display:grid;gap:.5mm;white-space:nowrap}.label-quantity span{font-size:7pt;font-weight:700}.label-quantity strong{font-size:calc(18pt * var(--label-quantity-scale,1));line-height:1.1;white-space:nowrap}.label-secondary-quantity{font-size:7pt;font-weight:600}.label-settings{width:min(1060px,calc(100vw - 24px));max-width:1060px;max-height:calc(100dvh - 24px);padding:0;border:0;border-radius:10px;overflow:auto;box-shadow:0 12px 40px #0004}.label-settings::backdrop{background:#0006}.label-settings .finishing-label-config-layout{min-height:0}.label-settings .finishing-label-preview-panel{grid-column:1;grid-row:1}.label-settings .finishing-label-options{grid-column:2;grid-row:1;max-height:calc(100dvh - 70px)}.label-settings .finishing-label-config-actions{grid-column:1/-1}.label-settings form{margin:0}.label-settings .dialog-head{position:sticky;top:0;z-index:1;background:#fff}.label-settings fieldset{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;min-width:0;margin:0;padding:9px 11px;border:1px solid #dce1e5;border-radius:7px}.label-settings legend{padding:0 5px;font-size:12px;font-weight:700}.label-settings input:not([type=checkbox]):not([type=radio]){min-width:0;width:100%;padding:7px 9px}.label-settings .label-controls{display:grid;gap:12px}.label-settings .finishing-label-preview-panel{align-content:start}.label-settings .finishing-label-preview-size{flex:none}.label-settings .finishing-label-language{margin-top:4px}.label-settings .actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #dce1e5;background:#fafbfc}.label-settings .brand-mode{display:grid;gap:5px}.label-settings .finishing-label-option-with-input>input{min-width:0}.label-settings input[type=checkbox],.label-settings input[type=radio]{accent-color:#cf2e31}@media(max-width:760px){.label-settings{width:calc(100vw - 12px);max-height:calc(100dvh - 12px)}.label-settings .finishing-label-config-layout{grid-template-columns:minmax(0,1fr)}.label-settings .finishing-label-preview-panel,.label-settings .finishing-label-options{grid-column:1;grid-row:auto;max-height:none}.label-settings .finishing-label-preview-size{transform:scale(.62);transform-origin:top center;margin-bottom:-90px}.labels{padding:10px}}@media print{body{background:#fff}.toolbar,.label-settings{display:none}.labels{display:block;padding:0}.label{border:0;box-shadow:none}}</style></head><body><div class="toolbar"><button type="button" data-label-settings-open>Edytuj wzór etykiety</button><button type="button" data-label-print>Drukuj etykiety</button><span>${bales.length} etykiet · 50 × 74 mm</span></div><dialog id="label-settings" class="label-settings" data-client-logo="${V.esc(settings.clientLogo)}"><div class="dialog-head"><strong>Ustawienia etykiety</strong><button type="button" class="dialog-close" data-label-settings-close aria-label="Zamknij">×</button></div><form method="get" action="/finishing/receipts/${receiptId}/labels"><input type="hidden" name="settings_applied" value="1"><div class="finishing-label-config-layout"><section class="finishing-label-preview-panel"><div class="finishing-label-preview-size">${preview}</div><small>Podgląd etykiety · 50 × 74 mm</small>${languageOptions}</section><section class="finishing-label-options"><fieldset><legend>Górna część etykiety</legend><label class="finishing-label-option"><input type="radio" name="brand_mode" value="logo"${settings.brandMode==='logo'?' checked':''}><span>Logo Marand</span></label><label class="finishing-label-option"><input type="radio" name="brand_mode" value="none"${settings.brandMode==='none'?' checked':''}><span>Bez logo i tekstu</span></label><div class="finishing-label-option-with-input"><label class="finishing-label-option"><input type="radio" name="brand_mode" value="text"${settings.brandMode==='text'?' checked':''}><span>Własny tekst</span></label><input name="brand_text" value="${V.esc(settings.brandText)}" maxlength="80" placeholder="Wpisz tekst"></div><label class="finishing-label-option"><input type="radio" name="brand_mode" value="client-logo"${settings.brandMode==='client-logo'?' checked':''}${settings.clientLogo?'':' disabled'}><span>Logo klienta</span></label></fieldset><fieldset><legend>Pola etykiety</legend>${fieldOption('symbol','Symbol handlowy')}${fieldOption('color','Kolor',`<input name="color_text" value="${V.esc(settings.colorText)}" maxlength="100" placeholder="Domyślnie z symbolu handlowego">`)}${fieldOption('lot','Nr partii / zlecenie z farbiarni')}${fieldOption('width','Szerokość')}${fieldOption('grammage','Gramatura')}${fieldOption('raw-symbol','Symbol surowy')}${fieldOption('client','Klient',`<input name="client_name" value="${V.esc(client)}" maxlength="200">`)}${fieldOption('weight','Waga [kg]')}${fieldOption('extra-text','Dodatkowy tekst',`<input name="extra_text" value="${V.esc(settings.extraText)}" maxlength="100" placeholder="Wpisz dodatkowy tekst">`)}${fieldOption('distance','Dystans [mm]',`<input type="number" min="0.1" step="0.1" name="distance" value="${V.esc(settings.distance)}" placeholder="Opcjonalnie">`)}</fieldset><fieldset><legend>Ilość</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="quantity_unit" value="meters"${settings.quantityUnit==='meters'?' checked':''}><span>MB</span></label><label class="finishing-label-option"><input type="radio" name="quantity_unit" value="weight"${settings.quantityUnit==='weight'?' checked':''}><span>KG</span></label></div><label class="finishing-label-option"><input type="checkbox" name="include_meters" value="1"${settings.includeMeters?' checked':''}><span>Dodatkowo pokaż metry mniejszą czcionką</span></label></fieldset></section><div class="finishing-label-config-actions"><button type="button" data-label-settings-close>Wróć</button><button class="primary" type="submit">Zastosuj wzór</button></div></div></form></dialog><main class="labels">${labels}</main></body></html>`;
  return html.replace('<link rel="stylesheet" href="/static/app.css">','<link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/static/finishing-labels.css">').replace('<script src="/static/finishing-labels.js" defer>','<script src="/static/finishing-label-renderer.js"></script><script src="/static/finishing-labels.js" defer>');
}
function receiptDialog(ctx,order,batch,pm,returnTo='orders') {
  const dialogId=`finishing-receive-${batch.id}`,labelConfigId=`finishing-label-config-${batch.id}`,targetWidth=order.target_width_cm??'',targetGrammage=order.target_grammage??'';
  let recipeSnapshot={};try{recipeSnapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const linkedRecipe=order.recipe_id?recipeRecord(ctx.db,order.recipe_id):null;
  const labelSettings=labelTemplate(linkedRecipe?.label_settings);
  labelSettings.fields.lot=true;
  const labelFieldOption=(key,label,control='')=>`<div class="finishing-label-option-with-input"><label class="finishing-label-option"><input type="checkbox" data-label-field="${key}"${labelSettings.fields[key]?' checked':''}><span>${label}</span></label>${control}</div>`;
  let labelConfigMarkup=`<dialog id="${labelConfigId}" class="form-dialog finishing-label-config-dialog"><div class="dialog-head"><strong>Ustawienia etykiety</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body finishing-label-config-layout"><section class="finishing-label-preview-panel"><div class="finishing-label-preview-size"><article class="finishing-label-preview" data-label-preview></article></div><small>Podgląd etykiety · 50 × 74 mm</small></section><section class="finishing-label-options"><fieldset><legend>Górna część etykiety</legend><label class="finishing-label-option"><input type="checkbox" value="logo" data-label-brand-mode${labelSettings.brandMode==='logo'?' checked':''}><span>Logo Marand</span></label><div class="finishing-label-option-with-input"><label class="finishing-label-option"><input type="checkbox" value="text" data-label-brand-mode${labelSettings.brandMode==='text'?' checked':''}><span>Własny tekst</span></label><input type="text" maxlength="80" value="${V.esc(labelSettings.brandText)}" placeholder="Wpisz własny tekst" data-label-brand-text data-label-brand-text-field aria-label="Tekst u góry"></div>${labelSettings.clientLogo?`<label class="finishing-label-option"><input type="checkbox" value="client-logo" data-label-brand-mode${labelSettings.brandMode==='client-logo'?' checked':''}><span>Logo klienta</span></label><input type="hidden" value="${V.esc(labelSettings.clientLogo)}" data-label-client-logo>`:''}</fieldset><fieldset><legend>Pola etykiety</legend>${labelFieldOption('symbol','Symbol handlowy')}${labelFieldOption('color','Kolor',`<input type="text" maxlength="100" value="${V.esc(labelSettings.colorText)}" placeholder="Domyślnie z symbolu handlowego" data-label-color aria-label="Kolor etykiety">`)}${labelFieldOption('lot','Nr partii / zlecenie z farbiarni')}${labelFieldOption('width','Szerokość')}${labelFieldOption('grammage','Gramatura')}${labelFieldOption('raw-symbol','Symbol surowy')}${labelFieldOption('client','Klient',`<input type="text" maxlength="200" value="${V.esc(order.client_name||'')}" data-label-client data-label-client-field aria-label="Klient">`)}${labelFieldOption('weight','Waga [kg]')}${labelFieldOption('extra-text','Dodatkowy tekst',`<input type="text" maxlength="100" value="${V.esc(labelSettings.extraText)}" placeholder="Opcjonalnie" data-label-extra-text aria-label="Dodatkowy tekst">`)}${labelFieldOption('distance','Dystans [mm]',`<input type="number" min="0.1" step="0.1" value="${V.esc(labelSettings.distance)}" placeholder="Opcjonalnie, dzianina 3D" data-label-distance aria-label="Dystans w milimetrach">`)}</fieldset><fieldset><legend>Ilość</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="label-quantity-unit-${batch.id}" value="meters"${labelSettings.quantityUnit==='meters'?' checked':''} data-label-quantity-unit><span>MB</span></label><label class="finishing-label-option"><input type="radio" name="label-quantity-unit-${batch.id}" value="weight"${labelSettings.quantityUnit==='weight'?' checked':''} data-label-quantity-unit><span>KG</span></label></div><label class="finishing-label-option"><input type="checkbox"${labelSettings.includeMeters?' checked':''} data-label-secondary-meters><span>Dodatkowo pokaż metry mniejszą czcionką</span></label></fieldset><fieldset><legend>Język etykiety</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="label-language-${batch.id}" value="pl"${labelSettings.language==='pl'?' checked':''} data-label-language><span>Polski</span></label><label class="finishing-label-option"><input type="radio" name="label-language-${batch.id}" value="en"${labelSettings.language==='en'?' checked':''} data-label-language><span>English</span></label></div></fieldset></section><div class="finishing-label-config-actions"><button type="button" data-close-dialog>Wróć</button><button type="button" class="primary" data-label-print>Drukuj etykiety</button></div></div></dialog>`;
  const labelLanguageMarkup=`<fieldset class="finishing-label-language"><legend>Język etykiety</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="label-language-${batch.id}" value="pl"${labelSettings.language==='pl'?' checked':''} data-label-language><span>Polski</span></label><label class="finishing-label-option"><input type="radio" name="label-language-${batch.id}" value="en"${labelSettings.language==='en'?' checked':''} data-label-language><span>English</span></label></div></fieldset>`;
  labelConfigMarkup=labelConfigMarkup.replace(/<fieldset><legend>Język etykiety<\/legend>[\s\S]*?<\/fieldset>/,'').replace('<small>Podgląd etykiety · 50 × 74 mm</small></section>',`<small>Podgląd etykiety · 50 × 74 mm</small>${labelLanguageMarkup}</section>`);
  const recipeSymbol=String(recipeSnapshot.rawSymbol||recipeSnapshot.raw_symbol||linkedRecipe?.raw_symbol||'').trim();
  const recipeDetails=orderRecipeDetails(ctx.db,order,recipeSnapshot);
  const recipeTradeParts=recipeTradeSymbolParts({name:recipeSnapshot.name,finishing_plant_name:recipeSnapshot.finishingPlant,trade_symbol:order.trade_symbol,recipe_details:JSON.stringify(recipeDetails)});
  const processRequirements=recipeProcessRequirements(recipeDetails);
  const capacity=receiptCapacity(ctx.db,order,batch),previousBatchTotals={pieces:capacity.batchTotals.pieces,weight:capacity.batchTotals.kg},allowIncompleteChoice=isMainPmBatch(ctx.db,order,batch),acceptWholeAdditionalBatch=isAdditionalPmBatch(ctx.db,order,batch);
  const otherBatchReceipts=ctx.db.prepare(`SELECT b.id,b.finishing_lot,b.sent_at,b.created_at,
      coalesce(sum(r.raw_pieces_received),0) pieces,coalesce(sum(r.used_weight_kg),0) kg
    FROM finishing_batches b JOIN finishing_receipts r ON r.batch_id=b.id
    WHERE b.order_id=? AND b.id<>? AND b.cancelled_at IS NULL
      AND b.correction_parent_batch_id IS NULL AND b.correction_of_batch_id IS NULL
    GROUP BY b.id HAVING coalesce(sum(r.raw_pieces_received),0)>0 ORDER BY b.id`).all(order.id,batch.id)
    .map(row=>({...row,order_no:finishingOrderNo(row)||`Partia #${row.id}`}));
  const remainingKg=capacity.remainingAfterBatchKg,suggestedRawPieces=capacity.suggestedPieces,suggestedUsedKg=capacity.suggestedKg;
  const correctionBatch=Boolean(batch.correction_of_batch_id||batch.correction_parent_batch_id),suggestedRawPiecesInput=String(suggestedRawPieces),suggestedUsedKgInput=String(suggestedUsedKg);
  const correctionParentId=batch.correction_parent_batch_id||batch.correction_of_batch_id,correctionParent=correctionParentId?ctx.db.prepare('SELECT correction_trade_symbol,correction_target_color FROM finishing_batches WHERE id=?').get(correctionParentId):null,baseOrder=correctionBatch?orderRecord(ctx.db,order.id)||order:order;
  const changeField=(label,before,after)=>{const oldValue=String(before||'').trim()||'—',newValue=String(after||'').trim()||'—';return `<div class="finishing-correction-info-change"><small>${V.esc(label)}</small><div class="finishing-correction-info-values">${oldValue===newValue?`<strong>${V.esc(newValue)}</strong>`:`<span>${V.esc(oldValue)}</span><b aria-hidden="true">→</b><strong>${V.esc(newValue)}</strong>`}</div></div>`;};
  const correctionInstructionText=[batch.correction_instruction,batch.correction_notes].filter(value=>String(value||'').trim()).join('\n\n');
  const correctionInfoDialog=correctionBatch?`<dialog id="finishing-correction-info-${batch.id}" class="form-dialog finishing-correction-info-dialog"><div class="dialog-head"><strong>Informacje o poprawce · ${V.esc(pm)}</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body"><p class="muted">Sprawdź zmiany zapisane dla tego zlecenia poprawkowego.</p><section class="finishing-correction-info-fields">${changeField('Symbol handlowy',correctionParent?.correction_trade_symbol||baseOrder.trade_symbol,batch.correction_trade_symbol||order.trade_symbol)}${changeField('Kolor po poprawie',correctionParent?.correction_target_color||baseOrder.target_color,batch.correction_target_color||order.target_color)}</section><section class="finishing-correction-info-instruction"><strong>Instrukcja poprawki</strong><p>${V.esc(correctionInstructionText||'Brak dodatkowej instrukcji.')}</p></section><div class="actions"><button type="button" data-close-dialog>Wróć</button><button type="button" class="primary" data-close-dialog data-open-dialog="${dialogId}">Przejdź do przyjęcia</button></div></div></dialog>`:'';
  const canRequestCorrection=['normal','poprawka','do_poprawy'].includes(batch.workflow_status);
  const grammagePlus=recipeDetails.grammagePlus??null,grammageMinus=recipeDetails.grammageMinus??null;
  const widthPlus=recipeDetails.widthPlus??null,widthMinus=recipeDetails.widthMinus??null;
  const symbolMismatch=recipeSymbol&&normalizeSearch(recipeSymbol)!==normalizeSearch(order.raw_symbol);
  const symbolWarning=symbolMismatch?`<div class="notice warning finishing-symbol-warning" role="status"><strong>Uwaga: różne symbole dzianiny.</strong> Symbol z PM: <strong>${V.esc(order.raw_symbol||'—')}</strong>; symbol w recepturze wykańczalni: <strong>${V.esc(recipeSymbol)}</strong>. Możesz zapisać przyjęcie mimo tej rozbieżności.</div>`:'';
  const priorComment=order.recipe_id?ctx.db.prepare(`SELECT r.id receipt_id,r.notes,r.received_at,b.finishing_lot,b.sent_at,o.id order_id
    FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id JOIN finishing_orders o ON o.id=b.order_id
    WHERE o.recipe_id=? AND trim(r.notes)<>'' AND r.comment_consumed_at IS NULL ORDER BY r.id DESC LIMIT 1`).get(order.recipe_id):null;
  const priorCommentHtml=priorComment?`<aside class="finishing-receive-prior-comment"><strong>Poprzedni komentarz do tej receptury</strong><small>${V.datepl(priorComment.received_at)}${priorComment.finishing_lot?` · LOT ${V.esc(finishingOrderNo(priorComment))}`:''}</small><div>${V.esc(priorComment.notes)}</div></aside>`:'';
  const statusChoices=(name,label,required=false,description='')=>`<fieldset class="finishing-receive-check"><legend>${V.esc(label)}</legend>${description?`<small class="finishing-receive-check-description">${V.esc(description)}</small>`:''}<label><input type="radio" name="${V.esc(name)}" value="ok"${required?' required':''}><span class="finishing-receive-choice-dot is-ok" aria-hidden="true"></span><span>OK</span></label><label><input type="radio" name="${V.esc(name)}" value="not_ok"><span class="finishing-receive-choice-dot is-nok" aria-hidden="true"></span><span>NOK</span></label></fieldset>`;
  const requiredKeys=new Set(processRequirements.map(item=>item.key));
  const recipeProcessChoices=processRequirements.map(item=>statusChoices(`process_check_${item.key}`,item.label,true,item.description)).join('');
  const baseChoices=[order.target_color?statusChoices('color_status','Kolor',true):'',...(!requiredKeys.has('stiffeningEnabled')&&order.target_stiffening?[statusChoices('stiffening_status','Usztywnienie',true)]:[])].join('');
  const grammageControl=Number(targetGrammage)>0?`<div class="finishing-receive-param-row" data-finishing-param-row data-param-target="${V.esc(targetGrammage)}" data-param-minus="${V.esc(grammageMinus??'')}" data-param-plus="${V.esc(grammagePlus??'')}" data-recipe-parameter="grammage"><label>Gramatura z belki<input name="actual_grammage" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="g/m²" required></label><div><small>Gramatura zlecona</small><strong>${V.esc(targetGrammage)} g/m²</strong></div><div><small>Tolerancja z receptury</small><strong>${grammagePlus!==null||grammageMinus!==null?`−${grammageMinus??'0'} / +${grammagePlus??'0'} g/m²`:'0 g/m²'}</strong></div><div class="finishing-receive-param-status" data-param-status aria-live="polite"></div></div>`:'';
  const widthControl=Number(targetWidth)>0?`<div class="finishing-receive-param-row" data-finishing-param-row data-param-target="${V.esc(targetWidth)}" data-param-minus="${V.esc(widthMinus??'')}" data-param-plus="${V.esc(widthPlus??'')}" data-recipe-parameter="width"><label>Szerokość z belki<input name="actual_width_cm" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="cm" required></label><div><small>Szerokość zlecona</small><strong>${V.esc(targetWidth)} cm</strong></div><div><small>Tolerancja z receptury</small><strong>${widthPlus!==null||widthMinus!==null?`−${widthMinus??'0'} / +${widthPlus??'0'} cm`:'0 cm'}</strong></div><div class="finishing-receive-param-status" data-param-status aria-live="polite"></div></div>`:'';
  return `<dialog id="${dialogId}" class="form-dialog finishing-receive-dialog" data-draggable-dialog aria-labelledby="${dialogId}-title"><div class="dialog-head finishing-receive-dialog-head" data-dialog-drag-handle><div><strong id="${dialogId}-title">Przyjęcie belek · ${V.esc(pm)} · ${V.datepl(V.todayInput())}</strong><small>${V.esc(order.finishing_plant_name||'')}</small></div><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body">
     <section class="finishing-receive-summary" aria-label="Przyjmowane zlecenie"><div><small>Symbol surowy</small><strong>${V.esc(order.raw_symbol||'—')}</strong></div><div><small>Symbol handlowy</small><strong>${V.esc(order.trade_symbol||'—')}</strong></div><div><small>Kolor planowany</small><strong>${V.esc(order.target_color||'—')}</strong></div><div><small>PM</small><strong>${V.esc(pm)}</strong></div></section>${symbolWarning}
    <form id="${dialogId}-form" method="post" action="/finishing/batches/${batch.id}/receipts" class="finishing-receipt-form finishing-receive-form" data-finishing-receive-form novalidate data-allow-incomplete-choice="${allowIncompleteChoice?'1':'0'}" data-accept-whole-additional-batch="${acceptWholeAdditionalBatch?'1':'0'}" data-other-batch-receipts="${V.esc(JSON.stringify(otherBatchReceipts))}" data-pm-previous-received-pieces="${V.esc(capacity.orderTotals.pieces)}" data-pm-previous-received-weight="${V.esc(capacity.orderTotals.kg)}" data-pm-total-pieces="${V.esc(capacity.sourcePiecesTotal)}" data-pm-total-weight="${V.esc(capacity.sourceWeightTotal)}" data-raw-symbol="${V.esc(order.raw_symbol||'')}" data-trade-symbol="${V.esc(recipeTradeParts.symbol||order.trade_symbol||'')}" data-trade-color-symbol="${V.esc(recipeTradeParts.color||'')}" data-target-color="${V.esc(order.target_color||'')}" data-order-number="${V.esc(finishingOrderNo(batch))}" data-plan-grammage="${V.esc(targetGrammage)}" data-plan-width="${V.esc(targetWidth)}" data-raw-weight="${V.esc(capacity.effectiveBatchKg)}" data-sent-pieces="${V.esc(capacity.effectiveBatchPieces)}" data-previous-received-pieces="${V.esc(previousBatchTotals.pieces)}" data-previous-received-weight="${V.esc(previousBatchTotals.kg)}">${hidden('csrf',ctx.req.session.csrf)}${hidden('modal_receipt','1')}${hidden('return_to',returnTo)}${hidden('close_incomplete','')}${priorComment?hidden('prior_comment_receipt_id',priorComment.receipt_id):''}<input type="hidden" name="meters_list" value="" data-receipt-meters-list><input type="hidden" name="weights_list" value="" data-receipt-weights-list>
       <section class="finishing-receive-overview" aria-label="Zlecone i odebrane wartości"><label class="finishing-receipt-date">Data przyjęcia<input type="date" name="received_at" value="${V.todayInput()}" required></label><div class="finishing-receive-metrics-grid">
        ${correctionBatch?`<div class="finishing-receive-metric finishing-correction-note" style="grid-column:1/-1"><strong>Poprawkowe zlecenie barwiarskie</strong><span>Ilości kg i szt. odpowiadają wartościom zadeklarowanym przy przyjęciu partii poprawianej. Wagę gotowych belek wpisuje się osobno.</span></div>`:`<div class="finishing-receive-metric"><small>Do rozliczenia z PM · kg</small><strong>${money(suggestedUsedKg)} kg</strong></div><div class="finishing-receive-metric"><small>Do rozliczenia z PM · szt.</small><strong>${suggestedRawPieces}</strong></div><div class="finishing-receive-metric" title="Ilość pozostała z PM po rozliczeniu tej partii"><small>Pozostałe kg</small><strong>${money(remainingKg)} kg</strong></div>`}
      </div><div class="finishing-receive-accepted-summary"><label><small>Rozliczamy ze zleconych · kg</small><input type="text" inputmode="decimal" name="used_weight_kg" maxlength="10" value="${V.esc(suggestedUsedKgInput)}" placeholder="${V.esc(suggestedUsedKgInput||'0')}" data-receipt-accounted-kg></label><label><small>Rozliczamy ze zleconych · szt.</small><input type="number" name="raw_pieces_received" min="0" step="1" value="${V.esc(suggestedRawPiecesInput)}" placeholder="${V.esc(suggestedRawPiecesInput||'0')}" data-receipt-raw-pieces required></label></div><p class="finishing-receive-completion" data-receipt-completion aria-live="polite"></p><div class="finishing-receive-incomplete-choice" data-receipt-incomplete-choice hidden><strong>Nie wszystkie wysłane sztuki zostały rozliczone.</strong><p data-receipt-incomplete-message></p><div class="actions"><button type="button" data-receipt-incomplete-option="0">Zostaw partię otwartą — reszta w wykańczalni</button><button type="button" class="danger" data-receipt-incomplete-option="1">Zamknij z brakami (belka zniszczona/zagubiona)</button></div></div></section>
      <section class="finishing-receive-quality"><h3>Kontrola parametrów</h3>
        ${grammageControl}${widthControl}
        <div class="finishing-receive-check-grid">${baseChoices}${recipeProcessChoices}</div></section>
      <section class="finishing-receive-bales"><div class="finishing-receive-bales-heading"><div><h3>Sztuki z wybranej pozycji PM</h3><p class="muted">Najpierw wpisz liczbę powtórzeń, potem metry lub kg i zatwierdź Enterem.</p></div></div><fieldset class="finishing-receive-mode"><legend>Wpisuję</legend><label><input type="radio" name="measurement_mode" value="meters" checked data-receipt-mode><span>mb</span></label><label><input type="radio" name="measurement_mode" value="both" data-receipt-mode><span>mb + kg</span></label><label><input type="radio" name="measurement_mode" value="weight" data-receipt-mode><span>kg</span></label></fieldset><input type="hidden" name="measure_meters" value="1" data-receipt-measure-meters><input type="hidden" name="measure_weight" value="0" data-receipt-measure-weight><div class="finishing-receive-entry-box"><label class="finishing-receive-entry-count"><small>Liczba powtórzeń</small><input type="text" inputmode="numeric" maxlength="3" value="1" data-receipt-entry-count aria-label="Liczba powtórzeń" autocomplete="off"></label><label class="finishing-receive-entry"><small data-receipt-entry-prompt>Sztuka 1 — metry (mb)</small><span class="finishing-receive-entry-input-row"><input type="text" inputmode="decimal" maxlength="5" data-receipt-entry-input placeholder="Wpisz wartość" autocomplete="off" autofocus><strong data-receipt-entry-unit>MB</strong></span></label></div><small class="finishing-receive-entry-status" data-receipt-entry-status aria-live="polite"></small><div class="finishing-receive-bale-list" data-receipt-bale-list></div><div class="finishing-receive-print-row"><button type="button" data-receipt-print-labels data-open-dialog="${labelConfigId}" disabled>Drukuj etykiety</button></div><div class="finishing-receive-totals"><div><small>L.m. teoretyczna</small><span data-receipt-theoretical>—</span></div><div><small>Strata</small><strong data-receipt-loss>—</strong></div><div class="finishing-receive-total-highlight"><small>Razem mb</small><strong data-receipt-total-meters>—</strong></div></div><p class="finishing-receive-calculation-note" data-receipt-calculation-note>Teoria jest liczona z kg rozliczanych ze zleconych oraz planowanej gramatury i szerokości.</p></section>
      ${priorCommentHtml}<label class="finishing-receive-notes">Komentarz do partii (wyświetli się jednorazowo przy kolejnej produkcji receptury)<textarea name="notes" maxlength="3000" rows="3" placeholder="Wpisz komentarz do tej partii"></textarea></label>
    </form>${labelConfigMarkup}${canRequestCorrection?`<form id="${dialogId}-correction-form" method="post" action="/finishing/batches/${batch.id}/send-to-correction" class="finishing-correction-form" hidden>${hidden('csrf',ctx.req.session.csrf)}<h3>${batch.workflow_status==='poprawka'?'Kolejna poprawka':'Informacje o poprawce'}</h3><div class="finishing-correction-fields"><label class="finishing-correction-instruction">Instrukcja poprawki<textarea name="correction_instruction" maxlength="3000" rows="4"></textarea></label><label>Kolor<input name="target_color" maxlength="160" value="${V.esc(order.target_color||'')}"></label><label>Gramatura g/m²<input name="target_grammage" type="number" min="0.1" step="0.1" value="${V.esc(order.target_grammage??'')}"></label><label>Szerokość cm<input name="target_width_cm" type="number" min="0.1" step="0.1" value="${V.esc(order.target_width_cm??'')}"></label></div><div class="actions"><button type="button" data-cancel-correction>Wróć do przyjęcia</button><button type="submit" class="finishing-send-to-correction">Utwórz poprawkę</button></div></form>`:''}<div class="actions finishing-receive-actions"><button type="button" data-close-dialog>Wróć</button>${canRequestCorrection?`<button type="button" class="finishing-send-to-correction" data-open-correction-form="${dialogId}-correction-form">DO POPRAWY</button>`:''}<button type="submit" form="${dialogId}-form" class="primary" data-receipt-save-button>Zapisz przyjęcie</button></div></div></dialog>${correctionInfoDialog}`;
}
function correctionForm(ctx,order,batch) {
  const hasActive=ctx.db.prepare('SELECT 1 FROM finishing_batches WHERE correction_parent_batch_id=? AND cancelled_at IS NULL AND closed_at IS NULL').get(batch.id);
  if(hasActive)return '';
  return `<details class="finishing-correction-editor"><summary>${batch.workflow_status==='do_poprawy'?'Ponów poprawkę':'Skieruj do poprawy'}</summary><form method="post" action="/finishing/batches/${batch.id}/send-to-correction" class="finishing-correction-form">${hidden('csrf',ctx.req.session.csrf)}<h3>Instrukcja poprawki</h3><label>Zakres materiału i co należy zrobić<textarea name="correction_instruction" maxlength="3000" rows="3" placeholder="Np. pozostałe belki z farbiarni oraz 90% belki próbnej; przefarbować na czarno"></textarea></label><div class="finishing-correction-fields"><label>Symbol handlowy<input name="trade_symbol" maxlength="200" value="${V.esc(order.trade_symbol||'')}"></label><label>Kolor<input name="target_color" maxlength="160" value="${V.esc(order.target_color||'')}"></label><label>Gramatura g/m²<input name="target_grammage" type="number" min="0.1" step="0.1" value="${V.esc(order.target_grammage??'')}"></label><label>Szerokość cm<input name="target_width_cm" type="number" min="0.1" step="0.1" value="${V.esc(order.target_width_cm??'')}"></label></div><div class="actions"><button class="primary">Utwórz zlecenie Poprawa</button></div></form></details>`;
}
function orderPage(ctx,id) {
  const db=ctx.db,order=orderRecord(db,id);
  if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const batches=orderBatches(db,id),receipts=orderReceipts(db,id);
  const activeBatches=batches.filter(batch=>!batch.cancelled_at);
  const allBatchesNeedCorrection=activeBatches.length>0&&activeBatches.every(batch=>batch.workflow_status==='do_poprawy');
  const orderWorkflowStatus=allBatchesNeedCorrection?'do_poprawy':activeBatches.some(batch=>batch.workflow_status==='poprawka')?'poprawka':order.status;
  const incidents=db.prepare(`SELECT i.*,u.name author,ru.name resolver FROM finishing_incidents i LEFT JOIN users u ON u.id=i.created_by LEFT JOIN users ru ON ru.id=i.resolved_by WHERE i.order_id=? ORDER BY i.id DESC`).all(id);
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const pm=pmReference(order);
  const source=order.source_shipment_no||'—';
  const piecesBody=orderPiecesView(db,order);
  const canEdit=editableRoles.includes(ctx.req.user.role)&&(order.manual_entry||!['cancelled','raw_sale'].includes(order.status));
  const baseBatch=[...batches].sort((a,b)=>a.id-b.id).find(batch=>!batch.cancelled_at&&!batch.correction_parent_batch_id&&!batch.correction_of_batch_id),unassignedPieces=unassignedOrderPieces(db,order,batches);
  const remainderSettlement=order.source_remainder_batch_id&&baseBatch?Costing.getSettlement(db,baseBatch.id):null;
  const remainderSettlementAction=order.source_remainder_batch_id&&baseBatch&&canEdit?(remainderSettlement?`<span class="badge ${remainderSettlement.status==='settled'?'approved':'status-finishing'}">${remainderSettlement.status==='settled'?'Rozliczona':'W rozliczeniu'}</span>`:`<form method="post" action="/finishing/orders/${id}/send-to-settlement">${hidden('csrf',ctx.req.session.csrf)}<button class="button danger">Wyślij do rozliczenia</button></form>`):'';
  const canAddBatch=canEdit&&!allBatchesNeedCorrection&&order.order_type!=='raw_sale'&&(!['cancelled','raw_sale'].includes(order.status))&&(!receipts.length||unassignedPieces>0)&&(!['received'].includes(order.status)||unassignedPieces>0)&&batches.length>0&&Number(baseBatch?.sent_pieces)>0;
  const lotBatch=batches.find(batch=>batch.workflow_status!=='do_poprawy'&&!String(batch.finishing_lot||'').trim())||batches.find(batch=>batch.workflow_status!=='do_poprawy')||batches[0];
  const lotControl=canEdit&&lotBatch?`<button type="button" class="finishing-lot-edit-button" data-open-dialog="finishing-lot-dialog">${lotBatch.finishing_lot?'Edytuj nr zlecenia':'Dodaj nr zlecenia'}</button>`:`<span class="muted">Nr zlecenia: ${V.esc(finishingOrderNo(lotBatch)||'do uzupełnienia')}</span>`;
   const lotDialog=canEdit&&lotBatch?`<dialog id="finishing-lot-dialog" class="form-dialog finishing-lot-dialog"><div class="dialog-head"><strong>Nr zlecenia barwiarskiego</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body"><p>Wpisz numer zlecenia barwiarskiego przypisanego do tej partii.</p><form method="post" action="/finishing/orders/${id}/lot" class="finishing-lot-form" data-finishing-lot-confirm>${hidden('csrf',ctx.req.session.csrf)}${hidden('batch_id',lotBatch.id)}<label>Nr zlecenia barwiarskiego<input name="finishing_lot" maxlength="120" value="${V.esc(lotBatch.finishing_lot||'')}" autofocus></label><div class="actions"><button type="button" data-close-dialog>Wróć</button><button class="primary">Zapisz nr zlecenia</button></div></form></div></dialog>`:'';
  const receiptDialogs=[];
  const receiptViews=batches.map(batch=>{
    const recent=receipts.filter(receipt=>receipt.batch_id===batch.id);
    const rows=recent.map(receipt=>{
      const bales=db.prepare('SELECT meters,weight_kg FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receipt.id),hasMeters=bales.some(bale=>bale.meters!==null),hasWeights=bales.some(bale=>bale.weight_kg!==null);
      const edit=canEdit?`<details class="finishing-receipt-edit"><summary>Edytuj przyjęcie</summary><form method="post" action="/finishing/receipts/${receipt.id}/edit">${hidden('csrf',ctx.req.session.csrf)}<label>Rozliczamy ze zleconych · kg<input type="number" name="used_weight_kg" min="0" step="0.01" value="${V.esc(receipt.used_weight_kg??'')}"></label><label>Rozliczamy ze zleconych · szt.<input type="number" name="raw_pieces_received" min="0" step="1" value="${V.esc(receipt.raw_pieces_received??0)}" required></label><label>Kolor uzyskany<input name="actual_color" value="${V.esc(receipt.actual_color||'')}" maxlength="160"></label><label>Szerokość cm<input type="number" name="actual_width_cm" min="0.01" step="0.01" value="${V.esc(receipt.actual_width_cm??'')}"></label><label>Gramatura g/m²<input type="number" name="actual_grammage" min="0.01" step="0.01" value="${V.esc(receipt.actual_grammage??'')}"></label><label>Uwagi<textarea name="notes" rows="2" maxlength="3000">${V.esc(receipt.notes||'')}</textarea></label>${hasMeters?`<label>Metry belek (po jednej w wierszu)<textarea name="meters_list" rows="3">${V.esc(bales.map(bale=>bale.meters??'').join('\n'))}</textarea></label>`:''}${hasWeights?`<label>Kg belek (po jednej w wierszu)<textarea name="weights_list" rows="3">${V.esc(bales.map(bale=>bale.weight_kg??'').join('\n'))}</textarea></label>`:''}<label class="check"><input type="checkbox" name="incomplete" value="1"${receipt.incomplete?' checked':''}> Przyjęcie niekompletne</label><p class="muted">Zmiana ilości lub parametrów oznaczy zatwierdzone rozliczenie jako zmienione.</p><button class="button">Zapisz zmiany</button></form></details>`:'';
      const processSummary=receiptProcessSummary(receipt,orderRecipeDetails(db,order,snapshot)),quality=[order.target_grammage!==null&&order.target_grammage!==undefined?`Gramatura: ${parameterStatusHtml(receipt.grammage_status)}`:'',order.target_width_cm!==null&&order.target_width_cm!==undefined?`Szerokość: ${parameterStatusHtml(receipt.width_status)}`:''].filter(Boolean).join(' · '),colorSummary=order.target_color?`Kolor: ${receipt.color_status==='ok'?'OK':receipt.color_status==='not_ok'?'NOK':'—'}`:'';
      return `<tr><td>${V.datepl(receipt.received_at)}</td><td>${receipt.raw_pieces_received} szt. · ${money(receipt.used_weight_kg)} kg rozliczone</td><td>${receipt.finished_pieces} belek · ${receipt.meters_sum===null?'—':`${qty(receipt.meters_sum)} mb`} · ${receipt.finished_weight_kg>0?`${money(receipt.finished_weight_kg)} kg`:'—'}</td><td>${quality}${colorSummary?`<small class="finishing-subline">${colorSummary}</small>`:''}${processSummary?`<small class="finishing-subline">${V.esc(processSummary)}</small>`:''}</td><td>${V.esc(receipt.notes||'—')}</td><td>${receipt.bale_count?`<a class="button" href="/finishing/receipts/${receipt.id}/labels" target="_blank" rel="noopener">Etykiety</a>`:'<span class="muted small">Brak wymiarów pojedynczych belek</span>'}${edit}</td></tr>`;
    }).join('');
    const additionalPmBatch=isAdditionalPmBatch(db,order,batch);
    const canReceiveBatch=canEdit&&!batch.cancelled_at&&!batch.closed_at&&batch.workflow_status!=='do_poprawy'&&!(additionalPmBatch&&batch.receipt_count>0);
    if(canReceiveBatch){const receiptOrder={...order,trade_symbol:batch.correction_trade_symbol||order.trade_symbol,target_color:batch.correction_target_color||order.target_color,target_width_cm:batch.correction_target_width_cm??order.target_width_cm,target_grammage:batch.correction_target_grammage??order.target_grammage};receiptDialogs.push(receiptDialog(ctx,receiptOrder,batch,pm,'detail'));}
    const correctionBatch=Boolean(batch.correction_of_batch_id||batch.correction_parent_batch_id),receiveDialogId=correctionBatch?`finishing-correction-info-${batch.id}`:`finishing-receive-${batch.id}`;
    const receiveButton=canReceiveBatch?`<button type="button" class="finishing-row-action is-receive" data-open-dialog="${receiveDialogId}" aria-label="Przyjmij sztuki partii ${V.esc(batch.finishing_lot)}" title="Przyjmij sztuki"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>`:canEdit&&!batch.closed_at&&!batch.cancelled_at&&!(additionalPmBatch&&batch.receipt_count)?'<button type="button" class="finishing-row-action is-receive" disabled title="Najpierw wpisz numer zlecenia barwiarskiego" aria-label="Najpierw wpisz numer zlecenia barwiarskiego">+</button>':'';
    const batchQuantities=Number(batch.sent_pieces)>0?`${batch.sent_pieces} szt. surowe · ${money(batch.raw_weight_kg)} kg`:batch.receipt_count?`${batch.raw_received_pieces} szt. przyjęte · ${money(batch.finished_weight_kg||0)} kg przyjęte`:'Ilość sztuk i masa zostaną uzupełnione przy przyjęciu';
    const complaintBadge=batch.complaint_status==='reklamowana'?'<span class="badge archived">Reklamowana</span>':batch.complaint_status==='poprawiona'?'<span class="badge approved">Poprawiona</span>':'';
    const complaintAction=canEdit&&batch.closed_at&&batch.complaint_status==='normal'?`<form method="post" action="/finishing/batches/${batch.id}/complaint">${hidden('csrf',ctx.req.session.csrf)}<button class="button danger">Oznacz jako reklamowaną</button></form>`:'';
    const undoLastReceiptAction=canEdit&&!batch.cancelled_at&&recent.length?`<form method="post" action="/finishing/batches/${batch.id}/receipts/undo" data-finishing-receipt-undo data-batch-label="${V.esc(finishingOrderNo(batch)||`#${batch.id}`)}">${hidden('csrf',ctx.req.session.csrf)}<button class="button danger">Cofnij przyjęcie</button></form>`:'';
    const batchStatusLabel=finishingBatchStatusLabel(db,order,batch),batchStatusClass=finishingBatchStatusClass(db,order,batch);
    const correctionAction=canEdit&&!batch.cancelled_at&&batch.workflow_status!=='poprawka'?correctionForm(ctx,order,batch):'';
    const cancelAttempt=canEdit&&batch.workflow_status==='poprawka'&&batch.correction_parent_batch_id&&!batch.cancelled_at&&!batch.closed_at?`<form method="post" action="/finishing/batches/${batch.id}/cancel-attempt">${hidden('csrf',ctx.req.session.csrf)}<button class="button danger">Usuń poprawę</button></form>`:'';
    const correctionInstruction=[batch.correction_instruction,batch.correction_notes].filter(value=>String(value||'').trim()).join('\n\n');
    const correctionDetails=batch.correction_parent_batch_id?`<aside class="finishing-correction-details"><strong>Instrukcja poprawki</strong><p>${V.esc(correctionInstruction||'—')}</p></aside>`:'';
     return `<section class="panel padded finishing-batch-card${batch.cancelled_at?' is-cancelled':''}" id="batch-${batch.id}"><h3>Zlecenie barwiarskie ${V.esc(finishingOrderNo(batch)||`#${batch.id}`)} ${batch.cancelled_at?'<span class="badge archived">Próba anulowana</span>':batchStatusLabel==='Przyjęta'||batchStatusLabel==='Przyjęta z brakiem'||batchStatusLabel==='Częściowo przyjęta'?`<span class="badge approved">${batchStatusLabel}</span>`:''} ${complaintBadge} ${receiveButton}</h3><p>Status: ${batch.cancelled_at?'Anulowana próba':batchStatusLabel} · Data wysyłki: ${V.datepl(batch.sent_at)} · ${batchQuantities} · LOT przędzy: ${V.esc(batch.yarn_lot||'—')}</p>${correctionDetails}<div class="actions">${undoLastReceiptAction}${complaintAction}${correctionAction}${cancelAttempt}</div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Data przyjęcia</th><th>Rozliczono ze zleconych</th><th>Belki wykończone</th><th>Kontrola parametrów</th><th>Komentarz do partii</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6">Jeszcze nie przyjęto zwrotu.</td></tr>'}</tbody></table></div></section>`;
  }).join('');
  const pmAllocationBales=!order.manual_entry&&order.order_type!=='raw_sale'&&order.shipment_article_id
    ?(()=>{const saved=db.prepare('SELECT weight_kg FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(id);return saved.length?saved:sourcePieces(db,order.shipment_article_id)})():[];
  const pmAllocationPieces=pmAllocationBales.length,pmAllocationWeight=pmAllocationBales.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0);
  const pmAllocationBatches=activeBatches.filter(batch=>!batch.correction_parent_batch_id&&!batch.correction_of_batch_id).sort((a,b)=>a.id-b.id);
  const mainPmAllocation=pmAllocationBatches[0]||null;
  const additionalPmAllocation=pmAllocationBatches.slice(1);
  const mainPmAssignedPieces=mainPmAllocation?Math.min(Number(mainPmAllocation.sent_pieces||0),Math.max(0,pmAllocationPieces-additionalPmAllocation.reduce((sum,batch)=>sum+(Number(batch.receipt_count||0)>0?Number(batch.raw_received_pieces||0):Number(batch.sent_pieces||0)),0))):0;
  const mainPmAssignedWeight=mainPmAllocation?Math.min(Number(mainPmAllocation.raw_weight_kg||0),Math.max(0,Math.round((pmAllocationWeight-additionalPmAllocation.reduce((sum,batch)=>sum+(Number(batch.receipt_count||0)>0?Number(batch.raw_received_weight_kg||0):Number(batch.raw_weight_kg||0)),0))*100)/100)):0;
  const batchRows=[...batches].sort((a,b)=>a.id-b.id).map((batch,index)=>{
    const batchStatusLabel=finishingBatchStatusLabel(db,order,batch),batchStatus=`<span class="badge ${finishingBatchStatusClass(db,order,batch)}">${V.esc(batchStatusLabel)}</span>`;
    const parent=batch.correction_parent_batch_id?db.prepare('SELECT id,order_id,finishing_lot,sent_at FROM finishing_batches WHERE id=?').get(batch.correction_parent_batch_id):null;
    const correctionLink=parent?`<small class="finishing-subline"><a href="/finishing/orders/${parent.order_id}#batch-${parent.id}">Poprawka po ${V.esc(finishingOrderNo(parent)||`#${parent.id}`)}</a></small>`:'';
    const correctionInstruction=[batch.correction_instruction,batch.correction_notes].filter(value=>String(value||'').trim()).join(' · ');
    const correctionText=batch.correction_parent_batch_id?`<small class="finishing-subline"><b>Instrukcja poprawki:</b> ${V.esc(correctionInstruction||'—')}</small>`:'';
    const isMainPmAllocation=batch.id===mainPmAllocation?.id;
    const assignedPieces=isMainPmAllocation?mainPmAssignedPieces:(Number(batch.receipt_count||0)>0?Number(batch.raw_received_pieces||0):Number(batch.sent_pieces||0)),assignedWeight=isMainPmAllocation?mainPmAssignedWeight:(Number(batch.receipt_count||0)>0?Number(batch.raw_received_weight_kg||0):Number(batch.raw_weight_kg||0));
    const provisionalMainAllocation=isMainPmAllocation&&additionalPmAllocation.length>0&&!batch.closed_at;
    const assignedText=provisionalMainAllocation?`<em class="finishing-provisional-quantity">${Number(batch.sent_pieces||0)} szt. · ${money(batch.raw_weight_kg)} kg</em><small class="finishing-provisional-note">Rzeczywista ilość będzie podana po przyjęciu partii składowych.</small>`:isMainPmAllocation?`${assignedPieces} szt. · ${money(assignedWeight)} kg`:assignedPieces>0?`${assignedPieces} szt. · ${money(assignedWeight)} kg`:batch.receipt_count?`${batch.raw_received_pieces} szt. · ${money(batch.finished_weight_kg||0)} kg`:'Do uzupełnienia przy przyjęciu';
     return `<tr><td><strong>${batch.correction_of_batch_id||batch.correction_parent_batch_id?'Poprawkowe':index===0?'Główne':`Dodatkowe ${index}`}</strong>${batch.complaint_status==='reklamowana'?' · Reklamowane':batch.complaint_status==='poprawiona'?' · Poprawione':''}${correctionLink}${correctionText}</td><td>${V.esc(finishingOrderNo(batch)||'Do uzupełnienia')}</td><td>${batchStatus}</td><td>${V.datepl(batch.sent_at)}</td><td>${assignedText}</td><td>${V.esc(batch.yarn_lot||'—')}</td><td>${batch.finished_pieces} szt. · ${batch.finished_meters===null?'—':`${qty(batch.finished_meters)} mb`}</td></tr>`;
  }).join('');
   const batchSection=batches.length?`<section class="panel padded finishing-order-batches"><div class="sectionhead"><h2>Zlecenia barwiarskie</h2><span>${batches.length} ${batches.length===1?'zlecenie':'zlecenia'}</span></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Rodzaj</th><th>Nr zlecenia barwiarskiego</th><th>Status</th><th>Data wysyłki</th><th>Przypisana PM</th><th>LOT przędzy</th><th>Powrót</th></tr></thead><tbody>${batchRows}</tbody></table></div>${canAddBatch?`<form method="post" action="/finishing/orders/${id}/batches" class="finishing-add-batch-form">${hidden('csrf',ctx.req.session.csrf)}<button type="submit" class="finishing-add-spec-button" aria-label="Dodaj kolejne zlecenie barwiarskie" title="Dodaj kolejne zlecenie barwiarskie"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></form>`:''}</section>`:'';
  const incidentRows=incidents.map(incident=>`<li class="${incident.status==='open'?'finishing-incident-open':''}"><strong>${V.esc({lost:'Zagubiona belka',wrong_order:'Pomyłka w zamówieniu',correction:'Poprawa / zwrot',count_difference:'Różnica ilości',other:'Inne'}[incident.incident_type])}</strong> · ${V.datepl(incident.created_at)} · ${V.esc(incident.description)} <small>${V.esc(incident.author||'')}</small>${incident.status==='open'&&canEdit?`<form method="post" action="/finishing/incidents/${incident.id}/resolve">${hidden('csrf',ctx.req.session.csrf)}<input name="resolution" placeholder="Rozwiązanie / wyjaśnienie" maxlength="1000" required><button>Oznacz jako rozwiązane</button></form>`:incident.resolution?`<p>Rozwiązanie: ${V.esc(incident.resolution)}</p>`:''}</li>`).join('');
  const incidentForm=canEdit?`<form method="post" action="/finishing/orders/${id}/incidents" class="form-grid finishing-incident-form">${hidden('csrf',ctx.req.session.csrf)}<label>Rodzaj problemu<select name="incident_type"><option value="lost">Zagubiona belka</option><option value="wrong_order">Pomyłka w zamówieniu</option><option value="correction">Poprawa / zwrot</option><option value="count_difference">Różnica ilości</option><option value="other">Inne</option></select></label><label>Opis<input name="description" maxlength="1000" required></label><button class="button danger">Zapisz problem</button></form>`:'';
  const recipeBody=`<details class="panel padded"><summary>Receptura zapisana przy zleceniu</summary><p><strong>${V.esc(snapshot.name||'—')}</strong> · ${V.esc(snapshot.finishingPlant||order.finishing_plant_name||'')}</p><pre class="preline finishing-recipe-text">${V.esc(snapshot.recipeText||'')}</pre>${snapshot.notes?`<div class="preline finishing-recipe-card-notes">${recipeNotesHtml(snapshot.notes)}</div>`:''}</details>`;
  const orderNotes=`${order.manual_entry&&order.manual_input_description?`<div class="finishing-order-notes-view"><strong>Źródła / opis materiału:</strong><div class="finishing-recipe-card-notes">${V.esc(order.manual_input_description)}</div></div>`:''}${order.notes?`<div class="finishing-order-notes-view"><strong>Uwagi dodatkowe:</strong><div class="finishing-recipe-card-notes">${recipeNotesHtml(order.notes)}</div></div>`:''}`;
  const editLink=editableRoles.includes(ctx.req.user.role)&&(order.manual_entry||!['cancelled','raw_sale'].includes(order.status))?`<a class="button primary" href="/finishing/orders/${id}/edit">Edytuj dane i specyfikację</a>`:'';
  const deleteLink=editableRoles.includes(ctx.req.user.role)?`<a class="button danger" href="/finishing/orders/${id}/delete">Usuń zlecenie</a>`:'';
  const orderStatusDisplay=order.source_remainder_batch_id?(activeBatches.some(batch=>String(batch.finishing_lot||'').trim())?statusBadge('sent'):'<span class="badge finishing-remainder-status" title="PMR utworzona z brakującej ilości po przyjęciu">Braki z wykańczalni</span>'):statusBadge(orderWorkflowStatus);
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczalni</a><div class="pagehead"><div><span class="eyebrow">${orderStatusDisplay} <span class="finishing-order-type-label${order.manual_entry?' is-manual':''}">${V.esc(order.manual_entry?'Zlecenie ręczne':orderTypeLabel(order.order_type))}</span></span><h1>${V.esc(pm)} · ${V.esc(order.raw_symbol||'Surowiec do uzupełnienia')}</h1><p class="muted">Data wysyłki: ${V.datepl(lotBatch?.sent_at||order.created_at)} · ${order.shipment_article_id?`WZ ${V.esc(source)}`:'Bez powiązania z PM'} · ${V.esc(order.client_name||'—')} · ${V.esc(order.trade_symbol||'—')} · ${V.esc(order.finishing_plant_name||'—')}</p>${orderNotes}</div><div class="actions">${editLink}${remainderSettlementAction}${deleteLink}<a class="button" href="/finishing/orders/${id}/print" target="_blank">Drukuj zlecenie</a>${lotControl}</div></div>${piecesBody}${recipeBody}${lotDialog}${batchSection}
    ${batches.length?`<div class="sectionhead"><h2>Przyjęcia z farbiarni</h2></div>${receiptViews}${receiptDialogs.join('')}`:`<div class="panel padded muted">Nie utworzono wyjścia do farbiarni.</div>`}
    <section class="panel padded finishing-incidents"><h2>Problemy i wyjaśnienia</h2>${incidentForm}<ul>${incidentRows||'<li>Nie zapisano problemów.</li>'}</ul></section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:pm,body});
}
function orderEditPage(ctx,order) {
  const id=order.id,db=ctx.db;
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const plants=db.prepare('SELECT id,name,active FROM finishing_plants ORDER BY active DESC,name COLLATE NOCASE').all();
  const plantOptions=plants.map(plant=>`<option value="${plant.id}"${Number(order.finishing_plant_id)===plant.id?' selected':''}>${V.esc(plant.name)}${plant.active?'':' (nieaktywna)'}</option>`).join('');
  const manualRecipes=order.manual_entry?recipes(db,0,false).filter(recipe=>recipe.active||Number(recipe.id)===Number(order.recipe_id)):[];
  const selectedManualRecipe=manualRecipes.find(recipe=>Number(recipe.id)===Number(order.recipe_id)),manualRecipeLabel=selectedManualRecipe?`${selectedManualRecipe.name}${selectedManualRecipe.raw_symbol?` · ${selectedManualRecipe.raw_symbol}`:''}${selectedManualRecipe.active?'':' (nieaktywna)'}`:'';
  const manualRecipePicker=order.manual_entry?`<div class="finishing-manual-recipe-picker" data-finishing-manual-recipe-picker data-search-url="/finishing/orders/new?partial=recipes"><label for="manual-recipe-search">Receptura barwiarska (opcjonalnie)</label><div class="finishing-recipe-search-box"><input id="manual-recipe-search" type="search" role="combobox" data-finishing-manual-recipe-search value="${V.esc(manualRecipeLabel)}" placeholder="Wpisz nazwę lub symbol" autocomplete="off" aria-autocomplete="list" aria-expanded="false"><div class="finishing-recipe-live-results" data-finishing-manual-recipe-results role="listbox" aria-label="Pasujące receptury"></div></div><input type="hidden" name="recipe_id" value="${V.esc(order.recipe_id||'')}" data-finishing-manual-recipe>${selectedManualRecipe?`<small class="finishing-manual-recipe-selected" data-finishing-manual-recipe-selected>Wybrano: ${V.esc(manualRecipeLabel)}</small>`:'<small class="muted" data-finishing-manual-recipe-selected>Nie wybrano receptury</small>'}</div>`:'';
  const source=order.shipment_article_id?sourcePieces(db,order.shipment_article_id):[];
  const saved=db.prepare('SELECT id,bale_local_id,bale_number,production_date,machine,weight_kg,meters,lot FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(id);
  const pieces=new Map();
  for(const piece of source)pieces.set(piece.bale_local_id,{...piece,saved:false});
  for(const piece of saved)pieces.set(piece.bale_local_id,{...pieces.get(piece.bale_local_id),...piece,saved:true});
  const pieceRows=[...pieces.values()].map((piece,index)=>`<fieldset class="finishing-order-edit-bale"><legend>Belka ${V.esc(piece.bale_number||index+1)}</legend>
    <input type="hidden" name="bale_${index}_local_id" value="${V.esc(piece.bale_local_id)}"><label class="finishing-order-edit-bale-include"><input type="checkbox" name="bale_${index}_include" value="1"${piece.saved||saved.length===0?' checked':''}> Uwzględnij w zleceniu</label>
    <div class="form-grid"><label>Numer belki<input name="bale_${index}_number" value="${V.esc(piece.bale_number||'')}" maxlength="100"></label><label>Maszyna<input name="bale_${index}_machine" value="${V.esc(piece.machine||'')}" maxlength="100"></label><label>Data produkcji<input name="bale_${index}_date" type="date" value="${V.esc(piece.production_date||'')}"></label><label>Metry<input name="bale_${index}_meters" type="number" min="0.01" step="0.01" value="${V.esc(piece.meters??'')}"></label><label>Masa kg<input name="bale_${index}_weight" type="number" min="0.01" step="0.01" value="${V.esc(piece.weight_kg??'')}"></label><label>LOT przędzy<input name="bale_${index}_lot" value="${V.esc(piece.lot||'')}" maxlength="250"></label></div></fieldset>`).join('');
  const batches=orderBatches(db,id);
  const batchSummaryRows=batches.map((batch,index)=>`<div class="finishing-batch-edit-item"><input type="hidden" name="batch_${index}_id" value="${batch.id}"><div class="finishing-batch-summary-row">${order.manual_entry?`<div class="finishing-manual-date-recipe"><label>Data wysyłki<input name="batch_${index}_date" type="date" value="${V.esc(batch.sent_at||V.todayInput())}"></label>${index===0?manualRecipePicker:''}</div>`:`<label>Data wysyłki<input name="batch_${index}_date" type="date" value="${V.esc(batch.sent_at||V.todayInput())}"></label>`}<label>Sztuki wysłane<input name="batch_${index}_pieces" type="number" min="0" step="1" value="${V.esc(batch.sent_pieces)}"></label><label>Masa wysłana kg<input name="batch_${index}_weight" type="number" min="0" step="0.01" value="${V.esc(batch.raw_weight_kg)}"></label><label>LOT przędzy<input name="batch_${index}_yarn_lot" value="${V.esc(batch.yarn_lot||'')}" maxlength="250"></label></div></div>`).join('');
  const batchDetailRows=batches.map((batch,index)=>`<div class="finishing-batch-detail-row"><div class="form-grid">${order.manual_entry?'':`<label>Nr zlecenia<input name="batch_${index}_lot" value="${V.esc(batch.finishing_lot||'')}" maxlength="120"></label><label>Uwagi partii<input name="batch_${index}_notes" value="${V.esc(batch.notes||'')}" maxlength="3000"></label>`}${batch.correction_parent_batch_id?`<label class="finishing-correction-instruction">Instrukcja poprawki<textarea name="batch_${index}_instruction" maxlength="3000" rows="3">${V.esc(batch.correction_instruction||'')}</textarea></label><label>Symbol handlowy<input name="batch_${index}_trade_symbol" value="${V.esc(batch.correction_trade_symbol||order.trade_symbol||'')}" maxlength="200"></label><label>Kolor poprawki<input name="batch_${index}_color" value="${V.esc(batch.correction_target_color||order.target_color||'')}" maxlength="160"></label><label>Gramatura g/m²<input name="batch_${index}_grammage" type="number" min="0.1" step="0.1" value="${V.esc(batch.correction_target_grammage??order.target_grammage??'')}"></label><label>Szerokość cm<input name="batch_${index}_width" type="number" min="0.1" step="0.1" value="${V.esc(batch.correction_target_width_cm??order.target_width_cm??'')}"></label>`:''}</div></div>`).join('');
  const pm=pmReference(order);
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="/finishing/orders/${id}">← Zlecenie ${V.esc(pm)}</a><div class="pagehead"><div><span class="eyebrow">EDYCJA ZLECENIA · ${statusBadge(order.status)}</span><h1>Edytuj zlecenie wykańczania</h1><p class="muted">Możesz poprawiać dane, partie i belki także po wpisaniu LOT-u lub przyjęciu. Zmiany belek dotyczą kopii zlecenia; zamknięta WZ pozostaje bez zmian.</p></div></div>
  <form method="post" action="/finishing/orders/${id}/edit" class="panel padded finishing-order-edit-form">${hidden('csrf',ctx.req.session.csrf)}
    <section class="finishing-order-section"><h2>Dane zlecenia</h2>${batchSummaryRows}<input type="hidden" name="batch_count" value="${batches.length}"><div class="form-grid"><label>Symbol dzianiny<input name="raw_symbol" value="${V.esc(order.raw_symbol)}" maxlength="200"${order.manual_entry?'':' required'}></label><label>Symbol handlowy<input name="trade_symbol" value="${V.esc(order.trade_symbol||'')}" maxlength="200"></label><label>Klient<input name="client_name" value="${V.esc(order.client_name||'')}" maxlength="200"></label><label>Wykańczalnia<select name="finishing_plant_id"><option value="">Dowolna</option>${plantOptions}</select></label><label>Kolor zadany<input name="target_color" value="${V.esc(order.target_color||'')}" maxlength="160"></label><label>Usztywnienie<input name="target_stiffening" value="${V.esc(order.target_stiffening||'')}" maxlength="2000"></label><label>Gramatura g/m²<input name="target_grammage" type="number" min="0.1" step="0.1" value="${V.esc(order.target_grammage??'')}"></label><label>Szerokość cm<input name="target_width_cm" type="number" min="0.1" step="0.1" value="${V.esc(order.target_width_cm??'')}"></label></div>${order.manual_entry?`<label>Źródła / opis materiału<textarea name="manual_input_description" rows="3" maxlength="3000">${V.esc(order.manual_input_description||'')}</textarea></label>`:''}${notesEditorField({label:'Uwagi do zlecenia',ariaLabel:'Uwagi do zlecenia',value:order.notes||''})}${batchDetailRows}</section>
    <section class="finishing-order-section"><h2>Receptura zapisana przy zleceniu</h2>${order.manual_entry?'<p class="muted">Wybór receptury jest opcjonalny; zapisane niżej dane receptury pozostają edytowalne.</p>':''}<div class="form-grid"><label>Nazwa receptury<input name="recipe_name" value="${V.esc(snapshot.name||'')}" maxlength="200"></label><label>Receptura / instrukcja<textarea name="recipe_text" rows="8" maxlength="20000">${V.esc(snapshot.recipeText||'')}</textarea></label></div>${notesEditorField({name:'recipe_notes',label:'Uwagi receptury',ariaLabel:'Uwagi receptury',value:snapshot.notes||''})}</section>
    ${order.manual_entry?'':`<section class="finishing-order-section"><h2>Specyfikacja i belki zlecenia</h2><p class="muted">Zaznacz belki uwzględnione w zleceniu i popraw ich dane. Zmiana nie modyfikuje zamkniętej specyfikacji WZ.</p>${pieceRows||'<p class="muted">Brak belek powiązanych z tą pozycją WZ.</p>'}<input type="hidden" name="bale_count" value="${pieces.size}"></section>`}
    <div class="actions"><a class="button" href="/finishing/orders/${id}">Wróć</a><button class="primary">Zapisz wszystkie zmiany</button></div>
  </form>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Edytuj ${pm}`,body});
}
function receiptsPage(ctx) {
  cleanupCorrectionRemainderPmrs(ctx.db);
  const q=String(ctx.url.searchParams.get('q')||'').trim(),query=q.length>=2?q.split(/\s+/).map(normalizeSearch).filter(Boolean):[];
  const db=ctx.db,all=Costing.settlementRows(db),view=ctx.url.searchParams.get('view')==='settled'?'settled':'pending',year=String(ctx.url.searchParams.get('year')||''),month=String(ctx.url.searchParams.get('month')||''),from=String(ctx.url.searchParams.get('from')||''),to=String(ctx.url.searchParams.get('to')||''),plantId=String(ctx.url.searchParams.get('plant_id')||'');
  const dateOf=row=>String(row.receipt_date||row.closed_at||row.sent_at||'').slice(0,10);
  const filtered=all.filter(({row,context})=>{
    const haystack=[row.raw_symbol,row.article_description,row.manual_input_description,row.client_name,row.trade_symbol,row.source_shipment_no,finishingOrderNo(row),row.manual_reference,row.finishing_plant_name,row.source_remainder_batch_id?'braki zagubiona zniszczona':'',row.article_sequence?`PM ${articleNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year},{sequence:row.article_sequence})}`:'',String(row.order_id),String(row.batch_id),row.complaint_status].map(normalizeSearch).join(' '),date=dateOf(row);
    const isSettled=context?.settlement?.status==='settled';
    return query.every(token=>haystack.includes(token))&&(!year||date.startsWith(`${year}-`))&&(!month||date.slice(5,7)===month)&&(!from||date>=from)&&(!to||date<=to)&&(!plantId||String(row.finishing_plant_id||'')===plantId)&&(view==='settled'?isSettled:!isSettled);
  });
  const latest=Costing.latestImport(db),groups=new Map(),years=[...new Set(all.map(({row})=>dateOf(row).slice(0,4)).filter(value=>/^\d{4}$/.test(value)))].sort((a,b)=>b.localeCompare(a));
  for(const item of filtered){const key=Number(item.row.order_id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  const statusBadgeFor=status=>status==='settled'?'<span class="badge approved">Rozliczona</span>':status==='changed'?'<span class="badge archived">Rozliczona – zmieniona</span>':status==='partial'?'<span class="badge submitted">Częściowo rozliczona</span>':'<span class="badge submitted">Do rozliczenia</span>';
  const groupRows=[];
  for(const [orderId,items] of groups){
    const first=items[0].row,pm=pmReference(first);
    const active=items.filter(item=>item.row.complaint_status!=='poprawiona'),settled=active.filter(item=>item.context?.settlement?.status==='settled').length,changed=active.some(item=>item.context?.settlement?.status==='changed');
    const parentStatus=changed?'changed':settled>0&&settled<active.length?'partial':active.length>0&&settled===active.length?'settled':'draft';
    const orderStatus=first.order_type==='raw_sale'?'<span class="badge finishing-pms-status">Sprzedaż surowej</span>':statusBadgeFor(parentStatus);
    groupRows.push(`<tr class="finishing-settlement-pm-row"><th colspan="12"><div class="finishing-settlement-pm-heading"><a class="finishing-order-pm${first.order_type==='raw_sale'?' is-pms':first.manual_entry?' is-manual':''}" href="/finishing/orders/${orderId}">${V.esc(pm)}</a><span class="finishing-settlement-pm-status">${orderStatus}</span><span class="finishing-settlement-pm-symbols"><strong>${V.esc(first.raw_symbol||'—')}</strong>${first.trade_symbol?` · ${V.esc(first.trade_symbol)}`:''}</span></div></th></tr>`);
    for(const item of items){
      const row=item.row,c=item.context,settlement=c?.settlement,output=c?.output||{output_quantity:0,output_unit:'mb',receipt_count:0},price=c?.price,readOnly=view==='settled';
      const replaced=row.complaint_status==='poprawiona',complained=row.complaint_status==='reklamowana',canSelect=readOnly?['settled','changed'].includes(settlement?.status):!replaced&&!complained&&row.order_status!=='cancelled';
      const correctionOrderNumber=row.workflow_status==='do_poprawy'?activeCorrectionOrderNumber(db,row.batch_id):'';
      const rawBasePrice=settlement?.raw_price_per_kg??price?.current_price??price?.theoretical_price??'',rawTheoretical=settlement?.theoretical_raw_price_per_kg??price?.theoretical_price??price?.current_price??'';
      const basePrice=rawBasePrice===''?'':Number(rawBasePrice).toFixed(2),theoretical=rawTheoretical===''?'':Number(rawTheoretical).toFixed(2);
      const usedKg=settlement?.used_weight_kg??c?.usedWeight??row.raw_weight_kg??'',unit=output.output_unit||'mb',outQty=Costing.round2(output.output_quantity||0);
      const orderName=finishingOrderNo(row)||row.manual_reference||`#${row.batch_id}`,state=row.order_type==='raw_sale'?'<span class="badge finishing-pms-status">Sprzedaż surowej</span>':row.source_remainder_batch_id?`<span class="badge finishing-remainder-status" title="Brakująca ilość z automatycznej PMR">Braki z wykańczalni</span><small class="finishing-subline">${settlement?(settlement.status==='settled'?'Rozliczona':settlement.status==='changed'?'Rozliczona – zmieniona':'Robocza'):'Do rozliczenia'}</small>`:row.workflow_status==='do_poprawy'?`<span class="badge finishing-correction-sent">Poprawa spec.${correctionOrderNumber?`: ${V.esc(correctionOrderNumber)}`:''}</span>`:complained?'<span class="badge archived">Reklamowana</span>':replaced?'<span class="badge approved">Poprawiona</span>':settlement?(settlement.status==='settled'?'<span class="badge approved">Rozliczona</span>':settlement.status==='changed'?'<span class="badge archived">Zmieniona</span>':'<span class="badge submitted">Robocza</span>'):'<span class="badge submitted">Do rozliczenia</span>';
      const history=Costing.comparableHistory(db,row.trade_symbol,settlement?.output_unit||unit,row.batch_id,1000),previous=history[0],historyDialogId=`finishing-cost-history-${row.batch_id}`;
      const historyHtml=history.length?`<button type="button" class="finishing-cost-history-open" data-open-dialog="${historyDialogId}">Historia (${history.length})</button><dialog id="${historyDialogId}" class="form-dialog finishing-cost-history-dialog"><div class="dialog-head"><strong>Historia porównywalnych przyjęć · ${V.esc(row.trade_symbol||'bez symbolu')}</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body"><div class="panel scroll"><table class="listing compact"><thead><tr><th>Data</th><th>PM</th><th>Zlecenie</th><th>Ilość</th><th>Rzeczywisty / jedn.</th><th>Teoretyczny / jedn.</th></tr></thead><tbody>${history.map(h=>{const hpm=h.article_sequence?`PM ${articleNo({sequence:h.shipment_sequence,shipment_year:h.shipment_year},{sequence:h.article_sequence})}`:`PM ${h.source_shipment_no||'—'}`;return `<tr><td>${V.datepl(h.approved_at)}</td><td>${V.esc(hpm)}</td><td>${V.esc(finishingOrderNo(h)||`#${h.batch_id}`)}</td><td>${qty(h.output_quantity)} ${h.output_unit}</td><td>${money(h.actual_unit_cost)} zł/${h.output_unit}</td><td>${money(h.theoretical_unit_cost)} zł/${h.output_unit}</td></tr>`;}).join('')}</tbody></table></div></div></dialog>`:'<small class="muted">Brak wcześniejszych porównywalnych przyjęć.</small>';
      const importHint=price?'Excel':'Wpisz ręcznie',actualPriceHint=price?.current_price==null&&price?.theoretical_price!=null?'Zastosowano cenę teoretyczną':price?.current_error||importHint,date=dateOf(row),calcActual=settlement?.actual_unit_cost??'',calcTheoretical=settlement?.theoretical_unit_cost??'',prevActual=previous?.actual_unit_cost??'',prevTheoretical=previous?.theoretical_unit_cost??'';
      const complaint=row.source_remainder_batch_id?'':row.complaint_status==='reklamowana'?'<small class="finishing-subline">Reklamowana</small>':row.complaint_status==='poprawiona'?'<small class="finishing-subline">Poprawiona</small>':editableRoles.includes(ctx.req.user.role)?`<small class="finishing-subline"><a href="/finishing/orders/${row.order_id}#batch-${row.batch_id}">Reklamuj</a></small>`:'';
      const readOnlyAttr=readOnly?' readonly':'';
      groupRows.push(`<tr class="finishing-settlement-order-row${replaced?' is-replaced':''}${row.order_type==='raw_sale'?' is-pms':''}" data-settlement-row data-output-quantity="${outQty}" data-output-unit="${unit}" data-previous-actual="${V.esc(prevActual)}" data-previous-theoretical="${V.esc(prevTheoretical)}"><td><input form="finishing-settlement-form" type="checkbox" data-finishing-settlement-select value="${row.batch_id}" aria-label="Wybierz zlecenie ${V.esc(orderName)}"${canSelect?'':' disabled'}></td><td><strong>${V.esc(orderName)}</strong>${(row.correction_of_batch_id||row.correction_parent_batch_id)?'<small class="finishing-subline">Poprawkowe</small>':''}${row.source_remainder_batch_id?state:`<small class="finishing-subline">${state}</small>`}${complaint}</td><td>${readOnly?V.datepl(date):`<input form="finishing-settlement-form" class="finishing-cost-input" type="date" name="date_${row.batch_id}" value="${V.esc(settlement?.receipt_date||date)}" aria-label="Data przyjęcia · ${V.esc(orderName)}">`}<small class="finishing-subline">${V.esc(row.order_type==='raw_sale'?'Sprzedaż surowej':row.finishing_plant_name||'—')}</small></td><td><strong>${V.esc(row.trade_symbol||'—')}</strong></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="finishing_${row.batch_id}" type="number" min="0" step="0.01" value="${row.order_type==='raw_sale'?'0':V.esc(settlement?.finishing_cost??'')}" aria-label="Koszt wykończenia zł/kg · ${V.esc(orderName)}"${row.order_type==='raw_sale'?' readonly title="PMS — bez kosztu wykończenia"':readOnlyAttr}></td><td><input form="finishing-settlement-form" class="finishing-cost-input finishing-invoice-input" name="invoice_${row.batch_id}" maxlength="120" value="${V.esc(settlement?.invoice_note||'')}" aria-label="Faktura — notatka · ${V.esc(orderName)}" placeholder="Nr faktury / notatka"${readOnlyAttr}></td><td><input form="finishing-settlement-form" class="finishing-cost-input finishing-invoice-input" name="pz_${row.batch_id}" maxlength="120" value="${V.esc(settlement?.pz_number||'')}" aria-label="Nr PZ · ${V.esc(orderName)}" placeholder="Nr PZ"${readOnlyAttr}></td><td class="finishing-live-cost" data-live-cost><strong data-live-actual>${calcActual!==''?`${money(calcActual)} zł/${settlement.output_unit}`:'—'}</strong><small data-live-theoretical>${calcTheoretical!==''?`Teoria ${money(calcTheoretical)} zł/${settlement.output_unit}`:''}</small><small data-live-delta>${previous&&calcActual!==''?`Różnica: ${money(Number(calcActual)-Number(prevActual))} zł/${unit}`:''}</small>${historyHtml}</td><td class="finishing-output">${row.source_remainder_batch_id?`<strong>Brak: ${qty(outQty)} kg</strong><small>${Number(output.finished_pieces||0)} szt.</small>`:`<strong>${outQty>0?`${qty(outQty)} ${unit}`:'—'}</strong><small>${Number(output.finished_pieces||0)} szt.</small>`}</td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="used_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(usedKg)}" aria-label="Wykorzystane kg · ${V.esc(orderName)}"${readOnlyAttr}></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="price_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(basePrice)}" aria-label="Cena surowca · ${V.esc(orderName)}"${readOnlyAttr}><small class="finishing-subline">${V.esc(actualPriceHint)}</small></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="theoretical_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(theoretical)}" aria-label="Cena teoretyczna · ${V.esc(orderName)}"${readOnlyAttr}><small class="finishing-subline">${V.esc(price?.theoretical_error||importHint)}</small></td></tr>`);
    }
  }
  const latestDate=latest?.calculation_date||'2026-09-22',dateLabel=new Intl.DateTimeFormat('pl-PL',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Warsaw'}).format(new Date(`${latestDate}T12:00:00Z`)),canImport=['admin','approver'].includes(ctx.req.user.role);
  const uploadDialog=canImport?`<button type="button" class="button finishing-load-calculation" data-open-dialog="finishing-calculation-dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>Załaduj kalkulację</button><dialog id="finishing-calculation-dialog" class="form-dialog finishing-calculation-dialog"><div class="dialog-head"><strong>Załaduj kalkulację kosztów surowca</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body"><p class="finishing-current-calculation">${latest?`Aktualna kalkulacja · plik ${V.esc(latest.source_name)} · obliczona na ${V.esc(dateLabel)} · ${latest.item_count} symboli`:'Nie wczytano jeszcze kalkulacji.'}</p><form data-finishing-calculation-upload data-csrf="${V.esc(ctx.req.session.csrf)}"><label>Plik kalkulacji Excel (.xlsx)<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-finishing-calculation-file required></label><label>Data kalkulacji z pliku<input type="date" name="calculation_date" value="${V.esc(latestDate)}" required></label><button class="primary" data-finishing-calculation-upload-button>Wczytaj plik</button><span class="muted" data-finishing-calculation-upload-status aria-live="polite"></span></form><small class="muted">Dopasowanie cen następuje po symbolu surowca.</small></div></dialog>`:'';
  const monthOptions=Array.from({length:12},(_,index)=>{const value=String(index+1).padStart(2,'0');return `<option value="${value}"${month===value?' selected':''}>${new Intl.DateTimeFormat('pl-PL',{month:'long'}).format(new Date(2026,index,1))}</option>`;}).join('');
  const filterForm=`<form method="get" action="/finishing/receipts" class="shipment-list-filters finishing-settlement-filters" data-live-search data-live-search-min="2"><input type="hidden" name="view" value="${view}"><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Wpisz co najmniej 2 znaki"></label><label>Wykańczalnia<select name="plant_id"><option value="">Wszystkie</option>${plants(db).map(plant=>`<option value="${plant.id}"${plantId===String(plant.id)?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><label>Rok<select name="year"><option value="">Wszystkie</option>${years.map(value=>`<option value="${value}"${year===value?' selected':''}>${value}</option>`).join('')}</select></label><label>Miesiąc<select name="month"><option value="">Wszystkie</option>${monthOptions}</select></label><label>Od<input type="date" name="from" value="${V.esc(from)}"></label><label>Do<input type="date" name="to" value="${V.esc(to)}"></label></form>`;
  const tabHref=target=>{const params=new URLSearchParams();params.set('view',target);for(const [key,value] of [['q',q],['year',year],['month',month],['from',from],['to',to],['plant_id',plantId]])if(value)params.set(key,value);return `/finishing/receipts?${params.toString()}`;};
  const receiptTabs=`<nav class="finishing-receipt-tabs" aria-label="Przyjęcia"><a class="${view==='pending'?'selected':''}" href="${tabHref('pending')}">Do rozliczenia</a><a class="${view==='settled'?'selected':''}" href="${tabHref('settled')}">Przyjęte i rozliczone</a></nav>`;
  const settlementActions=view==='settled'?`<button class="button danger">Cofnij rozliczenie</button>`:`<button class="button" name="settlement_action" value="save">Zapisz roboczo</button><button class="primary" name="settlement_action" value="approve">Zatwierdź rozliczenie</button><button class="button" formaction="/finishing/settlements/report" name="settlement_action" value="report">Raport do Subiekta</button>`;
  const body=`${navTabs('receipts',db)}<div class="pagehead finishing-settlement-head"><div><span class="eyebrow">WYKAŃCZANIE</span><div class="finishing-settlement-title"><h1>Przyjęcia i rozliczenia</h1>${uploadDialog}</div></div></div>${receiptTabs}${filterForm}<div data-live-results><div class="panel scroll"><table class="listing compact finishing-receipts-list finishing-settlements-list"><thead><tr><th><input type="checkbox" form="finishing-settlement-form" data-finishing-settlement-all aria-label="Zaznacz widoczne zlecenia"></th><th>Nr zlecenia barw.</th><th>Data</th><th>Symbol wykańczalni</th><th>Koszt wykończenia zł/kg</th><th>Nr faktury / notatka</th><th>Nr PZ</th><th>Wyliczona cena</th><th>Odebrane</th><th>Wykorzystane kg</th><th>Surowiec zł/kg</th><th>Teoria zł/kg</th></tr></thead><tbody>${groupRows.join('')||`<tr><td colspan="12">${view==='settled'?'Brak przyjętych i rozliczonych partii dla wybranych filtrów.':'Brak przyjętych zleceń do rozliczenia dla wybranych filtrów.'}</td></tr>`}</tbody></table></div><form id="finishing-settlement-form" method="post" action="${view==='settled'?'/finishing/settlements/revert':'/finishing/settlements/save'}" data-finishing-settlement-form>${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="batch_ids" value="" data-finishing-settlement-ids><div class="actions finishing-settlement-actions">${settlementActions}${view==='pending'?'<button class="button danger" formaction="/finishing/settlements/revert">Cofnij rozliczenie</button>':''}<span class="muted" data-finishing-settlement-selection>Wybierz zlecenia barwiarskie.</span></div></form></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Przyjęcie towaru',body});
}
function lostPage(ctx) {
  const canManage=editableRoles.includes(ctx.req.user.role);
  const rows=ctx.db.prepare(`SELECT i.*,b.finishing_lot,b.sent_at,o.created_at order_created_at,o.source_shipment_no,o.manual_entry,o.manual_reference,
      s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence
    FROM finishing_incidents i JOIN finishing_batches b ON b.id=i.batch_id JOIN finishing_orders o ON o.id=i.order_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id LEFT JOIN shipments s ON s.id=sa.shipment_id
    WHERE i.auto_generated=1 AND i.incident_type='lost' ORDER BY i.created_at DESC,i.id DESC`).all();
  const pm=row=>pmReference(row);
  const rowsHtml=rows.map(row=>{
    const foundSelected=Boolean(row.found_at&&(!row.settled_at||row.found_at>=row.settled_at)),settledSelected=Boolean(row.settled_at&&(!row.found_at||row.settled_at>row.found_at));
    const action=(kind,label,done)=>`<form method="post" action="/finishing/lost/${row.id}/${kind}">${hidden('csrf',ctx.req.session.csrf)}<label class="finishing-lost-status-pill${done?' is-active':''}"><input type="checkbox"${done?' checked':''}${canManage?` onchange="this.form.requestSubmit()"`:' disabled'} aria-label="${label}" title="${label}"><span>${label}</span></label></form>`;
    const additionalInfo=canManage?`<form class="finishing-lost-info-form" method="post" action="/finishing/lost/${row.id}/info">${hidden('csrf',ctx.req.session.csrf)}<input name="additional_info" value="${V.esc(row.resolution||'')}" maxlength="1000" placeholder="Dodatkowe info" aria-label="Dodatkowe info"><button class="button">Zapisz</button></form>`:V.esc(row.resolution||'—');
    return `<tr><td>${row.lost_pieces} szt.</td><td>${money(row.lost_weight_kg)} kg</td><td><a class="finishing-order-pm${row.manual_entry?' is-manual':''}" href="/finishing/orders/${row.order_id}">${V.esc(pm(row))}</a></td><td>${V.esc(finishingOrderNo(row)||'—')}</td><td>${V.datepl(row.order_created_at)}</td><td>${V.datepl(row.created_at)}</td><td>${additionalInfo}</td><td class="finishing-lost-actions">${action('found','Odnaleziona',foundSelected)}${action('settle','Rozliczona z wykańczalnią',settledSelected)}</td></tr>`;
  }).join('');
  const body=`${navTabs('lost',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Zagubione/zniszczone</h1><p class="muted">Braki są dopisywane automatycznie po zamknięciu przyjęcia partii.</p></div></div><div class="panel scroll"><table class="listing compact finishing-lost-list"><thead><tr><th>Brak</th><th>Masa</th><th>PM</th><th>Nr zlecenia</th><th>Data zlecenia</th><th>Data przyjęcia</th><th>Dodatkowe info</th><th>Status</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="8">Brak zagubionych lub zniszczonych sztuk.</td></tr>'}</tbody></table></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Zagubione/zniszczone',body});
}
function recipeForm(ctx,recipe=null,initialRawSymbol='',returnToOrder=false) {
  const plantList=plants(ctx.db),rawArticles=ctx.db.prepare("SELECT DISTINCT a.symbol,r.payload FROM articles a LEFT JOIN records r ON r.id=a.active_spec WHERE trim(a.symbol)<>'' ORDER BY a.symbol COLLATE NOCASE").all().map(article=>{
    let payload={};try{payload=JSON.parse(article.payload||'{}')}catch{}
    return {symbol:article.symbol,composition:V.yarnComposition(Array.isArray(payload.gb)?payload.gb:[])};
  }),r=recipe||{raw_symbol:initialRawSymbol},d=readRecipeDetails(recipe),tradeParts=recipeTradeSymbolParts(recipe);
  if(recipe&&!Object.keys(d).length&&r.target_stiffening){d.stiffeningEnabled='yes';d.stiffeningDescription=r.target_stiffening;}
  const yesNo=(name,label,selected='')=>`<label class="finishing-check-option">${hidden(name,'no')}<input type="checkbox" name="${name}" value="yes"${selected==='yes'?' checked':''}><span>${label}</span></label>`;
  const input=(label,name,val='',attrs='')=>`<label>${label}<input name="${name}" value="${V.esc(val??'')}" ${attrs}></label>`;
  const area=(label,name,val='',rows=3,hint='')=>`<label>${label}${hint?`<small class="muted">${hint}</small>`:''}<textarea name="${name}" rows="${rows}">${V.esc(val||'')}</textarea></label>`;
  const legacyNotes=Object.keys(d).length?(r.notes||''):[r.recipe_text,r.notes].filter(Boolean).join('\n');
  const tolerance=(label,plusName,minusName,detailsPlus,detailsMinus,unit)=>`<fieldset class="finishing-tolerance"><legend>Tolerancja ${unit}</legend><label><span>+</span><input aria-label="Tolerancja plus ${label}" name="${plusName}" value="${V.esc(detailsPlus??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label><label><span>−</span><input aria-label="Tolerancja minus ${label}" name="${minusName}" value="${V.esc(detailsMinus??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label></fieldset>`;
  const winding=(d.winding||[]).filter(Boolean).join('\n');
  const recipeNotesValue=JSON.stringify(recipeNotesData(legacyNotes));
  const recipeNotesSizes=RECIPE_NOTES_SIZES.map(size=>`<option value="${size}"${size===16?' selected':''}>${size} px</option>`).join('');
  const savedLabelTemplate=labelTemplate(r.label_settings);
  const labelFieldOption=(key,label,control='')=>`<div class="finishing-label-option-with-input"><label class="finishing-label-option"><input type="checkbox" name="label_field_${key.replace(/-/g,'_')}" value="1" data-label-field="${key}"${savedLabelTemplate.fields[key]?' checked':''}><span>${label}</span></label>${control}</div>`;
  const labelTemplateSection=`<section class="finishing-recipe-section finishing-recipe-label-template"><h2>Wzór etykiety</h2><p class="muted">Te ustawienia wczytają się przy wyborze tej receptury. W oknie wydruku możesz je zmienić tylko dla bieżącego wydruku.</p><div class="finishing-recipe-label-template-controls"><fieldset><legend>Górna część</legend><div class="finishing-recipe-label-option-row"><label class="finishing-check-option"><input type="checkbox" name="label_brand_logo" value="1"${savedLabelTemplate.brandMode==='logo'?' checked':''}><span>Logo Marand</span></label></div><div class="finishing-recipe-label-option-row"><label class="finishing-check-option"><input type="checkbox" name="label_brand_text" value="1"${savedLabelTemplate.brandMode==='text'?' checked':''}><span>Własny tekst</span></label><input name="label_brand_text_value" value="${V.esc(savedLabelTemplate.brandText)}" maxlength="80" placeholder="Tekst u góry"></div><div class="finishing-recipe-label-option-row finishing-recipe-client-logo-row"><label class="finishing-check-option"><input type="checkbox" name="label_brand_client_logo" value="1"${savedLabelTemplate.brandMode==='client-logo'?' checked':''}${savedLabelTemplate.clientLogo?'':' disabled'}><span>Logo klienta</span></label><input type="file" accept="image/jpeg,image/png" data-label-client-logo-file aria-label="Wczytaj logo klienta"><input type="hidden" name="label_client_logo_data" value="${V.esc(savedLabelTemplate.clientLogo)}" data-label-client-logo-data><img src="${V.esc(savedLabelTemplate.clientLogo)}" alt="Podgląd logo klienta" data-label-client-logo-preview${savedLabelTemplate.clientLogo?'':' hidden'}><button type="button" data-label-client-logo-clear${savedLabelTemplate.clientLogo?'':' hidden'}>Usuń logo</button><small class="muted" data-label-client-logo-status>${savedLabelTemplate.clientLogo?'Logo klienta zapisane.':'JPG lub PNG, maksymalnie 350 KB.'}</small></div></fieldset><fieldset><legend>Pola etykiety</legend>${labelFieldOption('symbol','Symbol handlowy')}${labelFieldOption('raw-symbol','Symbol surowy')}${labelFieldOption('color','Kolor',`<input name="label_color_text" value="${V.esc(savedLabelTemplate.colorText)}" maxlength="100" placeholder="Domyślnie z symbolu handlowego">`)}${labelFieldOption('lot','Nr partii')}${labelFieldOption('width','Szerokość')}${labelFieldOption('grammage','Gramatura')}${labelFieldOption('client','Klient')}${labelFieldOption('weight','Waga [kg]')}${labelFieldOption('extra-text','Dodatkowy tekst',`<input name="label_extra_text" value="${V.esc(savedLabelTemplate.extraText)}" maxlength="100" placeholder="Tekst bez opisu na etykiecie">`)}${labelFieldOption('distance','Dystans [mm]',`<input type="number" min="0.1" step="0.1" name="label_distance" value="${V.esc(savedLabelTemplate.distance)}" maxlength="30" inputmode="decimal" placeholder="Opcjonalnie, dzianina 3D">`)}</fieldset><fieldset><legend>Ilość</legend><div class="finishing-recipe-label-choice-row"><label><input type="radio" name="label_quantity_unit" value="meters"${savedLabelTemplate.quantityUnit==='meters'?' checked':''}> MB</label><label><input type="radio" name="label_quantity_unit" value="weight"${savedLabelTemplate.quantityUnit==='weight'?' checked':''}> KG</label></div><label class="finishing-check-option"><input type="checkbox" name="label_include_meters" value="1"${savedLabelTemplate.includeMeters?' checked':''}><span>Dodatkowo pokaż metry mniejszą czcionką</span></label></fieldset><label>Język<select name="label_language"><option value="pl"${savedLabelTemplate.language==='pl'?' selected':''}>Polski</option><option value="en"${savedLabelTemplate.language==='en'?' selected':''}>English</option></select></label></div></section>`;
  const languageOptions=`<fieldset class="finishing-label-language"><legend>Język etykiety</legend><div class="finishing-label-radio-row"><label class="finishing-label-option"><input type="radio" name="label_language" value="pl" data-label-language${savedLabelTemplate.language==='pl'?' checked':''}><span>Polski</span></label><label class="finishing-label-option"><input type="radio" name="label_language" value="en" data-label-language${savedLabelTemplate.language==='en'?' checked':''}><span>English</span></label></div></fieldset>`;
  const labelTemplateSectionEditor=labelTemplateSection
    .replace('<div class="finishing-recipe-label-template-controls">',`<div class="finishing-label-config-layout finishing-recipe-label-config-layout"><section class="finishing-label-preview-panel"><div class="finishing-label-preview-size"><article class="finishing-label-preview" data-recipe-label-preview></article></div><small>Podgląd etykiety · 50 × 74 mm · wartości przykładowe</small>${languageOptions}</section><div class="finishing-label-options"><div class="finishing-recipe-label-template-controls">`)
    .replace('<div class="finishing-recipe-label-option-row"><label class="finishing-check-option"><input type="checkbox" name="label_brand_logo" value="1"','<div class="finishing-recipe-label-option-row"><label class="finishing-label-option"><input type="checkbox" name="label_brand_logo" value="1"')
    .replace('<label class="finishing-check-option"><input type="checkbox" name="label_brand_text" value="1"','<label class="finishing-label-option"><input type="checkbox" name="label_brand_text" value="1"')
    .replace('<label class="finishing-check-option"><input type="checkbox" name="label_brand_client_logo" value="1"','<label class="finishing-label-option"><input type="checkbox" name="label_brand_client_logo" value="1"')
    .replace('<fieldset><legend>Górna część</legend>','<fieldset><legend>Górna część etykiety</legend>')
    .replace('<fieldset><legend>Pola etykiety</legend>','<fieldset><legend>Pola etykiety</legend>')
    .replace('<input name="label_color_text"','<input data-recipe-label-color name="label_color_text"')
    .replace('<input name="label_extra_text"','<input data-recipe-label-extra name="label_extra_text"')
    .replace('name="label_distance"','name="label_distance" data-recipe-label-distance')
    .replace('<div class="finishing-recipe-label-choice-row">','<div class="finishing-label-radio-row">')
    .replace('<label><input type="radio" name="label_quantity_unit"','<label class="finishing-label-option"><input type="radio" name="label_quantity_unit" data-label-quantity-unit')
    .replace('> MB</label><label><input type="radio" name="label_quantity_unit"','><span>MB</span></label><label class="finishing-label-option"><input type="radio" name="label_quantity_unit" data-label-quantity-unit')
    .replace('> KG</label></div><label class="finishing-check-option"><input type="checkbox" name="label_include_meters"','><span>KG</span></label></div><label class="finishing-label-option"><input type="checkbox" name="label_include_meters" data-label-secondary-meters')
    .replace(/<label>Język<select name="label_language">[\s\S]*?<\/select><\/label><\/div><\/section>$/,'</div></div></div></section>');
  const copySources=recipe?[]:recipes(ctx.db).map(source=>{
    const sourceDetails=readRecipeDetails(source),notes=Object.keys(sourceDetails).length?(source.notes||''):[source.recipe_text,source.notes].filter(Boolean).join('\n');
    const parts=recipeTradeSymbolParts(source);
    return {label:`${source.name} · ${source.raw_symbol||'bez symbolu'} · #${source.id}`,values:{raw_symbol:source.raw_symbol||'',trade_symbol:parts.symbol,trade_color_symbol:parts.color,raw_material:sourceDetails.rawMaterial||'',target_color:source.target_color||'',finishing_plant_id:source.finishing_plant_id||'',target_grammage:source.target_grammage??'',target_grammage_plus:sourceDetails.grammagePlus??'',target_grammage_minus:sourceDetails.grammageMinus??'',target_width_cm:source.target_width_cm??'',target_width_plus:sourceDetails.widthPlus??'',target_width_minus:sourceDetails.widthMinus??'',width_between_needles:sourceDetails.widthMode==='needles',brushing:sourceDetails.brushing==='yes',brushing_for_velcro:sourceDetails.brushingForVelcro==='yes',stiffening_enabled:sourceDetails.stiffeningEnabled==='yes',stiffening_description:sourceDetails.stiffeningDescription||'',softening_enabled:sourceDetails.softeningEnabled==='yes',softening_description:sourceDetails.softeningDescription||'',trim_edges:sourceDetails.trimEdges==='yes',bond_edges:sourceDetails.bondEdges==='yes',trim_sygnits:sourceDetails.trimSygnits==='yes',winding:(sourceDetails.winding||[]).filter(Boolean).join('\n'),shrinkage:sourceDetails.shrinkage||'',notes}};
  });
  const copyData=JSON.stringify(copySources).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  const copyControls=!recipe?`<div class="finishing-recipe-copy"><label>Kopiuj parametry receptury<input type="search" list="finishing-recipe-copy-options" placeholder="Wyszukaj recepturę…" autocomplete="off" data-finishing-recipe-copy-search></label><datalist id="finishing-recipe-copy-options">${copySources.map(source=>`<option value="${V.esc(source.label)}"></option>`).join('')}</datalist><button type="button" data-finishing-recipe-copy-button disabled>Kopiuj</button><small class="muted" data-finishing-recipe-copy-status>${copySources.length?'':'Brak receptur do skopiowania.'}</small><script type="application/json" data-finishing-recipe-copy-data>${copyData}</script></div>`:'';
  const compositionMap=JSON.stringify(Object.fromEntries(rawArticles.filter(article=>article.composition!=='—').map(article=>[article.symbol,article.composition]))).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  return `<form method="post" action="${recipe?`/finishing/recipes/${recipe.id}`:'/finishing/recipes'}" class="finishing-recipe-form">${hidden('csrf',ctx.req.session.csrf)}${returnToOrder?hidden('return_to_order','1'):''}
    <script type="application/json" data-article-composition-map>${compositionMap}</script>
    <section class="finishing-recipe-section finishing-recipe-identity"><div class="finishing-recipe-top-row${recipe?' is-editing':''}"><div class="finishing-recipe-primary"><label for="recipe-name">Nazwa receptury</label><input id="recipe-name" name="name" value="${V.esc(r.name||'')}" maxlength="200" placeholder="Wpisz nazwę receptury" required autofocus></div>${copyControls}</div><div><h2>Identyfikacja dzianiny</h2><div class="finishing-recipe-identity-grid"><label>Symbol dzianiny surowej<input name="raw_symbol" value="${V.esc(r.raw_symbol||'')}" list="finishing-recipe-articles" maxlength="200" required data-article-symbol><datalist id="finishing-recipe-articles">${rawArticles.map(article=>`<option value="${V.esc(article.symbol)}"></option>`).join('')}</datalist></label>${input('Symbol handlowy','trade_symbol',tradeParts.symbol,'maxlength="200"')}${input('Symbol koloru handlowego','trade_color_symbol',tradeParts.color,'maxlength="200"')}<label>Surowiec / skład procentowy<input name="raw_material" value="${V.esc(d.rawMaterial||'')}" maxlength="1000" data-article-composition><small class="muted">Po wybraniu symbolu skład jest pobierany z aktualnej karty technicznej artykułu.</small></label>${input('Kolor / oznaczenie z farbiarni','target_color',r.target_color,'maxlength="160"')}<label>Domyślna wykończalnia<select name="finishing_plant_id"><option value="">Dowolna</option>${plantList.map(plant=>`<option value="${plant.id}"${Number(r.finishing_plant_id)===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label>${yesNo('trial_recipe','Receptura próbna',d.trialRecipe)}</div></div></section>
    <div class="finishing-recipe-technical-row"><section class="finishing-recipe-section"><h2>Parametry oczekiwane</h2><div class="finishing-measurement-row"><label class="finishing-measurement-value"><span>Gramatura g/m²</span><input name="target_grammage" value="${V.esc(r.target_grammage??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label>${tolerance('gramatury','target_grammage_plus','target_grammage_minus',d.grammagePlus,d.grammageMinus,'g/m²')}</div><div class="finishing-measurement-row"><label class="finishing-measurement-value"><span>Szerokość cm</span><input name="target_width_cm" value="${V.esc(r.target_width_cm??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label>${tolerance('szerokości','target_width_plus','target_width_minus',d.widthPlus,d.widthMinus,'cm')}<label class="finishing-check-option finishing-width-needles">${hidden('width_between_needles','no')}<input type="checkbox" name="width_between_needles" value="yes"${d.widthMode==='needles'?' checked':''}><span>Szerokość między igłami</span></label></div>${area('Kurczliwości','shrinkage',d.shrinkage,1)}</section>
    <section class="finishing-recipe-section finishing-recipe-processing"><h2>Uszlachetnianie i obróbka</h2><div class="finishing-process-top-options">${yesNo('brushing','Drapanie',d.brushing)}${yesNo('brushing_for_velcro','Drapanie pod rzep',d.brushingForVelcro)}</div><div class="finishing-process-grid"><div class="finishing-process-described">${yesNo('stiffening_enabled','Usztywnienie',d.stiffeningEnabled)}${input('Opis procesu','stiffening_description',d.stiffeningDescription,'maxlength="2000"')}</div><div class="finishing-process-described">${yesNo('softening_enabled','Zmiękczenie',d.softeningEnabled)}${input('Opis procesu','softening_description',d.softeningDescription,'maxlength="2000"')}</div>${yesNo('trim_edges','Obcinanie brzegów',d.trimEdges)}${yesNo('bond_edges','Podklejanie brzegów',d.bondEdges)}${yesNo('trim_sygnits','Obcinanie sygnitów',d.trimSygnits)}</div></section></div>
    <section class="finishing-recipe-section"><h2>Nawijanie</h2><label>Instrukcje nawijania<textarea class="finishing-winding-input" name="winding_1" rows="3" maxlength="1000">${V.esc(winding)}</textarea></label></section>
    <section class="finishing-recipe-section"><h2>Uwagi dodatkowe</h2><div class="finishing-notes-editor-label"><span class="finishing-notes-field-label">Dodatkowe informacje</span><div class="finishing-notes-editor" data-finishing-notes-editor><div class="finishing-notes-toolbar" role="toolbar" aria-label="Formatowanie uwag"><button type="button" data-finishing-notes-bold aria-pressed="false" title="Włącz lub wyłącz pogrubienie"><strong>B</strong></button><button type="button" data-finishing-notes-underline aria-pressed="false" title="Włącz lub wyłącz podkreślenie"><u>U</u></button><button type="button" data-finishing-notes-italic aria-pressed="false" title="Włącz lub wyłącz kursywę"><em>I</em></button><label>Rozmiar<select data-finishing-notes-size>${recipeNotesSizes}</select></label><span class="muted small">Kliknij formatowanie, aby pisać z nim dalej; zaznacz tekst, aby zmienić istniejący.</span></div><div class="finishing-notes-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Uwagi dodatkowe receptury" data-finishing-notes-content>${recipeNotesEditorHtml(legacyNotes)}</div><input type="hidden" name="notes" value="${V.esc(recipeNotesValue)}" data-finishing-notes-value></div><small class="muted">Każda linia zostanie zachowana osobno na wydruku.</small></div></section>${labelTemplateSectionEditor}
    <div class="finishing-form-actions"><button class="primary">${recipe?'Zapisz zmiany':'Dodaj recepturę'}</button></div></form>`;
}
function recipesPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),plantId=Number(ctx.url.searchParams.get('plant_id')||0),status=ctx.url.searchParams.get('status')==='inactive'?'inactive':'active',activeValue=status==='active'?1:0,allRecipes=recipes(ctx.db,0,false);
  const returnToOrderContext=ctx.url.searchParams.get('return_to_order')==='1';
  const qNorm=normalizeSearch(q);
  const matches=allRecipes.filter(recipe=>{
    const details=readRecipeDetails(recipe),tradeSymbol=recipeTradeSymbol(recipe),fields=[recipe.name,recipe.raw_symbol,tradeSymbol,recipe.recipe_text,recipe.target_color,details.rawMaterial].map(normalizeSearch),terms=q.split(/\s+/).map(normalizeSearch).filter(Boolean);
    return Number(recipe.active)===activeValue&&(!plantId||recipe.finishing_plant_id===plantId)&&terms.every(term=>fields.some(field=>field.includes(term)));
  });
  if(ctx.url.searchParams.get('partial')==='search') {
    if(!qNorm)return '';
    const statusRecipes=recipes(ctx.db,plantId,status==='active').filter(recipe=>Number(recipe.active)===activeValue);
    const activeMatches=statusRecipes.filter(recipe=>{const details=readRecipeDetails(recipe),fields=[recipe.name,recipe.raw_symbol,recipeTradeSymbol(recipe),recipe.recipe_text,recipe.target_color,details.rawMaterial].map(normalizeSearch),terms=q.split(/\s+/).map(normalizeSearch).filter(Boolean);return terms.every(term=>fields.some(field=>field.includes(term)));});
    const options=activeMatches.map(recipe=>`<a id="finishing-recipe-option-${recipe.id}" role="option" aria-selected="false" href="/finishing/recipes/${recipe.id}" class="warehouse-article-option finishing-recipe-option"><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Bez symbolu')}${recipeTradeSymbol(recipe)?` · ${V.esc(recipeTradeSymbol(recipe))}`:''}</span></a>`).join('');
    return options?`<div class="warehouse-search-results finishing-recipe-search-results" role="listbox" aria-label="Pasujące receptury">${options}</div>`:'';
  }
  const rows=matches.map(recipe=>{const d=readRecipeDetails(recipe),parts=recipeTradeSymbolParts(recipe),preview=recipeTextFor(recipe),searchText=[recipe.name,recipe.raw_symbol,parts.symbol,parts.color,recipe.recipe_text,recipe.target_color,d.rawMaterial].filter(Boolean).join(' ');return `<article class="finishing-recipe-row" data-finishing-recipe-row data-recipe-search="${V.esc(searchText)}"><div class="finishing-recipe-row-heading"><a class="finishing-recipe-row-name" href="/finishing/recipes/${recipe.id}"><strong>${V.esc(recipe.name)}</strong></a><span class="badge ${recipe.active?'approved':'archived'}">${recipe.active?'Aktywna':'Nieaktywna'}</span>${d.trialRecipe==='yes'?'<span class="badge finishing-trial-badge">Próba</span>':''}${preview?`<details class="finishing-recipe-preview"><summary>Podgląd wykończenia</summary><pre>${V.esc(preview)}</pre></details>`:''}</div><div class="finishing-recipe-row-symbols"><strong>${V.esc(recipe.raw_symbol||'Bez symbolu')}</strong>${parts.symbol?`<span>Symbol handlowy: <strong>${V.esc(parts.symbol)}</strong></span>`:''}${parts.color?`<span>Kolor handlowy: <strong>${V.esc(parts.color)}</strong></span>`:''}<span>${V.esc(recipe.finishing_plant_name||'Dowolna wykończalnia')}</span></div>${editableRoles.includes(ctx.req.user.role)?`<div class="finishing-recipe-row-actions"><a class="button finishing-recipe-icon-action" href="/finishing/recipes/${recipe.id}/edit${returnToOrderContext?'?return_to_order=1':''}"${returnToOrderContext?' target="_blank" rel="noopener"':''} aria-label="Edytuj recepturę ${V.esc(recipe.name)}" title="Edytuj recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20Z"/></svg></a><form method="post" action="/finishing/recipes/${recipe.id}/status" class="finishing-recipe-status-form">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="active" value="${recipe.active?0:1}"><button class="button finishing-recipe-status-button" aria-label="${recipe.active?'Dezaktywuj':'Aktywuj'} recepturę ${V.esc(recipe.name)}">${recipe.active?'Dezaktywuj':'Aktywuj'}</button></form></div>`:''}</article>`;}).join('');
  const updatedRecipeId=ctx.url.searchParams.get('updated_recipe_id'),returningToOrder=returnToOrderContext&&/^\d+$/.test(updatedRecipeId||'');
  let returnRecipeHtml='';
  if(returningToOrder){const recipe=recipeRecord(ctx.db,Number(updatedRecipeId));if(recipe){const details=readRecipeDetails(recipe),parts=recipeTradeSymbolParts(recipe),payload={id:recipe.id,name:recipe.name,rawSymbol:recipe.raw_symbol||'',tradeSymbol:parts.symbol,tradeColorSymbol:parts.color,recipeText:recipePreviewText(recipe),plant:recipe.finishing_plant_id||'',color:recipe.target_color||'',stiffening:recipe.target_stiffening||'',width:recipe.target_width_cm??'',grammage:recipe.target_grammage??''},json=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');returnRecipeHtml=`<div hidden data-return-recipe-to-order>${json}</div>`;}}
  const counts={active:allRecipes.filter(recipe=>recipe.active).length,inactive:allRecipes.filter(recipe=>!recipe.active).length};
  const body=`${returnRecipeHtml}${navTabs('recipes',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Biblioteka receptur wykańczania</h1><p class="muted">Receptury są przechowywane w bazie danych. Zlecenie zapisuje własną kopię wybranej receptury.</p></div>${editableRoles.includes(ctx.req.user.role)?'<a class="button primary" href="/finishing/recipes/new">+ Dodaj recepturę</a>':''}</div><nav class="finishing-recipe-status-filter" aria-label="Status receptur"><a class="button ${status==='active'?'selected':''}" href="/finishing/recipes?status=active">Aktywne (${counts.active})</a><a class="button ${status==='inactive'?'selected':''}" href="/finishing/recipes?status=inactive">Nieaktywne (${counts.inactive})</a></nav><form method="get" action="/finishing/recipes" class="shipment-list-filters" data-shipment-live-search><input type="hidden" name="status" value="${status}"><div class="shipment-list-search finishing-recipe-search-field"><label for="finishing-recipe-search">Szukaj</label><input id="finishing-recipe-search" type="search" name="q" value="${V.esc(q)}" placeholder="Nazwa receptury, symbol dzianiny lub handlowy" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="finishing-recipe-search-results"><div id="finishing-recipe-search-results" class="warehouse-search-results-wrap" data-shipment-search-results></div></div><label>Wykańczalnia<select name="plant_id"><option value="0">Wszystkie</option>${plants(ctx.db).map(plant=>`<option value="${plant.id}"${plantId===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><a class="button" href="/finishing/recipes?status=${status}">Wyczyść</a></form><section data-finishing-recipe-library><div data-finishing-recipe-list>${rows}</div><div class="panel padded" data-finishing-recipe-empty${rows?' hidden':''}>Brak ${status==='active'?'aktywnych':'nieaktywnych'} receptur dla podanych kryteriów.</div></section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Biblioteka receptur wykańczania',body});
}
function recipeCardPage(ctx,id) {
  const recipe=recipeRecord(ctx.db,id);if(!recipe)throw Object.assign(new Error('Nie znaleziono receptury.'),{status:404});
  const d=readRecipeDetails(recipe),e=V.esc,show=(label,value)=>value!==null&&value!==undefined&&String(value).trim()!==''?`<div><dt>${e(label)}</dt><dd><strong>${e(value)}</strong></dd></div>`:'',numberText=value=>value===null||value===undefined||value===''?'':qty(value);
  const tolerance=(plus,minus)=>plus!==null&&plus!==undefined||minus!==null&&minus!==undefined?` (+${numberText(plus)||'—'} / −${numberText(minus)||'—'})`:'';
  const widthValue=d.widthMode==='range'?`${numberText(d.widthMinimum)||'—'}–${numberText(d.widthMaximum)||'—'} cm`:d.widthMode==='minimum'?`nie mniej niż ${numberText(d.widthMinimum)||'—'} cm`:recipe.target_width_cm!==null&&recipe.target_width_cm!==undefined?`${d.widthMode==='needles'?'między igłami · ':''}${numberText(recipe.target_width_cm)} cm`:d.widthNeedles||'';
  const operationRows=[
    d.brushing==='yes'?['Drapanie','Wykonać']:null,
    d.brushingForVelcro==='yes'?['Drapanie pod rzep','Wykonać']:null,
    d.stiffeningEnabled==='yes'?['Usztywnienie',d.stiffeningDescription||'Wykonać']:null,
    !d.stiffeningEnabled&&recipe.target_stiffening&&!/^nie$/i.test(String(recipe.target_stiffening).trim())?['Usztywnienie',recipe.target_stiffening]:null,
    d.softeningEnabled==='yes'?['Zmiękczenie',d.softeningDescription||'Wykonać']:null,
    d.trimEdges==='yes'?['Obcinanie brzegów','Wykonać']:null,
    d.bondEdges==='yes'?['Podklejanie brzegów','Wykonać']:null,
    d.trimSygnits==='yes'?['Obcinanie sygnitów','Wykonać']:null,
  ].filter(Boolean);
  const operationHtml=operationRows.map(([label,value])=>`<div><dt>${e(label)}</dt><dd><strong>${e(value)}</strong></dd></div>`).join('');
  const tradeParts=recipeTradeSymbolParts(recipe);
  const detailsHtml=`<section id="recipe-identification" class="finishing-recipe-card-section"><h2>Identyfikacja dzianiny</h2>${d.trialRecipe==='yes'?'<span class="badge finishing-trial-badge">Receptura próbna</span>':''}<dl class="finishing-recipe-card-grid">${show('Symbol dzianiny surowej',recipe.raw_symbol)}${show('Symbol handlowy',tradeParts.symbol)}${show('Symbol koloru handlowego',tradeParts.color)}${show('Surowiec / skład',d.rawMaterial)}${show('Kolor / oznaczenie farbiarni',recipe.target_color)}${show('Domyślna wykończalnia',recipe.finishing_plant_name||'Dowolna')}</dl></section>
    <section class="finishing-recipe-card-section"><h2>Parametry oczekiwane</h2><dl class="finishing-recipe-card-grid">${show('Gramatura',recipe.target_grammage!==null&&recipe.target_grammage!==undefined?`${numberText(recipe.target_grammage)} g/m²${tolerance(d.grammagePlus,d.grammageMinus)}`:'')}${show('Szerokość',widthValue?`${widthValue}${tolerance(d.widthPlus,d.widthMinus)}`:'')}${show('Kurczliwości',d.shrinkage)}</dl></section>
    <section class="finishing-recipe-card-section"><h2>Uszlachetnianie i obróbka</h2>${operationHtml?`<dl class="finishing-recipe-card-grid">${operationHtml}</dl>`:'<p class="muted">Brak wskazanych operacji.</p>'}</section>
    ${!Object.keys(d).length&&recipe.recipe_text?`<section class="finishing-recipe-card-section"><h2>Parametry zapisane w starszym formacie</h2><div class="preline finishing-recipe-card-notes">${e(recipe.recipe_text)}</div></section>`:''}
    ${(d.winding||[]).some(Boolean)?`<section class="finishing-recipe-card-section"><h2>Instrukcje nawijania</h2><ol class="finishing-recipe-card-winding">${d.winding.filter(Boolean).map(line=>`<li><strong>${e(line)}</strong></li>`).join('')}</ol></section>`:''}
    ${recipe.notes?`<section class="finishing-recipe-card-section"><h2>Uwagi dodatkowe</h2><div class="finishing-recipe-card-notes">${recipeNotesHtml(recipe.notes)}</div></section>`:''}`;
  const history=ctx.db.prepare(`SELECT o.id order_id,o.source_shipment_no,o.source_shipment_date,fp.name finishing_plant_name,
      b.finishing_lot,b.sent_at,r.id receipt_id,r.received_at,r.finished_pieces,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb WHERE rb.receipt_id=r.id AND rb.weight_kg IS NOT NULL) THEN r.finished_weight_kg ELSE NULL END finished_weight_kg,
      r.finished_meters,r.actual_color,r.actual_stiffening,r.color_status,r.stiffening_status,r.actual_width_cm,r.actual_grammage,r.rubbing_status,r.notes,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id)
        THEN (SELECT round(sum(rb.meters),2) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id) ELSE r.finished_meters END actual_meters
    FROM finishing_orders o JOIN finishing_batches b ON b.order_id=o.id JOIN finishing_receipts r ON r.batch_id=b.id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id WHERE o.recipe_id=?
    ORDER BY r.received_at DESC,r.id DESC`).all(id);
  const historyHtml=history.map(item=>`<article class="finishing-recipe-history-item"><header><strong>${e(V.datepl(item.received_at))}</strong><span>Zlecenie #${item.order_id}${item.source_shipment_no?` · WZ ${e(item.source_shipment_no)}`:''}</span><span>${e(item.finishing_plant_name||'Bez przypisanej wykończalni')}${item.finishing_lot?` · LOT ${e(finishingOrderNo(item))}`:''}</span></header><dl class="finishing-recipe-card-grid">${recipe.target_color?show('Kolor uzyskany',item.actual_color):''}${recipe.target_color?show('Ocena koloru',item.color_status==='ok'?'OK':item.color_status==='not_ok'?'NOK':''):''}${d.stiffeningEnabled==='yes'||recipe.target_stiffening?show('Usztywnienie uzyskane',item.actual_stiffening):''}${d.stiffeningEnabled==='yes'||recipe.target_stiffening?show('Ocena usztywnienia',item.stiffening_status==='ok'?'OK':item.stiffening_status==='not_ok'?'NOK':''):''}${recipe.target_width_cm!==null&&recipe.target_width_cm!==undefined?show('Szerokość uzyskana',item.actual_width_cm!==null?`${numberText(item.actual_width_cm)} cm`:''):''}${recipe.target_grammage!==null&&recipe.target_grammage!==undefined?show('Gramatura uzyskana',item.actual_grammage!==null?`${numberText(item.actual_grammage)} g/m²`:''):''}${show('Odebrane belki',`${item.finished_pieces} szt.`)}${show('Metry',item.actual_meters!==null&&item.actual_meters!==undefined?`${numberText(item.actual_meters)} m`:'')}${show('Masa',item.finished_weight_kg!==null&&item.finished_weight_kg!==undefined?`${numberText(item.finished_weight_kg)} kg`:'')}${d.brushing==='yes'||d.brushingForVelcro==='yes'?show('Wydrapanie',item.rubbing_status==='ok'?'OK':item.rubbing_status==='not_ok'?'NOK':''):''}${show('Komentarz do partii',item.notes)}</dl></article>`).join('');
  const actions=editableRoles.includes(ctx.req.user.role)?`<div class="actions"><a class="button primary" href="/finishing/recipes/${recipe.id}/edit">Edytuj recepturę</a><a class="button danger" href="/finishing/recipes/${recipe.id}/delete">Usuń</a></div>`:'';
  const body=`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><div class="pagehead"><div><span class="eyebrow">KARTA RECEPTURY</span><h1>${e(recipe.name)}${d.trialRecipe==='yes'?' <span class="badge finishing-trial-badge">Próba</span>':''}</h1><p class="muted"><strong>${e(recipe.raw_symbol||'Bez symbolu dzianiny')}</strong>${tradeParts.symbol?` · ${e(tradeParts.symbol)}`:''}${tradeParts.color?` · ${e(tradeParts.color)}`:''}</p></div>${actions}</div><div class="finishing-recipe-card">${detailsHtml}<details class="finishing-recipe-card-section finishing-recipe-history"><summary><span>Historia wykonań</span><small>${history.length} ${history.length===1?'przyjęcie':'przyjęć'}</small></summary><div class="finishing-recipe-history-content">${historyHtml||'<p class="muted">Brak zarejestrowanych przyjęć z wykończalni dla tej receptury.</p>'}</div></details></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:recipe.name,body});
}
function recipeDeleteConfirmPage(ctx,recipe) {
  const cancelUrl=`/finishing/recipes/${recipe.id}`;
  const body=`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="${cancelUrl}">← ${V.esc(recipe.name)}</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Usuń recepturę</h1></div></div><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Usunąć recepturę z aktywnej biblioteki?</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrana receptura:</p><h2 class="delete-confirm-object">${V.esc(recipe.name)} · ${V.esc(recipe.raw_symbol||'Bez symbolu')}</h2><div class="shipment-cancel-details"><div class="shipment-cancel-detail-row"><strong>Dostępność</strong><span>Receptura zniknie z biblioteki i nie będzie dostępna przy tworzeniu nowych zleceń.</span></div><div class="shipment-cancel-detail-row"><strong>Historia</strong><span>Powiązane zlecenia, przyjęcia i wyniki wykończeń pozostaną zachowane.</span></div></div><form method="post" action="/finishing/recipes/${recipe.id}/delete" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_recipe','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Usuń recepturę z biblioteki</button></form></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Usuń recepturę',body});
}
function receiptPage(ctx,id,batchId=0) {
  const order=orderRecord(ctx.db,id);if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const pm=pmReference(order);
  const correctionBatch=batchId?ctx.db.prepare('SELECT * FROM finishing_batches WHERE id=? AND order_id=? AND correction_parent_batch_id IS NOT NULL AND cancelled_at IS NULL').get(batchId,id):null;
  if(correctionBatch){
    const correctionPrintText=[correctionBatch.correction_instruction,correctionBatch.correction_notes].filter(value=>String(value||'').trim()).join('\n\n');
    const correctionTradeSymbol=String(correctionBatch.correction_trade_symbol||'').trim(),correctionColor=String(correctionBatch.correction_target_color||'').trim();
    const correctionParent=ctx.db.prepare('SELECT finishing_lot FROM finishing_batches WHERE id=?').get(correctionBatch.correction_parent_batch_id);
    const correctionOrderNumber=String(correctionParent?.finishing_lot||'').trim()||'________________';
    const html=`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Poprawa zlecenia · ${V.esc(pm)}</title><link rel="icon" type="image/png" href="/static/favicon.png?v=${V.FAVICON_CACHE_VERSION}"><script defer src="/static/app.js"></script><style>
      @page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{font:9.5pt/1.35 Arial,sans-serif;color:#111;margin:0}.toolbar{display:flex;justify-content:flex-end;margin:0 0 12px}.sheet{max-width:194mm;margin:auto}.head{display:grid;grid-template-columns:1fr .9fr;gap:12mm;align-items:stretch;border-bottom:2px solid #222;padding-bottom:7px}.head-title{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start}.brand{font-size:8pt;letter-spacing:.08em;font-weight:700;color:#444;margin-top:3px}.brand span{font-weight:400;letter-spacing:0;margin-left:4px}.title{margin:0;background:#111;color:#fff;padding:7px 10px;font-size:17pt;line-height:1.15;font-weight:800;letter-spacing:.04em;-webkit-print-color-adjust:exact;print-color-adjust:exact}.head-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.blank-field{border:1px solid #888;min-height:18mm;padding:5px;font-size:8pt;color:#333}.identification{padding:11px 2px 9px;border-bottom:2px solid #222}.pm{font-size:16pt;font-weight:800;margin-bottom:3px}.order-number{font-size:11pt;font-weight:700}.details{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:16px 0 20px}.detail{border-bottom:1px solid #888;padding:5px 3px}.detail small{display:block;color:#555;font-size:9pt;margin-bottom:3px}.detail strong{font-size:13pt}.instruction{border:2px solid #222;padding:12px;margin-top:16px;break-inside:avoid}.instruction h2{font-size:13pt;margin:0 0 9px}.instruction div{font-size:16pt;line-height:1.45;font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere;min-height:24mm}.footer{margin-top:20px;border-top:1px solid #aaa;padding-top:6px;font-size:8pt;color:#555}@media print{.toolbar{display:none}.head,.identification,.detail,.instruction{break-inside:avoid}}
      </style></head><body><div class="toolbar"><button type="button" data-print>Drukuj / zapisz jako PDF</button></div><main class="sheet"><header class="head"><div class="head-title"><h1 class="title">POPRAWA ZLECENIA</h1><div class="brand">MARAND<span>dzianiny techniczne</span></div></div><div class="head-fields"><div class="blank-field">Klient</div><div class="blank-field">Nr zlecenia u wykańczalni</div></div></header><section class="identification"><div class="pm">${V.esc(pm)}</div><div class="order-number">Poprawa zlecenia barwiarskiego nr ${V.esc(correctionOrderNumber)}</div></section><section class="details"><div class="detail"><small>Symbol handlowy</small><strong>${V.esc(correctionTradeSymbol||'—')}</strong></div><div class="detail"><small>Kolor</small><strong>${V.esc(correctionColor||'—')}</strong></div><div class="detail"><small>Symbol surowy</small><strong>${V.esc(order.raw_symbol||'—')}</strong></div><div class="detail"><small>Data wysyłki</small><strong>${V.datepl(correctionBatch.sent_at)}</strong></div><div class="detail"><small>Liczba sztuk do poprawy</small><strong>${Number(correctionBatch.sent_pieces||0)} szt.</strong></div><div class="detail"><small>Masa do poprawy</small><strong>${money(correctionBatch.raw_weight_kg)} kg</strong></div></section><section class="instruction"><h2>Instrukcja poprawki</h2><div>${V.esc(correctionPrintText||'—')}</div></section><footer class="footer">Wygenerowano z programu wykańczania · MarandTech · © Marand · ${V.esc(pm)}</footer></main></body></html>`;
    return ctx.send(ctx.req,ctx.res,200,html);
  }
  let sourceBales=ctx.db.prepare(`SELECT f.bale_number,f.machine,f.production_date,f.weight_kg,f.meters,f.lot,
      coalesce(p.errors,0) errors,coalesce(p.stops,0) stops,coalesce(p.notes,'') notes
    FROM finishing_order_bales f LEFT JOIN production_bales p ON p.local_id=f.bale_local_id WHERE f.order_id=? ORDER BY f.id`).all(id);
  if(!sourceBales.length&&order.shipment_article_id)sourceBales=sourcePieces(ctx.db,order.shipment_article_id);
  const manualBatches=order.manual_entry?ctx.db.prepare('SELECT sent_at,sent_pieces,raw_weight_kg,finishing_lot FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL ORDER BY id').all(id):[];
  const printPieceCount=order.manual_entry?manualBatches.reduce((sum,batch)=>sum+Number(batch.sent_pieces||0),0):sourceBales.length;
  const totalWeight=order.manual_entry?manualBatches.reduce((sum,batch)=>sum+Number(batch.raw_weight_kg||0),0):sourceBales.reduce((sum,bale)=>sum+Number(bale.weight_kg||0),0);
  const sourceBaleRows=sourceBales.map((bale,index)=>`<tr><td class="piece-index">${index+1}</td><td><strong>${V.esc(bale.bale_number||'—')}</strong></td><td class="narrow-number">${Number(bale.errors||0)}</td><td class="narrow-number">${Number(bale.stops||0)}</td><td>${V.esc(bale.lot||'—')}</td><td class="number">${qty(bale.meters)} m</td><td class="number">${money(bale.weight_kg)} kg</td><td>${bale.notes?V.esc(bale.notes):''}</td></tr>`).join('');
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const details=snapshot.details&&typeof snapshot.details==='object'?snapshot.details:{};
  const recipeLines=String(snapshot.recipeText||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const fieldValue=label=>recipeLines.find(line=>new RegExp(`^${label}\\s*:`,'i').test(line))?.replace(new RegExp(`^${label}\\s*:\\s*`,'i'),'').trim()||'';
  const tradeSymbol=String(details.tradeSymbol||details.trade_symbol||order.trade_symbol||fieldValue('Symbol handlowy')).trim();
  const rawMaterial=String(details.rawMaterial||fieldValue('Surowiec')).trim();
  const recipeParameterRows=recipeLines.filter(line=>!/^\s*(?:symbol handlowy|surowiec)\s*:/i.test(line)).map(line=>{
    const separator=line.indexOf(':');
    return separator>0?{label:line.slice(0,separator).trim(),value:line.slice(separator+1).trim()}:{label:'',value:line};
  });
  const recipeParameters=`${rawMaterial?`<div class="recipe-param"><small class="recipe-label">Surowiec:</small> <strong class="raw-material">${V.esc(rawMaterial)}</strong></div>`:''}${recipeParameterRows.map(item=>`<div class="recipe-param${item.label?'':' recipe-param-wide'}${item.label?.toLocaleLowerCase('pl-PL')==='nawijanie'?' recipe-param-wide':''}">${item.label?`<small class="recipe-label">${V.esc(item.label)}:</small> `:''}<strong>${V.esc(item.value)}</strong></div>`).join('')}`;
  const recipeNotesPrint=snapshot.notes?`<section class="recipe-notes"><div>${recipeNotesHtml(snapshot.notes)}</div></section>`:'';
  const orderNotes=order.notes?`<section class="order-notes"><div>${recipeNotesHtml(order.notes)}</div></section>`:'';
  const manualOrderPrint=order.manual_entry?`<section class="manual-order-print"><div class="recipe-params"><div class="recipe-param"><small class="recipe-label">Kolor:</small> <strong>${V.esc(order.target_color||'—')}</strong></div><div class="recipe-param"><small class="recipe-label">Usztywnienie:</small> <strong>${V.esc(order.target_stiffening||'—')}</strong></div><div class="recipe-param"><small class="recipe-label">Gramatura:</small> <strong>${order.target_grammage===null?'—':`${qty(order.target_grammage)} g/m²`}</strong></div><div class="recipe-param"><small class="recipe-label">Szerokość:</small> <strong>${order.target_width_cm===null?'—':`${qty(order.target_width_cm)} cm`}</strong></div></div>${order.manual_input_description?`<div class="recipe-notes"><div>${V.esc(order.manual_input_description)}</div></div>`:''}</section>`:'';
  const html=`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zlecenie farbiarskie · ${V.esc(pm)}</title><link rel="icon" type="image/png" href="/static/favicon.png?v=${V.FAVICON_CACHE_VERSION}"><script defer src="/static/app.js"></script><link rel="stylesheet" href="/static/finishing-order-print.css"><style>
    .raw-sale-banner{margin:8px 0;padding:6px 9px;border:2px solid #222;text-align:center;font-size:12pt;font-weight:700;letter-spacing:.08em}.manual-order-print{margin:2px 0;padding:0;border:0;background:transparent;break-inside:avoid}.print-field strong{display:block;margin-top:4px;font-size:10pt;color:#111}.head-title{display:flex;flex-direction:column;align-items:flex-start}.head-pm{font-size:13pt;font-weight:800;color:#111;margin-top:auto;line-height:1}
    @page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{font:9.5pt/1.35 Arial,sans-serif;color:#111;margin:0}.toolbar{display:flex;justify-content:flex-end;margin:0 0 12px}.sheet{max-width:194mm;margin:auto}.head{display:grid;grid-template-columns:1fr 0.9fr;gap:12mm;align-items:stretch;border-bottom:2px solid #222;padding-bottom:7px}.head-title{align-self:stretch}.head h1,.head-trial{font-size:17pt;line-height:1.15;margin:0}.head-trial{font-weight:700;margin-top:2px}.brand{margin-top:3px;font-size:8pt;letter-spacing:.08em;font-weight:700;color:#444}.brand span{font-weight:400;letter-spacing:0;margin-left:4px}.head-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.blank-field{border:1px solid #888;min-height:18mm;padding:5px;font-size:8pt;color:#333}.meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin:8px 0}.field{border-bottom:1px solid #aaa;padding:4px 3px}.field b{display:block;font-size:8pt;color:#555;margin-bottom:2px}.field strong{font-size:10pt}.order-notes{border:2px solid #555;background:#f8f8f8;padding:8px;margin:9px 0}.order-notes div{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11pt;font-weight:600}.correction-print{margin:9px 0;padding:8px;border:2px solid #333;background:#f7f7f7;break-inside:avoid}.correction-print h2{margin:0 0 6px;font-size:11pt}.correction-print>strong{display:block;margin-top:5px}.correction-print>div:not(.recipe-params){white-space:pre-wrap;overflow-wrap:anywhere}.recipe-params{display:grid;grid-template-columns:1fr 1fr;gap:6px}.recipe-param{border:1px solid #bbb;padding:5px 7px;min-height:12mm;break-inside:avoid}.recipe-param small{display:block;color:#555;font-size:8pt;margin-bottom:2px}.recipe-param strong{font-size:10pt}.recipe-param .raw-material{font-size:11pt;font-weight:700}.recipe-param-wide{grid-column:1/-1}.recipe-notes{margin-top:8px;border:1px solid #bbb;padding:7px;break-inside:avoid}.recipe-notes div{white-space:pre-wrap;overflow-wrap:anywhere;font-weight:600}.pieces{margin-top:10px}.pieces h2{font-size:11pt;background:#eee;padding:5px 7px;margin:0 0 6px}.pieces table{border-collapse:collapse;width:100%;font-size:8pt;table-layout:fixed}.pieces th,.pieces td{border:1px solid #444;padding:4px;text-align:left;vertical-align:top;overflow-wrap:anywhere}.pieces th{background:#f0f0f0}.pieces th:nth-child(1){width:7mm}.pieces th:nth-child(2){width:24mm}.pieces th:nth-child(3),.pieces th:nth-child(4){width:10mm;text-align:center}.pieces td.narrow-number,.pieces td.piece-index{text-align:center}.pieces th:nth-child(5){width:27mm}.pieces th:nth-child(6),.pieces th:nth-child(7){width:22mm}.pieces td.number{text-align:right;white-space:nowrap}.pieces tfoot td{font-weight:700;background:#f0f0f0}.totals{display:flex;justify-content:flex-end;gap:20px;margin-top:7px;padding:8px;border-top:2px solid #222;font-size:11pt}.totals strong{font-size:12pt}.muted{font-size:8pt;color:#555}@media print{.toolbar{display:none}.head,.meta,.order-notes,.correction-print,.recipe-param,.pieces tr{break-inside:avoid}.pieces thead{display:table-header-group}.pieces tfoot{display:table-row-group}}
    .recipe-param .recipe-label{display:inline;margin:0 3px 0 0;font-size:7pt;font-weight:400;white-space:nowrap}.recipe-param{min-height:0;padding:2px 4px;line-height:1.1}.recipe-param strong,.recipe-param .raw-material{font-size:8pt;line-height:1.1}.recipe-param-wide{grid-column:span 2}.recipe-param-wide strong,.recipe-notes div,.order-notes div{font-size:10pt;line-height:1.1}.recipe-notes{margin-top:2px;padding:3px}.recipe-notes .notes-label{display:none}.pieces{margin-top:6px}
  </style></head><body><div class="toolbar"><button type="button" data-print>Drukuj / zapisz jako PDF</button></div><main class="sheet">
    <header class="head"><div class="head-title"><h1>ZLECENIE FARBIARSKIE</h1>${order.order_type==='trial'?'<div class="head-trial">PRÓBA - NOWOŚĆ</div>':''}<div class="brand">MARAND<span>dzianiny techniczne</span></div><strong class="head-pm">${V.esc(pm)}</strong></div><div class="head-fields"><div class="blank-field">Klient</div><div class="blank-field">Nr zlecenia z wykańczalni<strong class="print-field">${V.esc(manualBatches[0]?.finishing_lot||'')}</strong></div></div></header>
    ${order.order_type==='raw_sale'?'<div class="raw-sale-banner">SPRZEDAŻ SUROWEJ</div>':''}<section class="meta"><div class="field"><b>Symbol handlowy</b><strong>${V.esc(tradeSymbol||'—')}</strong></div><div class="field"><b>Symbol surowy</b><strong>${V.esc(order.raw_symbol||'—')}</strong></div><div class="field"><b>Data wysyłki</b><strong>${V.datepl(order.manual_entry?manualBatches.find(batch=>batch.sent_at)?.sent_at:order.source_shipment_date)}</strong></div><div class="field"><b>Wykańczalnia</b><strong>${V.esc(order.finishing_plant_name||'')}</strong></div><div class="field"><b>Liczba sztuk</b><strong>${printPieceCount} szt.</strong></div><div class="field"><b>Waga łączna</b><strong>${money(totalWeight)} kg</strong></div></section>
    ${manualOrderPrint}${orderNotes}${recipeParameters||recipeNotesPrint?`<section>${recipeParameters?`<div class="recipe-params">${recipeParameters}</div>`:''}${recipeNotesPrint}</section>`:''}
    ${!order.manual_entry?`<section class="pieces"><table><thead><tr><th>Nr</th><th>Numer sztuki</th><th>Bł.</th><th>St.</th><th>LOT przędzy</th><th>Metry</th><th>Waga</th><th>Uwagi</th></tr></thead><tbody>${sourceBaleRows||'<tr><td colspan="8">Brak zapisanych sztuk źródłowych.</td></tr>'}</tbody><tfoot><tr><td colspan="5">RAZEM · ${sourceBales.length} szt.</td><td class="number">${qty(sourceBales.reduce((sum,bale)=>sum+Number(bale.meters||0),0))} m</td><td class="number">${money(totalWeight)} kg</td><td></td></tr></tfoot></table></section>`:''}
    <div class="totals"><span>Liczba sztuk: <strong>${printPieceCount} szt.</strong></span><span>Waga łączna: <strong>${money(totalWeight)} kg</strong></span></div><footer class="muted">Wygenerowano z programu wykańczania · ${V.esc(pm)}</footer></main></body></html>`;
  return ctx.send(ctx.req,ctx.res,200,html);
}
function validatePositiveNumber(value,label,allowZero=false) {
  const n=number(value);
  if(n===null||!Number.isFinite(n)||(allowZero?n<0:n<=0))throw Object.assign(new Error(`${label}: wpisz prawidłową wartość.`),{status:400});
  return n;
}
function parseList(value,label) {
  const parts=String(value||'').split(/[+\n\r;]+/).map(item=>item.trim()).filter(Boolean);
  if(!parts.length)throw Object.assign(new Error(`Wpisz wartości dla każdego zwróconego produktu: ${label.toLowerCase()}.`),{status:400});
  return parts.map((part,index)=>validatePositiveNumber(part,`${label}, pozycja ${index+1}`));
}
function updateOrderStatus(ctx,orderId) {
  const order=orderRecord(ctx.db,orderId),batches=ctx.db.prepare('SELECT closed_at,finishing_lot,sent_pieces,correction_parent_batch_id,correction_of_batch_id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL').all(orderId),unassigned=unassignedOrderPieces(ctx.db,order,batches);
  const status=!batches.length?'draft':batches.every(batch=>batch.closed_at)&&unassigned===0?'received':batches.some(batch=>String(batch.finishing_lot||'').trim())?'sent':'draft';
  ctx.db.prepare('UPDATE finishing_orders SET status=?,updated_at=?,updated_by=? WHERE id=?').run(status,ctx.now(),ctx.req.user.id,orderId);
  return status;
}
function recomputeBatchClosure(db,batchId,userId,stamp) {
  const batch=db.prepare('SELECT closed_at FROM finishing_batches WHERE id=?').get(batchId);
  if(!batch)return false;
  const totals=db.prepare('SELECT count(*) receipt_count,max(incomplete) incomplete FROM finishing_receipts WHERE batch_id=?').get(batchId);
  const complete=Number(totals.receipt_count)>0&&!Number(totals.incomplete||0);
  const closedAt=complete?(batch.closed_at||stamp):null;
  db.prepare('UPDATE finishing_batches SET closed_at=?,updated_at=?,updated_by=? WHERE id=?').run(closedAt,stamp,userId,batchId);
  return complete;
}
function orderHasPendingBaseBatch(db,orderId) {
  return Boolean(db.prepare(`SELECT 1 FROM finishing_batches
    WHERE order_id=? AND cancelled_at IS NULL
      AND correction_parent_batch_id IS NULL AND correction_of_batch_id IS NULL
      AND closed_at IS NULL LIMIT 1`).get(orderId));
}
function syncAutoLostIncident(db,batchId,userId,stamp) {
  const batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId);
  if(!batch)return;
  const existing=db.prepare("SELECT * FROM finishing_incidents WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").get(batchId);
  // A missing quantity is not a loss while another base batch from this PM is still in process.
  // Wait until every assigned dyeing batch has been closed before reconciling lost bales.
  if(batch.closed_at&&!batch.cancelled_at&&!batch.correction_parent_batch_id&&!batch.correction_of_batch_id&&orderHasPendingBaseBatch(db,batch.order_id)){
    if(existing&&existing.status==='open'&&!String(existing.resolution||'').trim())db.prepare('DELETE FROM finishing_incidents WHERE id=?').run(existing.id);
    return;
  }
  if(!batch.closed_at){if(existing)db.prepare('DELETE FROM finishing_incidents WHERE id=?').run(existing.id);return;}
  const order=orderRecord(db,batch.order_id),capacity=order?receiptCapacity(db,order,batch):null,effectiveSentPieces=capacity?capacity.effectiveBatchPieces:Number(batch.sent_pieces||0),effectiveSentKg=capacity?capacity.effectiveBatchKg:Number(batch.raw_weight_kg||0);
  const accounted=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(used_weight_kg),0) kg FROM finishing_receipts WHERE batch_id=?').get(batchId),returned=Number(accounted.pieces||0),sent=Math.max(0,Number(effectiveSentPieces||0)),lostPieces=Math.max(0,sent-returned);
  if(!lostPieces){if(existing)db.prepare('DELETE FROM finishing_incidents WHERE id=?').run(existing.id);return;}
  const lostWeight=Math.max(0,Costing.round2(Number(effectiveSentKg||0)-Number(accounted.kg||0))),description=`Automatycznie po zamknięciu przyjęcia: brak ${lostPieces} szt.${lostWeight>0?` · ${money(lostWeight)} kg`:''}.`;
  if(!existing){db.prepare("INSERT INTO finishing_incidents(order_id,batch_id,incident_type,description,status,created_at,created_by,auto_generated,lost_pieces,lost_weight_kg) VALUES(?,?,'lost',?,'open',?,?,1,?,?)").run(batch.order_id,batchId,description,stamp,userId,lostPieces,lostWeight);return;}
  const piecesChanged=Number(existing.lost_pieces)!==lostPieces,changed=piecesChanged||Math.abs(Number(existing.lost_weight_kg||0)-lostWeight)>0.005;
  if(piecesChanged)db.prepare("UPDATE finishing_incidents SET description=?,lost_pieces=?,lost_weight_kg=?,status='open',resolved_at=NULL,resolved_by=NULL,found_at=NULL,found_by=NULL,settled_at=NULL,settled_by=NULL WHERE id=?").run(description,lostPieces,lostWeight,existing.id);
  else if(changed)db.prepare('UPDATE finishing_incidents SET description=?,lost_weight_kg=? WHERE id=?').run(description,lostWeight,existing.id);
}
function reconcileAutoLostIncidents(db) {
  const rows=db.prepare("SELECT batch_id,created_by FROM finishing_incidents WHERE auto_generated=1 AND incident_type='lost' AND batch_id IS NOT NULL").all();
  const stamp=new Date().toISOString();
  for(const row of rows)syncAutoLostIncident(db,row.batch_id,row.created_by||0,stamp);
  cleanupPrematureAutoRemainderPmrs(db);
}
function cleanupPrematureAutoRemainderPmrs(db) {
  const rows=db.prepare(`SELECT o.id FROM finishing_orders o JOIN finishing_batches source ON source.id=o.source_remainder_batch_id
    WHERE source.cancelled_at IS NULL AND source.closed_at IS NOT NULL
      AND source.correction_parent_batch_id IS NULL AND source.correction_of_batch_id IS NULL
      AND EXISTS(SELECT 1 FROM finishing_batches pending WHERE pending.order_id=source.order_id
        AND pending.cancelled_at IS NULL AND pending.correction_parent_batch_id IS NULL AND pending.correction_of_batch_id IS NULL
        AND pending.closed_at IS NULL)
      AND o.status='draft' AND o.updated_at=o.created_at
      AND NOT EXISTS(SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM finishing_settlements s JOIN finishing_batches b ON b.id=s.batch_id WHERE b.order_id=o.id)`).all();
  for(const row of rows)db.prepare('DELETE FROM finishing_orders WHERE id=?').run(row.id);
  return rows.length;
}
function syncAutoLostIncidentsForOrder(db,orderId,userId,stamp) {
  const batches=db.prepare('SELECT id,correction_parent_batch_id,correction_of_batch_id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL').all(orderId);
  if(orderHasPendingBaseBatch(db,orderId)){
    for(const batch of batches){
      if(batch.correction_parent_batch_id||batch.correction_of_batch_id){syncAutoLostIncident(db,batch.id,userId,stamp);continue;}
      const existing=db.prepare("SELECT id,status,resolution FROM finishing_incidents WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").get(batch.id);
      if(existing&&existing.status==='open'&&!String(existing.resolution||'').trim())db.prepare('DELETE FROM finishing_incidents WHERE id=?').run(existing.id);
    }
    return;
  }
  for(const batch of batches)syncAutoLostIncident(db,batch.id,userId,stamp);
}
function syncAutoRemainderPmr(db,batchId,userId,stamp) {
  const batch=db.prepare(`SELECT b.*,o.raw_symbol,o.client_name,o.trade_symbol,o.recipe_snapshot,o.target_color,o.target_stiffening,o.target_width_cm,o.target_grammage,o.finishing_plant_id,o.manual_entry,o.order_type,o.id order_id,o.created_at order_created_at
    FROM finishing_batches b JOIN finishing_orders o ON o.id=b.order_id WHERE b.id=?`).get(batchId);
  if(!batch)return null;
  const existing=db.prepare('SELECT * FROM finishing_orders WHERE source_remainder_batch_id=?').get(batchId);
  if(batch.correction_parent_batch_id||batch.correction_of_batch_id){
    const untouched=existing&&existing.status==='draft'&&existing.updated_at===existing.created_at&&!db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(existing.id);
    if(untouched)db.prepare('DELETE FROM finishing_orders WHERE id=?').run(existing.id);
    return null;
  }
  if(batch.cancelled_at||batch.manual_entry||batch.order_type==='raw_sale'||!batch.closed_at){
    if(existing&&existing.status==='draft'&&existing.updated_at===existing.created_at&&!db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(existing.id))db.prepare('DELETE FROM finishing_orders WHERE id=?').run(existing.id);
    return null;
  }
  // Defer remainder PMRs until all sibling batches are received or explicitly closed with shortages.
  if(orderHasPendingBaseBatch(db,batch.order_id)){
    const untouched=existing&&existing.status==='draft'&&existing.updated_at===existing.created_at
      &&!db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(existing.id)
      &&!db.prepare('SELECT 1 FROM finishing_settlements s JOIN finishing_batches b ON b.id=s.batch_id WHERE b.order_id=? LIMIT 1').get(existing.id);
    if(untouched)db.prepare('DELETE FROM finishing_orders WHERE id=?').run(existing.id);
    return null;
  }
  const capacity=receiptCapacity(db,orderRecord(db,batch.order_id),batch),accounted=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(used_weight_kg),0) kg FROM finishing_receipts WHERE batch_id=?').get(batchId),missingPieces=Math.max(0,Number(capacity.effectiveBatchPieces||0)-Number(accounted.pieces||0)),missingKg=Math.max(0,Math.round((Number(capacity.effectiveBatchKg||0)-Number(accounted.kg||0))*100)/100);
  const hasMissing=missingPieces>0||missingKg>0.005;
  if(!hasMissing){
    if(existing&&existing.status==='draft'&&existing.updated_at===existing.created_at&&!db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(existing.id))db.prepare('DELETE FROM finishing_orders WHERE id=?').run(existing.id);
    return null;
  }
  if(existing){
    const untouched=existing.status==='draft'&&existing.updated_at===existing.created_at&&!db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(existing.id);
    if(untouched){const remainderBatch=db.prepare('SELECT id FROM finishing_batches WHERE order_id=? ORDER BY id LIMIT 1').get(existing.id);if(remainderBatch)db.prepare('UPDATE finishing_batches SET sent_pieces=?,raw_weight_kg=?,updated_at=?,updated_by=? WHERE id=?').run(missingPieces,missingKg,stamp,userId,remainderBatch.id);}
    return {id:existing.id,reference:existing.manual_reference,kg:missingKg,pieces:missingPieces,created:false,batchId};
  }
  const manualReference=nextManualReference(db,stamp),sourceOrder=orderRecord(db,batch.order_id),sourceOrderLabel=pmReference(sourceOrder),sourceBatchLabel=finishingOrderNo(batch)||`#${batchId}`,description=`Automatycznie utworzono z braków po niepełnym przyjęciu zlecenia barwiarskiego ${sourceBatchLabel} · ${sourceOrderLabel}.`;
  const result=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,order_type,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,manual_entry,manual_reference,manual_input_description,source_remainder_batch_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(NULL,'standard',?,'','',?,?,?,?,?,?,?,?,1,?,?,?,'draft',?,?,?,?)`).run(batch.finishing_plant_id,batch.raw_symbol||'',batch.client_name||'',batch.trade_symbol||'',batch.recipe_snapshot||'{}',batch.target_color||'',batch.target_stiffening||'',batch.target_width_cm??null,batch.target_grammage??null,manualReference,description,batchId,stamp,userId,stamp,userId);
  const pmrId=Number(result.lastInsertRowid),receivedAt=db.prepare('SELECT max(received_at) received_at FROM finishing_receipts WHERE batch_id=?').get(batchId)?.received_at||V.todayInput();
  db.prepare(`INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by)
    VALUES(?,'',?,?,?,?,?,?,?, ?,?)`).run(pmrId,receivedAt,missingPieces,missingKg,batch.yarn_lot||'',description,stamp,userId,stamp,userId);
  return {id:pmrId,reference:manualReference,kg:missingKg,pieces:missingPieces,created:true,batchId};
}
function syncAutoRemainderPmrsForOrder(db,orderId,userId,stamp) {
  const correctionBatches=db.prepare(`SELECT id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL
    AND (correction_parent_batch_id IS NOT NULL OR correction_of_batch_id IS NOT NULL)`).all(orderId);
  for(const batch of correctionBatches)syncAutoRemainderPmr(db,batch.id,userId,stamp);
  if(orderHasPendingBaseBatch(db,orderId)){
    // Remove only untouched auto-generated PMRs that were created prematurely by an older version.
    const premature=db.prepare(`SELECT o.id FROM finishing_orders o JOIN finishing_batches source ON source.id=o.source_remainder_batch_id
      WHERE source.order_id=? AND source.cancelled_at IS NULL AND source.closed_at IS NOT NULL
        AND source.correction_parent_batch_id IS NULL AND source.correction_of_batch_id IS NULL
        AND o.status='draft' AND o.updated_at=o.created_at
        AND NOT EXISTS(SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=o.id)
        AND NOT EXISTS(SELECT 1 FROM finishing_settlements s JOIN finishing_batches b ON b.id=s.batch_id WHERE b.order_id=o.id)`).all(orderId);
    for(const row of premature)db.prepare('DELETE FROM finishing_orders WHERE id=?').run(row.id);
    return [];
  }
  const batches=db.prepare(`SELECT id FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL
    AND correction_parent_batch_id IS NULL AND correction_of_batch_id IS NULL AND closed_at IS NOT NULL ORDER BY id`).all(orderId);
  return batches.map(batch=>syncAutoRemainderPmr(db,batch.id,userId,stamp)).filter(Boolean);
}
function cleanupCorrectionRemainderPmrs(db) {
  const invalid=db.prepare(`SELECT o.id FROM finishing_orders o JOIN finishing_batches source ON source.id=o.source_remainder_batch_id
    WHERE o.manual_entry=1 AND o.status='draft' AND o.updated_at=o.created_at
      AND (source.correction_parent_batch_id IS NOT NULL OR source.correction_of_batch_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM finishing_settlements s JOIN finishing_batches b ON b.id=s.batch_id WHERE b.order_id=o.id)`).all();
  for(const row of invalid)db.prepare('DELETE FROM finishing_orders WHERE id=?').run(row.id);
  return invalid.length;
}
function settlementSnapshot(row){
  return {batch_id:row.batch_id,status:row.status,receipt_date:row.receipt_date,pz_number:row.pz_number,invoice_note:row.invoice_note,calculation_import_id:row.calculation_import_id,raw_symbol:row.raw_symbol,trade_symbol:row.trade_symbol,
    raw_price_per_kg:row.raw_price_per_kg,theoretical_raw_price_per_kg:row.theoretical_raw_price_per_kg,raw_price_override:row.raw_price_override,theoretical_price_override:row.theoretical_price_override,
    used_weight_kg:row.used_weight_kg,finishing_cost:row.finishing_cost,output_quantity:row.output_quantity,output_unit:row.output_unit,raw_cost_total:row.raw_cost_total,
    actual_cost_total:row.actual_cost_total,theoretical_cost_total:row.theoretical_cost_total,actual_unit_cost:row.actual_unit_cost,theoretical_unit_cost:row.theoretical_unit_cost,version:row.version};
}
function markSettlementChanged(db,batchIds,userId,stamp){
  const ids=[...new Set(batchIds.map(Number))];
  for(const batchId of ids){
    const settlement=Costing.getSettlement(db,batchId);if(!settlement)continue;
    const version=Number(settlement.version||0)+1,status=settlement.status==='settled'||settlement.status==='changed'?'changed':settlement.status;
    db.prepare('UPDATE finishing_settlements SET status=?,version=?,updated_at=?,updated_by=?,approved_at=NULL,approved_by=NULL WHERE id=?').run(status,version,stamp,userId,settlement.id);
    const snapshot={...settlement,status,version,updated_at:stamp,updated_by:userId,approved_at:null,approved_by:null};
    db.prepare('INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,?,?,?,?)').run(settlement.id,version,'changed',JSON.stringify(snapshot),stamp,userId);
  }
}
function saveSettlement(ctx,batchId,action){
  const {db,form,req,fail,now,audit}=ctx,c=Costing.calculationContext(db,batchId);
  if(!c)fail(404,'Nie znaleziono zlecenia barwiarskiego.');
  const isRemainderPmr=Boolean(c.batch.source_remainder_batch_id&&c.settlement);
  if((!c.batch.closed_at||!c.output.receipt_count)&&!isRemainderPmr)fail(409,'Najpierw przyjmij całe zlecenie barwiarskie.');
  if(c.batch.complaint_status==='reklamowana'||c.batch.complaint_status==='poprawiona')fail(409,'Reklamowanego lub zastąpionego zleceniu nie można rozliczyć.');
  const isCorrection=Boolean(c.batch.correction_of_batch_id||c.batch.correction_parent_batch_id),rawSale=c.batch.order_type==='raw_sale',used=number(form[`used_${batchId}`]??c.usedWeight),enteredPrice=number(form[`price_${batchId}`]??c.settlement?.raw_price_per_kg??c.price?.current_price??c.price?.theoretical_price),enteredTheoretical=number(form[`theoretical_${batchId}`]??c.settlement?.theoretical_raw_price_per_kg??c.price?.theoretical_price??c.price?.current_price),enteredFinishing=rawSale?0:number(form[`finishing_${batchId}`]),price=enteredPrice===null?null:Costing.round2(enteredPrice),theoretical=enteredTheoretical===null?null:Costing.round2(enteredTheoretical),finishing=enteredFinishing===null?null:Costing.round2(enteredFinishing),invoice=text(form,`invoice_${batchId}`,120),pz=text(form,`pz_${batchId}`,120),receiptDate=text(form,`date_${batchId}`,10)||c.settlement?.receipt_date||c.batch.receipt_date||String(c.batch.closed_at||c.batch.sent_at||'').slice(0,10);
  if(receiptDate&&!validDate(receiptDate))fail(400,'Wpisz prawidłową datę przyjęcia.');
  const needsCompleteCalculation=action==='approve'||action==='report';
  if(needsCompleteCalculation&&(used===null||used<=0))fail(400,`Wpisz dodatnią wartość „Wykorzystane kg” dla zlecenia ${c.batch.finishing_lot||batchId}.`);
  if(needsCompleteCalculation&&price===null)fail(400,`Brak ceny do kalkulacji dla symbolu surowki ${c.root.raw_symbol}. Wpisz ją ręcznie.`);
  if(needsCompleteCalculation&&theoretical===null)fail(400,`Brak ceny teoretycznej dla symbolu surowki ${c.root.raw_symbol}. Wpisz ją ręcznie.`);
  if(needsCompleteCalculation&&!rawSale&&finishing===null)fail(400,`Wpisz koszt wykończenia w zł/kg dla zlecenia ${c.batch.finishing_lot||batchId}.`);
  for(const [label,value] of [['Wykorzystane kg',used],['Cena do kalkulacji',price],['Cena teoretyczna',theoretical],['Koszt wykończenia zł/kg',finishing]])if(value!==null&&value<0)fail(400,`${label} nie może być ujemny.`);
  const calculatedOutputQty=isRemainderPmr?Number(c.batch.raw_weight_kg||0):Number(c.output.output_quantity||0),calculatedOutputUnit=isRemainderPmr?'kg':c.output.output_unit;
  if(needsCompleteCalculation&&calculatedOutputQty<=0)fail(409,isRemainderPmr?'PMR nie ma zapisanej brakującej masy do rozliczenia.':'Brak końcowej ilości fizycznie przyjętej dzianiny.');
  const usedWeight=Costing.round2(used||0),finishCost=Costing.round2(finishing||0),outputUnit=calculatedOutputUnit,outputQty=Costing.round2(calculatedOutputQty);
  const rawCost=price===null?0:Costing.round2(usedWeight*price),actualTotal=Costing.round2(usedWeight*((price??0)+finishCost)),theoreticalTotal=theoretical===null?0:Costing.round2(usedWeight*(theoretical+finishCost));
  const next={batch_id:batchId,invoice_note:invoice,pz_number:pz,receipt_date:receiptDate,calculation_import_id:c.settlement?.calculation_import_id??c.current?.id??null,raw_symbol:c.root.raw_symbol||'',trade_symbol:c.batch.trade_symbol||'',
    raw_price_per_kg:price,theoretical_raw_price_per_kg:theoretical,raw_price_override:price!==null&&(!c.price||c.price.current_price===null||Math.abs(price-Number(c.price.current_price))>0.000001)?1:0,
    theoretical_price_override:theoretical!==null&&(!c.price||c.price.theoretical_price===null||Math.abs(theoretical-Number(c.price.theoretical_price))>0.000001)?1:0,
    used_weight_kg:usedWeight,finishing_cost:finishCost,output_quantity:outputQty,output_unit:outputUnit,raw_cost_total:rawCost,actual_cost_total:actualTotal,theoretical_cost_total:theoreticalTotal,
    actual_unit_cost:outputQty?Costing.round2(actualTotal/outputQty):null,theoretical_unit_cost:outputQty?Costing.round2(theoreticalTotal/outputQty):null};
  const old=c.settlement,stamp=now();
  const same=old&&Object.keys(next).every(key=>{
    const a=old[key],b=next[key];return typeof a==='number'||typeof b==='number'?((a===null||a===undefined)&&(b===null||b===undefined))||Math.abs(Number(a||0)-Number(b||0))<0.000001:String(a??'')===String(b??'');
  });
  if(same&&old.status==='settled'){
    if(c.batch.source_remainder_batch_id)db.prepare("UPDATE finishing_incidents SET settled_at=coalesce(settled_at,?),settled_by=coalesce(settled_by,?),found_at=NULL,found_by=NULL WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").run(now(),req.user.id,c.batch.source_remainder_batch_id);
    return {id:old.id,status:old.status,changed:false,batch:c.batch};
  }
  const changed=Boolean(old&&!same),version=Number(old?.version||0)+(changed?1:old?0:1);
  let status;
  if(changed&&old.status==='settled')status='changed';
  else if(old?.status==='changed')status=action==='approve'&&!changed?'settled':'changed';
  else if(action==='approve')status='settled';
  else status=old?.status==='settled'?'settled':'draft';
  const approvedAt=status==='settled'?(old?.status==='settled'&&!changed?old.approved_at:stamp):null,approvedBy=status==='settled'?(old?.status==='settled'&&!changed?old.approved_by:req.user.id):null;
  const persist=()=>{
    let id;
    if(old){id=old.id;db.prepare(`UPDATE finishing_settlements SET status=?,receipt_date=?,invoice_note=?,pz_number=?,calculation_import_id=?,raw_symbol=?,trade_symbol=?,raw_price_per_kg=?,theoretical_raw_price_per_kg=?,raw_price_override=?,theoretical_price_override=?,used_weight_kg=?,finishing_cost=?,output_quantity=?,output_unit=?,raw_cost_total=?,actual_cost_total=?,theoretical_cost_total=?,actual_unit_cost=?,theoretical_unit_cost=?,version=?,updated_at=?,updated_by=?,approved_at=?,approved_by=? WHERE id=?`).run(status,next.receipt_date,next.invoice_note,next.pz_number,next.calculation_import_id,next.raw_symbol,next.trade_symbol,next.raw_price_per_kg,next.theoretical_raw_price_per_kg,next.raw_price_override,next.theoretical_price_override,next.used_weight_kg,next.finishing_cost,next.output_quantity,next.output_unit,next.raw_cost_total,next.actual_cost_total,next.theoretical_cost_total,next.actual_unit_cost,next.theoretical_unit_cost,version,stamp,req.user.id,approvedAt,approvedBy,id);}
    else {const result=db.prepare(`INSERT INTO finishing_settlements(batch_id,status,receipt_date,invoice_note,pz_number,calculation_import_id,raw_symbol,trade_symbol,raw_price_per_kg,theoretical_raw_price_per_kg,raw_price_override,theoretical_price_override,used_weight_kg,finishing_cost,output_quantity,output_unit,raw_cost_total,actual_cost_total,theoretical_cost_total,actual_unit_cost,theoretical_unit_cost,version,updated_at,updated_by,approved_at,approved_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId,status,next.receipt_date,next.invoice_note,next.pz_number,next.calculation_import_id,next.raw_symbol,next.trade_symbol,next.raw_price_per_kg,next.theoretical_raw_price_per_kg,next.raw_price_override,next.theoretical_price_override,next.used_weight_kg,next.finishing_cost,next.output_quantity,next.output_unit,next.raw_cost_total,next.actual_cost_total,next.theoretical_cost_total,next.actual_unit_cost,next.theoretical_unit_cost,version,stamp,req.user.id,approvedAt,approvedBy);id=Number(result.lastInsertRowid);}
    if(status==='settled'||status==='changed'||!old||changed){const saved=db.prepare('SELECT * FROM finishing_settlements WHERE id=?').get(id),historyAction=status==='settled'?'approved':status==='changed'?'changed':'draft_saved';db.prepare('INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,?,?,?,?)').run(id,version,historyAction,JSON.stringify(settlementSnapshot(saved)),stamp,req.user.id);}
    if(c.batch.source_remainder_batch_id){if(status==='settled')db.prepare("UPDATE finishing_incidents SET settled_at=coalesce(settled_at,?),settled_by=coalesce(settled_by,?),found_at=NULL,found_by=NULL WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").run(stamp,req.user.id,c.batch.source_remainder_batch_id);else db.prepare("UPDATE finishing_incidents SET settled_at=NULL,settled_by=NULL WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").run(c.batch.source_remainder_batch_id);}
    audit(req.user,status==='settled'?'Zatwierdzono rozliczenie zlecenia barwiarskiego':status==='changed'?'Zmieniono zatwierdzone rozliczenie zlecenia barwiarskiego':'Zapisano robocze rozliczenie zlecenia barwiarskiego',null,JSON.stringify({batchId,settlementId:id,version,status,actualUnitCost:next.actual_unit_cost,theoreticalUnitCost:next.theoretical_unit_cost}),null);
    return {id,status,changed,batch:c.batch};
  };
  return persist();
}
function settlementReportPage(ctx,batchIds){
  const rows=[];
  for(const id of batchIds){
    const c=Costing.calculationContext(ctx.db,id),s=c?.settlement;if(!c||!s)continue;
    const pm=pmReference(c.batch);
    rows.push({...s,pm,orderNumber:finishingOrderNo(c.batch)||`#${id}`,trade_symbol:c.batch.trade_symbol||'—',raw_symbol:c.root.raw_symbol||'—',finishing_plant_name:c.batch.finishing_plant_name||'—',receipt_date:c.batch.receipt_date||c.batch.closed_at||'—'});
  }
  if(!rows.length)throw Object.assign(new Error('Zapisz przynajmniej jedno wybrane rozliczenie, aby przygotować raport.'),{status:400});
  const body=`<article class="finishing-cost-report"><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Raport do Subiekta</h1><p class="muted">Raport obejmuje wybrane zlecenia barwiarskie.</p></div><button type="button" data-print-page>Drukuj raport</button></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Wykańczalnia</th><th>Symbol wykańczalni / handlowy</th><th>Symbol surowy</th><th>PM</th><th>Zlecenie barwiarskie</th><th>Data przyjęcia</th><th>Nr faktury</th><th>Nr PZ</th><th>Ilość końcowa</th><th>Koszt surowca</th><th>Koszt wykończenia razem</th><th>Koszt rzeczywisty / jednostkę</th><th>Koszt teoretyczny / jednostkę</th><th>Różnica kwotowa</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${V.esc(row.finishing_plant_name)}</td><td>${V.esc(row.trade_symbol)}</td><td>${V.esc(row.raw_symbol)}</td><td>${V.esc(row.pm)}</td><td>${V.esc(row.orderNumber)}</td><td>${V.datepl(row.receipt_date)}</td><td>${V.esc(row.invoice_note||'—')}</td><td>${V.esc(row.pz_number||'—')}</td><td>${qty(row.output_quantity)} ${row.output_unit}</td><td>${money(row.raw_cost_total)} zł</td><td>${money(Costing.round2(Number(row.used_weight_kg||0)*Number(row.finishing_cost||0)))} zł</td><td>${money(row.actual_unit_cost)} zł/${row.output_unit}</td><td>${money(row.theoretical_unit_cost)} zł/${row.output_unit}</td><td>${money(Number(row.actual_unit_cost||0)-Number(row.theoretical_unit_cost||0))} zł/${row.output_unit}</td></tr>`).join('')}</tbody></table></div></article>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Raport do Subiekta',body});
}

function handle(ctx) {
  const {db,req,res,p,url,form,send,redirect,fail,role,transaction,audit,now,getFlashes}=ctx;
  migrateRecipeTradeSymbols(db);
  if(p==='/finishing'&&req.method==='GET')return redirect(req,res,'/finishing/orders');
  if(p==='/finishing/settlements/save'&&req.method==='POST'||p==='/finishing/settlements/report'&&req.method==='POST'){
    role(req.user,...editableRoles);
    const ids=[...new Set(String(form.batch_ids||'').split(',').map(value=>integer(value)).filter(value=>value&&value>0))];
    if(!ids.length)fail(400,'Zaznacz przynajmniej jedno zlecenie barwiarskie.');
    const report=p.endsWith('/report'),requested=String(form.settlement_action||'save'),action=report?'report':requested==='approve'?'approve':'save';
    const results=transaction(()=>ids.map(id=>saveSettlement(ctx,id,action)));
    if(report)return send(req,res,200,settlementReportPage(ctx,ids));
    const changed=results.some(result=>result.status==='changed');
    const approved=results.filter(result=>result.status==='settled').length;
    const message=changed?'Zmieniono zatwierdzone dane. Rozliczenie ma status „Rozliczona – zmieniona”; zatwierdź je ponownie po sprawdzeniu.':action==='approve'?`Zatwierdzono ${approved} zleceń barwiarskich.`:'Zapisano robocze rozliczenie wybranych zleceń barwiarskich.';
    return redirect(req,res,'/finishing/receipts',message,changed?'warning':'success');
  }
  if(p==='/finishing/settlements/revert'&&req.method==='POST'){
    role(req.user,...editableRoles);
    const ids=[...new Set(String(form.batch_ids||'').split(',').map(value=>integer(value)).filter(value=>value&&value>0))];
    if(!ids.length)fail(400,'Zaznacz rozliczone zlecenia barwiarskie do cofnięcia.');
    const reverted=transaction(()=>{
      let count=0;const stamp=now();
      for(const batchId of ids){
        const settlement=Costing.getSettlement(db,batchId);if(!settlement||!['settled','changed'].includes(settlement.status))continue;
        const version=Number(settlement.version||0)+1,snapshot={...settlement,status:'draft',version,updated_at:stamp,updated_by:req.user.id,approved_at:null,approved_by:null};
        db.prepare("UPDATE finishing_settlements SET status='draft',version=?,updated_at=?,updated_by=?,approved_at=NULL,approved_by=NULL WHERE id=?").run(version,stamp,req.user.id,settlement.id);
        db.prepare("INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,'draft_saved',?,?,?)").run(settlement.id,version,JSON.stringify(snapshot),stamp,req.user.id);
        const settledRemainder=Costing.batchRecord(db,batchId)?.source_remainder_batch_id;
        if(settledRemainder)db.prepare("UPDATE finishing_incidents SET settled_at=NULL,settled_by=NULL WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").run(settledRemainder);
        audit(req.user,'Cofnięto rozliczenie zlecenia barwiarskiego',null,JSON.stringify({batchId,settlementId:settlement.id,version}),null);count++;
      }
      return count;
    });
    if(!reverted)fail(409,'Zaznaczone zlecenia nie mają zatwierdzonego rozliczenia do cofnięcia.');
    return redirect(req,res,'/finishing/receipts',`Cofnięto rozliczenie ${reverted} zleceń barwiarskich. Dane i historia pozostały zachowane.`,'warning');
  }
  const remainderSettlementMatch=p.match(/^\/finishing\/orders\/(\d+)\/send-to-settlement$/);
  if(remainderSettlementMatch&&req.method==='POST'){
    role(req.user,...editableRoles);
    const orderId=Number(remainderSettlementMatch[1]),order=orderRecord(db,orderId);
    if(!order||!order.source_remainder_batch_id)fail(409,'Tylko automatyczną PMR z brakującej ilości można wysłać do rozliczenia.');
    const batch=db.prepare('SELECT * FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL ORDER BY id LIMIT 1').get(orderId);
    if(!batch)fail(409,'W PMR nie ma partii do rozliczenia.');
    if(Costing.getSettlement(db,batch.id))return redirect(req,res,'/finishing/receipts',`${manualPm(order)} jest już w przyjęciach i rozliczeniach.`,'warning');
    if(!db.prepare("SELECT id FROM finishing_incidents WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").get(order.source_remainder_batch_id))fail(409,'Nie znaleziono powiązanego wpisu w „Zagubione/zniszczone”.');
    const stamp=now(),weight=Costing.round2(Number(batch.raw_weight_kg||0));
    if(weight<=0)fail(409,'Brak kg do wysłania do rozliczenia.');
    transaction(()=>{
      db.prepare(`INSERT INTO finishing_settlements(batch_id,status,used_weight_kg,output_quantity,output_unit,updated_at,updated_by)
        VALUES(?,'draft',?,?,'kg',?,?)`).run(batch.id,weight,weight,stamp,req.user.id);
      audit(req.user,'Wysłano automatyczną PMR do rozliczenia',null,JSON.stringify({orderId,batchId:batch.id,sourceBatchId:order.source_remainder_batch_id,pieces:batch.sent_pieces,weightKg:weight}),null);
    });
    return redirect(req,res,`/finishing/receipts?q=${encodeURIComponent(manualPm(order))}`,`${manualPm(order)} trafiła do przyjęć i rozliczeń jako braki.`);
  }
  if(p==='/finishing/orders/outstanding-report'&&req.method==='GET'){
    const requested=String(url.searchParams.get('date')||''),asOf=/^\d{4}-\d{2}-\d{2}$/.test(requested)?requested:V.todayInput();
    return send(req,res,200,outstandingReportPage(ctx,asOf));
  }
  if(p==='/finishing/orders'&&req.method==='GET')return send(req,res,200,ordersPage(ctx));
  if(p==='/finishing/orders/manual'){
    role(req.user,...editableRoles);
    if(req.method==='GET')return send(req,res,200,manualOrderCreatePage(ctx));
    if(req.method==='POST'){
      const rawSymbol=text(form,'raw_symbol',200),tradeSymbol=text(form,'trade_symbol',200),client=text(form,'client_name',200),plantId=Number(form.finishing_plant_id)||null;
      if(plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(plantId))fail(400,'Nie znaleziono wybranej wykańczalni.');
      const recipeId=Number(form.recipe_id)||null,selectedRecipe=recipeId?recipeRecord(db,recipeId):null;
      if(recipeId&&(!selectedRecipe||!selectedRecipe.active))fail(400,'Wybierz aktywną recepturę z biblioteki albo pozostaw wybór pusty.');
      const sentAt=text(form,'sent_at',10)||V.todayInput();
      if(!validDate(sentAt))fail(400,'Wpisz prawidłową datę wysyłki.');
      const sentPieces=integer(form.sent_pieces),weight=number(form.raw_weight_kg),rawWeight=weight===null?0:weight;
      if(sentPieces!==null&&sentPieces<0||rawWeight<0)fail(400,'Sztuki i masa wysłana nie mogą być ujemne.');
      const targetColor=text(form,'target_color',160),targetStiffening=text(form,'target_stiffening',2000),width=number(form.target_width_cm),grammage=number(form.target_grammage);
      if(width!==null&&width<=0)fail(400,'Szerokość musi być większa od zera.');
      if(grammage!==null&&grammage<=0)fail(400,'Gramatura musi być większa od zera.');
      const recipeName=text(form,'recipe_name',200),recipeText=text(form,'recipe_text',20000),recipeNotes=recipeNotesData(text(form,'recipe_notes',100000)),noteData=recipeNotesData(text(form,'notes',100000)),manualDescription=text(form,'manual_input_description',3000),yarnLot=text(form,'yarn_lot',250);
      const snapshot={name:recipeName,finishingPlant:plantId?(db.prepare('SELECT name FROM finishing_plants WHERE id=?').get(plantId)?.name||''):'',rawSymbol,tradeSymbol,recipeText,targetColor,targetStiffening,targetWidthCm:width,targetGrammage:grammage,details:selectedRecipe?readRecipeDetails(selectedRecipe):{},notes:JSON.stringify(recipeNotes)};
      const id=transaction(()=>{
        const stamp=now(),manualReference=nextManualReference(db,stamp);
        const created=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,order_type,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_id,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,notes,manual_entry,manual_reference,manual_input_description,status,created_at,created_by,updated_at,updated_by)
          VALUES(NULL,'standard',NULLIF(?,0),'','',?,?,?,?,?,?,?,?,?,?,1,?,?,'draft',?,?,?,?)`).run(plantId||0,rawSymbol,client,tradeSymbol,recipeId,JSON.stringify(snapshot),targetColor,targetStiffening,width,grammage,JSON.stringify(noteData),manualReference,manualDescription,stamp,req.user.id,stamp,req.user.id);
        const orderId=Number(created.lastInsertRowid);
        db.prepare("INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by) VALUES(?,'',?,?,?,?,'',?,?,?,?)").run(orderId,sentAt,sentPieces??0,rawWeight,yarnLot,stamp,req.user.id,stamp,req.user.id);
        audit(req.user,'Utworzono ręczne zlecenie wykańczania',null,JSON.stringify({orderId,manualReference,recipeId,sentPieces:sentPieces??0,rawWeight}),null);
        return orderId;
      });
      return redirect(req,res,`/finishing/orders/${id}`,'Zapisano nowe zlecenie ręczne.');
    }
  }
  if(p==='/finishing/orders/new'&&req.method==='GET'){
    const partial=url.searchParams.get('partial');
    if(partial==='source'){
      const id=Number(url.searchParams.get('shipment_article_id')||0),source=id?sourceSpec(db,id):null;
      if(!source||source.status!=='closed'||Number(source.raw_bales)<1)return send(req,res,409,'<p class="muted">Ta specyfikacja nie ma już dostępnych sztuk do nowego zlecenia.</p>');
      if(shipmentSpecUsed(db,id))return send(req,res,409,'<p class="muted">Ta pozycja PM jest już powiązana ze zleceniem wykańczania.</p>');
      return send(req,res,200,sourceDetailsView(db,source));
    }
    if(partial==='last-production'){
      const shipmentArticleId=Number(url.searchParams.get('shipment_article_id')||0),source=shipmentArticleId?sourceSpec(db,shipmentArticleId):null,recipeId=Number(url.searchParams.get('recipe_id')||0),recipe=recipeId?recipeRecord(db,recipeId):null;
      if(!source||source.status!=='closed'||shipmentSpecUsed(db,shipmentArticleId))return send(req,res,409,JSON.stringify({error:'Wybrana pozycja PM nie jest już dostępna.'}),'application/json; charset=utf-8');
      if(recipeId&&(!recipe||!recipe.active))return send(req,res,409,JSON.stringify({error:'Wybrana receptura nie jest już dostępna.'}),'application/json; charset=utf-8');
      return send(req,res,200,JSON.stringify(lastProductionPreview(db,source,recipe)),'application/json; charset=utf-8');
    }
    if(partial==='recipes'){
      const requestedPlant=Number(url.searchParams.get('plant_id')||0),plantId=Number.isSafeInteger(requestedPlant)&&requestedPlant>0?requestedPlant:0;
      return send(req,res,200,recipeSearchView(db,url.searchParams.get('q')||'',plantId));
    }
    return send(req,res,200,orderForm(ctx,Number(url.searchParams.get('shipment_article_id')||0)));
  }
  if(p==='/finishing/orders'&&req.method==='POST'){
    role(req.user,...editableRoles);
    const orderType=String(form.order_type||'');
    if(!['standard','raw_sale','trial'].includes(orderType))fail(400,'Wybierz rodzaj zlecenia.');
    if(form.confirm_last_production!=='1')fail(409,'Przed utworzeniem zlecenia zapoznaj się z podsumowaniem ostatniej produkcji i je potwierdź.');
    const rawSale=orderType==='raw_sale',requiresFinishing=!rawSale;
    const shipmentArticleId=Number(form.shipment_article_id),plantId=Number(form.finishing_plant_id),source=sourceSpec(db,shipmentArticleId),plant=plantId?db.prepare('SELECT id,name FROM finishing_plants WHERE id=? AND active=1').get(plantId):null;
    if(!source||source.status!=='closed')fail(400,'Wybierz zamkniętą specyfikację wysyłkową.');
    if(shipmentSpecUsed(db,shipmentArticleId))fail(409,'Ta pozycja PM jest już powiązana ze zleceniem wykańczania. Wybierz inną specyfikację.');
    if(Number(source.raw_bales)<1)fail(409,'Wybrana pozycja WZ nie ma aktywnych sztuk do wykańczania.');
    if(requiresFinishing&&!plant)fail(400,'Wybierz aktywną wykończalnię.');
    const recipeId=rawSale?0:Number(form.recipe_id),recipe=recipeId?recipeRecord(db,recipeId):null;
    if(requiresFinishing&&(!recipe||!recipe.active))fail(400,'Wybierz aktywną recepturę z biblioteki.');
    if(requiresFinishing&&recipe.finishing_plant_id&&recipe.finishing_plant_id!==plantId)fail(400,'Wybrana receptura jest przypisana do innej wykończalni.');
    const client=text(form,'client_name',200);
    const enteredWidth=number(form.target_width_cm),enteredGrammage=number(form.target_grammage);
    const targetWidth=enteredWidth===null?(recipe?.target_width_cm??null):enteredWidth,targetGrammage=enteredGrammage===null?(recipe?.target_grammage??null):enteredGrammage;
    if(targetWidth!==null&&targetWidth<=0)fail(400,'Szerokość musi być większa od zera.');
    if(targetGrammage!==null&&targetGrammage<=0)fail(400,'Gramatura musi być większa od zera.');
    const id=transaction(()=>{
      const currentSource=sourceSpec(db,shipmentArticleId);
      if(!currentSource||currentSource.status!=='closed')fail(409,'Specyfikacja wysyłkowa nie jest już dostępna. Odśwież listę i wybierz inną pozycję.');
      if(shipmentSpecUsed(db,shipmentArticleId))fail(409,'Ta pozycja PM została już powiązana z innym zleceniem wykańczania.');
      if(Number(currentSource.raw_bales)<1)fail(409,'Wybrana pozycja WZ nie ma już aktywnych sztuk do wykańczania.');
      let orderNotes=recipeNotesData(String(form.notes||'').trim().slice(0,100000));
      const finishingNote=text(form,'last_production_note',3000);
      if(finishingNote)orderNotes=appendRecipeNote(orderNotes,`Informacja dla wykańczalni: ${finishingNote}`);
      if(recipe){
        const previousProduction=lastProductionPreview(db,currentSource,recipe);
        if(previousProduction.lotChanged&&previousProduction.previousLot){
          const previousOrderInReference=previousProduction.finishingOrder?`zleceniu farbiarskim nr ${previousProduction.finishingOrder}`:'ostatnim zleceniu farbiarskim';
          orderNotes=appendRecipeNote(orderNotes,`UWAGA: INNY LOT PRZĘDZY NIŻ W ${previousOrderInReference.toLocaleUpperCase('pl-PL')}. WYKONAĆ KOREKTĘ KOLORU.`);
        }
      }
      const tradeSymbol=orderType==='trial'?'PRÓBA':text(form,'trade_symbol',200),recipeSnapshot={...snapshotRecipe(recipe),finishingPlant:plant?.name||''};
      if(orderType==='trial'){recipeSnapshot.tradeSymbol='PRÓBA';recipeSnapshot.details={...(recipeSnapshot.details||{}),tradeSymbol:'PRÓBA'};}
      const result=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,order_type,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_id,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,notes,status,created_at,created_by,updated_at,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(currentSource.shipment_article_id,orderType,plantId||null,shipmentNo({sequence:currentSource.shipment_sequence,shipment_year:currentSource.shipment_year}),currentSource.shipment_date,currentSource.symbol,client,tradeSymbol,recipe?recipeId:null,JSON.stringify(recipeSnapshot),text(form,'target_color',160)||(recipe&&recipe.target_color)||'',text(form,'target_stiffening',160)||(recipe&&recipe.target_stiffening)||'',targetWidth,targetGrammage,JSON.stringify(orderNotes),rawSale?'raw_sale':'draft',now(),req.user.id,now(),req.user.id);
      const newId=Number(result.lastInsertRowid);
      const pieceCount=saveOrderPieces(db,newId,currentSource.shipment_article_id);
      if(!pieceCount)fail(409,'Wybrana pozycja WZ nie ma już aktywnych sztuk do załadowania do zlecenia.');
      const orderBales=db.prepare('SELECT bale_local_id,bale_number,machine,production_date,weight_kg,meters,lot FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(newId);
      if(rawSale){
        createRawSaleReceipt(db,newId,orderBales,req.user.id,now(),V.todayInput());
      }else{
        const yarnLots=[...new Set(orderBales.map(piece=>String(piece.lot||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pl')).join(', ');
        db.prepare('INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(newId,'',V.todayInput(),currentSource.raw_bales,currentSource.raw_weight_kg,yarnLots,'',now(),req.user.id,now(),req.user.id);
      }
      audit(req.user,'Utworzono zlecenie jako wyjście PM do farbiarni',null,JSON.stringify({orderId:newId,sourceShipmentArticleId:currentSource.shipment_article_id,recipeId,orderType,sentPieces:currentSource.raw_bales,rawWeightKg:currentSource.raw_weight_kg}),null);
      return newId;
    });
    if(rawSale){const savedSource=sourceSpec(db,shipmentArticleId),savedPm=savedSource?.article_sequence?`PM ${articleNo({sequence:savedSource.shipment_sequence,shipment_year:savedSource.shipment_year},{sequence:savedSource.article_sequence})}`:`PM ${savedSource?.source_shipment_no||''}`;return redirect(req,res,`/finishing/receipts?q=${encodeURIComponent(savedPm)}`,'Sprzedaż surowej została przeniesiona do przyjęć i rozliczeń.');}
    return redirect(req,res,'/finishing/orders',orderType==='trial'?'Utworzono zlecenie próbne.':'Utworzono zlecenie wykańczania.');
  }
  const orderDelete=p.match(/^\/finishing\/orders\/(\d+)\/delete$/);
  if(orderDelete){
    role(req.user,...editableRoles);
    const id=Number(orderDelete[1]),order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    if(req.method==='GET'){
      return send(req,res,200,deleteOrderConfirmPage(ctx,order));
    }
    if(req.method==='POST'){
      if(form.confirm_delete_order!=='1')fail(400,'Potwierdź usunięcie zlecenia.');
      transaction(()=>{
        const current=orderRecord(db,id);
        if(!current)fail(404,'Nie znaleziono zlecenia.');
        const sourceRemainderBatchId=current.source_remainder_batch_id?Number(current.source_remainder_batch_id):null;
        db.prepare('UPDATE finishing_incidents SET batch_id=NULL WHERE order_id=?').run(id);
        db.prepare('UPDATE finishing_batches SET correction_parent_batch_id=NULL,correction_of_batch_id=NULL WHERE order_id=?').run(id);
        db.prepare('DELETE FROM finishing_orders WHERE id=?').run(id);
        if(sourceRemainderBatchId){
          db.prepare("UPDATE finishing_incidents SET settled_at=NULL,settled_by=NULL WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").run(sourceRemainderBatchId);
          const source=db.prepare('SELECT order_id FROM finishing_batches WHERE id=?').get(sourceRemainderBatchId),stamp=now();
          if(source)syncAutoLostIncidentsForOrder(db,source.order_id,req.user.id,stamp);
          if(source)syncAutoRemainderPmrsForOrder(db,source.order_id,req.user.id,stamp);
        }
        audit(req.user,'Usunięto zlecenie wykańczania wraz z przyjęciami i rozliczeniami',null,JSON.stringify({orderId:id,rawSymbol:current.raw_symbol,client:current.client_name,status:current.status,sourceShipmentArticleId:current.shipment_article_id,sourceRemainderBatchId}),null);
      });
      return redirect(req,res,'/finishing/orders',order.source_remainder_batch_id?'Usunięto automatyczne PMR. Brak pozostał zapisany na pierwotnym zleceniu.':'Usunięto zlecenie wykańczania.');
    }
  }
  const orderEditMatch=p.match(/^\/finishing\/orders\/(\d+)\/edit$/);
  if(orderEditMatch){
    role(req.user,...editableRoles);
    const id=Number(orderEditMatch[1]),order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    if(order.status==='raw_sale'||order.status==='cancelled'&&!order.manual_entry)fail(409,'Anulowanego zlecenia ani sprzedaży surowej nie można edytować.');
    if(req.method==='GET')return send(req,res,200,orderEditPage(ctx,order));
    if(req.method==='POST'){
      const rawSymbol=text(form,'raw_symbol',200),tradeSymbol=order.order_type==='trial'?'PRÓBA':text(form,'trade_symbol',200),client=text(form,'client_name',200),plantId=Number(form.finishing_plant_id)||null;
      if(!rawSymbol&&!order.manual_entry)fail(400,'Wpisz symbol dzianiny.');
      if(plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=?').get(plantId))fail(400,'Nie znaleziono wybranej wykończalni.');
      const targetColor=text(form,'target_color',160),targetStiffening=text(form,'target_stiffening',2000),width=number(form.target_width_cm),grammage=number(form.target_grammage);
      if(width!==null&&width<=0)fail(400,'Szerokość musi być większa od zera.');
      if(grammage!==null&&grammage<=0)fail(400,'Gramatura musi być większa od zera.');
      const noteData=recipeNotesData(text(form,'notes',100000));
      const recipeName=text(form,'recipe_name',200),recipeText=text(form,'recipe_text',20000),recipeNotes=recipeNotesData(text(form,'recipe_notes',100000));
      const selectedRecipeId=order.manual_entry?(Number(form.recipe_id)||null):order.recipe_id;
      const selectedRecipe=selectedRecipeId?recipeRecord(db,selectedRecipeId):null;
      if(order.manual_entry&&selectedRecipeId&&(!selectedRecipe||!selectedRecipe.active))fail(400,'Wybierz aktywną recepturę z biblioteki albo pozostaw wybór pusty.');
      let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
      snapshot.name=recipeName;snapshot.rawSymbol=rawSymbol;snapshot.tradeSymbol=tradeSymbol;snapshot.finishingPlant=plantId?(db.prepare('SELECT name FROM finishing_plants WHERE id=?').get(plantId)?.name||''):'';
      if(order.order_type==='trial')snapshot.details={...(snapshot.details||{}),tradeSymbol:'PRÓBA'};
      snapshot.recipeText=recipeText;snapshot.targetColor=targetColor;snapshot.targetStiffening=targetStiffening;snapshot.targetWidthCm=width;snapshot.targetGrammage=grammage;snapshot.notes=recipeNotes;
      if(order.manual_entry)snapshot.details=selectedRecipe?readRecipeDetails(selectedRecipe):{};

      const sourceRows=order.shipment_article_id?sourcePieces(db,order.shipment_article_id):[];
      const sourceIds=new Set(sourceRows.map(row=>String(row.bale_local_id)));
      const savedIds=new Set(db.prepare('SELECT bale_local_id FROM finishing_order_bales WHERE order_id=?').all(id).map(row=>String(row.bale_local_id)));
      const baleCount=order.manual_entry?0:integer(form.bale_count);
      if(baleCount===null||baleCount<0||baleCount>500)fail(400,'Nieprawidłowa liczba belek w specyfikacji.');
      const selectedBales=[];
      for(let i=0;i<baleCount;i++){
        const prefix=`bale_${i}_`,localId=text(form,`${prefix}local_id`,200);
        if(!localId)fail(400,`Brak identyfikatora belki ${i+1}.`);
        if(form[`${prefix}include`]!=='1')continue;
        if(!sourceIds.has(localId)&&!savedIds.has(localId))fail(409,`Belka ${localId} nie należy do źródłowej specyfikacji tego zlecenia.`);
        const baleNumber=text(form,`${prefix}number`,100),machine=text(form,`${prefix}machine`,100),productionDate=text(form,`${prefix}date`,10),meters=validatePositiveNumber(form[`${prefix}meters`],`Metry belki ${i+1}`),weight=validatePositiveNumber(form[`${prefix}weight`],`Masa belki ${i+1}`),lot=text(form,`${prefix}lot`,250);
        if(!baleNumber||!validDate(productionDate))fail(400,`Uzupełnij numer i prawidłową datę belki ${i+1}.`);
        selectedBales.push({localId,baleNumber,machine,productionDate,meters,weight,lot});
      }
      if(!selectedBales.length&&!order.manual_entry)fail(400,'Zlecenie musi zawierać co najmniej jedną belkę.');
      const manualDescription=text(form,'manual_input_description',3000);

      const batchCount=integer(form.batch_count),currentBatches=db.prepare('SELECT * FROM finishing_batches WHERE order_id=? ORDER BY id').all(id);
      if(batchCount===null||batchCount!==currentBatches.length)fail(409,'Lista partii zmieniła się. Odśwież formularz.');
      const editedBatches=[];
      for(let i=0;i<batchCount;i++){
        const prefix=`batch_${i}_`,batchId=integer(form[`${prefix}id`]),current=currentBatches[i];
        if(!current||batchId!==current.id)fail(409,'Lista partii zmieniła się. Odśwież formularz.');
        const finishingLot=order.manual_entry?String(current.finishing_lot||''):text(form,`${prefix}lot`,120),sentAt=text(form,`${prefix}date`,10),sentPieces=integer(form[`${prefix}pieces`]),rawWeight=number(form[`${prefix}weight`]),yarnLot=text(form,`${prefix}yarn_lot`,250),batchNotes=order.manual_entry?String(current.notes||''):text(form,`${prefix}notes`,3000);
        if(sentAt&&!validDate(sentAt)||!sentAt&&!order.manual_entry||sentPieces===null||sentPieces<0||rawWeight===null||rawWeight<0)fail(400,`Uzupełnij prawidłową datę, sztuki i masę w partii ${i+1}.`);
        const correctionInstruction=text(form,`${prefix}instruction`,3000),correctionTradeSymbol=text(form,`${prefix}trade_symbol`,200),correctionTargetColor=text(form,`${prefix}color`,160),correctionTargetGrammage=number(form[`${prefix}grammage`]),correctionTargetWidth=number(form[`${prefix}width`]);
        editedBatches.push({id:batchId,finishingLot,sentAt,sentPieces,rawWeight,yarnLot,batchNotes,closed:Boolean(current.closed_at),oldClosedAt:current.closed_at,correctionInstruction:current.correction_parent_batch_id?correctionInstruction:current.correction_instruction,correctionTradeSymbol:current.correction_parent_batch_id?correctionTradeSymbol:current.correction_trade_symbol,correctionTargetColor:current.correction_parent_batch_id?correctionTargetColor:current.correction_target_color,correctionTargetGrammage:current.correction_parent_batch_id?correctionTargetGrammage:current.correction_target_grammage,correctionTargetWidth:current.correction_parent_batch_id?correctionTargetWidth:current.correction_target_width_cm});
      }
      transaction(()=>{
        const current=orderRecord(db,id);
        if(!current||current.status==='raw_sale'||current.status==='cancelled'&&!current.manual_entry)fail(409,'Zlecenie nie jest już edytowalne.');
        db.prepare(`UPDATE finishing_orders SET finishing_plant_id=?,raw_symbol=?,client_name=?,trade_symbol=?,recipe_id=?,target_color=?,target_stiffening=?,target_width_cm=?,target_grammage=?,notes=?,recipe_snapshot=?,manual_input_description=?,updated_at=?,updated_by=? WHERE id=?`)
          .run(plantId,rawSymbol,client,tradeSymbol,selectedRecipeId,targetColor,targetStiffening,width,grammage,JSON.stringify(noteData),JSON.stringify(snapshot),manualDescription,now(),req.user.id,id);
        const deleteBale=db.prepare('DELETE FROM finishing_order_bales WHERE order_id=? AND bale_local_id=?');
        const saveBale=db.prepare(`INSERT INTO finishing_order_bales(order_id,bale_local_id,bale_number,machine,production_date,weight_kg,meters,lot) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(order_id,bale_local_id) DO UPDATE SET bale_number=excluded.bale_number,machine=excluded.machine,production_date=excluded.production_date,weight_kg=excluded.weight_kg,meters=excluded.meters,lot=excluded.lot`);
        const keepIds=new Set(selectedBales.map(bale=>bale.localId));
        for(const localId of savedIds)if(!keepIds.has(localId))deleteBale.run(id,localId);
        for(const bale of selectedBales)saveBale.run(id,bale.localId,bale.baleNumber,bale.machine,bale.productionDate,bale.weight,bale.meters,bale.lot);
        const saveBatch=db.prepare('UPDATE finishing_batches SET finishing_lot=?,sent_at=?,sent_pieces=?,raw_weight_kg=?,yarn_lot=?,notes=?,closed_at=?,correction_instruction=?,correction_trade_symbol=?,correction_target_color=?,correction_target_width_cm=?,correction_target_grammage=?,updated_at=?,updated_by=? WHERE id=? AND order_id=?');
        for(const batch of editedBatches){
          const closedAt=batch.closed?(batch.oldClosedAt||now()):null;
          saveBatch.run(batch.finishingLot,batch.sentAt,batch.sentPieces,batch.rawWeight,batch.yarnLot,batch.batchNotes,closedAt,batch.correctionInstruction,batch.correctionTradeSymbol,batch.correctionTargetColor,batch.correctionTargetWidth,batch.correctionTargetGrammage,now(),req.user.id,batch.id,id);
          recomputeBatchClosure(db,batch.id,req.user.id,now());
        }
        const syncStamp=now();syncAutoLostIncidentsForOrder(db,id,req.user.id,syncStamp);syncAutoRemainderPmrsForOrder(db,id,req.user.id,syncStamp);
        const calculationInputsChanged=rawSymbol!==order.raw_symbol||tradeSymbol!==order.trade_symbol||editedBatches.some((batch,index)=>Math.abs(batch.rawWeight-Number(currentBatches[index].raw_weight_kg||0))>0.001||batch.sentPieces!==Number(currentBatches[index].sent_pieces)||batch.correctionTradeSymbol!==currentBatches[index].correction_trade_symbol||batch.correctionTargetColor!==currentBatches[index].correction_target_color||batch.correctionTargetGrammage!==currentBatches[index].correction_target_grammage||batch.correctionTargetWidth!==currentBatches[index].correction_target_width_cm);
        if(calculationInputsChanged)markSettlementChanged(db,editedBatches.map(batch=>batch.id),req.user.id,now());
        updateOrderStatus(ctx,id);
        audit(req.user,'Edytowano zlecenie wykańczania',null,JSON.stringify({orderId:id,rawSymbol,client,tradeSymbol,recipeId:selectedRecipeId,baleCount:selectedBales.length,batchCount:editedBatches.length,settlementsMarkedChanged:calculationInputsChanged}),null);
      });
      return redirect(req,res,`/finishing/orders/${id}`,'Zapisano zmiany zlecenia, belek i partii.');
    }
  }
  const orderMatch=p.match(/^\/finishing\/orders\/(\d+)(?:\/(print|batches|lot|incidents|cancel))?$/);
  if(orderMatch){
    const id=Number(orderMatch[1]),action=orderMatch[2],order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    if(action==='print'&&req.method==='GET')return receiptPage(ctx,id,integer(ctx.url.searchParams.get('batch_id'))||0);
    if(action==='lot'&&req.method==='POST'){
      role(req.user,...editableRoles);if(['raw_sale','cancelled'].includes(order.status))fail(409,'Tego zlecenia nie można już edytować.');
      const batchId=Number(form.batch_id),lot=text(form,'finishing_lot',120),batch=db.prepare('SELECT b.*,(SELECT count(*) FROM finishing_receipts r WHERE r.batch_id=b.id) receipt_count FROM finishing_batches b WHERE b.id=? AND b.order_id=?').get(batchId,id);
      if(!batch)fail(400,'Nie znaleziono wyjścia PM dla tego zlecenia.');
      const updatedStatus=transaction(()=>{db.prepare('UPDATE finishing_batches SET finishing_lot=?,updated_at=?,updated_by=? WHERE id=?').run(lot,now(),req.user.id,batchId);const status=updateOrderStatus(ctx,id);audit(req.user,'Uzupełniono LOT partii w farbiarni',null,JSON.stringify({orderId:id,batchId,finishingLot:lot,status}),null);return status;});
      if(String(req.headers.accept||'').includes('application/json')){const lostPieces=Number(db.prepare("SELECT coalesce(sum(lost_pieces),0) pieces FROM finishing_incidents WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").get(batchId).pieces||0),displayStatus=batch.workflow_status==='poprawka'?'poprawka':updatedStatus,correctionNumber=activeCorrectionOrderNumber(db,batchId),batchStatusLabel=batch.cancelled_at?'Anulowana':batch.workflow_status==='do_poprawy'?`Poprawa spec.${correctionNumber?`: ${correctionNumber}`:''}`:batch.closed_at?lostPieces?'Przyjęta z brakiem':'Przyjęta':batch.workflow_status==='poprawka'?`Poprawa${batch.receipt_count?' · Częściowo przyjęta':''}`:batch.receipt_count?'Częściowo przyjęta':String(lot).trim()?'W farbiarni':'W drodze',batchStatusClass=batch.cancelled_at||batch.workflow_status==='do_poprawy'?'archived':batch.closed_at||batch.receipt_count?'approved':batch.workflow_status==='poprawka'||String(lot).trim()?'status-finishing':'submitted';return send(req,res,200,JSON.stringify({ok:true,finishing_lot:lot,display_order_number:finishingOrderNo({...batch,finishing_lot:lot}),status:updatedStatus,status_label:orderStatusLabel(displayStatus),status_class:orderStatusBadgeClass(displayStatus),batch_status_label:batchStatusLabel,batch_status_class:batchStatusClass,batch_id:batchId,parent_correction_batch_id:batch.correction_parent_batch_id||null}),'application/json; charset=utf-8');}
      const returnTo=form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${id}`;
      return redirect(req,res,returnTo,'Zapisano numer specyfikacji z farbiarni.');
    }
    if(action==='batches'&&req.method==='POST'){
      role(req.user,...editableRoles);
      if(form.remove_batch_id!==undefined){
        const removeBatchId=integer(form.remove_batch_id);if(!removeBatchId)fail(400,'Nieprawidłowe zlecenie do usunięcia.');
        const deleted=transaction(()=>{
          const root=db.prepare('SELECT * FROM finishing_batches WHERE id=? AND order_id=?').get(removeBatchId,id);
          if(!root)fail(404,'Nie znaleziono zlecenia barwiarskiego do usunięcia.');
          if(root.cancelled_at||root.closed_at||root.correction_parent_batch_id||root.correction_of_batch_id||!isAdditionalPmBatch(db,order,root))fail(409,'Można usuwać tylko nieprzyjęte dodatkowe zlecenia barwiarskie.');
          const ids=new Set([removeBatchId]),queue=[removeBatchId];
          while(queue.length){const parentId=queue.pop();for(const child of db.prepare('SELECT id FROM finishing_batches WHERE order_id=? AND (correction_parent_batch_id=? OR correction_of_batch_id=?)').all(id,parentId,parentId)){if(!ids.has(child.id)){ids.add(child.id);queue.push(child.id);}}}
          const removed=[...ids];
          if(db.prepare(`SELECT 1 FROM finishing_receipts WHERE batch_id IN (${removed.map(()=>'?').join(',')}) LIMIT 1`).get(...removed))fail(409,'Aby usunąć dodatkowe zlecenie, najpierw cofnij jego przyjęcie.');
          for(const batchId of removed)db.prepare('UPDATE finishing_incidents SET batch_id=NULL WHERE batch_id=?').run(batchId);
          for(const batchId of removed)db.prepare('UPDATE finishing_batches SET correction_parent_batch_id=NULL,correction_of_batch_id=NULL WHERE id=?').run(batchId);
          const info=db.prepare(`SELECT count(*) receipt_count,coalesce(sum(r.finished_pieces),0) finished_pieces FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.id IN (${removed.map(()=>'?').join(',')})`).get(...removed);
          for(const batchId of removed)db.prepare('DELETE FROM finishing_batches WHERE id=?').run(batchId);
          const remaining=Number(db.prepare('SELECT count(*) n FROM finishing_batches WHERE order_id=?').get(id).n);
          if(!remaining){
            db.prepare('DELETE FROM finishing_orders WHERE id=?').run(id);
          }else{
            if(root.correction_parent_batch_id)db.prepare("UPDATE finishing_batches SET workflow_status='do_poprawy',closed_at=NULL WHERE id=?").run(root.correction_parent_batch_id);
            const stamp=now();syncAutoLostIncidentsForOrder(db,id,req.user.id,stamp);syncAutoRemainderPmrsForOrder(db,id,req.user.id,stamp);
            updateOrderStatus(ctx,id);
          }
          audit(req.user,'Usunięto zlecenie barwiarskie i powiązane poprawki, przyjęcia oraz rozliczenia',null,JSON.stringify({orderId:id,batchId:removeBatchId,deletedBatchIds:removed,receiptCount:info.receipt_count,finishedPieces:info.finished_pieces,sourceShipmentArticleId:order.shipment_article_id,orderRemoved:!remaining}),null);
          return {removed,orderRemoved:!remaining};
        });
        const returnTo=deleted.orderRemoved||form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${id}`;
        return redirect(req,res,returnTo,`Usunięto zlecenie barwiarskie i ${deleted.removed.length-1} powiązanych prób poprawki. Przyjęcia, zgłoszenia i rozliczenia zostały wyczyszczone.`);
      }
      if(['raw_sale','cancelled'].includes(order.status)||order.order_type==='raw_sale')fail(409,'Tego zlecenia nie można już dzielić na partie.');
      const currentBatches=orderBatches(db,id),unassignedPieces=unassignedOrderPieces(db,order,currentBatches),hasReceipts=Boolean(db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(id));
      if(hasReceipts&&unassignedPieces===0)fail(409,'Nie ma już nieprzypisanych sztuk PM do nowej partii.');
      if(order.status==='received'&&unassignedPieces===0)fail(409,'Przyjęte zlecenie nie ma nieprzypisanych sztuk PM do nowej partii.');
      const batchId=transaction(()=>{
        const base=db.prepare('SELECT * FROM finishing_batches WHERE order_id=? AND cancelled_at IS NULL AND correction_parent_batch_id IS NULL AND correction_of_batch_id IS NULL ORDER BY id LIMIT 1').get(id);
      if(!base||base.workflow_status!=='normal')fail(409,'Nie znaleziono partii głównej do podziału.');
        const date=base.sent_at||V.todayInput(),yarnLot=base.yarn_lot||'';
        const result=db.prepare('INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'',date,0,0,yarnLot,'',now(),req.user.id,now(),req.user.id);
        const createdId=Number(result.lastInsertRowid);updateOrderStatus(ctx,id);audit(req.user,'Dodano pustą dodatkową partię wykańczalni',null,JSON.stringify({orderId:id,batchId:createdId,sourceBatchId:base.id}),null);return createdId;
      });
      const returnTo=form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${id}#batch-${batchId}`;
      return redirect(req,res,returnTo,'Dodano dodatkową partię. Ilość sztuk i masę uzupełnisz przy przyjęciu.');
    }
    if(action==='incidents'&&req.method==='POST'){
      role(req.user,...editableRoles);const kind=text(form,'incident_type',30),description=text(form,'description',1000);
      if(!['lost','wrong_order','correction','count_difference','other'].includes(kind)||!description)fail(400,'Wybierz rodzaj problemu i wpisz opis.');
      const batchId=Number(form.batch_id)||null;if(batchId&&!db.prepare('SELECT id FROM finishing_batches WHERE id=? AND order_id=?').get(batchId,id))fail(400,'Partia nie należy do tego zlecenia.');
      transaction(()=>{const row=db.prepare('INSERT INTO finishing_incidents(order_id,batch_id,incident_type,description,created_at,created_by) VALUES(?,?,?,?,?,?)').run(id,batchId,kind,description,now(),req.user.id);audit(req.user,'Zapisano problem przy wykańczaniu',null,JSON.stringify({orderId:id,incidentId:Number(row.lastInsertRowid),kind}),null);});
      return redirect(req,res,`/finishing/orders/${id}`,'Zapisano problem do wyjaśnienia.');
    }
    if(req.method==='GET'&&!action)return send(req,res,200,orderPage(ctx,id));
  }
  const correctionRequest=p.match(/^\/finishing\/batches\/(\d+)\/send-to-correction$/);
  if(correctionRequest&&req.method==='POST'){
    role(req.user,...editableRoles);
    const batchId=Number(correctionRequest[1]),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId),order=batch?orderRecord(db,batch.order_id):null;
    if(!batch||!order)fail(404,'Nie znaleziono zlecenia do poprawy.');
    if(order.order_type==='raw_sale'||order.status==='cancelled'||batch.cancelled_at||!['normal','poprawka','do_poprawy'].includes(batch.workflow_status))fail(409,'Tego zlecenia nie można już skierować do poprawy.');
    if(db.prepare('SELECT 1 FROM finishing_batches WHERE correction_parent_batch_id=? AND cancelled_at IS NULL AND closed_at IS NULL LIMIT 1').get(batchId))fail(409,'Ta partia ma już aktywną próbę poprawki.');
    const correctionInstruction=text(form,'correction_instruction',3000),correctionNotes='';
    const targetColor=form.target_color===undefined?order.target_color||'':text(form,'target_color',160),targetTradeSymbol=form.trade_symbol===undefined?order.trade_symbol||'':text(form,'trade_symbol',200);
    const enteredWidth=number(form.target_width_cm),enteredGrammage=number(form.target_grammage);
    const targetWidth=form.target_width_cm===undefined?order.target_width_cm:enteredWidth,targetGrammage=form.target_grammage===undefined?order.target_grammage:enteredGrammage;
    if(targetWidth!==null&&targetWidth<=0)fail(400,'Szerokość docelowa musi być większa od zera.');
    if(targetGrammage!==null&&targetGrammage<=0)fail(400,'Gramatura docelowa musi być większa od zera.');
    const declaredReceipt=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(used_weight_kg),0) kg FROM finishing_receipts WHERE batch_id=?').get(batchId);
    const correctionPieces=Number(declaredReceipt.pieces)>0?Number(declaredReceipt.pieces):Number(batch.sent_pieces||0),correctionWeight=Number(declaredReceipt.kg)>0?Number(declaredReceipt.kg):Number(batch.raw_weight_kg||0);
    const newBatchId=transaction(()=>{
      const stamp=now(),sentAt=V.todayInput();
      db.prepare("UPDATE finishing_batches SET workflow_status='do_poprawy',updated_at=?,updated_by=? WHERE id=?").run(stamp,req.user.id,batchId);
      const result=db.prepare(`INSERT INTO finishing_batches(order_id,workflow_status,correction_parent_batch_id,correction_instruction,correction_notes,correction_trade_symbol,correction_target_color,correction_target_width_cm,correction_target_grammage,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by)
        VALUES(?,'poprawka',?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,?,?)`).run(order.id,batchId,correctionInstruction,correctionNotes,targetTradeSymbol,targetColor,targetWidth,targetGrammage,'',sentAt,correctionPieces,correctionWeight,batch.yarn_lot||'',stamp,req.user.id,stamp,req.user.id);
      const id=Number(result.lastInsertRowid);
      db.prepare("UPDATE finishing_orders SET status='sent',updated_at=?,updated_by=? WHERE id=?").run(stamp,req.user.id,order.id);
      audit(req.user,'Utworzono próbę poprawki w tej samej PM',null,JSON.stringify({orderId:order.id,parentBatchId:batchId,batchId:id,correctionInstruction,targetTradeSymbol,targetColor,targetWidth,targetGrammage}),null);
      return id;
    });
    return redirect(req,res,`/finishing/orders/${order.id}#batch-${newBatchId}`,'Utworzono nową próbę poprawki dla tej samej PM. Przyjęcie nie zostało utworzone.');
  }
  const cancelCorrection=p.match(/^\/finishing\/batches\/(\d+)\/cancel-attempt$/);
  if(cancelCorrection&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(cancelCorrection[1]),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(id);
    if(!batch||batch.workflow_status!=='poprawka'||!batch.correction_parent_batch_id)fail(404,'Nie znaleziono próby poprawki.');
    if(batch.closed_at||db.prepare('SELECT 1 FROM finishing_receipts WHERE batch_id=?').get(id))fail(409,'Przyjętej poprawy nie można usunąć.');
    if(db.prepare('SELECT 1 FROM finishing_batches WHERE correction_parent_batch_id=? LIMIT 1').get(id))fail(409,'Nie można usunąć tej poprawy, ponieważ jest już powiązana z kolejną poprawą.');
    transaction(()=>{const stamp=now();db.prepare('UPDATE finishing_incidents SET batch_id=NULL WHERE batch_id=?').run(id);db.prepare('DELETE FROM finishing_batches WHERE id=?').run(id);db.prepare("UPDATE finishing_batches SET workflow_status='do_poprawy',updated_at=?,updated_by=? WHERE id=?").run(stamp,req.user.id,batch.correction_parent_batch_id);updateOrderStatus(ctx,batch.order_id);audit(req.user,'Usunięto poprawę',null,JSON.stringify({batchId:id,parentBatchId:batch.correction_parent_batch_id,orderId:batch.order_id}),null);});
    return redirect(req,res,`/finishing/orders/${batch.order_id}#batch-${batch.correction_parent_batch_id}`,'Usunięto poprawę. PM nadal czeka na poprawkę; można utworzyć ją ponownie.','warning');
  }
  const undoCorrectionSend=p.match(/^\/finishing\/batches\/(\d+)\/undo-send-to-correction$/);
  if(undoCorrectionSend&&req.method==='POST'){
    role(req.user,...editableRoles);
    const parentId=Number(undoCorrectionSend[1]),parent=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(parentId),order=parent?orderRecord(db,parent.order_id):null;
    if(!parent||!order||parent.cancelled_at||parent.workflow_status!=='do_poprawy')fail(404,'Nie znaleziono partii wysłanej do poprawki.');
    const attempt=db.prepare(`SELECT b.* FROM finishing_batches b WHERE b.correction_parent_batch_id=? AND b.cancelled_at IS NULL AND b.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM finishing_receipts r WHERE r.batch_id=b.id) AND NOT EXISTS(SELECT 1 FROM finishing_batches child WHERE child.correction_parent_batch_id=b.id OR child.correction_of_batch_id=b.id) ORDER BY b.id DESC LIMIT 1`).get(parentId);
    if(!attempt)fail(409,'Nie można cofnąć wysłania: próba poprawki została już przyjęta albo nie jest już aktywna.');
    transaction(()=>{
      const stamp=now(),restoredStatus=parent.correction_parent_batch_id?'poprawka':'normal';
      db.prepare('UPDATE finishing_incidents SET batch_id=NULL WHERE batch_id=?').run(attempt.id);
      db.prepare('DELETE FROM finishing_batches WHERE id=?').run(attempt.id);
      db.prepare('UPDATE finishing_batches SET workflow_status=?,updated_at=?,updated_by=? WHERE id=?').run(restoredStatus,stamp,req.user.id,parentId);
      updateOrderStatus(ctx,parent.order_id);
      audit(req.user,'Usunięto poprawę z listy zleceń',null,JSON.stringify({orderId:parent.order_id,parentBatchId:parentId,deletedAttemptBatchId:attempt.id,restoredStatus}),null);
    });
    const returnTo=form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${order.id}#batch-${parentId}`;
    return redirect(req,res,returnTo,'Usunięto poprawę. Partia źródłowa wróciła do poprzedniego statusu i można ponowić poprawkę.','warning');
  }
  const complaintMatch=p.match(/^\/finishing\/batches\/(\d+)\/(complaint|correction)$/);
  if(complaintMatch&&req.method==='POST'){
    role(req.user,...editableRoles);
    const batchId=Number(complaintMatch[1]),action=complaintMatch[2],batch=Costing.batchRecord(db,batchId);
    if(!batch)fail(404,'Nie znaleziono zlecenia barwiarskiego.');
    if(action==='complaint'){
      if(!batch.closed_at)fail(409,'Najpierw przyjmij całe zlecenie barwiarskie.');
      if(batch.complaint_status!=='normal')fail(409,'Status reklamacji został już zapisany.');
      transaction(()=>{
        const stamp=now();db.prepare("UPDATE finishing_batches SET complaint_status='reklamowana',updated_at=?,updated_by=? WHERE id=?").run(stamp,req.user.id,batchId);
        const settlement=Costing.getSettlement(db,batchId);
        if(settlement){
          const version=Number(settlement.version||1)+1,snapshot={...settlement,status:'changed',version,approved_at:null,approved_by:null};
          db.prepare("UPDATE finishing_settlements SET status='changed',version=?,updated_at=?,updated_by=?,approved_at=NULL,approved_by=NULL WHERE id=?").run(version,stamp,req.user.id,settlement.id);
          db.prepare("INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,'changed',?,?,?)").run(settlement.id,version,JSON.stringify(snapshot),stamp,req.user.id);
        }
        audit(req.user,'Oznaczono zlecenie barwiarskie jako reklamowane',null,JSON.stringify({batchId,orderId:batch.order_id}),null);
      });
      return redirect(req,res,`/finishing/orders/${batch.order_id}#batch-${batchId}`,'Oznaczono zlecenie barwiarskie jako reklamowane.');
    }
    if(batch.complaint_status!=='reklamowana')fail(409,'Najpierw oznacz zlecenie barwiarskie jako reklamowane.');
    const declaredReceipt=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(used_weight_kg),0) kg FROM finishing_receipts WHERE batch_id=?').get(batchId);
    const correctionPieces=Number(declaredReceipt.pieces)>0?Number(declaredReceipt.pieces):Number(batch.sent_pieces||0),correctionWeight=Number(declaredReceipt.kg)>0?Number(declaredReceipt.kg):Number(batch.raw_weight_kg||0);
    const createdId=transaction(()=>{
      const stamp=now(),date=V.todayInput();
      const result=db.prepare(`INSERT INTO finishing_batches(order_id,correction_of_batch_id,complaint_status,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by)
        VALUES(?,?,'normal','',?,?,?,?,'',?,?,?,?)`).run(batch.order_id,batch.id,date,correctionPieces,correctionWeight,batch.yarn_lot||'',stamp,req.user.id,stamp,req.user.id);
      const id=Number(result.lastInsertRowid);updateOrderStatus(ctx,batch.order_id);
      audit(req.user,'Utworzono poprawkowe zlecenie barwiarskie',null,JSON.stringify({batchId:id,correctionOfBatchId:batch.id,orderId:batch.order_id}),null);return id;
    });
    return redirect(req,res,`/finishing/orders/${batch.order_id}#batch-${createdId}`,'Dodano nowe poprawkowe zlecenie barwiarskie. Wpisz jego numer i po pełnym przyjęciu rozlicz je osobno.');
  }
  const receiptMatch=p.match(/^\/finishing\/batches\/(\d+)\/receipts$/);
  if(receiptMatch&&req.method==='POST'){
    role(req.user,...editableRoles);const batchId=Number(receiptMatch[1]),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId);
    if(!batch||batch.cancelled_at)fail(404,'Nie znaleziono aktywnej partii.');
    if(batch.closed_at)fail(409,'Ta partia została już przyjęta. Nie można przyjąć jej ponownie.');
    if(!String(batch.finishing_lot||'').trim())fail(409,'Najpierw wpisz numer zlecenia barwiarskiego.');
    const receivedAt=text(form,'received_at',10),rawReceived=integer(form.raw_pieces_received);
    if(!validDate(receivedAt)||rawReceived===null||rawReceived<0)fail(400,'Wpisz prawidłową datę i ręcznie podaj nieujemną liczbę przyjętych belek surowych.');
    const modalReceipt=form.modal_receipt==='1',measureMeters=modalReceipt?form.measure_meters==='1':true,measureWeight=modalReceipt?form.measure_weight==='1':true;
    if(!measureMeters&&!measureWeight)fail(400,'Wybierz zapis w metrach, kilogramach albo obu jednostkach.');
    const allowEmptyMeasurements=false;
    const meters=measureMeters&&String(form.meters_list||'').trim()?parseList(form.meters_list,'metry'):[],weights=measureWeight&&String(form.weights_list||'').trim()?parseList(form.weights_list,'kg'):[];
    if(!allowEmptyMeasurements&&measureMeters&&!meters.length||!allowEmptyMeasurements&&measureWeight&&!weights.length)fail(400,'Wpisz wymiary każdej przyjętej belki albo oznacz przyjęcie jako niekompletne.');
    if(measureMeters&&measureWeight&&meters.length!==weights.length)fail(400,`Liczba wartości metrów (${meters.length}) różni się od liczby wartości kg (${weights.length}). Popraw listy i spróbuj ponownie.`);
    const width=number(form.actual_width_cm),grammage=number(form.actual_grammage);
    if(width!==null&&width<=0||grammage!==null&&grammage<=0)fail(400,'Szerokość i gramatura muszą być większe od zera.');
    const order=orderRecord(db,batch.order_id);let savedRecipe={};try{savedRecipe=JSON.parse(order?.recipe_snapshot||'{}')}catch{}
    const recipeDetails=orderRecipeDetails(db,order,savedRecipe);
    const requiredProcesses=recipeProcessRequirements(recipeDetails),processChecks={};
    if(modalReceipt)for(const requirement of requiredProcesses){
      const status=form[`process_check_${requirement.key}`];
      if(!['ok','not_ok'].includes(status))fail(400,`Zaznacz ocenę parametru „${requirement.label}” jako OK albo NOK.`);
      processChecks[requirement.key]=status;
    }
    const requiredColor=batch.correction_target_color||order?.target_color,requiredWidth=batch.correction_target_width_cm??order?.target_width_cm,requiredGrammage=batch.correction_target_grammage??order?.target_grammage;
    const grammageStatus=parameterStatus(grammage,requiredGrammage,recipeDetails.grammageMinus,recipeDetails.grammagePlus);
    const widthStatus=parameterStatus(width,requiredWidth,recipeDetails.widthMinus,recipeDetails.widthPlus);
    const colorStatus=['ok','not_ok'].includes(form.color_status)?form.color_status:'',stiffeningStatus=['ok','not_ok'].includes(form.stiffening_status)?form.stiffening_status:'';
    if(modalReceipt&&requiredColor&&!colorStatus)fail(400,'Zaznacz ocenę koloru jako OK albo NOK.');
    if(modalReceipt&&order?.target_stiffening&&!requiredProcesses.some(item=>item.key==='stiffeningEnabled')&&!stiffeningStatus)fail(400,'Zaznacz ocenę usztywnienia jako OK albo NOK.');
    if(modalReceipt&&Number(requiredWidth)>0&&width===null)fail(400,'Wpisz zmierzoną szerokość z belki.');
    if(modalReceipt&&Number(requiredGrammage)>0&&grammage===null)fail(400,'Wpisz zmierzoną gramaturę z belki.');
    const priorCommentReceiptId=Number(form.prior_comment_receipt_id)||0;
    const usedWeight=number(form.used_weight_kg)??0;
    if(usedWeight<0)fail(400,'Wykorzystane kg nie mogą być ujemne.');
    const totalWeight=measureWeight?Math.round(weights.reduce((sum,value)=>sum+value,0)*100)/100:0,totalMeters=measureMeters?Math.round(meters.reduce((sum,value)=>sum+value,0)*100)/100:0,finishedPieces=measureMeters?meters.length:weights.length;
    const rawPiecesToSave=rawReceived;
    if(rawPiecesToSave<1)fail(400,'Wpisz co najmniej jedną przyjętą belkę surową.');
    if(finishedPieces<1)fail(400,'Dodaj zwrócone sztuki.');
    const receiptId=transaction(()=>{
      const liveBatch=db.prepare('SELECT closed_at,cancelled_at,finishing_lot,sent_pieces,raw_weight_kg,correction_parent_batch_id,correction_of_batch_id FROM finishing_batches WHERE id=?').get(batchId);
      if(!liveBatch||liveBatch.cancelled_at)fail(404,'Nie znaleziono aktywnej partii.');
      if(liveBatch.closed_at)fail(409,'Ta partia została już przyjęta. Nie można przyjąć jej ponownie.');
      if(!String(liveBatch.finishing_lot||'').trim())fail(409,'Najpierw wpisz numer zlecenia barwiarskiego.');
      const capacity=receiptCapacity(db,order,{...batch,...liveBatch});
      if(rawPiecesToSave>capacity.suggestedPieces)fail(409,`Można jeszcze rozliczyć najwyżej ${capacity.suggestedPieces} szt. z ilości przypisanej do tej partii.`);
      if(usedWeight>capacity.suggestedKg+0.01)fail(409,`Można jeszcze rozliczyć najwyżej ${money(capacity.suggestedKg)} kg z ilości przypisanej do tej partii.`);
      const result=db.prepare(`INSERT INTO finishing_receipts(batch_id,received_at,raw_pieces_received,finished_pieces,finished_weight_kg,used_weight_kg,settlement_unit,finished_meters,incomplete,actual_color,actual_stiffening,color_status,stiffening_status,actual_width_cm,actual_grammage,width_status,grammage_status,rubbing_status,notes,process_checks,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId,receivedAt,rawPiecesToSave,finishedPieces,totalWeight,usedWeight,measureMeters?'mb':'kg',totalMeters,1,text(form,'actual_color',160),text(form,'actual_stiffening',160),colorStatus,stiffeningStatus,width,grammage,widthStatus,grammageStatus,['ok','not_ok'].includes(form.rubbing_status)?form.rubbing_status:'',text(form,'notes',3000),JSON.stringify(processChecks),now(),req.user.id);
      const id=Number(result.lastInsertRowid),insert=db.prepare('INSERT INTO finishing_return_bales(receipt_id,sequence,meters,weight_kg) VALUES(?,?,?,?)');
      if(priorCommentReceiptId&&order?.recipe_id)db.prepare(`UPDATE finishing_receipts SET comment_consumed_at=?,comment_consumed_by=?
        WHERE id=? AND comment_consumed_at IS NULL AND trim(notes)<>'' AND EXISTS(
          SELECT 1 FROM finishing_batches pb JOIN finishing_orders po ON po.id=pb.order_id
          WHERE pb.id=finishing_receipts.batch_id AND po.recipe_id=?)`).run(now(),id,priorCommentReceiptId,order.recipe_id);
      for(let i=0;i<finishedPieces;i++)insert.run(id,i+1,measureMeters?meters[i]:null,measureWeight?weights[i]:null);
      const receiptTotals=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(used_weight_kg),0) kg FROM finishing_receipts WHERE batch_id=?').get(batchId),receivedTotal=Number(receiptTotals.pieces||0),mainPmBatch=isMainPmBatch(db,order,{...batch,...liveBatch}),additionalPmBatch=isAdditionalPmBatch(db,order,{...batch,...liveBatch});
      const expectedBatchPieces=Math.max(0,Number(capacity.effectiveBatchPieces||0)),stillPartial=!additionalPmBatch&&expectedBatchPieces>0&&receivedTotal<expectedBatchPieces,closeWithMissing=stillPartial&&mainPmBatch&&form.close_incomplete==='1';
      if(stillPartial&&mainPmBatch&&modalReceipt&&!['0','1'].includes(form.close_incomplete))fail(400,'Wybierz, czy zostawić główne zlecenie otwarte, czy zamknąć je z brakami.');
      db.prepare('UPDATE finishing_receipts SET incomplete=? WHERE batch_id=?').run(stillPartial&&!closeWithMissing?1:0,batchId);
      const stamp=now(),complete=recomputeBatchClosure(db,batchId,req.user.id,stamp);syncAutoLostIncidentsForOrder(db,batch.order_id,req.user.id,stamp);const autoPmrs=syncAutoRemainderPmrsForOrder(db,batch.order_id,req.user.id,stamp),autoPmr=complete?autoPmrs.find(item=>item.batchId===batchId)||null:null;
      if(complete&&batch.correction_of_batch_id)db.prepare("UPDATE finishing_batches SET complaint_status='poprawiona',updated_at=?,updated_by=? WHERE id=? AND complaint_status='reklamowana'").run(stamp,req.user.id,batch.correction_of_batch_id);
      markSettlementChanged(db,[batchId],req.user.id,now());
      updateOrderStatus(ctx,batch.order_id);
      audit(req.user,'Zarejestrowano przyjęcie z wykończalni',null,JSON.stringify({batchId,receiptId:id,returnedRawPieces:rawPiecesToSave,finishedPieces,complete,autoPmr}),null);
      return {id,complete,autoPmr,closeWithMissing};
    });
    const returnTo=modalReceipt&&form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${batch.order_id}#batch-${batchId}`;
    const pmrNotice=receiptId.autoPmr?.created?` Utworzono ${receiptId.autoPmr.reference} z brakującą ilością: ${money(receiptId.autoPmr.kg)} kg · ${receiptId.autoPmr.pieces} szt.`:'';
    return redirect(req,res,returnTo,(receiptId.closeWithMissing?'Zamknięto przyjęcie z brakami. Braki zapisano w „Zagubione/zniszczone”.':receiptId.complete?'Przyjęcie zamknięte.':'Zapisano przyjęcie częściowe. Partia pozostaje otwarta na pozostałe sztuki.')+pmrNotice,receiptId.closeWithMissing?'warning':'success');
  }
  const undoReceiptMatch=p.match(/^\/finishing\/batches\/(\d+)\/receipts\/undo$/);
  if(undoReceiptMatch&&req.method==='POST'){
    role(req.user,...editableRoles);
    const batchId=Number(undoReceiptMatch[1]),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId);
    if(!batch||batch.cancelled_at)fail(404,'Nie znaleziono aktywnego zlecenia barwiarskiego.');
    const receipt=db.prepare('SELECT * FROM finishing_receipts WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId);
    if(!receipt)fail(409,'To zlecenie barwiarskie nie ma przyjęcia do cofnięcia.');
    transaction(()=>{
      const liveReceipt=db.prepare('SELECT * FROM finishing_receipts WHERE id=? AND batch_id=?').get(receipt.id,batchId);
      if(!liveReceipt)fail(409,'Ostatnie przyjęcie zostało już zmienione. Odśwież stronę.');
      db.prepare('UPDATE finishing_receipts SET comment_consumed_at=NULL,comment_consumed_by=NULL WHERE comment_consumed_by=?').run(liveReceipt.id);
      db.prepare('DELETE FROM finishing_receipts WHERE id=? AND batch_id=?').run(liveReceipt.id,batchId);
      const currentBatch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId),currentOrder=orderRecord(db,batch.order_id);
      if(isAdditionalPmBatch(db,currentOrder,currentBatch))db.prepare('UPDATE finishing_batches SET sent_pieces=0,raw_weight_kg=0 WHERE id=?').run(batchId);
      const remainingPieces=Number(db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces FROM finishing_receipts WHERE batch_id=?').get(batchId)?.pieces||0),capacity=receiptCapacity(db,currentOrder,currentBatch),hasReceipts=Boolean(db.prepare('SELECT 1 FROM finishing_receipts WHERE batch_id=? LIMIT 1').get(batchId)),stillPartial=hasReceipts&&Number(capacity.effectiveBatchPieces||0)>remainingPieces;
      if(hasReceipts)db.prepare('UPDATE finishing_receipts SET incomplete=? WHERE batch_id=?').run(stillPartial?1:0,batchId);
      const stamp=now(),complete=recomputeBatchClosure(db,batchId,req.user.id,stamp);
      syncAutoLostIncidentsForOrder(db,batch.order_id,req.user.id,stamp);
      syncAutoRemainderPmrsForOrder(db,batch.order_id,req.user.id,stamp);
      if(batch.correction_of_batch_id&&!complete)db.prepare("UPDATE finishing_batches SET complaint_status='reklamowana',updated_at=?,updated_by=? WHERE id=? AND complaint_status='poprawiona'").run(stamp,req.user.id,batch.correction_of_batch_id);
      markSettlementChanged(db,[batchId],req.user.id,stamp);
      updateOrderStatus(ctx,batch.order_id);
      audit(req.user,'Cofnięto ostatnie przyjęcie zlecenia barwiarskiego',null,JSON.stringify({batchId,receiptId:liveReceipt.id,rawPiecesReceived:liveReceipt.raw_pieces_received,usedWeightKg:liveReceipt.used_weight_kg,remainingReceipts:hasReceipts,closed:complete}),null);
    });
    return redirect(req,res,`/finishing/orders/${batch.order_id}#batch-${batchId}`,'Cofnięto ostatnie przyjęcie tego zlecenia barwiarskiego.');
  }
  const lostAction=p.match(/^\/finishing\/lost\/(\d+)\/(found|settle|info)$/);
  if(lostAction&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(lostAction[1]),kind=lostAction[2],incident=db.prepare("SELECT * FROM finishing_incidents WHERE id=? AND auto_generated=1 AND incident_type='lost'").get(id);
    if(!incident)fail(404,'Nie znaleziono wpisu o zagubionych sztukach.');
    if(kind==='info'){
      const additionalInfo=text(form,'additional_info',1000);
      transaction(()=>{db.prepare('UPDATE finishing_incidents SET resolution=? WHERE id=?').run(additionalInfo,id);audit(req.user,'Zapisano dodatkowe informacje o brakujących sztukach',null,JSON.stringify({incidentId:id,orderId:incident.order_id,batchId:incident.batch_id}),null);});
      return redirect(req,res,'/finishing/lost','Zapisano dodatkowe informacje.');
    }
    const stamp=now(),column=kind==='found'?'found_at':'settled_at',userColumn=kind==='found'?'found_by':'settled_by';
    const wasMarked=Boolean(incident[column]),nextValue=wasMarked?null:stamp;
    transaction(()=>{
      db.prepare(`UPDATE finishing_incidents SET ${column}=?,${userColumn}=?,${otherColumn}=NULL,${otherUserColumn}=NULL WHERE id=?`).run(nextValue,wasMarked?null:req.user.id,id);
      audit(req.user,kind==='found'?(wasMarked?'Cofnięto oznaczenie odnalezienia sztuk':'Oznaczono brakujące sztuki jako odnalezione'):(wasMarked?'Cofnięto oznaczenie rozliczenia z wykańczalnią':'Oznaczono brakujące sztuki jako rozliczone z wykańczalnią'),null,JSON.stringify({incidentId:id,orderId:incident.order_id,batchId:incident.batch_id,marked:!wasMarked}),null);
    });
    return redirect(req,res,'/finishing/lost',wasMarked?(kind==='found'?'Cofnięto oznaczenie odnalezienia.':'Cofnięto oznaczenie rozliczenia z wykańczalnią.'):(kind==='found'?'Oznaczono sztuki jako odnalezione.':'Oznaczono sztuki jako rozliczone z wykańczalnią.'));
  }
  const resolveMatch=p.match(/^\/finishing\/incidents\/(\d+)\/resolve$/);
  if(resolveMatch&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(resolveMatch[1]),resolution=text(form,'resolution',1000),incident=db.prepare('SELECT * FROM finishing_incidents WHERE id=?').get(id);
    if(!incident)fail(404,'Nie znaleziono problemu.');if(incident.status==='resolved')fail(409,'Problem został już rozwiązany.');if(!resolution)fail(400,'Wpisz rozwiązanie.');
    transaction(()=>{db.prepare("UPDATE finishing_incidents SET status='resolved',resolution=?,resolved_at=?,resolved_by=? WHERE id=?").run(resolution,now(),req.user.id,id);audit(req.user,'Rozwiązano problem przy wykańczaniu',null,JSON.stringify({incidentId:id,orderId:incident.order_id}),null);});
    return redirect(req,res,`/finishing/orders/${incident.order_id}`,'Oznaczono problem jako rozwiązany.');
  }
  if(p==='/finishing/receipts'&&req.method==='GET')return send(req,res,200,receiptsPage(ctx));
  if(p==='/finishing/lost'&&req.method==='GET')return send(req,res,200,lostPage(ctx));
  const receiptEdit=p.match(/^\/finishing\/receipts\/(\d+)\/edit$/);
  if(receiptEdit&&req.method==='POST'){
    role(req.user,...editableRoles);const receiptId=Number(receiptEdit[1]),receipt=db.prepare(`SELECT r.*,b.order_id,b.sent_pieces,b.raw_weight_kg,b.closed_at FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE r.id=?`).get(receiptId);
    if(!receipt)fail(404,'Nie znaleziono przyjęcia.');
    const used=validatePositiveNumber(form.used_weight_kg,'Wykorzystane kg',true),bales=db.prepare('SELECT * FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receiptId),rawReceived=integer(form.raw_pieces_received),width=number(form.actual_width_cm),grammage=number(form.actual_grammage);
    if(rawReceived===null)fail(400,'Wpisz ręcznie liczbę przyjętych belek surowych.');
    if(rawReceived!==null&&rawReceived<0||width!==null&&width<=0||grammage!==null&&grammage<=0)fail(400,'Wartości przyjęcia muszą być nieujemne.');
    const incomplete=form.incomplete==='1';
    if(rawReceived<1&&!incomplete)fail(400,'Wpisz co najmniej jedną przyjętą belkę albo oznacz przyjęcie jako niekompletne.');
    if(!bales.length){transaction(()=>{db.prepare('UPDATE finishing_receipts SET used_weight_kg=?,raw_pieces_received=?,actual_color=?,actual_width_cm=?,actual_grammage=?,notes=?,incomplete=? WHERE id=?').run(used,rawReceived||0,text(form,'actual_color',160),width,grammage,text(form,'notes',3000),incomplete?1:0,receiptId);const stamp=now();recomputeBatchClosure(db,receipt.batch_id,req.user.id,stamp);syncAutoLostIncidentsForOrder(db,receipt.order_id,req.user.id,stamp);syncAutoRemainderPmrsForOrder(db,receipt.order_id,req.user.id,stamp);markSettlementChanged(db,[receipt.batch_id],req.user.id,stamp);updateOrderStatus(ctx,receipt.order_id);audit(req.user,'Poprawiono przyjęcie zlecenia barwiarskiego',null,JSON.stringify({receiptId,batchId:receipt.batch_id,usedWeightKg:used,incomplete}),null);});return redirect(req,res,`/finishing/orders/${receipt.order_id}#batch-${receipt.batch_id}`,'Zapisano zmiany przyjęcia.');}
    const hasMeters=bales.some(bale=>bale.meters!==null),hasWeights=bales.some(bale=>bale.weight_kg!==null);
    const meters=hasMeters?parseList(form.meters_list,'metry'):[],weights=hasWeights?parseList(form.weights_list,'kg'):[];
    if(hasMeters&&meters.length!==bales.length)fail(400,'Podaj jedną wartość metrów dla każdej belki.');
    if(hasWeights&&weights.length!==bales.length)fail(400,'Podaj jedną wartość kg dla każdej belki.');
    const nextMeters=hasMeters?Costing.round2(meters.reduce((sum,value)=>sum+value,0)):Number(receipt.finished_meters||0),nextWeight=hasWeights?Costing.round2(weights.reduce((sum,value)=>sum+value,0)):Number(receipt.finished_weight_kg||0);
    if(!nextMeters&&!nextWeight&&!incomplete)fail(400,'Końcowa ilość musi być większa od zera albo przyjęcie musi pozostać niekompletne.');
    transaction(()=>{
      const updateBale=db.prepare('UPDATE finishing_return_bales SET meters=?,weight_kg=? WHERE id=? AND receipt_id=?');
      bales.forEach((bale,index)=>updateBale.run(hasMeters?meters[index]:null,hasWeights?weights[index]:null,bale.id,receiptId));
      db.prepare('UPDATE finishing_receipts SET used_weight_kg=?,raw_pieces_received=?,finished_meters=?,finished_weight_kg=?,settlement_unit=?,actual_color=?,actual_width_cm=?,actual_grammage=?,notes=?,incomplete=? WHERE id=?').run(used,rawReceived||0,nextMeters,nextWeight,hasMeters?'mb':'kg',text(form,'actual_color',160),width,grammage,text(form,'notes',3000),incomplete?1:0,receiptId);
      const batchReceipts=db.prepare('SELECT coalesce(sum(finished_weight_kg),0) weight,coalesce(sum(used_weight_kg),0) used FROM finishing_receipts WHERE batch_id=?').get(receipt.batch_id);
      const settlements=db.prepare('SELECT * FROM finishing_settlements WHERE batch_id=?').all(receipt.batch_id),stamp=now();
      for(const settlement of settlements){
        const version=Number(settlement.version||0)+1,status=settlement.status==='settled'||settlement.status==='changed'?'changed':settlement.status;
        db.prepare('UPDATE finishing_settlements SET status=?,version=?,updated_at=?,updated_by=?,approved_at=NULL,approved_by=NULL WHERE id=?').run(status,version,stamp,req.user.id,settlement.id);
        const snapshot={...settlement,status,version,updated_at:stamp,updated_by:req.user.id,approved_at:null,approved_by:null};
        db.prepare('INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,?,?,?,?)').run(settlement.id,version,'changed',JSON.stringify(snapshot),stamp,req.user.id);
      }
      recomputeBatchClosure(db,receipt.batch_id,req.user.id,stamp);syncAutoLostIncidentsForOrder(db,receipt.order_id,req.user.id,stamp);syncAutoRemainderPmrsForOrder(db,receipt.order_id,req.user.id,stamp);updateOrderStatus(ctx,receipt.order_id);
      audit(req.user,'Poprawiono ilości przyjętego zlecenia barwiarskiego',null,JSON.stringify({receiptId,batchId:receipt.batch_id,usedWeightKg:used,finishedMeters:nextMeters,finishedWeightKg:nextWeight,relatedSettlements:settlements.length}),null);
    });
    return redirect(req,res,`/finishing/orders/${receipt.order_id}#batch-${receipt.batch_id}`,'Zapisano poprawione ilości. Rozliczenie wymaga ponownego przeliczenia i zatwierdzenia.','warning');
  }
  const labelMatch=p.match(/^\/finishing\/receipts\/(\d+)\/labels$/);
  if(labelMatch&&req.method==='GET')return send(req,res,200,labelPage(ctx,Number(labelMatch[1])),'text/html; charset=utf-8');
  if(p==='/finishing/labels'&&req.method==='GET')return send(req,res,200,manualLabelsPage(ctx),'text/html; charset=utf-8');
  if(p==='/finishing/recipes'&&req.method==='GET')return send(req,res,200,recipesPage(ctx));
  if(p==='/finishing/recipes/new'&&req.method==='GET'){const initialRawSymbol=String(url.searchParams.get('raw_symbol')||'').trim().slice(0,200);return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Nowa receptura',body:`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><h1>Dodaj recepturę</h1>${recipeForm(ctx,null,initialRawSymbol)}`}));}
  if(p==='/finishing/recipes'&&req.method==='POST'){
    role(req.user,...editableRoles);const value=prepareRecipe(form,fail);
    if(value.plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(value.plantId))fail(400,'Wybierz aktywną wykończalnię.');
    transaction(()=>{const row=db.prepare('INSERT INTO finishing_recipes(name,finishing_plant_id,raw_symbol,recipe_text,target_color,target_stiffening,target_width_cm,target_grammage,recipe_details,label_settings,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.name,value.plantId,value.rawSymbol,value.recipeText,value.color,value.stiffening,value.width,value.grammage,JSON.stringify(value.details),value.labelSettings,value.notes,now(),req.user.id,now(),req.user.id);audit(req.user,'Dodano recepturę wykańczania',null,JSON.stringify({recipeId:Number(row.lastInsertRowid)}),null);});
    return redirect(req,res,'/finishing/recipes','Dodano recepturę do biblioteki.');
  }
  const recipeEdit=p.match(/^\/finishing\/recipes\/(\d+)\/edit$/);
  if(recipeEdit&&req.method==='GET'){
    const recipe=recipeRecord(db,Number(recipeEdit[1]));if(!recipe)fail(404,'Nie znaleziono receptury.');
    role(req.user,...editableRoles);
    const returnToOrder=url.searchParams.get('return_to_order')==='1';
    return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Edytuj recepturę',body:`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><h1>Edytuj recepturę</h1>${recipeForm(ctx,recipe,'',returnToOrder)}`}));
  }
  const recipeStatus=p.match(/^\/finishing\/recipes\/(\d+)\/status$/);
  if(recipeStatus&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(recipeStatus[1]),recipe=recipeRecord(db,id),active=integer(form.active);
    if(!recipe)fail(404,'Nie znaleziono receptury.');
    if(active!==0&&active!==1)fail(400,'Wybierz status aktywny albo nieaktywny.');
    transaction(()=>{db.prepare('UPDATE finishing_recipes SET active=?,updated_at=?,updated_by=? WHERE id=?').run(active,now(),req.user.id,id);audit(req.user,active?'Aktywowano recepturę':'Dezaktywowano recepturę',null,JSON.stringify({recipeId:id,name:recipe.name}),null);});
    return redirect(req,res,`/finishing/recipes?status=${active?'active':'inactive'}`,active?'Receptura jest aktywna.':'Receptura jest nieaktywna.');
  }
  const recipeDelete=p.match(/^\/finishing\/recipes\/(\d+)\/delete$/);
  if(recipeDelete&&req.method==='GET'){
    role(req.user,...editableRoles);const recipe=recipeRecord(db,Number(recipeDelete[1]));if(!recipe||!recipe.active)fail(404,'Nie znaleziono aktywnej receptury.');
    return send(req,res,200,recipeDeleteConfirmPage(ctx,recipe));
  }
  if(recipeDelete&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(recipeDelete[1]),recipe=recipeRecord(db,id);
    if(!recipe||!recipe.active)fail(404,'Nie znaleziono aktywnej receptury.');
    if(form.confirm_delete_recipe!=='1')fail(400,'Potwierdź usunięcie receptury.');
    transaction(()=>{db.prepare('UPDATE finishing_recipes SET active=0,updated_at=?,updated_by=? WHERE id=? AND active=1').run(now(),req.user.id,id);audit(req.user,'Usunięto recepturę z aktywnej biblioteki',null,JSON.stringify({recipeId:id,name:recipe.name,historyPreserved:true}),null);});
    return redirect(req,res,'/finishing/recipes','Receptura została usunięta z aktywnej biblioteki. Historia zleceń pozostała zachowana.');
  }
  const recipeUpdate=p.match(/^\/finishing\/recipes\/(\d+)$/);
  if(recipeUpdate&&req.method==='GET')return send(req,res,200,recipeCardPage(ctx,Number(recipeUpdate[1])));
  if(recipeUpdate&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(recipeUpdate[1]),value=prepareRecipe(form,fail);
    if(!recipeRecord(db,id))fail(404,'Nie znaleziono receptury.');
    if(value.plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(value.plantId))fail(400,'Wybierz aktywną wykończalnię.');
    transaction(()=>{db.prepare('UPDATE finishing_recipes SET name=?,finishing_plant_id=?,raw_symbol=?,recipe_text=?,target_color=?,target_stiffening=?,target_width_cm=?,target_grammage=?,recipe_details=?,label_settings=?,notes=?,updated_at=?,updated_by=? WHERE id=?').run(value.name,value.plantId,value.rawSymbol,value.recipeText,value.color,value.stiffening,value.width,value.grammage,JSON.stringify(value.details),value.labelSettings,value.notes,now(),req.user.id,id);audit(req.user,'Zmieniono recepturę wykańczania',null,JSON.stringify({recipeId:id}),null);});
    if(form.return_to_order==='1')return redirect(req,res,`/finishing/recipes?return_to_order=1&updated_recipe_id=${id}`,'Zapisano zmiany receptury. Wrócono do tworzonego zlecenia.');
    return redirect(req,res,'/finishing/recipes','Zapisano zmiany receptury. Zlecenia historyczne zachowały poprzednią kopię.');
  }
  return false;
}

module.exports={handle,orderStatusLabel,reconcileAutoLostIncidents};
