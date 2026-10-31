'use strict';

const crypto = require('node:crypto');
const V = require('../views');
const Xlsx = require('./xlsx');

const editableRoles = ['admin', 'approver', 'technologist'];
const managerRoles = ['admin', 'approver'];
const hidden = (name, value) => `<input type="hidden" name="${V.esc(name)}" value="${V.esc(value)}">`;
const normalizeSearch = value => String(value || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
const printerSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/><path d="M18 11h.01"/></svg>';
const excelSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M7 12l4 6m0-6-4 6m7-5h2m-2 4h2"/></svg>';
const shipmentPrintIcon = (id, label) => `<a class="shipment-print-icon" href="/shipments/${id}/report" target="_blank" rel="noopener" aria-label="Drukuj raport wysyłki ${V.esc(label)}" title="Drukuj raport wysyłki">${printerSvg}</a>`;

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
    CREATE TABLE IF NOT EXISTS shipment_sequence_counters (
      shipment_year INTEGER PRIMARY KEY, last_value INTEGER NOT NULL CHECK(last_value >= 0)
    );
    CREATE TABLE IF NOT EXISTS finishing_plants (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS knitting_workers (
      employee_uid TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
      name_key TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS finishing_types (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id)
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
    CREATE TABLE IF NOT EXISTS shipment_correction_batches (
      id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      shipment_article_id INTEGER NOT NULL REFERENCES shipment_articles(id), reason TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS shipment_correction_items (
      id INTEGER PRIMARY KEY, correction_batch_id INTEGER NOT NULL REFERENCES shipment_correction_batches(id) ON DELETE CASCADE,
      bale_local_id TEXT NOT NULL REFERENCES production_bales(local_id),
      action TEXT NOT NULL CHECK(action IN ('removed','added')),
      disposition TEXT CHECK(disposition IS NULL OR disposition IN ('returned','lost','shipped_out','mistaken')),
      UNIQUE(correction_batch_id,bale_local_id,action)
    );
  `);
  const correctionItemSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shipment_correction_items'").get()?.sql||'';
  if(!correctionItemSchema.includes("'mistaken'")){
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE shipment_correction_items_updated (
        id INTEGER PRIMARY KEY, correction_batch_id INTEGER NOT NULL REFERENCES shipment_correction_batches(id) ON DELETE CASCADE,
        bale_local_id TEXT NOT NULL REFERENCES production_bales(local_id),
        action TEXT NOT NULL CHECK(action IN ('removed','added')),
        disposition TEXT CHECK(disposition IS NULL OR disposition IN ('returned','lost','shipped_out','mistaken')),
        UNIQUE(correction_batch_id,bale_local_id,action)
      );
      INSERT INTO shipment_correction_items_updated SELECT * FROM shipment_correction_items;
      DROP TABLE shipment_correction_items;
      ALTER TABLE shipment_correction_items_updated RENAME TO shipment_correction_items;
      COMMIT;`);
  }
  db.prepare(`INSERT INTO shipment_sequence_counters(shipment_year,last_value)
    SELECT shipment_year,max(sequence) FROM shipments WHERE 1 GROUP BY shipment_year
    ON CONFLICT(shipment_year) DO UPDATE SET last_value=max(last_value,excluded.last_value)`).run();
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
  db.exec(`CREATE TABLE IF NOT EXISTS warehouse_bale_custom_statuses (
    bale_local_id TEXT PRIMARY KEY REFERENCES production_bales(local_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(length(trim(status)) BETWEEN 1 AND 120),
    created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id)
  );`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS knitting_workers_identity ON knitting_workers(lower(trim(name)),lower(trim(code)));');
  const workerColumns=db.prepare("PRAGMA table_info('knitting_workers')").all().map(column=>column.name);
  if(!workerColumns.includes('name_key')) db.exec("ALTER TABLE knitting_workers ADD COLUMN name_key TEXT NOT NULL DEFAULT '';");
  const workers=db.prepare('SELECT employee_uid,name,active,created_at FROM knitting_workers ORDER BY active DESC,created_at,employee_uid').all();
  const workersByName=new Map();
  for(const worker of workers){
    const key=normalizeSearch(worker.name);
    if(!key){db.prepare('UPDATE knitting_workers SET active=0,name_key=? WHERE employee_uid=?').run(`archived:${worker.employee_uid}`,worker.employee_uid);continue;}
    const group=workersByName.get(key)||[];group.push(worker);workersByName.set(key,group);
  }
  for(const [key,group] of workersByName){
    const canonical=group[0];
    db.prepare('UPDATE knitting_workers SET name_key=?,active=? WHERE employee_uid=?').run(key,group.some(worker=>worker.active)?1:0,canonical.employee_uid);
    for(const duplicate of group.slice(1)) db.prepare('UPDATE knitting_workers SET active=0,name_key=? WHERE employee_uid=?').run(`archived:${duplicate.employee_uid}`,duplicate.employee_uid);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS knitting_workers_name_key ON knitting_workers(name_key);');
  const correctionColumns=db.prepare("PRAGMA table_info('shipment_corrections')").all().map(column=>column.name);
  if(!correctionColumns.includes('shipment_article_id')) db.exec('ALTER TABLE shipment_corrections ADD COLUMN shipment_article_id INTEGER REFERENCES shipment_articles(id);');
  db.exec(`UPDATE shipment_corrections SET shipment_article_id=(SELECT sb.shipment_article_id FROM shipment_bales sb WHERE sb.bale_local_id=shipment_corrections.removed_bale_local_id ORDER BY sb.id LIMIT 1) WHERE shipment_article_id IS NULL;`);
  // Do not rename legacy plant rows automatically: historical rows can coexist
  // with their canonical labels, and changing name_key would violate the UNIQUE
  // constraint while the old row is still referenced by production history.
  const insertPlant=db.prepare('INSERT OR IGNORE INTO finishing_plants(name,name_key,created_at) VALUES(?,?,?)');
  for(const name of ['Anfarb','MarkoColor','Femina','Sagan']) insertPlant.run(name,normalizeSearch(name),new Date().toISOString());
}

const money = value => Number(value || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = value => String(value || '').split('-').reverse().join('.');
const shipmentNo = row => `${String(row.sequence).padStart(2, '0')}/${row.shipment_year}`;
const articleNo = (shipment, item) => `PM ${String(shipment.sequence).padStart(2, '0')}-${String(item.sequence).padStart(2, '0')}`;
const plantColors=['plant-color-orange','plant-color-blue','plant-color-green','plant-color-purple','plant-color-teal','plant-color-red'];
const plantColor = id => plantColors[(Math.max(1,Number(id)||1)-1)%plantColors.length];

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
  return db.prepare(`SELECT b.*,CASE WHEN trim(b.trial_symbol)<>'' THEN b.trial_symbol ELSE a.symbol END symbol,coalesce(f.status,'available') inventory_status,
      coalesce((SELECT group_concat(tag,',') FROM warehouse_bale_tags bt WHERE bt.bale_local_id=b.local_id),'') quality_tags,
      (SELECT status FROM warehouse_bale_custom_statuses cs WHERE cs.bale_local_id=b.local_id) custom_status,
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
    if(row.custom_status)badges.push(`<span class="badge warehouse-custom-status">${V.esc(row.custom_status)}</span>`);
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
    const noteForm = options.editNotes ? `<form method="post" action="/warehouse/bales/${encodeURIComponent(row.local_id)}/notes" class="warehouse-note-form" data-warehouse-note-form>${hidden('csrf', options.csrf)}<input name="notes" value="${V.esc(row.notes)}" aria-label="Uwagi do belki ${V.esc(row.bale_number)}" data-warehouse-note><span class="print-only">${V.esc(row.notes || '—')}</span><span class="warehouse-note-status no-print" aria-live="polite"></span></form>` : V.esc(row.notes || '—');
    const statusAction = options.manageStatuses && row.inventory_status !== 'lost' && row.reserved_status !== 'draft'
      ? `<label class="warehouse-pick"><input type="checkbox" value="${V.esc(row.local_id)}" data-warehouse-check aria-label="Zaznacz belkę ${V.esc(row.bale_number)}"></label>`
      : options.manageStatuses && row.inventory_status === 'lost'
        ? `<label class="warehouse-pick"><input type="checkbox" value="${V.esc(row.local_id)}" data-warehouse-check aria-label="Zaznacz zagubioną belkę ${V.esc(row.bale_number)}"></label>`
        : '';
    const lot = String(row.lot || '').trim();
     return `<tr class="${row.inventory_status === 'lost' ? 'warehouse-row-lost' : ''}"><td>${index + 1}</td>${options.manageStatuses ? `<td class="no-print">${statusAction}</td>` : ''}<td>${V.esc(row.symbol)}${row.trial_symbol?'<small class="badge submitted">Próba</small>':''}</td><td class="warehouse-bale-number"><a href="/warehouse/bales/${encodeURIComponent(row.local_id)}">${V.esc(row.bale_number)}</a>${statusText(row)}</td><td>${money(row.weight_kg)}</td><td>${Number(row.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${row.errors}</td><td>${row.stops}</td><td><span class="lot-chip ${lotClass(lot)}">${V.esc(lot || '—')}</span></td><td>${noteForm}</td><td>${date(row.production_date)}</td></tr>`;
  }).join('');
}

function warehouseExcelStatus(row) {
  const statuses=[];
  if(row.inventory_status==='lost') statuses.push('Zagubiona');
  const tags=String(row.quality_tags||'').split(',');
  if(tags.includes('second_grade')) statuses.push('II gatunek');
  if(tags.includes('stripe_risk')) statuses.push('Ryzyko pasiastości');
  if(row.custom_status) statuses.push(row.custom_status);
  if(!statuses.length) statuses.push(row.reserved_status==='draft'?'W przygotowaniu':'Dostępna');
  return statuses.join('; ');
}

function warehouseExcel(ctx, article) {
  const articleId=article.id;
  if(!article) throw Object.assign(new Error('Nie znaleziono artykułu w wykazie sztuk.'),{status:404});
  const rows=registeredBales(ctx.db,articleId).map((row,index)=>[
    index+1,row.symbol,row.bale_number,Number(row.weight_kg),Number(row.meters),Number(row.errors),Number(row.stops),row.lot||'',row.notes||'',date(row.production_date),warehouseExcelStatus(row),
  ]);
  return Xlsx.workbook(['LP','Symbol','Nr szt.','Masa kg','Metry','Błędy','Stopy','LOT','Uwagi','Data produkcji','Status'],rows,article.symbol);
}

function articleSearchResults(ctx, q) {
  if (!q) return '';
  const matches = articleBalances(ctx.db, q).filter(article => article.stock_pieces > 0);
  if (!matches.length) return '<p class="warehouse-search-empty">Brak artykułów z dostępnymi belkami.</p>';
  return `<div class="warehouse-search-results" role="listbox" aria-label="Pasujące artykuły">${matches.map(article => `<a id="warehouse-article-option-${article.id}" role="option" aria-selected="false" href="/warehouse?article_id=${article.id}" class="warehouse-article-option"><strong>${V.esc(article.symbol)}</strong><span>${article.stock_pieces} szt · ${money(article.stock_weight)} kg</span></a>`).join('')}</div>`;
}

function articleFilenamePart(article) {
  return article.symbol.replace(/ł/gi,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,'-').replace(/[^a-zA-Z0-9._()-]+/g,'-').replace(/-+/g,'-').replace(/^[.-]+|[.-]+$/g,'')||`artykul-${article.id}`;
}

function catalogPage(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '').trim();
  const rawArticleId = Number(ctx.url.searchParams.get('article_id') || 0);
  if (ctx.url.searchParams.get('partial') === 'search') return articleSearchResults(ctx, q);
  const current = Number.isSafeInteger(rawArticleId) && rawArticleId > 0 ? articleBalances(ctx.db).find(a => a.id === rawArticleId) : null;
  const search = `<form method="get" action="/warehouse" class="warehouse-search" data-warehouse-live-search><label>Szukaj artykułu<input name="q" value="${V.esc(q)}" placeholder="Symbol lub opis artykułu" aria-label="Szukaj artykułu" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${q?'true':'false'}" aria-controls="warehouse-search-results"></label><p class="muted small">Wpisz co najmniej 1 znak. Szukamy w symbolu i opisie; wielkość liter i polskie znaki nie mają znaczenia. Przy kilku słowach każde musi pasować.</p><div class="warehouse-search-results-wrap" id="warehouse-search-results" data-warehouse-search-results>${articleSearchResults(ctx, q)}</div></form>`;
  let selectedView = '';
  if (current) {
    const bales = registeredBales(ctx.db, current.id);
    const availableCount = bales.filter(b => b.inventory_status === 'available').length;
    const currentWeight = bales.filter(b => b.inventory_status === 'available').reduce((sum, b) => sum + b.weight_kg, 0);
    const lostCount = bales.filter(b => b.inventory_status === 'lost').length;
    const canManageStatuses = managerRoles.includes(ctx.req.user.role);
    const lostForm = canManageStatuses ? `<form method="post" action="/warehouse/bales/status" id="warehouse-bulk-status" class="warehouse-bulk-status">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="article_id" value="${current.id}"><input type="hidden" name="bale_ids" value="" data-warehouse-selected><input name="reason" placeholder="Powód zagubienia (opcjonalnie)" maxlength="500"><button name="status" value="lost" class="button danger">Oznacz jako zagubione</button><button name="status" value="second_grade" class="button warehouse-action-second-grade">Oznacz jako drugi gatunek</button><button name="status" value="stripe_risk" class="button warehouse-action-stripe-risk">Oznacz jako ryzyko pasiastości</button><input name="custom_status" maxlength="120" placeholder="Własny status"><button name="status" value="custom" class="button warehouse-action-custom-status">Dodaj status</button>${lostCount||bales.some(b=>b.quality_tags||b.custom_status) ? '<button name="status" value="available" class="button">Usuń oznaczenia / przywróć dostępność</button>' : ''}</form>` : '';
    const cols = canManageStatuses ? 11 : 10;
    const exportIcons=`<span class="warehouse-export-icons no-print"><button type="button" class="warehouse-icon-button" data-print-page title="Drukuj wykaz" aria-label="Drukuj wykaz sztuk artykułu ${V.esc(current.symbol)}">${printerSvg}</button><a class="warehouse-icon-button" href="/warehouse/export.xlsx?article_id=${current.id}" title="Eksportuj do Excela" aria-label="Eksportuj wykaz sztuk artykułu ${V.esc(current.symbol)} do Excela">${excelSvg}</a></span>`;
    const baleTableRows=baleRows(bales,{editNotes:editableRoles.includes(ctx.req.user.role),manageStatuses:canManageStatuses,csrf:ctx.req.session.csrf})||`<tr><td colspan="${cols}">Brak belek w bieżącej kartotece.</td></tr>`;
    const listedWeight=bales.reduce((sum,b)=>sum+Number(b.weight_kg||0),0);
    selectedView = `<section class="warehouse-selected"><div class="pagehead warehouse-selected-head"><div><div class="warehouse-symbol-row"><h2>${V.esc(current.symbol)}</h2>${exportIcons}</div><p class="warehouse-stock-summary"><strong>Stan bieżący: ${availableCount} szt · ${money(currentWeight)} kg</strong>${lostCount ? `<span class="warehouse-lost-count">Zagubione: ${lostCount} szt</span>` : ''}</p></div><time class="print-only warehouse-print-timestamp" data-print-timestamp></time></div>${lostForm}<div class="panel scroll"><table class="listing warehouse-bales-table"><thead><tr>${canManageStatuses ? '<th>LP</th><th class="no-print">✓</th>' : '<th>LP</th>'}<th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Uwagi</th><th>Data produkcji</th></tr></thead><tbody>${baleTableRows}<tr class="warehouse-print-total"><th colspan="3">Razem · ${bales.length} szt.</th><th>${money(listedWeight)}</th><th colspan="6"></th></tr></tbody></table></div></section>`;
  }
  if (!current) {
    const canManageStatuses=managerRoles.includes(ctx.req.user.role),cols=canManageStatuses?11:10;
    selectedView=`<section class="warehouse-selected"><div class="panel scroll"><table class="listing warehouse-bales-table"><thead><tr>${canManageStatuses?'<th>LP</th><th>✓</th>':'<th>LP</th>'}<th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Uwagi</th><th>Data produkcji</th></tr></thead><tbody><tr><td colspan="${cols}">Wybierz artykuł, aby wyświetlić jego belki.</td></tr></tbody></table></div></section>`;
  }
    const body = `<div class="pagehead warehouse-pagehead"><div><span class="eyebrow">MAGAZYN</span><h1>Wykaz sztuk</h1><p class="muted">Wyszukaj artykuł, aby zobaczyć jego belki i bieżący stan.</p></div></div>${search}${selectedView}`;
  const pageTitle=current?`wykaz-${articleFilenamePart(current)}-${ctx.todayWarsaw()}`:'Wykaz sztuk · Marand';
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:pageTitle,body});
}

function baleDetailPage(ctx, localId) {
  const bale = ctx.db.prepare(`SELECT b.*,a.id article_id,a.symbol,coalesce(f.status,'available') inventory_status,f.reason status_reason,
      coalesce((SELECT group_concat(tag,',') FROM warehouse_bale_tags bt WHERE bt.bale_local_id=b.local_id),'') quality_tags,
      (SELECT status FROM warehouse_bale_custom_statuses cs WHERE cs.bale_local_id=b.local_id) custom_status,
      sh.id shipment_id,sh.shipment_year,sh.sequence shipment_sequence,sh.status shipment_status,
      sa.id shipment_article_id,sa.sequence article_sequence,sb.removed_at shipment_removed_at,
      sb.removal_reason shipment_removal_reason,coalesce(sc.disposition,(SELECT ci.disposition FROM shipment_correction_items ci JOIN shipment_correction_batches cb ON cb.id=ci.correction_batch_id WHERE ci.bale_local_id=b.local_id AND ci.action='removed' AND cb.shipment_article_id=sa.id ORDER BY ci.id DESC LIMIT 1)) correction_disposition,
      coalesce(sc.reason,(SELECT cb.reason FROM shipment_correction_items ci JOIN shipment_correction_batches cb ON cb.id=ci.correction_batch_id WHERE ci.bale_local_id=b.local_id AND ci.action='removed' AND cb.shipment_article_id=sa.id ORDER BY ci.id DESC LIMIT 1)) correction_reason
    FROM production_bales b JOIN articles a ON a.id=b.article_id
    LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    LEFT JOIN shipment_bales sb ON sb.id=(SELECT sb2.id FROM shipment_bales sb2 WHERE sb2.bale_local_id=b.local_id ORDER BY sb2.id DESC LIMIT 1)
    LEFT JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
    LEFT JOIN shipments sh ON sh.id=sa.shipment_id
    LEFT JOIN shipment_corrections sc ON sc.shipment_article_id=sa.id AND sc.removed_bale_local_id=b.local_id
    WHERE b.local_id=?`).get(localId);
  if (!bale) throw Object.assign(new Error('Nie znaleziono belki.'),{status:404});
  let workers=[];try{workers=JSON.parse(bale.workers_json||'[]')}catch{}
  const workerList=workers.length?`<ul>${workers.map(worker=>`<li>${V.esc(worker.name)} · ${Number(worker.meters||0).toLocaleString('pl-PL')} m</li>`).join('')}</ul>`:'—';
  const quality=[];
  if(bale.inventory_status==='lost')quality.push('Zagubiona');
  if(String(bale.quality_tags).split(',').includes('second_grade'))quality.push('Drugi gatunek');
  if(String(bale.quality_tags).split(',').includes('stripe_risk'))quality.push('Ryzyko pasiastości');
  if(bale.custom_status)quality.push(bale.custom_status);
  const status=quality.join(' · ')||(bale.inventory_status==='shipped_out'?'Wysłana poza stan':'Dostępna');
  const shipmentStatus=bale.shipment_removed_at?(bale.correction_disposition?`Usunięta korektą (${bale.correction_disposition})`:'Usunięta z roboczej wysyłki'):(bale.shipment_status==='closed'?'Zamknięta':'W przygotowaniu');
  const shipment=bale.shipment_id?`<a href="/shipments/${bale.shipment_id}#specification-${bale.shipment_article_id}">${shipmentNo({sequence:bale.shipment_sequence,shipment_year:bale.shipment_year})} · ${shipmentStatus}</a>${bale.correction_reason||bale.shipment_removal_reason?`<div class="muted small">${V.esc(bale.correction_reason||bale.shipment_removal_reason)}</div>`:''}`:'—';
  const canEditNote=editableRoles.includes(ctx.req.user.role)&&bale.shipment_status!=='closed'&&bale.inventory_status!=='shipped_out';
  const noteForm=canEditNote?`<form method="post" action="/warehouse/bales/${encodeURIComponent(bale.local_id)}/notes" class="warehouse-detail-note" data-warehouse-note-form>${hidden('csrf',ctx.req.session.csrf)}<input name="notes" value="${V.esc(bale.notes)}" aria-label="Uwagi do belki" data-warehouse-note><span class="warehouse-note-status" aria-live="polite"></span></form>`:V.esc(bale.notes||'—');
  const entries=[['Symbol artykułu',`<a href="/warehouse?article_id=${bale.article_id}">${V.esc(bale.symbol)}</a>`],['Numer belki',V.esc(bale.bale_number)],['Status',V.esc(status)],['Maszyna',V.esc(bale.machine)],['Data produkcji',date(bale.production_date)],['Masa',`${money(bale.weight_kg)} kg`],['Długość',`${Number(bale.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})} m`],['Błędy',String(bale.errors)],['Stopy',String(bale.stops)],['Dziewiarze',workerList],['LOT',V.esc(bale.lot||'—')],['Uwagi',noteForm],['Kontrola',bale.needs_check?'Wymaga sprawdzenia':'—'],['Wysyłka',shipment],['Zarejestrowano lokalnie',V.datepl(bale.local_created_at)],['Wysłano na serwer',V.datepl(bale.uploaded_at)]];
  if(bale.trial_symbol)entries.splice(1,0,['Symbol próby',V.esc(bale.trial_symbol)]);
  const body=`<a class="breadcrumb" href="/warehouse?article_id=${bale.article_id}">← Wykaz sztuk · ${V.esc(bale.symbol)}</a><div class="pagehead"><div><span class="eyebrow">SZCZEGÓŁY BELKI</span><h1>${V.esc(bale.bale_number)}</h1></div></div><section class="panel padded warehouse-bale-detail"><dl>${entries.map(([label,value])=>`<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl></section>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Belka ${bale.bale_number} · Wykaz sztuk · Marand`,body});
}

function shipmentRecord(db, id) {
  return db.prepare('SELECT * FROM shipments WHERE id=?').get(id);
}

function shipmentConfirmPage(ctx, shipment, kind) {
  const cancelUrl=`/shipments/${shipment.id}`;
  const isCancel=kind==='cancel';
  const action=`/shipments/${shipment.id}/${kind}`;
  const title=isCancel?'Anuluj wysyłkę':'Usuń wysyłkę';
  const text=isCancel?'Anulowanie całkowicie usunie roboczą wysyłkę.':'Usunięcie całkowicie usunie roboczą wysyłkę.';
  const details=`<p>${text} Belki zostaną zwolnione i ponownie pojawią się jako dostępne. Numer WZ pozostanie zarezerwowany i nie zostanie użyty ponownie.</p>`;
  const body=`<a class="breadcrumb" href="${cancelUrl}">← Wróć do wysyłki</a><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>${title} ${shipmentNo(shipment)}?</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><h2 class="delete-confirm-object">Wysyłka ${shipmentNo(shipment)}</h2>${details}<form method="post" action="${action}" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden(isCancel?'confirm_cancel':'confirm_delete','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">${isCancel?'Potwierdź anulowanie':'Potwierdź całkowite usunięcie'}</button></form></div></dialog>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Potwierdź ${title.toLocaleLowerCase('pl-PL')} · Marand`,body});
}

function shipmentArticleDeleteConfirmPage(ctx, shipment, item) {
  const cancelUrl=`/shipments/${shipment.id}`;
  const action=`/shipments/${shipment.id}/specifications/${item.id}/delete`;
  const bales=shipmentBales(ctx.db,item.id);
  const body=`<a class="breadcrumb" href="${cancelUrl}">← Wróć do wysyłki</a><dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${cancelUrl}"><div class="dialog-head"><strong>Usuń specyfikację ${articleNo(shipment,item)}?</strong><a class="dialog-close" href="${cancelUrl}" aria-label="Anuluj">×</a></div><div class="dialog-body"><h2 class="delete-confirm-object">${articleNo(shipment,item)} · ${V.esc(item.symbol)}</h2><p>Specyfikacja wraz z ${bales.length} belkami zostanie usunięta z roboczej wysyłki. Belki wrócą do dostępnych, a numer specyfikacji będzie można wykorzystać ponownie.</p><form method="post" action="${action}" class="actions">${hidden('csrf',ctx.req.session.csrf)}${hidden('confirm_delete_specification','1')}<a class="button" href="${cancelUrl}">Wróć</a><button class="danger">Potwierdź usunięcie specyfikacji</button></form></div></dialog>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Usuń specyfikację ${articleNo(shipment,item)} · Marand`,body});
}

function eraseDraftShipment(db,id) {
  // Audit records are immutable. Keep their history when a draft shipment is
  // removed; the shipment data can be deleted independently.
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
    WHERE sa.shipment_id=? GROUP BY sa.id ORDER BY sa.id DESC`).all(shipmentId);
}

function nextShipmentSequence(db, year) {
  const used = new Set(db.prepare('SELECT sequence FROM shipments WHERE shipment_year=?').all(year).map(row=>Number(row.sequence)));
  let sequence = 1;
  while (used.has(sequence)) sequence++;
  return sequence;
}

function nextShipmentArticleSequence(db, shipmentId) {
  const used=new Set(db.prepare('SELECT sequence FROM shipment_articles WHERE shipment_id=?').all(shipmentId).map(row=>Number(row.sequence)));
  let sequence=1;
  while(used.has(sequence)) sequence++;
  return sequence;
}

function shipmentBales(db, itemId) {
  return db.prepare(`SELECT b.*,a.symbol FROM shipment_bales sb
    JOIN production_bales b ON b.local_id=sb.bale_local_id
    JOIN articles a ON a.id=b.article_id
    WHERE sb.shipment_article_id=? AND sb.removed_at IS NULL
    ORDER BY b.production_date,b.local_created_at,b.uploaded_at,b.bale_number COLLATE NOCASE`).all(itemId);
}

function shipmentBaleHistory(db, itemId) {
  return db.prepare(`SELECT b.*,a.symbol,sb.added_at,sb.removed_at,sb.removal_reason,
      sc.disposition correction_disposition,sc.reason correction_reason,sc.created_at corrected_at,
      (SELECT ci.action FROM shipment_correction_items ci JOIN shipment_correction_batches cb ON cb.id=ci.correction_batch_id
        WHERE ci.bale_local_id=b.local_id AND cb.shipment_article_id=sb.shipment_article_id ORDER BY ci.id DESC LIMIT 1) correction_action,
      (SELECT ci.disposition FROM shipment_correction_items ci JOIN shipment_correction_batches cb ON cb.id=ci.correction_batch_id
        WHERE ci.bale_local_id=b.local_id AND ci.action='removed' AND cb.shipment_article_id=sb.shipment_article_id ORDER BY ci.id DESC LIMIT 1) batch_disposition,
      (SELECT cb.reason FROM shipment_correction_items ci JOIN shipment_correction_batches cb ON cb.id=ci.correction_batch_id
        WHERE ci.bale_local_id=b.local_id AND cb.shipment_article_id=sb.shipment_article_id ORDER BY ci.id DESC LIMIT 1) batch_reason
    FROM shipment_bales sb
    JOIN production_bales b ON b.local_id=sb.bale_local_id
    JOIN articles a ON a.id=b.article_id
    LEFT JOIN shipment_corrections sc ON sc.shipment_article_id=sb.shipment_article_id AND sc.removed_bale_local_id=sb.bale_local_id
    WHERE sb.shipment_article_id=?
    ORDER BY sb.id`).all(itemId);
}

function shipmentCorrectionDocumentLinks(ctx, shipment) {
  const batches=ctx.db.prepare(`SELECT c.id,c.created_at,sa.sequence,a.symbol FROM shipment_correction_batches c
    JOIN shipment_articles sa ON sa.id=c.shipment_article_id JOIN articles a ON a.id=sa.article_id
    WHERE c.shipment_id=? ORDER BY c.id DESC`).all(shipment.id);
  const legacy=ctx.db.prepare(`SELECT c.id,c.created_at,sa.sequence,a.symbol FROM shipment_corrections c
    JOIN shipment_articles sa ON sa.id=c.shipment_article_id JOIN articles a ON a.id=sa.article_id
    WHERE c.shipment_id=? ORDER BY c.id DESC`).all(shipment.id);
  return [...batches.map(c=>`<li><a href="/shipments/${shipment.id}/correction/${c.id}?batch=1" target="_blank" rel="noopener">Korekta ${shipmentNo(shipment)} · ${articleNo(shipment,c)} ${V.esc(c.symbol)} · ${V.datepl(c.created_at)}</a></li>`),...legacy.map(c=>`<li><a href="/shipments/${shipment.id}/correction/${c.id}" target="_blank" rel="noopener">Korekta ${shipmentNo(shipment)} · ${articleNo(shipment,c)} ${V.esc(c.symbol)} · ${V.datepl(c.created_at)}</a></li>`)];
}

function shipmentCorrectionSearchResults(db, shipments, q) {
  const terms=String(q||'').trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
  const matches=shipments.map(shipment=>{
    const items=shipmentArticles(db,shipment.id);
    const fields=[shipmentNo(shipment),shipment.shipment_date,date(shipment.shipment_date),String(shipment.shipment_year),...items.flatMap(item=>[articleNo(shipment,item),item.symbol,item.finishing_plant_name||''])].map(normalizeSearch);
    return {shipment,items,match:terms.every(term=>fields.some(field=>field.includes(term)))};
  }).filter(result=>result.match);
  return `<div class="warehouse-search-results" role="listbox" aria-label="Pasujące wysyłki">${matches.map(({shipment,items})=>`<a id="shipment-correction-option-${shipment.id}" role="option" aria-selected="false" href="/shipments/correct?shipment_id=${shipment.id}" class="warehouse-article-option"><strong>Wysyłka ${shipmentNo(shipment)} · ${date(shipment.shipment_date)}</strong><span>${items.map(item=>`${V.esc(articleNo(shipment,item))} ${V.esc(item.symbol)}`).join(' · ')||'Bez specyfikacji'}</span></a>`).join('')||'<p class="muted small">Brak pasujących zamkniętych wysyłek.</p>'}</div>`;
}

function shipmentsPage(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '').trim();
  const dateFrom = String(ctx.url.searchParams.get('date_from') || '').trim();
  const dateTo = String(ctx.url.searchParams.get('date_to') || '').trim();
  const requestedYear = String(ctx.url.searchParams.get('year') || '').trim();
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
  const from = validDate(dateFrom) ? dateFrom : '';
  const to = validDate(dateTo) ? dateTo : '';
  const shipments = ctx.db.prepare(`SELECT s.*,
      count(DISTINCT sa.id) article_count,count(sb.id) bale_count,
      round(coalesce(sum(b.weight_kg),0),2) weight_kg
    FROM shipments s LEFT JOIN shipment_articles sa ON sa.shipment_id=s.id
    LEFT JOIN shipment_bales sb ON sb.shipment_article_id=sa.id AND sb.removed_at IS NULL
    LEFT JOIN production_bales b ON b.local_id=sb.bale_local_id
    WHERE s.status!='cancelled' GROUP BY s.id ORDER BY s.shipment_year DESC,s.sequence DESC`).all();
  const years = [...new Set(shipments.map(shipment => String(shipment.shipment_year)))].sort((a,b) => Number(b)-Number(a));
  const year = years.includes(requestedYear) ? requestedYear : '';
  const canPrepare = editableRoles.includes(ctx.req.user.role);
  const create = canPrepare ? `<form method="post" action="/shipments/create">${hidden('csrf',ctx.req.session.csrf)}<button class="primary">+ Przygotuj wysyłkę</button></form>` : '';
  const correct = managerRoles.includes(ctx.req.user.role) ? `<a class="button shipment-correction-launch" href="/shipments/correct" target="_blank" rel="noopener">Koryguj wysyłkę</a>` : '';
  const searchReady = normalizeSearch(q).length >= 1;
  const searchTerms = searchReady ? q.split(/\s+/).map(normalizeSearch).filter(Boolean) : [];
  const rows = shipments.filter(s => {
    const items = shipmentArticles(ctx.db,s.id);
    if (year && String(s.shipment_year) !== year) return false;
    if (from && s.shipment_date < from || to && s.shipment_date > to) return false;
    const statusText = s.status==='closed' ? 'Zamknięta' : s.status==='draft' ? 'W przygotowaniu' : 'Anulowana';
    const searchFields = [shipmentNo(s), s.shipment_date, date(s.shipment_date), String(s.shipment_year), statusText, ...items.flatMap(item => [articleNo(s,item), item.symbol, item.finishing_plant_name || ''])].map(normalizeSearch);
    return !searchTerms.length || searchTerms.every(term => searchFields.some(field => field.includes(term)));
  }).map(s => {
    const items = shipmentArticles(ctx.db,s.id);
    const itemRows = s.status==='cancelled'?'':[...items.map(item => `<li><a href="/shipments/${s.id}/wz/${item.id}" target="_blank" rel="noopener">${articleNo(s,item)} ${V.esc(item.symbol)}</a> · ${item.bale_count} szt · ${money(item.weight_kg)} kg${item.finishing_plant_name?` · <span class="plant-chip ${plantColor(item.finishing_plant_id)}">${V.esc(item.finishing_plant_name)}</span>`:''}</li>`),...(s.status==='closed'?shipmentCorrectionDocumentLinks(ctx,s):[])].join('');
    const print=s.status==='closed'?shipmentPrintIcon(s.id,shipmentNo(s)):'';
    const remove=managerRoles.includes(ctx.req.user.role)&&s.status!=='closed'?`<a class="shipment-delete-button shipment-delete-link" href="/shipments/${s.id}/delete" title="Usuń wysyłkę" aria-label="Usuń wysyłkę ${shipmentNo(s)}">×</a>`:'';
    return `<tr data-live-result-row><td><a class="item-title" href="/shipments/${s.id}">${shipmentNo(s)}</a></td><td>${date(s.shipment_date)}</td><td><span class="badge ${s.status==='closed'?'approved':s.status==='draft'?'submitted':'archived'}">${s.status==='closed'?`Zamknięta · ${V.datepl(s.closed_at)}`:s.status==='draft'?'W przygotowaniu':'Anulowana'}</span></td><td>${s.article_count}</td><td>${s.bale_count}</td><td>${money(s.weight_kg)} kg</td><td><details><summary>Dokumenty</summary><ul class="shipment-doc-list">${itemRows||'<li>Brak artykułów.</li>'}</ul></details></td><td class="shipment-delete-cell"><div class="shipment-row-actions">${print}${remove}</div></td></tr>`;
  }).join('');
  const filters = `<form method="get" action="/shipments" class="shipment-list-filters" data-live-search><label class="shipment-list-search">Szukaj<input type="search" name="q" value="${V.esc(q)}" placeholder="Nr wysyłki, artykuł lub wykończalnia" autocomplete="off" aria-label="Szukaj wysyłek"></label><label>Rok<select name="year"><option value="">Wszystkie lata</option>${years.map(value => `<option value="${V.esc(value)}"${year===value?' selected':''}>${V.esc(value)}</option>`).join('')}</select></label><label>Data od<input type="date" name="date_from" value="${V.esc(from)}"></label><label>Data do<input type="date" name="date_to" value="${V.esc(to)}"></label><a class="button" href="/shipments">Wyczyść</a><p class="muted small shipment-list-filter-hint">Szukamy po numerze wysyłki, statusie, symbolu artykułu i wykończalni. Wielkość liter i polskie znaki nie mają znaczenia; przy kilku słowach każde musi pasować.</p></form>`;
  const body = `<div class="pagehead"><div><span class="eyebrow">MAGAZYN</span><h1>Wysyłki</h1><p class="muted">Przygotuj transport, przypisz belki i zamknij wysyłkę po sprawdzeniu.</p></div><div class="shipment-list-actions">${create}${correct}</div></div>${filters}<div class="panel scroll" data-live-results><table class="listing compact"><thead><tr><th>Nr wysyłki</th><th>Data</th><th>Status</th><th>Artykuły</th><th>Belki</th><th>Masa</th><th>Specyfikacje</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="8">${shipments.length?'Brak wysyłek dla wybranych filtrów.':'Nie ma jeszcze wysyłek.'}</td></tr>`}</tbody></table></div>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Wysyłka · Marand',body});
}

function shipmentPage(ctx, shipment) {
  const items = shipmentArticles(ctx.db,shipment.id);
  const openSpecificationId=Number(ctx.url.searchParams.get('open_specification')||0);
  const canEdit = editableRoles.includes(ctx.req.user.role) && shipment.status==='draft';
  const canClose = managerRoles.includes(ctx.req.user.role) && shipment.status==='draft';
  const itemViews = items.map(item => {
    const bales = shipmentBaleHistory(ctx.db,item.id);
    const baleRowsHtml = bales.map((b,index) => {
      const removed=Boolean(b.removed_at);
      const reason=b.correction_reason||b.batch_reason||b.removal_reason;
      const disposition=b.correction_disposition||b.batch_disposition;
      const dispositionLabels={mistaken:'Pomylona sztuka · wróciła do bieżącego stanu',shipped_out:'bez zmian'};
      const assignmentStatus=removed?(disposition?`Usunięta korektą · ${dispositionLabels[disposition]||disposition}`:'Usunięta z wysyłki'):b.correction_action==='added'?'Dodana korektą':'W specyfikacji';
      return `<tr class="${removed?'shipment-bale-removed':''}"><td>${index+1}</td><td>${V.esc(b.symbol)}</td><td><a href="/warehouse/bales/${encodeURIComponent(b.local_id)}">${V.esc(b.bale_number)}</a></td><td>${money(b.weight_kg)}</td><td>${Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${V.esc(b.lot||'—')}</td><td>${date(b.production_date)}</td><td>${V.esc(assignmentStatus)}${reason?`<div class="muted small">${V.esc(reason)}</div>`:''}</td>${canEdit&&!removed?`<td><form method="post" action="/shipments/${shipment.id}/remove">${hidden('csrf',ctx.req.session.csrf)}<input type="hidden" name="specification_id" value="${item.id}"><input type="hidden" name="bale_id" value="${V.esc(b.local_id)}"><button class="link danger">Usuń</button></form></td>`:canEdit?'<td></td>':''}</tr>`;
    }).join('');
    const deleteSpecification=canClose?`<a class="button danger" href="/shipments/${shipment.id}/specifications/${item.id}/delete">Usuń specyfikację</a>`:'';
    const plant=item.finishing_plant_name?`<span class="plant-chip ${plantColor(item.finishing_plant_id)}">${V.esc(item.finishing_plant_name)}</span>`:'';
    return `<details class="shipment-article" id="specification-${item.id}"${openSpecificationId===item.id?' open':''}><summary>${articleNo(shipment,item)} · ${V.esc(item.symbol)} <span>${item.bale_count} szt w wysyłce · ${money(item.weight_kg)} kg ${plant}</span></summary><div class="shipment-article-actions"><a class="button" target="_blank" rel="noopener" href="/shipments/${shipment.id}/wz/${item.id}">Podgląd WZ</a>${deleteSpecification}</div><div class="panel scroll"><table class="listing compact"><thead><tr><th>LP</th><th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>LOT</th><th>Data produkcji</th><th>Historia przypisania</th>${canEdit?'<th></th>':''}</tr></thead><tbody>${baleRowsHtml||'<tr><td colspan="9">Brak belek.</td></tr>'}</tbody></table></div></details>`;
  }).join('');
  const status = shipment.status==='closed'?`<span class="badge approved">Zamknięta · ${V.datepl(shipment.closed_at)}</span>`:shipment.status==='cancelled'?'<span class="badge archived">Anulowana</span>':'<span class="badge submitted">W przygotowaniu</span>';
  const details = canEdit ? `<form method="post" action="/shipments/${shipment.id}/date" class="shipment-date-form" data-autosave>${hidden('csrf',ctx.req.session.csrf)}<label>Data wysyłki<input type="date" name="shipment_date" value="${V.esc(shipment.shipment_date)}" data-autosave-value required></label><span data-autosave-status class="autosave-status" aria-live="polite"></span></form>` : `<p>Data wysyłki: <strong>${date(shipment.shipment_date)}</strong></p>`;
  const actions = canEdit ? `<div class="actions"><a class="button primary" href="/shipments/${shipment.id}/select">+ Dodaj specyfikację do wysyłki</a></div>` : '';
  const close = canClose && items.some(item=>item.bale_count>0) ? `<form method="post" action="/shipments/${shipment.id}/close" class="shipment-close-form">${hidden('csrf',ctx.req.session.csrf)}<label class="check"><input type="checkbox" name="confirm_close" value="1" required> Potwierdzam zamknięcie wysyłki. Belki znikną z bieżącego rejestru.</label><button class="primary">Zamknij wysyłkę</button></form>` : '';
  const cancel = canClose ? `<a class="button danger" href="/shipments/${shipment.id}/cancel">Anuluj wysyłkę i zwolnij belki</a>` : '';
  const reportIcon = shipment.status==='closed' ? shipmentPrintIcon(shipment.id,shipmentNo(shipment)) : '';
  const body = `<a class="breadcrumb" href="/shipments">← Wysyłki</a><div class="pagehead"><div><span class="eyebrow">${status}</span><h1>Wysyłka ${shipmentNo(shipment)}</h1>${details}</div><div class="shipment-totals"><strong>${items.reduce((s,x)=>s+x.bale_count,0)} szt</strong><strong>${money(items.reduce((s,x)=>s+x.weight_kg,0))} kg</strong>${reportIcon}</div></div><div class="shipment-final-actions">${close}</div>${actions}${itemViews||'<p class="muted">Dodaj specyfikację i wybierz belki do wysyłki.</p>'}<div class="shipment-final-actions">${cancel}</div>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Wysyłka ${shipmentNo(shipment)} · Marand`,body});
}

function shipmentReportPage(ctx, shipment) {
  const rows = ctx.db.prepare(`SELECT a.symbol,count(sb.id) bale_count,round(coalesce(sum(b.weight_kg),0),2) weight_kg
    FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
    JOIN articles a ON a.id=sa.article_id JOIN production_bales b ON b.local_id=sb.bale_local_id
    WHERE sa.shipment_id=? AND sb.removed_at IS NULL GROUP BY a.id,a.symbol ORDER BY a.symbol COLLATE NOCASE`).all(shipment.id);
  const totalBales = rows.reduce((sum,row)=>sum+Number(row.bale_count),0);
  const totalWeight = rows.reduce((sum,row)=>sum+Number(row.weight_kg),0);
  const tableRows = rows.map(row=>`<tr><td>${V.esc(row.symbol)}</td><td>${row.bale_count}</td><td>${money(row.weight_kg)} kg</td></tr>`).join('');
  const body = `<article class="shipment-print-report"><div class="shipment-print-heading"><div><span class="eyebrow">MARAND · WYSYŁKA</span><h1>Raport wysyłki ${shipmentNo(shipment)}</h1><p>Data wysyłki: <strong>${date(shipment.shipment_date)}</strong></p><p>Zamknięto: <strong>${V.datepl(shipment.closed_at)}</strong></p></div><button class="no-print" type="button" data-print-page>Drukuj raport</button></div><table class="listing compact"><thead><tr><th>Artykuł</th><th>Liczba sztuk</th><th>Masa</th></tr></thead><tbody>${tableRows||'<tr><td colspan="3">Brak sztuk w wysyłce.</td></tr>'}<tr class="shipment-print-total"><th>Razem</th><th>${totalBales}</th><th>${money(totalWeight)} kg</th></tr></tbody></table></article>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Raport wysyłki ${shipmentNo(shipment)} · Marand`,body});
}

function finishingPlantsPage(ctx) {
  if(!managerRoles.includes(ctx.req.user.role)) throw Object.assign(new Error('Brak uprawnień do bibliotek.'),{status:403});
  const plants=ctx.db.prepare('SELECT id,name,active FROM finishing_plants ORDER BY active DESC,name COLLATE NOCASE').all();
  const rows=plants.map(plant=>`<tr><td><form method="post" action="/settings/finishing-plants/${plant.id}/edit" class="library-edit" data-autosave>${hidden('csrf',ctx.req.session.csrf)}<input name="name" data-autosave-value value="${V.esc(plant.name)}" maxlength="100" required aria-label="Nazwa wykańczalni"><span data-autosave-status class="autosave-status" aria-live="polite"></span></form></td><td><span class="badge ${plant.active?'approved':'archived'}">${plant.active?'Aktywna':'Nieaktywna'}</span></td><td><form method="post" action="/settings/finishing-plants/${plant.id}/toggle">${hidden('csrf',ctx.req.session.csrf)}<button>${plant.active?'Dezaktywuj':'Aktywuj'}</button></form></td></tr>`).join('');
  const workers=ctx.db.prepare("SELECT employee_uid,name,active FROM knitting_workers WHERE name_key NOT LIKE 'archived:%' ORDER BY active DESC,name COLLATE NOCASE").all();
  const workerRows=workers.map(worker=>`<tr><td><form method="post" action="/settings/libraries/workers/${encodeURIComponent(worker.employee_uid)}/edit" class="library-edit" data-autosave>${hidden('csrf',ctx.req.session.csrf)}<input name="name" data-autosave-value value="${V.esc(worker.name)}" maxlength="100" required aria-label="Imię i nazwisko"><span data-autosave-status class="autosave-status" aria-live="polite"></span></form></td><td><span class="badge ${worker.active?'approved':'archived'}">${worker.active?'Aktywny':'Nieaktywny'}</span></td><td><form method="post" action="/settings/libraries/workers/${encodeURIComponent(worker.employee_uid)}/toggle">${hidden('csrf',ctx.req.session.csrf)}<button>${worker.active?'Dezaktywuj':'Aktywuj'}</button></form></td></tr>`).join('');
  const finishTypes=ctx.db.prepare('SELECT id,name,active FROM finishing_types ORDER BY active DESC,name COLLATE NOCASE').all();
  const finishRows=finishTypes.map(item=>`<tr><td><form method="post" action="/settings/libraries/finishes/${item.id}/edit" class="library-edit" data-autosave>${hidden('csrf',ctx.req.session.csrf)}<input name="name" data-autosave-value value="${V.esc(item.name)}" maxlength="100" required aria-label="Rodzaj wykończenia"><span data-autosave-status class="autosave-status" aria-live="polite"></span></form></td><td><span class="badge ${item.active?'approved':'archived'}">${item.active?'Aktywne':'Nieaktywne'}</span></td><td><form method="post" action="/settings/libraries/finishes/${item.id}/toggle">${hidden('csrf',ctx.req.session.csrf)}<button>${item.active?'Dezaktywuj':'Aktywuj'}</button></form></td></tr>`).join('');
  const body=`<div class="pagehead"><div><span class="eyebrow">USTAWIENIA</span><h1>Biblioteki</h1><p class="muted">Centralne słowniki używane w programie głównym i lokalnym panelu dziewiarni.</p></div></div><section class="panel padded"><h2>Artykuły</h2><p class="muted">Program główny jest źródłem kartotek artykułów. Lokalny panel pobiera połączenia z aktywną, zatwierdzoną technologią.</p><a class="button" href="/articles">Otwórz bibliotekę artykułów</a></section><section class="panel padded"><h2>Wykończalnie</h2><p class="muted">Aktywne pozycje można przypisywać niezależnie do każdej specyfikacji WZ.</p><form method="post" action="/settings/finishing-plants" class="finishing-plant-add">${hidden('csrf',ctx.req.session.csrf)}<label>Nowa wykończalnia<input name="name" maxlength="100" required placeholder="Nazwa wykończalni"></label><button class="primary">Dodaj wykończalnię</button></form><div class="scroll"><table class="listing compact"><thead><tr><th>Nazwa</th><th>Status</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="3">Brak wykończalni.</td></tr>'}</tbody></table></div></section><section class="panel padded"><h2>Dziewiarze</h2><p class="muted">Każda osoba ma trwały identyfikator systemowy; nazwisko służy do dopasowania z listą w programie lokalnym.</p><form method="post" action="/settings/libraries/workers" class="library-add">${hidden('csrf',ctx.req.session.csrf)}<label>Imię i nazwisko<input name="name" maxlength="100" required></label><button class="primary">Dodaj dziewiarza</button></form><div class="scroll"><table class="listing compact"><thead><tr><th>Osoba</th><th>Status</th><th></th></tr></thead><tbody>${workerRows||'<tr><td colspan="3">Brak dziewiarzy w bibliotece.</td></tr>'}</tbody></table></div></section><section class="panel padded"><h2>Wykończenia</h2><p class="muted">Słownik jest przygotowany do przyszłego modułu zleceń na wykańczalnię. Zmiany nie wpływają na specyfikacje WZ.</p><form method="post" action="/settings/libraries/finishes" class="library-add">${hidden('csrf',ctx.req.session.csrf)}<label>Rodzaj wykończenia<input name="name" maxlength="100" required></label><button class="primary">Dodaj rodzaj wykończenia</button></form><div class="scroll"><table class="listing compact"><thead><tr><th>Nazwa</th><th>Status</th><th></th></tr></thead><tbody>${finishRows||'<tr><td colspan="3">Brak rodzajów wykończeń.</td></tr>'}</tbody></table></div></section>`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Wykończalnie · Marand',body});
}

function shipmentCorrectionPage(ctx) {
  const shipments=ctx.db.prepare("SELECT * FROM shipments WHERE status='closed' ORDER BY shipment_year DESC,sequence DESC").all();
  const searchQuery=String(ctx.url.searchParams.get('q')||'').trim();
  if(ctx.url.searchParams.get('partial')==='search'){
    return shipmentCorrectionSearchResults(ctx.db,shipments,searchQuery);
  }
  const shipmentId=Number(ctx.url.searchParams.get('shipment_id')||0);
  const shipment=shipments.find(row=>row.id===shipmentId);
  const specifications=shipment?shipmentArticles(ctx.db,shipment.id):[];
  const specificationId=Number(ctx.url.searchParams.get('specification_id')||0);
  const item=specifications.find(row=>row.id===specificationId);
  const shipmentSearchValue=shipment?`Wysyłka ${shipmentNo(shipment)} · ${date(shipment.shipment_date)}`:'';
  const shipmentPicker=`<section class="panel padded shipment-correction-step"><h2>1. Wybierz wysyłkę do korekty</h2><form method="get" action="/shipments/correct" class="shipment-correction-picker shipment-correction-search" data-shipment-live-search><label>Wysyłka<input type="search" name="q" value="${V.esc(shipmentSearchValue)}" placeholder="Wpisz numer wysyłki, symbol artykułu…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="shipment-correction-search-results"></label><div id="shipment-correction-search-results" class="warehouse-search-results-wrap" data-shipment-search-results></div></form>${shipments.length?'':'<p class="muted">Nie ma zamkniętych wysyłek do skorygowania.</p>'}</section>`;
  const specificationPicker=shipment?`<section class="panel padded shipment-correction-step"><h2>2. Wybierz specyfikację do korekty</h2><p class="muted">Wysyłka ${shipmentNo(shipment)} · ${date(shipment.shipment_date)}</p><form method="get" action="/shipments/correct" class="shipment-correction-picker">${hidden('shipment_id',shipment.id)}<label>Specyfikacja<select name="specification_id" data-auto-submit required><option value="">Wybierz specyfikację</option>${specifications.map(row=>`<option value="${row.id}"${row.id===specificationId?' selected':''}>${articleNo(shipment,row)} · ${V.esc(row.symbol)} · ${row.bale_count} szt · ${money(row.weight_kg)} kg</option>`).join('')}</select></label></form>${specifications.length?'':'<p class="muted">Ta wysyłka nie ma specyfikacji.</p>'}</section>`:'';
  let editSection='';
  if(item){
    const currentBales=shipmentBales(ctx.db,item.id);
    const stockBales=ctx.db.prepare(`SELECT b.* FROM production_bales b LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
      WHERE b.article_id=? AND coalesce(f.status,'available')='available'
      AND NOT EXISTS (SELECT 1 FROM shipment_bales sb WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL)
      ORDER BY b.production_date,b.local_created_at,b.uploaded_at,b.bale_number COLLATE NOCASE`).all(item.article_id);
    const removedRows=currentBales.map((b,index)=>`<tr data-correction-current-row><td><input type="checkbox" value="${V.esc(b.local_id)}" data-correction-remove aria-label="Usuń belkę ${V.esc(b.bale_number)}"></td><td>${index+1}</td><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${V.esc(b.lot||'—')}</td><td><select data-correction-disposition aria-label="Status belki ${V.esc(b.bale_number)}" hidden disabled><option value="returned" selected>Wraca na stan</option><option value="lost">Utracona / zagubiona</option></select></td></tr>`).join('');
    const addedRows=stockBales.map((b,index)=>`<tr><td><input type="checkbox" value="${V.esc(b.local_id)}" data-correction-add data-bale-number="${V.esc(b.bale_number)}" data-weight="${money(b.weight_kg)}" data-meters="${Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}" data-lot="${V.esc(b.lot||'—')}" aria-label="Dodaj belkę ${V.esc(b.bale_number)}"></td><td>${index+1}</td><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${V.esc(b.lot||'—')}</td><td>${date(b.production_date)}</td></tr>`).join('');
    const history=shipmentCorrectionDocumentLinks(ctx,shipment);
    editSection=`<form class="shipment-correction-editor" method="post" action="/shipments/correct" data-shipment-correction-form>${hidden('csrf',ctx.req.session.csrf)}${hidden('shipment_id',shipment.id)}${hidden('specification_id',item.id)}${hidden('removed_items','')}<input type="hidden" name="added_bale_ids" value="" data-correction-added-values><section class="panel padded shipment-correction-step"><h2>3. Wybierz belki do korekty</h2><p class="muted">Specyfikacja ${articleNo(shipment,item)} · ${V.esc(item.symbol)}. Zaznacz dowolną liczbę belek do usunięcia i niezależnie wybierz belki do dodania.</p><h3>Belki w specyfikacji po korekcie · <span data-correction-spec-count>${currentBales.length}</span></h3><p class="muted small">Belki zaznaczone do usunięcia będą przekreślone. Wybrane do dodania pojawią się tu na zielono.</p><div class="panel scroll"><table class="listing compact"><thead><tr><th>Akcja</th><th>LP</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>LOT</th><th>Status po usunięciu</th></tr></thead><tbody data-correction-specification-preview>${removedRows||'<tr><td colspan="7">Brak aktywnych belek w specyfikacji.</td></tr>'}</tbody></table></div><div class="shipment-correction-save-between"><label>Powód korekty<input name="reason" maxlength="500" required></label><button class="primary" type="submit">Zapisz korektę</button></div><h3>Dostępne belki z bieżącego stanu · ${V.esc(item.symbol)} · ${stockBales.length}</h3><p class="muted small">Lista pokazuje wyłącznie dostępne belki tego artykułu, które nie są już przypisane do wysyłki.</p><div class="panel scroll"><table class="listing compact"><thead><tr><th>Dodaj</th><th>LP</th><th>Nr szt.</th><th>Masa kg</th><th>Metry</th><th>LOT</th><th>Data produkcji</th></tr></thead><tbody>${addedRows||'<tr><td colspan="7">Brak dostępnych belek tego artykułu.</td></tr>'}</tbody></table></div></section></form>${history.length?`<section class="panel padded shipment-correction-step"><h2>Historia korekt wysyłki ${shipmentNo(shipment)}</h2><ul>${history.join('')}</ul></section>`:''}`;
  }
  const body=`<a class="breadcrumb" href="/shipments">← Wysyłki</a><div class="pagehead"><div><span class="eyebrow">MAGAZYN</span><h1>Koryguj wysyłkę</h1><p class="muted">Wybierz zamkniętą wysyłkę, jej specyfikację i belki do usunięcia lub dodania.</p></div></div>${shipmentPicker}${specificationPicker}${editSection}`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:'Koryguj wysyłkę · Marand',body});
}

