'use strict';

const V = require('../views');

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
const normalizeSearch = value => String(value||'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'');
const RECIPE_NOTES_FORMAT='marand-finishing-notes-v1';
const RECIPE_NOTES_SIZES=[14,16,18,20,24,28];
function recipeNotesData(value='') {
  let parsed;try{parsed=JSON.parse(String(value||''));}catch{}
  if(parsed?.format!==RECIPE_NOTES_FORMAT||!Array.isArray(parsed.runs))parsed={runs:[{text:String(value||''),underline:false,italic:false,size:16}]};
  let remaining=5000;
  const runs=parsed.runs.slice(0,1000).map(run=>{
    const text=String(run?.text||'').slice(0,remaining);remaining-=text.length;
    return {text,bold:Boolean(run?.bold),underline:Boolean(run?.underline),italic:Boolean(run?.italic),size:RECIPE_NOTES_SIZES.includes(Number(run?.size))?Number(run.size):16};
  }).filter(run=>run.text);
  return {format:RECIPE_NOTES_FORMAT,runs};
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
  return Boolean(db.prepare('SELECT 1 FROM finishing_orders WHERE shipment_article_id=? LIMIT 1').get(id));
}
function sourcePieces(db,id) {
  return db.prepare(`SELECT b.bale_number,b.production_date,b.machine,b.weight_kg,b.meters,b.lot
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
  return `<div class="finishing-source-summary"><strong>${V.esc(source.symbol)}</strong><span>WZ ${shipmentNo({sequence:source.shipment_sequence,shipment_year:source.shipment_year})} · spec. ${articleNo({sequence:source.shipment_sequence},{sequence:source.article_sequence})} · ${pieces.length} szt · ${money(totalWeight)} kg · ${V.datepl(source.shipment_date)}</span></div>${pieceListView(pieces)}`;
}
function orderPiecesView(db,order) {
  if(!order.shipment_article_id)return '';
  let pieces=db.prepare('SELECT bale_number,production_date,machine,weight_kg,meters,lot FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(order.id);
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
      coalesce(sum(r.finished_pieces),0) finished_pieces,
      round(coalesce(sum(r.finished_weight_kg),0),2) finished_weight_kg,
      coalesce((SELECT round(sum(CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=rr.id) THEN (SELECT sum(rb.meters) FROM finishing_return_bales rb WHERE rb.receipt_id=rr.id) ELSE rr.finished_meters END),2) FROM finishing_receipts rr WHERE rr.batch_id=b.id),0) finished_meters
    FROM finishing_batches b LEFT JOIN finishing_receipts r ON r.batch_id=b.id
    WHERE b.order_id=? GROUP BY b.id ORDER BY b.id DESC`).all(orderId);
}
function orderReceipts(db,orderId) {
  return db.prepare(`SELECT r.*,b.finishing_lot,o.raw_symbol,o.trade_symbol,o.client_name,o.target_color,o.target_stiffening,o.target_width_cm,o.target_grammage,
      coalesce((SELECT count(*) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id),0) bale_count,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id) THEN coalesce((SELECT round(sum(rb.meters),2) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id),0) ELSE r.finished_meters END meters_sum
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
  const batches=db.prepare('SELECT id,closed_at FROM finishing_batches WHERE order_id=?').all(orderId);
  const receiptCount=db.prepare('SELECT count(*) n FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=?').get(orderId).n;
  const status=!batches.length?'draft':batches.every(batch=>batch.closed_at)?'received':receiptCount?'partial':'sent';
  db.prepare('UPDATE finishing_orders SET status=?,updated_at=? WHERE id=?').run(status,new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),orderId);
}
function orderStatusLabel(status) {
  return {draft:'Do wysłania',sent:'W wykończalni',partial:'Częściowo przyjęta',received:'Przyjęta',raw_sale:'Sprzedaż surowej',cancelled:'Anulowana'}[status]||status;
}
function orderTypeLabel(type) {
  return {standard:'Wykończenie standard',raw_sale:'Sprzedaż surowej',trial:'Próba'}[type]||'Wykończenie standard';
}
function statusBadge(status) {
  const cls={draft:'submitted',sent:'status-finishing',partial:'status-finishing',received:'approved',raw_sale:'archived',cancelled:'archived'}[status]||'submitted';
  return `<span class="badge ${cls}">${V.esc(orderStatusLabel(status))}</span>`;
}
function header({user,csrf,flashes,title,body}) { return V.layout({user,csrf,flashes,title:`${title} · Wykańczanie`,body}); }
function navTabs(active) {
  return `<nav class="finishing-tabs" aria-label="Wykańczanie"><a class="${active==='orders'?'selected':''}" href="/finishing/orders">Zlecenia wykańczania</a><a class="${active==='receipts'?'selected':''}" href="/finishing/receipts">Przyjęcie towaru</a><a class="${active==='recipes'?'selected':''}" href="/finishing/recipes">Biblioteka receptur wykańczania</a></nav>`;
}
function shipmentOptions(db,selectedId=0) {
  const rows=db.prepare(`SELECT sa.id,sa.sequence article_sequence,s.shipment_year,s.sequence shipment_sequence,s.shipment_date,
      a.symbol,sa.finishing_plant_id,count(sb.id) raw_bales,round(coalesce(sum(b.weight_kg),0),2) raw_weight_kg
    FROM shipment_articles sa JOIN shipments s ON s.id=sa.shipment_id
    JOIN articles a ON a.id=sa.article_id LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id WHERE s.status='closed'
      AND NOT EXISTS(SELECT 1 FROM finishing_orders fo WHERE fo.shipment_article_id=sa.id)
      AND EXISTS(SELECT 1 FROM shipment_bales active_sb WHERE active_sb.shipment_article_id=sa.id AND active_sb.removed_at IS NULL)
    GROUP BY sa.id ORDER BY s.shipment_year DESC,s.sequence DESC,sa.sequence DESC`).all();
  return rows.map(row=>`<option value="${row.id}" data-plant="${row.finishing_plant_id||''}"${Number(selectedId)===row.id?' selected':''}>${shipmentNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year})} · spec. ${articleNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year},{sequence:row.article_sequence})} · ${V.esc(row.symbol)} · ${row.raw_bales} szt · ${money(row.raw_weight_kg)} kg · ${V.datepl(row.shipment_date)}</option>`).join('');
}
function orderForm(ctx, selectedSource=0) {
  const db=ctx.db,source=selectedSource&&!shipmentSpecUsed(db,selectedSource)?sourceSpec(db,selectedSource):null,plantList=plants(db);
  const eligibleSource=source&&source.status==='closed'&&Number(source.raw_bales)>0?source:null;
  const clientOptions=clientNames(db).map(name=>`<option value="${V.esc(name)}"></option>`).join('');
  const sourceDetails=eligibleSource?sourceDetailsView(db,eligibleSource):'<p class="muted finishing-source-placeholder" data-finishing-source-placeholder>Po wybraniu specyfikacji zostaną załadowane sztuki z tej wysyłki.</p>';
  const recipePicker=`<div class="finishing-recipe-picker"><div class="finishing-recipe-search-row"><div class="finishing-recipe-search-control"><label for="finishing-recipe-search">Receptura wykańczania</label><div class="finishing-recipe-search-box"><input id="finishing-recipe-search" type="search" role="combobox" data-finishing-recipe-search data-search-url="/finishing/orders/new?partial=recipes" autocomplete="off" placeholder="Wpisz nazwę lub symbol receptury" aria-autocomplete="list" aria-expanded="false" aria-controls="finishing-recipe-results"><div id="finishing-recipe-results" class="finishing-recipe-live-results" data-finishing-recipe-results role="listbox" aria-label="Pasujące receptury"></div></div></div><div class="finishing-recipe-search-actions"><a class="finishing-recipe-edit-shortcut" href="/finishing/recipes" target="_blank" rel="noopener" data-finishing-recipe-edit-shortcut aria-label="Otwórz bibliotekę receptur do edycji" title="Otwórz bibliotekę receptur do edycji"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20Z"/></svg></a><a class="finishing-recipe-add-shortcut" href="/finishing/recipes/new" target="_blank" rel="noopener" aria-label="Dodaj nową recepturę" title="Dodaj nową recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>Nowa receptura</span></a></div></div><input type="hidden" name="recipe_id" data-finishing-recipe><p class="finishing-recipe-selected" data-finishing-recipe-selected aria-live="polite"></p><details class="finishing-selected-recipe" data-finishing-selected-recipe hidden><summary>Podgląd receptury wykańczania</summary><pre class="preline" data-finishing-selected-recipe-text></pre></details></div>`;
  const orderTypes=`<div class="finishing-order-type-inline" role="radiogroup" aria-label="Rodzaj zlecenia"><label class="finishing-order-type-option"><input type="radio" name="order_type" value="standard" checked><span class="finishing-type-check" aria-hidden="true"></span><strong>Wykończenie standard</strong></label><label class="finishing-order-type-option"><input type="radio" name="order_type" value="raw_sale"><span class="finishing-type-check" aria-hidden="true"></span><strong>Sprzedaż surowej</strong></label><label class="finishing-order-type-option"><input type="radio" name="order_type" value="trial"><span class="finishing-type-check" aria-hidden="true"></span><strong>Próba</strong></label></div>`;
  const body=`${navTabs('orders')}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Nowe zlecenie wykańczania</h1><p class="muted">Utwórz czytelne zlecenie z pozycją PM, recepturą i kompletem informacji dla wykończalni.</p></div></div>
    <form method="post" action="/finishing/orders" class="panel padded finishing-form" data-finishing-order-form data-source-url="/finishing/orders/new?partial=source">${hidden('csrf',ctx.req.session.csrf)}
    <section class="finishing-order-section"><header class="finishing-order-section-heading"><span>01</span><div><h2>Specyfikacja i sztuki</h2><p>Wybierz PM z zamkniętej WZ. Sztuki zostaną załadowane do zlecenia.</p></div></header><label>PM ze specyfikacji wysyłkowej / WZ<select name="shipment_article_id" data-finishing-source required><option value="">Wybierz PM z WZ</option>${shipmentOptions(db,eligibleSource?.shipment_article_id||0)}</select></label><div class="finishing-source-details" data-finishing-source-details aria-live="polite">${sourceDetails}</div>${orderTypes}</section>
    <section class="finishing-order-section finishing-order-details"><header class="finishing-order-section-heading"><span>02</span><div><h2>Dane zlecenia</h2><p>Receptura wykańczania, wykończalnia, klient i symbol handlowy.</p></div></header>${recipePicker}<div class="finishing-order-data-grid"><label>Wykończalnia<select name="finishing_plant_id" data-finishing-plant><option value="">Wybierz wykończalnię</option>${plantList.map(plant=>`<option value="${plant.id}"${eligibleSource?.finishing_plant_id===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><label>Klient (opcjonalnie)<input name="client_name" list="finishing-clients" maxlength="200"><datalist id="finishing-clients">${clientOptions}</datalist></label><label>Symbol handlowy<input name="trade_symbol" maxlength="200" data-finishing-trade-symbol></label><label class="finishing-additional-notes">Uwagi dodatkowe<textarea name="notes" maxlength="3000" placeholder="Dodatkowe informacje dla wykończalni…"></textarea></label></div></section><div class="finishing-form-actions"><button type="submit" class="primary finishing-order-submit">Utwórz zlecenie</button></div></form>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Nowe zlecenie',body});
}
function recipeSearchView(db,query,plantId=0) {
  const terms=String(query||'').trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
  if(!terms.length||terms.some(term=>term.length<2))return '<p class="finishing-recipe-search-hint">Wpisz co najmniej 2 znaki każdego szukanego hasła, np. symbol i kolor.</p>';
  const matches=recipes(db,plantId).map(recipe=>({recipe,tradeSymbol:recipeTradeSymbol(recipe)})).filter(({recipe,tradeSymbol})=>{
    const details=readRecipeDetails(recipe),fields=[recipe.name,recipe.raw_symbol,tradeSymbol,recipe.recipe_text,recipe.target_color,details.rawMaterial,recipe.notes].map(normalizeSearch);
    return terms.every(term=>fields.some(field=>field.includes(term)));
  }).slice(0,30);
  const buttons=matches.map(({recipe,tradeSymbol})=>{
    const label=`${recipe.name}${recipe.raw_symbol?` · ${recipe.raw_symbol}`:''}`;
    return `<button type="button" id="finishing-recipe-option-${recipe.id}" role="option" aria-selected="false" class="finishing-recipe-result" data-finishing-recipe-option data-recipe-id="${recipe.id}" data-recipe-label="${V.esc(label)}" data-recipe-text="${V.esc(recipeTextFor(recipe))}" data-plant="${recipe.finishing_plant_id||''}" data-color="${V.esc(recipe.target_color||'')}" data-stiffening="${V.esc(recipe.target_stiffening||'')}" data-width="${recipe.target_width_cm??''}" data-grammage="${recipe.target_grammage??''}" data-trade-symbol="${V.esc(tradeSymbol)}"><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Bez symbolu')}${tradeSymbol?` · ${V.esc(tradeSymbol)}`:''}${recipe.target_color?` · ${V.esc(recipe.target_color)}`:''}${recipe.finishing_plant_name?` · ${V.esc(recipe.finishing_plant_name)}`:''}</span></button>`;
  }).join('');
  return buttons?`<div class="finishing-recipe-result-list" role="group">${buttons}</div>`:'<p class="finishing-recipe-search-hint">Brak pasujących receptur.</p>';
}
function ordersPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),status=String(ctx.url.searchParams.get('status')||'');
  const filters=['draft','sent','partial','received','raw_sale','cancelled'];
  const all=ctx.db.prepare(`SELECT o.*,fp.name finishing_plant_name,
      count(DISTINCT b.id) batch_count,coalesce(sum(b.sent_pieces),0) sent_pieces,
      coalesce(sum((SELECT coalesce(sum(r.finished_pieces),0) FROM finishing_receipts r WHERE r.batch_id=b.id)),0) finished_pieces,
      coalesce((SELECT count(*) FROM finishing_incidents i WHERE i.order_id=o.id AND i.status='open'),0) open_incidents
    FROM finishing_orders o LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id
    LEFT JOIN finishing_batches b ON b.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC,o.id DESC`).all();
  const query=normalizeSearch(q);
  const rows=all.filter(order=>(!status||order.status===status)&&(!query||[order.source_shipment_no,order.raw_symbol,order.client_name,order.trade_symbol,order.finishing_plant_name].map(normalizeSearch).join(' ').includes(query))).map(order=>{
    const canDelete=editableRoles.includes(ctx.req.user.role)&&order.batch_count===0&&['draft','raw_sale','cancelled'].includes(order.status);
    return `<tr><td><a class="item-title" href="/finishing/orders/${order.id}">#${order.id} · ${V.esc(order.raw_symbol)}</a><small class="finishing-subline">${V.esc(order.source_shipment_no||'Zlecenie historyczne')}${order.trade_symbol?` · ${V.esc(order.trade_symbol)}`:''}</small></td><td>${V.esc(order.client_name||'—')}</td><td>${V.esc(order.finishing_plant_name||'—')}</td><td>${statusBadge(order.status)}<small class="finishing-order-type-label">${V.esc(orderTypeLabel(order.order_type))}</small>${order.open_incidents?` <span class="badge archived">Problemy: ${order.open_incidents}</span>`:''}</td><td>${order.batch_count}</td><td>${order.sent_pieces} / ${order.finished_pieces} szt</td><td>${V.datepl(order.updated_at)}</td><td class="row-actions">${canDelete?`<a class="delete-x" href="/finishing/orders/${order.id}/delete" aria-label="Usuń zlecenie wykańczania ${order.id}" title="Usuń zlecenie">×</a>`:''}</td></tr>`;
  }).join('');
  const body=`${navTabs('orders')}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Zlecenia wykańczania</h1><p class="muted">Wybierz specyfikację WZ, recepturę i klienta, a potem rejestruj partie wysłane do wykończalni.</p></div><a class="button primary" href="/finishing/orders/new">+ Nowe zlecenie</a></div>
    <form method="get" action="/finishing/orders" class="shipment-list-filters"><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Wysyłka, symbol, klient, wykończalnia"></label><label>Status<select name="status"><option value="">Wszystkie</option>${filters.map(value=>`<option value="${value}"${status===value?' selected':''}>${orderStatusLabel(value)}</option>`).join('')}</select></label><button class="primary">Filtruj</button><a class="button" href="/finishing/orders">Wyczyść</a></form>
    <div class="panel scroll"><table class="listing compact"><thead><tr><th>Specyfikacja</th><th>Klient</th><th>Wykończalnia</th><th>Status</th><th>Partie</th><th>Wysłano / odebrano</th><th>Aktualizacja</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="8">${all.length?'Brak zleceń dla wybranych filtrów.':'Brak zleceń wykańczania.'}</td></tr>`}</tbody></table></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Zlecenia wykańczania',body});
}
function deleteOrderConfirmPage(ctx,order) {
  const cancelUrl='/finishing/orders';
  const body=`${navTabs('orders')}<a class="breadcrumb" href="${cancelUrl}">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Usuń zlecenie wykańczania</h1></div></div><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Potwierdź usunięcie zlecenia</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrane zlecenie:</p><h2 class="delete-confirm-object">#${order.id} · ${V.esc(order.raw_symbol)} · ${V.esc(order.client_name||'—')}</h2><p>Usunięte zostanie tylko to zlecenie. Można usuwać wyłącznie zlecenia bez zarejestrowanych partii. Rejestr audytowy pozostanie zachowany.</p><form method="post" action="/finishing/orders/${order.id}/delete" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_order','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Usuń zlecenie #${order.id}</button></form></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Usuń zlecenie',body});
}
function labelPage(ctx,receiptId) {
  const receipt=ctx.db.prepare(`SELECT r.*,b.finishing_lot,o.raw_symbol,o.trade_symbol,o.client_name,o.target_color,o.target_stiffening,o.target_width_cm,o.target_grammage,fp.name finishing_plant_name
    FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id JOIN finishing_orders o ON o.id=b.order_id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id WHERE r.id=?`).get(receiptId);
  if(!receipt)throw Object.assign(new Error('Nie znaleziono przyjęcia.'),{status:404});
  const showWeight=ctx.url.searchParams.get('weight')==='1';
  const bales=ctx.db.prepare('SELECT * FROM finishing_return_bales WHERE receipt_id=? ORDER BY sequence').all(receiptId);
  const labels=bales.map((b,index)=>`<article class="finishing-label"><strong class="finishing-label-symbol">${V.esc(receipt.trade_symbol||receipt.raw_symbol)}</strong><div><b>Kolor:</b> ${V.esc(receipt.actual_color||receipt.target_color||'—')}</div><div><b>Nr partii:</b> ${V.esc(receipt.finishing_lot||'—')}</div><div><b>Szerokość:</b> ${V.esc(receipt.actual_width_cm??receipt.target_width_cm??'—')} cm</div><div><b>Gramatura:</b> ${V.esc(receipt.actual_grammage??receipt.target_grammage??'—')} g/m²</div><div class="finishing-label-qty"><b>Ilość mb:</b> ${qty(b.meters)}</div>${showWeight?`<div class="finishing-label-qty"><b>Waga kg:</b> ${qty(b.weight_kg)}</div>`:''}<small>${index+1}/${bales.length}</small></article>`).join('');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Etykiety partii ${V.esc(receipt.finishing_lot||receiptId)}</title><style>@page{size:50mm 74mm;margin:0}*{box-sizing:border-box}body{margin:0;font:10pt/1.22 Arial,sans-serif;color:#111}.toolbar{display:flex;gap:10px;align-items:center;padding:10px;background:#f3f4f6;position:sticky;top:0}.labels{display:block}.finishing-label{width:50mm;height:74mm;padding:4mm 3.5mm;overflow:hidden;page-break-after:always;break-after:page;border:1px solid #bbb;position:relative}.finishing-label-symbol{display:block;font-size:15pt;text-align:center;margin:0 0 3mm}.finishing-label>div{margin:1.6mm 0}.finishing-label-qty{font-size:13pt;font-weight:700;margin-top:3mm!important}.finishing-label small{position:absolute;bottom:2mm;right:3mm;font-size:7pt}@media print{.toolbar{display:none}.finishing-label{border:0}}</style></head><body><div class="toolbar"><button onclick="window.print()">Drukuj etykiety</button><label><input id="weight" type="checkbox"${showWeight?' checked':''} onchange="location.search=this.checked?'?weight=1':''"> Drukuj wagę kg</label><span>${bales.length} etykiet</span></div><main class="labels">${labels}</main></body></html>`;
}
function receiptForm(ctx,batch) {
  return `<form method="post" action="/finishing/batches/${batch.id}/receipts" class="panel padded finishing-receipt-form" data-finishing-batch-form>${hidden('csrf',ctx.req.session.csrf)}<h3>Dodaj przyjęcie partii ${V.esc(batch.finishing_lot||`#${batch.id}`)}</h3><div class="form-grid"><label>Data odbioru<input type="date" name="received_at" value="${V.todayInput()}" required></label><label>Odebrane szt. (surowe)<input type="number" name="raw_pieces_received" min="0" step="1" required></label><label>Wydrapanie<select name="rubbing_status"><option value="">Nie sprawdzono</option><option value="ok">OK</option><option value="not_ok">Nie OK</option></select></label><label>Kolor faktyczny<input name="actual_color" maxlength="160"></label><label>Usztywnienie faktyczne<input name="actual_stiffening" maxlength="160"></label><label>Szerokość faktyczna cm<input name="actual_width_cm" inputmode="decimal"></label><label>Gramatura faktyczna g/m²<input name="actual_grammage" inputmode="decimal"></label></div><div class="finishing-bale-entry"><div><label>Metry każdej belki<input name="meters_list" placeholder="np. 100+100+58" required></label><small>Wartości w kolejności belek, rozdzielone znakiem + lub nową linią.</small></div><div><label>Kg każdej belki<input name="weights_list" placeholder="np. 32+31,5+18" required></label><small>Wagę wpisz ręcznie w tej samej kolejności.</small></div></div><p class="finishing-bale-preview" data-finishing-bale-preview>Wprowadź metry i kg. Liczba wartości musi być taka sama.</p><label>Uwagi<textarea name="notes" maxlength="3000"></textarea></label><label class="check"><input type="checkbox" name="close_batch" value="1"> To przyjęcie zamyka tę partię</label><button class="primary">Zapisz przyjęcie partii</button></form>`;
}
function orderPage(ctx,id) {
  const db=ctx.db,order=orderRecord(db,id);
  if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const batches=orderBatches(db,id),receipts=orderReceipts(db,id);
  const incidents=db.prepare(`SELECT i.*,u.name author,ru.name resolver FROM finishing_incidents i LEFT JOIN users u ON u.id=i.created_by LEFT JOIN users ru ON ru.id=i.resolved_by WHERE i.order_id=? ORDER BY i.id DESC`).all(id);
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const recipeNotesPrint=snapshot.notes?`<h2>Uwagi dodatkowe do receptury</h2><div class="recipe-notes">${recipeNotesHtml(snapshot.notes)}</div>`:'';
  const source=order.shipment_sequence?`${shipmentNo({sequence:order.shipment_sequence,shipment_year:order.shipment_year})} · spec. ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:order.source_shipment_no||'Historia';
  const piecesBody=orderPiecesView(db,order);
  const canEdit=editableRoles.includes(ctx.req.user.role)&&!['cancelled','raw_sale'].includes(order.status);
  const canAddBatch=canEdit&&!['received'].includes(order.status);
  const batchRows=batches.map(batch=>`<tr><td><strong>${V.esc(batch.finishing_lot||`Partia #${batch.id}`)}</strong></td><td>${V.datepl(batch.sent_at)}</td><td>${batch.sent_pieces} szt · ${money(batch.raw_weight_kg)} kg</td><td>${V.esc(batch.yarn_lot||'—')}</td><td>${batch.finished_pieces} szt · ${qty(batch.finished_meters)} mb · ${money(batch.finished_weight_kg)} kg</td><td>${batch.closed_at?'<span class="badge approved">Zamknięta</span>':batch.receipt_count?'<span class="badge submitted">Częściowy powrót</span>':'<span class="badge status-finishing">W wykończalni</span>'}</td><td><a href="#batch-${batch.id}">Otwórz</a></td></tr>`).join('');
  const batchForms=canAddBatch?`<details class="panel padded finishing-batch-add" open><summary><strong>Dodaj wyjście partii do wykończalni</strong></summary><form method="post" action="/finishing/orders/${id}/batches" class="form-grid">${hidden('csrf',ctx.req.session.csrf)}<label>Data wysyłki<input type="date" name="sent_at" value="${V.todayInput()}" required></label><label>Numer partii / LOT z wykończalni<input name="finishing_lot" maxlength="120"></label><label>Wysłane szt. surowe<input type="number" name="sent_pieces" min="0" step="1" required></label><label>Wysłana masa surowa kg<input name="raw_weight_kg" inputmode="decimal" required></label><label>LOT przędzy<input name="yarn_lot" maxlength="250"></label><label>Uwagi<input name="notes" maxlength="500"></label><button class="primary">Dodaj wyjście</button></form></details>`:'';
  const receiptViews=batches.map(batch=>{
    const recent=receipts.filter(receipt=>receipt.batch_id===batch.id);
    const rows=recent.map(receipt=>`<tr><td>${V.datepl(receipt.received_at)}</td><td>${receipt.raw_pieces_received} szt. surowe</td><td>${receipt.finished_pieces} belek · ${qty(receipt.meters_sum)} mb · ${money(receipt.finished_weight_kg)} kg</td><td>${V.esc(receipt.rubbing_status==='ok'?'OK':receipt.rubbing_status==='not_ok'?'Nie OK':'—')}</td><td>${V.esc(receipt.notes||'—')}</td><td>${receipt.bale_count?`<a class="button" href="/finishing/receipts/${receipt.id}/labels">Etykiety</a>`:'<span class="muted small">Brak wymiarów pojedynczych belek</span>'}</td></tr>`).join('');
    return `<section class="panel padded finishing-batch-card" id="batch-${batch.id}"><h3>Partia ${V.esc(batch.finishing_lot||`#${batch.id}`)} ${batch.closed_at?'<span class="badge approved">Zamknięta</span>':''}</h3><p>Wyjście: ${V.datepl(batch.sent_at)} · ${batch.sent_pieces} szt. surowe · ${money(batch.raw_weight_kg)} kg · LOT przędzy: ${V.esc(batch.yarn_lot||'—')}</p><div class="panel scroll"><table class="listing compact"><thead><tr><th>Data powrotu</th><th>Przyjęcie surowej</th><th>Belki wykończone</th><th>Wydrapanie</th><th>Uwagi</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6">Jeszcze nie przyjęto zwrotu.</td></tr>'}</tbody></table></div>${canEdit&&!batch.closed_at?receiptForm(ctx,batch):''}</section>`;
  }).join('');
  const incidentRows=incidents.map(incident=>`<li class="${incident.status==='open'?'finishing-incident-open':''}"><strong>${V.esc({lost:'Zagubiona belka',wrong_order:'Pomyłka w zamówieniu',correction:'Poprawa / zwrot',count_difference:'Różnica ilości',other:'Inne'}[incident.incident_type])}</strong> · ${V.datepl(incident.created_at)} · ${V.esc(incident.description)} <small>${V.esc(incident.author||'')}</small>${incident.status==='open'&&canEdit?`<form method="post" action="/finishing/incidents/${incident.id}/resolve">${hidden('csrf',ctx.req.session.csrf)}<input name="resolution" placeholder="Rozwiązanie / wyjaśnienie" maxlength="1000" required><button>Oznacz jako rozwiązane</button></form>`:incident.resolution?`<p>Rozwiązanie: ${V.esc(incident.resolution)}</p>`:''}</li>`).join('');
  const incidentForm=canEdit?`<form method="post" action="/finishing/orders/${id}/incidents" class="form-grid finishing-incident-form">${hidden('csrf',ctx.req.session.csrf)}<label>Rodzaj problemu<select name="incident_type"><option value="lost">Zagubiona belka</option><option value="wrong_order">Pomyłka w zamówieniu</option><option value="correction">Poprawa / zwrot</option><option value="count_difference">Różnica ilości</option><option value="other">Inne</option></select></label><label>Opis<input name="description" maxlength="1000" required></label><button class="button danger">Zapisz problem</button></form>`:'';
  const recipeBody=`<details class="panel padded"><summary>Receptura zapisana przy zleceniu</summary><p><strong>${V.esc(snapshot.name||'—')}</strong> · ${V.esc(snapshot.finishingPlant||order.finishing_plant_name||'')}</p><pre class="preline finishing-recipe-text">${V.esc(snapshot.recipeText||'')}</pre>${snapshot.notes?`<div class="preline finishing-recipe-card-notes">${recipeNotesHtml(snapshot.notes)}</div>`:''}</details>`;
  const cancel=canEdit&&!['received'].includes(order.status)?`<form method="post" action="/finishing/orders/${id}/cancel" class="finishing-inline-form">${hidden('csrf',ctx.req.session.csrf)}<button class="danger">Anuluj zlecenie</button></form>`:'';
  const body=`${navTabs('orders')}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykańczania</a><div class="pagehead"><div><span class="eyebrow">${statusBadge(order.status)} <span class="finishing-order-type-label">${V.esc(orderTypeLabel(order.order_type))}</span></span><h1>Zlecenie #${order.id} · ${V.esc(order.raw_symbol)}</h1><p class="muted">WZ ${V.esc(source)} · ${V.esc(order.client_name||'—')} · ${V.esc(order.trade_symbol||'—')} · ${V.esc(order.finishing_plant_name||'—')}</p><p>Parametry zadane: ${V.esc(order.target_color||'—')} · usztywnienie ${V.esc(order.target_stiffening||'—')} · ${V.esc(order.target_width_cm??'—')} cm · ${V.esc(order.target_grammage??'—')} g/m²</p>${order.notes?`<p class="preline"><strong>Uwagi dodatkowe:</strong> ${V.esc(order.notes)}</p>`:''}</div><div class="actions"><a class="button" href="/finishing/orders/${id}/print" target="_blank">Drukuj zlecenie</a>${cancel}</div></div>${piecesBody}${recipeBody}
    <section class="panel padded"><div class="sectionhead"><h2>Wyjścia i partie wykończalnicze</h2><span>${batches.length} partii</span></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>LOT</th><th>Data wyjścia</th><th>Surowe wysłane</th><th>LOT przędzy</th><th>Odebrano gotowe</th><th>Stan</th><th></th></tr></thead><tbody>${batchRows||'<tr><td colspan="7">Nie dodano jeszcze wyjścia partii.</td></tr>'}</tbody></table></div></section>${batchForms}<div class="sectionhead"><h2>Przyjęcia zwrotów</h2></div>${receiptViews||'<div class="panel padded muted">Dodaj wyjście, aby zarejestrować powrót z wykończalni.</div>'}
    <section class="panel padded finishing-incidents"><h2>Problemy i wyjaśnienia</h2>${incidentForm}<ul>${incidentRows||'<li>Nie zapisano problemów.</li>'}</ul></section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Zlecenie ${order.id}`,body});
}
function receiptsPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim();
  const query=normalizeSearch(q);
  const rows=ctx.db.prepare(`SELECT o.id order_id,o.raw_symbol,o.client_name,o.trade_symbol,o.source_shipment_no,o.status order_status,fp.name finishing_plant_name,
      b.id batch_id,b.finishing_lot,b.sent_at,b.sent_pieces,b.raw_weight_kg,b.yarn_lot,b.closed_at,
      coalesce((SELECT sum(r.raw_pieces_received) FROM finishing_receipts r WHERE r.batch_id=b.id),0) raw_received,
      coalesce((SELECT sum(r.finished_pieces) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_pieces,
      coalesce((SELECT round(sum(r.finished_weight_kg),2) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_weight_kg,
      coalesce((SELECT round(sum(CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id) THEN (SELECT sum(rb.meters) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id) ELSE r.finished_meters END),2) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_meters
    FROM finishing_orders o LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id
    LEFT JOIN finishing_batches b ON b.order_id=o.id
    WHERE o.status<>'cancelled' ORDER BY b.sent_at DESC,b.id DESC,o.created_at DESC`).all().filter(row=>!query||[row.raw_symbol,row.client_name,row.trade_symbol,row.source_shipment_no,row.finishing_lot,row.finishing_plant_name].map(normalizeSearch).join(' ').includes(query)).map(row=>`<tr><td><a href="/finishing/orders/${row.order_id}">#${row.order_id} · ${V.esc(row.raw_symbol)}</a><small class="finishing-subline">${V.esc(row.source_shipment_no||'')}</small></td><td>${V.esc(row.client_name||'—')}</td><td>${V.esc(row.finishing_plant_name||'—')}</td><td>${V.esc(row.finishing_lot||'—')}</td><td>${V.datepl(row.sent_at)}<small class="finishing-subline">${row.sent_pieces} szt · ${money(row.raw_weight_kg)} kg</small></td><td>${row.raw_received} szt surowe</td><td>${row.finished_pieces} belek · ${qty(row.finished_meters)} mb · ${money(row.finished_weight_kg)} kg</td><td>${row.closed_at?'<span class="badge approved">Przyjęta</span>':row.finished_pieces?'<span class="badge submitted">Częściowy powrót</span>':statusBadge(row.order_status)}</td><td><a href="/finishing/orders/${row.order_id}#batch-${row.batch_id||''}">Szczegóły</a></td></tr>`).join('');
  const body=`${navTabs('receipts')}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Przyjęcie towaru</h1><p class="muted">Rejestr wyjść do wykończalni i powrotów. Liczba wysłana i odebrana może się różnić.</p></div></div><form method="get" action="/finishing/receipts" class="shipment-list-filters"><label class="shipment-list-search">Szukaj<input name="q" value="${V.esc(q)}" placeholder="WZ, symbol, klient, LOT"></label><button class="primary">Szukaj</button><a class="button" href="/finishing/receipts">Wyczyść</a></form><div class="panel scroll"><table class="listing compact"><thead><tr><th>Specyfikacja</th><th>Klient</th><th>Wykończalnia</th><th>LOT wykończalni</th><th>Wysłano</th><th>Odebrane szt. surowe</th><th>Belki wykończone</th><th>Status</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="9">Brak zarejestrowanych wyjść i powrotów.</td></tr>'}</tbody></table></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Przyjęcie towaru',body});
}
function recipeForm(ctx,recipe=null,initialRawSymbol='') {
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
  return `<form method="post" action="${recipe?`/finishing/recipes/${recipe.id}`:'/finishing/recipes'}" class="finishing-recipe-form">${hidden('csrf',ctx.req.session.csrf)}
    <script type="application/json" data-article-composition-map>${compositionMap}</script>
    <section class="finishing-recipe-section finishing-recipe-identity"><div class="finishing-recipe-top-row${recipe?' is-editing':''}"><div class="finishing-recipe-primary"><label for="recipe-name">Nazwa receptury</label><input id="recipe-name" name="name" value="${V.esc(r.name||'')}" maxlength="200" placeholder="Wpisz nazwę receptury" required autofocus></div>${copyControls}</div><div><h2>Identyfikacja dzianiny</h2><div class="finishing-recipe-identity-grid"><label>Symbol dzianiny surowej<input name="raw_symbol" value="${V.esc(r.raw_symbol||'')}" list="finishing-recipe-articles" maxlength="200" required data-article-symbol><datalist id="finishing-recipe-articles">${rawArticles.map(article=>`<option value="${V.esc(article.symbol)}"></option>`).join('')}</datalist></label>${input('Symbol handlowy','trade_symbol',d.tradeSymbol,'maxlength="200"')}<label>Surowiec / skład procentowy<input name="raw_material" value="${V.esc(d.rawMaterial||'')}" maxlength="1000" data-article-composition><small class="muted">Po wybraniu symbolu skład jest pobierany z aktualnej karty technicznej artykułu.</small></label>${input('Kolor / oznaczenie z farbiarni','target_color',r.target_color,'maxlength="160"')}<label>Domyślna wykończalnia<select name="finishing_plant_id"><option value="">Dowolna</option>${plantList.map(plant=>`<option value="${plant.id}"${Number(r.finishing_plant_id)===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label>${yesNo('trial_recipe','Receptura próbna',d.trialRecipe)}</div></div></section>
    <div class="finishing-recipe-technical-row"><section class="finishing-recipe-section"><h2>Parametry oczekiwane</h2><div class="finishing-measurement-row"><label class="finishing-measurement-value"><span>Gramatura g/m²</span><input name="target_grammage" value="${V.esc(r.target_grammage??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label>${tolerance('gramatury','target_grammage_plus','target_grammage_minus',d.grammagePlus,d.grammageMinus,'g/m²')}</div><div class="finishing-measurement-row"><label class="finishing-measurement-value"><span>Szerokość cm</span><input name="target_width_cm" value="${V.esc(r.target_width_cm??'')}" type="number" inputmode="decimal" step="0.1" min="0"></label>${tolerance('szerokości','target_width_plus','target_width_minus',d.widthPlus,d.widthMinus,'cm')}<label class="finishing-check-option finishing-width-needles">${hidden('width_between_needles','no')}<input type="checkbox" name="width_between_needles" value="yes"${d.widthMode==='needles'?' checked':''}><span>Szerokość między igłami</span></label></div>${area('Kurczliwości','shrinkage',d.shrinkage,1)}</section>
    <section class="finishing-recipe-section finishing-recipe-processing"><h2>Uszlachetnianie i obróbka</h2><div class="finishing-process-top-options">${yesNo('brushing','Drapanie',d.brushing)}${yesNo('brushing_for_velcro','Drapanie pod rzep',d.brushingForVelcro)}</div><div class="finishing-process-grid"><div class="finishing-process-described">${yesNo('stiffening_enabled','Usztywnienie',d.stiffeningEnabled)}${input('Opis procesu','stiffening_description',d.stiffeningDescription,'maxlength="2000"')}</div><div class="finishing-process-described">${yesNo('softening_enabled','Zmiękczenie',d.softeningEnabled)}${input('Opis procesu','softening_description',d.softeningDescription,'maxlength="2000"')}</div>${yesNo('trim_edges','Obcinanie brzegów',d.trimEdges)}${yesNo('bond_edges','Podklejanie brzegów',d.bondEdges)}${yesNo('trim_sygnits','Obcinanie sygnitów',d.trimSygnits)}</div></section></div>
    <section class="finishing-recipe-section"><h2>Nawijanie</h2><label>Instrukcje nawijania<textarea class="finishing-winding-input" name="winding_1" rows="3" maxlength="1000">${V.esc(winding)}</textarea></label></section>
    <section class="finishing-recipe-section"><h2>Uwagi dodatkowe</h2><div class="finishing-notes-editor-label"><span class="finishing-notes-field-label">Dodatkowe informacje</span><div class="finishing-notes-editor" data-finishing-notes-editor><div class="finishing-notes-toolbar" role="toolbar" aria-label="Formatowanie uwag"><button type="button" data-finishing-notes-bold title="Pogrub zaznaczony tekst"><strong>B</strong></button><button type="button" data-finishing-notes-underline title="Podkreśl zaznaczony tekst"><u>U</u></button><button type="button" data-finishing-notes-italic title="Pochyl zaznaczony tekst"><em>I</em></button><label>Rozmiar<select data-finishing-notes-size>${recipeNotesSizes}</select></label><span class="muted small">Zaznacz tekst i wybierz formatowanie.</span></div><div class="finishing-notes-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Uwagi dodatkowe receptury" data-finishing-notes-content>${recipeNotesEditorHtml(legacyNotes)}</div><input type="hidden" name="notes" value="${V.esc(recipeNotesValue)}" data-finishing-notes-value></div><small class="muted">Każda linia zostanie zachowana osobno na wydruku.</small></div></section>
    <div class="finishing-form-actions"><button class="primary">${recipe?'Zapisz zmiany':'Dodaj recepturę'}</button></div></form>`;
}
function recipesPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),plantId=Number(ctx.url.searchParams.get('plant_id')||0),allRecipes=recipes(ctx.db);
  const qNorm=normalizeSearch(q);
  const matches=allRecipes.filter(recipe=>{
    const tradeSymbol=readRecipeDetails(recipe).tradeSymbol;
    return (!plantId||recipe.finishing_plant_id===plantId)&&(!qNorm||[recipe.name,recipe.raw_symbol,tradeSymbol,recipe.recipe_text,recipe.target_color].map(normalizeSearch).join(' ').includes(qNorm));
  });
  if(ctx.url.searchParams.get('partial')==='search') {
    if(!qNorm)return '';
    const options=matches.map(recipe=>`<a id="finishing-recipe-option-${recipe.id}" role="option" aria-selected="false" href="/finishing/recipes/${recipe.id}" class="warehouse-article-option finishing-recipe-option"><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Bez symbolu')}${readRecipeDetails(recipe).tradeSymbol?` · ${V.esc(readRecipeDetails(recipe).tradeSymbol)}`:''}</span></a>`).join('');
    return `<div class="warehouse-search-results finishing-recipe-search-results" role="listbox" aria-label="Pasujące receptury">${options||'<p class="warehouse-search-empty">Brak pasujących receptur.</p>'}</div>`;
  }
  const rows=matches.map(recipe=>{const d=readRecipeDetails(recipe),preview=recipeTextFor(recipe);return `<article class="finishing-recipe-row"><div class="finishing-recipe-row-heading"><a class="finishing-recipe-row-name" href="/finishing/recipes/${recipe.id}"><strong>${V.esc(recipe.name)}</strong></a>${d.trialRecipe==='yes'?'<span class="badge finishing-trial-badge">Próba</span>':''}${preview?`<details class="finishing-recipe-preview"><summary>Podgląd wykończenia</summary><pre>${V.esc(preview)}</pre></details>`:''}</div><div class="finishing-recipe-row-symbols"><strong>${V.esc(recipe.raw_symbol||'Bez symbolu')}</strong>${d.tradeSymbol?`<span>Symbol handlowy: <strong>${V.esc(d.tradeSymbol)}</strong></span>`:''}<span>${V.esc(recipe.finishing_plant_name||'Dowolna wykończalnia')}</span></div>${editableRoles.includes(ctx.req.user.role)?`<div class="finishing-recipe-row-actions"><a class="button finishing-recipe-icon-action" href="/finishing/recipes/${recipe.id}/edit" aria-label="Edytuj recepturę ${V.esc(recipe.name)}" title="Edytuj recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20Z"/></svg></a><a class="button danger finishing-recipe-icon-action" href="/finishing/recipes/${recipe.id}/delete" aria-label="Usuń recepturę ${V.esc(recipe.name)}" title="Usuń recepturę"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></a></div>`:''}</article>`;}).join('');
  const body=`${navTabs('recipes')}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Biblioteka receptur wykańczania</h1><p class="muted">Receptury są przechowywane w bazie danych. Zlecenie zapisuje własną kopię wybranej receptury.</p></div>${editableRoles.includes(ctx.req.user.role)?'<a class="button primary" href="/finishing/recipes/new">+ Dodaj recepturę</a>':''}</div><form method="get" action="/finishing/recipes" class="shipment-list-filters" data-shipment-live-search><div class="shipment-list-search finishing-recipe-search-field"><label for="finishing-recipe-search">Szukaj</label><input id="finishing-recipe-search" type="search" name="q" value="${V.esc(q)}" placeholder="Nazwa receptury, symbol dzianiny lub handlowy" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="finishing-recipe-search-results"><div id="finishing-recipe-search-results" class="warehouse-search-results-wrap" data-shipment-search-results></div></div><label>Wykończalnia<select name="plant_id"><option value="0">Wszystkie</option>${plants(ctx.db).map(plant=>`<option value="${plant.id}"${plantId===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><a class="button" href="/finishing/recipes">Wyczyść</a></form><section>${rows||'<div class="panel padded">Brak aktywnych receptur. Dodaj je ręcznie lub zaimportuj dane testowe.</div>'}</section>`;
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
      b.finishing_lot,r.id receipt_id,r.received_at,r.finished_pieces,r.finished_weight_kg,r.finished_meters,r.actual_color,r.actual_stiffening,r.actual_width_cm,r.actual_grammage,r.rubbing_status,r.notes,
      CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id)
        THEN coalesce((SELECT round(sum(rb.meters),2) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id),0) ELSE r.finished_meters END actual_meters
    FROM finishing_orders o JOIN finishing_batches b ON b.order_id=o.id JOIN finishing_receipts r ON r.batch_id=b.id
    LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id WHERE o.recipe_id=?
    ORDER BY r.received_at DESC,r.id DESC`).all(id);
  const historyHtml=history.map(item=>`<article class="finishing-recipe-history-item"><header><strong>${e(V.datepl(item.received_at))}</strong><span>Zlecenie #${item.order_id}${item.source_shipment_no?` · WZ ${e(item.source_shipment_no)}`:''}</span><span>${e(item.finishing_plant_name||'Bez przypisanej wykończalni')}${item.finishing_lot?` · LOT ${e(item.finishing_lot)}`:''}</span></header><dl class="finishing-recipe-card-grid">${show('Kolor uzyskany',item.actual_color)}${show('Usztywnienie uzyskane',item.actual_stiffening)}${show('Szerokość uzyskana',item.actual_width_cm!==null?`${numberText(item.actual_width_cm)} cm`:'')}${show('Gramatura uzyskana',item.actual_grammage!==null?`${numberText(item.actual_grammage)} g/m²`:'')}${show('Odebrane belki',`${item.finished_pieces} szt.`)}${show('Metry',`${numberText(item.actual_meters)} m`)}${show('Masa',`${numberText(item.finished_weight_kg)} kg`)}${show('Wydrapanie',item.rubbing_status==='ok'?'OK':item.rubbing_status==='not_ok'?'Nie OK':'')}${show('Uwagi z przyjęcia',item.notes)}</dl></article>`).join('');
  const actions=editableRoles.includes(ctx.req.user.role)?`<div class="actions"><a class="button primary" href="/finishing/recipes/${recipe.id}/edit">Edytuj recepturę</a><a class="button danger" href="/finishing/recipes/${recipe.id}/delete">Usuń</a></div>`:'';
  const body=`${navTabs('recipes')}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><div class="pagehead"><div><span class="eyebrow">KARTA RECEPTURY</span><h1>${e(recipe.name)}${d.trialRecipe==='yes'?' <span class="badge finishing-trial-badge">Próba</span>':''}</h1><p class="muted"><strong>${e(recipe.raw_symbol||'Bez symbolu dzianiny')}</strong>${d.tradeSymbol?` · ${e(d.tradeSymbol)}`:''}</p></div>${actions}</div><div class="finishing-recipe-card">${detailsHtml}<section class="finishing-recipe-card-section finishing-recipe-history"><h2>Historia wykonań</h2>${historyHtml||'<p class="muted">Brak zarejestrowanych przyjęć z wykończalni dla tej receptury.</p>'}</section></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:recipe.name,body});
}
function recipeDeleteConfirmPage(ctx,recipe) {
  const cancelUrl=`/finishing/recipes/${recipe.id}`;
  const body=`${navTabs('recipes')}<a class="breadcrumb" href="${cancelUrl}">← ${V.esc(recipe.name)}</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Usuń recepturę</h1></div></div><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Usunąć recepturę z aktywnej biblioteki?</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrana receptura:</p><h2 class="delete-confirm-object">${V.esc(recipe.name)} · ${V.esc(recipe.raw_symbol||'Bez symbolu')}</h2><div class="shipment-cancel-details"><div class="shipment-cancel-detail-row"><strong>Dostępność</strong><span>Receptura zniknie z biblioteki i nie będzie dostępna przy tworzeniu nowych zleceń.</span></div><div class="shipment-cancel-detail-row"><strong>Historia</strong><span>Powiązane zlecenia, przyjęcia i wyniki wykończeń pozostaną zachowane.</span></div></div><form method="post" action="/finishing/recipes/${recipe.id}/delete" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_recipe','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Usuń recepturę z biblioteki</button></form></div></dialog>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Usuń recepturę',body});
}
function receiptPage(ctx,id) {
  const order=orderRecord(ctx.db,id);if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const source=order.shipment_sequence?`${shipmentNo({sequence:order.shipment_sequence,shipment_year:order.shipment_year})} · spec. ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:order.source_shipment_no||'Historia';
  let sourceBales=ctx.db.prepare('SELECT bale_number,production_date,machine,weight_kg,meters,lot FROM finishing_order_bales WHERE order_id=? ORDER BY id').all(id);
  if(!sourceBales.length&&order.shipment_article_id)sourceBales=sourcePieces(ctx.db,order.shipment_article_id);
  const sourceBaleRows=sourceBales.map(bale=>`<tr><td>${V.esc(bale.bale_number)}</td><td>${V.esc(bale.machine||'—')}</td><td>${V.datepl(bale.production_date)}</td><td>${qty(bale.meters)} m · ${money(bale.weight_kg)} kg</td><td>${V.esc(bale.lot||'—')}</td></tr>`).join('');
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const rows=ctx.db.prepare(`SELECT b.*,coalesce((SELECT sum(r.finished_pieces) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_pieces
    FROM finishing_batches b WHERE b.order_id=? ORDER BY b.id`).all(id).map(batch=>`<tr><td>${V.esc(batch.finishing_lot||`#${batch.id}`)}</td><td>${V.datepl(batch.sent_at)}</td><td>${batch.sent_pieces}</td><td>${money(batch.raw_weight_kg)}</td><td>${V.esc(batch.yarn_lot||'—')}</td><td>${batch.finished_pieces}</td></tr>`).join('');
  const html=`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zlecenie wykańczania #${id}</title><style>@page{size:A4 portrait;margin:8mm}body{font:10pt/1.35 Arial,sans-serif;color:#111}.toolbar{display:flex;justify-content:flex-end;margin:0 0 12px}.sheet{max-width:194mm;margin:auto}.head{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:6px}h1{font-size:18pt;margin:0}h2{font-size:11pt;background:#eee;padding:4px;margin:12px 0 6px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:8px 0}.field{border-bottom:1px solid #aaa;padding:3px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.recipe{white-space:pre-wrap;border:1px solid #aaa;padding:7px;min-height:35mm}.recipe-notes{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #ddd;padding:7px}table{border-collapse:collapse;width:100%;font-size:9pt}th,td{border:1px solid #555;padding:3px 4px;text-align:left;overflow-wrap:anywhere}footer{margin-top:10mm;border-top:1px solid #888;padding-top:6px;font-size:8pt}@media print{.toolbar{display:none}}</style></head><body><div class="toolbar"><button onclick="window.print()">Drukuj / zapisz jako PDF</button></div><main class="sheet"><header class="head"><h1>ZLECENIE WYKAŃCZANIA</h1><strong>#${id}</strong></header><div class="meta"><div class="field"><b>WZ / wysyłka:</b> ${V.esc(source)}</div><div class="field"><b>Rodzaj zlecenia:</b> ${V.esc(orderTypeLabel(order.order_type))}</div><div class="field"><b>Data wysyłki:</b> ${V.datepl(order.source_shipment_date)}</div><div class="field"><b>Symbol surowy:</b> ${V.esc(order.raw_symbol)}</div><div class="field"><b>Symbol handlowy:</b> ${V.esc(order.trade_symbol||'—')}</div><div class="field"><b>Klient:</b> ${V.esc(order.client_name||'—')}</div><div class="field"><b>Wykończalnia:</b> ${V.esc(order.finishing_plant_name||'—')}</div><div class="field"><b>Kolor zadany:</b> ${V.esc(order.target_color||'—')}</div><div class="field"><b>Usztywnienie:</b> ${V.esc(order.target_stiffening||'—')}</div><div class="field"><b>Szerokość:</b> ${V.esc(order.target_width_cm??'—')} cm</div><div class="field"><b>Gramatura:</b> ${V.esc(order.target_grammage??'—')} g/m²</div></div><h2>Receptura: ${V.esc(snapshot.name||'—')}</h2><div class="recipe">${V.esc(snapshot.recipeText||'')}</div>${recipeNotesPrint}<h2>Sztuki z wybranej pozycji PM</h2><table><thead><tr><th>Nr sztuki</th><th>Maszyna</th><th>Data</th><th>Metry · kg</th><th>LOT</th></tr></thead><tbody>${sourceBaleRows||'<tr><td colspan="5">Brak zapisanych sztuk źródłowych.</td></tr>'}</tbody></table><h2>Partie i ilości</h2><table><thead><tr><th>LOT wykończalni</th><th>Data wysłania</th><th>Szt. surowe</th><th>Kg surowe</th><th>LOT przędzy</th><th>Szt. odebrane</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Partie do uzupełnienia przy wysyłce.</td></tr>'}</tbody></table>${order.notes?`<h2>Uwagi</h2><p class="text">${V.esc(order.notes)}</p>`:''}<footer>Wygenerowano z programu wykańczania · Zlecenie #${id}</footer></main></body></html>`;
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
  const batches=ctx.db.prepare('SELECT closed_at FROM finishing_batches WHERE order_id=?').all(orderId);
  const receiptCount=ctx.db.prepare('SELECT count(*) n FROM finishing_receipts r JOIN finishing_batches b ON b.id=r.batch_id WHERE b.order_id=?').get(orderId).n;
  const status=!batches.length?'draft':batches.every(batch=>batch.closed_at)?'received':receiptCount?'partial':'sent';
  ctx.db.prepare('UPDATE finishing_orders SET status=?,updated_at=?,updated_by=? WHERE id=?').run(status,ctx.now(),ctx.req.user.id,orderId);
}

function handle(ctx) {
  const {db,req,res,p,url,form,send,redirect,fail,role,transaction,audit,now,getFlashes}=ctx;
  if(p==='/finishing'&&req.method==='GET')return redirect(req,res,'/finishing/orders');
  if(p==='/finishing/orders'&&req.method==='GET')return send(req,res,200,ordersPage(ctx));
  if(p==='/finishing/orders/new'&&req.method==='GET'){
    const partial=url.searchParams.get('partial');
    if(partial==='source'){
      const id=Number(url.searchParams.get('shipment_article_id')||0),source=id?sourceSpec(db,id):null;
      if(!source||source.status!=='closed'||Number(source.raw_bales)<1)return send(req,res,409,'<p class="muted">Ta specyfikacja nie ma już dostępnych sztuk do nowego zlecenia.</p>');
      if(shipmentSpecUsed(db,id))return send(req,res,409,'<p class="muted">Ta pozycja PM jest już powiązana ze zleceniem wykańczania.</p>');
      return send(req,res,200,sourceDetailsView(db,source));
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
      const result=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,order_type,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_id,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,notes,status,created_at,created_by,updated_at,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(currentSource.shipment_article_id,orderType,plantId||null,shipmentNo({sequence:currentSource.shipment_sequence,shipment_year:currentSource.shipment_year}),currentSource.shipment_date,currentSource.symbol,client,text(form,'trade_symbol',200),recipe?recipeId:null,JSON.stringify({...snapshotRecipe(recipe),finishingPlant:plant?.name||''}),text(form,'target_color',160)||(recipe&&recipe.target_color)||'',text(form,'target_stiffening',160)||(recipe&&recipe.target_stiffening)||'',targetWidth,targetGrammage,text(form,'notes',3000),rawSale?'raw_sale':'draft',now(),req.user.id,now(),req.user.id);
      const newId=Number(result.lastInsertRowid);
      const pieceCount=saveOrderPieces(db,newId,currentSource.shipment_article_id);
      if(!pieceCount)fail(409,'Wybrana pozycja WZ nie ma już aktywnych sztuk do załadowania do zlecenia.');
      audit(req.user,'Utworzono zlecenie wykańczania',null,JSON.stringify({orderId:newId,sourceShipmentArticleId:currentSource.shipment_article_id,recipeId,orderType}),null);
      return newId;
    });
    return redirect(req,res,rawSale?'/finishing/receipts':`/finishing/orders/${id}`,rawSale?'Zarejestrowano sprzedaż surowej dzianiny.':orderType==='trial'?'Utworzono zlecenie próbne.':'Utworzono zlecenie wykańczania.');
  }
  const orderDelete=p.match(/^\/finishing\/orders\/(\d+)\/delete$/);
  if(orderDelete){
    role(req.user,...editableRoles);
    const id=Number(orderDelete[1]),order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    const ensureDeletable=current=>{
      const batchCount=db.prepare('SELECT count(*) n FROM finishing_batches WHERE order_id=?').get(id).n;
      if(batchCount!==0||!['draft','raw_sale','cancelled'].includes(current.status))fail(409,'Można usunąć tylko zlecenie bez zarejestrowanych partii. Zlecenie z wysyłką należy anulować, aby zachować historię.');
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
  const orderMatch=p.match(/^\/finishing\/orders\/(\d+)(?:\/(print|batches|incidents|cancel))?$/);
  if(orderMatch){
    const id=Number(orderMatch[1]),action=orderMatch[2],order=orderRecord(db,id);
    if(!order)fail(404,'Nie znaleziono zlecenia.');
    if(action==='print'&&req.method==='GET')return receiptPage(ctx,id);
    if(action==='batches'&&req.method==='POST'){
      role(req.user,...editableRoles);if(['received','raw_sale','cancelled'].includes(order.status))fail(409,'Tego zlecenia nie można już wysyłać.');
      const sentAt=text(form,'sent_at',10),sentPieces=integer(form.sent_pieces);
      if(!validDate(sentAt)||sentPieces===null||sentPieces<0)fail(400,'Wpisz prawidłową datę i liczbę wysłanych sztuk.');
      const rawWeight=validatePositiveNumber(form.raw_weight_kg,'Masa surowa',true);
      const batchId=transaction(()=>{
        const result=db.prepare('INSERT INTO finishing_batches(order_id,finishing_lot,sent_at,sent_pieces,raw_weight_kg,yarn_lot,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,text(form,'finishing_lot',120),sentAt,sentPieces,rawWeight,text(form,'yarn_lot',250),text(form,'notes',500),now(),req.user.id,now(),req.user.id);
        updateOrderStatus(ctx,id);audit(req.user,'Zarejestrowano wyjście do wykończalni',null,JSON.stringify({orderId:id,batchId,sentPieces}),null);return Number(result.lastInsertRowid);
      });
      return redirect(req,res,`/finishing/orders/${id}#batch-${batchId}`,'Zarejestrowano wyjście partii do wykończalni.');
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
  const receiptMatch=p.match(/^\/finishing\/batches\/(\d+)\/receipts$/);
  if(receiptMatch&&req.method==='POST'){
    role(req.user,...editableRoles);const batchId=Number(receiptMatch[1]),batch=db.prepare('SELECT * FROM finishing_batches WHERE id=?').get(batchId);
    if(!batch)fail(404,'Nie znaleziono partii.');if(batch.closed_at)fail(409,'Ta partia jest już zamknięta.');
    const receivedAt=text(form,'received_at',10),rawReceived=integer(form.raw_pieces_received);
    if(!validDate(receivedAt)||rawReceived===null||rawReceived<0)fail(400,'Wpisz prawidłową datę i liczbę odebranych sztuk surowych.');
    const meters=parseList(form.meters_list,'metry'),weights=parseList(form.weights_list,'kg');
    if(meters.length!==weights.length)fail(400,`Liczba wartości metrów (${meters.length}) różni się od liczby wartości kg (${weights.length}). Popraw listy i spróbuj ponownie.`);
    const width=number(form.actual_width_cm),grammage=number(form.actual_grammage);
    if(width!==null&&width<=0||grammage!==null&&grammage<=0)fail(400,'Szerokość i gramatura muszą być większe od zera.');
    const totalWeight=Math.round(weights.reduce((sum,value)=>sum+value,0)*100)/100,finishedPieces=meters.length;
    const receiptId=transaction(()=>{
      const result=db.prepare(`INSERT INTO finishing_receipts(batch_id,received_at,raw_pieces_received,finished_pieces,finished_weight_kg,actual_color,actual_stiffening,actual_width_cm,actual_grammage,rubbing_status,notes,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId,receivedAt,rawReceived,finishedPieces,totalWeight,text(form,'actual_color',160),text(form,'actual_stiffening',160),width,grammage,['ok','not_ok'].includes(form.rubbing_status)?form.rubbing_status:'',text(form,'notes',3000),now(),req.user.id);
      const id=Number(result.lastInsertRowid),insert=db.prepare('INSERT INTO finishing_return_bales(receipt_id,sequence,meters,weight_kg) VALUES(?,?,?,?)');
      for(let i=0;i<meters.length;i++)insert.run(id,i+1,meters[i],weights[i]);
      if(form.close_batch==='1')db.prepare('UPDATE finishing_batches SET closed_at=?,updated_at=?,updated_by=? WHERE id=?').run(now(),now(),req.user.id,batchId);
      updateOrderStatus(ctx,batch.order_id);
      audit(req.user,'Zarejestrowano przyjęcie z wykończalni',null,JSON.stringify({batchId,receiptId,returnedRawPieces:rawReceived,finishedPieces}),null);
      return id;
    });
    return redirect(req,res,`/finishing/orders/${batch.order_id}#batch-${batchId}`,'Zapisano przyjęcie. Sprawdź rozliczenie ilości i parametry.');
  }
  const resolveMatch=p.match(/^\/finishing\/incidents\/(\d+)\/resolve$/);
  if(resolveMatch&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(resolveMatch[1]),resolution=text(form,'resolution',1000),incident=db.prepare('SELECT * FROM finishing_incidents WHERE id=?').get(id);
    if(!incident)fail(404,'Nie znaleziono problemu.');if(incident.status==='resolved')fail(409,'Problem został już rozwiązany.');if(!resolution)fail(400,'Wpisz rozwiązanie.');
    transaction(()=>{db.prepare("UPDATE finishing_incidents SET status='resolved',resolution=?,resolved_at=?,resolved_by=? WHERE id=?").run(resolution,now(),req.user.id,id);audit(req.user,'Rozwiązano problem przy wykańczaniu',null,JSON.stringify({incidentId:id,orderId:incident.order_id}),null);});
    return redirect(req,res,`/finishing/orders/${incident.order_id}`,'Oznaczono problem jako rozwiązany.');
  }
  if(p==='/finishing/receipts'&&req.method==='GET')return send(req,res,200,receiptsPage(ctx));
  const labelMatch=p.match(/^\/finishing\/receipts\/(\d+)\/labels$/);
  if(labelMatch&&req.method==='GET')return send(req,res,200,labelPage(ctx,Number(labelMatch[1])),'text/html; charset=utf-8');
  if(p==='/finishing/recipes'&&req.method==='GET')return send(req,res,200,recipesPage(ctx));
  if(p==='/finishing/recipes/new'&&req.method==='GET'){const initialRawSymbol=String(url.searchParams.get('raw_symbol')||'').trim().slice(0,200);return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Nowa receptura',body:`${navTabs('recipes')}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><h1>Dodaj recepturę</h1>${recipeForm(ctx,null,initialRawSymbol)}`}));}
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
    return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Edytuj recepturę',body:`${navTabs('recipes')}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka receptur wykańczania</a><h1>Edytuj recepturę</h1>${recipeForm(ctx,recipe)}`}));
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
    return redirect(req,res,'/finishing/recipes','Zapisano zmiany receptury. Zlecenia historyczne zachowały poprzednią kopię.');
  }
  return false;
}

module.exports={handle,orderStatusLabel};
