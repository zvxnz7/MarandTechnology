'use strict';

const V = require('../views');

const editableRoles = ['admin', 'approver', 'technologist'];
const managerRoles = ['admin', 'approver'];
const hidden = (name, value) => `<input type="hidden" name="${V.esc(name)}" value="${V.esc(value)}">`;
const normalizeSearch = value => String(value || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_bale_flags (
      bale_local_id TEXT PRIMARY KEY REFERENCES production_bales(local_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('lost','shipped_out')),
      reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY, shipment_year INTEGER NOT NULL, sequence INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','closed','cancelled')),
      shipment_date TEXT NOT NULL, created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id),
      closed_at TEXT, closed_by INTEGER REFERENCES users(id), cancelled_at TEXT,
      UNIQUE(shipment_year,sequence)
    );
    CREATE TABLE IF NOT EXISTS finishing_plants (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS shipment_articles (
      id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      article_id INTEGER NOT NULL REFERENCES articles(id), sequence INTEGER NOT NULL,
      finishing_plant_id INTEGER REFERENCES finishing_plants(id),
      closed_snapshot TEXT NOT NULL DEFAULT '',
      UNIQUE(shipment_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS shipment_bales (
      id INTEGER PRIMARY KEY, shipment_article_id INTEGER NOT NULL REFERENCES shipment_articles(id),
      bale_local_id TEXT NOT NULL REFERENCES production_bales(local_id), added_at TEXT NOT NULL,
      removed_at TEXT, removed_by INTEGER REFERENCES users(id), removal_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS shipment_bales_active_unique
      ON shipment_bales(bale_local_id) WHERE removed_at IS NULL;
    CREATE INDEX IF NOT EXISTS shipment_bales_by_item ON shipment_bales(shipment_article_id,removed_at,id);
    CREATE TABLE IF NOT EXISTS shipment_corrections (
      id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      removed_bale_local_id TEXT NOT NULL REFERENCES production_bales(local_id),
      replacement_bale_local_id TEXT REFERENCES production_bales(local_id),
      disposition TEXT NOT NULL CHECK(disposition IN ('returned','lost','shipped_out')),
      reason TEXT NOT NULL, created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id)
    );
  `);
  const columns=db.prepare("PRAGMA table_info('shipment_articles')").all();
  const hasPlantColumn=columns.some(column=>column.name==='finishing_plant_id');
  const uniqueIndexes=db.prepare("PRAGMA index_list('shipment_articles')").all().filter(index=>index.unique);
  const uniqueArticleIndex=uniqueIndexes.some(index=>{
    const escaped=String(index.name).replace(/"/g,'""');
    const names=db.prepare(`PRAGMA index_info("${escaped}")`).all().map(column=>column.name);
    return names.length===2&&names.includes('shipment_id')&&names.includes('article_id');
  });
  if(!hasPlantColumn||uniqueArticleIndex){
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try{
      const plantSelect=hasPlantColumn?'finishing_plant_id':'NULL';
      db.exec(`CREATE TABLE shipment_articles_next (
        id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
        article_id INTEGER NOT NULL REFERENCES articles(id), sequence INTEGER NOT NULL,
        finishing_plant_id INTEGER REFERENCES finishing_plants(id), closed_snapshot TEXT NOT NULL DEFAULT '',
        UNIQUE(shipment_id,sequence)
      );
      INSERT INTO shipment_articles_next(id,shipment_id,article_id,sequence,finishing_plant_id,closed_snapshot)
        SELECT id,shipment_id,article_id,sequence,${plantSelect},closed_snapshot FROM shipment_articles;
      DROP TABLE shipment_articles;
      ALTER TABLE shipment_articles_next RENAME TO shipment_articles;
      COMMIT;`);
    }catch(error){try{db.exec('ROLLBACK;')}catch{}throw error;}
    finally{db.exec('PRAGMA foreign_keys=ON;');}
  }
  db.exec(`CREATE TABLE IF NOT EXISTS warehouse_bale_tags (
    bale_local_id TEXT NOT NULL REFERENCES production_bales(local_id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK(tag IN ('second_grade','stripe_risk')),
    created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id),
    PRIMARY KEY(bale_local_id,tag)
  );`);
  const insertPlant=db.prepare('INSERT OR IGNORE INTO finishing_plants(name,name_key,created_at) VALUES(?,?,?)');
  for(const name of ['AN-FARB','MARKO-KOLOR','FEMINA','SAGAN Textiles']) insertPlant.run(name,normalizeSearch(name),new Date().toISOString());
  const cancelled=db.prepare("SELECT id FROM shipments WHERE status='cancelled'").all();
  for(const shipment of cancelled){
    const rows=db.prepare("SELECT id,detail FROM audit WHERE detail LIKE '%shipmentId%'").all().filter(row=>{try{return Number(JSON.parse(row.detail).shipmentId)===shipment.id}catch{return false}});
    for(const row of rows){db.prepare('DELETE FROM audit_articles WHERE audit_id=?').run(row.id);db.prepare('DELETE FROM audit WHERE id=?').run(row.id);}
    db.prepare('DELETE FROM shipment_bales WHERE shipment_article_id IN(SELECT id FROM shipment_articles WHERE shipment_id=?)').run(shipment.id);
    db.prepare('DELETE FROM shipment_articles WHERE shipment_id=?').run(shipment.id);
    db.prepare('DELETE FROM shipments WHERE id=?').run(shipment.id);
  }
}

const money = value => Number(value || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = value => String(value || '').split('-').reverse().join('.');
const shipmentNo = row => `${String(row.sequence).padStart(2, '0')}/${row.shipment_year}`;
const articleNo = (shipment, item) => `${String(shipment.sequence).padStart(2, '0')}-${String(item.sequence).padStart(2, '0')}`;

function activeStockSql() {
  return `coalesce(f.status,'available')='available'
    AND NOT EXISTS (
      SELECT 1 FROM shipment_bales sb
      JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
      JOIN shipments sh ON sh.id=sa.shipment_id
      WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND sh.status='closed'
    )`;
}

function articleBalances(db, q = '') {
  const clauses = ["a.archived_at IS NULL", "a.purged_at IS NULL",
    `NOT EXISTS (SELECT 1 FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND sh.status='closed')`,
    "coalesce(f.status,'available')!='shipped_out'"];
  const params = [];
  for (const word of String(q || '').trim().split(/\s+/).map(normalizeSearch).filter(Boolean)) {
    clauses.push("search_text(a.symbol || ' ' || coalesce(a.description,'')) LIKE ? ESCAPE '\\'");
    params.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return db.prepare(`SELECT a.id,a.symbol,count(*) visible_pieces,
      sum(CASE WHEN coalesce(f.status,'available')='available' THEN 1 ELSE 0 END) stock_pieces,
      round(sum(CASE WHEN coalesce(f.status,'available')='available' THEN b.weight_kg ELSE 0 END),2) stock_weight,
      sum(CASE WHEN f.status='lost' THEN 1 ELSE 0 END) lost_pieces
    FROM articles a JOIN production_bales b ON b.article_id=a.id
    LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    WHERE ${clauses.join(' AND ')} GROUP BY a.id HAVING visible_pieces>0
    ORDER BY a.symbol_key,a.id`).all(...params);
}

function registeredBales(db, articleId) {
  return db.prepare(`SELECT b.*,a.symbol,coalesce(f.status,'available') inventory_status,
      coalesce((SELECT group_concat(tag,',') FROM warehouse_bale_tags bt WHERE bt.bale_local_id=b.local_id),'') quality_tags,
      (SELECT sh.status FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
        JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL LIMIT 1) reserved_status,
      (SELECT sh.id FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
        JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND sh.status='closed' LIMIT 1) closed_shipment
    FROM production_bales b JOIN articles a ON a.id=b.article_id
    LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    WHERE b.article_id=? AND coalesce(f.status,'available')!='shipped_out' AND NOT EXISTS (
      SELECT 1 FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
      JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND sh.status='closed'
    ) ORDER BY b.production_date,b.local_created_at,b.uploaded_at,b.bale_number COLLATE NOCASE`).all(articleId);
}

function baleAvailableForNewShipment(db, localId) {
  return db.prepare(`SELECT b.local_id,b.article_id FROM production_bales b
    LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    WHERE b.local_id=? AND coalesce(f.status,'available')='available'
    AND NOT EXISTS (SELECT 1 FROM shipment_bales sb WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL)`).get(localId);
}

function baleRows(rows, options = {}) {
  const statusText = row => {
    const tags=String(row.quality_tags||'').split(',').filter(Boolean);
    const badges=[];
    if(row.inventory_status==='lost')badges.push('<span class="badge warehouse-lost">Zagubiona</span>');
    if(tags.includes('second_grade'))badges.push('<span class="badge warehouse-second-grade">II gatunek</span>');
    if(tags.includes('stripe_risk'))badges.push('<span class="badge warehouse-stripe-risk">Ryzyko pasiastości</span>');
    if(!badges.length)badges.push(row.reserved_status==='draft'?'<span class="badge submitted">W przygotowaniu</span>':'<span class="badge approved">Dostępna</span>');
    return badges.join('');
  };
  const lotClass = lot => {
    const value = String(lot || '').trim();
    if (!value || /\s/.test(value) || !/\d/.test(value) || !/^[\p{L}\d#./_-]+$/u.test(value)) return 'lot-descriptive';
    let hash = 0;
    for (const char of value.toLocaleUpperCase('pl-PL')) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
    return `lot-color-${hash % 8}`;
  };
  return rows.map((row, index) => {
    const noteForm = options.editNotes ? `<form method="post" action="/warehouse/bales/${encodeURIComponent(row.local_id)}/notes" class="warehouse-note-form" data-warehouse-note-form>${hidden('csrf', options.csrf)}<input name="notes" value="${V.esc(row.notes)}" aria-label="Uwagi do belki ${V.esc(row.bale_number)}" data-warehouse-note><span class="warehouse-note-status" aria-live="polite"></span></form>` : V.esc(row.notes || '—');
    const statusAction = options.manageStatuses && row.inventory_status !== 'lost' && row.reserved_status !== 'draft'
      ? `<label class="warehouse-pick"><input type="checkbox" value="${V.esc(row.local_id)}" data-warehouse-check aria-label="Zaznacz belkę ${V.esc(row.bale_number)}"></label>`
      : options.manageStatuses && row.inventory_status === 'lost'
        ? `<label class="warehouse-pick"><input type="checkbox" value="${V.esc(row.local_id)}" data-warehouse-check aria-label="Zaznacz zagubioną belkę ${V.esc(row.bale_number)}"></label>`
        : '';
    const lot = String(row.lot || '').trim();
    return `<tr class="${row.inventory_status === 'lost' ? 'warehouse-row-lost' : ''}"><td>${index + 1}</td>${options.manageStatuses ? `<td>${statusAction}</td>` : ''}<td>${V.esc(row.symbol)}</td><td class="warehouse-bale-number"><a href="/warehouse/bales/${encodeURIComponent(row.local_id)}">${V.esc(row.bale_number)}</a>${statusText(row)}</td><td>${money(row.weight_kg)}</td><td>${Number(row.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${row.errors}</td><td>${row.stops}</td><td><span class="lot-chip ${lotClass(lot)}">${V.esc(lot || '—')}</span></td><td>${noteForm}</td><td>${date(row.production_date)}</td></tr>`;
  }).join('');
}

function articleSearchResults(ctx, q) {
  if (!q) return '';
  const matches = articleBalances(ctx.db, q).filter(article => article.stock_pieces > 0);
  if (!matches.length) return '<p class="warehouse-search-empty">Brak artykułów z dostępnymi belkami.</p>';
  return `<div class="warehouse-search-results" role="listbox" aria-label="Pasujące artykuły">${matches.map(article => `<a role="option" href="/warehouse?article_id=${article.id}" class="warehouse-article-option"><strong>${V.esc(article.symbol)}</strong><span>${article.stock_pieces} szt · ${money(article.stock_weight)} kg</span></a>`).join('')}</div>`;
}

function catalogPage(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '').trim();
  const rawArticleId = Number(ctx.url.searchParams.get('article_id') || 0);
  if (ctx.url.searchParams.get('partial') === 'search') return articleSearchResults(ctx, q);
  const current = Number.isSafeInteger(rawArticleId) && rawArticleId > 0 ? articleBalances(ctx.db).find(a => a.id === rawArticleId) : null;
  const search = `<form method="get" action="/warehouse" class="warehouse-search" data-warehouse-live-search><input name="q" value="${V.esc(q)}" placeholder="Szukaj artykułu" aria-label="Szukaj artykułu" autocomplete="off" aria-controls="warehouse-search-results"><div class="warehouse-search-results-wrap" id="warehouse-search-results" data-warehouse-search-results>${articleSearchResults(ctx, q)}</div></form>`;
  let selectedView = '';
  if (current) {
    const bales = registeredBales(ctx.db, current.id);
    const availableCount = bales.filter(b => b.inventory_status === 'available').length;
    const currentWeight = bales.filter(b => b.inventory_status === 'available').reduce((sum, b) => sum + b.weight_kg, 0);
    const lostCount = bales.filter(b => b.inventory_status === 'lost').length;
    const canManageStatuses = managerRoles.includes(ctx.req.user.role);
    const lostForm = canManageStatuses ? `<form method="post" action="/warehouse/bales/status" id="warehouse-bulk-status" class="warehouse-bulk-status">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="article_id" value="${current.id}"><input type="hidden" name="bale_ids" value="" data-warehouse-selected><input name="reason" placeholder="Powód zagubienia (opcjonalnie)" maxlength="500"><button name="status" value="lost" class="button danger">Oznacz jako zagubione</button><button name="status" value="second_grade" class="button">Oznacz jako drugi gatunek</button><button name="status" value="stripe_risk" class="button">Oznacz jako ryzyko pasiastości</button>${lostCount||bales.some(b=>b.quality_tags) ? '<button name="status" value="available" class="button">Usuń oznaczenia / przywróć dostępność</button>' : ''}</form>` : '';
    const cols = canManageStatuses ? 11 : 10;
    selectedView = `<section class="warehouse-selected"><div class="pagehead"><div><h2>${V.esc(current.symbol)}</h2><p class="warehouse-stock-summary"><strong>Stan bieżący: ${availableCount} szt · ${money(currentWeight)} kg</strong>${lostCount ? `<span class="warehouse-lost-count">Zagubione: ${lostCount} szt</span>` : ''}</p></div></div>${lostForm}<div class="panel scroll"><table class="listing warehouse-bales-table"><thead><tr>${canManageStatuses ? '<th>LP</th><th>✓</th>' : '<th>LP</th>'}<th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Uwagi</th><th>Data produkcji</th></tr></thead><tbody>${baleRows(bales,{editNotes:editableRoles.includes(ctx.req.user.role),manageStatuses:canManageStatuses,csrf:ctx.req.session.csrf})||`<tr><td colspan="${cols}">Brak belek w bieżącej kartotece.</td></tr>`}</tbody></table></div></section>`;
  }
  const body = `<div class="pagehead"><div><span class="eyebrow">MAGAZYN</span><h1>Kartoteka</h1><p class="muted">Wyszukaj artykuł, aby zobaczyć jego belki i bieżący stan.</p></div></div>${search}${current ? selectedView : ''}`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Kartoteka magazynowa · Marand',body});
}

function baleDetailPage(ctx, localId) {
  const bale = ctx.db.prepare(`SELECT b.*,a.id article_id,a.symbol,coalesce(f.status,'available') inventory_status,f.reason status_reason,
      coalesce((SELECT group_concat(tag,',') FROM warehouse_bale_tags bt WHERE bt.bale_local_id=b.local_id),'') quality_tags,
      sh.id shipment_id,sh.shipment_year,sh.sequence shipment_sequence,sh.status shipment_status,
      sa.sequence article_sequence
    FROM production_bales b JOIN articles a ON a.id=b.article_id
    LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    LEFT JOIN shipment_bales sb ON sb.bale_local_id=b.local_id AND sb.removed_at IS NULL
    LEFT JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
    LEFT JOIN shipments sh ON sh.id=sa.shipment_id
    WHERE b.local_id=?`).get(localId);
  if (!bale) throw Object.assign(new Error('Nie znaleziono belki.'),{status:404});
  let workers=[];try{workers=JSON.parse(bale.workers_json||'[]')}catch{}
  const workerList=workers.length?`<ul>${workers.map(worker=>`<li>${worker.code?`${V.esc(worker.code)} · `:''}${V.esc(worker.name)} · ${Number(worker.meters||0).toLocaleString('pl-PL')} m</li>`).join('')}</ul>`:'—';
  const quality=[];
  if(bale.inventory_status==='lost')quality.push('Zagubiona');
  if(String(bale.quality_tags).split(',').includes('second_grade'))quality.push('Drugi gatunek');
  if(String(bale.quality_tags).split(',').includes('stripe_risk'))quality.push('Ryzyko pasiastości');
  const status=quality.join(' · ')||(bale.inventory_status==='shipped_out'?'Wysłana poza stan':'Dostępna');
  const shipment=bale.shipment_id?`<a href="/shipments/${bale.shipment_id}">${shipmentNo({sequence:bale.shipment_sequence,shipment_year:bale.shipment_year})} · ${bale.shipment_status==='closed'?'Zamknięta':'W przygotowaniu'}</a>`:'—';
  const canEditNote=editableRoles.includes(ctx.req.user.role)&&bale.shipment_status!=='closed'&&bale.inventory_status!=='shipped_out';
  const noteForm=canEditNote?`<form method="post" action="/warehouse/bales/${encodeURIComponent(bale.local_id)}/notes" class="warehouse-detail-note" data-warehouse-note-form>${hidden('csrf',ctx.req.session.csrf)}<input name="notes" value="${V.esc(bale.notes)}" aria-label="Uwagi do belki" data-warehouse-note><span class="warehouse-note-status" aria-live="polite"></span></form>`:V.esc(bale.notes||'—');
  const entries=[['Symbol artykułu',`<a href="/warehouse?article_id=${bale.article_id}">${V.esc(bale.symbol)}</a>`],['Numer belki',V.esc(bale.bale_number)],['Status',V.esc(status)],['Maszyna',V.esc(bale.machine)],['Data produkcji',date(bale.production_date)],['Masa',`${money(bale.weight_kg)} kg`],['Długość',`${Number(bale.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})} m`],['Błędy',String(bale.errors)],['Stopy',String(bale.stops)],['Dziewiarze',workerList],['LOT',V.esc(bale.lot||'—')],['Uwagi',noteForm],['Kontrola',bale.needs_check?'Wymaga sprawdzenia':'—'],['Wysyłka',shipment],['Zarejestrowano lokalnie',V.datepl(bale.local_created_at)],['Wysłano na serwer',V.datepl(bale.uploaded_at)]];
  const body=`<a class="breadcrumb" href="/warehouse?article_id=${bale.article_id}">← Kartoteka ${V.esc(bale.symbol)}</a><div class="pagehead"><div><span class="eyebrow">SZCZEGÓŁY BELKI</span><h1>${V.esc(bale.bale_number)}</h1></div></div><section class="panel padded warehouse-bale-detail"><dl>${entries.map(([label,value])=>`<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl></section>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Belka ${bale.bale_number} · Kartoteka · Marand`,body});
}

function shipmentRecord(db, id) {
  return db.prepare('SELECT * FROM shipments WHERE id=?').get(id);
}

function eraseDraftShipment(db,id) {
  const rows=db.prepare("SELECT id,detail FROM audit WHERE detail LIKE '%shipmentId%'").all().filter(row=>{try{return Number(JSON.parse(row.detail).shipmentId)===id}catch{return false}});
  for(const row of rows){db.prepare('DELETE FROM audit_articles WHERE audit_id=?').run(row.id);db.prepare('DELETE FROM audit WHERE id=?').run(row.id);}
  db.prepare('DELETE FROM shipment_bales WHERE shipment_article_id IN(SELECT id FROM shipment_articles WHERE shipment_id=?)').run(id);
  db.prepare('DELETE FROM shipment_articles WHERE shipment_id=?').run(id);
  db.prepare('DELETE FROM shipments WHERE id=?').run(id);
}

function shipmentArticles(db, shipmentId) {
  return db.prepare(`SELECT sa.id,sa.sequence,sa.closed_snapshot,sa.finishing_plant_id,fp.name finishing_plant_name,a.id article_id,a.symbol,
      count(sb.id) bale_count,round(coalesce(sum(b.weight_kg),0),2) weight_kg
    FROM shipment_articles sa JOIN articles a ON a.id=sa.article_id
    LEFT JOIN finishing_plants fp ON fp.id=sa.finishing_plant_id
    LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id
    WHERE sa.shipment_id=? GROUP BY sa.id ORDER BY sa.sequence`).all(shipmentId);
}

function shipmentBales(db, itemId) {
  return db.prepare(`SELECT b.*,a.symbol FROM shipment_bales sb
    JOIN production_bales b ON b.local_id=sb.bale_local_id
    JOIN articles a ON a.id=b.article_id
    WHERE sb.shipment_article_id=? AND sb.removed_at IS NULL
    ORDER BY b.production_date,b.local_created_at,b.uploaded_at,b.bale_number COLLATE NOCASE`).all(itemId);
}

function shipmentsPage(ctx) {
  const shipments = ctx.db.prepare(`SELECT s.*,
      count(DISTINCT sa.id) article_count,count(sb.id) bale_count,
      round(coalesce(sum(b.weight_kg),0),2) weight_kg
    FROM shipments s LEFT JOIN shipment_articles sa ON sa.shipment_id=s.id
    LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id
    GROUP BY s.id ORDER BY s.shipment_year DESC,s.sequence DESC`).all();
  const canPrepare = editableRoles.includes(ctx.req.user.role);
  const create = canPrepare ? `<form method="post" action="/shipments/create">${hidden('csrf',ctx.req.session.csrf)}<button class="primary">+ Przygotuj wysyłkę</button></form>` : '';
  const rows = shipments.map(s => {
    const items = shipmentArticles(ctx.db,s.id);
    const itemRows = s.status==='cancelled'?'':items.map(item => `<li><a href="/shipments/${s.id}/wz/${item.id}" target="_blank" rel="noopener">${articleNo(s,item)} ${V.esc(item.symbol)}</a> · ${item.bale_count} szt · ${money(item.weight_kg)} kg${item.finishing_plant_name?` · ${V.esc(item.finishing_plant_name)}`:''}</li>`).join('');
    const remove=managerRoles.includes(ctx.req.user.role)&&s.status!=='closed'?`<form method="post" action="/shipments/${s.id}/delete" class="shipment-delete-form" onsubmit="return confirm('Usunąć tę roboczą wysyłkę i zwolnić przypisane belki?')">${hidden('csrf',ctx.req.session.csrf)}<button class="shipment-delete-button" title="Usuń wysyłkę" aria-label="Usuń wysyłkę">×</button></form>`:'';
    return `<tr><td><a class="item-title" href="/shipments/${s.id}">${shipmentNo(s)}</a></td><td>${date(s.shipment_date)}</td><td><span class="badge ${s.status==='closed'?'approved':s.status==='draft'?'submitted':'archived'}">${s.status==='closed'?`Zamknięta · ${V.datepl(s.closed_at)}`:s.status==='draft'?'W przygotowaniu':'Anulowana'}</span></td><td>${s.article_count}</td><td>${s.bale_count}</td><td>${money(s.weight_kg)} kg</td><td><details><summary>Dokumenty</summary><ul class="shipment-doc-list">${itemRows||'<li>Brak artykułów.</li>'}</ul></details></td><td class="shipment-delete-cell">${remove}</td></tr>`;
  }).join('');
  const body = `<div class="pagehead"><div><span class="eyebrow">MAGAZYN</span><h1>Wysyłka</h1><p class="muted">Przygotuj transport, przypisz belki i zamknij wysyłkę po sprawdzeniu.</p></div>${create}</div><div class="panel scroll"><table class="listing compact"><thead><tr><th>Nr wysyłki</th><th>Data</th><th>Status</th><th>Artykuły</th><th>Belki</th><th>Masa</th><th>Specyfikacje</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="8">Nie ma jeszcze wysyłek.</td></tr>'}</tbody></table></div>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Wysyłka · Marand',body});
}

function shipmentPage(ctx, shipment) {
  const items = shipmentArticles(ctx.db,shipment.id);
  const canEdit = editableRoles.includes(ctx.req.user.role) && shipment.status==='draft';
  const canClose = managerRoles.includes(ctx.req.user.role) && shipment.status==='draft';
  const itemViews = items.map(item => {
    const bales = shipmentBales(ctx.db,item.id);
    const baleRowsHtml = bales.map((b,index) => `<tr><td>${index+1}</td><td>${V.esc(b.symbol)}</td><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${V.esc(b.lot||'—')}</td><td>${date(b.production_date)}</td>${canEdit?`<td><form method="post" action="/shipments/${shipment.id}/remove">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="bale_id" value="${V.esc(b.local_id)}"><button class="link danger">Usuń</button></form></td>`:''}</tr>`).join('');
    return `<details class="shipment-article" open><summary>${articleNo(shipment,item)} · ${V.esc(item.symbol)} <span>${bales.length} szt · ${money(item.weight_kg)} kg${item.finishing_plant_name?` · ${V.esc(item.finishing_plant_name)}`:''}</span></summary><div class="shipment-article-actions"><a class="button" target="_blank" rel="noopener" href="/shipments/${shipment.id}/wz/${item.id}">Podgląd WZ</a></div><div class="panel scroll"><table class="listing compact"><thead><tr><th>LP</th><th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>LOT</th><th>Data</th>${canEdit?'<th></th>':''}</tr></thead><tbody>${baleRowsHtml||'<tr><td colspan="8">Brak belek.</td></tr>'}</tbody></table></div></details>`;
  }).join('');
  const status = shipment.status==='closed'?`<span class="badge approved">Zamknięta · ${V.datepl(shipment.closed_at)}</span>`:shipment.status==='cancelled'?'<span class="badge archived">Anulowana</span>':'<span class="badge submitted">W przygotowaniu</span>';
  const details = canEdit ? `<form method="post" action="/shipments/${shipment.id}/date" class="shipment-date-form">${hidden('csrf',ctx.req.session.csrf)}<label>Data wysyłki<input type="date" name="shipment_date" value="${V.esc(shipment.shipment_date)}" required></label><button>Zapisz datę</button></form>` : `<p>Data wysyłki: <strong>${date(shipment.shipment_date)}</strong></p>`;
  const actions = canEdit ? `<div class="actions"><a class="button primary" href="/shipments/${shipment.id}/select">+ Dodaj artykuł / belki</a></div>` : '';
  const close = canClose && items.some(item=>item.bale_count>0) ? `<form method="post" action="/shipments/${shipment.id}/close" class="shipment-close-form">${hidden('csrf',ctx.req.session.csrf)}<label class="check"><input type="checkbox" name="confirm_close" value="1" required> Potwierdzam zamknięcie wysyłki. Belki znikną z bieżącego rejestru.</label><button class="primary">Zamknij wysyłkę</button></form>` : '';
  const cancel = canClose ? `<form method="post" action="/shipments/${shipment.id}/cancel">${hidden('csrf',ctx.req.session.csrf)}<button class="danger">Anuluj wysyłkę i zwolnij belki</button></form>` : '';
  const correction = shipment.status==='closed' && managerRoles.includes(ctx.req.user.role) ? correctionForm(ctx,shipment,items) : '';
  const body = `<a class="breadcrumb" href="/shipments">← Wysyłki</a><div class="pagehead"><div><span class="eyebrow">${status}</span><h1>Wysyłka ${shipmentNo(shipment)}</h1>${details}</div><div class="shipment-totals"><strong>${items.reduce((s,x)=>s+x.bale_count,0)} szt</strong><strong>${money(items.reduce((s,x)=>s+x.weight_kg,0))} kg</strong></div></div>${actions}${itemViews||'<p class="muted">Dodaj artykuł i wybierz belki do wysyłki.</p>'}<div class="shipment-final-actions">${close}${cancel}</div>${correction}`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Wysyłka ${shipmentNo(shipment)} · Marand`,body});
}

function finishingPlantsPage(ctx) {
  role(ctx.req.user,...managerRoles);
  const plants=ctx.db.prepare('SELECT id,name,active FROM finishing_plants ORDER BY active DESC,name COLLATE NOCASE').all();
  const rows=plants.map(plant=>`<tr><td>${V.esc(plant.name)}</td><td><span class="badge ${plant.active?'approved':'archived'}">${plant.active?'Aktywna':'Nieaktywna'}</span></td><td><form method="post" action="/settings/finishing-plants/${plant.id}/toggle">${hidden('csrf',ctx.req.session.csrf)}<button>${plant.active?'Dezaktywuj':'Aktywuj'}</button></form></td></tr>`).join('');
  const body=`<div class="pagehead"><div><span class="eyebrow">USTAWIENIA MAGAZYNU</span><h1>Wykończalnie</h1><p class="muted">Lista jest używana przy dodawaniu belek do specyfikacji wysyłki.</p></div></div><section class="panel padded"><form method="post" action="/settings/finishing-plants" class="finishing-plant-add">${hidden('csrf',ctx.req.session.csrf)}<label>Nowa wykończalnia<input name="name" maxlength="100" required placeholder="Nazwa wykończalni"></label><button class="primary">Dodaj</button></form><div class="scroll"><table class="listing compact"><thead><tr><th>Nazwa</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Wykończalnie · Marand',body});
}

function correctionForm(ctx, shipment, items) {
  const shipped = items.flatMap(item => shipmentBales(ctx.db,item.id).map(b => ({...b,itemId:item.id})));
  const candidates = ctx.db.prepare(`SELECT b.local_id,b.bale_number,b.article_id,a.symbol FROM production_bales b
    JOIN articles a ON a.id=b.article_id LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    WHERE coalesce(f.status,'available')='available' AND NOT EXISTS (SELECT 1 FROM shipment_bales sb WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL)
    ORDER BY b.production_date,b.local_created_at,b.bale_number`).all();
  const history=ctx.db.prepare(`SELECT c.*,old.bale_number old_number,old_a.symbol old_symbol,
      new.bale_number new_number,new_a.symbol new_symbol,u.name author
    FROM shipment_corrections c JOIN production_bales old ON old.local_id=c.removed_bale_local_id
    JOIN articles old_a ON old_a.id=old.article_id LEFT JOIN production_bales new ON new.local_id=c.replacement_bale_local_id
    LEFT JOIN articles new_a ON new_a.id=new.article_id LEFT JOIN users u ON u.id=c.created_by
    WHERE c.shipment_id=? ORDER BY c.id DESC`).all(shipment.id);
  return `<section class="panel padded shipment-correction"><h2>Korekta zamkniętej wysyłki</h2><p class="muted">Pierwotny WZ zostaje zachowany. Korekta otrzyma osobny dokument powiązany z wysyłką.</p><form method="post" action="/shipments/${shipment.id}/correct">${hidden('csrf',ctx.req.session.csrf)}<label>Usuń z WZ<select name="old_bale_id" required><option value="">Wybierz belkę</option>${shipped.map(b=>`<option value="${V.esc(b.local_id)}">${V.esc(b.symbol)} · ${V.esc(b.bale_number)}</option>`).join('')}</select></label><label>Dodaj zamiast niej belkę (opcjonalnie)<select name="new_bale_id"><option value="">Nie dodawaj innej</option>${candidates.map(b=>`<option value="${V.esc(b.local_id)}">${V.esc(b.symbol)} · ${V.esc(b.bale_number)}</option>`).join('')}</select></label><label>Co stało się z błędną belką?<select name="disposition" required><option value="returned">Wróciła do bieżącego stanu</option><option value="lost">Jest zagubiona</option><option value="shipped_out">Wyjechała i pozostaje poza stanem</option></select></label><label>Powód korekty<input name="reason" maxlength="500" required></label><button class="primary">Zapisz korektę</button></form>${history.length?`<h3>Historia korekt</h3><ul>${history.map(c=>`<li><a href="/shipments/${shipment.id}/correction/${c.id}" target="_blank" rel="noopener">Korekta · ${V.esc(c.old_symbol)} ${V.esc(c.old_number)}${c.new_number?` → ${V.esc(c.new_symbol)} ${V.esc(c.new_number)}`:''} · ${V.datepl(c.created_at)}</a></li>`).join('')}</ul>`:''}</section>`;
}

function shipmentSelectionPage(ctx, shipment) {
  const q = String(ctx.url.searchParams.get('q') || '').trim();
  const articles = articleBalances(ctx.db,q).filter(a=>a.stock_pieces>0);
  if(ctx.url.searchParams.get('partial')==='search') return shipmentArticleSearchResults(articles,shipment.id);
  const articleId = Number(ctx.url.searchParams.get('article_id') || 0);
  const selectedArticle = articles.find(a=>a.id===articleId);
  const articleForm = `<form method="get" action="/shipments/${shipment.id}/select" class="shipment-select-article" data-shipment-live-search><label>Szukaj artykułu<input name="q" value="${V.esc(q)}" placeholder="Wpisz symbol artykułu" autocomplete="off" aria-controls="shipment-search-results"></label><input type="hidden" name="article_id" value="${selectedArticle?selectedArticle.id:''}"><div id="shipment-search-results" class="warehouse-search-results-wrap" data-shipment-search-results>${q?shipmentArticleSearchResults(articles,shipment.id):''}</div></form>`;
  const plants=ctx.db.prepare('SELECT id,name FROM finishing_plants WHERE active=1 ORDER BY name COLLATE NOCASE').all();
  const currentItems = shipmentArticles(ctx.db,shipment.id);
  const chosenRows = currentItems.map(item => {
    const bales = shipmentBales(ctx.db,item.id);
    return `<section class="shipment-picked-article"><h3>${articleNo(shipment,item)} · ${V.esc(item.symbol)} <small>${bales.length} szt · ${money(item.weight_kg)} kg</small></h3><div class="panel scroll"><table class="listing compact"><thead><tr><th>Nr szt.</th><th>Masa kg</th><th>Data</th><th></th></tr></thead><tbody>${bales.map(b=>`<tr><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${date(b.production_date)}</td><td><form method="post" action="/shipments/${shipment.id}/remove">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="bale_id" value="${V.esc(b.local_id)}"><button class="link danger">Usuń</button></form></td></tr>`).join('')}</tbody></table></div></section>`;
  }).join('')||'<p class="muted">Nie wybrano jeszcze belek.</p>';
  let availablePanel = '<p class="muted">Wybierz artykuł, aby zobaczyć dostępne belki.</p>';
  if(selectedArticle) {
    const available = ctx.db.prepare(`SELECT b.* FROM production_bales b LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
      WHERE b.article_id=? AND coalesce(f.status,'available')='available'
      AND NOT EXISTS (SELECT 1 FROM shipment_bales sb WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL)
      ORDER BY b.production_date,b.local_created_at,b.uploaded_at,b.bale_number COLLATE NOCASE`).all(selectedArticle.id);
    const trs = available.map((b,i)=>`<tr><td><input type="checkbox" value="${V.esc(b.local_id)}" data-range-select aria-label="Belka ${V.esc(b.bale_number)}"></td><td>${i+1}</td><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${V.esc(b.lot||'—')}</td><td>${date(b.production_date)}</td></tr>`).join('');
    availablePanel = `<div class="panel scroll"><table class="listing compact"><thead><tr><th></th><th>LP</th><th>Nr szt.</th><th>kg</th><th>metry</th><th>LOT</th><th>Data produkcji</th></tr></thead><tbody>${trs||'<tr><td colspan="7">Brak dostępnych belek.</td></tr>'}</tbody></table></div>`;
  }
  const picker=selectedArticle?`<form method="post" action="/shipments/${shipment.id}/add" data-range-selection class="shipment-picker shipment-available-form">${hidden('csrf',ctx.req.session.csrf)}${hidden('article_id',selectedArticle.id)}<input type="hidden" name="bale_ids" value="" data-range-values><section><h2>Dostępne belki · ${V.esc(selectedArticle.symbol)}</h2><label class="check shipment-select-all"><input type="checkbox" data-range-all> Zaznacz wszystkie dostępne belki artykułu</label><p class="muted small">Kliknij pierwszą belkę, a następnie ostatnią z wciśniętym Shift, aby zaznaczyć zakres.</p>${availablePanel}</section><div class="shipment-picker-controls"><label>Wykończalnia<select name="finishing_plant_id" required><option value="">Wybierz</option>${plants.map(plant=>`<option value="${plant.id}">${V.esc(plant.name)}</option>`).join('')}</select></label><button class="primary">Dodaj belki</button></div><section><h2>Belki w wysyłce</h2>${chosenRows}</section></form>`:`<div class="shipment-picker"><section><h2>Dostępne belki</h2><p class="muted">Wpisz symbol i wybierz artykuł.</p></section><section></section><section><h2>Belki w wysyłce</h2>${chosenRows}</section></div>`;
  const totals = currentItems.reduce((s,x)=>({pieces:s.pieces+x.bale_count,weight:s.weight+x.weight_kg}),{pieces:0,weight:0});
  const body = `<a class="breadcrumb" href="/shipments/${shipment.id}">← Wysyłka ${shipmentNo(shipment)}</a><div class="pagehead"><div><span class="eyebrow">WYBÓR BELEK</span><h1>Dodaj artykuł do wysyłki ${shipmentNo(shipment)}</h1></div><div class="shipment-totals"><strong>${totals.pieces} szt</strong><strong>${money(totals.weight)} kg</strong></div></div>${articleForm}${picker}`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Wybór belek · ${shipmentNo(shipment)} · Marand`,body});
}

