'use strict';

const crypto = require('node:crypto');
const V = require('../views');
const Warehouse = require('./warehouse');

const STOCK_STATES = {
  in_production: 'W produkcji',
  standard: 'Standard',
  three_d: '3D',
  aging: 'Zalegające',
  baltex: 'Baltex',
  second_grade: 'II gatunek',
};
const normalizeSymbol = value => String(value || '').toLocaleUpperCase('pl-PL').replace(/\s+/g, '');

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_sync_token (
      id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS production_bales (
      local_id TEXT PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES articles(id),
      article_symbol TEXT NOT NULL,
      machine TEXT NOT NULL,
      bale_number TEXT NOT NULL,
      production_date TEXT NOT NULL,
      weight_kg REAL NOT NULL CHECK(weight_kg>0),
      meters REAL NOT NULL CHECK(meters>0),
      errors INTEGER NOT NULL DEFAULT 0 CHECK(errors>=0),
      stops INTEGER NOT NULL DEFAULT 0 CHECK(stops>=0),
      needs_check INTEGER NOT NULL DEFAULT 0 CHECK(needs_check IN (0,1)),
      lot TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', trial_symbol TEXT NOT NULL DEFAULT '',
      workers_json TEXT NOT NULL DEFAULT '[]',
      local_created_at TEXT NOT NULL, uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS production_bales_article_date ON production_bales(article_id,production_date,uploaded_at);
    CREATE TABLE IF NOT EXISTS production_stock_snapshots (
      snapshot_date TEXT NOT NULL,
      article_id INTEGER NOT NULL REFERENCES articles(id),
      pieces INTEGER NOT NULL CHECK(pieces>=0),
      weight_kg REAL NOT NULL CHECK(weight_kg>=0),
      uploaded_at TEXT NOT NULL,
      PRIMARY KEY(snapshot_date,article_id)
    );
    CREATE INDEX IF NOT EXISTS production_snapshots_recent ON production_stock_snapshots(snapshot_date,article_id);
    CREATE TABLE IF NOT EXISTS production_article_status (
      article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'standard' CHECK(status IN ('in_production','standard','three_d','aging','baltex','second_grade')),
      updated_at TEXT NOT NULL
    );
  `);
  const baleColumns = db.prepare('PRAGMA table_info(production_bales)').all().map(column => column.name);
  if (!baleColumns.includes('trial_symbol')) db.exec("ALTER TABLE production_bales ADD COLUMN trial_symbol TEXT NOT NULL DEFAULT '';");
  // Older versions keyed these rows by upload date. Rebuild them on startup
  // from the per-bale production date so the one-time correction also covers
  // historical pieces that are not part of the next upload batch.
  db.exec(`DELETE FROM production_stock_snapshots;
    INSERT INTO production_stock_snapshots(snapshot_date,article_id,pieces,weight_kg,uploaded_at)
    SELECT production_date,article_id,count(*),round(coalesce(sum(weight_kg),0),2),max(uploaded_at)
    FROM production_bales GROUP BY production_date,article_id;`);
}

function responseError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function tokenMatches(db, authorization) {
  const match = String(authorization || '').match(/^Bearer ([a-f0-9]{64})$/i);
  const saved = db.prepare('SELECT token_hash FROM production_sync_token WHERE id=1').get();
  if (!match || !saved) return false;
  const candidate = crypto.createHash('sha256').update(match[1].toLowerCase()).digest();
  const expected = Buffer.from(saved.token_hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function catalogPayload(db, authorization) {
  if (!tokenMatches(db, authorization)) throw responseError(401, 'Brak uprawnień do pobrania bibliotek produkcji. Sprawdź token w ustawieniach lokalnych.');
  return {
    articles: db.prepare(`SELECT a.id,a.symbol,a.description FROM articles a JOIN records r ON r.id=a.active_spec
      WHERE a.archived_at IS NULL AND a.purged_at IS NULL AND r.kind='spec' AND r.state='approved'
        AND r.archived_at IS NULL ORDER BY a.symbol_key,a.id`).all(),
    workers: db.prepare('SELECT employee_uid,name FROM knitting_workers WHERE active=1 ORDER BY name COLLATE NOCASE').all(),
    syncedAt: new Date().toISOString(),
  };
}

function receiveUpload(db, authorization, payload, helpers) {
  if (!tokenMatches(db, authorization)) throw responseError(401, 'Brak uprawnień do wysłania produkcji. Sprawdź token w ustawieniach lokalnych.');
  if (!payload || !Array.isArray(payload.bales) || payload.bales.length > 5000) throw responseError(400, 'Nieprawidłowa lista belek.');
  const today = helpers.todayWarsaw();
  const uploadedAt = helpers.now();
  const valid = payload.bales.map((row, index) => {
    const localId = String(row.id || '');
    if (!/^[0-9a-f-]{32,36}$/i.test(localId)) throw responseError(400, `Belka ${index + 1}: nieprawidłowy identyfikator.`);
    const symbol = String(row.symbol || '').trim();
    if (!symbol || symbol.length > 150) throw responseError(400, `Belka ${index + 1}: nieprawidłowy symbol artykułu.`);
    const machine = String(row.machine || '').trim();
    const number = String(row.number || '').trim();
    const date = String(row.production_date || '');
    const trialSymbol = String(row.trial_symbol || '').trim();
    if (trialSymbol.length > 150) throw responseError(400, `Belka ${index + 1}: symbol próby może mieć maksymalnie 150 znaków.`);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date && date <= today;
    const weight = Number(row.weight_kg), meters = Number(row.meters), errors = Number(row.errors), stops = Number(row.stops);
    if (!machine || machine.length > 40 || !number || number.length > 80 || !validDate) throw responseError(400, `Belka ${index + 1}: nieprawidłowa maszyna, numer lub data produkcji.`);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000 || !Number.isFinite(meters) || meters <= 0 || meters > 100000) throw responseError(400, `Belka ${index + 1}: nieprawidłowa masa lub długość.`);
    if (!Number.isSafeInteger(errors) || errors < 0 || !Number.isSafeInteger(stops) || stops < 0) throw responseError(400, `Belka ${index + 1}: błędy i stopy muszą być nieujemnymi liczbami całkowitymi.`);
    const workers = Array.isArray(row.workers) ? row.workers.slice(0, 25).map(worker => ({
      employeeUid: String(worker.employeeUid || '').slice(0, 36),
      name: String(worker.name || '').trim().slice(0, 100),
      meters: Number(worker.meters) || 0,
    })) : [];
    if (workers.some(worker => !worker.name || !Number.isFinite(worker.meters) || worker.meters < 0)) throw responseError(400, `Belka ${index + 1}: nieprawidłowe dane dziewiarzy.`);
    return {
      localId, symbol, machine, number, date,
      weight: Math.round(weight * 100) / 100,
      meters: Math.round(meters * 100) / 100,
      errors, stops, lot: String(row.lot || '').trim().slice(0, 120),
      needsCheck: row.needs_check ? 1 : 0,
      notes: String(row.notes || '').trim().slice(0, 1000),
      trialSymbol,
      workers: JSON.stringify(workers),
      localCreatedAt: String(row.created_at || '').slice(0, 30),
    };
  });

  const results = helpers.transaction(() => {
    const articles = new Map();
    for (const symbol of new Set(valid.map(row => row.symbol))) {
      const matches = db.prepare('SELECT * FROM articles WHERE symbol_key=?').all(normalizeSymbol(symbol));
      if (matches.length > 1) throw responseError(409, `Kartoteka zawiera powielony symbol ${symbol}. Administrator musi go uporządkować.`);
      articles.set(symbol, matches[0] || helpers.makeArticle(null, symbol));
    }
    const save = db.prepare(`INSERT INTO production_bales
      (local_id,article_id,article_symbol,machine,bale_number,production_date,weight_kg,meters,errors,stops,needs_check,lot,notes,trial_symbol,workers_json,local_created_at,uploaded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(local_id) DO UPDATE SET article_id=excluded.article_id,article_symbol=excluded.article_symbol,
      machine=excluded.machine,bale_number=excluded.bale_number,production_date=excluded.production_date,
      weight_kg=excluded.weight_kg,meters=excluded.meters,errors=excluded.errors,stops=excluded.stops,
      needs_check=excluded.needs_check,lot=excluded.lot,notes=excluded.notes,trial_symbol=excluded.trial_symbol,workers_json=excluded.workers_json,
      local_created_at=excluded.local_created_at,uploaded_at=excluded.uploaded_at`);
    const accepted = [];
    for (const row of valid) {
      const articleId = articles.get(row.symbol).id;
      save.run(row.localId, articleId, row.symbol, row.machine, row.number, row.date, row.weight, row.meters, row.errors, row.stops, row.needsCheck, row.lot, row.notes, row.trialSymbol, row.workers, row.localCreatedAt || uploadedAt, uploadedAt);
      if (db.prepare('SELECT 1 FROM production_bales WHERE local_id=?').get(row.localId)) accepted.push(row.localId);
    }
    const snapshots = [];
    const snapshotDates = new Set();
    for (const articleId of new Set([...articles.values()].map(article => article.id))) {
      // Rebuild each touched article from the source bales. A resend can correct
      // a bale's production date, so both its old and new day must be reflected.
      db.prepare('DELETE FROM production_stock_snapshots WHERE article_id=?').run(articleId);
      const daily = db.prepare(`SELECT production_date snapshot_date,count(*) pieces,
          round(coalesce(sum(weight_kg),0),2) weight_kg
        FROM production_bales WHERE article_id=? GROUP BY production_date ORDER BY production_date`).all(articleId);
      for (const day of daily) {
        db.prepare(`INSERT INTO production_stock_snapshots(snapshot_date,article_id,pieces,weight_kg,uploaded_at)
          VALUES(?,?,?,?,?)`).run(day.snapshot_date, articleId, day.pieces, day.weight_kg, uploadedAt);
        snapshots.push({ articleId, date: day.snapshot_date, pieces: day.pieces, weightKg: day.weight_kg });
        snapshotDates.add(day.snapshot_date);
      }
    }
    const primaryArticle = [...articles.values()].find(article => normalizeSymbol(article.symbol) === 'WT56-21(5)') || [...articles.values()][0];
    const primarySnapshot = snapshots.filter(snapshot => snapshot.articleId === primaryArticle?.id).sort((a,b) => b.date.localeCompare(a.date))[0] || { date: '', pieces: 0, weightKg: 0 };
    helpers.audit(null, 'Wysłano produkcję z lokalnego panelu dziewiarza', null, JSON.stringify({ dates: [...snapshotDates].sort(), uploaded: valid.length, accepted: accepted.length, snapshots }), primaryArticle?.id);
    return { acceptedIds: accepted, snapshots, snapshot: { date: primarySnapshot.date, pieces: primarySnapshot.pieces, weightKg: primarySnapshot.weightKg, uploadedAt } };
  });
  return results;
}

function productionBusinessDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${fields.year}-${fields.month}-${fields.day}`;
  return Number(fields.hour) < 6 ? addDays(date, -1) : date;
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function lastWorkingDays(today) {
  const dates = [];
  for (let date = today; dates.length < 5; date = addDays(date, -1)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(date);
  }
  return dates.reverse();
}

function overviewPage(ctx) {
  const days = lastWorkingDays(productionBusinessDate(ctx.now()));
  const latestDate = days.at(-1);
  const latest = ctx.db.prepare(`SELECT a.id,a.symbol,coalesce(st.status,'standard') status,
      count(b.local_id) pieces,round(coalesce(sum(b.weight_kg),0),2) weight_kg,max(b.uploaded_at) uploaded_at
    FROM articles a JOIN production_bales b ON b.article_id=a.id
    LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    LEFT JOIN production_article_status st ON st.article_id=a.id
    WHERE a.archived_at IS NULL AND a.purged_at IS NULL AND trim(coalesce(b.trial_symbol,''))='' AND ${Warehouse.activeStockSql()}
    GROUP BY a.id
    ORDER BY CASE coalesce(st.status,'standard') WHEN 'in_production' THEN 0 WHEN 'standard' THEN 1 WHEN 'three_d' THEN 2 WHEN 'aging' THEN 3 WHEN 'baltex' THEN 4 WHEN 'second_grade' THEN 5 ELSE 6 END,
      a.symbol_key,a.id`).all();
  const trialStock=ctx.db.prepare(`SELECT count(b.local_id) pieces,round(coalesce(sum(b.weight_kg),0),2) weight_kg,max(b.uploaded_at) uploaded_at
    FROM production_bales b JOIN articles a ON a.id=b.article_id LEFT JOIN warehouse_bale_flags f ON f.bale_local_id=b.local_id
    WHERE trim(coalesce(b.trial_symbol,''))<>'' AND a.archived_at IS NULL AND a.purged_at IS NULL AND ${Warehouse.activeStockSql()}`).get();
  if(trialStock.pieces) latest.push({id:'trials',symbol:'Próby',status:'standard',pieces:trialStock.pieces,weight_kg:trialStock.weight_kg,uploaded_at:trialStock.uploaded_at,isTrialGroup:true});
  const balances = new Map();
  const shippedDates=new Map();
  const addMovement = (articleId, date, pieces, weight) => {
    if (!date || date > latestDate) return;
    if (!balances.has(articleId)) balances.set(articleId, new Map());
    const movement = balances.get(articleId).get(date) || { pieces: 0, weight: 0 };
    movement.pieces += pieces;
    movement.weight += weight;
    balances.get(articleId).set(date, movement);
  };
  for (const bale of ctx.db.prepare('SELECT article_id,trial_symbol,production_date,weight_kg FROM production_bales WHERE production_date<=?').all(latestDate)) {
    addMovement(bale.trial_symbol?'trials':bale.article_id, bale.production_date, 1, Number(bale.weight_kg) || 0);
  }
  for (const bale of ctx.db.prepare(`SELECT b.article_id,b.trial_symbol,b.weight_kg,sh.shipment_date
      FROM shipment_bales sb JOIN shipment_articles sa ON sa.id=sb.shipment_article_id
      JOIN shipments sh ON sh.id=sa.shipment_id JOIN production_bales b ON b.local_id=sb.bale_local_id
      WHERE sh.status='closed'`).all()) {
    const groupId=bale.trial_symbol?'trials':bale.article_id;
    if(!shippedDates.has(groupId)) shippedDates.set(groupId,new Set());
    shippedDates.get(groupId).add(bale.shipment_date);
    addMovement(groupId, bale.shipment_date, -1, -(Number(bale.weight_kg) || 0));
  }
  for (const correction of ctx.db.prepare(`SELECT b.article_id,b.trial_symbol,b.weight_kg,c.created_at
      FROM shipment_corrections c JOIN production_bales b ON b.local_id=c.removed_bale_local_id
      WHERE c.disposition='returned'`).all()) {
    addMovement(correction.trial_symbol?'trials':correction.article_id, productionBusinessDate(correction.created_at), 1, Number(correction.weight_kg) || 0);
  }
  const statusOptions = Object.entries(STOCK_STATES);
  const formatWeight = value => Number(value).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dayHeaders = days.map(date => {
    const day = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
    return `<th class="stock-day-header" colspan="2" data-stock-date="${date}"><span class="stock-date">${V.esc(day)}</span></th>`;
  }).join('');
  const daySubheaders = days.map(() => '<th class="stock-day-subheader stock-day-start">Szt.</th><th class="stock-day-subheader stock-day-end">Kg</th>').join('');
  const rows = latest.map(article => {
    const state = article.isTrialGroup ? '<span class="badge submitted">Grupa prób</span>' : `<form method="post" action="/production/article-status" class="stock-state-form"><input type="hidden" name="csrf" value="${V.esc(ctx.req.session.csrf)}"><input type="hidden" name="article_id" value="${article.id}"><select name="status" aria-label="Stan artykułu ${V.esc(article.symbol)}" class="stock-state stock-state-${V.esc(article.status)}"${ctx.req.user.role === 'viewer' ? ' disabled' : ' data-auto-submit'}>${statusOptions.map(([key,label]) => `<option value="${key}" ${article.status === key ? 'selected' : ''}>${V.esc(label)}</option>`).join('')}</select></form>`;
    let piecesBalance = 0, weightBalance = 0;
    const events = [...(balances.get(article.id) || new Map())].sort(([a], [b]) => a.localeCompare(b));
    let eventIndex = 0;
    const values = days.map(date => {
      while (eventIndex < events.length && events[eventIndex][0] <= date) {
        piecesBalance += events[eventIndex][1].pieces;
        weightBalance += events[eventIndex][1].weight;
        eventIndex++;
      }
      const shipmentDay=shippedDates.get(article.id)?.has(date);
      return `<td class="stock-day-start${shipmentDay?' stock-shipment-day':''}" data-stock-date="${date}" data-pieces="${piecesBalance}">${piecesBalance}</td><td class="stock-day-end${shipmentDay?' stock-shipment-day':''}" data-stock-date="${date}" data-weight-kg="${weightBalance}">${formatWeight(weightBalance)}</td>`;
    }).join('');
    const stockLink=article.isTrialGroup?'/warehouse?trials=1':`/warehouse?article_id=${article.id}`;
    return `<tr class="stock-row stock-row-${V.esc(article.status)}"><td>${state}</td><td><a class="item-title" href="${stockLink}">${V.esc(article.symbol)}</a></td>${values}</tr>`;
  }).join('');
  const pieces = latest.reduce((sum, row) => sum + row.pieces, 0);
  const weight = latest.reduce((sum, row) => sum + row.weight_kg, 0);
  const updatedAt = latest.map(row => row.uploaded_at).sort().at(-1);
  const summary = `<p class="stock-summary"><strong>Liczba sztuk: ${pieces}</strong><strong>Łączna waga: ${Number(weight).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg</strong></p><p class="muted">Stan zaktualizowano: ${updatedAt ? V.datepl(updatedAt) : 'brak danych'}</p>`;
  const printIcon='<button type="button" class="warehouse-icon-button production-stock-print no-print" data-print-page title="Drukuj stan bieżący" aria-label="Drukuj stan bieżący"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  const body = `<div class="pagehead"><div><span class="eyebrow">PRODUKCJA</span><div class="stock-title-row"><h1>Stan bieżący</h1>${printIcon}</div>${summary}</div></div><div class="panel scroll production-stock"><table class="listing stock-table"><colgroup><col class="stock-state-column"><col class="stock-symbol-column">${days.map(() => '<col class="stock-day-pieces"><col class="stock-day-weight">').join('')}</colgroup><thead><tr><th class="stock-fixed-header" rowspan="2">Stan</th><th class="stock-fixed-header" rowspan="2">Artykuł</th>${dayHeaders}</tr><tr>${daySubheaders}</tr></thead><tbody>${rows || `<tr><td colspan="${2 + days.length * 2}">Brak artykułów z niezerowym stanem.</td></tr>`}</tbody></table></div><p class="muted small">Pokazano zawsze pięć ostatnich dni roboczych. Stan z każdego dnia obejmuje narastająco przyjęcia z programu lokalnego oraz wyjścia z zamkniętych wysyłek.</p>`;
  return V.layout({ user: ctx.req.user, csrf: ctx.req.session.csrf, flashes: ctx.getFlashes(ctx.req), title: 'Stan bieżący · Marand', body });
}

function connectionPage(ctx, oneTimeToken = '') {
  const syncStatus = ctx.db.prepare('SELECT created_at FROM production_sync_token WHERE id=1').get();
  const setup = `<section class="panel padded production-setup"><h2>Połączenie z panelem lokalnym</h2><p class="muted">${syncStatus ? `Token aktywny · utworzony ${V.datepl(syncStatus.created_at)}.` : 'Utwórz token do jednorazowego wpisania w ustawieniach panelu lokalnego.'} Po wygenerowaniu zastąp poprzedni token w panelu dziewiarza.</p><form method="post" action="/production/token"><input type="hidden" name="csrf" value="${V.esc(ctx.req.session.csrf)}"><button class="primary" name="generate" value="1">${syncStatus ? 'Wygeneruj nowy token' : 'Utwórz token'}</button></form></section>`;
  const tokenPanel = oneTimeToken ? `<section class="notice success"><strong>Skopiuj token i wklej go w ustawieniach lokalnego panelu. Później nie będzie wyświetlany.</strong><p><code class="production-token">${V.esc(oneTimeToken)}</code></p></section>` : '';
  const body = `<a class="breadcrumb" href="/production">← Stan bieżący</a><div class="pagehead"><div><span class="eyebrow">INTEGRACJE</span><h1>Połączenie z panelem lokalnym</h1></div></div>${tokenPanel}${setup}`;
  return V.layout({ user: ctx.req.user, csrf: ctx.req.session.csrf, flashes: ctx.getFlashes(ctx.req), title: 'Połączenie z panelem lokalnym · Marand', body });
}

async function handle(ctx) {
  const { req, res, p, send, redirect, role, db } = ctx;
  if ((p === '/production/bales' || p === '/production/bales/export.xlsx') && req.method === 'GET') return redirect(req, res, '/warehouse');
  if (p === '/production/token' && req.method === 'POST') {
    role(req.user, 'admin');
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO production_sync_token(id,token_hash,created_at,created_by) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,created_by=excluded.created_by`)
      .run(crypto.createHash('sha256').update(token).digest('hex'), ctx.now(), req.user.id);
    return send(req, res, 200, connectionPage(ctx, token));
  }
  if (p === '/production/connection' && req.method === 'GET') {
    role(req.user, 'admin');
    return send(req, res, 200, connectionPage(ctx));
  }
  if (p === '/production/article-status' && req.method === 'POST') {
    role(req.user, 'admin', 'approver', 'technologist');
    const articleId = Number(ctx.form.article_id);
    const status = String(ctx.form.status || '');
    if (!Number.isSafeInteger(articleId) || articleId < 1 || !Object.hasOwn(STOCK_STATES, status)) throw responseError(400, 'Nieprawidłowy artykuł lub stan.');
    if (!db.prepare('SELECT id FROM articles WHERE id=?').get(articleId)) throw responseError(404, 'Nie znaleziono artykułu.');
    db.prepare(`INSERT INTO production_article_status(article_id,status,updated_at) VALUES(?,?,?)
      ON CONFLICT(article_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`).run(articleId, status, ctx.now());
    ctx.audit(req.user, 'Zmieniono stan artykułu w produkcji', null, JSON.stringify({ status }), articleId);
    return redirect(req, res, '/production', 'Stan artykułu został zapisany.');
  }
  if (p === '/production' && req.method === 'GET') return send(req, res, 200, overviewPage(ctx));
  return false;
}

module.exports = { initialize, receiveUpload, catalogPayload, handle };
