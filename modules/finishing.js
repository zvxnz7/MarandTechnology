'use strict';

const V = require('../views');
const Costing = require('./finishing-costing');

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
const articleNo = (shipment,item) => `${String(shipment.sequence).padStart(2,'0')}-${String(item.sequence).padStart(2,'0')}`;

function recipeRecord(db,id) {
  return db.prepare(`SELECT r.*,p.name finishing_plant_name FROM finishing_recipes r
    LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id WHERE r.id=?`).get(id);
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
function pieceListView(pieces,summary='Sztuki w zleceniu') {
  const totalWeight=pieces.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0),totalMeters=pieces.reduce((sum,piece)=>sum+Number(piece.meters||0),0);
  const pieceRows=pieces.map((piece,index)=>`<li><strong>${index+1}. ${V.esc(piece.bale_number)}</strong><span>${V.esc(piece.machine||'—')} · ${V.datepl(piece.production_date)} · ${qty(piece.meters)} m · ${money(piece.weight_kg)} kg${piece.lot?` · LOT ${V.esc(piece.lot)}`:''}</span></li>`).join('');
  return `<details class="finishing-source-pieces"><summary>${summary} <span>${pieces.length} szt · ${qty(totalMeters)} m · ${money(totalWeight)} kg</span></summary>${pieces.length?`<ol class="finishing-source-piece-list">${pieceRows}</ol>`:'<p class="muted">Brak aktywnych sztuk w tej specyfikacji.</p>'}</details>`;
}
function sourceDetailsView(db,source) {
  const pieces=sourcePieces(db,source.shipment_article_id),totalWeight=pieces.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0);
  return `<div class="finishing-source-summary"><strong>PM ${articleNo({sequence:source.shipment_sequence},{sequence:source.article_sequence})} · ${V.esc(source.symbol)}</strong><span>${pieces.length} szt · ${money(totalWeight)} kg · WZ ${shipmentNo({sequence:source.shipment_sequence,shipment_year:source.shipment_year})} · ${V.datepl(source.shipment_date)}</span></div>${pieceListView(pieces)}`;
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
      coalesce(sum(r.finished_pieces),0) finished_pieces,
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
function recipes(db,plantId=0) {
  return plantId
    ? db.prepare('SELECT r.*,p.name finishing_plant_name FROM finishing_recipes r LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id WHERE r.active=1 AND (r.finishing_plant_id IS NULL OR r.finishing_plant_id=?) ORDER BY r.name COLLATE NOCASE,r.id').all(plantId)
    : db.prepare('SELECT r.*,p.name finishing_plant_name FROM finishing_recipes r LEFT JOIN finishing_plants p ON p.id=r.finishing_plant_id WHERE r.active=1 ORDER BY r.name COLLATE NOCASE,r.id').all();
}
function snapshotRecipe(recipe) {
  if(!recipe)return {};
  return {name:recipe.name,finishingPlant:recipe.finishing_plant_name||'',rawSymbol:recipe.raw_symbol||'',recipeText:recipeTextFor(recipe),details:readRecipeDetails(recipe),targetColor:recipe.target_color||'',targetStiffening:recipe.target_stiffening||'',targetWidthCm:recipe.target_width_cm??'',targetGrammage:recipe.target_grammage??'',notes:recipe.notes||''};
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
function receiptProcessSummary(receipt,details={}) {
  let checks={};try{checks=JSON.parse(receipt.process_checks||'{}')||{};}catch{}
  return recipeProcessRequirements(details).map(item=>{
    const status=checks[item.key];
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
function recipeTradeSymbol(recipe) {
  const details=readRecipeDetails(recipe);
  const saved=details.tradeSymbol||details.trade_symbol||recipe?.trade_symbol;
  if(String(saved||'').trim())return String(saved).trim();
  return String(recipe?.recipe_text||'').match(/^\s*Symbol handlowy\s*:\s*(.+?)\s*$/im)?.[1]||'';
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
    trialRecipe:selected('trial_recipe'),tradeSymbol:text(form,'trade_symbol',200),rawMaterial:text(form,'raw_material',1000),
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
  return {name,rawSymbol,details,plantId,width,grammage,color,stiffening,notes,recipeText:summary};
}
function orderStatus(db,orderId) {
  const order=db.prepare('SELECT status FROM finishing_orders WHERE id=?').get(orderId);
  if(!order)return;
  if(order.status==='raw_sale'||order.status==='cancelled')return;
  const batches=db.prepare('SELECT id,closed_at,finishing_lot FROM finishing_batches WHERE order_id=?').all(orderId);
  const status=!batches.length?'draft':batches.every(batch=>batch.closed_at)?'received':batches.some(batch=>String(batch.finishing_lot||'').trim())?'sent':'draft';
  db.prepare('UPDATE finishing_orders SET status=?,updated_at=? WHERE id=?').run(status,new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),orderId);
}
function orderStatusLabel(status) {
  return {draft:'W drodze',sent:'W farbiarni',partial:'W farbiarni',received:'Przyjęta',raw_sale:'Sprzedaż surowej',cancelled:'Anulowana'}[status]||status;
}
function orderTypeLabel(type) {
  return {standard:'Wykończenie standard',raw_sale:'Sprzedaż surowej',trial:'Próba'}[type]||'Wykończenie standard';
}
function statusBadge(status) {
  return `<span class="badge ${orderStatusBadgeClass(status)}">${V.esc(orderStatusLabel(status))}</span>`;
}
function orderStatusBadgeClass(status) {
  return {draft:'submitted',sent:'status-finishing',partial:'status-finishing',received:'approved',raw_sale:'archived',cancelled:'archived'}[status]||'submitted';
}
function lastProductionPreview(db,source,recipe) {
  const currentLots=[...new Set(sourcePieces(db,source.shipment_article_id).map(piece=>String(piece.lot||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pl'));
  const recipeSymbol=String(recipe?.raw_symbol||readRecipeDetails(recipe).rawSymbol||readRecipeDetails(recipe).raw_symbol||'').trim();
  const symbolMismatch=Boolean(recipeSymbol&&normalizeSearch(recipeSymbol)!==normalizeSearch(source.symbol));
  const symbolIssue=symbolMismatch?`Symbol z PM (${source.symbol}) różni się od symbolu receptury (${recipeSymbol}).`:!recipeSymbol?'Brak symbolu dzianiny w recepturze — nie można porównać go z PM.':'';
  const previous=db.prepare(`SELECT o.id,o.source_shipment_no,o.source_shipment_date,o.recipe_snapshot,o.target_color,o.target_grammage,
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
  const pm=previous.article_sequence?`PM ${articleNo({sequence:previous.shipment_sequence},{sequence:previous.article_sequence})}`:`PM ${previous.source_shipment_no||'—'}`;
  const orderYear=String(previous.sent_at||previous.received_at||'').slice(0,4),finishingOrder=previous.finishing_lot?`${previous.finishing_lot}${orderYear?`/${orderYear}`:''}`:'';
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
  const unresolved=Number(db.prepare("SELECT count(*) count FROM finishing_incidents WHERE auto_generated=1 AND incident_type='lost' AND (found_at IS NULL OR settled_at IS NULL)").get()?.count||0);
  return `<nav class="finishing-tabs" aria-label="Wykańczanie"><a class="${active==='orders'?'selected':''}" href="/finishing/orders">Zlecenia wykańczania</a><a class="${active==='receipts'?'selected':''}" href="/finishing/receipts">Przyjęcia i rozliczenia</a><a class="finishing-lost-tab ${active==='lost'?'selected':''}" href="/finishing/lost">Zagubione/zniszczone${unresolved?`<span class="finishing-lost-count" aria-label="${unresolved} niezałatwionych spraw">${unresolved}</span>`:''}</a><a class="${active==='recipes'?'selected':''}" href="/finishing/recipes">Biblioteka receptur wykańczania</a></nav>`;
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
  return rows.map(row=>`<option value="${row.id}" data-plant="${row.finishing_plant_id||''}"${Number(selectedId)===row.id?' selected':''}>PM ${articleNo({sequence:row.shipment_sequence},{sequence:row.article_sequence})} · ${V.esc(row.symbol)} · ${row.raw_bales} szt · ${money(row.raw_weight_kg)} kg · WZ ${shipmentNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year})} · ${V.datepl(row.shipment_date)}</option>`).join('');
}
function orderForm(ctx, selectedSource=0) {
  const db=ctx.db,source=selectedSource&&!shipmentSpecUsed(db,selectedSource)?sourceSpec(db,selectedSource):null,plantList=plants(db);
  const eligibleSource=source&&source.status==='closed'&&Number(source.raw_bales)>0?source:null;
  const clientOptions=clientNames(db).map(name=>`<option value="${V.esc(name)}"></option>`).join('');
  const orderNotes=notesEditorField({label:'Uwagi do zlecenia',ariaLabel:'Uwagi dodatkowe do zlecenia'});
  const sourceDetails=eligibleSource?sourceDetailsView(db,eligibleSource):'<p class="muted finishing-source-placeholder" data-finishing-source-placeholder>Po wybraniu specyfikacji zostaną załadowane sztuki z tej wysyłki.</p>';
  const recipePicker=`<div class="finishing-recipe-picker"><div class="finishing-recipe-search-row"><div class="finishing-recipe-search-control"><label for="finishing-recipe-search">Receptura wykańczania</label><div class="finishing-recipe-search-box"><input id="finishing-recipe-search" type="search" role="combobox" data-finishing-recipe-search data-search-url="/finishing/orders/new?partial=recipes" autocomplete="off" placeholder="Wpisz nazwę lub symbol receptury" aria-autocomplete="list" aria-expanded="false" aria-controls="finishing-recipe-results"><div id="finishing-recipe-results" class="finishing-recipe-live-results" data-finishing-recipe-results role="listbox" aria-label="Pasujące receptury"></div></div></div><div class="finishing-recipe-search-actions"><a class="finishing-recipe-edit-shortcut" href="/finishing/recipes" target="_blank" rel="noopener" data-finishing-recipe-edit-shortcut aria-label="Otwórz bibliotekę receptur do edycji" title="Otwórz bibliotekę receptur do edycji"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20Z"/></svg></a><a class="finishing-recipe-add-shortcut" href="/finishing/recipes/new" target="_blank" rel="noopener" aria-label="Dodaj nową recepturę" title="Dodaj nową recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>Nowa receptura</span></a></div></div><input type="hidden" name="recipe_id" data-finishing-recipe><p class="finishing-recipe-selected" data-finishing-recipe-selected aria-live="polite"></p><details class="finishing-selected-recipe" data-finishing-selected-recipe hidden><summary>Podgląd receptury wykańczania</summary><pre class="preline" data-finishing-selected-recipe-text></pre></details></div>`;
  const orderTypes=`<div class="finishing-order-type-inline" role="radiogroup" aria-label="Rodzaj zlecenia"><label class="finishing-order-type-option"><input type="radio" name="order_type" value="standard" checked><span class="finishing-type-check" aria-hidden="true"></span><strong>Wykończenie standard</strong></label><label class="finishing-order-type-option"><input type="radio" name="order_type" value="raw_sale"><span class="finishing-type-check" aria-hidden="true"></span><strong>Sprzedaż surowej</strong></label><label class="finishing-order-type-option"><input type="radio" name="order_type" value="trial"><span class="finishing-type-check" aria-hidden="true"></span><strong>Próba</strong></label></div>`;
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Nowe zlecenie wykańczania</h1><p class="muted">Utwórz czytelne zlecenie z pozycją PM, recepturą i kompletem informacji dla wykończalni.</p></div></div>
    <form method="post" action="/finishing/orders" class="panel padded finishing-form" data-finishing-order-form data-source-url="/finishing/orders/new?partial=source" data-production-check-url="/finishing/orders/new?partial=last-production">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_last_production','')}
    <section class="finishing-order-section"><header class="finishing-order-section-heading"><span>01</span><div><h2>Specyfikacja i sztuki</h2><p>Wybierz PM z zamkniętej WZ. Sztuki zostaną załadowane do zlecenia.</p></div></header><label>PM ze specyfikacji wysyłkowej / WZ<select name="shipment_article_id" data-finishing-source required><option value="">Wybierz PM z WZ</option>${shipmentOptions(db,eligibleSource?.shipment_article_id||0)}</select></label><div class="finishing-source-details" data-finishing-source-details aria-live="polite">${sourceDetails}</div>${orderTypes}</section>
    <section class="finishing-order-section finishing-order-details"><header class="finishing-order-section-heading"><span>02</span><div><h2>Dane zlecenia</h2><p>Receptura wykańczania, wykończalnia, klient i symbol handlowy.</p></div></header>${recipePicker}<div class="finishing-order-data-grid"><label>Wykończalnia<select name="finishing_plant_id" data-finishing-plant><option value="">Wybierz wykończalnię</option>${plantList.map(plant=>`<option value="${plant.id}"${eligibleSource?.finishing_plant_id===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><label>Klient (opcjonalnie)<input name="client_name" list="finishing-clients" maxlength="200"><datalist id="finishing-clients">${clientOptions}</datalist></label><label>Symbol handlowy<input name="trade_symbol" maxlength="200" data-finishing-trade-symbol></label><div class="finishing-additional-notes">${orderNotes}</div></div></section><div class="finishing-form-actions"><button type="submit" class="primary finishing-order-submit">Utwórz zlecenie</button></div></form>
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
    return `<button type="button" id="finishing-recipe-option-${recipe.id}" role="option" aria-selected="false" class="finishing-recipe-result" data-finishing-recipe-option data-recipe-id="${recipe.id}" data-recipe-label="${V.esc(label)}" data-recipe-text="${V.esc(recipeTextFor(recipe))}" data-plant="${recipe.finishing_plant_id||''}" data-color="${V.esc(recipe.target_color||'')}" data-stiffening="${V.esc(recipe.target_stiffening||'')}" data-width="${recipe.target_width_cm??''}" data-grammage="${recipe.target_grammage??''}" data-trade-symbol="${V.esc(tradeSymbol)}"><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Bez symbolu')}${tradeSymbol?` · ${V.esc(tradeSymbol)}`:''}${recipe.target_color?` · ${V.esc(recipe.target_color)}`:''}${recipe.finishing_plant_name?` · ${V.esc(recipe.finishing_plant_name)}`:''}</span></button>`;
  }).join('');
  return buttons?`<div class="finishing-recipe-result-list" role="group">${buttons}</div>`:'';
}
function ordersPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),status=String(ctx.url.searchParams.get('status')||'');
  const filters=['draft','sent','received','raw_sale','cancelled'];
  const all=ctx.db.prepare(`SELECT o.*,fp.name finishing_plant_name,
      s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence,
      min(b.sent_at) sent_at,count(DISTINCT b.id) batch_count,
      min(CASE WHEN b.closed_at IS NULL AND trim(coalesce(b.finishing_lot,''))<>'' THEN b.id END) open_batch_id,
      (SELECT group_concat(coalesce(nullif(trim(fb.finishing_lot),''),'Do uzupełnienia'), ', ') FROM finishing_batches fb WHERE fb.order_id=o.id) finishing_lots,
      count(DISTINCT CASE WHEN trim(coalesce(b.finishing_lot,''))<>'' THEN b.id END) lot_batch_count,
      count(DISTINCT r.id) receipt_count,
      coalesce((SELECT count(*) FROM finishing_incidents i WHERE i.order_id=o.id AND i.status='open'),0) open_incidents
    FROM finishing_orders o LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id LEFT JOIN shipments s ON s.id=sa.shipment_id
    LEFT JOIN finishing_batches b ON b.order_id=o.id LEFT JOIN finishing_receipts r ON r.batch_id=b.id
    GROUP BY o.id ORDER BY o.created_at DESC,o.id DESC`).all();
  const batchesByOrder=new Map();
  for(const batch of ctx.db.prepare(`SELECT b.id,b.order_id,b.finishing_lot,b.closed_at,b.sent_pieces,b.raw_weight_kg,
      (SELECT count(*) FROM finishing_receipts r WHERE r.batch_id=b.id) receipt_count,
      coalesce((SELECT sum(r.raw_pieces_received) FROM finishing_receipts r WHERE r.batch_id=b.id),0) raw_received
    FROM finishing_batches b ORDER BY b.id`).all()) {
    if(!batchesByOrder.has(batch.order_id))batchesByOrder.set(batch.order_id,[]);
    batchesByOrder.get(batch.order_id).push(batch);
  }
  const query=normalizeSearch(q);
  const receiveDialogs=[];
  const rows=all.filter(order=>(!status||order.status===status||(status==='sent'&&order.status==='partial'))&&(!query||[order.source_shipment_no,order.raw_symbol,order.client_name,order.trade_symbol,order.finishing_plant_name,order.finishing_lots,order.article_sequence?`PM ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:''].map(normalizeSearch).join(' ').includes(query))).map(order=>{
    const canDelete=editableRoles.includes(ctx.req.user.role)&&(order.status==='cancelled'||(order.receipt_count===0&&order.lot_batch_count===0&&['draft','raw_sale'].includes(order.status)));
    const canReceive=editableRoles.includes(ctx.req.user.role)&&order.open_batch_id&&!['raw_sale','cancelled','received'].includes(order.status);
    const canEditLots=editableRoles.includes(ctx.req.user.role)&&!['raw_sale','cancelled'].includes(order.status);
    const pm=order.article_sequence?`PM ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:`PM ${order.source_shipment_no||'—'}`;
    const batches=batchesByOrder.get(order.id)||[];
    const baseBatch=[...batches].sort((a,b)=>a.id-b.id)[0];
    const canAddSpec=editableRoles.includes(ctx.req.user.role)&&order.order_type!=='raw_sale'&&!['received','raw_sale','cancelled'].includes(order.status)&&order.receipt_count===0&&batches.length>0&&baseBatch&&Number(baseBatch.sent_pieces)>0;
    const canReceiveBatch=editableRoles.includes(ctx.req.user.role)&&!['raw_sale','cancelled','received'].includes(order.status);
    const receiveActions=[];
    const receiveButtonForBatch=batch=>{
      if(!canReceiveBatch||batch.closed_at)return '';
      const dialogId=`finishing-receive-${batch.id}`;
      receiveDialogs.push(receiptDialog(ctx,order,batch,pm));
      const hasLot=Boolean(String(batch.finishing_lot||'').trim());
      receiveActions.push(`<button type="button" class="finishing-row-action is-receive" data-batch-receive="${batch.id}"${hasLot?` data-open-dialog="${dialogId}" aria-label="Przyjmij sztuki ${V.esc(pm)} · ${V.esc(batch.finishing_lot)}" title="Przyjmij sztuki"`:' disabled aria-label="Najpierw wpisz nr zlecenia" title="Najpierw wpisz nr zlecenia"'}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>`);
      return '';
    };
    const lotCell=batches.length?`<div class="finishing-order-lot-list">${batches.map((batch,index)=>{
      const canRemoveThisSpec=canEditLots;
      const removeSpec=canRemoveThisSpec?`<form method="post" action="/finishing/orders/${order.id}/batches" class="finishing-order-remove-spec-form" data-finishing-batch-delete data-batch-label="${V.esc(batch.finishing_lot||'bez numeru')}">${hidden('csrf',ctx.req.session.csrf)}${hidden('return_to','orders')}${hidden('remove_batch_id',batch.id)}<button type="submit" class="finishing-remove-spec-button" aria-label="Usuń partię ${V.esc(batch.finishing_lot||'bez numeru')}" title="Usuń partię"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button></form>`:'';
      const addSpec=canAddSpec&&index===batches.length-1?`<form method="post" action="/finishing/orders/${order.id}/batches" class="finishing-order-add-spec-form">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="return_to" value="orders"><button type="submit" class="finishing-add-spec-button" aria-label="Dodaj kolejną partię" title="Dodaj kolejną partię"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></form>`:'';
      if(canEditLots){
        receiveButtonForBatch(batch);
        return `<div class="finishing-order-lot-entry"><form method="post" action="/finishing/orders/${order.id}/lot" class="finishing-order-lot-inline" data-finishing-lot-autosave>${hidden('csrf',ctx.req.session.csrf)}${hidden('batch_id',batch.id)}${hidden('return_to','orders')}<input name="finishing_lot" maxlength="120" value="${V.esc(batch.finishing_lot||'')}" placeholder="Wpisz nr zlecenia" aria-label="Nr zlecenia" required></form>${removeSpec}${addSpec}</div>`;
      }
      receiveButtonForBatch(batch);
      return `<div class="finishing-order-lot-entry"><span class="muted">Do uzupełnienia</span>${removeSpec}${addSpec}</div>`;
    }).join('')}</div>`:'—';
    const receiveActionStack=receiveActions.length?`<div class="finishing-order-receive-actions">${receiveActions.join('')}</div>`:'';
    return `<tr><td>${dateOnlyPl(order.sent_at||order.created_at)}</td><td>${V.esc(order.finishing_plant_name||'—')}</td><td><strong>${V.esc(order.raw_symbol)}</strong></td><td>${V.esc(order.client_name||'—')}</td><td>${V.esc(order.trade_symbol||'—')}</td><td><a class="finishing-order-pm" href="/finishing/orders/${order.id}">${V.esc(pm)}</a></td><td>${lotCell}</td><td>${statusBadge(order.status)}${order.open_incidents?` <span class="badge archived">Problemy: ${order.open_incidents}</span>`:''}</td><td class="finishing-row-actions finishing-order-actions-cell"><div class="finishing-order-actions-inline">${receiveActionStack}<a class="finishing-row-action" href="/finishing/orders/${order.id}/print" target="_blank" rel="noopener" aria-label="Drukuj zlecenie ${V.esc(pm)}" title="Drukuj zlecenie"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M7 14h10v7H7zM18 11h.01"/></svg></a>${canDelete?`<a class="finishing-row-action is-delete" href="/finishing/orders/${order.id}/delete" aria-label="Usuń zlecenie ${V.esc(pm)}" title="Usuń zlecenie">×</a>`:''}</div></td></tr>`;
  }).join('');
  const body=`${navTabs('orders',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Zlecenia wykańczania</h1><p class="muted">Zlecenie oznacza wyjście PM do farbiarni. Przyjęcie belek rozpoczniesz z listy przyciskiem „+”.</p></div><a class="button primary" href="/finishing/orders/new">+ Nowe zlecenie</a></div>
    <form method="get" action="/finishing/orders" class="shipment-list-filters"><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Data wysyłki, farbiarnia, symbol, klient, symbol handlowy, PM"></label><label>Status<select name="status"><option value="">Wszystkie</option>${filters.map(value=>`<option value="${value}"${status===value?' selected':''}>${orderStatusLabel(value)}</option>`).join('')}</select></label><button class="primary">Filtruj</button><a class="button" href="/finishing/orders">Wyczyść</a></form>
    <div class="panel scroll"><table class="listing compact finishing-orders-list"><thead><tr><th>Data wysyłki</th><th>Farbiarnia</th><th>Symbol dzianiny (surowej)</th><th>Klient</th><th>Symbol handlowy</th><th>PM</th><th>Nr zlecenia</th><th>Status</th><th>Akcje</th></tr></thead><tbody>${rows||`<tr><td colspan="9">${all.length?'Brak zleceń dla wybranych filtrów.':'Brak zleceń wykańczania.'}</td></tr>`}</table></div>${receiveDialogs.join('')}`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Zlecenia wykańczania',body});
}
function deleteOrderConfirmPage(ctx,order) {
  const cancelUrl='/finishing/orders';
  const pm=order.article_sequence?`PM ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:`PM ${order.source_shipment_no||'—'}`;
  const explanation=order.status==='cancelled'?'Usunięte zostaną karta, zapisane przyjęcia i dane belek. Specyfikacja WZ będzie dostępna do ponownego wykorzystania.':'Usunąć można tylko zlecenie bez zapisanych partii i przyjęć. Aby zwolnić specyfikację WZ, anuluj zlecenie.';
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="${cancelUrl}">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Usuń zlecenie wykańczania</h1></div></div><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Potwierdź usunięcie zlecenia</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrane zlecenie:</p><h2 class="delete-confirm-object">${V.esc(pm)} · ${V.esc(order.raw_symbol)} · ${V.esc(order.client_name||'—')}</h2><div class="shipment-cancel-details"><div class="shipment-cancel-detail-row"><strong>Skutek</strong><span>${explanation}</span></div><div class="shipment-cancel-detail-row"><strong>Historia</strong><span>Wpis audytowy pozostanie zachowany.</span></div></div><form method="post" action="/finishing/orders/${order.id}/delete" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_order','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Usuń ${V.esc(pm)}</button></form></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Usuń zlecenie',body});
}
function labelPage(ctx,receiptId) {
  const receipt=ctx.db.prepare(`SELECT r.*,b.finishing_lot,o.raw_symbol,o.trade_symbol,o.client_name,o.target_color,o.target_stiffening,o.target_width_cm,o.target_grammage,fp.name finishing_plant_name
    FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id JOIN finishing_orders o ON o.id=b.order_id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id WHERE r.id=?`).get(receiptId);
  if(!receipt)throw Object.assign(new Error('Nie znaleziono przyjęcia.'),{status:404});
  const showWeight=ctx.url.searchParams.get('weight')==='1';
  const bales=ctx.db.prepare('SELECT * FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receiptId);
  const labels=bales.map((b,index)=>`<article class="finishing-label"><strong class="finishing-label-symbol">${V.esc(receipt.trade_symbol||receipt.raw_symbol)}</strong><div><b>Kolor:</b> ${V.esc(receipt.actual_color||receipt.target_color||'—')}${receipt.color_status?` · ${receipt.color_status==='ok'?'OK':'NOK'}`:''}</div><div><b>Nr partii:</b> ${V.esc(receipt.finishing_lot||'—')}</div><div><b>Szerokość:</b> ${V.esc(receipt.actual_width_cm??receipt.target_width_cm??'—')} cm</div><div><b>Gramatura:</b> ${V.esc(receipt.actual_grammage??receipt.target_grammage??'—')} g/m²</div><div class="finishing-label-qty"><b>Ilość mb:</b> ${b.meters===null?'—':qty(b.meters)}</div>${showWeight?`<div class="finishing-label-qty"><b>Waga kg:</b> ${b.weight_kg===null?'—':qty(b.weight_kg)}</div>`:''}<small>${index+1}/${bales.length}</small></article>`).join('');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Etykiety partii ${V.esc(receipt.finishing_lot||receiptId)}</title><style>@page{size:50mm 74mm;margin:0}*{box-sizing:border-box}body{margin:0;font:10pt/1.22 Arial,sans-serif;color:#111}.toolbar{display:flex;gap:10px;align-items:center;padding:10px;background:#f3f4f6;position:sticky;top:0}.labels{display:block}.finishing-label{width:50mm;height:74mm;padding:4mm 3.5mm;overflow:hidden;page-break-after:always;break-after:page;border:1px solid #bbb;position:relative}.finishing-label-symbol{display:block;font-size:15pt;text-align:center;margin:0 0 3mm}.finishing-label>div{margin:1.6mm 0}.finishing-label-qty{font-size:13pt;font-weight:700;margin-top:3mm!important}.finishing-label small{position:absolute;bottom:2mm;right:3mm;font-size:7pt}@media print{.toolbar{display:none}.finishing-label{border:0}}</style></head><body><div class="toolbar"><button onclick="window.print()">Drukuj etykiety</button><label><input id="weight" type="checkbox"${showWeight?' checked':''} onchange="location.search=this.checked?'?weight=1':''"> Drukuj wagę kg</label><span>${bales.length} etykiet</span></div><main class="labels">${labels}</main></body></html>`;
}
function receiptDialog(ctx,order,batch,pm,returnTo='orders') {
  const dialogId=`finishing-receive-${batch.id}`,targetWidth=order.target_width_cm??'',targetGrammage=order.target_grammage??'';
  let recipeSnapshot={};try{recipeSnapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const recipeSymbol=String(recipeSnapshot.rawSymbol||recipeSnapshot.raw_symbol||'').trim();
  const recipeDetails=recipeSnapshot.details||{};
  const processRequirements=recipeProcessRequirements(recipeDetails);
  let originalOrderBales=ctx.db.prepare('SELECT weight_kg FROM finishing_order_bales WHERE order_id=?').all(order.id);
  if(!originalOrderBales.length&&order.shipment_article_id)originalOrderBales=sourcePieces(ctx.db,order.shipment_article_id);
  const originalOrderKg=originalOrderBales.reduce((sum,piece)=>sum+Number(piece.weight_kg||0),0);
  const remainingKg=Math.max(0,Math.round((originalOrderKg-Number(batch.raw_weight_kg||0))*100)/100);
  const previousBatchTotals=ctx.db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(finished_weight_kg),0) weight FROM finishing_receipts WHERE batch_id=?').get(batch.id);
  const grammagePlus=recipeDetails.grammagePlus??null,grammageMinus=recipeDetails.grammageMinus??null;
  const widthPlus=recipeDetails.widthPlus??null,widthMinus=recipeDetails.widthMinus??null;
  const symbolMismatch=recipeSymbol&&normalizeSearch(recipeSymbol)!==normalizeSearch(order.raw_symbol);
  const symbolWarning=symbolMismatch?`<div class="notice warning finishing-symbol-warning" role="status"><strong>Uwaga: różne symbole dzianiny.</strong> Symbol z PM: <strong>${V.esc(order.raw_symbol||'—')}</strong>; symbol w recepturze wykańczalni: <strong>${V.esc(recipeSymbol)}</strong>. Możesz zapisać przyjęcie mimo tej rozbieżności.</div>`:'';
  const priorComment=order.recipe_id?ctx.db.prepare(`SELECT r.id receipt_id,r.notes,r.received_at,b.finishing_lot,o.id order_id
    FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id JOIN finishing_orders o ON o.id=b.order_id
    WHERE o.recipe_id=? AND trim(r.notes)<>'' AND r.comment_consumed_at IS NULL ORDER BY r.id DESC LIMIT 1`).get(order.recipe_id):null;
  const priorCommentHtml=priorComment?`<aside class="finishing-receive-prior-comment"><strong>Poprzedni komentarz do tej receptury</strong><small>${V.datepl(priorComment.received_at)}${priorComment.finishing_lot?` · LOT ${V.esc(priorComment.finishing_lot)}`:''}</small><div>${V.esc(priorComment.notes)}</div></aside>`:'';
  const statusChoices=(name,label,required=false,description='')=>`<fieldset class="finishing-receive-check"><legend>${V.esc(label)}</legend>${description?`<small class="finishing-receive-check-description">${V.esc(description)}</small>`:''}<label><input type="radio" name="${V.esc(name)}" value="ok"${required?' required':''}><span class="finishing-receive-choice-dot is-ok" aria-hidden="true"></span><span>OK</span></label><label><input type="radio" name="${V.esc(name)}" value="not_ok"><span class="finishing-receive-choice-dot is-nok" aria-hidden="true"></span><span>NOK</span></label></fieldset>`;
  const requiredKeys=new Set(processRequirements.map(item=>item.key));
  const recipeProcessChoices=processRequirements.map(item=>statusChoices(`process_check_${item.key}`,item.label,true,item.description)).join('');
  const baseChoices=[statusChoices('color_status','Kolor'),...(!requiredKeys.has('stiffeningEnabled')?[statusChoices('stiffening_status','Usztywnienie')]:[]),...(!requiredKeys.has('brushing')&&!requiredKeys.has('brushingForVelcro')?[statusChoices('rubbing_status','Wydrapanie')]:[])].join('');
  return `<dialog id="${dialogId}" class="form-dialog finishing-receive-dialog" data-draggable-dialog aria-labelledby="${dialogId}-title"><div class="dialog-head finishing-receive-dialog-head" data-dialog-drag-handle><div><strong id="${dialogId}-title">Przyjęcie belek · ${V.esc(pm)} · ${V.datepl(V.todayInput())}</strong><small>${V.esc(order.finishing_plant_name||'')}</small></div><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body">
    <section class="finishing-receive-summary" aria-label="Przyjmowane zlecenie"><div><small>Symbol surowy</small><strong>${V.esc(order.raw_symbol||'—')}</strong></div><div><small>Symbol handlowy</small><strong>${V.esc(order.trade_symbol||'—')}</strong></div><div><small>Kolor planowany</small><strong>${V.esc(order.target_color||'—')}</strong></div><div><small>PM</small><strong>${V.esc(pm)}</strong></div><div><small>Nr zlecenia</small><strong data-receipt-order-number>${V.esc(batch.finishing_lot||'—')}</strong></div></section>${symbolWarning}
    <form id="${dialogId}-form" method="post" action="/finishing/batches/${batch.id}/receipts" class="finishing-receipt-form finishing-receive-form" data-finishing-receive-form data-raw-symbol="${V.esc(order.raw_symbol||'')}" data-trade-symbol="${V.esc(order.trade_symbol||'')}" data-target-color="${V.esc(order.target_color||'')}" data-order-number="${V.esc(batch.finishing_lot||'')}" data-plan-grammage="${V.esc(targetGrammage)}" data-plan-width="${V.esc(targetWidth)}" data-raw-weight="${V.esc(batch.raw_weight_kg)}" data-sent-pieces="${V.esc(batch.sent_pieces)}" data-previous-received-pieces="${V.esc(previousBatchTotals.pieces)}" data-previous-received-weight="${V.esc(previousBatchTotals.weight)}">${hidden('csrf',ctx.req.session.csrf)}${hidden('modal_receipt','1')}${hidden('return_to',returnTo)}${hidden('received_at',V.todayInput())}${priorComment?hidden('prior_comment_receipt_id',priorComment.receipt_id):''}<input type="hidden" name="meters_list" value="" data-receipt-meters-list><input type="hidden" name="weights_list" value="" data-receipt-weights-list>
      <section class="finishing-receive-overview" aria-label="Zlecone i odebrane wartości"><div class="finishing-receive-metrics-grid">
        ${batch.correction_of_batch_id?`<div class="finishing-receive-metric finishing-correction-note" style="grid-column:1/-1"><strong>Poprawkowe zlecenie barwiarskie</strong><span>Surowiec rozliczany jest z pierwotnego zlecenia. Wpisz fizycznie przyjęte sztuki i ich masę.</span></div><input type="hidden" name="used_weight_kg" value="0">`:`<div class="finishing-receive-metric"><small>Zlecone kg z PM</small><strong>${money(batch.raw_weight_kg)} kg</strong></div><div class="finishing-receive-metric"><small>Zlecone sztuki z PM</small><strong>${Number(batch.sent_pieces)||0}</strong></div><div class="finishing-receive-metric" title="Masa z PM poza tą partią — np. w innych partiach lub jako ubytek"><small>Pozostałe kg</small><strong>${money(remainingKg)} kg</strong></div><input type="hidden" name="used_weight_kg" value="${V.esc(batch.raw_weight_kg||'')}">`}
      </div><div class="finishing-receive-accepted-summary"><label><small>Przyjęte wg wagi (kg)</small><input type="text" inputmode="decimal" name="finished_weight_kg" placeholder="0,00" readonly data-receipt-total-weight-input></label><label><small>Przyjęte sztuki</small><input type="number" name="raw_pieces_received" min="0"${Number(batch.sent_pieces)>0?` max="${V.esc(batch.sent_pieces)}"`:''} step="1" required data-receipt-raw-pieces></label></div></section>
      <section class="finishing-receive-quality"><h3>Kontrola parametrów</h3>
        <div class="finishing-receive-param-row" data-finishing-param-row data-param-target="${V.esc(targetGrammage)}" data-param-minus="${V.esc(grammageMinus??'')}" data-param-plus="${V.esc(grammagePlus??'')}"><label>Gramatura z belki<input name="actual_grammage" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="g/m²" required></label><div><small>Gramatura zlecona</small><strong>${targetGrammage?`${V.esc(targetGrammage)} g/m²`:'—'}</strong></div><div><small>Tolerancja z receptury</small><strong>${grammagePlus!==null||grammageMinus!==null?`−${grammageMinus??'0'} / +${grammagePlus??'0'} g/m²`:'0 g/m²'}</strong></div><div class="finishing-receive-param-status" data-param-status aria-live="polite"></div></div>
        <div class="finishing-receive-param-row" data-finishing-param-row data-param-target="${V.esc(targetWidth)}" data-param-minus="${V.esc(widthMinus??'')}" data-param-plus="${V.esc(widthPlus??'')}"><label>Szerokość z belki<input name="actual_width_cm" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="cm" required></label><div><small>Szerokość zlecona</small><strong>${targetWidth?`${V.esc(targetWidth)} cm`:'—'}</strong></div><div><small>Tolerancja z receptury</small><strong>${widthPlus!==null||widthMinus!==null?`−${widthMinus??'0'} / +${widthPlus??'0'} cm`:'0 cm'}</strong></div><div class="finishing-receive-param-status" data-param-status aria-live="polite"></div></div>
        <div class="finishing-receive-check-grid">${baseChoices}${recipeProcessChoices}</div></section>
      <section class="finishing-receive-bales"><div class="finishing-receive-bales-heading"><div><h3>Sztuki z wybranej pozycji PM</h3><p class="muted">Wpisz metry i kg każdej sztuki. Enter przechodzi do następnego pola.</p></div></div><input type="hidden" name="measure_meters" value="1" data-receipt-measure-meters><input type="hidden" name="measure_weight" value="1" data-receipt-measure-weight><div class="finishing-receive-bale-list" data-receipt-bale-list></div><button type="button" class="finishing-receive-add-bale" data-receipt-add-bale>+ Dodaj sztukę</button><div class="finishing-receive-print-row"><button type="button" data-receipt-print-labels disabled>Drukuj etykiety</button></div><div class="finishing-receive-totals"><div><small>L.m. teoretyczna</small><span data-receipt-theoretical>—</span></div><div><small>Strata</small><strong data-receipt-loss>—</strong></div><div data-receipt-weight-difference><small>Różnica kg · wydane − odebrane</small><strong data-receipt-weight-difference-value>—</strong></div><div class="finishing-receive-total-highlight"><small>Razem mb</small><strong data-receipt-total-meters>—</strong></div></div><p class="finishing-receive-calculation-note" data-receipt-calculation-note>Teoria jest liczona z masy odebranych sztuk oraz planowanej gramatury i szerokości.</p></section>
      ${priorCommentHtml}<label class="finishing-receive-notes">Komentarz do partii (wyświetli się jednorazowo przy kolejnej produkcji receptury)<textarea name="notes" maxlength="3000" rows="3" placeholder="Wpisz komentarz do tej partii"></textarea></label><div class="finishing-receive-auto-close" data-receipt-auto-close-message hidden>Odebrane kg i sztuki zgadzają się ze zleceniem — to przyjęcie zamyka tę partię.</div><div class="finishing-receive-close-row"><label class="check finishing-receive-close-batch"><input type="checkbox" name="close_batch" value="1"> Ręcznie zamknij partię (np. zagubiona belka)</label></div>
      <div class="actions finishing-receive-actions"><button type="button" data-close-dialog>Wróć</button><button type="submit" class="primary">Zapisz przyjęcie</button></div>
    </form></div></dialog>`;
}
function orderPage(ctx,id) {
  const db=ctx.db,order=orderRecord(db,id);
  if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const batches=orderBatches(db,id),receipts=orderReceipts(db,id);
  const incidents=db.prepare(`SELECT i.*,u.name author,ru.name resolver FROM finishing_incidents i LEFT JOIN users u ON u.id=i.created_by LEFT JOIN users ru ON ru.id=i.resolved_by WHERE i.order_id=? ORDER BY i.id DESC`).all(id);
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const pm=order.article_sequence?`PM ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:`PM ${order.source_shipment_no||'—'}`;
  const source=order.source_shipment_no||'—';
  const piecesBody=orderPiecesView(db,order);
  const canEdit=editableRoles.includes(ctx.req.user.role)&&!['cancelled','raw_sale'].includes(order.status);
  const baseBatch=[...batches].sort((a,b)=>a.id-b.id)[0];
  const canAddBatch=canEdit&&order.order_type!=='raw_sale'&&order.status!=='received'&&receipts.length===0&&batches.length>0&&Number(baseBatch?.sent_pieces)>0;
  const lotBatch=batches.find(batch=>!String(batch.finishing_lot||'').trim())||batches[0];
  const lotControl=canEdit&&lotBatch?`<button type="button" class="finishing-lot-edit-button" data-open-dialog="finishing-lot-dialog">${lotBatch.finishing_lot?'Edytuj nr zlecenia':'Dodaj nr zlecenia'}</button>`:`<span class="muted">Nr zlecenia: ${V.esc(lotBatch?.finishing_lot||'do uzupełnienia')}</span>`;
  const lotDialog=canEdit&&lotBatch?`<dialog id="finishing-lot-dialog" class="form-dialog finishing-lot-dialog"><div class="dialog-head"><strong>Nr zlecenia z wykończalni</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body"><p>Numer można poprawić także po przyjęciu. Wpisz aktualny nr zlecenia z wykończalni.</p><form method="post" action="/finishing/orders/${id}/lot" class="finishing-lot-form">${hidden('csrf',ctx.req.session.csrf)}${hidden('batch_id',lotBatch.id)}<label>Nr zlecenia<input name="finishing_lot" maxlength="120" value="${V.esc(lotBatch.finishing_lot||'')}" autofocus></label><div class="actions"><button type="button" data-close-dialog>Wróć</button><button class="primary">Zapisz nr zlecenia</button></div></form></div></dialog>`:'';
  const receiptDialogs=[];
  const receiptViews=batches.map(batch=>{
    const recent=receipts.filter(receipt=>receipt.batch_id===batch.id);
    const rows=recent.map(receipt=>{
      const bales=db.prepare('SELECT meters,weight_kg FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receipt.id),hasMeters=bales.some(bale=>bale.meters!==null),hasWeights=bales.some(bale=>bale.weight_kg!==null);
      const edit=canEdit?`<details class="finishing-receipt-edit"><summary>Popraw przyjęte ilości</summary><form method="post" action="/finishing/receipts/${receipt.id}/edit">${hidden('csrf',ctx.req.session.csrf)}<label>Wykorzystane kg (rozliczenie farbiarni)<input type="number" name="used_weight_kg" min="0" step="0.01" value="${V.esc(receipt.used_weight_kg??'')}"></label>${hasMeters?`<label>Metry belek (po jednej w wierszu)<textarea name="meters_list" rows="3">${V.esc(bales.map(bale=>bale.meters??'').join('\n'))}</textarea></label>`:''}${hasWeights?`<label>Kg belek (po jednej w wierszu)<textarea name="weights_list" rows="3">${V.esc(bales.map(bale=>bale.weight_kg??'').join('\n'))}</textarea></label>`:''}<p class="muted">Zmiana ilości przeliczy koszt i oznaczy zatwierdzone rozliczenie jako zmienione.</p><button class="button">Zapisz ilości</button></form></details>`:'';
      return `<tr><td>${V.datepl(receipt.received_at)}</td><td>${receipt.raw_pieces_received} szt. surowe</td><td>${receipt.finished_pieces} belek · ${receipt.meters_sum===null?'—':`${qty(receipt.meters_sum)} mb`} · ${receipt.finished_weight_kg>0?`${money(receipt.finished_weight_kg)} kg`:'—'}</td><td>Gramatura: ${parameterStatusHtml(receipt.grammage_status)} · Szerokość: ${parameterStatusHtml(receipt.width_status)}<small class="finishing-subline">Kolor: ${receipt.color_status==='ok'?'OK':receipt.color_status==='not_ok'?'NOK':'—'} · Usztywnienie: ${receipt.stiffening_status==='ok'?'OK':receipt.stiffening_status==='not_ok'?'NOK':'—'} · Wydrapanie: ${receipt.rubbing_status==='ok'?'OK':receipt.rubbing_status==='not_ok'?'NOK':'—'}</small>${receiptProcessSummary(receipt,snapshot.details||{})?`<small class="finishing-subline">${V.esc(receiptProcessSummary(receipt,snapshot.details||{}))}</small>`:''}</td><td>${V.esc(receipt.notes||'—')}</td><td>${receipt.bale_count?`<a class="button" href="/finishing/receipts/${receipt.id}/labels">Etykiety</a>`:'<span class="muted small">Brak wymiarów pojedynczych belek</span>'}${edit}</td></tr>`;
    }).join('');
    const canReceiveBatch=canEdit&&!batch.closed_at&&String(batch.finishing_lot||'').trim();
    if(canReceiveBatch)receiptDialogs.push(receiptDialog(ctx,order,batch,pm,'detail'));
    const receiveButton=canReceiveBatch?`<button type="button" class="finishing-row-action is-receive" data-open-dialog="finishing-receive-${batch.id}" aria-label="Przyjmij sztuki partii ${V.esc(batch.finishing_lot)}" title="Przyjmij sztuki"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>`:canEdit&&!batch.closed_at?'<button type="button" class="finishing-row-action is-receive" disabled title="Najpierw wpisz numer specyfikacji z wykończalni" aria-label="Najpierw wpisz numer specyfikacji z wykończalni">+</button>':'';
    const batchQuantities=Number(batch.sent_pieces)>0?`${batch.sent_pieces} szt. surowe · ${money(batch.raw_weight_kg)} kg`:batch.receipt_count?`${batch.raw_received_pieces} szt. przyjęte · ${money(batch.finished_weight_kg||0)} kg przyjęte`:'Ilość sztuk i masa zostaną uzupełnione przy przyjęciu';
    const complaintBadge=batch.complaint_status==='reklamowana'?'<span class="badge archived">Reklamowana</span>':batch.complaint_status==='poprawiona'?'<span class="badge approved">Poprawiona</span>':'';
    const complaintAction=canEdit&&batch.closed_at&&batch.complaint_status==='normal'?`<form method="post" action="/finishing/batches/${batch.id}/complaint">${hidden('csrf',ctx.req.session.csrf)}<button class="button danger">Oznacz jako reklamowaną</button></form>`:'';
    const batchStatusLabel=batch.closed_at?'Przyjęte':String(batch.finishing_lot||'').trim()?'W farbiarni':'Do uzupełnienia';
    const correctionAction=canEdit&&batch.closed_at&&batch.complaint_status==='reklamowana'?`<form method="post" action="/finishing/batches/${batch.id}/correction">${hidden('csrf',ctx.req.session.csrf)}<button class="button">Dodaj poprawkowe zlecenie barwiarskie</button></form>`:'';
    return `<section class="panel padded finishing-batch-card" id="batch-${batch.id}"><h3>Zlecenie barwiarskie ${V.esc(batch.finishing_lot||`#${batch.id}`)} ${batch.closed_at?'<span class="badge approved">Przyjęte</span>':''} ${complaintBadge} ${receiveButton}</h3><p>Status: ${batchStatusLabel} · Data wysyłki: ${V.datepl(batch.sent_at)} · ${batchQuantities} · LOT przędzy: ${V.esc(batch.yarn_lot||'—')}</p><div class="actions">${complaintAction}${correctionAction}</div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Data przyjęcia</th><th>Przyjęcie surowej</th><th>Belki wykończone</th><th>Wydrapanie</th><th>Komentarz do partii</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6">Jeszcze nie przyjęto zwrotu.</td></tr>'}</tbody></table></div></section>`;
  }).join('');
  const batchRows=[...batches].sort((a,b)=>a.id-b.id).map((batch,index)=>{
    const canRemoveThisBatch=canEdit&&!batch.closed_at&&!batch.correction_of_batch_id&&!Costing.getSettlement(db,batch.id);
    const removeForm=canRemoveThisBatch?`<form method="post" action="/finishing/orders/${id}/batches" class="finishing-order-remove-spec-form" data-finishing-batch-delete data-batch-label="${V.esc(batch.finishing_lot||'bez numeru')}">${hidden('csrf',ctx.req.session.csrf)}${hidden('remove_batch_id',batch.id)}<button type="submit" class="finishing-remove-spec-button" aria-label="Usuń partię ${V.esc(batch.finishing_lot||'bez numeru')}" title="Usuń partię"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></form>`:'';
    const batchStatus=batch.closed_at?'<span class="badge approved">Przyjęte</span>':String(batch.finishing_lot||'').trim()?'<span class="badge status-finishing">W farbiarni</span>':'<span class="badge submitted">Do uzupełnienia</span>';
    return `<tr><td><strong>${batch.correction_of_batch_id?'Poprawkowe':index===0?'Główne':`Dodatkowe ${index}`}</strong>${batch.complaint_status==='reklamowana'?' · Reklamowane':batch.complaint_status==='poprawiona'?' · Poprawione':''}</td><td>${V.esc(batch.finishing_lot||'Do uzupełnienia')}</td><td>${batchStatus}</td><td>${V.datepl(batch.sent_at)}</td><td>${Number(batch.sent_pieces)>0?`${batch.sent_pieces} szt. · ${money(batch.raw_weight_kg)} kg`:batch.receipt_count?`${batch.raw_received_pieces} szt. · ${money(batch.finished_weight_kg||0)} kg`:'Do uzupełnienia przy przyjęciu'}</td><td>${V.esc(batch.yarn_lot||'—')}</td><td>${batch.finished_pieces} szt. · ${batch.finished_meters===null?'—':`${qty(batch.finished_meters)} mb`}</td><td>${removeForm}</td></tr>`;
  }).join('');
  const batchSection=batches.length?`<section class="panel padded finishing-order-batches"><div class="sectionhead"><h2>Zlecenia barwiarskie</h2><span>${batches.length} ${batches.length===1?'zlecenie':'zlecenia'}</span></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Rodzaj</th><th>Nr zlecenia</th><th>Status</th><th>Data wysyłki</th><th>Przypisana PM</th><th>LOT przędzy</th><th>Powrót</th><th></th></tr></thead><tbody>${batchRows}</tbody></table></div>${canAddBatch?`<form method="post" action="/finishing/orders/${id}/batches" class="finishing-add-batch-form">${hidden('csrf',ctx.req.session.csrf)}<button type="submit" class="finishing-add-spec-button" aria-label="Dodaj kolejne zlecenie barwiarskie" title="Dodaj kolejne zlecenie barwiarskie"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></form>`:''}</section>`:'';
  const incidentRows=incidents.map(incident=>`<li class="${incident.status==='open'?'finishing-incident-open':''}"><strong>${V.esc({lost:'Zagubiona belka',wrong_order:'Pomyłka w zamówieniu',correction:'Poprawa / zwrot',count_difference:'Różnica ilości',other:'Inne'}[incident.incident_type])}</strong> · ${V.datepl(incident.created_at)} · ${V.esc(incident.description)} <small>${V.esc(incident.author||'')}</small>${incident.status==='open'&&canEdit?`<form method="post" action="/finishing/incidents/${incident.id}/resolve">${hidden('csrf',ctx.req.session.csrf)}<input name="resolution" placeholder="Rozwiązanie / wyjaśnienie" maxlength="1000" required><button>Oznacz jako rozwiązane</button></form>`:incident.resolution?`<p>Rozwiązanie: ${V.esc(incident.resolution)}</p>`:''}</li>`).join('');
  const incidentForm=canEdit?`<form method="post" action="/finishing/orders/${id}/incidents" class="form-grid finishing-incident-form">${hidden('csrf',ctx.req.session.csrf)}<label>Rodzaj problemu<select name="incident_type"><option value="lost">Zagubiona belka</option><option value="wrong_order">Pomyłka w zamówieniu</option><option value="correction">Poprawa / zwrot</option><option value="count_difference">Różnica ilości</option><option value="other">Inne</option></select></label><label>Opis<input name="description" maxlength="1000" required></label><button class="button danger">Zapisz problem</button></form>`:'';
  const recipeBody=`<details class="panel padded"><summary>Receptura zapisana przy zleceniu</summary><p><strong>${V.esc(snapshot.name||'—')}</strong> · ${V.esc(snapshot.finishingPlant||order.finishing_plant_name||'')}</p><pre class="preline finishing-recipe-text">${V.esc(snapshot.recipeText||'')}</pre>${snapshot.notes?`<div class="preline finishing-recipe-card-notes">${recipeNotesHtml(snapshot.notes)}</div>`:''}</details>`;
  const orderNotes=order.notes?`<div class="finishing-order-notes-view"><strong>Uwagi dodatkowe:</strong><div class="finishing-recipe-card-notes">${recipeNotesHtml(order.notes)}</div></div>`:'';
  const cancel=canEdit&&!['received'].includes(order.status)?`<form method="post" action="/finishing/orders/${id}/cancel" class="finishing-inline-form">${hidden('csrf',ctx.req.session.csrf)}<button class="danger">Anuluj zlecenie</button></form>`:'';
  const editLink=editableRoles.includes(ctx.req.user.role)&&!['cancelled','raw_sale'].includes(order.status)?`<a class="button primary" href="/finishing/orders/${id}/edit">Edytuj dane i specyfikację</a>`:'';
  const deleteLink=order.status==='cancelled'&&editableRoles.includes(ctx.req.user.role)?`<a class="button danger" href="/finishing/orders/${id}/delete">Usuń anulowane zlecenie</a>`:'';
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">${statusBadge(order.status)} <span class="finishing-order-type-label">${V.esc(orderTypeLabel(order.order_type))}</span></span><h1>${V.esc(pm)} · ${V.esc(order.raw_symbol)}</h1><p class="muted">Data wysyłki: ${V.datepl(lotBatch?.sent_at||order.created_at)} · WZ ${V.esc(source)} · ${V.esc(order.client_name||'—')} · ${V.esc(order.trade_symbol||'—')} · ${V.esc(order.finishing_plant_name||'—')}</p>${orderNotes}</div><div class="actions">${editLink}${deleteLink}<a class="button" href="/finishing/orders/${id}/print" target="_blank">Drukuj zlecenie</a>${lotControl}${cancel}</div></div>${piecesBody}${recipeBody}${lotDialog}${batchSection}
    ${batches.length?`<div class="sectionhead"><h2>Przyjęcia z farbiarni</h2></div>${receiptViews}${receiptDialogs.join('')}`:`<div class="panel padded muted">Nie utworzono wyjścia do farbiarni.</div>`}
    <section class="panel padded finishing-incidents"><h2>Problemy i wyjaśnienia</h2>${incidentForm}<ul>${incidentRows||'<li>Nie zapisano problemów.</li>'}</ul></section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:pm,body});
}
function orderEditPage(ctx,order) {
  const id=order.id,db=ctx.db;
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const plants=db.prepare('SELECT id,name,active FROM finishing_plants ORDER BY active DESC,name COLLATE NOCASE').all();
  const plantOptions=plants.map(plant=>`<option value="${plant.id}"${Number(order.finishing_plant_id)===plant.id?' selected':''}>${V.esc(plant.name)}${plant.active?'':' (nieaktywna)'}</option>`).join('');
  const source=order.shipment_article_id?sourcePieces(db,order.shipment_article_id):[];
  const saved=db.prepare('SELECT id,bale_local_id,bale_number,production_date,machine,weight_kg,meters,lot FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(id);
  const pieces=new Map();
  for(const piece of source)pieces.set(piece.bale_local_id,{...piece,saved:false});
  for(const piece of saved)pieces.set(piece.bale_local_id,{...pieces.get(piece.bale_local_id),...piece,saved:true});
  const pieceRows=[...pieces.values()].map((piece,index)=>`<fieldset class="finishing-order-edit-bale"><legend>Belka ${V.esc(piece.bale_number||index+1)}</legend>
    <input type="hidden" name="bale_${index}_local_id" value="${V.esc(piece.bale_local_id)}"><label class="finishing-order-edit-bale-include"><input type="checkbox" name="bale_${index}_include" value="1"${piece.saved||saved.length===0?' checked':''}> Uwzględnij w zleceniu</label>
    <div class="form-grid"><label>Numer belki<input name="bale_${index}_number" value="${V.esc(piece.bale_number||'')}" maxlength="100"></label><label>Maszyna<input name="bale_${index}_machine" value="${V.esc(piece.machine||'')}" maxlength="100"></label><label>Data produkcji<input name="bale_${index}_date" type="date" value="${V.esc(piece.production_date||'')}"></label><label>Metry<input name="bale_${index}_meters" type="number" min="0.01" step="0.01" value="${V.esc(piece.meters??'')}"></label><label>Masa kg<input name="bale_${index}_weight" type="number" min="0.01" step="0.01" value="${V.esc(piece.weight_kg??'')}"></label><label>LOT przędzy<input name="bale_${index}_lot" value="${V.esc(piece.lot||'')}" maxlength="250"></label></div></fieldset>`).join('');
  const batches=orderBatches(db,id);
  const batchRows=batches.map((batch,index)=>`<fieldset class="finishing-order-edit-batch"><legend>Specyfikacja · #${batch.id}</legend><input type="hidden" name="batch_${index}_id" value="${batch.id}">
    <div class="form-grid"><label>Nr zlecenia<input name="batch_${index}_lot" value="${V.esc(batch.finishing_lot||'')}" maxlength="120"></label><label>Data wysyłki<input name="batch_${index}_date" type="date" value="${V.esc(batch.sent_at||'')}"></label>${Number(batch.sent_pieces)>0||Number(batch.raw_weight_kg)>0?`<label>Sztuki wysłane<input name="batch_${index}_pieces" type="number" min="0" step="1" value="${V.esc(batch.sent_pieces)}"></label><label>Masa wysłana kg<input name="batch_${index}_weight" type="number" min="0" step="0.01" value="${V.esc(batch.raw_weight_kg)}"></label>`:`<p class="muted finishing-batch-quantity-hint">Sztuki i kilogramy uzupełnisz przy przyjęciu.</p><input type="hidden" name="batch_${index}_pieces" value="0"><input type="hidden" name="batch_${index}_weight" value="0">`}<label>LOT przędzy<input name="batch_${index}_yarn_lot" value="${V.esc(batch.yarn_lot||'')}" maxlength="250"></label><label>Uwagi partii<input name="batch_${index}_notes" value="${V.esc(batch.notes||'')}" maxlength="3000"></label><label class="finishing-order-edit-bale-include"><input type="checkbox" name="batch_${index}_closed" value="1"${batch.closed_at?' checked':''}> Partia zamknięta</label></div></fieldset>`).join('');
  const pm=order.article_sequence?`PM ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:`PM ${order.source_shipment_no||'—'}`;
  const body=`${navTabs('orders',ctx.db)}<a class="breadcrumb" href="/finishing/orders/${id}">← Zlecenie ${V.esc(pm)}</a><div class="pagehead"><div><span class="eyebrow">EDYCJA ZLECENIA · ${statusBadge(order.status)}</span><h1>Edytuj zlecenie wykańczania</h1><p class="muted">Możesz poprawiać dane, partie i belki także po wpisaniu LOT-u lub przyjęciu. Zmiany belek dotyczą kopii zlecenia; zamknięta WZ pozostaje bez zmian.</p></div></div>
  <form method="post" action="/finishing/orders/${id}/edit" class="panel padded finishing-order-edit-form">${hidden('csrf',ctx.req.session.csrf)}
    <section class="finishing-order-section"><h2>Dane zlecenia</h2><div class="form-grid"><label>Symbol dzianiny<input name="raw_symbol" value="${V.esc(order.raw_symbol)}" maxlength="200" required></label><label>Symbol handlowy<input name="trade_symbol" value="${V.esc(order.trade_symbol||'')}" maxlength="200"></label><label>Klient<input name="client_name" value="${V.esc(order.client_name||'')}" maxlength="200"></label><label>Wykończalnia<select name="finishing_plant_id"><option value="">Dowolna</option>${plantOptions}</select></label><label>Kolor zadany<input name="target_color" value="${V.esc(order.target_color||'')}" maxlength="160"></label><label>Usztywnienie<input name="target_stiffening" value="${V.esc(order.target_stiffening||'')}" maxlength="2000"></label><label>Gramatura g/m²<input name="target_grammage" type="number" min="0.1" step="0.1" value="${V.esc(order.target_grammage??'')}"></label><label>Szerokość cm<input name="target_width_cm" type="number" min="0.1" step="0.1" value="${V.esc(order.target_width_cm??'')}"></label></div>${notesEditorField({label:'Uwagi do zlecenia',ariaLabel:'Uwagi do zlecenia',value:order.notes||''})}</section>
    <section class="finishing-order-section"><h2>Receptura zapisana przy zleceniu</h2><div class="form-grid"><label>Nazwa receptury<input name="recipe_name" value="${V.esc(snapshot.name||'')}" maxlength="200"></label><label>Receptura / instrukcja<textarea name="recipe_text" rows="8" maxlength="20000">${V.esc(snapshot.recipeText||'')}</textarea></label></div>${notesEditorField({name:'recipe_notes',label:'Uwagi receptury',ariaLabel:'Uwagi receptury',value:snapshot.notes||''})}</section>
    <section class="finishing-order-section"><h2>Specyfikacja i belki zlecenia</h2><p class="muted">Zaznacz belki uwzględnione w zleceniu i popraw ich dane. Zmiana nie modyfikuje zamkniętej specyfikacji WZ.</p>${pieceRows||'<p class="muted">Brak belek powiązanych z tą pozycją WZ.</p>'}<input type="hidden" name="bale_count" value="${pieces.size}"></section>
    <section class="finishing-order-section"><h2>Specyfikacje i partie wykańczalni</h2>${batchRows||'<p class="muted">Brak partii.</p>'}<input type="hidden" name="batch_count" value="${batches.length}"></section>
    <div class="actions"><a class="button" href="/finishing/orders/${id}">Wróć</a><button class="primary">Zapisz wszystkie zmiany</button></div>
  </form>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Edytuj ${pm}`,body});
}
function receiptsPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),query=q.length>=2?q.split(/\s+/).map(normalizeSearch).filter(Boolean):[];
  const db=ctx.db,all=Costing.settlementRows(db),year=String(ctx.url.searchParams.get('year')||''),month=String(ctx.url.searchParams.get('month')||''),from=String(ctx.url.searchParams.get('from')||''),to=String(ctx.url.searchParams.get('to')||'');
  const dateOf=row=>String(row.receipt_date||row.closed_at||row.sent_at||'').slice(0,10);
  const filtered=all.filter(({row})=>{
    const haystack=[row.raw_symbol,row.client_name,row.trade_symbol,row.source_shipment_no,row.finishing_lot,row.finishing_plant_name,String(row.order_id),String(row.batch_id),row.complaint_status].map(normalizeSearch).join(' '),date=dateOf(row);
    return query.every(token=>haystack.includes(token))&&(!year||date.startsWith(`${year}-`))&&(!month||date.slice(5,7)===month)&&(!from||date>=from)&&(!to||date<=to);
  });
  const latest=Costing.latestImport(db),groups=new Map(),years=[...new Set(all.map(({row})=>dateOf(row).slice(0,4)).filter(value=>/^\d{4}$/.test(value)))].sort((a,b)=>b.localeCompare(a));
  for(const item of filtered){const key=Number(item.row.order_id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  const statusBadgeFor=status=>status==='settled'?'<span class="badge approved">Rozliczona</span>':status==='changed'?'<span class="badge archived">Rozliczona – zmieniona</span>':status==='partial'?'<span class="badge submitted">Częściowo rozliczona</span>':'<span class="badge submitted">Do rozliczenia</span>';
  const groupRows=[];
  for(const [orderId,items] of groups){
    const first=items[0].row,pm=first.article_sequence?`PM ${articleNo({sequence:first.shipment_sequence},{sequence:first.article_sequence})}`:`PM ${first.source_shipment_no||'—'}`;
    const active=items.filter(item=>item.row.complaint_status!=='poprawiona'),settled=active.filter(item=>item.context?.settlement?.status==='settled').length,changed=active.some(item=>item.context?.settlement?.status==='changed');
    const parentStatus=changed?'changed':settled>0&&settled<active.length?'partial':active.length>0&&settled===active.length?'settled':'draft';
    groupRows.push(`<tr class="finishing-settlement-pm-row"><th colspan="10"><a class="finishing-order-pm" href="/finishing/orders/${orderId}">${V.esc(pm)}</a><span class="finishing-settlement-pm-status">${statusBadgeFor(parentStatus)}</span><span class="finishing-settlement-pm-symbols"><strong>${V.esc(first.raw_symbol||'—')}</strong>${first.trade_symbol?` · ${V.esc(first.trade_symbol)}`:''}</span></th></tr>`);
    for(const item of items){
      const row=item.row,c=item.context,settlement=c?.settlement,output=c?.output||{output_quantity:0,output_unit:'mb',receipt_count:0},price=c?.price;
      const replaced=row.complaint_status==='poprawiona',complained=row.complaint_status==='reklamowana',canSelect=!replaced&&!complained&&row.order_status!=='cancelled';
      const rawBasePrice=settlement?.raw_price_per_kg??price?.current_price??'',rawTheoretical=settlement?.theoretical_raw_price_per_kg??price?.theoretical_price??'';
      const basePrice=rawBasePrice===''?'':Number(rawBasePrice).toFixed(2),theoretical=rawTheoretical===''?'':Number(rawTheoretical).toFixed(2);
      const usedKg=settlement?.used_weight_kg??c?.usedWeight??row.raw_weight_kg??'',unit=output.output_unit||'mb',outQty=Costing.round2(output.output_quantity||0);
      const orderName=row.finishing_lot||`#${row.batch_id}`,state=complained?'<span class="badge archived">Reklamowana</span>':replaced?'<span class="badge approved">Poprawiona</span>':settlement?(settlement.status==='settled'?'<span class="badge approved">Rozliczona</span>':settlement.status==='changed'?'<span class="badge archived">Zmieniona</span>':'<span class="badge submitted">Robocza</span>'):'<span class="badge submitted">Do rozliczenia</span>';
      const history=Costing.comparableHistory(db,row.trade_symbol,settlement?.output_unit||unit,row.batch_id,1000),previous=history[0];
      const historyHtml=history.length?`<details class="finishing-cost-history"><summary>Historia (${history.length})</summary><div class="panel scroll"><table class="listing compact"><thead><tr><th>Data</th><th>PM</th><th>Zlecenie</th><th>Ilość</th><th>Rzeczywisty / jedn.</th><th>Teoretyczny / jedn.</th></tr></thead><tbody>${history.map(h=>{const hpm=h.article_sequence?`PM ${articleNo({sequence:h.shipment_sequence},{sequence:h.article_sequence})}`:`PM ${h.source_shipment_no||'—'}`;return `<tr><td>${V.datepl(h.approved_at)}</td><td>${V.esc(hpm)}</td><td>${V.esc(h.finishing_lot||`#${h.batch_id}`)}</td><td>${qty(h.output_quantity)} ${h.output_unit}</td><td>${money(h.actual_unit_cost)} zł/${h.output_unit}</td><td>${money(h.theoretical_unit_cost)} zł/${h.output_unit}</td></tr>`;}).join('')}</tbody></table></div></details>`:'<small class="muted">Brak wcześniejszych porównywalnych przyjęć.</small>';
      const importHint=price?'Excel':'Wpisz ręcznie',date=dateOf(row),calcActual=settlement?.actual_unit_cost??'',calcTheoretical=settlement?.theoretical_unit_cost??'',prevActual=previous?.actual_unit_cost??'',prevTheoretical=previous?.theoretical_unit_cost??'';
      const complaint=row.complaint_status==='reklamowana'?'<small class="finishing-subline">Reklamowana</small>':row.complaint_status==='poprawiona'?'<small class="finishing-subline">Poprawiona</small>':editableRoles.includes(ctx.req.user.role)?`<small class="finishing-subline"><a href="/finishing/orders/${row.order_id}#batch-${row.batch_id}">Reklamuj</a></small>`:'';
      groupRows.push(`<tr class="finishing-settlement-order-row${replaced?' is-replaced':''}" data-settlement-row data-output-quantity="${outQty}" data-output-unit="${unit}" data-previous-actual="${V.esc(prevActual)}" data-previous-theoretical="${V.esc(prevTheoretical)}"><td><input form="finishing-settlement-form" type="checkbox" data-finishing-settlement-select value="${row.batch_id}" aria-label="Wybierz zlecenie ${V.esc(orderName)}"${canSelect?'':' disabled'}></td><td>${V.datepl(date)}<small class="finishing-subline">${V.esc(row.finishing_plant_name||'—')}</small></td><td><strong>${V.esc(orderName)}</strong>${row.correction_of_batch_id?'<small class="finishing-subline">Poprawkowe</small>':''}<small class="finishing-subline">${state}</small>${complaint}</td><td class="finishing-output"><strong>${outQty>0?`${qty(outQty)} ${unit}`:'—'}</strong><small>${Number(output.finished_pieces||0)} szt.</small></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="used_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(usedKg)}" aria-label="Wykorzystane kg · ${V.esc(orderName)}"${row.correction_of_batch_id?' readonly':''}></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="price_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(basePrice)}" aria-label="Cena surowca · ${V.esc(orderName)}"><small class="finishing-subline">${V.esc(price?.current_error||importHint)}</small></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="theoretical_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(theoretical)}" aria-label="Cena teoretyczna · ${V.esc(orderName)}"><small class="finishing-subline">${V.esc(price?.theoretical_error||importHint)}</small></td><td><input form="finishing-settlement-form" class="finishing-cost-input" name="finishing_${row.batch_id}" type="number" min="0" step="0.01" value="${V.esc(settlement?.finishing_cost??'')}" aria-label="Koszt wykończenia zł/kg · ${V.esc(orderName)}"></td><td><input form="finishing-settlement-form" class="finishing-cost-input finishing-invoice-input" name="invoice_${row.batch_id}" maxlength="120" value="${V.esc(settlement?.invoice_note||'')}" aria-label="Faktura — notatka · ${V.esc(orderName)}" placeholder="Notatka"></td><td class="finishing-live-cost" data-live-cost><strong data-live-actual>${calcActual!==''?`${money(calcActual)} zł/${settlement.output_unit}`:'—'}</strong><small data-live-theoretical>${calcTheoretical!==''?`Teoria ${money(calcTheoretical)} zł/${settlement.output_unit}`:''}</small><small data-live-delta>${previous&&calcActual!==''?`Różnica: ${money(Number(calcActual)-Number(prevActual))} zł/${unit}`:''}</small>${historyHtml}</td></tr>`);
    }
  }
  const latestDate=latest?.calculation_date||'2026-09-22',dateLabel=new Intl.DateTimeFormat('pl-PL',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Warsaw'}).format(new Date(`${latestDate}T12:00:00Z`)),canImport=['admin','approver'].includes(ctx.req.user.role);
  const uploadDialog=canImport?`<button type="button" class="button finishing-load-calculation" data-open-dialog="finishing-calculation-dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>Załaduj kalkulację</button><dialog id="finishing-calculation-dialog" class="form-dialog finishing-calculation-dialog"><div class="dialog-head"><strong>Załaduj kalkulację kosztów surowca</strong><button type="button" class="dialog-close" data-close-dialog aria-label="Zamknij">×</button></div><div class="dialog-body"><p class="finishing-current-calculation">${latest?`Aktualna kalkulacja · plik ${V.esc(latest.source_name)} · obliczona na ${V.esc(dateLabel)} · ${latest.item_count} symboli`:'Nie wczytano jeszcze kalkulacji.'}</p><form data-finishing-calculation-upload data-csrf="${V.esc(ctx.req.session.csrf)}"><label>Plik kalkulacji Excel (.xlsx)<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-finishing-calculation-file required></label><label>Data kalkulacji z pliku<input type="date" name="calculation_date" value="${V.esc(latestDate)}" required></label><button class="primary" data-finishing-calculation-upload-button>Wczytaj plik</button><span class="muted" data-finishing-calculation-upload-status aria-live="polite"></span></form><small class="muted">Dopasowanie cen następuje po symbolu surowca.</small></div></dialog>`:'';
  const monthOptions=Array.from({length:12},(_,index)=>{const value=String(index+1).padStart(2,'0');return `<option value="${value}"${month===value?' selected':''}>${new Intl.DateTimeFormat('pl-PL',{month:'long'}).format(new Date(2026,index,1))}</option>`;}).join('');
  const filterForm=`<form method="get" action="/finishing/receipts" class="shipment-list-filters finishing-settlement-filters" data-live-search data-live-search-min="2"><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Wpisz co najmniej 2 znaki"></label><label>Rok<select name="year"><option value="">Wszystkie</option>${years.map(value=>`<option value="${value}"${year===value?' selected':''}>${value}</option>`).join('')}</select></label><label>Miesiąc<select name="month"><option value="">Wszystkie</option>${monthOptions}</select></label><label>Od<input type="date" name="from" value="${V.esc(from)}"></label><label>Do<input type="date" name="to" value="${V.esc(to)}"></label></form>`;
  const body=`${navTabs('receipts',db)}<div class="pagehead finishing-settlement-head"><div><span class="eyebrow">WYKAŃCZANIE</span><div class="finishing-settlement-title"><h1>Przyjęcia i rozliczenia</h1>${uploadDialog}</div></div></div>${filterForm}<div data-live-results><div class="panel scroll"><table class="listing compact finishing-receipts-list finishing-settlements-list"><thead><tr><th><input type="checkbox" form="finishing-settlement-form" data-finishing-settlement-all aria-label="Zaznacz widoczne zlecenia"></th><th>Przyjęto</th><th>Zlecenie barwiarskie</th><th>Odebrane</th><th>Wykorzystane kg</th><th>Surowiec zł/kg</th><th>Teoria zł/kg</th><th>Wykończenie zł/kg</th><th>Faktura · notatka</th><th>Wynik / historia</th></tr></thead><tbody>${groupRows.join('')||'<tr><td colspan="10">Brak przyjętych zleceń dla wybranych filtrów.</td></tr>'}</tbody></table></div><form id="finishing-settlement-form" method="post" action="/finishing/settlements/save" data-finishing-settlement-form>${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="batch_ids" value="" data-finishing-settlement-ids><div class="actions finishing-settlement-actions"><button class="button" name="settlement_action" value="save">Zapisz roboczo</button><button class="primary" name="settlement_action" value="approve">Zatwierdź rozliczenie</button><button class="button" formaction="/finishing/settlements/report" name="settlement_action" value="report">Raport do Subiekta</button><button class="button danger" formaction="/finishing/settlements/revert" name="settlement_action" value="revert">Cofnij rozliczenie</button><span class="muted" data-finishing-settlement-selection>Wybierz zlecenia barwiarskie.</span></div></form></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Przyjęcie towaru',body});
}
function lostPage(ctx) {
  const canManage=editableRoles.includes(ctx.req.user.role);
  const rows=ctx.db.prepare(`SELECT i.*,b.finishing_lot,b.sent_at,o.created_at order_created_at,o.source_shipment_no,
      s.shipment_year,s.sequence shipment_sequence,sa.sequence article_sequence
    FROM finishing_incidents i JOIN finishing_batches b ON b.id=i.batch_id JOIN finishing_orders o ON o.id=i.order_id
    LEFT JOIN shipment_articles sa ON sa.id=o.shipment_article_id LEFT JOIN shipments s ON s.id=sa.shipment_id
    WHERE i.auto_generated=1 AND i.incident_type='lost' ORDER BY i.created_at DESC,i.id DESC`).all();
  const pm=row=>row.article_sequence?`PM ${articleNo({sequence:row.shipment_sequence},{sequence:row.article_sequence})}`:`PM ${row.source_shipment_no||'—'}`;
  const rowsHtml=rows.map(row=>{
    const action=(kind,label,doneAt)=>doneAt?`<span class="badge approved">${label}</span>`:canManage?`<form method="post" action="/finishing/lost/${row.id}/${kind}">${hidden('csrf',ctx.req.session.csrf)}<button class="button${kind==='found'?'':' primary'}">${label}</button></form>`:'<span class="muted">Oczekuje</span>';
    return `<tr><td>${row.lost_pieces} szt.</td><td>${money(row.lost_weight_kg)} kg</td><td><a class="finishing-order-pm" href="/finishing/orders/${row.order_id}">${V.esc(pm(row))}</a></td><td>${V.esc(row.finishing_lot||'—')}</td><td>${V.datepl(row.order_created_at)}</td><td>${V.datepl(row.created_at)}</td><td class="finishing-lost-actions">${action('found','Odnaleziona',row.found_at)}${action('settle','Rozliczona z wykańczalnią',row.settled_at)}</td></tr>`;
  }).join('');
  const body=`${navTabs('lost',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Zagubione/zniszczone</h1><p class="muted">Braki są dopisywane automatycznie po zamknięciu przyjęcia partii.</p></div></div><div class="panel scroll"><table class="listing compact finishing-lost-list"><thead><tr><th>Brak</th><th>Masa</th><th>PM</th><th>Nr zlecenia</th><th>Data zlecenia</th><th>Data przyjęcia</th><th>Akcje</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="7">Brak zagubionych lub zniszczonych sztuk.</td></tr>'}</tbody></table></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Zagubione/zniszczone',body});
}
function recipeForm(ctx,recipe=null,initialRawSymbol='',returnToOrder=false) {
  const plantList=plants(ctx.db),rawArticles=ctx.db.prepare("SELECT DISTINCT a.symbol,r.payload FROM articles a LEFT JOIN records r ON r.id=a.active_spec WHERE trim(a.symbol)<>'' ORDER BY a.symbol COLLATE NOCASE").all().map(article=>{
    let payload={};try{payload=JSON.parse(article.payload||'{}')}catch{}
    return {symbol:article.symbol,composition:V.yarnComposition(Array.isArray(payload.gb)?payload.gb:[])};
  }),r=recipe||{raw_symbol:initialRawSymbol},d=readRecipeDetails(recipe);
  if(recipe&&!Object.keys(d).length&&r.target_stiffening){d.stiffeningEnabled='yes';d.stiffeningDescription=r.target_stiffening;}
  const yesNo=(name,label,selected='')=>`<label class="finishing-check-option">${hidden(name,'no')}<input type="checkbox" name="${name}" value="yes"${selected==='yes'?' checked':''}><span>${label}</span></label>`;
  const input=(label,name,val='',attrs='')=>`<label>${label}<input name="${name}" value="${V.esc(val??'')}" ${attrs}></label>`;
  const area=(label,name,val='',rows=3,hint='')=>`<label>${label}${hint?`<small class="muted">${hint}</small>`:''}<textarea name="${name}" rows="${rows}">${V.esc(val||'')}</textarea></label>`;
  const legacyNotes=Object.keys(d).length?(r.notes||''):[r.recipe_text,r.notes].filter(Boolean).join('\n');
  const tolerance=(label,plusName,minusName,detailsPlus,detailsMinus,unit)=>`<fieldset class="finishing-tolerance"><legend>Tolerancja ${unit}</legend><label><span>+</span><input aria-label="Tolerancja plus ${label}" name="${plusName}" value="${V.esc(detailsPlus??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label><label><span>−</span><input aria-label="Tolerancja minus ${label}" name="${minusName}" value="${V.esc(detailsMinus??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label></fieldset>`;
  const winding=(d.winding||[]).filter(Boolean).join('\n');
  const recipeNotesValue=JSON.stringify(recipeNotesData(legacyNotes));
  const recipeNotesSizes=RECIPE_NOTES_SIZES.map(size=>`<option value="${size}"${size===16?' selected':''}>${size} px</option>`).join('');
  const copySources=recipe?[]:recipes(ctx.db).map(source=>{
    const sourceDetails=readRecipeDetails(source),notes=Object.keys(sourceDetails).length?(source.notes||''):[source.recipe_text,source.notes].filter(Boolean).join('\n');
    return {label:`${source.name} · ${source.raw_symbol||'bez symbolu'} · #${source.id}`,values:{raw_symbol:source.raw_symbol||'',trade_symbol:sourceDetails.tradeSymbol||'',raw_material:sourceDetails.rawMaterial||'',target_color:source.target_color||'',finishing_plant_id:source.finishing_plant_id||'',target_grammage:source.target_grammage??'',target_grammage_plus:sourceDetails.grammagePlus??'',target_grammage_minus:sourceDetails.grammageMinus??'',target_width_cm:source.target_width_cm??'',target_width_plus:sourceDetails.widthPlus??'',target_width_minus:sourceDetails.widthMinus??'',width_between_needles:sourceDetails.widthMode==='needles',brushing:sourceDetails.brushing==='yes',brushing_for_velcro:sourceDetails.brushingForVelcro==='yes',stiffening_enabled:sourceDetails.stiffeningEnabled==='yes',stiffening_description:sourceDetails.stiffeningDescription||'',softening_enabled:sourceDetails.softeningEnabled==='yes',softening_description:sourceDetails.softeningDescription||'',trim_edges:sourceDetails.trimEdges==='yes',bond_edges:sourceDetails.bondEdges==='yes',trim_sygnits:sourceDetails.trimSygnits==='yes',winding:(sourceDetails.winding||[]).filter(Boolean).join('\n'),shrinkage:sourceDetails.shrinkage||'',notes}};
  });
  const copyData=JSON.stringify(copySources).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  const copyControls=!recipe?`<div class="finishing-recipe-copy"><label>Kopiuj parametry receptury<input type="search" list="finishing-recipe-copy-options" placeholder="Wyszukaj recepturę…" autocomplete="off" data-finishing-recipe-copy-search></label><datalist id="finishing-recipe-copy-options">${copySources.map(source=>`<option value="${V.esc(source.label)}"></option>`).join('')}</datalist><button type="button" data-finishing-recipe-copy-button disabled>Kopiuj</button><small class="muted" data-finishing-recipe-copy-status>${copySources.length?'':'Brak receptur do skopiowania.'}</small><script type="application/json" data-finishing-recipe-copy-data>${copyData}</script></div>`:'';
  const compositionMap=JSON.stringify(Object.fromEntries(rawArticles.filter(article=>article.composition!=='—').map(article=>[article.symbol,article.composition]))).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  return `<form method="post" action="${recipe?`/finishing/recipes/${recipe.id}`:'/finishing/recipes'}" class="finishing-recipe-form">${hidden('csrf',ctx.req.session.csrf)}${returnToOrder?hidden('return_to_order','1'):''}
    <script type="application/json" data-article-composition-map>${compositionMap}</script>
    <section class="finishing-recipe-section finishing-recipe-identity"><div class="finishing-recipe-top-row${recipe?' is-editing':''}"><div class="finishing-recipe-primary"><label for="recipe-name">Nazwa receptury</label><input id="recipe-name" name="name" value="${V.esc(r.name||'')}" maxlength="200" placeholder="Wpisz nazwę receptury" required autofocus></div>${copyControls}</div><div><h2>Identyfikacja dzianiny</h2><div class="finishing-recipe-identity-grid"><label>Symbol dzianiny surowej<input name="raw_symbol" value="${V.esc(r.raw_symbol||'')}" list="finishing-recipe-articles" maxlength="200" required data-article-symbol><datalist id="finishing-recipe-articles">${rawArticles.map(article=>`<option value="${V.esc(article.symbol)}"></option>`).join('')}</datalist></label>${input('Symbol handlowy','trade_symbol',d.tradeSymbol,'maxlength="200"')}<label>Surowiec / skład procentowy<input name="raw_material" value="${V.esc(d.rawMaterial||'')}" maxlength="1000" data-article-composition><small class="muted">Po wybraniu symbolu skład jest pobierany z aktualnej karty technicznej artykułu.</small></label>${input('Kolor / oznaczenie z farbiarni','target_color',r.target_color,'maxlength="160"')}<label>Domyślna wykończalnia<select name="finishing_plant_id"><option value="">Dowolna</option>${plantList.map(plant=>`<option value="${plant.id}"${Number(r.finishing_plant_id)===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label>${yesNo('trial_recipe','Receptura próbna',d.trialRecipe)}</div></div></section>
    <div class="finishing-recipe-technical-row"><section class="finishing-recipe-section"><h2>Parametry oczekiwane</h2><div class="finishing-measurement-row"><label class="finishing-measurement-value"><span>Gramatura g/m²</span><input name="target_grammage" value="${V.esc(r.target_grammage??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label>${tolerance('gramatury','target_grammage_plus','target_grammage_minus',d.grammagePlus,d.grammageMinus,'g/m²')}</div><div class="finishing-measurement-row"><label class="finishing-measurement-value"><span>Szerokość cm</span><input name="target_width_cm" value="${V.esc(r.target_width_cm??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label>${tolerance('szerokości','target_width_plus','target_width_minus',d.widthPlus,d.widthMinus,'cm')}<label class="finishing-check-option finishing-width-needles">${hidden('width_between_needles','no')}<input type="checkbox" name="width_between_needles" value="yes"${d.widthMode==='needles'?' checked':''}><span>Szerokość między igłami</span></label></div>${area('Kurczliwości','shrinkage',d.shrinkage,1)}</section>
    <section class="finishing-recipe-section finishing-recipe-processing"><h2>Uszlachetnianie i obróbka</h2><div class="finishing-process-top-options">${yesNo('brushing','Drapanie',d.brushing)}${yesNo('brushing_for_velcro','Drapanie pod rzep',d.brushingForVelcro)}</div><div class="finishing-process-grid"><div class="finishing-process-described">${yesNo('stiffening_enabled','Usztywnienie',d.stiffeningEnabled)}${input('Opis procesu','stiffening_description',d.stiffeningDescription,'maxlength="2000"')}</div><div class="finishing-process-described">${yesNo('softening_enabled','Zmiękczenie',d.softeningEnabled)}${input('Opis procesu','softening_description',d.softeningDescription,'maxlength="2000"')}</div>${yesNo('trim_edges','Obcinanie brzegów',d.trimEdges)}${yesNo('bond_edges','Podklejanie brzegów',d.bondEdges)}${yesNo('trim_sygnits','Obcinanie sygnitów',d.trimSygnits)}</div></section></div>
    <section class="finishing-recipe-section"><h2>Nawijanie</h2><label>Instrukcje nawijania<textarea class="finishing-winding-input" name="winding_1" rows="3" maxlength="1000">${V.esc(winding)}</textarea></label></section>
    <section class="finishing-recipe-section"><h2>Uwagi dodatkowe</h2><div class="finishing-notes-editor-label"><span class="finishing-notes-field-label">Dodatkowe informacje</span><div class="finishing-notes-editor" data-finishing-notes-editor><div class="finishing-notes-toolbar" role="toolbar" aria-label="Formatowanie uwag"><button type="button" data-finishing-notes-bold aria-pressed="false" title="Włącz lub wyłącz pogrubienie"><strong>B</strong></button><button type="button" data-finishing-notes-underline aria-pressed="false" title="Włącz lub wyłącz podkreślenie"><u>U</u></button><button type="button" data-finishing-notes-italic aria-pressed="false" title="Włącz lub wyłącz kursywę"><em>I</em></button><label>Rozmiar<select data-finishing-notes-size>${recipeNotesSizes}</select></label><span class="muted small">Kliknij formatowanie, aby pisać z nim dalej; zaznacz tekst, aby zmienić istniejący.</span></div><div class="finishing-notes-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Uwagi dodatkowe receptury" data-finishing-notes-content>${recipeNotesEditorHtml(legacyNotes)}</div><input type="hidden" name="notes" value="${V.esc(recipeNotesValue)}" data-finishing-notes-value></div><small class="muted">Każda linia zostanie zachowana osobno na wydruku.</small></div></section>
    <div class="finishing-form-actions"><button class="primary">${recipe?'Zapisz zmiany':'Dodaj recepturę'}</button></div></form>`;
}
function recipesPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),plantId=Number(ctx.url.searchParams.get('plant_id')||0),allRecipes=recipes(ctx.db);
  const returnToOrderContext=ctx.url.searchParams.get('return_to_order')==='1';
  const qNorm=normalizeSearch(q);
  const matches=allRecipes.filter(recipe=>{
    const details=readRecipeDetails(recipe),tradeSymbol=details.tradeSymbol,fields=[recipe.name,recipe.raw_symbol,tradeSymbol,recipe.recipe_text,recipe.target_color,details.rawMaterial].map(normalizeSearch),terms=q.split(/\s+/).map(normalizeSearch).filter(Boolean);
    return (!plantId||recipe.finishing_plant_id===plantId)&&terms.every(term=>fields.some(field=>field.includes(term)));
  });
  if(ctx.url.searchParams.get('partial')==='search') {
    if(!qNorm)return '';
    const options=matches.map(recipe=>`<a id="finishing-recipe-option-${recipe.id}" role="option" aria-selected="false" href="/finishing/recipes/${recipe.id}" class="warehouse-article-option finishing-recipe-option"><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Bez symbolu')}${readRecipeDetails(recipe).tradeSymbol?` · ${V.esc(readRecipeDetails(recipe).tradeSymbol)}`:''}</span></a>`).join('');
    return options?`<div class="warehouse-search-results finishing-recipe-search-results" role="listbox" aria-label="Pasujące receptury">${options}</div>`:'';
  }
  const rows=matches.map(recipe=>{const d=readRecipeDetails(recipe),preview=recipeTextFor(recipe),searchText=[recipe.name,recipe.raw_symbol,d.tradeSymbol,recipe.recipe_text,recipe.target_color,d.rawMaterial].filter(Boolean).join(' ');return `<article class="finishing-recipe-row" data-finishing-recipe-row data-recipe-search="${V.esc(searchText)}"><div class="finishing-recipe-row-heading"><a class="finishing-recipe-row-name" href="/finishing/recipes/${recipe.id}"><strong>${V.esc(recipe.name)}</strong></a>${d.trialRecipe==='yes'?'<span class="badge finishing-trial-badge">Próba</span>':''}${preview?`<details class="finishing-recipe-preview"><summary>Podgląd wykończenia</summary><pre>${V.esc(preview)}</pre></details>`:''}</div><div class="finishing-recipe-row-symbols"><strong>${V.esc(recipe.raw_symbol||'Bez symbolu')}</strong>${d.tradeSymbol?`<span>Symbol handlowy: <strong>${V.esc(d.tradeSymbol)}</strong></span>`:''}<span>${V.esc(recipe.finishing_plant_name||'Dowolna wykończalnia')}</span></div>${editableRoles.includes(ctx.req.user.role)?`<div class="finishing-recipe-row-actions"><a class="button finishing-recipe-icon-action" href="/finishing/recipes/${recipe.id}/edit${returnToOrderContext?'?return_to_order=1':''}"${returnToOrderContext?' target="_blank" rel="noopener"':''} aria-label="Edytuj recepturę ${V.esc(recipe.name)}" title="Edytuj recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20Z"/></svg></a><a class="button danger finishing-recipe-icon-action" href="/finishing/recipes/${recipe.id}/delete" aria-label="Usuń recepturę ${V.esc(recipe.name)}" title="Usuń recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></a></div>`:''}</article>`;}).join('');
  const updatedRecipeId=ctx.url.searchParams.get('updated_recipe_id'),returningToOrder=returnToOrderContext&&/^\d+$/.test(updatedRecipeId||'');
  let returnRecipeHtml='';
  if(returningToOrder){const recipe=recipeRecord(ctx.db,Number(updatedRecipeId));if(recipe){const details=readRecipeDetails(recipe),payload={id:recipe.id,name:recipe.name,rawSymbol:recipe.raw_symbol||'',tradeSymbol:details.tradeSymbol||'',recipeText:recipeTextFor(recipe),plant:recipe.finishing_plant_id||'',color:recipe.target_color||'',stiffening:recipe.target_stiffening||'',width:recipe.target_width_cm??'',grammage:recipe.target_grammage??''},json=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');returnRecipeHtml=`<div hidden data-return-recipe-to-order>${json}</div>`;}}
  const body=`${returnRecipeHtml}${navTabs('recipes',ctx.db)}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Biblioteka receptur wykańczania</h1><p class="muted">Receptury są przechowywane w bazie danych. Zlecenie zapisuje własną kopię wybranej receptury.</p></div>${editableRoles.includes(ctx.req.user.role)?'<a class="button primary" href="/finishing/recipes/new">+ Dodaj recepturę</a>':''}</div><form method="get" action="/finishing/recipes" class="shipment-list-filters" data-shipment-live-search><div class="shipment-list-search finishing-recipe-search-field"><label for="finishing-recipe-search">Szukaj</label><input id="finishing-recipe-search" type="search" name="q" value="${V.esc(q)}" placeholder="Nazwa receptury, symbol dzianiny lub handlowy" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="finishing-recipe-search-results"><div id="finishing-recipe-search-results" class="warehouse-search-results-wrap" data-shipment-search-results></div></div><label>Wykończalnia<select name="plant_id"><option value="0">Wszystkie</option>${plants(ctx.db).map(plant=>`<option value="${plant.id}"${plantId===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><a class="button" href="/finishing/recipes">Wyczyść</a></form><section data-finishing-recipe-library><div data-finishing-recipe-list>${rows}</div><div class="panel padded" data-finishing-recipe-empty${rows?' hidden':''}>${allRecipes.length?'Brak receptur dla podanych kryteriów.':'Brak aktywnych receptur. Dodaj je ręcznie lub zaimportuj dane testowe.'}</div></section>`;
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
  const detailsHtml=`<section id="recipe-identification" class="finishing-recipe-card-section"><h2>Identyfikacja dzianiny</h2>${d.trialRecipe==='yes'?'<span class="badge finishing-trial-badge">Receptura próbna</span>':''}<dl class="finishing-recipe-card-grid">${show('Symbol dzianiny surowej',recipe.raw_symbol)}${show('Symbol handlowy',d.tradeSymbol)}${show('Surowiec / skład',d.rawMaterial)}${show('Kolor / oznaczenie farbiarni',recipe.target_color)}${show('Domyślna wykończalnia',recipe.finishing_plant_name||'Dowolna')}</dl></section>
    <section class="finishing-recipe-card-section"><h2>Parametry oczekiwane</h2><dl class="finishing-recipe-card-grid">${show('Gramatura',recipe.target_grammage!==null&&recipe.target_grammage!==undefined?`${numberText(recipe.target_grammage)} g/m²${tolerance(d.grammagePlus,d.grammageMinus)}`:'')}${show('Szerokość',widthValue?`${widthValue}${tolerance(d.widthPlus,d.widthMinus)}`:'')}${show('Kurczliwości',d.shrinkage)}</dl></section>
    <section class="finishing-recipe-card-section"><h2>Uszlachetnianie i obróbka</h2>${operationHtml?`<dl class="finishing-recipe-card-grid">${operationHtml}</dl>`:'<p class="muted">Brak wskazanych operacji.</p>'}</section>
    ${!Object.keys(d).length&&recipe.recipe_text?`<section class="finishing-recipe-card-section"><h2>Parametry zapisane w starszym formacie</h2><div class="preline finishing-recipe-card-notes">${e(recipe.recipe_text)}</div></section>`:''}
    ${(d.winding||[]).some(Boolean)?`<section class="finishing-recipe-card-section"><h2>Instrukcje nawijania</h2><ol class="finishing-recipe-card-winding">${d.winding.filter(Boolean).map(line=>`<li><strong>${e(line)}</strong></li>`).join('')}</ol></section>`:''}
    ${recipe.notes?`<section class="finishing-recipe-card-section"><h2>Uwagi dodatkowe</h2><div class="finishing-recipe-card-notes">${recipeNotesHtml(recipe.notes)}</div></section>`:''}`;
  const history=ctx.db.prepare(`SELECT o.id order_id,o.source_shipment_no,o.source_shipment_date,fp.name finishing_plant_name,
      b.finishing_lot,r.id receipt_id,r.received_at,r.finished_pieces,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb WHERE rb.receipt_id=r.id AND rb.weight_kg IS NOT NULL) THEN r.finished_weight_kg ELSE NULL END finished_weight_kg,
      r.finished_meters,r.actual_color,r.actual_stiffening,r.color_status,r.stiffening_status,r.actual_width_cm,r.actual_grammage,r.rubbing_status,r.notes,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id)
        THEN (SELECT round(sum(rb.meters),2) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id) ELSE r.finished_meters END actual_meters
    FROM finishing_orders o JOIN finishing_batches b ON b.order_id=o.id JOIN finishing_receipts r ON r.batch_id=b.id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id WHERE o.recipe_id=?
    ORDER BY r.received_at DESC,r.id DESC`).all(id);
  const historyHtml=history.map(item=>`<article class="finishing-recipe-history-item"><header><strong>${e(V.datepl(item.received_at))}</strong><span>Zlecenie #${item.order_id}${item.source_shipment_no?` · WZ ${e(item.source_shipment_no)}`:''}</span><span>${e(item.finishing_plant_name||'Bez przypisanej wykończalni')}${item.finishing_lot?` · LOT ${e(item.finishing_lot)}`:''}</span></header><dl class="finishing-recipe-card-grid">${show('Kolor uzyskany',item.actual_color)}${show('Ocena koloru',item.color_status==='ok'?'OK':item.color_status==='not_ok'?'NOK':'')}${show('Usztywnienie uzyskane',item.actual_stiffening)}${show('Ocena usztywnienia',item.stiffening_status==='ok'?'OK':item.stiffening_status==='not_ok'?'NOK':'')}${show('Szerokość uzyskana',item.actual_width_cm!==null?`${numberText(item.actual_width_cm)} cm`:'')}${show('Gramatura uzyskana',item.actual_grammage!==null?`${numberText(item.actual_grammage)} g/m²`:'')}${show('Odebrane belki',`${item.finished_pieces} szt.`)}${show('Metry',item.actual_meters!==null&&item.actual_meters!==undefined?`${numberText(item.actual_meters)} m`:'')}${show('Masa',item.finished_weight_kg!==null&&item.finished_weight_kg!==undefined?`${numberText(item.finished_weight_kg)} kg`:'')}${show('Wydrapanie',item.rubbing_status==='ok'?'OK':item.rubbing_status==='not_ok'?'NOK':'')}${show('Komentarz do partii',item.notes)}</dl></article>`).join('');
  const actions=editableRoles.includes(ctx.req.user.role)?`<div class="actions"><a class="button primary" href="/finishing/recipes/${recipe.id}/edit">Edytuj recepturę</a><a class="button danger" href="/finishing/recipes/${recipe.id}/delete">Usuń</a></div>`:'';
  const body=`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><div class="pagehead"><div><span class="eyebrow">KARTA RECEPTURY</span><h1>${e(recipe.name)}${d.trialRecipe==='yes'?' <span class="badge finishing-trial-badge">Próba</span>':''}</h1><p class="muted"><strong>${e(recipe.raw_symbol||'Bez symbolu dzianiny')}</strong>${d.tradeSymbol?` · ${e(d.tradeSymbol)}`:''}</p></div>${actions}</div><div class="finishing-recipe-card">${detailsHtml}<section class="finishing-recipe-card-section finishing-recipe-history"><h2>Historia wykonań</h2>${historyHtml||'<p class="muted">Brak zarejestrowanych przyjęć z wykończalni dla tej receptury.</p>'}</section></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:recipe.name,body});
}
function recipeDeleteConfirmPage(ctx,recipe) {
  const cancelUrl=`/finishing/recipes/${recipe.id}`;
  const body=`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="${cancelUrl}">← ${V.esc(recipe.name)}</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Usuń recepturę</h1></div></div><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Usunąć recepturę z aktywnej biblioteki?</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrana receptura:</p><h2 class="delete-confirm-object">${V.esc(recipe.name)} · ${V.esc(recipe.raw_symbol||'Bez symbolu')}</h2><div class="shipment-cancel-details"><div class="shipment-cancel-detail-row"><strong>Dostępność</strong><span>Receptura zniknie z biblioteki i nie będzie dostępna przy tworzeniu nowych zleceń.</span></div><div class="shipment-cancel-detail-row"><strong>Historia</strong><span>Powiązane zlecenia, przyjęcia i wyniki wykończeń pozostaną zachowane.</span></div></div><form method="post" action="/finishing/recipes/${recipe.id}/delete" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_recipe','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Usuń recepturę z biblioteki</button></form></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Usuń recepturę',body});
}
function receiptPage(ctx,id) {
  const order=orderRecord(ctx.db,id);if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const pm=order.shipment_sequence?`PM ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:'PM —';
  let sourceBales=ctx.db.prepare(`SELECT f.bale_number,f.machine,f.production_date,f.weight_kg,f.meters,f.lot,
      coalesce(p.errors,0) errors,coalesce(p.stops,0) stops,coalesce(p.notes,'') notes
    FROM finishing_order_bales f LEFT JOIN production_bales p ON p.local_id=f.bale_local_id WHERE f.order_id=? ORDER BY f.id`).all(id);
  if(!sourceBales.length&&order.shipment_article_id)sourceBales=sourcePieces(ctx.db,order.shipment_article_id);
  const totalWeight=sourceBales.reduce((sum,bale)=>sum+Number(bale.weight_kg||0),0);
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
  const recipeParameters=`${rawMaterial?`<div class="recipe-param"><small>Surowiec</small><strong class="raw-material">${V.esc(rawMaterial)}</strong></div>`:''}${recipeParameterRows.map(item=>`<div class="recipe-param${item.label?'':' recipe-param-wide'}">${item.label?`<small>${V.esc(item.label)}</small>`:''}<strong>${V.esc(item.value)}</strong></div>`).join('')}`;
  const recipeNotesPrint=snapshot.notes?`<section class="recipe-notes"><strong class="notes-label">Informacje dodatkowe</strong><div>${recipeNotesHtml(snapshot.notes)}</div></section>`:'';
  const orderNotes=order.notes?`<section class="order-notes"><strong class="notes-label">Uwagi</strong><div>${recipeNotesHtml(order.notes)}</div></section>`:'';
  const html=`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zlecenie farbiarskie · ${V.esc(pm)}</title><script defer src="/static/app.js"></script><link rel="stylesheet" href="/static/finishing-order-print.css"><style>
    .raw-sale-banner{margin:8px 0;padding:6px 9px;border:2px solid #222;text-align:center;font-size:12pt;font-weight:700;letter-spacing:.08em}
    @page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{font:9.5pt/1.35 Arial,sans-serif;color:#111;margin:0}.toolbar{display:flex;justify-content:flex-end;margin:0 0 12px}.sheet{max-width:194mm;margin:auto}.head{display:grid;grid-template-columns:1fr 0.9fr;gap:12mm;align-items:stretch;border-bottom:2px solid #222;padding-bottom:7px}.head-title{align-self:center}.head h1{font-size:17pt;line-height:1.15;margin:0}.brand{margin-top:3px;font-size:8pt;letter-spacing:.08em;font-weight:700;color:#444}.brand span{font-weight:400;letter-spacing:0;margin-left:4px}.head-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.blank-field{border:1px solid #888;min-height:18mm;padding:5px;font-size:8pt;color:#333}.blank-line{display:block;border-bottom:1px solid #555;height:8mm;margin-top:2mm}.meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin:8px 0}.field{border-bottom:1px solid #aaa;padding:4px 3px}.field b{display:block;font-size:8pt;color:#555;margin-bottom:2px}.field strong{font-size:10pt}.order-notes{border:2px solid #555;background:#f8f8f8;padding:8px;margin:9px 0}.order-notes div{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11pt;font-weight:600}.recipe-params{display:grid;grid-template-columns:1fr 1fr;gap:6px}.recipe-param{border:1px solid #bbb;padding:5px 7px;min-height:12mm;break-inside:avoid}.recipe-param small{display:block;color:#555;font-size:8pt;margin-bottom:2px}.recipe-param strong{font-size:10pt}.recipe-param .raw-material{font-size:11pt;font-weight:700}.recipe-param-wide{grid-column:1/-1}.recipe-notes{margin-top:8px;border:1px solid #bbb;padding:7px;break-inside:avoid}.recipe-notes div{white-space:pre-wrap;overflow-wrap:anywhere;font-weight:600}.pieces{margin-top:10px}.pieces h2{font-size:11pt;background:#eee;padding:5px 7px;margin:0 0 6px}.pieces table{border-collapse:collapse;width:100%;font-size:8pt;table-layout:fixed}.pieces th,.pieces td{border:1px solid #444;padding:4px;text-align:left;vertical-align:top;overflow-wrap:anywhere}.pieces th{background:#f0f0f0}.pieces th:nth-child(1){width:7mm}.pieces th:nth-child(2){width:24mm}.pieces th:nth-child(3),.pieces th:nth-child(4){width:10mm;text-align:center}.pieces td.narrow-number,.pieces td.piece-index{text-align:center}.pieces th:nth-child(5){width:27mm}.pieces th:nth-child(6),.pieces th:nth-child(7){width:22mm}.pieces td.number{text-align:right;white-space:nowrap}.pieces tfoot td{font-weight:700;background:#f0f0f0}.totals{display:flex;justify-content:flex-end;gap:20px;margin-top:7px;padding:8px;border-top:2px solid #222;font-size:11pt}.totals strong{font-size:12pt}.muted{font-size:8pt;color:#555}@media print{.toolbar{display:none}.head,.meta,.order-notes,.recipe-param,.pieces tr{break-inside:avoid}.pieces thead{display:table-header-group}.pieces tfoot{display:table-row-group}}
  </style></head><body><div class="toolbar"><button type="button" data-print>Drukuj / zapisz jako PDF</button></div><main class="sheet">
    <header class="head"><div class="head-title"><h1>ZLECENIE FARBIARSKIE</h1><div class="brand">MARAND<span>dzianiny techniczne</span></div></div><div class="head-fields"><div class="blank-field">Klient<span class="blank-line"></span></div><div class="blank-field">Nr zlecenia z wykańczalni<span class="blank-line"></span></div></div></header>
    ${order.order_type==='raw_sale'?'<div class="raw-sale-banner">SPRZEDAŻ SUROWEJ</div>':''}<div class="symbols-line"><div><small>Symbol handlowy</small><strong>${V.esc(tradeSymbol||'—')}</strong></div><div><small>Symbol surowy</small><strong>${V.esc(order.raw_symbol||'—')}</strong></div></div><section class="meta"><div class="field"><b>PM</b><strong>${V.esc(pm)}</strong></div><div class="field"><b>Symbol surowy</b><strong>${V.esc(order.raw_symbol||'—')}</strong></div><div class="field"><b>Data wysyłki</b><strong>${V.datepl(order.source_shipment_date)}</strong></div><div class="field"><b>Wykańczalnia</b><strong>${V.esc(order.finishing_plant_name||'')}</strong></div><div class="field"><b>Liczba sztuk</b><strong>${sourceBales.length} szt.</strong></div><div class="field"><b>Waga łączna</b><strong>${money(totalWeight)} kg</strong></div></section>
    ${orderNotes}${recipeParameters||recipeNotesPrint?`<section>${recipeParameters?`<div class="recipe-params">${recipeParameters}</div>`:''}${recipeNotesPrint}</section>`:''}
    <section class="pieces"><h2>Sztuki z wybranej pozycji PM</h2><table><thead><tr><th>Nr</th><th>Numer sztuki</th><th>Bł.</th><th>St.</th><th>LOT przędzy</th><th>Metry</th><th>Waga</th><th>Uwagi</th></tr></thead><tbody>${sourceBaleRows||'<tr><td colspan="8">Brak zapisanych sztuk źródłowych.</td></tr>'}</tbody><tfoot><tr><td colspan="5">RAZEM · ${sourceBales.length} szt.</td><td class="number">${qty(sourceBales.reduce((sum,bale)=>sum+Number(bale.meters||0),0))} m</td><td class="number">${money(totalWeight)} kg</td><td></td></tr></tfoot></table></section>
    <div class="totals"><span>Liczba sztuk: <strong>${sourceBales.length} szt.</strong></span><span>Waga łączna: <strong>${money(totalWeight)} kg</strong></span></div><footer class="muted">Wygenerowano z programu wykańczania · ${V.esc(pm)}</footer></main></body></html>`;
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
  const batches=ctx.db.prepare('SELECT closed_at,finishing_lot FROM finishing_batches WHERE order_id=?').all(orderId);
  const status=!batches.length?'draft':batches.every(batch=>batch.closed_at)?'received':batches.some(batch=>String(batch.finishing_lot||'').trim())?'sent':'draft';
  ctx.db.prepare('UPDATE finishing_orders SET status=?,updated_at=?,updated_by=? WHERE id=?').run(status,ctx.now(),ctx.req.user.id,orderId);
  return status;
}
function settlementSnapshot(row){
  return {batch_id:row.batch_id,status:row.status,invoice_note:row.invoice_note,calculation_import_id:row.calculation_import_id,raw_symbol:row.raw_symbol,trade_symbol:row.trade_symbol,
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
  if(!c.batch.closed_at||!c.output.receipt_count)fail(409,'Najpierw przyjmij całe zlecenie barwiarskie.');
  if(c.batch.complaint_status==='reklamowana'||c.batch.complaint_status==='poprawiona')fail(409,'Reklamowanego lub zastąpionego zleceniu nie można rozliczyć.');
  const isCorrection=Boolean(c.batch.correction_of_batch_id),used=number(isCorrection?c.usedWeight:form[`used_${batchId}`]),enteredPrice=number(form[`price_${batchId}`]??c.settlement?.raw_price_per_kg??c.price?.current_price),enteredTheoretical=number(form[`theoretical_${batchId}`]??c.settlement?.theoretical_raw_price_per_kg??c.price?.theoretical_price),enteredFinishing=number(form[`finishing_${batchId}`]),price=enteredPrice===null?null:Costing.round2(enteredPrice),theoretical=enteredTheoretical===null?null:Costing.round2(enteredTheoretical),finishing=enteredFinishing===null?null:Costing.round2(enteredFinishing),invoice=text(form,`invoice_${batchId}`,120);
  const needsCompleteCalculation=action==='approve'||action==='report';
  if(needsCompleteCalculation&&(used===null||used<=0))fail(400,`Wpisz dodatnią wartość „Wykorzystane kg” dla zlecenia ${c.batch.finishing_lot||batchId}.`);
  if(needsCompleteCalculation&&price===null)fail(400,`Brak ceny do kalkulacji dla symbolu surowki ${c.root.raw_symbol}. Wpisz ją ręcznie.`);
  if(needsCompleteCalculation&&theoretical===null)fail(400,`Brak ceny teoretycznej dla symbolu surowki ${c.root.raw_symbol}. Wpisz ją ręcznie.`);
  if(needsCompleteCalculation&&finishing===null)fail(400,`Wpisz koszt wykończenia w zł/kg dla zlecenia ${c.batch.finishing_lot||batchId}.`);
  for(const [label,value] of [['Wykorzystane kg',used],['Cena do kalkulacji',price],['Cena teoretyczna',theoretical],['Koszt wykończenia zł/kg',finishing]])if(value!==null&&value<0)fail(400,`${label} nie może być ujemny.`);
  if(needsCompleteCalculation&&(!c.output.output_quantity||c.output.output_quantity<=0))fail(409,'Brak końcowej ilości fizycznie przyjętej dzianiny.');
  const usedWeight=Costing.round2(used||0),finishCost=Costing.round2(finishing||0),outputUnit=c.output.output_unit,outputQty=Costing.round2(c.output.output_quantity||0);
  const rawCost=price===null?0:Costing.round2(usedWeight*price),actualTotal=Costing.round2(usedWeight*((price??0)+finishCost)),theoreticalTotal=theoretical===null?0:Costing.round2(usedWeight*(theoretical+finishCost));
  const next={batch_id:batchId,invoice_note:invoice,calculation_import_id:c.settlement?.calculation_import_id??c.current?.id??null,raw_symbol:c.root.raw_symbol||'',trade_symbol:c.batch.trade_symbol||'',
    raw_price_per_kg:price,theoretical_raw_price_per_kg:theoretical,raw_price_override:price!==null&&(!c.price||c.price.current_price===null||Math.abs(price-Number(c.price.current_price))>0.000001)?1:0,
    theoretical_price_override:theoretical!==null&&(!c.price||c.price.theoretical_price===null||Math.abs(theoretical-Number(c.price.theoretical_price))>0.000001)?1:0,
    used_weight_kg:usedWeight,finishing_cost:finishCost,output_quantity:outputQty,output_unit:outputUnit,raw_cost_total:rawCost,actual_cost_total:actualTotal,theoretical_cost_total:theoreticalTotal,
    actual_unit_cost:outputQty?Costing.round2(actualTotal/outputQty):null,theoretical_unit_cost:outputQty?Costing.round2(theoreticalTotal/outputQty):null};
  const old=c.settlement,stamp=now();
  const same=old&&Object.keys(next).every(key=>{
    const a=old[key],b=next[key];return typeof a==='number'||typeof b==='number'?((a===null||a===undefined)&&(b===null||b===undefined))||Math.abs(Number(a||0)-Number(b||0))<0.000001:String(a??'')===String(b??'');
  });
  if(same&&old.status==='settled')return {id:old.id,status:old.status,changed:false,batch:c.batch};
  const changed=Boolean(old&&!same),version=Number(old?.version||0)+(changed?1:old?0:1);
  let status;
  if(changed&&old.status==='settled')status='changed';
  else if(old?.status==='changed')status=action==='approve'&&!changed?'settled':'changed';
  else if(action==='approve')status='settled';
  else status=old?.status==='settled'?'settled':'draft';
  const approvedAt=status==='settled'?(old?.status==='settled'&&!changed?old.approved_at:stamp):null,approvedBy=status==='settled'?(old?.status==='settled'&&!changed?old.approved_by:req.user.id):null;
  const persist=()=>{
    let id;
    if(old){id=old.id;db.prepare(`UPDATE finishing_settlements SET status=?,invoice_note=?,calculation_import_id=?,raw_symbol=?,trade_symbol=?,raw_price_per_kg=?,theoretical_raw_price_per_kg=?,raw_price_override=?,theoretical_price_override=?,used_weight_kg=?,finishing_cost=?,output_quantity=?,output_unit=?,raw_cost_total=?,actual_cost_total=?,theoretical_cost_total=?,actual_unit_cost=?,theoretical_unit_cost=?,version=?,updated_at=?,updated_by=?,approved_at=?,approved_by=? WHERE id=?`).run(status,next.invoice_note,next.calculation_import_id,next.raw_symbol,next.trade_symbol,next.raw_price_per_kg,next.theoretical_raw_price_per_kg,next.raw_price_override,next.theoretical_price_override,next.used_weight_kg,next.finishing_cost,next.output_quantity,next.output_unit,next.raw_cost_total,next.actual_cost_total,next.theoretical_cost_total,next.actual_unit_cost,next.theoretical_unit_cost,version,stamp,req.user.id,approvedAt,approvedBy,id);}
    else {const result=db.prepare(`INSERT INTO finishing_settlements(batch_id,status,invoice_note,calculation_import_id,raw_symbol,trade_symbol,raw_price_per_kg,theoretical_raw_price_per_kg,raw_price_override,theoretical_price_override,used_weight_kg,finishing_cost,output_quantity,output_unit,raw_cost_total,actual_cost_total,theoretical_cost_total,actual_unit_cost,theoretical_unit_cost,version,updated_at,updated_by,approved_at,approved_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId,status,next.invoice_note,next.calculation_import_id,next.raw_symbol,next.trade_symbol,next.raw_price_per_kg,next.theoretical_raw_price_per_kg,next.raw_price_override,next.theoretical_price_override,next.used_weight_kg,next.finishing_cost,next.output_quantity,next.output_unit,next.raw_cost_total,next.actual_cost_total,next.theoretical_cost_total,next.actual_unit_cost,next.theoretical_unit_cost,version,stamp,req.user.id,approvedAt,approvedBy);id=Number(result.lastInsertRowid);}
    if(status==='settled'||status==='changed'||!old||changed){const saved=db.prepare('SELECT * FROM finishing_settlements WHERE id=?').get(id),historyAction=status==='settled'?'approved':status==='changed'?'changed':'draft_saved';db.prepare('INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,?,?,?,?)').run(id,version,historyAction,JSON.stringify(settlementSnapshot(saved)),stamp,req.user.id);}
    audit(req.user,status==='settled'?'Zatwierdzono rozliczenie zlecenia barwiarskiego':status==='changed'?'Zmieniono zatwierdzone rozliczenie zlecenia barwiarskiego':'Zapisano robocze rozliczenie zlecenia barwiarskiego',null,JSON.stringify({batchId,settlementId:id,version,status,actualUnitCost:next.actual_unit_cost,theoreticalUnitCost:next.theoretical_unit_cost}),null);
    return {id,status,changed,batch:c.batch};
  };
  return persist();
}
function settlementReportPage(ctx,batchIds){
  const rows=[];
  for(const id of batchIds){
    const c=Costing.calculationContext(ctx.db,id),s=c?.settlement;if(!c||!s)continue;
    const pm=c.batch.article_sequence?`PM ${articleNo({sequence:c.batch.shipment_sequence},{sequence:c.batch.article_sequence})}`:`PM ${c.batch.source_shipment_no||'—'}`;
    rows.push({...s,pm,orderNumber:c.batch.finishing_lot||`#${id}`,trade_symbol:c.batch.trade_symbol||'—',raw_symbol:c.root.raw_symbol||'—'});
  }
  if(!rows.length)throw Object.assign(new Error('Zapisz przynajmniej jedno wybrane rozliczenie, aby przygotować raport.'),{status:400});
  const body=`<article class="finishing-cost-report"><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Raport do Subiekta</h1><p class="muted">Raport obejmuje wybrane zlecenia barwiarskie.</p></div><button type="button" data-print-page>Drukuj raport</button></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Symbol handlowy</th><th>Symbol surowki</th><th>PM</th><th>Zlecenie barwiarskie</th><th>Nr faktury</th><th>Ilość końcowa</th><th>Koszt surowki</th><th>Koszt wykończenia razem</th><th>Koszt rzeczywisty / jednostkę</th><th>Koszt teoretyczny / jednostkę</th><th>Różnica kwotowa</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${V.esc(row.trade_symbol)}</td><td>${V.esc(row.raw_symbol)}</td><td>${V.esc(row.pm)}</td><td>${V.esc(row.orderNumber)}</td><td>${V.esc(row.invoice_note||'—')}</td><td>${qty(row.output_quantity)} ${row.output_unit}</td><td>${money(row.raw_cost_total)} zł</td><td>${money(Costing.round2(Number(row.used_weight_kg||0)*Number(row.finishing_cost||0)))} zł</td><td>${money(row.actual_unit_cost)} zł/${row.output_unit}</td><td>${money(row.theoretical_unit_cost)} zł/${row.output_unit}</td><td>${money(Number(row.actual_unit_cost||0)-Number(row.theoretical_unit_cost||0))} zł/${row.output_unit}</td></tr>`).join('')}</tbody></table></div></article>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Raport do Subiekta',body});
}

function handle(ctx) {
  const {db,req,res,p,url,form,send,redirect,fail,role,transaction,audit,now,getFlashes}=ctx;
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
        audit(req.user,'Cofnięto rozliczenie zlecenia barwiarskiego',null,JSON.stringify({batchId,settlementId:settlement.id,version}),null);count++;
      }
      return count;
    });
    if(!reverted)fail(409,'Zaznaczone zlecenia nie mają zatwierdzonego rozliczenia do cofnięcia.');
    return redirect(req,res,'/finishing/receipts',`Cofnięto rozliczenie ${reverted} zleceń barwiarskich. Dane i historia pozostały zachowane.`,'warning');
  }
  if(p==='/finishing/orders'&&req.method==='GET')return send(req,res,200,ordersPage(ctx));
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
      if(recipe){
        const previousProduction=lastProductionPreview(db,currentSource,recipe);
        if(previousProduction.lotChanged&&previousProduction.previousLot){
          const previousOrderInReference=previousProduction.finishingOrder?`zleceniu farbiarskim nr ${previousProduction.finishingOrder}`:'ostatnim zleceniu farbiarskim';
          orderNotes=appendRecipeNote(orderNotes,`UWAGA: INNY LOT PRZĘDZY NIŻ W ${previousOrderInReference.toLocaleUpperCase('pl-PL')}. WYKONAĆ KOREKTĘ KOLORU.`);
        }
      }
      const result=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,order_type,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_id,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,notes,status,created_at,created_by,updated_at,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(currentSource.shipment_article_id,orderType,plantId||null,shipmentNo({sequence:currentSource.shipment_sequence,shipment_year:currentSource.shipment_year}),currentSource.shipment_date,currentSource.symbol,client,text(form,'trade_symbol',200),recipe?recipeId:null,JSON.stringify({...snapshotRecipe(recipe),finishingPlant:plant?.name||''}),text(form,'target_color',160)||(recipe&&recipe.target_color)||'',text(form,'target_stiffening',160)||(recipe&&recipe.target_stiffening)||'',targetWidth,targetGrammage,JSON.stringify(orderNotes),rawSale?'raw_sale':'draft',now(),req.user.id,now(),req.user.id);
      const newId=Number(result.lastInsertRowid);
      const pieceCount=saveOrderPieces(db,newId,currentSource.shipment_article_id);
      if(!pieceCount)fail(409,'Wybrana pozycja WZ nie ma już aktywnych sztuk do załadowania do zlecenia.');
      if(!rawSale){
        const yarnLots=[...new Set(sourcePieces(db,currentSource.shipment_article_id).map(piece=>String(piece.lot||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pl')).join(', ');
        db.prepare('INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(newId,'',V.todayInput(),currentSource.raw_bales,currentSource.raw_weight_kg,yarnLots,'',now(),req.user.id,now(),req.user.id);
      }
      audit(req.user,'Utworzono zlecenie jako wyjście PM do farbiarni',null,JSON.stringify({orderId:newId,sourceShipmentArticleId:currentSource.shipment_article_id,recipeId,orderType,sentPieces:currentSource.raw_bales,rawWeightKg:currentSource.raw_weight_kg}),null);
      return newId;
    });
    return redirect(req,res,'/finishing/orders',rawSale?'Zarejestrowano sprzedaż surowej dzianiny.':orderType==='trial'?'Utworzono zlecenie próbne.':'Utworzono zlecenie wykańczania.');
  }
  const orderDelete=p.match(/^\/finishing\/orders\/(\d+)\/delete$/);
  if(orderDelete){
    role(req.user,...editableRoles);
    const id=Number(orderDelete[1]),order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    const ensureDeletable=current=>{
      const hasLot=db.prepare("SELECT 1 FROM finishing_batches WHERE order_id=? AND trim(finishing_lot)<>'' LIMIT 1").get(id),receiptCount=db.prepare('SELECT count(*) n FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=?').get(id).n;
      if(current.status==='cancelled'){
        return;
      }
      if(hasLot||receiptCount||!['draft','raw_sale'].includes(current.status))fail(409,'Zlecenie z numerem LOT lub przyjęciem należy najpierw anulować.');
    };
    if(req.method==='GET'){
      ensureDeletable(order);
      return send(req,res,200,deleteOrderConfirmPage(ctx,order));
    }
    if(req.method==='POST'){
      if(form.confirm_delete_order!=='1')fail(400,'Potwierdź usunięcie zlecenia.');
      transaction(()=>{
        const current=orderRecord(db,id);
        if(!current)fail(404,'Nie znaleziono zlecenia.');
        ensureDeletable(current);
        db.prepare('DELETE FROM finishing_orders WHERE id=?').run(id);
        audit(req.user,'Usunięto zlecenie wykańczania',null,JSON.stringify({orderId:id,rawSymbol:current.raw_symbol,client:current.client_name,status:current.status}),null);
      });
      return redirect(req,res,'/finishing/orders','Usunięto zlecenie wykańczania.');
    }
  }
  const orderEditMatch=p.match(/^\/finishing\/orders\/(\d+)\/edit$/);
  if(orderEditMatch){
    role(req.user,...editableRoles);
    const id=Number(orderEditMatch[1]),order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    if(['cancelled','raw_sale'].includes(order.status))fail(409,'Anulowanego zlecenia ani sprzedaży surowej nie można edytować.');
    if(req.method==='GET')return send(req,res,200,orderEditPage(ctx,order));
    if(req.method==='POST'){
      const rawSymbol=text(form,'raw_symbol',200),tradeSymbol=text(form,'trade_symbol',200),client=text(form,'client_name',200),plantId=Number(form.finishing_plant_id)||null;
      if(!rawSymbol)fail(400,'Wpisz symbol dzianiny.');
      if(plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=?').get(plantId))fail(400,'Nie znaleziono wybranej wykończalni.');
      const targetColor=text(form,'target_color',160),targetStiffening=text(form,'target_stiffening',2000),width=number(form.target_width_cm),grammage=number(form.target_grammage);
      if(width!==null&&width<=0)fail(400,'Szerokość musi być większa od zera.');
      if(grammage!==null&&grammage<=0)fail(400,'Gramatura musi być większa od zera.');
      const noteData=recipeNotesData(text(form,'notes',100000));
      const recipeName=text(form,'recipe_name',200),recipeText=text(form,'recipe_text',20000),recipeNotes=recipeNotesData(text(form,'recipe_notes',100000));
      let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
      snapshot.name=recipeName;snapshot.rawSymbol=rawSymbol;snapshot.tradeSymbol=tradeSymbol;snapshot.finishingPlant=plantId?(db.prepare('SELECT name FROM finishing_plants WHERE id=?').get(plantId)?.name||''):'';
      snapshot.recipeText=recipeText;snapshot.targetColor=targetColor;snapshot.targetStiffening=targetStiffening;snapshot.targetWidthCm=width;snapshot.targetGrammage=grammage;snapshot.notes=recipeNotes;

      const sourceRows=order.shipment_article_id?sourcePieces(db,order.shipment_article_id):[];
      const sourceIds=new Set(sourceRows.map(row=>String(row.bale_local_id)));
      const savedIds=new Set(db.prepare('SELECT bale_local_id FROM finishing_order_bales WHERE order_id=?').all(id).map(row=>String(row.bale_local_id)));
      const baleCount=integer(form.bale_count);
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
      if(!selectedBales.length)fail(400,'Zlecenie musi zawierać co najmniej jedną belkę.');

      const batchCount=integer(form.batch_count),currentBatches=db.prepare('SELECT * FROM finishing_batches WHERE order_id=? ORDER BY id').all(id);
      if(batchCount===null||batchCount!==currentBatches.length)fail(409,'Lista partii zmieniła się. Odśwież formularz.');
      const editedBatches=[];
      for(let i=0;i<batchCount;i++){
        const prefix=`batch_${i}_`,batchId=integer(form[`${prefix}id`]),current=currentBatches[i];
        if(!current||batchId!==current.id)fail(409,'Lista partii zmieniła się. Odśwież formularz.');
        const finishingLot=text(form,`${prefix}lot`,120),sentAt=text(form,`${prefix}date`,10),sentPieces=integer(form[`${prefix}pieces`]),rawWeight=number(form[`${prefix}weight`]),yarnLot=text(form,`${prefix}yarn_lot`,250),batchNotes=text(form,`${prefix}notes`,3000);
        if(!validDate(sentAt)||sentPieces===null||sentPieces<0||rawWeight===null||rawWeight<0)fail(400,`Uzupełnij prawidłową datę, sztuki i masę w partii ${i+1}.`);
        const rawReceived=Number(db.prepare('SELECT coalesce(sum(raw_pieces_received),0) n FROM finishing_receipts WHERE batch_id=?').get(batchId).n);
        const quantitiesAtReceipt=Number(current.sent_pieces)===0&&Number(current.raw_weight_kg)===0;
        if(current.closed_at&&(sentPieces!==Number(current.sent_pieces)||Math.abs(rawWeight-Number(current.raw_weight_kg))>0.001||form[`${prefix}closed`]!=='1'))fail(409,`Nie można zmieniać ilości ani ponownie otwierać partii ${i+1} po przyjęciu. Popraw ilości w zapisanym przyjęciu.`);
        if(!quantitiesAtReceipt&&sentPieces<rawReceived)fail(409,`W partii ${i+1} wysłano mniej sztuk niż już zapisano w przyjęciach (${rawReceived}).`);
        editedBatches.push({id:batchId,finishingLot,sentAt,sentPieces:quantitiesAtReceipt?current.sent_pieces:sentPieces,rawWeight:quantitiesAtReceipt?current.raw_weight_kg:rawWeight,yarnLot,batchNotes,closed:form[`${prefix}closed`]==='1',oldClosedAt:current.closed_at});
      }

      transaction(()=>{
        const current=orderRecord(db,id);
        if(!current||['cancelled','raw_sale'].includes(current.status))fail(409,'Zlecenie nie jest już edytowalne.');
        db.prepare(`UPDATE finishing_orders SET finishing_plant_id=?,raw_symbol=?,client_name=?,trade_symbol=?,target_color=?,target_stiffening=?,target_width_cm=?,target_grammage=?,notes=?,recipe_snapshot=?,updated_at=?,updated_by=? WHERE id=?`)
          .run(plantId,rawSymbol,client,tradeSymbol,targetColor,targetStiffening,width,grammage,JSON.stringify(noteData),JSON.stringify(snapshot),now(),req.user.id,id);
        const deleteBale=db.prepare('DELETE FROM finishing_order_bales WHERE order_id=? AND bale_local_id=?');
        const saveBale=db.prepare(`INSERT INTO finishing_order_bales(order_id,bale_local_id,bale_number,machine,production_date,weight_kg,meters,lot) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(order_id,bale_local_id) DO UPDATE SET bale_number=excluded.bale_number,machine=excluded.machine,production_date=excluded.production_date,weight_kg=excluded.weight_kg,meters=excluded.meters,lot=excluded.lot`);
        const keepIds=new Set(selectedBales.map(bale=>bale.localId));
        for(const localId of savedIds)if(!keepIds.has(localId))deleteBale.run(id,localId);
        for(const bale of selectedBales)saveBale.run(id,bale.localId,bale.baleNumber,bale.machine,bale.productionDate,bale.weight,bale.meters,bale.lot);
        const saveBatch=db.prepare('UPDATE finishing_batches SET finishing_lot=?,sent_at=?,sent_pieces=?,raw_weight_kg=?,yarn_lot=?,notes=?,closed_at=?,updated_at=?,updated_by=? WHERE id=? AND order_id=?');
        for(const batch of editedBatches){
          const closedAt=batch.closed?(batch.oldClosedAt||now()):null;
          saveBatch.run(batch.finishingLot,batch.sentAt,batch.sentPieces,batch.rawWeight,batch.yarnLot,batch.batchNotes,closedAt,now(),req.user.id,batch.id,id);
        }
        const calculationInputsChanged=rawSymbol!==order.raw_symbol||tradeSymbol!==order.trade_symbol||editedBatches.some((batch,index)=>Math.abs(batch.rawWeight-Number(currentBatches[index].raw_weight_kg||0))>0.001||batch.sentPieces!==Number(currentBatches[index].sent_pieces));
        if(calculationInputsChanged)markSettlementChanged(db,editedBatches.map(batch=>batch.id),req.user.id,now());
        updateOrderStatus(ctx,id);
        audit(req.user,'Edytowano zlecenie wykańczania',null,JSON.stringify({orderId:id,rawSymbol,client,tradeSymbol,baleCount:selectedBales.length,batchCount:editedBatches.length,settlementsMarkedChanged:calculationInputsChanged}),null);
      });
      return redirect(req,res,`/finishing/orders/${id}`,'Zapisano zmiany zlecenia, belek i partii.');
    }
  }
  const orderMatch=p.match(/^\/finishing\/orders\/(\d+)(?:\/(print|batches|lot|incidents|cancel))?$/);
  if(orderMatch){
    const id=Number(orderMatch[1]),action=orderMatch[2],order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    if(action==='print'&&req.method==='GET')return receiptPage(ctx,id);
    if(action==='lot'&&req.method==='POST'){
      role(req.user,...editableRoles);if(['raw_sale','cancelled'].includes(order.status))fail(409,'Tego zlecenia nie można już edytować.');
      const batchId=Number(form.batch_id),lot=text(form,'finishing_lot',120),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=? AND order_id=?').get(batchId,id);
      if(!batch)fail(400,'Nie znaleziono wyjścia PM dla tego zlecenia.');if(!lot)fail(400,'Wpisz numer partii otrzymany z farbiarni.');
      const updatedStatus=transaction(()=>{db.prepare('UPDATE finishing_batches SET finishing_lot=?,updated_at=?,updated_by=? WHERE id=?').run(lot,now(),req.user.id,batchId);const status=updateOrderStatus(ctx,id);audit(req.user,'Uzupełniono LOT partii w farbiarni',null,JSON.stringify({orderId:id,batchId,finishingLot:lot,status}),null);return status;});
      if(String(req.headers.accept||'').includes('application/json'))return send(req,res,200,JSON.stringify({ok:true,finishing_lot:lot,status:updatedStatus,status_label:orderStatusLabel(updatedStatus),status_class:orderStatusBadgeClass(updatedStatus)}),'application/json; charset=utf-8');
      const returnTo=form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${id}`;
      return redirect(req,res,returnTo,'Zapisano numer specyfikacji z farbiarni.');
    }
    if(action==='batches'&&req.method==='POST'){
      role(req.user,...editableRoles);
      if(form.remove_batch_id!==undefined){
        if(['raw_sale','cancelled'].includes(order.status)||order.order_type==='raw_sale')fail(409,'Tego zlecenia nie można już edytować.');
        const removeBatchId=integer(form.remove_batch_id);if(!removeBatchId)fail(400,'Nieprawidłowa specyfikacja do usunięcia.');
        transaction(()=>{
          const batchToRemove=db.prepare('SELECT * FROM finishing_batches WHERE id=? AND order_id=?').get(removeBatchId,id);
          if(!batchToRemove)fail(404,'Nie znaleziono partii do usunięcia.');
          const receiptSummary=db.prepare('SELECT count(*) receipt_count,coalesce(sum(finished_pieces),0) finished_pieces FROM finishing_receipts WHERE batch_id=?').get(removeBatchId);
          if(receiptSummary.receipt_count||batchToRemove.closed_at||batchToRemove.correction_of_batch_id||Costing.getSettlement(db,removeBatchId))fail(409,'Partii z przyjęciem lub historią rozliczenia nie można usunąć. Zachowaj historię i w razie potrzeby dodaj zlecenie poprawkowe.');
          db.prepare('UPDATE finishing_incidents SET batch_id=NULL WHERE batch_id=? AND order_id=?').run(removeBatchId,id);
          db.prepare('DELETE FROM finishing_batches WHERE id=? AND order_id=?').run(removeBatchId,id);
          const remaining=db.prepare('SELECT count(*) n FROM finishing_batches WHERE order_id=?').get(id).n;
          if(!remaining)db.prepare('INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'',batchToRemove.sent_at||V.todayInput(),batchToRemove.sent_pieces||0,batchToRemove.raw_weight_kg||0,batchToRemove.yarn_lot||'','',now(),req.user.id,now(),req.user.id);
          updateOrderStatus(ctx,id);
          audit(req.user,'Usunięto partię wykańczalni wraz z przyjęciami',null,JSON.stringify({orderId:id,batchId:removeBatchId,finishingLot:batchToRemove.finishing_lot,receiptCount:receiptSummary.receipt_count,finishedPieces:receiptSummary.finished_pieces,incidentsDetached:true}),null);
        });
        const returnTo=form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${id}`;
        return redirect(req,res,returnTo,'Usunięto partię wraz z jej przyjęciami i danymi belek. Wpis audytowy oraz zgłoszone problemy pozostały.');
      }
      if(['received','raw_sale','cancelled'].includes(order.status)||order.order_type==='raw_sale')fail(409,'Tego zlecenia nie można już dzielić na partie.');
      if(db.prepare('SELECT 1 FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=? LIMIT 1').get(id))fail(409,'Nie można dzielić zlecenia po zapisaniu przyjęcia z farbiarni.');
      const batchId=transaction(()=>{
        const base=db.prepare('SELECT * FROM finishing_batches WHERE order_id=? ORDER BY id LIMIT 1').get(id);
        if(!base||base.closed_at)fail(409,'Nie znaleziono otwartej partii głównej do podziału.');
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
    if(action==='cancel'&&req.method==='POST'){
      role(req.user,...editableRoles);if(order.status==='received')fail(409,'Przyjętego zlecenia nie można anulować. Zapisz korektę jako problem.');
      transaction(()=>{db.prepare("UPDATE finishing_orders SET status='cancelled',updated_at=?,updated_by=? WHERE id=?").run(now(),req.user.id,id);audit(req.user,'Anulowano zlecenie wykańczania',null,JSON.stringify({orderId:id}),null);});
      return redirect(req,res,'/finishing/orders','Anulowano zlecenie. Historia została zachowana.');
    }
    if(req.method==='GET'&&!action)return send(req,res,200,orderPage(ctx,id));
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
    const createdId=transaction(()=>{
      const stamp=now(),date=V.todayInput();
      const result=db.prepare(`INSERT INTO finishing_batches(order_id,correction_of_batch_id,complaint_status,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by)
        VALUES(?,?,'normal','',?,0,0,?,'',?,?,?,?)`).run(batch.order_id,batch.id,date,batch.yarn_lot||'',stamp,req.user.id,stamp,req.user.id);
      const id=Number(result.lastInsertRowid);updateOrderStatus(ctx,batch.order_id);
      audit(req.user,'Utworzono poprawkowe zlecenie barwiarskie',null,JSON.stringify({batchId:id,correctionOfBatchId:batch.id,orderId:batch.order_id}),null);return id;
    });
    return redirect(req,res,`/finishing/orders/${batch.order_id}#batch-${createdId}`,'Dodano nowe poprawkowe zlecenie barwiarskie. Wpisz jego numer i po pełnym przyjęciu rozlicz je osobno.');
  }
  const receiptMatch=p.match(/^\/finishing\/batches\/(\d+)\/receipts$/);
  if(receiptMatch&&req.method==='POST'){
    role(req.user,...editableRoles);const batchId=Number(receiptMatch[1]),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId);
    if(!batch)fail(404,'Nie znaleziono partii.');if(batch.closed_at)fail(409,'Ta partia jest już zamknięta.');if(!String(batch.finishing_lot||'').trim())fail(409,'Najpierw wpisz numer specyfikacji z wykończalni.');
    const receivedAt=text(form,'received_at',10),rawReceived=integer(form.raw_pieces_received);
    if(!validDate(receivedAt)||rawReceived===null||rawReceived<0)fail(400,'Wpisz prawidłową datę i liczbę odebranych sztuk surowych.');
    const modalReceipt=form.modal_receipt==='1',measureMeters=modalReceipt?form.measure_meters==='1':true,measureWeight=modalReceipt?form.measure_weight==='1':true;
    if(!measureMeters&&!measureWeight)fail(400,'Wybierz zapis w metrach, kilogramach albo obu jednostkach.');
    const meters=measureMeters?parseList(form.meters_list,'metry'):[],weights=measureWeight?parseList(form.weights_list,'kg'):[];
    if(measureMeters&&measureWeight&&meters.length!==weights.length)fail(400,`Liczba wartości metrów (${meters.length}) różni się od liczby wartości kg (${weights.length}). Popraw listy i spróbuj ponownie.`);
    const width=number(form.actual_width_cm),grammage=number(form.actual_grammage);
    if(width!==null&&width<=0||grammage!==null&&grammage<=0)fail(400,'Szerokość i gramatura muszą być większe od zera.');
    if(modalReceipt&&(!width||!grammage))fail(400,'Wpisz zmierzoną szerokość i gramaturę.');
    const order=orderRecord(db,batch.order_id);let savedRecipe={};try{savedRecipe=JSON.parse(order?.recipe_snapshot||'{}')}catch{}
    const recipeDetails=savedRecipe.details||{};
    const requiredProcesses=recipeProcessRequirements(recipeDetails),processChecks={};
    if(modalReceipt)for(const requirement of requiredProcesses){
      const status=form[`process_check_${requirement.key}`];
      if(!['ok','not_ok'].includes(status))fail(400,`Wybierz OK lub NOK dla wymagania z receptury: ${requirement.label}.`);
      processChecks[requirement.key]=status;
    }
    const grammageStatus=parameterStatus(grammage,order?.target_grammage,recipeDetails.grammageMinus,recipeDetails.grammagePlus);
    const widthStatus=parameterStatus(width,order?.target_width_cm,recipeDetails.widthMinus,recipeDetails.widthPlus);
    const colorStatus=['ok','not_ok'].includes(form.color_status)?form.color_status:'',stiffeningStatus=['ok','not_ok'].includes(form.stiffening_status)?form.stiffening_status:'';
    const priorCommentReceiptId=Number(form.prior_comment_receipt_id)||0;
    const enteredFinishedWeight=number(form.finished_weight_kg);
    const usedWeight=number(form.used_weight_kg);
    if(usedWeight===null||usedWeight<0)fail(400,'Wpisz prawidłowe wykorzystane kg z rozliczenia farbiarni.');
    if(enteredFinishedWeight!==null&&enteredFinishedWeight<0)fail(400,'Odebrana masa nie może być ujemna.');
    const totalWeight=measureWeight?Math.round(weights.reduce((sum,value)=>sum+value,0)*100)/100:enteredFinishedWeight!==null?Math.round(enteredFinishedWeight*100)/100:0,totalMeters=measureMeters?Math.round(meters.reduce((sum,value)=>sum+value,0)*100)/100:0,finishedPieces=measureMeters?meters.length:weights.length;
    if(finishedPieces<1)fail(400,'Dodaj co najmniej jedną belkę z wybranym pomiarem.');
    const receiptId=transaction(()=>{
      const cumulative=db.prepare(`SELECT coalesce(sum(r.raw_pieces_received),0) pieces,coalesce(sum(r.finished_weight_kg),0) weight
        FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=?`).get(batch.order_id);
      const ordered=db.prepare('SELECT coalesce(sum(sent_pieces),0) pieces,coalesce(sum(raw_weight_kg),0) weight FROM finishing_batches WHERE order_id=?').get(batch.order_id);
      if(!batch.correction_of_batch_id&&Number(ordered.pieces)>0&&Number(cumulative.pieces)+rawReceived>Number(ordered.pieces))fail(400,'Odebrane sztuki przekraczają liczbę sztuk zleconych w PM.');
      if(!batch.correction_of_batch_id&&Number(ordered.weight)>0&&Number(cumulative.weight)+totalWeight>Number(ordered.weight)+0.001)fail(400,`Suma odebranych kg z przyjęć przekroczyłaby zlecone ${money(ordered.weight)} kg.`);
      const result=db.prepare(`INSERT INTO finishing_receipts(batch_id,received_at,raw_pieces_received,finished_pieces,finished_weight_kg,used_weight_kg,settlement_unit,finished_meters,actual_color,actual_stiffening,color_status,stiffening_status,actual_width_cm,actual_grammage,width_status,grammage_status,rubbing_status,notes,process_checks,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId,receivedAt,rawReceived,finishedPieces,totalWeight,usedWeight,measureMeters?'mb':'kg',totalMeters,text(form,'actual_color',160),text(form,'actual_stiffening',160),colorStatus,stiffeningStatus,width,grammage,widthStatus,grammageStatus,['ok','not_ok'].includes(form.rubbing_status)?form.rubbing_status:'',text(form,'notes',3000),JSON.stringify(processChecks),now(),req.user.id);
      const id=Number(result.lastInsertRowid),insert=db.prepare('INSERT INTO finishing_return_bales(receipt_id,sequence,meters,weight_kg) VALUES(?,?,?,?)');
      if(priorCommentReceiptId&&order?.recipe_id)db.prepare(`UPDATE finishing_receipts SET comment_consumed_at=?,comment_consumed_by=?
        WHERE id=? AND comment_consumed_at IS NULL AND trim(notes)<>'' AND EXISTS(
          SELECT 1 FROM finishing_batches pb JOIN finishing_orders po ON po.id=pb.order_id
          WHERE pb.id=finishing_receipts.batch_id AND po.recipe_id=?)`).run(now(),id,priorCommentReceiptId,order.recipe_id);
      for(let i=0;i<finishedPieces;i++)insert.run(id,i+1,measureMeters?meters[i]:null,measureWeight?weights[i]:null);
      const batchTotals=db.prepare('SELECT coalesce(sum(raw_pieces_received),0) pieces,coalesce(sum(finished_weight_kg),0) weight FROM finishing_receipts WHERE batch_id=?').get(batchId);
      const quantitiesMatch=Number(batch.sent_pieces)>0&&Number(batchTotals.pieces)===Number(batch.sent_pieces)&&Number(batch.raw_weight_kg)>0&&Math.abs(Number(batchTotals.weight)-Number(batch.raw_weight_kg))<=0.01;
      if(form.close_batch==='1'||quantitiesMatch){
        const closedAt=now();
        db.prepare('UPDATE finishing_batches SET closed_at=?,updated_at=?,updated_by=? WHERE id=?').run(closedAt,closedAt,req.user.id,batchId);
        const lostPieces=Math.max(0,Number(batch.sent_pieces||0)-Number(batchTotals.pieces||0));
        if(lostPieces>0){
          const lostWeight=Number(batch.sent_pieces)>0?Math.max(0,Math.round(Number(batch.raw_weight_kg||0)/Number(batch.sent_pieces)*lostPieces*100)/100):0;
          const description=`Automatycznie po zamknięciu przyjęcia: brak ${lostPieces} szt.${lostWeight>0?` · ${money(lostWeight)} kg`:''}.`;
          db.prepare(`INSERT OR IGNORE INTO finishing_incidents(order_id,batch_id,incident_type,description,created_at,created_by,auto_generated,lost_pieces,lost_weight_kg)
            VALUES(?,?,'lost',?,?,?,?,?,?)`).run(batch.order_id,batchId,description,closedAt,req.user.id,1,lostPieces,lostWeight);
        }
        if(batch.correction_of_batch_id)db.prepare("UPDATE finishing_batches SET complaint_status='poprawiona',updated_at=?,updated_by=? WHERE id=? AND complaint_status='reklamowana'").run(closedAt,req.user.id,batch.correction_of_batch_id);
      }
      updateOrderStatus(ctx,batch.order_id);
      audit(req.user,'Zarejestrowano przyjęcie z wykończalni',null,JSON.stringify({batchId,receiptId:id,returnedRawPieces:rawReceived,finishedPieces}),null);
      return id;
    });
    const returnTo=modalReceipt&&form.return_to==='orders'?'/finishing/orders':`/finishing/orders/${batch.order_id}#batch-${batchId}`;
    return redirect(req,res,returnTo,'Zapisano przyjęcie belek.');
  }
  const lostAction=p.match(/^\/finishing\/lost\/(\d+)\/(found|settle)$/);
  if(lostAction&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(lostAction[1]),kind=lostAction[2],incident=db.prepare("SELECT * FROM finishing_incidents WHERE id=? AND auto_generated=1 AND incident_type='lost'").get(id);
    if(!incident)fail(404,'Nie znaleziono wpisu o zagubionych sztukach.');
    const stamp=now(),column=kind==='found'?'found_at':'settled_at',userColumn=kind==='found'?'found_by':'settled_by';
    const changed=transaction(()=>{
      const result=db.prepare(`UPDATE finishing_incidents SET ${column}=?,${userColumn}=? WHERE id=? AND ${column} IS NULL`).run(stamp,req.user.id,id);
      if(result.changes)audit(req.user,kind==='found'?'Oznaczono brakujące sztuki jako odnalezione':'Oznaczono brakujące sztuki jako rozliczone z wykańczalnią',null,JSON.stringify({incidentId:id,orderId:incident.order_id,batchId:incident.batch_id}),null);
      return result.changes;
    });
    return redirect(req,res,'/finishing/lost',changed?(kind==='found'?'Oznaczono sztuki jako odnalezione.':'Oznaczono sztuki jako rozliczone z wykańczalnią.'):'Ta akcja została już zapisana.');
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
    if(!receipt)fail(404,'Nie znaleziono przyjęcia.');if(!receipt.closed_at)fail(409,'Można poprawiać ilości dopiero po pełnym przyjęciu zlecenia barwiarskiego.');
    const used=validatePositiveNumber(form.used_weight_kg,'Wykorzystane kg',true),bales=db.prepare('SELECT * FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receiptId);
    if(!bales.length)fail(409,'Brak zapisanych wymiarów pojedynczych belek do poprawy.');
    const hasMeters=bales.some(bale=>bale.meters!==null),hasWeights=bales.some(bale=>bale.weight_kg!==null);
    const meters=hasMeters?parseList(form.meters_list,'metry'):[],weights=hasWeights?parseList(form.weights_list,'kg'):[];
    if(hasMeters&&meters.length!==bales.length)fail(400,'Podaj jedną wartość metrów dla każdej belki.');
    if(hasWeights&&weights.length!==bales.length)fail(400,'Podaj jedną wartość kg dla każdej belki.');
    const nextMeters=hasMeters?Costing.round2(meters.reduce((sum,value)=>sum+value,0)):Number(receipt.finished_meters||0),nextWeight=hasWeights?Costing.round2(weights.reduce((sum,value)=>sum+value,0)):Number(receipt.finished_weight_kg||0);
    if(!nextMeters&&!nextWeight)fail(400,'Końcowa ilość musi być większa od zera.');
    transaction(()=>{
      const updateBale=db.prepare('UPDATE finishing_return_bales SET meters=?,weight_kg=? WHERE id=? AND receipt_id=?');
      bales.forEach((bale,index)=>updateBale.run(hasMeters?meters[index]:null,hasWeights?weights[index]:null,bale.id,receiptId));
      db.prepare('UPDATE finishing_receipts SET used_weight_kg=?,finished_meters=?,finished_weight_kg=?,settlement_unit=? WHERE id=?').run(used,nextMeters,nextWeight,hasMeters?'mb':'kg',receiptId);
      const batchReceipts=db.prepare('SELECT coalesce(sum(finished_weight_kg),0) weight,coalesce(sum(used_weight_kg),0) used FROM finishing_receipts WHERE batch_id=?').get(receipt.batch_id);
      const incidents=db.prepare("SELECT id,lost_pieces FROM finishing_incidents WHERE batch_id=? AND auto_generated=1 AND incident_type='lost'").all(receipt.batch_id);
      const lostWeight=receipt.sent_pieces>0?Costing.round2(Number(receipt.raw_weight_kg||0)/Number(receipt.sent_pieces)*Number(incidents[0]?.lost_pieces||0)):0;
      if(incidents.length)db.prepare('UPDATE finishing_incidents SET lost_weight_kg=?,description=? WHERE id=?').run(lostWeight,`Automatycznie po zamknięciu przyjęcia: brak ${incidents[0].lost_pieces} szt.${lostWeight>0?` · ${money(lostWeight)} kg`:''}.`,incidents[0].id);
      const settlements=db.prepare('SELECT * FROM finishing_settlements WHERE batch_id=?').all(receipt.batch_id),stamp=now();
      for(const settlement of settlements){
        const version=Number(settlement.version||0)+1,status=settlement.status==='settled'||settlement.status==='changed'?'changed':settlement.status;
        db.prepare('UPDATE finishing_settlements SET status=?,version=?,updated_at=?,updated_by=?,approved_at=NULL,approved_by=NULL WHERE id=?').run(status,version,stamp,req.user.id,settlement.id);
        const snapshot={...settlement,status,version,updated_at:stamp,updated_by:req.user.id,approved_at:null,approved_by:null};
        db.prepare('INSERT INTO finishing_settlement_history(settlement_id,version,action,snapshot,changed_at,changed_by) VALUES(?,?,?,?,?,?)').run(settlement.id,version,'changed',JSON.stringify(snapshot),stamp,req.user.id);
      }
      audit(req.user,'Poprawiono ilości przyjętego zlecenia barwiarskiego',null,JSON.stringify({receiptId,batchId:receipt.batch_id,usedWeightKg:used,finishedMeters:nextMeters,finishedWeightKg:nextWeight,relatedSettlements:settlements.length}),null);
    });
    return redirect(req,res,`/finishing/orders/${receipt.order_id}#batch-${receipt.batch_id}`,'Zapisano poprawione ilości. Rozliczenie wymaga ponownego przeliczenia i zatwierdzenia.','warning');
  }
  const labelMatch=p.match(/^\/finishing\/receipts\/(\d+)\/labels$/);
  if(labelMatch&&req.method==='GET')return send(req,res,200,labelPage(ctx,Number(labelMatch[1])),'text/html; charset=utf-8');
  if(p==='/finishing/recipes'&&req.method==='GET')return send(req,res,200,recipesPage(ctx));
  if(p==='/finishing/recipes/new'&&req.method==='GET'){const initialRawSymbol=String(url.searchParams.get('raw_symbol')||'').trim().slice(0,200);return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Nowa receptura',body:`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><h1>Dodaj recepturę</h1>${recipeForm(ctx,null,initialRawSymbol)}`}));}
  if(p==='/finishing/recipes'&&req.method==='POST'){
    role(req.user,...editableRoles);const value=prepareRecipe(form,fail);
    if(value.plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(value.plantId))fail(400,'Wybierz aktywną wykończalnię.');
    transaction(()=>{const row=db.prepare('INSERT INTO finishing_recipes(name,finishing_plant_id,raw_symbol,recipe_text,target_color,target_stiffening,target_width_cm,target_grammage,recipe_details,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.name,value.plantId,value.rawSymbol,value.recipeText,value.color,value.stiffening,value.width,value.grammage,JSON.stringify(value.details),value.notes,now(),req.user.id,now(),req.user.id);audit(req.user,'Dodano recepturę wykańczania',null,JSON.stringify({recipeId:Number(row.lastInsertRowid)}),null);});
    return redirect(req,res,'/finishing/recipes','Dodano recepturę do biblioteki.');
  }
  const recipeEdit=p.match(/^\/finishing\/recipes\/(\d+)\/edit$/);
  if(recipeEdit&&req.method==='GET'){
    const recipe=recipeRecord(db,Number(recipeEdit[1]));if(!recipe)fail(404,'Nie znaleziono receptury.');
    role(req.user,...editableRoles);
    const returnToOrder=url.searchParams.get('return_to_order')==='1';
    return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Edytuj recepturę',body:`${navTabs('recipes',ctx.db)}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><h1>Edytuj recepturę</h1>${recipeForm(ctx,recipe,'',returnToOrder)}`}));
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
    transaction(()=>{db.prepare('UPDATE finishing_recipes SET name=?,finishing_plant_id=?,raw_symbol=?,recipe_text=?,target_color=?,target_stiffening=?,target_width_cm=?,target_grammage=?,recipe_details=?,notes=?,updated_at=?,updated_by=? WHERE id=?').run(value.name,value.plantId,value.rawSymbol,value.recipeText,value.color,value.stiffening,value.width,value.grammage,JSON.stringify(value.details),value.notes,now(),req.user.id,id);audit(req.user,'Zmieniono recepturę wykańczania',null,JSON.stringify({recipeId:id}),null);});
    if(form.return_to_order==='1')return redirect(req,res,`/finishing/recipes?return_to_order=1&updated_recipe_id=${id}`,'Zapisano zmiany receptury. Wrócono do tworzonego zlecenia.');
    return redirect(req,res,'/finishing/recipes','Zapisano zmiany receptury. Zlecenia historyczne zachowały poprzednią kopię.');
  }
  return false;
}

module.exports={handle,orderStatusLabel};