function shipmentArticleSearchResults(articles, shipmentId) {
  const matches=articles.filter(article=>article.stock_pieces>0);
  if(!matches.length) return '<p class="warehouse-search-empty">Brak artykułów z dostępnymi belkami.</p>';
  return `<div class="warehouse-search-results" role="listbox" aria-label="Pasujące artykuły">${matches.map(article=>`<a role="option" class="warehouse-article-option" href="/shipments/${shipmentId}/select?article_id=${article.id}&q=${encodeURIComponent(article.symbol)}"><strong>${V.esc(article.symbol)}</strong><span>${article.stock_pieces} szt · ${money(article.stock_weight)} kg</span></a>`).join('')}</div>`;
}

function wzPage(ctx, shipment, item) {
  const liveArticle = ctx.db.prepare('SELECT a.*,r.version,r.payload FROM articles a LEFT JOIN records r ON r.id=a.active_spec WHERE a.id=?').get(item.article_id);
  let snapshot=null;try{snapshot=item.closed_snapshot?JSON.parse(item.closed_snapshot):null}catch{}
  const article = snapshot?.article || liveArticle;
  let payload = {};
  try { payload = JSON.parse(article?.payload || '{}'); } catch {}
  const bales = Array.isArray(snapshot?.bales) ? snapshot.bales : shipmentBales(ctx.db,item.id);
  const finishingPlant=snapshot?.finishingPlant||item.finishing_plant_name||'';
  const rows = bales.map((b,i)=>`<tr><td>${i+1}</td><td>${V.esc(b.symbol)}</td><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${b.errors}</td><td>${b.stops}</td><td>${V.esc(b.lot||'')}</td><td>${V.esc(b.notes||'')}</td><td>${date(b.production_date)}</td></tr>`).join('');
  const totalWeight = bales.reduce((sum,b)=>sum+b.weight_kg,0);
  const finish = Array.isArray(payload.finished) ? payload.finished : [];
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {};
  const targets = payload.targets && typeof payload.targets === 'object' ? payload.targets : {};
  const techRows = [
    ...V.RAW_METRICS.map(([key,label])=>[`${label} · surowa`,raw[key]]),
    ...V.TARGET_METRICS.map(([key,label])=>[`${label} · docelowa`,targets[key]]),
  ].filter(([,value])=>value!==undefined&&value!==null&&String(value).trim()!=='');
  const finishTable = techRows.length||finish.length ? `<h2>Dane technologiczne artykułu</h2><table class="tech"><thead><tr><th>Pozycja</th><th>Parametry</th></tr></thead><tbody>${techRows.map(([label,value])=>`<tr><td>${V.esc(label)}</td><td>${V.esc(value)}</td></tr>`).join('')}${finish.map((row,index)=>`<tr><td>Wykończenie ${index+1}${row.name?` · ${V.esc(row.name)}`:''}</td><td>${V.FINISH.filter(([key])=>key!=='name'&&row[key]).map(([key,label])=>`${V.esc(label)}: ${V.esc(row[key])}`).join(' · ')||'—'}</td></tr>`).join('')}</tbody></table>` : '';
  const notes = [payload.raw_comments,payload.finished_comments,payload.comments].filter(Boolean).map(V.esc).join('<br>');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${articleNo(shipment,item)} ${V.esc(article?.symbol||'')} · WZ</title><link rel="stylesheet" href="/static/app.css"><script defer src="/static/app.js"></script><style>@page{size:A4 portrait;margin:9mm}.wz-page{max-width:210mm;margin:12px auto;background:#fff;padding:8mm;color:#111;font:10px/1.25 Arial,sans-serif}.wz-toolbar{display:flex;justify-content:space-between;align-items:center;max-width:210mm;margin:12px auto}.wz-page h1{font-size:18px;letter-spacing:0;margin:4px 0;text-align:center}.wz-page h2{background:#555;color:#fff;font-size:10px;text-align:center;padding:4px;margin:10px 0 0}.wz-meta{display:grid;grid-template-columns:1fr 1fr;gap:3px;border:1px solid #555;padding:6px;margin:8px 0}.wz-page table{width:100%;border-collapse:collapse;table-layout:fixed}.wz-page th,.wz-page td{border:1px solid #555;padding:3px 2px;vertical-align:middle;text-align:center;overflow-wrap:anywhere}.wz-page th{background:#eee;font-weight:600}.wz-page td{font-weight:600}.wz-page .bales th:nth-child(1){width:5%}.wz-page .bales th:nth-child(2){width:16%}.wz-page .bales th:nth-child(3){width:11%}.wz-page .bales th:nth-child(4){width:8%}.wz-page .bales th:nth-child(5),.wz-page .bales th:nth-child(6){width:6%}.wz-page .bales th:nth-child(7){width:18%}.wz-page .bales th:nth-child(8){width:17%}.wz-page .bales th:nth-child(9){width:13%}.wz-page .notes{margin-top:6px;white-space:pre-wrap}.wz-page .wz-total{font-weight:bold;text-align:right;margin:8px 0}.wz-page .tech td{text-align:left}.wz-page .signatures{display:flex;gap:25px;margin:20px 0}.wz-page .signatures span{flex:1;border-bottom:1px solid #555;padding-bottom:18px}@media print{body{background:#fff}.wz-toolbar{display:none}.wz-page{margin:0;padding:0;max-width:none}.wz-page h2{print-color-adjust:exact;-webkit-print-color-adjust:exact}.bales tr,.tech tr{break-inside:avoid}}</style></head><body><div class="wz-toolbar"><button data-print>Drukuj / zapisz jako PDF</button><a href="/shipments/${shipment.id}">Wróć do wysyłki</a></div><main class="wz-page"><h1>SPECYFIKACJA WYSYŁKI · ${V.esc(article?.symbol||'')}</h1><div class="wz-meta"><div><b>Klient:</b> ${V.esc(payload.client||'—')}</div><div><b>Symbol:</b> ${V.esc(payload.symbol||article?.symbol||'')}</div><div><b>Dostawca:</b> MARAND · ul. Szadkowska 72, 98-220 Zduńska Wola</div><div><b>Przesunięcie magazynowe:</b> ${shipmentNo(shipment)}</div><div><b>Odbiorca:</b> MARAND · ul. Burtowa 10, 93-478 Łódź</div><div><b>Dnia:</b> ${date(shipment.shipment_date)} · <b>Dokument:</b> ${articleNo(shipment,item)}</div></div><h2>Wykaz belek</h2><table class="bales"><thead><tr><th>Lp.</th><th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Błędy</th><th>Stop</th><th>LOT</th><th>Uwagi</th><th>Data produkcji</th></tr></thead><tbody>${rows||'<tr><td colspan="9">Brak belek.</td></tr>'}</tbody></table><div class="wz-total">Suma: ${bales.length} szt. · ${money(totalWeight)} kg</div>${finishingPlant?`<div><b>Wykończalnia:</b> ${V.esc(finishingPlant)}</div>`:''}${finishTable}${notes?`<div class="notes">${notes}</div>`:''}<div class="signatures"><span>Wydano</span><span>Odebrano</span></div></main></body></html>`;
}

function correctionPage(ctx, shipment, correctionId) {
  const c=ctx.db.prepare(`SELECT c.*,old.bale_number old_number,old_a.symbol old_symbol,
      new.bale_number new_number,new_a.symbol new_symbol,u.name author
    FROM shipment_corrections c JOIN production_bales old ON old.local_id=c.removed_bale_local_id
    JOIN articles old_a ON old_a.id=old.article_id LEFT JOIN production_bales new ON new.local_id=c.replacement_bale_local_id
    LEFT JOIN articles new_a ON new_a.id=new.article_id LEFT JOIN users u ON u.id=c.created_by
    WHERE c.id=? AND c.shipment_id=?`).get(correctionId,shipment.id);
  if(!c) throw Object.assign(new Error('Nie znaleziono korekty.'),{status:404});
  const disposition={returned:'Wróciła do bieżącego stanu',lost:'Zagubiona',shipped_out:'Wyjechała i pozostaje poza stanem'}[c.disposition];
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Korekta WZ ${shipmentNo(shipment)}</title><style>@page{size:A4 portrait;margin:15mm}body{font:12px/1.5 Arial,sans-serif;color:#111}.sheet{max-width:180mm;margin:20px auto}.bar{margin-bottom:24px}h1{text-align:center;font-size:21px}.meta{border:1px solid #555;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.row{margin:28px 0;padding:16px;border:1px solid #555}.label{color:#666}.sign{display:flex;gap:30px;margin-top:55px}.sign span{flex:1;border-bottom:1px solid #555;padding-bottom:35px}@media print{.bar{display:none}.sheet{margin:0}}</style><script defer src="/static/app.js"></script></head><body><div class="bar"><button data-print>Drukuj / zapisz jako PDF</button> <a href="/shipments/${shipment.id}">Wróć do wysyłki</a></div><main class="sheet"><h1>KOREKTA SPECYFIKACJI WYSYŁKI</h1><div class="meta"><div><b>Wysyłka:</b> ${shipmentNo(shipment)}</div><div><b>Data wysyłki:</b> ${date(shipment.shipment_date)}</div><div><b>Korekta nr:</b> ${correctionId}</div><div><b>Data korekty:</b> ${V.datepl(c.created_at)}</div></div><section class="row"><p><span class="label">Usunięto z wykazu:</span> <b>${V.esc(c.old_symbol)} · ${V.esc(c.old_number)}</b></p>${c.new_number?`<p><span class="label">Dodano:</span> <b>${V.esc(c.new_symbol)} · ${V.esc(c.new_number)}</b></p>`:''}<p><span class="label">Rozliczenie błędnej belki:</span> <b>${disposition}</b></p><p><span class="label">Powód:</span> ${V.esc(c.reason)}</p></section><p>Wystawił(a): ${V.esc(c.author||'')}</p><div class="sign"><span>Wydano</span><span>Odebrano</span></div></main></body></html>`;
}

function handle(ctx) {
  const {req,res,p,db,send,redirect,role,transaction}=ctx;
  if(p==='/settings'&&req.method==='GET') return send(req,res,200,finishingPlantsPage(ctx));
  if(p==='/settings/finishing-plants'&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz nazwę wykończalni.'),{status:400});
    try{db.prepare('INSERT INTO finishing_plants(name,name_key,active,created_at,created_by) VALUES(?,?,1,?,?)').run(name,normalizeSearch(name),ctx.now(),req.user.id);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Wykończalnia o takiej nazwie już istnieje.'),{status:409});throw error;}
    return redirect(req,res,'/settings','Dodano wykończalnię.');
  }
  const plantToggle=p.match(/^\/settings\/finishing-plants\/(\d+)\/toggle$/);
  if(plantToggle&&req.method==='POST'){
    role(req.user,...managerRoles);
    const result=db.prepare('UPDATE finishing_plants SET active=1-active WHERE id=?').run(Number(plantToggle[1]));
    if(!result.changes) throw Object.assign(new Error('Nie znaleziono wykończalni.'),{status:404});
    return redirect(req,res,'/settings','Zmieniono status wykończalni.');
  }
  if(p==='/warehouse'&&req.method==='GET') return send(req,res,200,catalogPage(ctx));
  if(p==='/warehouse/bales/status'&&req.method==='POST') {
    role(req.user,...managerRoles);
    const ids=String(ctx.form.bale_ids||'').split(',').filter(Boolean);
    const status=String(ctx.form.status||''), reason=String(ctx.form.reason||'').trim().slice(0,500), articleId=Number(ctx.form.article_id);
    if(!ids.length||!['lost','available','second_grade','stripe_risk'].includes(status)) throw Object.assign(new Error('Zaznacz prawidłowe belki.'),{status:400});
    transaction(()=>{
      for(const id of ids){
        const bale=db.prepare(`SELECT b.local_id FROM production_bales b WHERE b.local_id=? AND b.article_id=? AND NOT EXISTS(SELECT 1 FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND (sh.status='closed' OR sh.status='draft'))`).get(id,articleId);
        if(!bale) throw Object.assign(new Error('Niektóre zaznaczone belki są już przypisane do wysyłki lub ich stan się zmienił.'),{status:409});
        if(status==='lost') db.prepare(`INSERT INTO warehouse_bale_flags(bale_local_id,status,reason,updated_at,updated_by) VALUES(?,'lost',?,?,?) ON CONFLICT(bale_local_id) DO UPDATE SET status='lost',reason=excluded.reason,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(id,reason,ctx.now(),req.user.id);
        else if(status==='available'){
          db.prepare("DELETE FROM warehouse_bale_flags WHERE bale_local_id=? AND status='lost'").run(id);
          db.prepare('DELETE FROM warehouse_bale_tags WHERE bale_local_id=?').run(id);
        }else db.prepare('INSERT OR IGNORE INTO warehouse_bale_tags(bale_local_id,tag,created_at,created_by) VALUES(?,?,?,?)').run(id,status,ctx.now(),req.user.id);
      }
      const action={lost:'Oznaczono belki jako zagubione',available:'Usunięto oznaczenia belek / przywrócono dostępność',second_grade:'Oznaczono belki jako drugi gatunek',stripe_risk:'Oznaczono ryzyko pasiastości belek'}[status];
      ctx.audit(req.user,action,null,JSON.stringify({articleId,ids,reason}),articleId);
    });
    const message={lost:'Belki oznaczono jako zagubione.',available:'Usunięto oznaczenia i przywrócono dostępność.',second_grade:'Oznaczono belki jako drugi gatunek.',stripe_risk:'Oznaczono ryzyko pasiastości belek.'}[status];
    return redirect(req,res,`/warehouse?article_id=${articleId}`,message);
  }
  const noteMatch=p.match(/^\/warehouse\/bales\/([^/]+)\/notes$/);
  if(noteMatch&&req.method==='POST'){
    role(req.user,...editableRoles);
    const baleId=decodeURIComponent(noteMatch[1]),note=String(ctx.form.notes||'').trim().slice(0,1000);
    const bale=db.prepare(`SELECT b.article_id FROM production_bales b WHERE b.local_id=? AND NOT EXISTS(SELECT 1 FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND sh.status='closed')`).get(baleId);
    if(!bale) throw Object.assign(new Error('Belka nie jest już w bieżącej kartotece.'),{status:404});
    db.prepare('UPDATE production_bales SET notes=? WHERE local_id=?').run(note,baleId);
    ctx.audit(req.user,'Zmieniono uwagi do belki',null,JSON.stringify({baleId,notes:note}),bale.article_id);
    if(req.headers['x-requested-with']==='fetch') return send(req,res,200,JSON.stringify({ok:true}), 'application/json; charset=utf-8');
    return redirect(req,res,`/warehouse?article_id=${bale.article_id}`,'Uwagi do belki zapisano.');
  }
  const baleDetailMatch=p.match(/^\/warehouse\/bales\/([^/]+)$/);
  if(baleDetailMatch&&req.method==='GET') return send(req,res,200,baleDetailPage(ctx,decodeURIComponent(baleDetailMatch[1])));
  if(p==='/shipments'&&req.method==='GET') return send(req,res,200,shipmentsPage(ctx));
  if(p==='/shipments/create'&&req.method==='POST'){
    role(req.user,...editableRoles);
    const today=ctx.todayWarsaw(),year=Number(today.slice(0,4));
    const id=transaction(()=>{
      const sequence=(db.prepare('SELECT coalesce(max(sequence),0)+1 next FROM shipments WHERE shipment_year=?').get(year).next);
      return Number(db.prepare("INSERT INTO shipments(shipment_year,sequence,status,shipment_date,created_at,created_by) VALUES(?,?,'draft',?,?,?)").run(year,sequence,today,ctx.now(),req.user.id).lastInsertRowid);
    });
    ctx.audit(req.user,'Utworzono roboczą wysyłkę',null,JSON.stringify({shipmentId:id,year}),null);
    return redirect(req,res,`/shipments/${id}`,'Utworzono nową wysyłkę.');
  }
  const pathMatch=p.match(/^\/shipments\/(\d+)(?:\/(select|add|remove|date|close|cancel|delete|correct|wz\/(\d+)|correction\/(\d+)))?$/);
  if(pathMatch){
    const id=Number(pathMatch[1]),action=pathMatch[2]||'',itemId=Number(pathMatch[3]||0),correctionId=Number(pathMatch[4]||0),shipment=shipmentRecord(db,id);
    if(!shipment) throw Object.assign(new Error('Nie znaleziono wysyłki.'),{status:404});
    if(action.startsWith('wz/')){
      const item=shipmentArticles(db,id).find(x=>x.id===itemId);
      if(!item) throw Object.assign(new Error('Nie znaleziono dokumentu artykułu w tej wysyłce.'),{status:404});
      return send(req,res,200,wzPage(ctx,shipment,item),'text/html; charset=utf-8');
    }
    if(action.startsWith('correction/')) return send(req,res,200,correctionPage(ctx,shipment,correctionId),'text/html; charset=utf-8');
    if(action==='select'&&req.method==='GET'){
      role(req.user,...editableRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Zamkniętej wysyłki nie można zmieniać.'),{status:409});
      return send(req,res,200,shipmentSelectionPage(ctx,shipment));
    }
    if(action==='delete'&&req.method==='POST'){
      role(req.user,...managerRoles);
      if(!['draft','cancelled'].includes(shipment.status)) throw Object.assign(new Error('Można usuwać tylko robocze lub anulowane wysyłki.'),{status:409});
      transaction(()=>eraseDraftShipment(db,id));
      return redirect(req,res,'/shipments','Usunięto wysyłkę i zwolniono przypisane belki.');
    }
    if(action==='add'&&req.method==='POST'){
      role(req.user,...editableRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Zamkniętej wysyłki nie można zmieniać.'),{status:409});
      const ids=[...new Set(String(ctx.form.bale_ids||'').split(',').filter(Boolean))];
      if(!ids.length) throw Object.assign(new Error('Zaznacz belki do dodania.'),{status:400});
      const articleId=Number(ctx.form.article_id),plantId=Number(ctx.form.finishing_plant_id);
      if(!articleId||!plantId||!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(plantId)) throw Object.assign(new Error('Wybierz aktywną wykończalnię.'),{status:400});
      transaction(()=>{
        const verified=[];
        for(const baleId of ids){
          const bale=baleAvailableForNewShipment(db,baleId);
          if(!bale) throw Object.assign(new Error(`Belka ${baleId} nie jest już dostępna do wysyłki. Odśwież listę.`),{status:409});
          if(Number(bale.article_id)!==articleId) throw Object.assign(new Error('Wszystkie zaznaczone belki muszą pochodzić z wybranego artykułu.'),{status:400});
          verified.push(baleId);
        }
        const seq=db.prepare('SELECT coalesce(max(sequence),0)+1 next FROM shipment_articles WHERE shipment_id=?').get(id).next;
        const itemId=Number(db.prepare('INSERT INTO shipment_articles(shipment_id,article_id,sequence,finishing_plant_id) VALUES(?,?,?,?)').run(id,articleId,seq,plantId).lastInsertRowid);
        for(const baleId of verified) db.prepare('INSERT INTO shipment_bales(shipment_article_id,bale_local_id,added_at) VALUES(?,?,?)').run(itemId,baleId,ctx.now());
      });
      ctx.audit(req.user,'Dodano belki do roboczej wysyłki',null,JSON.stringify({shipmentId:id,baleIds:ids}),null);
      return redirect(req,res,`/shipments/${id}/select?article_id=${articleId}&q=${encodeURIComponent(db.prepare('SELECT symbol FROM articles WHERE id=?').get(articleId)?.symbol||'')}`,'Dodano zaznaczone belki do nowej specyfikacji.');
    }
    if(action==='remove'&&req.method==='POST'){
      role(req.user,...editableRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Zamkniętej wysyłki nie można zmieniać.'),{status:409});
      const baleId=String(ctx.form.bale_id||'');
      const result=db.prepare(`UPDATE shipment_bales SET removed_at=?,removed_by=?,removal_reason='Usunięto z roboczej wysyłki' WHERE id=(SELECT sb.id FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id WHERE sa.shipment_id=? AND sb.bale_local_id=? AND sb.removed_at IS NULL)`).run(ctx.now(),req.user.id,id,baleId);
      if(!result.changes) throw Object.assign(new Error('Belka nie jest przypisana do tej wysyłki.'),{status:404});
      return redirect(req,res,`/shipments/${id}/select`,'Belkę usunięto z roboczej wysyłki.');
    }
    if(action==='date'&&req.method==='POST'){
      role(req.user,...editableRoles);
      const shipmentDate=String(ctx.form.shipment_date||'');
      if(shipment.status!=='draft'||!/^\d{4}-\d{2}-\d{2}$/.test(shipmentDate)||Number.isNaN(Date.parse(`${shipmentDate}T12:00:00Z`))) throw Object.assign(new Error('Nieprawidłowa data wysyłki.'),{status:400});
      db.prepare('UPDATE shipments SET shipment_date=? WHERE id=?').run(shipmentDate,id);
      return redirect(req,res,`/shipments/${id}`,'Zapisano datę wysyłki.');
    }
    if(action==='close'&&req.method==='POST'){
      role(req.user,...managerRoles);
      if(shipment.status!=='draft'||ctx.form.confirm_close!=='1') throw Object.assign(new Error('Potwierdź zamknięcie roboczej wysyłki.'),{status:400});
      const active=transaction(()=>{
        const count=db.prepare('SELECT count(*) n FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id WHERE sa.shipment_id=? AND sb.removed_at IS NULL').get(id).n;
        if(!count) throw Object.assign(new Error('Nie można zamknąć pustej wysyłki.'),{status:409});
        for(const item of shipmentArticles(db,id)){
          const bales=shipmentBales(db,item.id),article=db.prepare('SELECT a.symbol,r.version,r.payload FROM articles a LEFT JOIN records r ON r.id=a.active_spec WHERE a.id=?').get(item.article_id);
          db.prepare('UPDATE shipment_articles SET closed_snapshot=? WHERE id=?').run(JSON.stringify({bales,article,finishingPlant:item.finishing_plant_name||''}),item.id);
        }
        db.prepare("UPDATE shipments SET status='closed',closed_at=?,closed_by=? WHERE id=? AND status='draft'").run(ctx.now(),req.user.id,id);
        return count;
      });
      ctx.audit(req.user,'Zamknięto wysyłkę',null,JSON.stringify({shipmentId:id,bales:active}),null);
      return redirect(req,res,`/shipments/${id}`,'Wysyłka została zamknięta. Belki zniknęły z bieżącej kartoteki.');
    }
    if(action==='cancel'&&req.method==='POST'){
      role(req.user,...managerRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Można anulować tylko roboczą wysyłkę.'),{status:409});
      transaction(()=>eraseDraftShipment(db,id));
      return redirect(req,res,'/shipments','Wysyłkę usunięto. Belki są ponownie dostępne.');
    }
    if(action==='correct'&&req.method==='POST'){
      role(req.user,...managerRoles);
      if(shipment.status!=='closed') throw Object.assign(new Error('Korygować można tylko zamkniętą wysyłkę.'),{status:409});
      const oldId=String(ctx.form.old_bale_id||''),newId=String(ctx.form.new_bale_id||''),disposition=String(ctx.form.disposition||''),reason=String(ctx.form.reason||'').trim().slice(0,500);
      if(!oldId||!reason||!['returned','lost','shipped_out'].includes(disposition)) throw Object.assign(new Error('Uzupełnij błędną belkę, sposób rozliczenia i powód korekty.'),{status:400});
      transaction(()=>{
        const old=db.prepare(`SELECT sb.id,sb.shipment_article_id,b.article_id FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id JOIN production_bales b ON b.local_id=sb.bale_local_id WHERE sa.shipment_id=? AND sb.bale_local_id=? AND sb.removed_at IS NULL`).get(id,oldId);
        if(!old) throw Object.assign(new Error('Wybrana belka nie jest już w wysyłce.'),{status:409});
        let replacement=null;
        if(newId){
          replacement=baleAvailableForNewShipment(db,newId);
          if(!replacement) throw Object.assign(new Error('Nowa belka musi być dostępna do wysyłki.'),{status:409});
        }
        db.prepare('UPDATE shipment_bales SET removed_at=?,removed_by=?,removal_reason=? WHERE id=?').run(ctx.now(),req.user.id,`Korekta: ${reason}`,old.id);
        db.prepare('INSERT INTO shipment_corrections(shipment_id,removed_bale_local_id,replacement_bale_local_id,disposition,reason,created_at,created_by) VALUES(?,?,?,?,?,?,?)').run(id,oldId,newId||null,disposition,reason,ctx.now(),req.user.id);
        if(disposition==='lost'||disposition==='shipped_out') db.prepare('INSERT INTO warehouse_bale_flags(bale_local_id,status,reason,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(bale_local_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(oldId,disposition,reason,ctx.now(),req.user.id);
        else db.prepare('DELETE FROM warehouse_bale_flags WHERE bale_local_id=?').run(oldId);
        if(replacement){
          const oldItem=shipmentArticles(db,id).find(item=>item.id===old.shipment_article_id);
          const sequence=db.prepare('SELECT coalesce(max(sequence),0)+1 next FROM shipment_articles WHERE shipment_id=?').get(id).next;
          const replacementItemId=Number(db.prepare('INSERT INTO shipment_articles(shipment_id,article_id,sequence,finishing_plant_id) VALUES(?,?,?,?)').run(id,replacement.article_id,sequence,oldItem?.finishing_plant_id||null).lastInsertRowid);
          const replacementItem={id:replacementItemId};
          db.prepare('INSERT INTO shipment_bales(shipment_article_id,bale_local_id,added_at) VALUES(?,?,?)').run(replacementItem.id,newId,ctx.now());
        }
      });
      ctx.audit(req.user,'Skorygowano zamkniętą wysyłkę',null,JSON.stringify({shipmentId:id,oldId,newId,disposition,reason}),null);
      return redirect(req,res,`/shipments/${id}`,'Korektę wysyłki zapisano.');
    }
    if(req.method==='GET'&&!action) return send(req,res,200,shipmentPage(ctx,shipment));
  }
  return false;
}

module.exports = { initialize, handle, articleBalances, activeStockSql };