function shipmentSelectionPage(ctx, shipment) {
  const q = String(ctx.url.searchParams.get('q') || '').trim();
  const articles = articleBalances(ctx.db,q).filter(a=>a.stock_pieces>0);
  const currentItems = shipmentArticles(ctx.db,shipment.id);
  if(ctx.url.searchParams.get('partial')==='search') return shipmentArticleSearchResults(articles,shipment.id,0,Number(ctx.url.searchParams.get('article_id')||0));
  const articleId = Number(ctx.url.searchParams.get('article_id') || 0);
  const selectedArticle = articles.find(a=>a.id===articleId);
  const articleForm = `<form method="get" action="/shipments/${shipment.id}/select" class="shipment-select-article" data-shipment-live-search><label>Szukaj artykułu<input name="q" value="${V.esc(q)}" placeholder="Wpisz symbol artykułu" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${q?'true':'false'}" aria-controls="shipment-search-results"></label><input type="hidden" name="article_id" value="${selectedArticle?selectedArticle.id:''}"><div id="shipment-search-results" class="warehouse-search-results-wrap" data-shipment-search-results>${q?shipmentArticleSearchResults(articles,shipment.id,0,selectedArticle?.id||0):''}</div></form>`;
  const selectionToolbar = `<div class="shipment-selection-toolbar">${articleForm}</div><p class="muted small shipment-select-hint">Wpisz co najmniej 1 znak. Szukamy w symbolu i opisie; wielkość liter i polskie znaki nie mają znaczenia.</p>`;
  let availableRows = '<tr><td colspan="9">Wybierz artykuł, aby zobaczyć dostępne belki.</td></tr>';
  if(selectedArticle) {
    const available = ctx.db.prepare(`SELECT b.* FROM production_bales b LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
      WHERE b.article_id=? AND coalesce(f.status,'available')='available'
      AND NOT EXISTS (SELECT 1 FROM shipment_bales sb WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL)
      ORDER BY b.production_date,b.local_created_at,b.uploaded_at,b.bale_number COLLATE NOCASE`).all(selectedArticle.id);
    availableRows = available.map((b,i)=>{
      const meters=Number(b.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2});
      const lot=b.lot||'—',productionDate=date(b.production_date),weight=money(b.weight_kg);
      return `<tr><td><input type="checkbox" value="${V.esc(b.local_id)}" data-range-select data-bale-number="${V.esc(b.bale_number)}" data-detail-url="/warehouse/bales/${encodeURIComponent(b.local_id)}" data-weight="${V.esc(weight)}" data-meters="${V.esc(meters)}" data-errors="${b.errors}" data-stops="${b.stops}" data-lot="${V.esc(lot)}" data-date="${V.esc(productionDate)}" aria-label="Belka ${V.esc(b.bale_number)}"></td><td>${i+1}</td><td><a href="/warehouse/bales/${encodeURIComponent(b.local_id)}" target="_blank" rel="noopener">${V.esc(b.bale_number)}</a></td><td>${weight}</td><td>${meters}</td><td>${b.errors}</td><td>${b.stops}</td><td>${V.esc(lot)}</td><td>${productionDate}</td></tr>`;
    }).join('')||'<tr><td colspan="9">Brak dostępnych belek.</td></tr>';
  }
  const selectedBaleRows='<tr><td colspan="8">Zaznacz belki z tabeli po lewej.</td></tr>';
  const picker=selectedArticle?`<form id="shipment-picker-form" method="post" action="/shipments/${shipment.id}/add" data-range-selection class="shipment-picker shipment-available-form">${hidden('csrf',ctx.req.session.csrf)}${hidden('article_id',selectedArticle.id)}<input type="hidden" name="bale_ids" value="" data-range-values><section><h2>Dostępne belki · ${V.esc(selectedArticle.symbol)}</h2><p class="muted small shipment-picker-hint">Zaznacz belki do nowej specyfikacji. Shift wybiera zakres. Kliknij numer belki, aby otworzyć szczegóły.</p><div class="panel scroll"><table class="listing compact"><thead><tr><th><input type="checkbox" data-range-all aria-label="Zaznacz wszystkie dostępne belki"></th><th>LP</th><th>Nr szt.</th><th>kg</th><th>metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Data produkcji</th></tr></thead><tbody>${availableRows}</tbody></table></div></section><section><div class="shipment-picked-heading"><h2>Dodane belki · <span data-range-selected-count>0</span></h2><button type="submit" class="primary shipment-create-spec-button">Utwórz specyfikację</button></div><p class="muted small shipment-picker-hint">Belki wybrane do tej specyfikacji.</p><div class="panel scroll"><table class="listing compact"><thead><tr><th>LP</th><th>Nr szt.</th><th>kg</th><th>metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Data produkcji</th></tr></thead><tbody data-range-picked-rows>${selectedBaleRows}</tbody></table></div></form>`:`<div class="shipment-picker"><section><h2>Dostępne belki</h2><p class="muted small shipment-picker-hint">Wybierz artykuł, aby zobaczyć stan magazynu.</p><div class="panel scroll"><table class="listing compact"><thead><tr><th></th><th>LP</th><th>Nr szt.</th><th>kg</th><th>metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Data produkcji</th></tr></thead><tbody>${availableRows}</tbody></table></div></section><section><h2>Dodane belki · 0</h2><p class="muted small shipment-picker-hint">Belki wybrane do tej specyfikacji.</p><div class="panel scroll"><table class="listing compact"><thead><tr><th>LP</th><th>Nr szt.</th><th>kg</th><th>metry</th><th>Błędy</th><th>Stopy</th><th>LOT</th><th>Data produkcji</th></tr></thead><tbody><tr><td colspan="8">Wybierz artykuł, a potem belki z tabeli po lewej.</td></tr></tbody></table></div></section></div>`;
  const totals = currentItems.reduce((s,x)=>({pieces:s.pieces+x.bale_count,weight:s.weight+x.weight_kg}),{pieces:0,weight:0});
  const body = `<a class="breadcrumb" href="/shipments/${shipment.id}">← Wysyłka ${shipmentNo(shipment)}</a><div class="pagehead"><div><span class="eyebrow">WYBÓR BELEK</span><h1>Dodaj specyfikację do wysyłki ${shipmentNo(shipment)}</h1><p class="muted">Jeden wybór artykułu i belek tworzy jedną nową specyfikację. Ten sam artykuł może mieć kilka specyfikacji.</p></div><div class="shipment-totals"><strong>${totals.pieces} szt</strong><strong>${money(totals.weight)} kg</strong></div></div>${selectionToolbar}${picker}`;
  return V.layout({user:ctx.req.user,csrf:ctx.req.session.csrf,flashes:ctx.getFlashes(ctx.req),title:`Wybór belek · ${shipmentNo(shipment)} · Marand`,body});
}

