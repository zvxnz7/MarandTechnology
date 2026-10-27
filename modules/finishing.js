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
  return {name:recipe.name,finishingPlant:recipe.finishing_plant_name||'',rawSymbol:recipe.raw_symbol||'',recipeText:recipe.recipe_text||'',targetColor:recipe.target_color||'',targetStiffening:recipe.target_stiffening||'',targetWidthCm:recipe.target_width_cm??'',targetGrammage:recipe.target_grammage??'',notes:recipe.notes||''};
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
function statusBadge(status) {
  const cls={draft:'submitted',sent:'status-finishing',partial:'status-finishing',received:'approved',raw_sale:'archived',cancelled:'archived'}[status]||'submitted';
  return `<span class="badge ${cls}">${V.esc(orderStatusLabel(status))}</span>`;
}
function header({user,csrf,flashes,title,body}) { return V.layout({user,csrf,flashes,title:`${title} · Wykańczanie`,body}); }
function navTabs(active) {
  return `<nav class="finishing-tabs" aria-label="Wykańczanie"><a class="${active==='orders'?'selected':''}" href="/finishing/orders">Zlecenia wykończenia</a><a class="${active==='receipts'?'selected':''}" href="/finishing/receipts">Przyjęcie towaru</a><a class="${active==='recipes'?'selected':''}" href="/finishing/recipes">Biblioteka wykończeń</a></nav>`;
}
function shipmentOptions(db,selectedId=0) {
  const rows=db.prepare(`SELECT sa.id,sa.sequence article_sequence,s.shipment_year,s.sequence shipment_sequence,s.shipment_date,
      a.symbol,count(sb.id) raw_bales,round(coalesce(sum(b.weight_kg),0),2) raw_weight_kg
    FROM shipment_articles sa JOIN shipments s ON s.id=sa.shipment_id
    JOIN articles a ON a.id=sa.article_id LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id WHERE s.status='closed'
    GROUP BY sa.id ORDER BY s.shipment_year DESC,s.sequence DESC,sa.sequence DESC`).all();
  return rows.map(row=>`<option value="${row.id}"${Number(selectedId)===row.id?' selected':''}>${shipmentNo(row)} · spec. ${articleNo({sequence:row.shipment_sequence,shipment_year:row.shipment_year},{sequence:row.article_sequence})} · ${V.esc(row.symbol)} · ${row.raw_bales} szt · ${money(row.raw_weight_kg)} kg · ${V.datepl(row.shipment_date)}</option>`).join('');
}
function orderForm(ctx, selectedSource=0) {
  const db=ctx.db,source=selectedSource?sourceSpec(db,selectedSource):null,plantList=plants(db);
  const clientOptions=clientNames(db).map(name=>`<option value="${V.esc(name)}"></option>`).join('');
  const recipeOptions=recipes(db).map(recipe=>`<option value="${recipe.id}" data-plant="${recipe.finishing_plant_id||''}" data-color="${V.esc(recipe.target_color)}" data-stiffening="${V.esc(recipe.target_stiffening)}" data-width="${recipe.target_width_cm??''}" data-grammage="${recipe.target_grammage??''}">${V.esc(recipe.name)}${recipe.raw_symbol?` · ${V.esc(recipe.raw_symbol)}`:''}</option>`).join('');
  const body=`${navTabs('orders')}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykończenia</a><div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Nowe zlecenie wykończenia</h1><p class="muted">Wybierz zamkniętą specyfikację wysyłkową i recepturę. Receptura zostanie zapisana przy zleceniu jako historyczna kopia.</p></div></div>
    <form method="post" action="/finishing/orders" class="panel padded finishing-form" data-finishing-order-form>${hidden('csrf',ctx.req.session.csrf)}
    <label>Specyfikacja wysyłkowa / WZ<select name="shipment_article_id" required><option value="">Wybierz specyfikację</option>${shipmentOptions(db,selectedSource)}</select></label>
    ${source?`<div class="finishing-source-summary"><strong>${V.esc(source.symbol)}</strong><span>Wysyłka ${shipmentNo({sequence:source.shipment_sequence,shipment_year:source.shipment_year})} · ${source.raw_bales} szt · ${money(source.raw_weight_kg)} kg · ${V.datepl(source.shipment_date)}</span></div>`:''}
    <div class="form-grid"><label>Wykończalnia<select name="finishing_plant_id" data-finishing-plant><option value="">Wybierz wykończalnię</option>${plantList.map(plant=>`<option value="${plant.id}"${source?.finishing_plant_id===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label>
    <label>Klient<input name="client_name" list="finishing-clients" maxlength="200" required><datalist id="finishing-clients">${clientOptions}</datalist></label>
    <label>Symbol handlowy<input name="trade_symbol" maxlength="200"></label>
    <label>Receptura z biblioteki<select name="recipe_id" data-finishing-recipe><option value="">Wybierz recepturę</option>${recipeOptions}</select></label></div>
    <div class="finishing-targets"><h2>Parametry zadane</h2><div class="form-grid"><label>Kolor<input name="target_color" maxlength="160"></label><label>Usztywnienie<input name="target_stiffening" maxlength="160"></label><label>Szerokość cm<input name="target_width_cm" inputmode="decimal"></label><label>Gramatura g/m²<input name="target_grammage" inputmode="decimal"></label></div></div>
    <label>Uwagi do wykończalni<textarea name="notes" maxlength="3000"></textarea></label>
    <div class="finishing-form-actions"><label class="check"><input type="checkbox" name="raw_sale" value="1" data-finishing-raw-sale> Sprzedaż surowej dzianiny, bez wysyłki do wykończalni</label><button class="primary">Utwórz zlecenie wykończenia</button></div></form>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Nowe zlecenie',body});
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
  const query=q.toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const rows=all.filter(order=>(!status||order.status===status)&&(!query||[order.source_shipment_no,order.raw_symbol,order.client_name,order.trade_symbol,order.finishing_plant_name].some(value=>String(value||'').toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(query)))).map(order=>`<tr><td><a class="item-title" href="/finishing/orders/${order.id}">#${order.id} · ${V.esc(order.raw_symbol)}</a><small class="finishing-subline">${V.esc(order.source_shipment_no||'Zlecenie historyczne')}${order.trade_symbol?` · ${V.esc(order.trade_symbol)}`:''}</small></td><td>${V.esc(order.client_name||'—')}</td><td>${V.esc(order.finishing_plant_name||'—')}</td><td>${statusBadge(order.status)}${order.open_incidents?` <span class="badge archived">Problemy: ${order.open_incidents}</span>`:''}</td><td>${order.batch_count}</td><td>${order.sent_pieces} / ${order.finished_pieces} szt</td><td>${V.datepl(order.updated_at)}</td></tr>`).join('');
  const body=`${navTabs('orders')}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Zlecenia wykończenia</h1><p class="muted">Wybierz specyfikację WZ, recepturę i klienta, a potem rejestruj partie wysłane do wykończalni.</p></div><a class="button primary" href="/finishing/orders/new">+ Nowe zlecenie</a></div>
    <form method="get" action="/finishing/orders" class="shipment-list-filters"><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Wysyłka, symbol, klient, wykończalnia"></label><label>Status<select name="status"><option value="">Wszystkie</option>${filters.map(value=>`<option value="${value}"${status===value?' selected':''}>${orderStatusLabel(value)}</option>`).join('')}</select></label><button class="primary">Filtruj</button><a class="button" href="/finishing/orders">Wyczyść</a></form>
    <div class="panel scroll"><table class="listing compact"><thead><tr><th>Specyfikacja</th><th>Klient</th><th>Wykończalnia</th><th>Status</th><th>Partie</th><th>Wysłano / odebrano</th><th>Aktualizacja</th></tr></thead><tbody>${rows||`<tr><td colspan="7">${all.length?'Brak zleceń dla wybranych filtrów.':'Brak zleceń wykończenia.'}</td></tr>`}</tbody></table></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Zlecenia wykończenia',body});
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
  const source=order.shipment_sequence?`${shipmentNo({sequence:order.shipment_sequence,shipment_year:order.shipment_year})} · spec. ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:order.source_shipment_no||'Historia';
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
  const recipeBody=`<details class="panel padded"><summary>Receptura zapisana przy zleceniu</summary><p><strong>${V.esc(snapshot.name||'—')}</strong> · ${V.esc(snapshot.finishingPlant||order.finishing_plant_name||'')}</p><pre class="preline finishing-recipe-text">${V.esc(snapshot.recipeText||'')}</pre>${snapshot.notes?`<p class="preline">${V.esc(snapshot.notes)}</p>`:''}</details>`;
  const cancel=canEdit&&!['received'].includes(order.status)?`<form method="post" action="/finishing/orders/${id}/cancel" class="finishing-inline-form">${hidden('csrf',ctx.req.session.csrf)}<button class="danger">Anuluj zlecenie</button></form>`:'';
  const body=`${navTabs('orders')}<a class="breadcrumb" href="/finishing/orders">← Zlecenia wykończenia</a><div class="pagehead"><div><span class="eyebrow">${statusBadge(order.status)}</span><h1>Zlecenie #${order.id} · ${V.esc(order.raw_symbol)}</h1><p class="muted">WZ ${V.esc(source)} · ${V.esc(order.client_name||'—')} · ${V.esc(order.trade_symbol||'—')} · ${V.esc(order.finishing_plant_name||'—')}</p><p>Parametry zadane: ${V.esc(order.target_color||'—')} · usztywnienie ${V.esc(order.target_stiffening||'—')} · ${V.esc(order.target_width_cm??'—')} cm · ${V.esc(order.target_grammage??'—')} g/m²</p></div><div class="actions"><a class="button" href="/finishing/orders/${id}/print" target="_blank">Drukuj zlecenie</a>${cancel}</div></div>${recipeBody}
    <section class="panel padded"><div class="sectionhead"><h2>Wyjścia i partie wykończalnicze</h2><span>${batches.length} partii</span></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>LOT</th><th>Data wyjścia</th><th>Surowe wysłane</th><th>LOT przędzy</th><th>Odebrano gotowe</th><th>Stan</th><th></th></tr></thead><tbody>${batchRows||'<tr><td colspan="7">Nie dodano jeszcze wyjścia partii.</td></tr>'}</tbody></table></div></section>${batchForms}<div class="sectionhead"><h2>Przyjęcia zwrotów</h2></div>${receiptViews||'<div class="panel padded muted">Dodaj wyjście, aby zarejestrować powrót z wykończalni.</div>'}
    <section class="panel padded finishing-incidents"><h2>Problemy i wyjaśnienia</h2>${incidentForm}<ul>${incidentRows||'<li>Nie zapisano problemów.</li>'}</ul></section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Zlecenie ${order.id}`,body});
}
function receiptsPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim();
  const query=q.toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const rows=ctx.db.prepare(`SELECT o.id order_id,o.raw_symbol,o.client_name,o.trade_symbol,o.source_shipment_no,o.status order_status,fp.name finishing_plant_name,
      b.id batch_id,b.finishing_lot,b.sent_at,b.sent_pieces,b.raw_weight_kg,b.yarn_lot,b.closed_at,
      coalesce((SELECT sum(r.raw_pieces_received) FROM finishing_receipts r WHERE r.batch_id=b.id),0) raw_received,
      coalesce((SELECT sum(r.finished_pieces) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_pieces,
      coalesce((SELECT round(sum(r.finished_weight_kg),2) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_weight_kg,
      coalesce((SELECT round(sum(CASE WHEN EXISTS(SELECT 1 FROM finishing_return_bales rb0 WHERE rb0.receipt_id=r.id) THEN (SELECT sum(rb.meters) FROM finishing_return_bales rb WHERE rb.receipt_id=r.id) ELSE r.finished_meters END),2) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_meters
    FROM finishing_orders o LEFT JOIN finishing_plants fp ON fp.id=o.finishing_plant_id
    LEFT JOIN finishing_batches b ON b.order_id=o.id
    WHERE o.status<>'cancelled' ORDER BY b.sent_at DESC,b.id DESC,o.created_at DESC`).all().filter(row=>!query||[row.raw_symbol,row.client_name,row.trade_symbol,row.source_shipment_no,row.finishing_lot,row.finishing_plant_name].some(value=>String(value||'').toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(query))).map(row=>`<tr><td><a href="/finishing/orders/${row.order_id}">#${row.order_id} · ${V.esc(row.raw_symbol)}</a><small class="finishing-subline">${V.esc(row.source_shipment_no||'')}</small></td><td>${V.esc(row.client_name||'—')}</td><td>${V.esc(row.finishing_plant_name||'—')}</td><td>${V.esc(row.finishing_lot||'—')}</td><td>${V.datepl(row.sent_at)}<small class="finishing-subline">${row.sent_pieces} szt · ${money(row.raw_weight_kg)} kg</small></td><td>${row.raw_received} szt surowe</td><td>${row.finished_pieces} belek · ${qty(row.finished_meters)} mb · ${money(row.finished_weight_kg)} kg</td><td>${row.closed_at?'<span class="badge approved">Przyjęta</span>':row.finished_pieces?'<span class="badge submitted">Częściowy powrót</span>':statusBadge(row.order_status)}</td><td><a href="/finishing/orders/${row.order_id}#batch-${row.batch_id||''}">Szczegóły</a></td></tr>`).join('');
  const body=`${navTabs('receipts')}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Przyjęcie towaru</h1><p class="muted">Rejestr wyjść do wykończalni i powrotów. Liczba wysłana i odebrana może się różnić.</p></div></div><form method="get" action="/finishing/receipts" class="shipment-list-filters"><label class="shipment-list-search">Szukaj<input name="q" value="${V.esc(q)}" placeholder="WZ, symbol, klient, LOT"></label><button class="primary">Szukaj</button><a class="button" href="/finishing/receipts">Wyczyść</a></form><div class="panel scroll"><table class="listing compact"><thead><tr><th>Specyfikacja</th><th>Klient</th><th>Wykończalnia</th><th>LOT wykończalni</th><th>Wysłano</th><th>Odebrane szt. surowe</th><th>Belki wykończone</th><th>Status</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="9">Brak zarejestrowanych wyjść i powrotów.</td></tr>'}</tbody></table></div>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Przyjęcie towaru',body});
}
function recipeForm(ctx,recipe=null) {
  const plantList=plants(ctx.db),r=recipe||{};
  return `<form method="post" action="${recipe?`/finishing/recipes/${recipe.id}`:'/finishing/recipes'}" class="panel padded finishing-recipe-form">${hidden('csrf',ctx.req.session.csrf)}<div class="form-grid"><label>Nazwa receptury<input name="name" value="${V.esc(r.name||'')}" maxlength="200" required></label><label>Domyślna wykończalnia<select name="finishing_plant_id"><option value="">Dowolna</option>${plantList.map(plant=>`<option value="${plant.id}"${Number(r.finishing_plant_id)===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><label>Symbol dzianiny surowej<input name="raw_symbol" value="${V.esc(r.raw_symbol||'')}" maxlength="200"></label><label>Kolor<input name="target_color" value="${V.esc(r.target_color||'')}" maxlength="160"></label><label>Usztywnienie<input name="target_stiffening" value="${V.esc(r.target_stiffening||'')}" maxlength="160"></label><label>Szerokość cm<input name="target_width_cm" value="${V.esc(r.target_width_cm??'')}" inputmode="decimal"></label><label>Gramatura g/m²<input name="target_grammage" value="${V.esc(r.target_grammage??'')}" inputmode="decimal"></label></div><label>Treść receptury<textarea name="recipe_text" rows="8" maxlength="12000" required>${V.esc(r.recipe_text||'')}</textarea></label><label>Uwagi<textarea name="notes" maxlength="3000">${V.esc(r.notes||'')}</textarea></label><button class="primary">${recipe?'Zapisz zmiany':'Dodaj recepturę'}</button></form>`;
}
function recipesPage(ctx) {
  const q=String(ctx.url.searchParams.get('q')||'').trim(),plantId=Number(ctx.url.searchParams.get('plant_id')||0),allRecipes=recipes(ctx.db);
  const qNorm=q.toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const matches=allRecipes.filter(recipe=>(!plantId||recipe.finishing_plant_id===plantId)&&(!qNorm||[recipe.name,recipe.raw_symbol,recipe.recipe_text,recipe.target_color].some(value=>String(value||'').toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(qNorm))));
  const rows=matches.map(recipe=>`<details class="finishing-recipe"><summary><strong>${V.esc(recipe.name)}</strong><span>${V.esc(recipe.raw_symbol||'Dowolny artykuł')} · ${V.esc(recipe.finishing_plant_name||'Dowolna wykończalnia')}</span></summary><div class="finishing-recipe-detail"><p>${V.esc(recipe.target_color||'—')} · usztywnienie ${V.esc(recipe.target_stiffening||'—')} · ${V.esc(recipe.target_width_cm??'—')} cm · ${V.esc(recipe.target_grammage??'—')} g/m²</p><pre class="preline finishing-recipe-text">${V.esc(recipe.recipe_text)}</pre>${recipe.notes?`<p class="preline">${V.esc(recipe.notes)}</p>`:''}${editableRoles.includes(ctx.req.user.role)?`<a class="button" href="/finishing/recipes/${recipe.id}/edit">Edytuj</a>`:''}</div></details>`).join('');
  const body=`${navTabs('recipes')}<div class="pagehead"><div><span class="eyebrow">WYKAŃCZANIE</span><h1>Biblioteka wykończeń</h1><p class="muted">Receptury są przechowywane w bazie danych. Zlecenie zapisuje własną kopię wybranej receptury.</p></div>${editableRoles.includes(ctx.req.user.role)?'<a class="button primary" href="/finishing/recipes/new">+ Dodaj recepturę</a>':''}</div><form method="get" action="/finishing/recipes" class="shipment-list-filters"><label class="shipment-list-search">Szukaj<input name="q" value="${V.esc(q)}" placeholder="Nazwa receptury lub symbol dzianiny"></label><label>Wykończalnia<select name="plant_id"><option value="0">Wszystkie</option>${plants(ctx.db).map(plant=>`<option value="${plant.id}"${plantId===plant.id?' selected':''}>${V.esc(plant.name)}</option>`).join('')}</select></label><button class="primary">Szukaj</button><a class="button" href="/finishing/recipes">Wyczyść</a></form><section>${rows||'<div class="panel padded">Brak aktywnych receptur. Dodaj je ręcznie lub zaimportuj dane testowe.</div>'}</section>`;
  return header({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Biblioteka wykończeń',body});
}
function receiptPage(ctx,id) {
  const order=orderRecord(ctx.db,id);if(!order)throw Object.assign(new Error('Nie znaleziono zlecenia.'),{status:404});
  const source=order.shipment_sequence?`${shipmentNo({sequence:order.shipment_sequence,shipment_year:order.shipment_year})} · spec. ${articleNo({sequence:order.shipment_sequence},{sequence:order.article_sequence})}`:order.source_shipment_no||'Historia';
  let snapshot={};try{snapshot=JSON.parse(order.recipe_snapshot||'{}')}catch{}
  const rows=ctx.db.prepare(`SELECT b.*,coalesce((SELECT sum(r.finished_pieces) FROM finishing_receipts r WHERE r.batch_id=b.id),0) finished_pieces
    FROM finishing_batches b WHERE b.order_id=? ORDER BY b.id`).all(id).map(batch=>`<tr><td>${V.esc(batch.finishing_lot||`#${batch.id}`)}</td><td>${V.datepl(batch.sent_at)}</td><td>${batch.sent_pieces}</td><td>${money(batch.raw_weight_kg)}</td><td>${V.esc(batch.yarn_lot||'—')}</td><td>${batch.finished_pieces}</td></tr>`).join('');
  const html=`<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zlecenie wykończenia #${id}</title><style>@page{size:A4;margin:12mm}body{font:11pt/1.4 Arial,sans-serif;color:#111}.toolbar{display:flex;justify-content:flex-end;margin:0 0 12px}.sheet{max-width:190mm;margin:auto}.head{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:8px}h1{font-size:20pt;margin:0}h2{font-size:13pt;background:#eee;padding:5px;margin:18px 0 8px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.field{border-bottom:1px solid #aaa;padding:5px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.recipe{white-space:pre-wrap;border:1px solid #aaa;padding:10px;min-height:45mm}table{border-collapse:collapse;width:100%}th,td{border:1px solid #555;padding:6px;text-align:left}footer{margin-top:20mm;border-top:1px solid #888;padding-top:8px;font-size:9pt}@media print{.toolbar{display:none}}</style></head><body><div class="toolbar"><button onclick="window.print()">Drukuj / zapisz jako PDF</button></div><main class="sheet"><header class="head"><h1>ZLECENIE WYKOŃCZENIA</h1><strong>#${id}</strong></header><div class="meta"><div class="field"><b>WZ / wysyłka:</b> ${V.esc(source)}</div><div class="field"><b>Data wysyłki:</b> ${V.datepl(order.source_shipment_date)}</div><div class="field"><b>Symbol surowy:</b> ${V.esc(order.raw_symbol)}</div><div class="field"><b>Symbol handlowy:</b> ${V.esc(order.trade_symbol||'—')}</div><div class="field"><b>Klient:</b> ${V.esc(order.client_name||'—')}</div><div class="field"><b>Wykończalnia:</b> ${V.esc(order.finishing_plant_name||'—')}</div><div class="field"><b>Kolor zadany:</b> ${V.esc(order.target_color||'—')}</div><div class="field"><b>Usztywnienie:</b> ${V.esc(order.target_stiffening||'—')}</div><div class="field"><b>Szerokość:</b> ${V.esc(order.target_width_cm??'—')} cm</div><div class="field"><b>Gramatura:</b> ${V.esc(order.target_grammage??'—')} g/m²</div></div><h2>Receptura: ${V.esc(snapshot.name||'—')}</h2><div class="recipe">${V.esc(snapshot.recipeText||'')}</div><h2>Partie i ilości</h2><table><thead><tr><th>LOT wykończalni</th><th>Data wysłania</th><th>Szt. surowe</th><th>Kg surowe</th><th>LOT przędzy</th><th>Szt. odebrane</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Partie do uzupełnienia przy wysyłce.</td></tr>'}</tbody></table>${order.notes?`<h2>Uwagi</h2><p class="text">${V.esc(order.notes)}</p>`:''}<footer>Wygenerowano z programu wykańczania · Zlecenie #${id}</footer></main></body></html>`;
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
  if(p==='/finishing/orders/new'&&req.method==='GET')return send(req,res,200,orderForm(ctx,Number(url.searchParams.get('shipment_article_id')||0)));
  if(p==='/finishing/orders'&&req.method==='POST'){
    role(req.user,...editableRoles);
    const rawSale=form.raw_sale==='1';
    const shipmentArticleId=Number(form.shipment_article_id),plantId=Number(form.finishing_plant_id),source=sourceSpec(db,shipmentArticleId),plant=plantId?db.prepare('SELECT id,name FROM finishing_plants WHERE id=? AND active=1').get(plantId):null;
    if(!source||source.status!=='closed')fail(400,'Wybierz zamkniętą specyfikację wysyłkową.');
    if(!rawSale&&!plant)fail(400,'Wybierz aktywną wykończalnię.');
    const recipeId=Number(form.recipe_id),recipe=recipeId?recipeRecord(db,recipeId):null;
    if(!rawSale&&(!recipe||!recipe.active))fail(400,'Wybierz aktywną recepturę z biblioteki.');
    if(!rawSale&&recipe.finishing_plant_id&&recipe.finishing_plant_id!==plantId)fail(400,'Wybrana receptura jest przypisana do innej wykończalni.');
    const client=text(form,'client_name',200);if(!client)fail(400,'Wybierz lub wpisz klienta.');
    const enteredWidth=number(form.target_width_cm),enteredGrammage=number(form.target_grammage);
    const targetWidth=enteredWidth===null?(recipe?.target_width_cm??null):enteredWidth,targetGrammage=enteredGrammage===null?(recipe?.target_grammage??null):enteredGrammage;
    if(targetWidth!==null&&targetWidth<=0)fail(400,'Szerokość musi być większa od zera.');
    if(targetGrammage!==null&&targetGrammage<=0)fail(400,'Gramatura musi być większa od zera.');
    const id=transaction(()=>{
      const result=db.prepare(`INSERT INTO finishing_orders(shipment_article_id,finishing_plant_id,source_shipment_no,source_shipment_date,raw_symbol,client_name,trade_symbol,recipe_id,recipe_snapshot,target_color,target_stiffening,target_width_cm,target_grammage,notes,status,created_at,created_by,updated_at,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.shipment_article_id,plantId||null,shipmentNo({sequence:source.shipment_sequence,shipment_year:source.shipment_year}),source.shipment_date,source.symbol,client,text(form,'trade_symbol',200),recipe?recipeId:null,JSON.stringify({...snapshotRecipe(recipe),finishingPlant:plant?.name||''}),text(form,'target_color',160)||(recipe&&recipe.target_color)||'',text(form,'target_stiffening',160)||(recipe&&recipe.target_stiffening)||'',targetWidth,targetGrammage,text(form,'notes',3000),rawSale?'raw_sale':'draft',now(),req.user.id,now(),req.user.id);
      const newId=Number(result.lastInsertRowid);
      audit(req.user,'Utworzono zlecenie wykończenia',null,JSON.stringify({orderId:newId,sourceShipmentArticleId:source.shipment_article_id,recipeId,rawSale}),null);
      return newId;
    });
    return redirect(req,res,rawSale?'/finishing/receipts':`/finishing/orders/${id}`,rawSale?'Zarejestrowano sprzedaż surowej dzianiny.':'Utworzono zlecenie wykończenia.');
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
      transaction(()=>{const row=db.prepare('INSERT INTO finishing_incidents(order_id,batch_id,incident_type,description,created_at,created_by) VALUES(?,?,?,?,?,?)').run(id,batchId,kind,description,now(),req.user.id);audit(req.user,'Zapisano problem wykończenia',null,JSON.stringify({orderId:id,incidentId:Number(row.lastInsertRowid),kind}),null);});
      return redirect(req,res,`/finishing/orders/${id}`,'Zapisano problem do wyjaśnienia.');
    }
    if(action==='cancel'&&req.method==='POST'){
      role(req.user,...editableRoles);if(order.status==='received')fail(409,'Przyjętego zlecenia nie można anulować. Zapisz korektę jako problem.');
      transaction(()=>{db.prepare("UPDATE finishing_orders SET status='cancelled',updated_at=?,updated_by=? WHERE id=?").run(now(),req.user.id,id);audit(req.user,'Anulowano zlecenie wykończenia',null,JSON.stringify({orderId:id}),null);});
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
    transaction(()=>{db.prepare("UPDATE finishing_incidents SET status='resolved',resolution=?,resolved_at=?,resolved_by=? WHERE id=?").run(resolution,now(),req.user.id,id);audit(req.user,'Rozwiązano problem wykończenia',null,JSON.stringify({incidentId:id,orderId:incident.order_id}),null);});
    return redirect(req,res,`/finishing/orders/${incident.order_id}`,'Oznaczono problem jako rozwiązany.');
  }
  if(p==='/finishing/receipts'&&req.method==='GET')return send(req,res,200,receiptsPage(ctx));
  const labelMatch=p.match(/^\/finishing\/receipts\/(\d+)\/labels$/);
  if(labelMatch&&req.method==='GET')return send(req,res,200,labelPage(ctx,Number(labelMatch[1])),'text/html; charset=utf-8');
  if(p==='/finishing/recipes'&&req.method==='GET')return send(req,res,200,recipesPage(ctx));
  if(p==='/finishing/recipes/new'&&req.method==='GET')return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Nowa receptura',body:`${navTabs('recipes')}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka wykończeń</a><h1>Dodaj recepturę</h1>${recipeForm(ctx)}`}));
  if(p==='/finishing/recipes'&&req.method==='POST'){
    role(req.user,...editableRoles);const name=text(form,'name',200),recipeText=text(form,'recipe_text',12000),plantId=Number(form.finishing_plant_id)||null,width=number(form.target_width_cm),grammage=number(form.target_grammage);
    if(!name||!recipeText)fail(400,'Nazwa i treść receptury są wymagane.');if(width!==null&&width<=0||grammage!==null&&grammage<=0)fail(400,'Szerokość i gramatura muszą być większe od zera.');
    if(plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(plantId))fail(400,'Wybierz aktywną wykończalnię.');
    transaction(()=>{const row=db.prepare('INSERT INTO finishing_recipes(name,finishing_plant_id,raw_symbol,recipe_text,target_color,target_stiffening,target_width_cm,target_grammage,notes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(name,plantId,text(form,'raw_symbol',200),recipeText,text(form,'target_color',160),text(form,'target_stiffening',160),width,grammage,text(form,'notes',3000),now(),req.user.id,now(),req.user.id);audit(req.user,'Dodano recepturę wykończenia',null,JSON.stringify({recipeId:Number(row.lastInsertRowid)}),null);});
    return redirect(req,res,'/finishing/recipes','Dodano recepturę do biblioteki.');
  }
  const recipeEdit=p.match(/^\/finishing\/recipes\/(\d+)\/edit$/);
  if(recipeEdit&&req.method==='GET'){
    const recipe=recipeRecord(db,Number(recipeEdit[1]));if(!recipe)fail(404,'Nie znaleziono receptury.');
    role(req.user,...editableRoles);
    return send(req,res,200,header({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),title:'Edytuj recepturę',body:`${navTabs('recipes')}<a class="breadcrumb" href="/finishing/recipes">← Biblioteka wykończeń</a><h1>Edytuj recepturę</h1>${recipeForm(ctx,recipe)}`}));
  }
  const recipeUpdate=p.match(/^\/finishing\/recipes\/(\d+)$/);
  if(recipeUpdate&&req.method==='POST'){
    role(req.user,...editableRoles);const id=Number(recipeUpdate[1]),name=text(form,'name',200),recipeText=text(form,'recipe_text',12000),plantId=Number(form.finishing_plant_id)||null,width=number(form.target_width_cm),grammage=number(form.target_grammage);
    if(!recipeRecord(db,id))fail(404,'Nie znaleziono receptury.');if(!name||!recipeText)fail(400,'Nazwa i treść receptury są wymagane.');if(width!==null&&width<=0||grammage!==null&&grammage<=0)fail(400,'Szerokość i gramatura muszą być większe od zera.');
    transaction(()=>{db.prepare('UPDATE finishing_recipes SET name=?,finishing_plant_id=?,raw_symbol=?,recipe_text=?,target_color=?,target_stiffening=?,target_width_cm=?,target_grammage=?,notes=?,updated_at=?,updated_by=? WHERE id=?').run(name,plantId,text(form,'raw_symbol',200),recipeText,text(form,'target_color',160),text(form,'target_stiffening',160),width,grammage,text(form,'notes',3000),now(),req.user.id,id);audit(req.user,'Zmieniono recepturę wykończenia',null,JSON.stringify({recipeId:id}),null);});
    return redirect(req,res,'/finishing/recipes','Zapisano zmiany receptury. Zlecenia historyczne zachowały poprzednią kopię.');
  }
  return false;
}

module.exports={handle,orderStatusLabel};
