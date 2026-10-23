'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const ROOT = __dirname;
const STATIC = path.join(ROOT, 'public');
const HOST = process.env.MARAND_KNITTER_HOST || '127.0.0.1';
const PORT = Number(process.env.MARAND_KNITTER_PORT || 8766);
const MAX_BODY = 1024 * 1024;
const DATA_ROOT = process.env.MARAND_KNITTER_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Marand', 'Produkcja');
const DB_PATH = path.join(path.resolve(DATA_ROOT), 'production.sqlite3');
const MACHINES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'B1', 'B2', 'B3'];
const SETTINGS_TOKEN_MS = 8 * 60 * 60 * 1000;
const settingsSessions = new Map();
let unlockFailures = 0;
let unlockBlockedUntil = 0;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH, { timeout: 15000, enableForeignKeyConstraints: true });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
const startingSchemaVersion = db.prepare('PRAGMA user_version').get().user_version;
if (startingSchemaVersion > 2) throw new Error('Lokalna baza pochodzi z nowszej wersji panelu.');
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS article_settings (
    article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    lot TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manager_auth (
    id INTEGER PRIMARY KEY CHECK(id=1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL,
    UNIQUE(code,name)
  );
  CREATE TABLE IF NOT EXISTS bale_sequences (
    machine TEXT NOT NULL,
    production_year INTEGER NOT NULL,
    last_value INTEGER NOT NULL CHECK(last_value >= 0),
    PRIMARY KEY(machine, production_year)
  );
  CREATE TABLE IF NOT EXISTS bales (
    id TEXT PRIMARY KEY,
    machine TEXT NOT NULL,
    production_year INTEGER NOT NULL,
    serial_number INTEGER NOT NULL CHECK(serial_number > 0),
    article_id INTEGER NOT NULL REFERENCES articles(id),
    production_date TEXT NOT NULL,
    weight_kg REAL NOT NULL CHECK(weight_kg > 0),
    meters REAL NOT NULL CHECK(meters > 0),
    errors INTEGER NOT NULL DEFAULT 0 CHECK(errors >= 0),
    stops INTEGER NOT NULL DEFAULT 0 CHECK(stops >= 0),
    lot TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    needs_check INTEGER NOT NULL DEFAULT 0 CHECK(needs_check IN (0,1)),
    sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    synced_at TEXT,
    UNIQUE(machine, production_year, serial_number)
  );
  CREATE TABLE IF NOT EXISTS bale_workers (
    bale_id TEXT NOT NULL REFERENCES bales(id) ON DELETE CASCADE,
    worker_id INTEGER NOT NULL REFERENCES workers(id),
    meters REAL NOT NULL CHECK(meters > 0),
    PRIMARY KEY(bale_id, worker_id)
  );
  CREATE INDEX IF NOT EXISTS bales_production_date ON bales(production_date, created_at);
  CREATE INDEX IF NOT EXISTS bales_sync_status ON bales(sync_status, production_date);
  CREATE INDEX IF NOT EXISTS bale_workers_worker ON bale_workers(worker_id, bale_id);
`);
if (startingSchemaVersion === 0) db.exec('PRAGMA user_version=1;');
if (startingSchemaVersion < 2) {
  const workerColumns = db.prepare('PRAGMA table_info(workers)').all().map(column => column.name);
  if (!workerColumns.includes('employee_uid')) db.exec('ALTER TABLE workers ADD COLUMN employee_uid TEXT;');
  const missingWorkerIds = db.prepare('SELECT id FROM workers WHERE employee_uid IS NULL OR employee_uid = ?').all('');
  const setWorkerId = db.prepare('UPDATE workers SET employee_uid=? WHERE id=?');
  for (const row of missingWorkerIds) setWorkerId.run(crypto.randomUUID(), row.id);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workers_employee_uid ON workers(employee_uid); PRAGMA user_version=2;');
}

function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function todayWarsaw() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function json(res, status, value, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
  res.end(JSON.stringify(value));
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Wysłane dane są za duże.'), { status: 413 })); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Nieprawidłowe dane formularza.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { fail(403, 'Żądanie spoza lokalnego panelu.'); }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || Number(parsed.port || 80) !== PORT) {
    fail(403, 'Żądanie spoza lokalnego panelu.');
  }
}
function cleanText(value, maxLength, label) {
  const result = String(value ?? '').trim();
  if (result.length > maxLength) fail(400, `${label}: maksymalnie ${maxLength} znaków.`);
  return result;
}
function positiveNumber(value, label, maximum) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > maximum) fail(400, `${label}: podaj wartość większą od zera.`);
  return Math.round(result * 100) / 100;
}
function nonnegativeInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 999999) fail(400, `${label}: wpisz nieujemną liczbę całkowitą.`);
  return result;
}
function validateProductionDate(value) {
  const date = String(value || '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T12:00:00Z`) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) fail(400, 'Podaj prawidłową datę produkcji.');
  return date;
}
function validateArticleAndMachine(articleId, machine, allowInactive = false) {
  const id = Number(articleId);
  if (!Number.isSafeInteger(id) || id < 1 || !db.prepare(allowInactive ? 'SELECT id FROM articles WHERE id=?' : 'SELECT id FROM articles WHERE id=? AND active=1').get(id)) fail(400, 'Wybierz aktywny artykuł.');
  if (!MACHINES.includes(machine)) fail(400, 'Wybierz prawidłową maszynę.');
  return id;
}
function normalizeBale(input, articleId, allowInactiveWorkers = false) {
  const meters = positiveNumber(input.meters, 'Metry', 100000);
  const workers = Array.isArray(input.workers) ? input.workers : [];
  if (!workers.length) fail(400, 'Przypisz metry przynajmniej jednemu dziewiarzowi.');
  const normalizedWorkers = [];
  const seen = new Set();
  for (const item of workers) {
    const workerId = Number(item.workerId);
    if (!Number.isSafeInteger(workerId) || workerId < 1 || !db.prepare(allowInactiveWorkers ? 'SELECT id FROM workers WHERE id=?' : 'SELECT id FROM workers WHERE id=? AND active=1').get(workerId)) fail(400, 'Wybierz aktywnego dziewiarza.');
    if (seen.has(workerId)) fail(400, 'Ten sam dziewiarz może być przypisany do belki tylko raz.');
    seen.add(workerId);
    normalizedWorkers.push({ workerId, meters: positiveNumber(item.meters, 'Metry dziewiarza', 100000) });
  }
  const allocated = normalizedWorkers.reduce((sum, row) => sum + row.meters, 0);
  if (Math.abs(allocated - meters) > 0.01) fail(400, `Suma metrów dziewiarzy (${allocated.toFixed(2)}) musi odpowiadać metrom belki (${meters.toFixed(2)}).`);
  return {
    weightKg: positiveNumber(input.weightKg, 'Kilogramy', 1000),
    meters,
    errors: nonnegativeInteger(input.errors ?? 0, 'Błędy'),
    stops: nonnegativeInteger(input.stops ?? 0, 'Stopy'),
    lot: db.prepare('SELECT lot FROM article_settings WHERE article_id=?').get(articleId)?.lot || '',
    notes: cleanText(input.notes, 1000, 'Uwagi'),
    workers: normalizedWorkers,
    articleId,
  };
}
function allocateSerial(machine, year) {
  const current = db.prepare('SELECT last_value FROM bale_sequences WHERE machine=? AND production_year=?').get(machine, year);
  if (!current) fail(409, `Nie ustawiono licznika dla ${machine} na rok ${year}. Otwórz Ustawienia → Numeracja.`);
  db.prepare('UPDATE bale_sequences SET last_value=last_value+1 WHERE machine=? AND production_year=?').run(machine, year);
  return current.last_value + 1;
}
function baleRows(limit = 60, dateFrom = '') {
  const where = dateFrom ? 'WHERE b.production_date>=?' : '';
  const args = dateFrom ? [dateFrom, limit] : [limit];
  return db.prepare(`SELECT b.*,a.symbol
    FROM bales b JOIN articles a ON a.id=b.article_id ${where}
    ORDER BY b.production_date DESC,b.created_at DESC LIMIT ?`).all(...args).map(row => ({
      ...row,
      workers: db.prepare(`SELECT bw.worker_id workerId,w.employee_uid employeeUid,w.code,w.name,bw.meters FROM bale_workers bw
        JOIN workers w ON w.id=bw.worker_id WHERE bw.bale_id=? ORDER BY w.name COLLATE NOCASE`).all(row.id),
    }));
}
function bootstrap() {
  const today = todayWarsaw();
  const start = new Date(`${today}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const from = start.toISOString().slice(0, 10);
  const pending = db.prepare("SELECT count(*) n FROM bales WHERE sync_status='pending'").get().n;
  const sequences = {};
  for (const row of db.prepare('SELECT machine,production_year,last_value FROM bale_sequences ORDER BY production_year,machine').all()) {
    (sequences[row.production_year] ||= {})[row.machine] = row.last_value;
  }
  const rows = baleRows(100, from).map(row => ({
    ...row,
    number: `${row.machine}/${row.serial_number}`,
    needs_check: Boolean(row.needs_check),
  }));
  return {
    today,
    machines: MACHINES,
    articles: db.prepare(`SELECT a.id,a.symbol,COALESCE(s.lot,'') lot FROM articles a
      LEFT JOIN article_settings s ON s.article_id=a.id WHERE a.active=1 ORDER BY a.symbol COLLATE NOCASE`).all(),
    workers: db.prepare('SELECT id,employee_uid,code,name FROM workers WHERE active=1 ORDER BY name COLLATE NOCASE,code COLLATE NOCASE').all(),
    sequences,
    bales: rows,
    pending,
    databasePath: DB_PATH,
  };
}
async function createLocalBackup() {
  const backupDirectory = path.join(path.dirname(DB_PATH), 'kopie');
  await fsp.mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const target = path.join(backupDirectory, `produkcja-${stamp}.sqlite3`);
  const staged = `${target}.partial-${process.pid}`;
  await backup(db, staged);
  const check = new DatabaseSync(staged, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (result !== 'ok') throw new Error('Kopia lokalnej bazy nie przeszła kontroli integralności.');
  } finally { check.close(); }
  await fsp.rename(staged, target);
  const backups = (await fsp.readdir(backupDirectory))
    .filter(name => /^produkcja-\d{14}\.sqlite3$/.test(name))
    .sort().reverse();
  await Promise.all(backups.slice(20).map(name => fsp.rm(path.join(backupDirectory, name), { force: true })));
  console.log(`Utworzono kopię lokalnej bazy: ${target}`);
}
function validateCatalog(body, key) {
  const source = body[key];
  if (!Array.isArray(source) || source.length > 500) fail(400, 'Nieprawidłowa lista.');
  const items = source.map(item => {
    if (key === 'articles') {
      const symbol = cleanText(item.symbol, 150, 'Symbol artykułu');
      if (!symbol) fail(400, 'Symbol artykułu nie może być pusty.');
      return { symbol, lot: cleanText(item.lot, 120, 'LOT') };
    }
    const code = cleanText(item.code, 20, 'Oznaczenie dziewiarza');
    const name = cleanText(item.name, 100, 'Nazwa dziewiarza');
    const employeeUid = cleanText(item.employeeUid, 36, 'Identyfikator pracownika') || crypto.randomUUID();
    if (!name) fail(400, 'Podaj imię i nazwisko pracownika.');
    if (!/^[0-9a-f-]{32,36}$/i.test(employeeUid)) fail(400, 'Nieprawidłowy identyfikator pracownika.');
    return { employeeUid, code, name };
  });
  if (!items.length) fail(400, key === 'articles' ? 'Dodaj przynajmniej jeden aktywny artykuł.' : 'Dodaj przynajmniej jednego aktywnego dziewiarza.');
  const keys = items.map(item => key === 'articles'
    ? item.symbol.toLocaleUpperCase('pl-PL')
    : item.employeeUid.toLocaleLowerCase('en-US'));
  if (new Set(keys).size !== keys.length) fail(400, 'Lista zawiera powtarzający się wpis.');
  return items;
}
function saveCatalogs(body) {
  const articles = validateCatalog(body, 'articles');
  const workers = validateCatalog(body, 'workers');
  const sequenceYear = Number(body.sequenceYear);
  if (!Number.isInteger(sequenceYear) || sequenceYear < 2000 || sequenceYear > new Date().getFullYear() + 1) fail(400, 'Wybierz prawidłowy rok produkcji dla liczników.');
  const sequences = Array.isArray(body.sequences) ? body.sequences : [];
  if (sequences.length > MACHINES.length) fail(400, 'Nieprawidłowa konfiguracja numeracji.');
  const normalizedSequences = [];
  const seenMachines = new Set();
  for (const item of sequences) {
    const machine = String(item.machine || '');
    if (!MACHINES.includes(machine) || seenMachines.has(machine)) fail(400, 'Nieprawidłowa lub powtórzona maszyna w numeracji.');
    seenMachines.add(machine);
    const lastValue = Number(item.lastValue);
    if (!Number.isSafeInteger(lastValue) || lastValue < 0 || lastValue > 99999999) fail(400, `Podaj poprawny ostatni numer dla ${machine}.`);
    normalizedSequences.push({ machine, lastValue });
  }
  const connectionUrl = String(body.productionServerUrl || '').trim();
  const apiToken = String(body.productionApiToken || '').trim();
  if (connectionUrl) {
    let parsed;
    try { parsed = new URL(connectionUrl); } catch { fail(400, 'Wpisz prawidłowy adres programu głównego.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail(400, 'Adres serwera musi zaczynać się od http:// lub https:// i nie może zawierać danych logowania.');
    if (apiToken && !/^[a-f0-9]{64}$/i.test(apiToken)) fail(400, 'Token serwera ma nieprawidłowy format. Wklej token wygenerowany w programie głównym.');
  } else if (apiToken) fail(400, 'Wpisz adres programu głównego przed tokenem.');
  transaction(() => {
    db.exec('UPDATE articles SET active=0; UPDATE workers SET active=0;');
    const addArticle = db.prepare(`INSERT INTO articles(symbol,active,created_at) VALUES(?,1,?)
      ON CONFLICT(symbol) DO UPDATE SET active=1`);
    const findArticle = db.prepare('SELECT id FROM articles WHERE symbol=?');
    const saveArticleSettings = db.prepare(`INSERT INTO article_settings(article_id,lot,updated_at) VALUES(?,?,?)
      ON CONFLICT(article_id) DO UPDATE SET lot=excluded.lot,updated_at=excluded.updated_at`);
    for (const item of articles) {
      addArticle.run(item.symbol, now());
      saveArticleSettings.run(findArticle.get(item.symbol).id, item.lot, now());
    }
    const addWorker = db.prepare(`INSERT INTO workers(employee_uid,code,name,active,created_at) VALUES(?,?,?,1,?)
      ON CONFLICT(employee_uid) DO UPDATE SET code=excluded.code,name=excluded.name,active=1`);
    for (const item of workers) addWorker.run(item.employeeUid, item.code, item.name, now());
    const readSequence = db.prepare('SELECT last_value FROM bale_sequences WHERE machine=? AND production_year=?');
    const writeSequence = db.prepare(`INSERT INTO bale_sequences(machine,production_year,last_value) VALUES(?,?,?)
      ON CONFLICT(machine,production_year) DO UPDATE SET last_value=max(last_value,excluded.last_value)`);
    for (const item of normalizedSequences) {
      const current = readSequence.get(item.machine, sequenceYear);
      if (current && item.lastValue < current.last_value) fail(409, `Licznik ${item.machine}/${sequenceYear} nie może zostać cofnięty z ${current.last_value} do ${item.lastValue}.`);
      writeSequence.run(item.machine, sequenceYear, item.lastValue);
    }
    if (connectionUrl) db.prepare(`INSERT INTO local_settings(key,value) VALUES('production_server_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(connectionUrl.replace(/\/$/, ''));
    if (apiToken) db.prepare(`INSERT INTO local_settings(key,value) VALUES('production_api_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(apiToken);
    if (!connectionUrl && !apiToken && body.clearProductionConnection === true) {
      db.prepare("DELETE FROM local_settings WHERE key IN ('production_server_url','production_api_token')").run();
    }
  });
  return bootstrap();
}
function productionConnection() {
  const get = db.prepare('SELECT value FROM local_settings WHERE key=?');
  const serverUrl = get.get('production_server_url')?.value || '';
  const apiToken = get.get('production_api_token')?.value || '';
  return { serverUrl, configured: Boolean(serverUrl && apiToken) };
}
async function uploadProduction() {
  const config = productionConnection();
  if (!config.configured) fail(409, 'Kierownik musi najpierw skonfigurować adres i token serwera w Ustawieniach.');
  const rows = db.prepare(`SELECT b.*,a.symbol FROM bales b JOIN articles a ON a.id=b.article_id
    WHERE b.sync_status='pending' AND upper(replace(replace(replace(a.symbol,' ',''),char(9),''),char(10),''))='WT56-21(5)'
    ORDER BY b.production_date,b.created_at,b.id`).all();
  const workersForBale = db.prepare(`SELECT w.employee_uid employeeUid,w.code,w.name,bw.meters FROM bale_workers bw
    JOIN workers w ON w.id=bw.worker_id WHERE bw.bale_id=? ORDER BY w.name COLLATE NOCASE`);
  const bales = rows.map(row => ({
    id: row.id, symbol: row.symbol, machine: row.machine, number: `${row.machine}/${row.serial_number}`,
    production_date: row.production_date, weight_kg: row.weight_kg, meters: row.meters,
    errors: row.errors, stops: row.stops, needs_check: row.needs_check, lot: row.lot, notes: row.notes,
    created_at: row.created_at, workers: workersForBale.all(row.id),
  }));
  const target = new URL('/api/production/upload', `${config.serverUrl}/`).toString();
  let response;
  try {
    response = await fetch(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiToken}` },
      body: JSON.stringify({ bales }), signal: AbortSignal.timeout(30000),
    });
  } catch (error) { fail(503, `Nie można połączyć z programem głównym: ${error.message}`); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) fail(response.status, result.error || `Program główny odpowiedział błędem ${response.status}.`);
  const accepted = Array.isArray(result.acceptedIds) ? result.acceptedIds.filter(id => rows.some(row => row.id === id)) : [];
  const stamp = now();
  transaction(() => {
    const mark = db.prepare("UPDATE bales SET sync_status='synced',synced_at=?,updated_at=? WHERE id=? AND sync_status='pending'");
    for (const id of accepted) mark.run(stamp, stamp, id);
  });
  const pendingTest = db.prepare(`SELECT count(*) n FROM bales b JOIN articles a ON a.id=b.article_id
    WHERE b.sync_status='pending' AND upper(replace(replace(replace(a.symbol,' ',''),char(9),''),char(10),''))='WT56-21(5)'`).get().n;
  const otherPending = db.prepare(`SELECT count(*) n FROM bales b JOIN articles a ON a.id=b.article_id
    WHERE b.sync_status='pending' AND upper(replace(replace(replace(a.symbol,' ',''),char(9),''),char(10),''))<>'WT56-21(5)'`).get().n;
  return { uploaded: accepted.length, pending: pendingTest, otherPending, snapshot: result.snapshot, bootstrap: bootstrap() };
}
function passwordConfigured() { return Boolean(db.prepare('SELECT id FROM manager_auth WHERE id=1').get()); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
  return `pbkdf2$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, encoded) {
  const [, saltHex, hashHex] = String(encoded || '').split('$');
  if (!saltHex || !hashHex || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{64}$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), 210000, expected.length, 'sha256');
  return crypto.timingSafeEqual(actual, expected);
}
function issueSettingsToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  settingsSessions.set(token, Date.now() + SETTINGS_TOKEN_MS);
  return token;
}
function requireSettingsAccess(req) {
  const token = String(req.headers['x-settings-token'] || '');
  const expiresAt = settingsSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    settingsSessions.delete(token);
    fail(401, 'Sesja kierownika wygasła. Wpisz ponownie hasło.');
  }
  settingsSessions.set(token, Date.now() + SETTINGS_TOKEN_MS);
}
function createBales(body) {
  const articleId = validateArticleAndMachine(body.articleId, String(body.machine || ''));
  const machine = String(body.machine);
  const productionDate = validateProductionDate(body.productionDate);
  const year = Number(productionDate.slice(0, 4));
  if (!Array.isArray(body.bales) || body.bales.length < 1 || body.bales.length > 6) fail(400, 'Dodaj od jednej do sześciu belek naraz.');
  const entries = body.bales.map(item => normalizeBale(item, articleId));
  return transaction(() => {
    const created = [];
    const insert = db.prepare(`INSERT INTO bales
      (id,machine,production_year,serial_number,article_id,production_date,weight_kg,meters,errors,stops,lot,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const addWorker = db.prepare('INSERT INTO bale_workers(bale_id,worker_id,meters) VALUES(?,?,?)');
    for (const item of entries) {
      const id = crypto.randomUUID();
      const serial = allocateSerial(machine, year);
      const stamp = now();
      insert.run(id,machine,year,serial,articleId,productionDate,item.weightKg,item.meters,item.errors,item.stops,item.lot,item.notes,stamp,stamp);
      for (const worker of item.workers) addWorker.run(id,worker.workerId,worker.meters);
      created.push({ id, number: `${machine}/${serial}` });
    }
    return created;
  });
}
function updateBale(id, body) {
  return transaction(() => {
    const current = db.prepare('SELECT * FROM bales WHERE id=?').get(id);
    if (!current) fail(404, 'Nie znaleziono belki.');
    if (current.sync_status !== 'pending') fail(409, 'Belka została już wysłana. Korektę wykonuje się w systemie głównym.');
    const articleId = validateArticleAndMachine(body.articleId ?? current.article_id, String(body.machine ?? current.machine), true);
    const productionDate = validateProductionDate(body.productionDate ?? current.production_date);
    const machine = String(body.machine ?? current.machine);
    const item = normalizeBale(body, articleId, true);
    const year = Number(productionDate.slice(0,4));
    const serial = machine === current.machine && year === current.production_year ? current.serial_number : allocateSerial(machine, year);
    db.prepare(`UPDATE bales SET machine=?,production_year=?,serial_number=?,article_id=?,production_date=?,weight_kg=?,meters=?,errors=?,stops=?,lot=?,notes=?,updated_at=? WHERE id=?`)
      .run(machine,year,serial,articleId,productionDate,item.weightKg,item.meters,item.errors,item.stops,item.lot,item.notes,now(),id);
    db.prepare('DELETE FROM bale_workers WHERE bale_id=?').run(id);
    const add = db.prepare('INSERT INTO bale_workers(bale_id,worker_id,meters) VALUES(?,?,?)');
    for (const worker of item.workers) add.run(id,worker.workerId,worker.meters);
  });
}
function deleteBale(id) {
  return transaction(() => {
    const current = db.prepare('SELECT sync_status FROM bales WHERE id=?').get(id);
    if (!current) fail(404, 'Nie znaleziono belki.');
    if (current.sync_status !== 'pending') fail(409, 'Wysłanej belki nie można usunąć w panelu lokalnym.');
    db.prepare("DELETE FROM bales WHERE id=? AND sync_status='pending'").run(id);
    return bootstrap();
  });
}
function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/') return sendFile(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/app.js') return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/app.css') return sendFile(res, 'app.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/api/settings-auth/status') return json(res, 200, { configured: passwordConfigured() });
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, bootstrap());
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    try { requireSettingsAccess(req); return json(res, 200, { productionConnection: productionConnection() }); }
    catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
  if (req.method === 'DELETE') {
    checkOrigin(req);
    const remove = url.pathname.match(/^\/api\/bales\/([0-9a-f-]+)$/i);
    if (!remove) return json(res, 404, { error: 'Nie znaleziono adresu API.' });
    return json(res, 200, deleteBale(remove[1]));
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'Nie znaleziono strony.' });
  checkOrigin(req);
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Panel oczekuje danych JSON.' });
  return readBody(req).then(body => {
    try {
      if (url.pathname === '/api/settings-auth/setup') {
        if (passwordConfigured()) fail(409, 'Hasło kierownika jest już ustawione. Wpisz je, aby odblokować ustawienia.');
        const password = String(body.password || '');
        if (password.length < 8 || password.length > 200) fail(400, 'Hasło musi mieć od 8 do 200 znaków.');
        transaction(() => {
          if (passwordConfigured()) fail(409, 'Hasło kierownika zostało już ustawione.');
          db.prepare('INSERT INTO manager_auth(id,password_hash,created_at) VALUES(1,?,?)').run(hashPassword(password), now());
        });
        return json(res, 200, { token: issueSettingsToken() });
      }
      if (url.pathname === '/api/settings-auth/unlock') {
        if (!passwordConfigured()) fail(409, 'Ustaw pierwsze hasło kierownika.');
        if (Date.now() < unlockBlockedUntil) fail(429, 'Za dużo prób. Odczekaj minutę i spróbuj ponownie.');
        const password = String(body.password || '');
        const stored = db.prepare('SELECT password_hash FROM manager_auth WHERE id=1').get().password_hash;
        if (password.length > 200 || !verifyPassword(password, stored)) {
          unlockFailures += 1;
          if (unlockFailures >= 5) { unlockBlockedUntil = Date.now() + 60000; unlockFailures = 0; }
          fail(401, 'Nieprawidłowe hasło.');
        }
        unlockFailures = 0;
        return json(res, 200, { token: issueSettingsToken() });
      }
      if (url.pathname === '/api/settings-auth/change-password') {
        requireSettingsAccess(req);
        const currentPassword = String(body.currentPassword || '');
        const newPassword = String(body.newPassword || '');
        if (newPassword.length < 8 || newPassword.length > 200) fail(400, 'Nowe hasło musi mieć od 8 do 200 znaków.');
        const stored = db.prepare('SELECT password_hash FROM manager_auth WHERE id=1').get()?.password_hash;
        if (!stored || !verifyPassword(currentPassword, stored)) fail(401, 'Obecne hasło jest nieprawidłowe.');
        db.prepare('UPDATE manager_auth SET password_hash=?,created_at=? WHERE id=1').run(hashPassword(newPassword), now());
        settingsSessions.clear();
        return json(res, 200, { token: issueSettingsToken() });
      }
      if (url.pathname === '/api/settings-auth/lock') {
        settingsSessions.delete(String(req.headers['x-settings-token'] || ''));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/settings') { requireSettingsAccess(req); return json(res, 200, saveCatalogs(body)); }
      if (url.pathname === '/api/sync') {
        requireSettingsAccess(req);
        return uploadProduction().then(result => json(res, 200, result));
      }
      if (url.pathname === '/api/bales') {
        const created = createBales(body);
        return json(res, 201, { created, bootstrap: bootstrap() });
      }
      const edit = url.pathname.match(/^\/api\/bales\/([0-9a-f-]+)$/i);
      if (edit) {
        updateBale(edit[1], body);
        return json(res, 200, bootstrap());
      }
      const review = url.pathname.match(/^\/api\/bales\/([0-9a-f-]+)\/review$/i);
      if (review) {
        const result = db.prepare("UPDATE bales SET needs_check=?,updated_at=? WHERE id=? AND sync_status='pending'").run(body.needsCheck ? 1 : 0, now(), review[1]);
        if (!result.changes) fail(409, 'Nie można oznaczyć tej belki; mogła zostać już wysłana.');
        return json(res, 200, bootstrap());
      }
      return json(res, 404, { error: 'Nie znaleziono adresu API.' });
    } catch (error) { return json(res, error.status || 500, { error: error.status ? error.message : 'Nie udało się zapisać danych.' }); }
  }).catch(error => json(res, error.status || 400, { error: error.message || 'Nie udało się odczytać danych.' }));
}
function sendFile(res, name, type) {
  const file = path.join(STATIC, name);
  fs.readFile(file, (error, data) => {
    if (error) return json(res, 404, { error: 'Nie znaleziono pliku panelu.' });
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(data);
  });
}
const server = http.createServer((req, res) => {
  try { Promise.resolve(route(req, res)).catch(error => json(res, error.status || 500, { error: error.message || 'Błąd panelu.' })); }
  catch (error) { json(res, error.status || 500, { error: error.message || 'Błąd panelu.' }); }
});
server.requestTimeout = 15000;
server.headersTimeout = 20000;
let backupRunning = false;
async function safeBackup() {
  if (backupRunning) return;
  backupRunning = true;
  try { await createLocalBackup(); }
  catch (error) { console.error('Nie udało się wykonać kopii lokalnej:', error.message); }
  finally { backupRunning = false; }
}
server.listen(PORT, HOST, () => {
  console.log(`Panel dziewiarza działa lokalnie: http://${HOST}:${PORT} · baza: ${DB_PATH}`);
  if (process.platform === 'win32' && process.env.MARAND_KNITTER_NO_BROWSER !== '1') {
    const browser = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "http://${HOST}:${PORT}"`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    browser.on('error', error => console.error('Nie udało się otworzyć przeglądarki:', error.message));
    browser.unref();
  }
  safeBackup();
});
const backupTimer = setInterval(safeBackup, 6 * 60 * 60 * 1000);
backupTimer.unref();
function shutdown() { clearInterval(backupTimer); server.close(() => { try { db.close(); } finally { process.exit(0); } }); setTimeout(() => process.exit(1), 8000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