function shipmentArticleSearchResults(articles, shipmentId, specificationId=0, selectedArticleId=0) {
  const matches=articles.filter(article=>article.stock_pieces>0&&article.id!==selectedArticleId);
  if(!matches.length) return '<p class="warehouse-search-empty">Brak artykułów z dostępnymi belkami.</p>';
  return `<div class="warehouse-search-results" role="listbox" aria-label="Pasujące artykuły">${matches.map(article=>`<a id="shipment-article-option-${article.id}" role="option" aria-selected="false" class="warehouse-article-option" href="/shipments/${shipmentId}/select?article_id=${article.id}${specificationId?`&specification_id=${specificationId}`:''}"><strong>${V.esc(article.symbol)}</strong><span>${article.stock_pieces} szt · ${money(article.stock_weight)} kg</span></a>`).join('')}</div>`;
}

function wzPage(ctx, shipment, item) {
  const liveArticle = ctx.db.prepare('SELECT a.*,r.version,r.payload FROM articles a LEFT JOIN records r ON r.id=a.active_spec WHERE a.id=?').get(item.article_id);
  let snapshot=null;try{snapshot=item.closed_snapshot?JSON.parse(item.closed_snapshot):null}catch{}
  const article = snapshot?.article || liveArticle;
  let payload = {};
  try { payload = JSON.parse(article?.payload || '{}'); } catch {}
  const bales = shipmentBales(ctx.db,item.id);
  const rows = bales.map((b,i)=>`<tr><td>${i+1}</td><td>${V.esc(b.symbol)}</td><td>${V.esc(b.bale_number)}</td><td>${money(b.weight_kg)}</td><td>${b.errors}</td><td>${b.stops}</td><td>${V.esc(b.lot||'')}</td><td>${V.esc(b.notes||'')}</td><td>${date(b.production_date)}</td></tr>`).join('');
  const totalWeight = bales.reduce((sum,b)=>sum+b.weight_kg,0);
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${articleNo(shipment,item)} ${V.esc(article?.symbol||'')} · WZ</title><link rel="stylesheet" href="/static/app.css"><script defer src="/static/app.js"></script><style>@page{size:A4 portrait;margin:9mm}.wz-page{max-width:210mm;margin:12px auto;background:#fff;padding:8mm;color:#111;font:10px/1.25 Arial,sans-serif}.wz-toolbar{display:flex;justify-content:space-between;align-items:center;max-width:210mm;margin:12px auto}.wz-page h1{font-size:18px;letter-spacing:0;margin:4px 0;text-align:center}.wz-page h2{background:#555;color:#fff;font-size:10px;text-align:center;padding:4px;margin:10px 0 0}.wz-meta{display:grid;grid-template-columns:1fr 1fr;gap:3px;border:1px solid #555;padding:6px;margin:8px 0}.wz-page table{width:100%;border-collapse:collapse;table-layout:fixed}.wz-page th,.wz-page td{border:1px solid #555;padding:3px 2px;vertical-align:middle;text-align:center;overflow-wrap:anywhere}.wz-page th{background:#eee;font-weight:600}.wz-page td{font-weight:600}.wz-page .bales th:nth-child(1){width:5%}.wz-page .bales th:nth-child(2){width:16%}.wz-page .bales th:nth-child(3){width:11%}.wz-page .bales th:nth-child(4){width:8%}.wz-page .bales th:nth-child(5),.wz-page .bales th:nth-child(6){width:6%}.wz-page .bales th:nth-child(7){width:18%}.wz-page .bales th:nth-child(8){width:17%}.wz-page .bales th:nth-child(9){width:13%}.wz-page .wz-total-row th{font-weight:bold;background:#eee}.wz-page .signatures{display:flex;gap:25px;margin:20px 0}.wz-page .signatures span{flex:1;border-bottom:1px solid #555;padding-bottom:18px}@media print{body{background:#fff}.wz-toolbar{display:none}.wz-page{margin:0;padding:0;max-width:none}.wz-page h2{print-color-adjust:exact;-webkit-print-color-adjust:exact}.bales tr{break-inside:avoid}}</style></head><body><div class="wz-toolbar"><button data-print>Drukuj / zapisz jako PDF</button><a href="/shipments/${shipment.id}">Wróć do wysyłki</a></div><main class="wz-page"><h1>SPECYFIKACJA WYSYŁKI · ${V.esc(article?.symbol||'')}</h1><div class="wz-meta"><div><b>Symbol:</b> ${V.esc(payload.symbol||article?.symbol||'')}</div><div><b>Dostawca:</b> MARAND · ul. Szadkowska 72, 98-220 Zduńska Wola</div><div><b>Odbiorca:</b> MARAND · Łódź</div><div><b>Przesunięcie magazynowe:</b> ${shipmentNo(shipment)}</div><div><b>Dnia:</b> ${date(shipment.shipment_date)} · <b>Dokument:</b> ${articleNo(shipment,item)}</div></div><h2>Wykaz belek</h2><table class="bales"><thead><tr><th>Lp.</th><th>Symbol</th><th>Nr szt.</th><th>Masa kg</th><th>Błędy</th><th>Stop</th><th>LOT</th><th>Uwagi</th><th>Data produkcji</th></tr></thead><tbody>${rows||'<tr><td colspan="9">Brak belek.</td></tr>'}<tr class="wz-total-row"><th colspan="3">Razem · ${bales.length} szt.</th><th>${money(totalWeight)} kg</th><th colspan="5"></th></tr></tbody></table><div class="signatures"><span>Wydano</span><span>Odebrano</span></div></main></body></html>`;
}

function correctionPage(ctx, shipment, correctionId) {
  if(ctx.url.searchParams.get('batch')==='1'){
    const correction=ctx.db.prepare(`SELECT c.*,sa.sequence,a.symbol,u.name author
      FROM shipment_correction_batches c JOIN shipment_articles sa ON sa.id=c.shipment_article_id
      JOIN articles a ON a.id=sa.article_id LEFT JOIN users u ON u.id=c.created_by
      WHERE c.id=? AND c.shipment_id=?`).get(correctionId,shipment.id);
    if(!correction) throw Object.assign(new Error('Nie znaleziono korekty.'),{status:404});
    const items=ctx.db.prepare(`SELECT i.action,i.disposition,b.bale_number,b.weight_kg,b.meters,b.lot,a.symbol
      FROM shipment_correction_items i JOIN production_bales b ON b.local_id=i.bale_local_id
      JOIN articles a ON a.id=b.article_id WHERE i.correction_batch_id=?
      ORDER BY CASE i.action WHEN 'removed' THEN 0 ELSE 1 END,b.bale_number COLLATE NOCASE`).all(correctionId);
    const disposition={returned:'Wróciła do bieżącego stanu',mistaken:'Pomylona sztuka · wróciła do bieżącego stanu',lost:'Zagubiona',shipped_out:'Bez zmian'};
    const rows=items.map(item=>`<tr><td>${item.action==='removed'?'Usunięto':'Dodano'}</td><td>${V.esc(item.symbol)}</td><td>${V.esc(item.bale_number)}</td><td>${money(item.weight_kg)} kg</td><td>${Number(item.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${item.action==='removed'?disposition[item.disposition]:'—'}</td></tr>`).join('');
    return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Korekta wysyłki ${shipmentNo(shipment)}</title><style>@page{size:A4 portrait;margin:12mm}body{font:11px/1.4 Arial,sans-serif;color:#111}.bar{display:flex;justify-content:space-between;margin-bottom:16px}.sheet{max-width:194mm;margin:auto}h1{font-size:19px;margin:0 0 12px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:10px;background:#f0f1f2;margin-bottom:12px}.reason{margin:12px 0;padding:10px;border:1px solid #bbb}table{width:100%;border-collapse:collapse;font-size:9pt}th,td{border:1px solid #777;padding:5px;text-align:left}th{background:#eee}@media print{.bar{display:none}.sheet{margin:0}}</style><script defer src="/static/app.js"></script></head><body><div class="bar"><button data-print>Drukuj / zapisz jako PDF</button><a href="/shipments/correct?shipment_id=${shipment.id}&specification_id=${correction.shipment_article_id}">Wróć do korekty wysyłki</a></div><main class="sheet"><h1>KOREKTA WYSYŁKI ${shipmentNo(shipment)}</h1><div class="meta"><div><b>Specyfikacja:</b> ${articleNo(shipment,correction)} · ${V.esc(correction.symbol)}</div><div><b>Data wysyłki:</b> ${date(shipment.shipment_date)}</div><div><b>Numer korekty:</b> ${correctionId}</div><div><b>Data korekty:</b> ${V.datepl(correction.created_at)}</div><div><b>Wystawił(a):</b> ${V.esc(correction.author||'—')}</div></div><div class="reason"><b>Powód:</b> ${V.esc(correction.reason)}</div><table><thead><tr><th>Operacja</th><th>Artykuł</th><th>Nr szt.</th><th>Masa</th><th>Metry</th><th>Rozliczenie</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
  }
  const c=ctx.db.prepare(`SELECT c.*,old.bale_number old_number,old_a.symbol old_symbol,
      new.bale_number new_number,new_a.symbol new_symbol,u.name author
    FROM shipment_corrections c JOIN production_bales old ON old.local_id=c.removed_bale_local_id
    JOIN articles old_a ON old_a.id=old.article_id LEFT JOIN production_bales new ON new.local_id=c.replacement_bale_local_id
    LEFT JOIN articles new_a ON new_a.id=new.article_id LEFT JOIN users u ON u.id=c.created_by
    WHERE c.id=? AND c.shipment_id=?`).get(correctionId,shipment.id);
  if(!c) throw Object.assign(new Error('Nie znaleziono korekty.'),{status:404});
  const disposition={returned:'Wróciła do bieżącego stanu',lost:'Zagubiona',shipped_out:'Bez zmian'}[c.disposition];
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Korekta WZ ${shipmentNo(shipment)}</title><style>@page{size:A4 portrait;margin:15mm}body{font:12px/1.5 Arial,sans-serif;color:#111}.sheet{max-width:180mm;margin:20px auto}.bar{margin-bottom:24px}h1{text-align:center;font-size:21px}.meta{border:1px solid #555;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.row{margin:28px 0;padding:16px;border:1px solid #555}.label{color:#666}.sign{display:flex;gap:30px;margin-top:55px}.sign span{flex:1;border-bottom:1px solid #555;padding-bottom:35px}@media print{.bar{display:none}.sheet{margin:0}}</style><script defer src="/static/app.js"></script></head><body><div class="bar"><button data-print>Drukuj / zapisz jako PDF</button> <a href="/shipments/${shipment.id}">Wróć do wysyłki</a></div><main class="sheet"><h1>KOREKTA SPECYFIKACJI WYSYŁKI</h1><div class="meta"><div><b>Wysyłka:</b> ${shipmentNo(shipment)}</div><div><b>Data wysyłki:</b> ${date(shipment.shipment_date)}</div><div><b>Korekta nr:</b> ${correctionId}</div><div><b>Data korekty:</b> ${V.datepl(c.created_at)}</div></div><section class="row"><p><span class="label">Usunięto z wykazu:</span> <b>${V.esc(c.old_symbol)} · ${V.esc(c.old_number)}</b></p>${c.new_number?`<p><span class="label">Dodano:</span> <b>${V.esc(c.new_symbol)} · ${V.esc(c.new_number)}</b></p>`:''}<p><span class="label">Rozliczenie błędnej belki:</span> <b>${disposition}</b></p><p><span class="label">Powód:</span> ${V.esc(c.reason)}</p></section><p>Wystawił(a): ${V.esc(c.author||'')}</p><div class="sign"><span>Wydano</span><span>Odebrano</span></div></main></body></html>`;
}

function saveShipmentCorrection(ctx) {
  const {req,res,db,transaction}=ctx;
  const shipmentId=Number(ctx.form.shipment_id||0),itemId=Number(ctx.form.specification_id||0),reason=String(ctx.form.reason||'').trim().slice(0,500);
  let removedItems=[];
  try{removedItems=JSON.parse(String(ctx.form.removed_items||'[]'));}catch{throw Object.assign(new Error('Nieprawidłowa lista belek do usunięcia.'),{status:400});}
  if(!Array.isArray(removedItems)||removedItems.length>500||removedItems.some(item=>!item||typeof item.id!=='string'||!item.id||!['returned','lost'].includes(item.disposition))) throw Object.assign(new Error('Nieprawidłowa lista belek do usunięcia.'),{status:400});
  const removedIds=removedItems.map(item=>item.id);
  const addedIds=[...new Set(String(ctx.form.added_bale_ids||'').split(',').filter(Boolean))];
  if(new Set(removedIds).size!==removedIds.length) throw Object.assign(new Error('Ta sama belka została zaznaczona więcej niż raz.'),{status:400});
  if(!removedIds.length&&!addedIds.length) throw Object.assign(new Error('Zaznacz przynajmniej jedną belkę do usunięcia lub dodania.'),{status:400});
  if(!reason) throw Object.assign(new Error('Wpisz powód korekty.'),{status:400});
  const shipment=shipmentRecord(db,shipmentId),item=db.prepare('SELECT * FROM shipment_articles WHERE id=? AND shipment_id=?').get(itemId,shipmentId);
  if(!shipment||!item) throw Object.assign(new Error('Nie znaleziono wysyłki lub specyfikacji.'),{status:404});
  if(shipment.status!=='closed') throw Object.assign(new Error('Korygować można tylko zamkniętą wysyłkę.'),{status:409});
  const correctionId=transaction(()=>{
    const currentShipment=shipmentRecord(db,shipmentId),currentItem=db.prepare('SELECT * FROM shipment_articles WHERE id=? AND shipment_id=?').get(itemId,shipmentId);
    if(!currentShipment||currentShipment.status!=='closed'||!currentItem) throw Object.assign(new Error('Wysyłka lub specyfikacja nie jest już dostępna do korekty.'),{status:409});
    const removals=[];
    for(const selected of removedItems){
      const old=db.prepare(`SELECT sb.id,b.article_id FROM shipment_bales sb JOIN production_bales b ON b.local_id=sb.bale_local_id
        WHERE sb.shipment_article_id=? AND sb.bale_local_id=? AND sb.removed_at IS NULL`).get(itemId,selected.id);
      if(!old) throw Object.assign(new Error(`Belka ${selected.id} nie należy już do tej specyfikacji.`),{status:409});
      removals.push({...selected,rowId:old.id});
    }
    const additions=[];
    for(const baleId of addedIds){
      const bale=baleAvailableForNewShipment(db,baleId);
      if(!bale||Number(bale.article_id)!==Number(currentItem.article_id)) throw Object.assign(new Error(`Belka ${baleId} nie jest już dostępna w bieżącym stanie tego artykułu.`),{status:409});
      additions.push(baleId);
    }
    const batchId=Number(db.prepare('INSERT INTO shipment_correction_batches(shipment_id,shipment_article_id,reason,created_at,created_by) VALUES(?,?,?,?,?)').run(shipmentId,itemId,reason,ctx.now(),req.user.id).lastInsertRowid);
    const addCorrectionItem=db.prepare('INSERT INTO shipment_correction_items(correction_batch_id,bale_local_id,action,disposition) VALUES(?,?,?,?)');
    for(const old of removals){
      db.prepare('UPDATE shipment_bales SET removed_at=?,removed_by=?,removal_reason=? WHERE id=? AND removed_at IS NULL').run(ctx.now(),req.user.id,`Korekta: ${reason}`,old.rowId);
      addCorrectionItem.run(batchId,old.id,'removed',old.disposition);
      if(old.disposition==='lost'||old.disposition==='shipped_out') db.prepare('INSERT INTO warehouse_bale_flags(bale_local_id,status,reason,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(bale_local_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(old.id,old.disposition,reason,ctx.now(),req.user.id);
      else db.prepare('DELETE FROM warehouse_bale_flags WHERE bale_local_id=?').run(old.id);
    }
    for(const baleId of additions){
      db.prepare('INSERT INTO shipment_bales(shipment_article_id,bale_local_id,added_at) VALUES(?,?,?)').run(itemId,baleId,ctx.now());
      addCorrectionItem.run(batchId,baleId,'added',null);
    }
    return batchId;
  });
  ctx.audit(req.user,'Skorygowano zamkniętą wysyłkę',null,JSON.stringify({shipmentId,itemId,correctionId,removedItems,addedIds,reason}),null);
  return ctx.redirect(req,res,`/shipments/${shipmentId}/correction/${correctionId}?batch=1`,'Korektę wysyłki zapisano. Podgląd WZ pokazuje aktualne belki.');
}

// Keep the historical single-bale endpoint working for existing integrations
// and references. New corrections are created through /shipments/correct.
function saveLegacyShipmentCorrection(ctx, shipmentId, itemId) {
  const {req,res,db,transaction}=ctx;
  const shipment=shipmentRecord(db,shipmentId),item=db.prepare('SELECT * FROM shipment_articles WHERE id=? AND shipment_id=?').get(itemId,shipmentId);
  if(!shipment||!item) throw Object.assign(new Error('Nie znaleziono wysyłki lub specyfikacji.'),{status:404});
  if(shipment.status!=='closed') throw Object.assign(new Error('Korygować można tylko zamkniętą wysyłkę.'),{status:409});
  const oldId=String(ctx.form.old_bale_id||''),newId=String(ctx.form.new_bale_id||''),disposition=String(ctx.form.disposition||''),reason=String(ctx.form.reason||'').trim().slice(0,500);
  if(!oldId||!reason||!['returned','lost','shipped_out'].includes(disposition)) throw Object.assign(new Error('Uzupełnij błędną belkę, sposób rozliczenia i powód korekty.'),{status:400});
  const correctionId=transaction(()=>{
    const old=db.prepare('SELECT id FROM shipment_bales WHERE shipment_article_id=? AND bale_local_id=? AND removed_at IS NULL').get(itemId,oldId);
    if(!old) throw Object.assign(new Error('Wybrana belka nie należy do tej specyfikacji.'),{status:409});
    let replacement=null;
    if(newId){replacement=baleAvailableForNewShipment(db,newId);if(!replacement||Number(replacement.article_id)!==Number(item.article_id))throw Object.assign(new Error('Belka zastępcza musi być dostępna i należeć do tego samego artykułu.'),{status:409});}
    db.prepare('UPDATE shipment_bales SET removed_at=?,removed_by=?,removal_reason=? WHERE id=?').run(ctx.now(),req.user.id,`Korekta: ${reason}`,old.id);
    const result=db.prepare('INSERT INTO shipment_corrections(shipment_id,shipment_article_id,removed_bale_local_id,replacement_bale_local_id,disposition,reason,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)').run(shipmentId,itemId,oldId,newId||null,disposition,reason,ctx.now(),req.user.id);
    if(disposition==='lost'||disposition==='shipped_out') db.prepare('INSERT INTO warehouse_bale_flags(bale_local_id,status,reason,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(bale_local_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(oldId,disposition,reason,ctx.now(),req.user.id);
    else db.prepare('DELETE FROM warehouse_bale_flags WHERE bale_local_id=?').run(oldId);
    if(replacement) db.prepare('INSERT INTO shipment_bales(shipment_article_id,bale_local_id,added_at) VALUES(?,?,?)').run(itemId,newId,ctx.now());
    return Number(result.lastInsertRowid);
  });
  ctx.audit(req.user,'Skorygowano specyfikację zamkniętej wysyłki',null,JSON.stringify({shipmentId,itemId,correctionId,oldId,newId,disposition,reason}),null);
  return ctx.redirect(req,res,`/shipments/${shipmentId}/correction/${correctionId}`,'Korektę specyfikacji zapisano.');
}

function handle(ctx) {
  const {req,res,p,db,send,redirect,role,transaction}=ctx;
  if(p==='/shipments/correct'&&req.method==='GET'){role(req.user,...managerRoles);return send(req,res,200,shipmentCorrectionPage(ctx));}
  if(p==='/shipments/correct'&&req.method==='POST'){role(req.user,...managerRoles);return saveShipmentCorrection(ctx);}
  const legacyCorrection=p.match(/^\/shipments\/(\d+)\/specifications\/(\d+)\/correct$/);
  if(legacyCorrection&&req.method==='POST'){role(req.user,...managerRoles);return saveLegacyShipmentCorrection(ctx,Number(legacyCorrection[1]),Number(legacyCorrection[2]));}
  if(p==='/settings'&&req.method==='GET') return redirect(req,res,'/settings/libraries');
  if(p==='/settings/libraries'&&req.method==='GET') return send(req,res,200,finishingPlantsPage(ctx));
  if(p==='/settings/finishing-plants'&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz nazwę wykończalni.'),{status:400});
    try{db.prepare('INSERT INTO finishing_plants(name,name_key,active,created_at,created_by) VALUES(?,?,1,?,?)').run(name,normalizeSearch(name),ctx.now(),req.user.id);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Wykończalnia o takiej nazwie już istnieje.'),{status:409});throw error;}
    return redirect(req,res,'/settings/libraries','Dodano wykończalnię.');
  }
  const plantEdit=p.match(/^\/settings\/finishing-plants\/(\d+)\/edit$/);
  if(plantEdit&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz nazwę wykończalni.'),{status:400});
    try{
      const result=db.prepare('UPDATE finishing_plants SET name=?,name_key=? WHERE id=?').run(name,normalizeSearch(name),Number(plantEdit[1]));
      if(!result.changes) throw Object.assign(new Error('Nie znaleziono wykończalni.'),{status:404});
    }catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Wykończalnia o takiej nazwie już istnieje.'),{status:409});throw error;}
    if(req.headers['x-requested-with']==='fetch') return send(req,res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');
    return redirect(req,res,'/settings/libraries','Zapisano nazwę wykończalni.');
  }
  const plantToggle=p.match(/^\/settings\/finishing-plants\/(\d+)\/toggle$/);
  if(plantToggle&&req.method==='POST'){
    role(req.user,...managerRoles);
    const result=db.prepare('UPDATE finishing_plants SET active=1-active WHERE id=?').run(Number(plantToggle[1]));
    if(!result.changes) throw Object.assign(new Error('Nie znaleziono wykończalni.'),{status:404});
    return redirect(req,res,'/settings/libraries','Zmieniono status wykończalni.');
  }
  if(p==='/settings/libraries/workers'&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz imię i nazwisko dziewiarza.'),{status:400});
    const employeeUid=crypto.randomUUID();
    try{db.prepare('INSERT INTO knitting_workers(employee_uid,code,name,active,name_key,created_at,updated_at,updated_by) VALUES(? ,\'\',?,1,?,?,?,?)').run(employeeUid,name,normalizeSearch(name),ctx.now(),ctx.now(),req.user.id);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Taki dziewiarz jest już w bibliotece.'),{status:409});throw error;}
    if(req.headers['x-requested-with']==='fetch') return send(req,res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');
    return redirect(req,res,'/settings/libraries','Dodano dziewiarza.');
  }
  const workerEdit=p.match(/^\/settings\/libraries\/workers\/([0-9a-f-]+)\/edit$/i);
  if(workerEdit&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz imię i nazwisko dziewiarza.'),{status:400});
    let result;
    try{result=db.prepare('UPDATE knitting_workers SET name=?,name_key=?,updated_at=?,updated_by=? WHERE employee_uid=?').run(name,normalizeSearch(name),ctx.now(),req.user.id,workerEdit[1]);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Taki dziewiarz jest już w bibliotece.'),{status:409});throw error;}
    if(!result.changes) throw Object.assign(new Error('Nie znaleziono dziewiarza.'),{status:404});
    if(req.headers['x-requested-with']==='fetch') return send(req,res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');
    return redirect(req,res,'/settings/libraries','Zapisano dane dziewiarza.');
  }
  const workerToggle=p.match(/^\/settings\/libraries\/workers\/([0-9a-f-]+)\/toggle$/i);
  if(workerToggle&&req.method==='POST'){
    role(req.user,...managerRoles);
    const result=db.prepare('UPDATE knitting_workers SET active=1-active,updated_at=?,updated_by=? WHERE employee_uid=?').run(ctx.now(),req.user.id,workerToggle[1]);
    if(!result.changes) throw Object.assign(new Error('Nie znaleziono dziewiarza.'),{status:404});
    return redirect(req,res,'/settings/libraries','Zmieniono status dziewiarza.');
  }
  if(p==='/settings/libraries/finishes'&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz rodzaj wykończenia.'),{status:400});
    try{db.prepare('INSERT INTO finishing_types(name,name_key,active,created_at,updated_at,updated_by) VALUES(?,?,1,?,?,?)').run(name,normalizeSearch(name),ctx.now(),ctx.now(),req.user.id);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Taki rodzaj wykończenia już istnieje.'),{status:409});throw error;}
    return redirect(req,res,'/settings/libraries','Dodano rodzaj wykończenia.');
  }
  const finishEdit=p.match(/^\/settings\/libraries\/finishes\/(\d+)\/edit$/);
  if(finishEdit&&req.method==='POST'){
    role(req.user,...managerRoles);
    const name=String(ctx.form.name||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!name) throw Object.assign(new Error('Wpisz rodzaj wykończenia.'),{status:400});
    try{const result=db.prepare('UPDATE finishing_types SET name=?,name_key=?,updated_at=?,updated_by=? WHERE id=?').run(name,normalizeSearch(name),ctx.now(),req.user.id,Number(finishEdit[1]));if(!result.changes)throw Object.assign(new Error('Nie znaleziono rodzaju wykończenia.'),{status:404});}
    catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('Taki rodzaj wykończenia już istnieje.'),{status:409});throw error;}
    if(req.headers['x-requested-with']==='fetch') return send(req,res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');
    return redirect(req,res,'/settings/libraries','Zapisano rodzaj wykończenia.');
  }
  const finishToggle=p.match(/^\/settings\/libraries\/finishes\/(\d+)\/toggle$/);
  if(finishToggle&&req.method==='POST'){
    role(req.user,...managerRoles);
    const result=db.prepare('UPDATE finishing_types SET active=1-active,updated_at=?,updated_by=? WHERE id=?').run(ctx.now(),req.user.id,Number(finishToggle[1]));
    if(!result.changes) throw Object.assign(new Error('Nie znaleziono rodzaju wykończenia.'),{status:404});
    return redirect(req,res,'/settings/libraries','Zmieniono status rodzaju wykończenia.');
  }
  if(p==='/warehouse/export.xlsx'&&req.method==='GET') {
    const articleId=Number(ctx.url.searchParams.get('article_id')||0);
    if(!Number.isSafeInteger(articleId)||articleId<1) throw Object.assign(new Error('Wybierz artykuł przed eksportem.'),{status:400});
    const article=articleBalances(db).find(row=>row.id===articleId);
    if(!article) throw Object.assign(new Error('Nie znaleziono artykułu w wykazie sztuk.'),{status:404});
    const symbolPart=articleFilenamePart(article);
    const filename=`wykaz-${symbolPart}-${ctx.todayWarsaw()}.xlsx`;
    return send(req,res,200,warehouseExcel(ctx,article),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{ 'Content-Disposition':`attachment; filename="${filename}"` });
  }
  if(p==='/warehouse'&&req.method==='GET') return send(req,res,200,catalogPage(ctx));
  if(p==='/warehouse/bales/status'&&req.method==='POST') {
    role(req.user,...managerRoles);
    const ids=String(ctx.form.bale_ids||'').split(',').filter(Boolean);
    const status=String(ctx.form.status||''), reason=String(ctx.form.reason||'').trim().slice(0,500), articleId=Number(ctx.form.article_id);
    const customStatus=String(ctx.form.custom_status||'').trim().replace(/\s+/g,' ').slice(0,120);
    if(!ids.length||!['lost','available','second_grade','stripe_risk','custom'].includes(status)) throw Object.assign(new Error('Zaznacz prawidłowe belki.'),{status:400});
    if(status==='custom'&&!customStatus) throw Object.assign(new Error('Wpisz własny status dla zaznaczonych belek.'),{status:400});
    transaction(()=>{
      for(const id of ids){
        const bale=db.prepare(`SELECT b.local_id FROM production_bales b WHERE b.local_id=? AND b.article_id=? AND NOT EXISTS(SELECT 1 FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id JOIN shipments sh ON sh.id=sa.shipment_id WHERE sb.bale_local_id=b.local_id AND sb.removed_at IS NULL AND (sh.status='closed' OR sh.status='draft'))`).get(id,articleId);
        if(!bale) throw Object.assign(new Error('Niektóre zaznaczone belki są już przypisane do wysyłki lub ich stan się zmienił.'),{status:409});
        if(status==='lost') db.prepare(`INSERT INTO warehouse_bale_flags(bale_local_id,status,reason,updated_at,updated_by) VALUES(?,'lost',?,?,?) ON CONFLICT(bale_local_id) DO UPDATE SET status='lost',reason=excluded.reason,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(id,reason,ctx.now(),req.user.id);
        else if(status==='available'){
          db.prepare("DELETE FROM warehouse_bale_flags WHERE bale_local_id=? AND status='lost'").run(id);
          db.prepare('DELETE FROM warehouse_bale_tags WHERE bale_local_id=?').run(id);
          db.prepare('DELETE FROM warehouse_bale_custom_statuses WHERE bale_local_id=?').run(id);
        }else if(status==='custom'){
          db.prepare(`INSERT INTO warehouse_bale_custom_statuses(bale_local_id,status,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?)
            ON CONFLICT(bale_local_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(id,customStatus,ctx.now(),req.user.id,ctx.now(),req.user.id);
        }else db.prepare('INSERT OR IGNORE INTO warehouse_bale_tags(bale_local_id,tag,created_at,created_by) VALUES(?,?,?,?)').run(id,status,ctx.now(),req.user.id);
      }
      const action={lost:'Oznaczono belki jako zagubione',available:'Usunięto oznaczenia belek / przywrócono dostępność',second_grade:'Oznaczono belki jako drugi gatunek',stripe_risk:'Oznaczono ryzyko pasiastości belek',custom:'Dodano własny status belek'}[status];
      ctx.audit(req.user,action,null,JSON.stringify({articleId,ids,reason}),articleId);
    });
    const message={lost:'Belki oznaczono jako zagubione.',available:'Usunięto oznaczenia i przywrócono dostępność.',second_grade:'Oznaczono belki jako drugi gatunek.',stripe_risk:'Oznaczono ryzyko pasiastości belek.',custom:'Dodano własny status do zaznaczonych belek.'}[status];
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
      db.prepare('INSERT OR IGNORE INTO shipment_sequence_counters(shipment_year,last_value) VALUES(?,0)').run(year);
      const sequence=nextShipmentSequence(db,year);
      db.prepare('UPDATE shipment_sequence_counters SET last_value=max(last_value,?) WHERE shipment_year=?').run(sequence,year);
      return Number(db.prepare("INSERT INTO shipments(shipment_year,sequence,status,shipment_date,created_at,created_by) VALUES(?,?,'draft',?,?,?)").run(year,sequence,today,ctx.now(),req.user.id).lastInsertRowid);
    });
    ctx.audit(req.user,'Utworzono roboczą wysyłkę',null,JSON.stringify({shipmentId:id,year}),null);
    return redirect(req,res,`/shipments/${id}`,'Utworzono nową wysyłkę.');
  }
  const pathMatch=p.match(/^\/shipments\/(\d+)(?:\/(select|add|remove|date|close|cancel|delete|report|wz\/(\d+)|correction\/(\d+)|specifications\/(\d+)\/(delete)))?$/);
  if(pathMatch){
    const id=Number(pathMatch[1]),action=pathMatch[2]||'',itemId=Number(pathMatch[3]||0),correctionId=Number(pathMatch[4]||0),specificationId=Number(pathMatch[5]||0),specificationAction=pathMatch[6]||'',shipment=shipmentRecord(db,id);
    if(!shipment) throw Object.assign(new Error('Nie znaleziono wysyłki.'),{status:404});
    if(action==='report'&&req.method==='GET') {
      if(shipment.status!=='closed') throw Object.assign(new Error('Raport można wydrukować po zamknięciu wysyłki.'),{status:409});
      return send(req,res,200,shipmentReportPage(ctx,shipment),'text/html; charset=utf-8');
    }
    if(action.startsWith('wz/')){
      const item=shipmentArticles(db,id).find(x=>x.id===itemId);
      if(!item) throw Object.assign(new Error('Nie znaleziono dokumentu artykułu w tej wysyłce.'),{status:404});
      return send(req,res,200,wzPage(ctx,shipment,item),'text/html; charset=utf-8');
    }
    if(action.startsWith('correction/')) return send(req,res,200,correctionPage(ctx,shipment,correctionId),'text/html; charset=utf-8');
    if(specificationAction==='delete'){
      role(req.user,...managerRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Specyfikację można usunąć tylko z roboczej wysyłki.'),{status:409});
      const item=shipmentArticles(db,id).find(row=>row.id===specificationId);
      if(!item) throw Object.assign(new Error('Nie znaleziono specyfikacji w tej wysyłce.'),{status:404});
      if(req.method==='GET') return send(req,res,200,shipmentArticleDeleteConfirmPage(ctx,shipment,item));
      if(req.method==='POST'){
        if(ctx.form.confirm_delete_specification!=='1') throw Object.assign(new Error('Potwierdź usunięcie specyfikacji.'),{status:400});
        const baleIds=shipmentBales(db,item.id).map(bale=>bale.local_id);
        transaction(()=>{
          db.prepare('DELETE FROM shipment_bales WHERE shipment_article_id=?').run(item.id);
          db.prepare('DELETE FROM shipment_articles WHERE id=? AND shipment_id=?').run(item.id,id);
        });
        ctx.audit(req.user,'Usunięto specyfikację z roboczej wysyłki',null,JSON.stringify({shipmentId:id,specificationId:item.id,sequence:item.sequence,articleId:item.article_id,baleIds}),null);
        return redirect(req,res,`/shipments/${id}`,`Usunięto specyfikację ${articleNo(shipment,item)}; belki zwolniono, a jej numer będzie można wykorzystać ponownie.`);
      }
    }
    if(action==='select'&&req.method==='GET'){
      role(req.user,...editableRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Zamkniętej wysyłki nie można zmieniać.'),{status:409});
      return send(req,res,200,shipmentSelectionPage(ctx,shipment));
    }
    if(action==='delete'&&req.method==='GET'){
      role(req.user,...managerRoles);
      if(!['draft','cancelled'].includes(shipment.status)) throw Object.assign(new Error('Można usuwać tylko robocze wysyłki.'),{status:409});
      return send(req,res,200,shipmentConfirmPage(ctx,shipment,'delete'));
    }
    if(action==='delete'&&req.method==='POST'){
      role(req.user,...managerRoles);
      if(!['draft','cancelled'].includes(shipment.status)||ctx.form.confirm_delete!=='1') throw Object.assign(new Error('Potwierdź całkowite usunięcie roboczej wysyłki.'),{status:400});
      transaction(()=>eraseDraftShipment(db,id));
      return redirect(req,res,'/shipments','Usunięto wysyłkę i zwolniono przypisane belki.');
    }
    if(action==='add'&&req.method==='POST'){
      role(req.user,...editableRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Zamkniętej wysyłki nie można zmieniać.'),{status:409});
      const ids=[...new Set(String(ctx.form.bale_ids||'').split(',').filter(Boolean))];
      if(!ids.length) throw Object.assign(new Error('Zaznacz belki do dodania.'),{status:400});
      const articleId=Number(ctx.form.article_id),plantId=Number(ctx.form.finishing_plant_id||0);
      if(!articleId) throw Object.assign(new Error('Wybierz artykuł dla tej specyfikacji.'),{status:400});
      if(plantId&&!db.prepare('SELECT id FROM finishing_plants WHERE id=? AND active=1').get(plantId)) throw Object.assign(new Error('Wybrana wykończalnia jest nieaktywna.'),{status:400});
      transaction(()=>{
        const verified=[];
        for(const baleId of ids){
          const bale=baleAvailableForNewShipment(db,baleId);
          if(!bale) throw Object.assign(new Error(`Belka ${baleId} nie jest już dostępna do wysyłki. Odśwież listę.`),{status:409});
          if(Number(bale.article_id)!==articleId) throw Object.assign(new Error('Wszystkie zaznaczone belki muszą pochodzić z wybranego artykułu.'),{status:400});
          verified.push(baleId);
        }
        const seq=nextShipmentArticleSequence(db,id);
        const itemId=Number(db.prepare('INSERT INTO shipment_articles(shipment_id,article_id,sequence,finishing_plant_id) VALUES(?,?,?,?)').run(id,articleId,seq,plantId||null).lastInsertRowid);
        for(const baleId of verified) db.prepare('INSERT INTO shipment_bales(shipment_article_id,bale_local_id,added_at) VALUES(?,?,?)').run(itemId,baleId,ctx.now());
      });
      ctx.audit(req.user,'Utworzono specyfikację i dodano belki do roboczej wysyłki',null,JSON.stringify({shipmentId:id,articleId,baleIds:ids}),null);
      return redirect(req,res,`/shipments/${id}`,'Dodano nową specyfikację do wysyłki.');
    }
    if(action==='remove'&&req.method==='POST'){
      role(req.user,...editableRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Zamkniętej wysyłki nie można zmieniać.'),{status:409});
      const baleId=String(ctx.form.bale_id||''),specificationId=Number(ctx.form.specification_id||0);
      if(!Number.isSafeInteger(specificationId)||specificationId<1||!db.prepare('SELECT id FROM shipment_articles WHERE id=? AND shipment_id=?').get(specificationId,id)) throw Object.assign(new Error('Nie znaleziono tej specyfikacji w wysyłce.'),{status:404});
      const result=db.prepare(`UPDATE shipment_bales SET removed_at=?,removed_by=?,removal_reason='Usunięto z roboczej wysyłki' WHERE id=(SELECT sb.id FROM shipment_bales sb WHERE sb.shipment_article_id=? AND sb.bale_local_id=? AND sb.removed_at IS NULL)`).run(ctx.now(),req.user.id,specificationId,baleId);
      if(!result.changes) throw Object.assign(new Error('Belka nie jest przypisana do tej wysyłki.'),{status:404});
      return redirect(req,res,`/shipments/${id}?open_specification=${specificationId}#specification-${specificationId}`,'Belkę usunięto z roboczej wysyłki.');
    }
    if(action==='date'&&req.method==='POST'){
      role(req.user,...editableRoles);
      const shipmentDate=String(ctx.form.shipment_date||'');
      if(shipment.status!=='draft'||!/^\d{4}-\d{2}-\d{2}$/.test(shipmentDate)||Number.isNaN(Date.parse(`${shipmentDate}T12:00:00Z`))) throw Object.assign(new Error('Nieprawidłowa data wysyłki.'),{status:400});
      db.prepare('UPDATE shipments SET shipment_date=? WHERE id=?').run(shipmentDate,id);
      if(req.headers['x-requested-with']==='fetch') return send(req,res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');
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
    if(action==='cancel'&&req.method==='GET'){
      role(req.user,...managerRoles);
      if(shipment.status!=='draft') throw Object.assign(new Error('Można anulować tylko roboczą wysyłkę.'),{status:409});
      return send(req,res,200,shipmentConfirmPage(ctx,shipment,'cancel'));
    }
    if(action==='cancel'&&req.method==='POST'){
      role(req.user,...managerRoles);
      if(shipment.status!=='draft'||ctx.form.confirm_cancel!=='1') throw Object.assign(new Error('Potwierdź anulowanie i całkowite usunięcie roboczej wysyłki.'),{status:400});
      transaction(()=>eraseDraftShipment(db,id));
      return redirect(req,res,'/shipments','Wysyłkę usunięto. Belki są ponownie dostępne.');
    }
    if(req.method==='GET'&&!action) return send(req,res,200,shipmentPage(ctx,shipment));
  }
  return false;
}

module.exports = { initialize, handle, articleBalances, activeStockSql };
