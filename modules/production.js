'use strict';

const crypto = require('node:crypto');
const V = require('../views');

const TEST_ARTICLE_KEY = 'WT56-21(5)';
const STOCK_STATES = {
  in_production: 'W produkcji',
  standard: 'Standard',
  three_d: '3D',
  aging: 'Zalegające',
  baltex: 'Baltex',
  second_grade: 'II gatunek',
};
const normalizeSymbol = value => String(value || '').toLocaleUpperCase('pl-PL').replace(/\s+/g, '');
const escapeLike = value => String(value).replace(/[\\%_]/g, '\\$&');

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
      lot TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
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
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date && date <= today;
    const weight = Number(row.weight_kg), meters = Number(row.meters), errors = Number(row.errors), stops = Number(row.stops);
    if (!machine || machine.length > 40 || !number || number.length > 80 || !validDate) throw responseError(400, `Belka ${index + 1}: nieprawidłowa maszyna, numer lub data produkcji.`);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000 || !Number.isFinite(meters) || meters <= 0 || meters > 100000) throw responseError(400, `Belka ${index + 1}: nieprawidłowa masa lub długość.`);
    if (!Number.isSafeInteger(errors) || errors < 0 || !Number.isSafeInteger(stops) || stops < 0) throw responseError(400, `Belka ${index + 1}: błędy i stopy muszą być nieujemnymi liczbami całkowitymi.`);
    const workers = Array.isArray(row.workers) ? row.workers.slice(0, 25).map(worker => ({
      employeeUid: String(worker.employeeUid || '').slice(0, 36),
      code: String(worker.code || '').slice(0, 20),
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
      (local_id,article_id,article_symbol,machine,bale_number,production_date,weight_kg,meters,errors,stops,needs_check,lot,notes,workers_json,local_created_at,uploaded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(local_id) DO UPDATE SET article_id=excluded.article_id,article_symbol=excluded.article_symbol,
      machine=excluded.machine,bale_number=excluded.bale_number,production_date=excluded.production_date,
      weight_kg=excluded.weight_kg,meters=excluded.meters,errors=excluded.errors,stops=excluded.stops,
      needs_check=excluded.needs_check,lot=excluded.lot,notes=excluded.notes,workers_json=excluded.workers_json,
      local_created_at=excluded.local_created_at,uploaded_at=excluded.uploaded_at`);
    const accepted = [];
    for (const row of valid) {
      const articleId = articles.get(row.symbol).id;
      save.run(row.localId, articleId, row.symbol, row.machine, row.number, row.date, row.weight, row.meters, row.errors, row.stops, row.needsCheck, row.lot, row.notes, row.workers, row.localCreatedAt || uploadedAt, uploadedAt);
      if (db.prepare('SELECT 1 FROM production_bales WHERE local_id=?').get(row.localId)) accepted.push(row.localId);
    }
    const snapshots = [];
    for (const articleId of new Set([...articles.values()].map(article => article.id))) {
      const totals = db.prepare('SELECT count(*) pieces,round(coalesce(sum(weight_kg),0),2) weight_kg FROM production_bales WHERE article_id=?').get(articleId);
      db.prepare(`INSERT INTO production_stock_snapshots(snapshot_date,article_id,pieces,weight_kg,uploaded_at)
        VALUES(?,?,?,?,?) ON CONFLICT(snapshot_date,article_id) DO UPDATE SET pieces=excluded.pieces,weight_kg=excluded.weight_kg,uploaded_at=excluded.uploaded_at`)
        .run(today, articleId, totals.pieces, totals.weight_kg, uploadedAt);
      snapshots.push({ articleId, pieces: totals.pieces, weightKg: totals.weight_kg });
    }
    const primarySnapshot = snapshots.find(snapshot => articles.values().some(article => article.id === snapshot.articleId && normalizeSymbol(article.symbol) === 'WT56-21(5)')) || snapshots[0] || { pieces: 0, weightKg: 0 };
    helpers.audit(null, 'Wysłano produkcję z lokalnego panelu dziewiarza', null, JSON.stringify({ date: today, uploaded: valid.length, accepted: accepted.length, snapshots }), snapshots[0]?.articleId);
    return { acceptedIds: accepted, snapshots, snapshot: { date: today, pieces: primarySnapshot.pieces, weightKg: primarySnapshot.weightKg, uploadedAt } };
  });
  return results;
}

function overviewPage(ctx) {
  const productionDates = ctx.db.prepare(`SELECT snapshot_date,max(uploaded_at) uploaded_at
    FROM production_stock_snapshots GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 5`).all().reverse();
  const dates = [
    ...Array.from({ length: Math.max(0, 5 - productionDates.length) }, () => null),
    ...productionDates,
  ];
  const dateHeaders = dates.map(day => day
    ? `<th colspan="2"><span class="stock-date">${V.esc(new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', weekday: 'long' }).format(new Date(`${day.snapshot_date}T12:00:00Z`)))}</span><small>${V.esc(day.snapshot_date.split('-').reverse().join('.'))}</small></th>`
    : '<th colspan="2"><span class="stock-date">—</span><small>&nbsp;</small></th>'
  ).join('');
  const latest = ctx.db.prepare(`SELECT a.id,a.symbol,coalesce(st.status,'standard') status,
      s.snapshot_date,s.pieces,s.weight_kg,s.uploaded_at
    FROM articles a
    JOIN production_stock_snapshots s ON s.article_id=a.id
      AND s.snapshot_date=(SELECT max(s2.snapshot_date) FROM production_stock_snapshots s2 WHERE s2.article_id=a.id)
    LEFT JOIN production_article_status st ON st.article_id=a.id
    ORDER BY CASE coalesce(st.status,'standard') WHEN 'in_production' THEN 0 WHEN 'standard' THEN 1 WHEN 'three_d' THEN 2 WHEN 'aging' THEN 3 WHEN 'baltex' THEN 4 WHEN 'second_grade' THEN 5 ELSE 6 END,
      a.symbol_key,a.id`).all();
  const snapshotDates = dates.filter(Boolean).map(day => day.snapshot_date);
  const snapshots = snapshotDates.length
    ? ctx.db.prepare(`SELECT article_id,snapshot_date,pieces,weight_kg
      FROM production_stock_snapshots WHERE snapshot_date IN (${snapshotDates.map(() => '?').join(',')})`).all(...snapshotDates)
    : [];
  const byArticleDay = new Map(snapshots.map(row => [`${row.article_id}:${row.snapshot_date}`, row]));
  const pieces = latest.reduce((sum, row) => sum + row.pieces, 0);
  const weight = latest.reduce((sum, row) => sum + row.weight_kg, 0);
  const updatedAt = latest.map(row => row.uploaded_at).sort().at(-1);
  const statusOptions = Object.entries(STOCK_STATES);
  const rows = latest.map(article => {
    const state = `<form method="post" action="/production/article-status" class="stock-state-form"><input type="hidden" name="csrf" value="${V.esc(ctx.req.session.csrf)}"><input type="hidden" name="article_id" value="${article.id}"><select name="status" aria-label="Stan artykułu ${V.esc(article.symbol)}" class="stock-state stock-state-${V.esc(article.status)}"${ctx.req.user.role === 'viewer' ? ' disabled' : ' data-auto-submit'}>${statusOptions.map(([key,label]) => `<option value="${key}" ${article.status === key ? 'selected' : ''}>${V.esc(label)}</option>`).join('')}</select></form>`;
    const values = dates.map(day => {
      if (!day) return '<td>—</td><td>—</td>';
      const value = byArticleDay.get(`${article.id}:${day.snapshot_date}`);
      return value ? `<td>${value.pieces}</td><td>${Number(value.weight_kg).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>` : '<td>—</td><td>—</td>';
    }).join('');
    return `<tr class="stock-row stock-row-${V.esc(article.status)}"><td>${state}</td><td><a class="item-title" href="/production/bales">${V.esc(article.symbol)}</a></td>${values}</tr>`;
  }).join('');
  const summary = `<p class="stock-summary"><strong>Liczba sztuk: ${pieces}</strong><strong>Łączna waga: ${Number(weight).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg</strong></p><p class="muted">Stan zaktualizowano: ${updatedAt ? V.datepl(updatedAt) : 'brak danych'}</p>`;
  const body = `<div class="pagehead"><div><span class="eyebrow">PRODUKCJA</span><h1>Stan bieżący</h1>${summary}</div><a class="button" href="/production/bales" target="_blank" rel="noopener">Kartoteka sztuk ↗</a></div><div class="panel scroll production-stock"><table class="listing stock-table"><thead><tr><th rowspan="2">Stan</th><th rowspan="2">Symbol</th>${dateHeaders}</tr><tr>${dates.map(() => '<th>Szt</th><th>Kg</th>').join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${2 + dates.length * 2}">Brak wysłanej produkcji.</td></tr>`}</tbody></table></div><p class="muted small">Tabela pokazuje pięć ostatnich dni z wysłaną produkcją. Szt/Kg to stan zapisany w kartotece w dniu wysyłki.</p>`;
  return V.layout({ user: ctx.req.user, csrf: ctx.req.session.csrf, flashes: ctx.getFlashes(ctx.req), title: 'Stan bieżący · Marand', body });
}

function connectionPage(ctx, oneTimeToken = '') {
  const syncStatus = ctx.db.prepare('SELECT created_at FROM production_sync_token WHERE id=1').get();
  const setup = `<section class="panel padded production-setup"><h2>Połączenie z panelem lokalnym</h2><p class="muted">${syncStatus ? `Token aktywny · utworzony ${V.datepl(syncStatus.created_at)}.` : 'Utwórz token do jednorazowego wpisania w ustawieniach panelu lokalnego.'} Po wygenerowaniu zastąp poprzedni token w panelu dziewiarza.</p><form method="post" action="/production/token"><input type="hidden" name="csrf" value="${V.esc(ctx.req.session.csrf)}"><button class="primary" name="generate" value="1">${syncStatus ? 'Wygeneruj nowy token' : 'Utwórz token'}</button></form></section>`;
  const tokenPanel = oneTimeToken ? `<section class="notice success"><strong>Skopiuj token i wklej go w ustawieniach lokalnego panelu. Później nie będzie wyświetlany.</strong><p><code class="production-token">${V.esc(oneTimeToken)}</code></p></section>` : '';
  const body = `<a class="breadcrumb" href="/production">← Stan bieżący</a><div class="pagehead"><div><span class="eyebrow">INTEGRACJE</span><h1>Połączenie z panelem lokalnym</h1></div></div>${tokenPanel}${setup}`;
  return V.layout({ user: ctx.req.user, csrf: ctx.req.session.csrf, flashes: ctx.getFlashes(ctx.req), title: 'Połączenie z panelem lokalnym · Marand', body });
}

function balesPage(ctx) {
  const query = String(ctx.url.searchParams.get('q') || '').trim();
  const terms = query.split(/\s+/).map(ctx.normalize).filter(Boolean);
  const where = ['a.symbol_key=?'];
  const params = [TEST_ARTICLE_KEY];
  for (const term of terms) {
    where.push("search_text(a.symbol || ' ' || b.bale_number || ' ' || b.machine || ' ' || b.lot || ' ' || b.notes || ' ' || b.workers_json) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(term)}%`);
  }
  const from = String(ctx.url.searchParams.get('date_from') || '');
  const to = String(ctx.url.searchParams.get('date_to') || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('b.production_date>=?'); params.push(from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('b.production_date<=?'); params.push(to); }
  const items = ctx.db.prepare(`SELECT b.*,a.symbol FROM production_bales b JOIN articles a ON a.id=b.article_id
    WHERE ${where.join(' AND ')} ORDER BY b.production_date DESC,b.uploaded_at DESC,b.bale_number LIMIT 1000`).all(...params);
  const rows = items.map(row => {
    let workers = [];
    try { workers = JSON.parse(row.workers_json || '[]'); } catch {}
    const workerText = workers.map(worker => `${worker.code ? `${V.esc(worker.code)} · ` : ''}${V.esc(worker.name)} · ${Number(worker.meters).toLocaleString('pl-PL')} m`).join('<br>') || '—';
    return `<tr><td>${V.esc(row.bale_number)}</td><td>${V.esc(row.symbol)}</td><td>${V.esc(row.machine)}</td><td>${V.esc(row.production_date.split('-').reverse().join('.'))}</td><td>${Number(row.weight_kg).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${Number(row.meters).toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${row.errors}</td><td>${row.stops}</td><td>${workerText}</td><td>${V.esc(row.lot)}</td><td>${V.esc(row.notes)}</td><td>${row.needs_check ? 'Do sprawdzenia' : '—'}</td><td>${V.datepl(row.uploaded_at)}</td></tr>`;
  }).join('');
  const form = `<form class="searchbar production-bale-filters"><input name="q" value="${V.esc(query)}" placeholder="Szukaj belki, dziewiarza lub LOT"><label class="date-filter">Od<input type="date" name="date_from" value="${V.esc(from)}"></label><label class="date-filter">Do<input type="date" name="date_to" value="${V.esc(to)}"></label><button class="primary">Szukaj</button></form>`;
  const body = `<a class="breadcrumb" href="/production">← Stan bieżący</a><div class="pagehead"><div><span class="eyebrow">KARTOTEKA PRODUKCJI</span><h1>Belki · WT 56-21 (5)</h1><p class="muted">${items.length} wpisów${items.length === 1000 ? ' · pokazano maksymalnie 1000 najnowszych' : ''}</p></div></div>${form}<div class="panel scroll"><table class="listing"><thead><tr><th>Belka</th><th>Artykuł</th><th>Maszyna</th><th>Data</th><th>kg</th><th>Metry</th><th>Błędy</th><th>Stopy</th><th>Dziewiarze / udział</th><th>LOT</th><th>Uwagi</th><th>Do sprawdzenia</th><th>Wysłano</th></tr></thead><tbody>${rows || '<tr><td colspan="13">Nie wysłano jeszcze belek dla tego artykułu.</td></tr>'}</tbody></table></div>`;
  return V.layout({ user: ctx.req.user, csrf: ctx.req.session.csrf, flashes: ctx.getFlashes(ctx.req), title: 'Kartoteka sztuk · Marand', body });
}

async function handle(ctx) {
  const { req, res, p, send, redirect, role, db } = ctx;
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
  if (p === '/production/bales' && req.method === 'GET') return send(req, res, 200, balesPage(ctx));
  return false;
}

module.exports = { initialize, receiveUpload, handle };
