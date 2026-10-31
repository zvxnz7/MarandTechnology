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
const DEFAULT_PRODUCTION_SERVER_URL = 'http://192.168.1.14:8765';
const MAX_BODY = 1024 * 1024;
const DATA_ROOT = process.env.MARAND_KNITTER_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Marand', 'Produkcja');
const DB_PATH = path.join(path.resolve(DATA_ROOT), 'production.sqlite3');
const DEFAULT_MACHINES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'B1', 'B2', 'B3'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH, { timeout: 15000, enableForeignKeyConstraints: true });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
const startingSchemaVersion = db.prepare('PRAGMA user_version').get().user_version;
if (startingSchemaVersion > 14) throw new Error('Lokalna baza pochodzi z nowszej wersji panelu.');
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    central_id INTEGER UNIQUE,
    central_managed INTEGER NOT NULL DEFAULT 0 CHECK(central_managed IN (0,1)),
    central_active INTEGER NOT NULL DEFAULT 1 CHECK(central_active IN (0,1)),
    central_description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS article_settings (
    article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    lot TEXT NOT NULL DEFAULT '',
    trial_symbol TEXT NOT NULL DEFAULT '',
    is_trial INTEGER NOT NULL DEFAULT 0 CHECK(is_trial IN (0,1)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS article_machine_choices (
    id INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    machine TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(article_id,machine)
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
  CREATE TABLE IF NOT EXISTS machine_catalog (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    central_managed INTEGER NOT NULL DEFAULT 0 CHECK(central_managed IN (0,1)),
    central_active INTEGER NOT NULL DEFAULT 1 CHECK(central_active IN (0,1)),
    work_status TEXT NOT NULL DEFAULT 'active' CHECK(work_status IN ('active','vacation','sick')),
    created_at TEXT NOT NULL,
    name_key TEXT NOT NULL DEFAULT '',
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
    weight_weighed INTEGER NOT NULL DEFAULT 1 CHECK(weight_weighed IN (0,1)),
    meters REAL NOT NULL CHECK(meters > 0),
    errors INTEGER NOT NULL DEFAULT 0 CHECK(errors >= 0),
    stops INTEGER NOT NULL DEFAULT 0 CHECK(stops >= 0),
    lot TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    trial_symbol TEXT NOT NULL DEFAULT '',
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
  CREATE INDEX IF NOT EXISTS bales_article_date_meters ON bales(article_id,production_date,meters,created_at);
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
if(startingSchemaVersion<6){
  const workerColumns=db.prepare('PRAGMA table_info(workers)').all().map(column=>column.name);
  if(!workerColumns.includes('name_key')) db.exec("ALTER TABLE workers ADD COLUMN name_key TEXT NOT NULL DEFAULT '';");
  const normalizeName=value=>String(value||'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'').trim();
  const rows=db.prepare('SELECT id,name,active,central_managed,central_active FROM workers ORDER BY central_managed DESC,active DESC,id').all();
  const groups=new Map();
  for(const row of rows){const key=normalizeName(row.name);if(!key){db.prepare('UPDATE workers SET name_key=? WHERE id=?').run(`legacy-empty:${row.id}`,row.id);continue;}const group=groups.get(key)||[];group.push(row);groups.set(key,group);}
  db.exec('BEGIN IMMEDIATE;');
  try{
    const add=db.prepare(`INSERT INTO bale_workers(bale_id,worker_id,meters) VALUES(?,?,?) ON CONFLICT(bale_id,worker_id) DO UPDATE SET meters=bale_workers.meters+excluded.meters`);
    const assignments=db.prepare('SELECT bale_id,meters FROM bale_workers WHERE worker_id=?');
    const archive=db.prepare("UPDATE workers SET active=0,central_active=0,name_key=? WHERE id=?");
    for(const [key,group] of groups){const canonical=group[0];db.prepare('UPDATE workers SET name_key=?,active=?,central_managed=?,central_active=max(central_active,?) WHERE id=?').run(key,group.some(w=>w.active)?1:0,group.some(w=>w.central_managed)?1:0,group.some(w=>w.central_managed&&w.active)?1:0,canonical.id);
      for(const duplicate of group.slice(1)){for(const a of assignments.all(duplicate.id))add.run(a.bale_id,canonical.id,a.meters);db.prepare('DELETE FROM bale_workers WHERE worker_id=?').run(duplicate.id);archive.run(`archived:${duplicate.id}`,duplicate.id);}}
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workers_name_key ON workers(name_key); PRAGMA user_version=6; COMMIT;');
  }catch(error){try{db.exec('ROLLBACK;')}catch{}throw error;}
}
if (startingSchemaVersion < 3) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_production_reports (
      report_date TEXT PRIMARY KEY,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','approved_pending','sent','send_error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      approved_payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS daily_production_report_bales (
      report_date TEXT NOT NULL REFERENCES daily_production_reports(report_date) ON DELETE CASCADE,
      bale_id TEXT NOT NULL REFERENCES bales(id) ON DELETE CASCADE,
      PRIMARY KEY(report_date,bale_id)
    );
    CREATE INDEX IF NOT EXISTS daily_reports_status ON daily_production_reports(status,report_date);
    PRAGMA user_version=3;
  `);
}
if (startingSchemaVersion < 4) {
  const reportBaleColumns = db.prepare('PRAGMA table_info(daily_production_report_bales)').all().map(column => column.name);
  if (!reportBaleColumns.includes('state')) db.exec("ALTER TABLE daily_production_report_bales ADD COLUMN state TEXT NOT NULL DEFAULT 'included' CHECK(state IN ('included','removed'));");
  db.exec(`CREATE INDEX IF NOT EXISTS daily_report_bales_state ON daily_production_report_bales(report_date,state);
    CREATE UNIQUE INDEX IF NOT EXISTS daily_bale_single_report ON daily_production_report_bales(bale_id) WHERE state='included';
    CREATE INDEX IF NOT EXISTS bales_created_at ON bales(created_at);
    PRAGMA user_version=4;`);
}
if (startingSchemaVersion < 5) {
  const articleColumns=db.prepare('PRAGMA table_info(articles)').all().map(column=>column.name);
  for(const [name,definition] of [['central_id','INTEGER'],['central_managed','INTEGER NOT NULL DEFAULT 0 CHECK(central_managed IN (0,1))'],['central_active','INTEGER NOT NULL DEFAULT 1 CHECK(central_active IN (0,1))'],['central_description',"TEXT NOT NULL DEFAULT ''"]]) if(!articleColumns.includes(name)) db.exec(`ALTER TABLE articles ADD COLUMN ${name} ${definition};`);
  const workerColumns=db.prepare('PRAGMA table_info(workers)').all().map(column=>column.name);
  for(const [name,definition] of [['central_managed','INTEGER NOT NULL DEFAULT 0 CHECK(central_managed IN (0,1))'],['central_active','INTEGER NOT NULL DEFAULT 1 CHECK(central_active IN (0,1))']]) if(!workerColumns.includes(name)) db.exec(`ALTER TABLE workers ADD COLUMN ${name} ${definition};`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS articles_central_id ON articles(central_id) WHERE central_id IS NOT NULL; PRAGMA user_version=5;');
}
if (startingSchemaVersion < 7) {
  const workerColumns = db.prepare('PRAGMA table_info(workers)').all().map(column => column.name);
  if (!workerColumns.includes('work_status')) db.exec("ALTER TABLE workers ADD COLUMN work_status TEXT NOT NULL DEFAULT 'active' CHECK(work_status IN ('active','vacation','sick'));");
  db.exec('PRAGMA user_version=7;');
}
if (startingSchemaVersion < 8) {
  const baleColumns = db.prepare('PRAGMA table_info(bales)').all().map(column => column.name);
  if (!baleColumns.includes('trial_symbol')) db.exec("ALTER TABLE bales ADD COLUMN trial_symbol TEXT NOT NULL DEFAULT '';");
  db.exec('PRAGMA user_version=8;');
}
if (startingSchemaVersion < 9) {
  const settingColumns = db.prepare('PRAGMA table_info(article_settings)').all().map(column => column.name);
  if (!settingColumns.includes('trial_symbol')) db.exec("ALTER TABLE article_settings ADD COLUMN trial_symbol TEXT NOT NULL DEFAULT '';");
  db.exec('PRAGMA user_version=9;');
}
if (startingSchemaVersion < 10) {
  const settingColumns = db.prepare('PRAGMA table_info(article_settings)').all().map(column => column.name);
  if (!settingColumns.includes('is_trial')) {
    db.exec("ALTER TABLE article_settings ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK(is_trial IN (0,1));");
    db.exec("UPDATE article_settings SET is_trial=1 WHERE trim(trial_symbol)<>'';");
  }
  db.exec('PRAGMA user_version=10;');
}
if (startingSchemaVersion < 11) {
  const baleColumns = db.prepare('PRAGMA table_info(bales)').all().map(column => column.name);
  if (!baleColumns.includes('weight_weighed')) db.exec('ALTER TABLE bales ADD COLUMN weight_weighed INTEGER NOT NULL DEFAULT 1 CHECK(weight_weighed IN (0,1));');
  db.exec('PRAGMA user_version=11;');
}
if (startingSchemaVersion < 12) {
  const settingColumns = db.prepare('PRAGMA table_info(article_settings)').all().map(column => column.name);
  if (!settingColumns.includes('weight_weigh_interval')) db.exec('ALTER TABLE article_settings ADD COLUMN weight_weigh_interval INTEGER NOT NULL DEFAULT 20;');
  const baleColumns = db.prepare('PRAGMA table_info(bales)').all().map(column => column.name);
  if (!baleColumns.includes('weight_source')) db.exec("ALTER TABLE bales ADD COLUMN weight_source TEXT NOT NULL DEFAULT 'weighed';");
  if (!baleColumns.includes('weight_gross_kg')) db.exec('ALTER TABLE bales ADD COLUMN weight_gross_kg REAL;');
  if (!baleColumns.includes('tube_weight_kg')) db.exec('ALTER TABLE bales ADD COLUMN tube_weight_kg REAL;');
  db.exec("UPDATE bales SET weight_source=CASE WHEN weight_weighed=1 THEN 'weighed' ELSE 'suggested' END;");
  db.exec('PRAGMA user_version=12;');
}
if (startingSchemaVersion < 13) {
  db.prepare(`INSERT OR IGNORE INTO article_machine_choices(article_id,machine,active,created_at,updated_at)
    SELECT a.id,'',1,?,? FROM articles a WHERE a.active=1`).run(now(), now());
  db.exec('PRAGMA user_version=13;');
}
db.prepare(`INSERT INTO local_settings(key,value) VALUES('production_server_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
  .run(DEFAULT_PRODUCTION_SERVER_URL);
db.prepare("INSERT INTO local_settings(key,value) VALUES('weight_weigh_interval','20') ON CONFLICT(key) DO NOTHING").run();
if(!db.prepare("SELECT 1 FROM local_settings WHERE key='machine_catalog_seeded'").get()){
  if(!db.prepare('SELECT 1 FROM machine_catalog LIMIT 1').get()){
    const stamp=now(),insert=db.prepare('INSERT OR IGNORE INTO machine_catalog(code,name,active,created_at,updated_at) VALUES(?,?,1,?,?)');
    for(const code of DEFAULT_MACHINES)insert.run(code,code,stamp,stamp);
  }
  db.prepare("INSERT INTO local_settings(key,value) VALUES('machine_catalog_seeded','1')").run();
}
if(startingSchemaVersion<14)db.exec('PRAGMA user_version=14;');

function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function todayWarsaw() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function warsawParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
}
function addCalendarDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function warsawSixUtc(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const wallClock = Date.UTC(year, month - 1, day, 6, 0, 0);
  let candidate = wallClock;
  for (let pass = 0; pass < 3; pass += 1) {
    const local = warsawParts(new Date(candidate));
    const represented = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
    candidate = wallClock - (represented - candidate);
  }
  return new Date(candidate).toISOString().replace('.000Z', 'Z');
}
function lastCompletedProductionPeriod() {
  const local = warsawParts(new Date());
  const localDate = `${local.year}-${local.month}-${local.day}`;
  const daysBack = Number(local.hour) >= 6 ? 1 : 2;
  const reportDate = addCalendarDays(localDate, -daysBack);
  const nextDate = addCalendarDays(reportDate, 1);
  return { reportDate, startsAt: warsawSixUtc(reportDate), endsAt: warsawSixUtc(nextDate) };
}
function currentProductionDate() {
  const local = warsawParts(new Date());
  const localDate = `${local.year}-${local.month}-${local.day}`;
  return Number(local.hour) >= 6 ? localDate : addCalendarDays(localDate, -1);
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
function normalizeWorkerName(value){return String(value||'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'').trim();}
function positiveNumber(value, label, maximum) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > maximum) fail(400, `${label}: podaj wartość większą od zera.`);
  return Math.round(result * 100) / 100;
}
function nonnegativeInteger(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') fail(400, `${label}: wpisz wartość (0, jeśli brak).`);
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
function machineCatalog(activeOnly = true) {
  return db.prepare(`SELECT code,name,active FROM machine_catalog ${activeOnly ? 'WHERE active=1' : ''} ORDER BY code COLLATE NOCASE`).all();
}
function activeMachineCodes() { return machineCatalog().map(machine => machine.code); }
function validateArticleAndMachine(articleId, machine, allowInactive = false) {
  const id = Number(articleId);
  if (!Number.isSafeInteger(id) || id < 1 || !db.prepare(allowInactive ? 'SELECT id FROM articles WHERE id=?' : 'SELECT id FROM articles WHERE id=? AND active=1').get(id)) fail(400, 'Wybierz aktywny artykuł.');
  const machineExists=db.prepare(allowInactive?'SELECT code FROM machine_catalog WHERE code=?':'SELECT code FROM machine_catalog WHERE code=? AND active=1').get(machine);
  if (!machineExists) fail(400, 'Wybierz aktywną maszynę z ustawień kierownika.');
  return id;
}
function normalizeBale(input, articleId, allowInactiveWorkers = false, existingTrialSymbol, existingWeightWeighed) {
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
  const configuredTrialSymbol = existingTrialSymbol === undefined
    ? db.prepare(`SELECT CASE WHEN s.is_trial=1 THEN a.symbol ELSE '' END trial_symbol
      FROM articles a LEFT JOIN article_settings s ON s.article_id=a.id WHERE a.id=?`).get(articleId)?.trial_symbol || ''
    : existingTrialSymbol;
  if (input.weightWeighed !== undefined && typeof input.weightWeighed !== 'boolean') fail(400, 'Nieprawidłowa informacja o zważeniu belki.');
  const weightSource = String(input.weightSource || (input.weightWeighed === false ? 'suggested' : existingWeightWeighed === false ? 'calculated' : 'weighed'));
  if (!['weighed', 'suggested', 'calculated'].includes(weightSource)) fail(400, 'Nieprawidłowy sposób ustalenia wagi.');
  const weightGrossKg = input.weightGrossKg === undefined || input.weightGrossKg === null || input.weightGrossKg === '' ? null : positiveNumber(input.weightGrossKg, 'Waga z tuleją', 1000);
  const tubeWeightKg = input.tubeWeightKg === undefined || input.tubeWeightKg === null || input.tubeWeightKg === '' ? null : positiveNumber(input.tubeWeightKg, 'Waga tulei', 1000);
  if ((weightGrossKg === null) !== (tubeWeightKg === null)) fail(400, 'Podaj wagę z tuleją i wagę samej tulei.');
  if (weightGrossKg !== null && weightGrossKg <= tubeWeightKg) fail(400, 'Waga z tuleją musi być większa od wagi tulei.');
  const weightKg = weightGrossKg === null ? positiveNumber(input.weightKg, 'Kilogramy', 1000) : Math.round((weightGrossKg - tubeWeightKg) * 10) / 10;
  return {
    weightKg,
    weightWeighed: weightSource === 'weighed' && (input.weightWeighed === undefined ? (existingWeightWeighed ?? true) : input.weightWeighed),
    weightSource,
    weightGrossKg,
    tubeWeightKg,
    meters,
    errors: nonnegativeInteger(input.errors, 'Błędy'),
    stops: nonnegativeInteger(input.stops, 'Stopy'),
    lot: db.prepare('SELECT lot FROM article_settings WHERE article_id=?').get(articleId)?.lot || '',
    notes: cleanText(input.notes, 1000, 'Uwagi'),
    trialSymbol: configuredTrialSymbol,
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
function baleRows(includeReported = false) {
  const visibilityFilter = includeReported ? '1=1' : `NOT EXISTS (SELECT 1 FROM daily_production_report_bales rb WHERE rb.bale_id=b.id AND rb.state='included')`;
  const limit = includeReported ? 'LIMIT 80' : '';
  return db.prepare(`SELECT b.*,CASE WHEN trim(b.trial_symbol)<>'' THEN b.trial_symbol ELSE a.symbol END symbol,a.symbol article_symbol
    FROM bales b JOIN articles a ON a.id=b.article_id
    WHERE ${visibilityFilter}
    ORDER BY b.created_at DESC,b.id DESC ${limit}`).all().map(row => ({
      ...row,
      workers: db.prepare(`SELECT bw.worker_id workerId,w.employee_uid employeeUid,w.name,bw.meters FROM bale_workers bw
        JOIN workers w ON w.id=bw.worker_id WHERE bw.bale_id=? ORDER BY w.name COLLATE NOCASE`).all(row.id),
    }));
}
function lastBaleRow() {
  const row = db.prepare(`SELECT b.*,CASE WHEN trim(b.trial_symbol)<>'' THEN b.trial_symbol ELSE a.symbol END symbol,a.symbol article_symbol FROM bales b
    JOIN articles a ON a.id=b.article_id ORDER BY b.created_at DESC,b.id DESC LIMIT 1`).get();
  if (!row) return null;
  return {
    ...row,
    number: `${row.machine}/${row.serial_number}`,
    needs_check: Boolean(row.needs_check),
    workers: db.prepare(`SELECT bw.worker_id workerId,w.employee_uid employeeUid,w.name,bw.meters FROM bale_workers bw
      JOIN workers w ON w.id=bw.worker_id WHERE bw.bale_id=? ORDER BY w.name COLLATE NOCASE`).all(row.id),
  };
}
function touchWeightInfo(articleId, productionDate, meters) {
  const [year, month] = productionDate.slice(0, 7).split('-').map(Number);
  const startDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const monthWhere = 'article_id=? AND production_date>=? AND production_date<?';
  const weighedRows = db.prepare(`SELECT id,machine,serial_number,article_id,production_date,weight_kg,meters,created_at
    FROM bales WHERE ${monthWhere} AND weight_weighed=1 ORDER BY created_at DESC,id DESC LIMIT 3`).all(articleId, startDate, endDate);
  const lastWeighed = weighedRows[0] || null;
  const monthCount = db.prepare(`SELECT count(*) n FROM bales WHERE ${monthWhere}`).get(articleId, startDate, endDate).n;
  const articleCount = db.prepare('SELECT count(*) n FROM bales WHERE article_id=?').get(articleId).n;
  const balesSinceLastWeigh = lastWeighed
    ? db.prepare(`SELECT count(*) n FROM bales WHERE ${monthWhere} AND (created_at>? OR (created_at=? AND id>?))`)
      .get(articleId, startDate, endDate, lastWeighed.created_at, lastWeighed.created_at, lastWeighed.id).n
    : monthCount;
  const weightRate = weighedRows.length
    ? weighedRows.reduce((sum, item) => sum + item.weight_kg / item.meters, 0) / weighedRows.length
    : 0;
  const matching = weighedRows.find(item => Math.abs(item.meters - meters) < 0.005);
  const interval = Number(db.prepare('SELECT weight_weigh_interval FROM article_settings WHERE article_id=?').get(articleId)?.weight_weigh_interval) || 20;
  const reminderIn = Math.max(0, interval - balesSinceLastWeigh);
  const firstBalesRemaining = Math.max(0, 2 - articleCount);
  const dueByInterval = interval > 0 && balesSinceLastWeigh >= interval;
  return {
    suggestion: weightRate ? { ...(matching || weighedRows[0]), weight_kg: Math.round(weightRate * meters * 10) / 10, weightRate, referenceCount: weighedRows.length, number: `${(matching || weighedRows[0]).machine}/${(matching || weighedRows[0]).serial_number}` } : null,
    lastWeighed: lastWeighed ? { ...lastWeighed, symbol: db.prepare('SELECT CASE WHEN trim(trial_symbol)<>\'\' THEN trial_symbol ELSE a.symbol END symbol FROM bales b JOIN articles a ON a.id=b.article_id WHERE b.id=?').get(lastWeighed.id)?.symbol || '', number: `${lastWeighed.machine}/${lastWeighed.serial_number}` } : null,
    referenceCount: weighedRows.length,
    balesSinceLastWeigh,
    firstBalesRemaining,
    startupWeighNumber: articleCount === 0 ? 'pierwsza' : 'druga',
    weighInterval: interval,
    reminderIn,
    mustWeigh: firstBalesRemaining > 0 || dueByInterval,
    weighReason: firstBalesRemaining > 0 ? 'startup' : dueByInterval ? 'interval' : '',
  };
}
function bootstrap() {
  const today = todayWarsaw();
  const pending = db.prepare(`SELECT count(*) n FROM bales b WHERE b.sync_status='pending'
    AND NOT EXISTS (SELECT 1 FROM daily_production_report_bales rb WHERE rb.bale_id=b.id AND rb.state='included')`).get().n;
  const sequences = {};
  for (const row of db.prepare('SELECT machine,production_year,last_value FROM bale_sequences ORDER BY production_year,machine').all()) {
    (sequences[row.production_year] ||= {})[row.machine] = row.last_value;
  }
  const rows = baleRows().map(row => ({
    ...row,
    number: `${row.machine}/${row.serial_number}`,
    needs_check: Boolean(row.needs_check),
  }));
  const recentRows = baleRows(true).map(row => ({
    ...row,
    number: `${row.machine}/${row.serial_number}`,
    needs_check: Boolean(row.needs_check),
  }));
  return {
    today,
    productionDay: currentProductionDate(),
    machines: machineCatalog().map(machine=>machine.code),
    machineLabels: Object.fromEntries(machineCatalog().map(machine=>[machine.code,machine.name])),
    machineCatalog: machineCatalog(),
    articles: db.prepare(`SELECT a.id,a.id articleId,c.id choiceId,c.machine,a.symbol,a.central_id centralId,COALESCE(s.lot,'') lot,COALESCE(s.is_trial,0) isTrial,
      COALESCE(s.weight_weigh_interval,20) weightWeighInterval FROM articles a JOIN article_machine_choices c ON c.article_id=a.id AND c.active=1
      LEFT JOIN article_settings s ON s.article_id=a.id WHERE a.active=1 AND (a.central_managed=0 OR a.central_active=1) ORDER BY a.symbol COLLATE NOCASE,c.machine`).all(),
    workers: db.prepare("SELECT id,employee_uid,name FROM workers WHERE active=1 AND work_status='active' AND central_managed=1 AND central_active=1 ORDER BY name COLLATE NOCASE").all(),
    workerCatalog: workerCatalog(),
    sequences,
    bales: rows,
    recentBales: recentRows,
    lastBale: lastBaleRow(),
    pending,
    databasePath: DB_PATH,
  };
}
function workerCatalog() {
  return db.prepare(`SELECT id,employee_uid,name,work_status status FROM workers
    WHERE central_managed=1 AND central_active=1 ORDER BY name COLLATE NOCASE`).all();
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
function validateCatalog(body, key, activeMachines = new Set(activeMachineCodes())) {
  const source = body[key];
  if (!Array.isArray(source) || source.length > 500) fail(400, 'Nieprawidłowa lista.');
  const items = source.map(item => {
    if (key === 'articles') {
      const symbol = cleanText(item.symbol, 150, 'Symbol artykułu');
      if (!symbol) fail(400, 'Symbol artykułu nie może być pusty.');
      const centralId=item.centralId===undefined||item.centralId===null||item.centralId===''?null:Number(item.centralId);
      if(centralId!==null&&(!Number.isSafeInteger(centralId)||centralId<1)) fail(400,'Identyfikator artykułu z centrali jest nieprawidłowy.');
      const isTrial = item.isTrial === true;
      const machine=String(item.machine??'');
      if(!activeMachines.has(machine)) fail(400,`Dla artykułu ${symbol} wybierz konkretną aktywną maszynę w Ustawieniach.`);
      const weightWeighInterval=Number(item.weightWeighInterval??20);
      if(!Number.isInteger(weightWeighInterval)||weightWeighInterval<1||weightWeighInterval>99) fail(400,`Dla artykułu ${symbol} ustaw kontrolę wagi od 1 do 99 belek.`);
      return { symbol, lot: cleanText(item.lot, 120, 'LOT'), centralId, isTrial, machine, weightWeighInterval };
    }
    const name = cleanText(item.name, 100, 'Nazwa dziewiarza');
    const employeeUid = cleanText(item.employeeUid, 36, 'Identyfikator pracownika');
    const status = String(item.status || 'active');
    if (!name) fail(400, 'Podaj imię i nazwisko pracownika.');
    if (!/^[0-9a-f-]{32,36}$/i.test(employeeUid)) fail(400, 'Nieprawidłowy identyfikator pracownika.');
    if (!['active','vacation','sick'].includes(status)) fail(400, 'Nieprawidłowy status dziewiarza.');
    return { employeeUid, name, nameKey: normalizeWorkerName(name), status };
  });
  const keys = items.map(item => key === 'articles'
    ? `${item.symbol.toLocaleUpperCase('pl-PL')}\u0000${item.machine}`
    : item.nameKey);
  if (new Set(keys).size !== keys.length) fail(400, 'Lista zawiera powtarzający się wpis.');
  if (key === 'articles' && new Set(items.map(item => item.machine)).size !== items.length) fail(400, 'Każda maszyna może być przypisana tylko do jednego artykułu. Wybierz inną maszynę dla powtórzonego przypisania.');
  return items;
}
function validateMachines(source) {
  if(!Array.isArray(source)||source.length>100)fail(400,'Nieprawidłowa lista maszyn.');
  const rows=source.map(item=>{
    const code=String(item.code||'').trim().toUpperCase();
    const name=cleanText(item.name,60,'Nazwa maszyny');
    if(!/^[A-Z][A-Z0-9]{0,7}$/.test(code))fail(400,'Kod maszyny może zawierać litery i cyfry, np. M1.');
    if(!name)fail(400,'Podaj nazwę maszyny.');
    return {code,name};
  });
  if(new Set(rows.map(row=>row.code)).size!==rows.length)fail(400,'Lista zawiera powtórzony kod maszyny.');
  const names=rows.map(row=>row.name.toLocaleUpperCase('pl-PL'));
  if(new Set(names).size!==names.length)fail(400,'Każda maszyna musi mieć inną nazwę.');
  return rows;
}
function saveCatalogs(body) {
  const machines=validateMachines(Array.isArray(body.machines)?body.machines:machineCatalog().map(({code,name})=>({code,name})));
  const activeMachines=new Set(machines.map(machine=>machine.code));
  const articles = validateCatalog(body, 'articles',activeMachines);
  const workers = validateCatalog(body, 'workers');
  const sequenceYear = Number(body.sequenceYear);
  if (!Number.isInteger(sequenceYear) || sequenceYear < 2000 || sequenceYear > new Date().getFullYear() + 1) fail(400, 'Wybierz prawidłowy rok produkcji dla liczników.');
  const sequences = Array.isArray(body.sequences) ? body.sequences : [];
  if (sequences.length > activeMachines.size) fail(400, 'Nieprawidłowa konfiguracja numeracji.');
  const normalizedSequences = [];
  const seenMachines = new Set();
  for (const item of sequences) {
    const machine = String(item.machine || '');
    if (!activeMachines.has(machine) || seenMachines.has(machine)) fail(400, 'Nieprawidłowa lub powtórzona maszyna w numeracji.');
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
    const stamp=now();
    db.prepare('UPDATE machine_catalog SET active=0,updated_at=? WHERE active=1').run(stamp);
    const saveMachine=db.prepare(`INSERT INTO machine_catalog(code,name,active,created_at,updated_at) VALUES(?,?,1,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name,active=1,updated_at=excluded.updated_at`);
    for(const machine of machines)saveMachine.run(machine.code,machine.name,stamp,stamp);
    db.exec('UPDATE articles SET active=0; UPDATE workers SET active=0; UPDATE article_machine_choices SET active=0;');
    const addArticle = db.prepare(`INSERT INTO articles(symbol,active,central_id,central_managed,central_active,created_at) VALUES(?,1,?,?,1,?)
      ON CONFLICT(symbol) DO UPDATE SET active=1,central_id=coalesce(excluded.central_id,articles.central_id),central_managed=CASE WHEN excluded.central_id IS NULL THEN articles.central_managed ELSE 1 END,central_active=1`);
    const findArticle = db.prepare('SELECT id FROM articles WHERE symbol=?');
    const saveArticleSettings = db.prepare(`INSERT INTO article_settings(article_id,lot,trial_symbol,is_trial,updated_at,weight_weigh_interval) VALUES(?,?,'',?,?,?)
      ON CONFLICT(article_id) DO UPDATE SET lot=excluded.lot,trial_symbol='',is_trial=excluded.is_trial,updated_at=excluded.updated_at,weight_weigh_interval=excluded.weight_weigh_interval`);
    const saveArticleChoice=db.prepare(`INSERT INTO article_machine_choices(article_id,machine,active,created_at,updated_at) VALUES(?,?,1,?,?)
      ON CONFLICT(article_id,machine) DO UPDATE SET active=1,updated_at=excluded.updated_at`);
    for (const item of articles) {
      addArticle.run(item.symbol, item.centralId, item.centralId===null?0:1, now());
      const articleId=findArticle.get(item.symbol).id,stamp=now();
      saveArticleSettings.run(articleId, item.lot, item.isTrial ? 1 : 0, stamp,item.weightWeighInterval);
      saveArticleChoice.run(articleId,item.machine,stamp,stamp);
    }
    const saveWorkerStatus = db.prepare(`UPDATE workers SET active=1,work_status=? WHERE employee_uid=?`);
    for (const item of workers) {
      const result = saveWorkerStatus.run(item.status,item.employeeUid);
      if (!result.changes) fail(409, 'Lista pracowników się zmieniła. Zaktualizuj listę z programu głównego i spróbuj ponownie.');
    }
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
function productionCredentials() {
  const get = db.prepare('SELECT value FROM local_settings WHERE key=?');
  const serverUrl = get.get('production_server_url')?.value || DEFAULT_PRODUCTION_SERVER_URL;
  const apiToken = get.get('production_api_token')?.value || '';
  return { serverUrl, apiToken, configured: Boolean(serverUrl && apiToken) };
}
function localSetting(key, fallback = '') {
  return db.prepare('SELECT value FROM local_settings WHERE key=?').get(key)?.value ?? fallback;
}
function productionConnection() {
  const { serverUrl, configured } = productionCredentials();
  return { serverUrl, configured };
}
let centralCatalogSyncAt = 0;
let centralCatalogSyncPromise = null;
let centralCatalogSyncOptions = null;
let centralCatalogStartupSyncPromise = Promise.resolve();
async function refreshCentralCatalog(force = false, { syncArticles = true, syncWorkers = true } = {}) {
  const { serverUrl, apiToken, configured } = productionCredentials();
  if (!configured) return { updated: false, reason: 'not_configured' };
  if (!force && Date.now() - centralCatalogSyncAt < 30000) return { updated: false, reason: 'recent' };
  if (centralCatalogSyncPromise) {
    const covered = (!syncArticles || centralCatalogSyncOptions?.syncArticles) && (!syncWorkers || centralCatalogSyncOptions?.syncWorkers);
    if (covered) return centralCatalogSyncPromise;
    await centralCatalogSyncPromise.catch(() => {});
    return refreshCentralCatalog(force, { syncArticles, syncWorkers });
  }
  centralCatalogSyncAt=Date.now();
  centralCatalogSyncOptions = { syncArticles, syncWorkers };
  centralCatalogSyncPromise=(async()=>{
    const response=await fetch(`${serverUrl}/api/production/catalog`,{headers:{Authorization:`Bearer ${apiToken}`,Accept:'application/json'},signal:AbortSignal.timeout(4000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.ok!==true||!Array.isArray(payload.articles)||!Array.isArray(payload.workers)) throw new Error(payload.error||'Nie udało się pobrać bibliotek z programu głównego.');
    transaction(()=>{
      if (syncArticles) db.exec('UPDATE articles SET central_active=0 WHERE central_managed=1;');
      if (syncWorkers) db.exec('UPDATE workers SET central_active=0 WHERE central_managed=1;');
      for(const item of syncArticles ? payload.articles : []){
        const centralId=Number(item.id),symbol=cleanText(item.symbol,150,'Symbol artykułu'),description=cleanText(item.description,2000,'Opis artykułu');
        if(!Number.isSafeInteger(centralId)||centralId<1||!symbol) continue;
        const local=db.prepare('SELECT id FROM articles WHERE central_id=? OR symbol=? COLLATE NOCASE LIMIT 1').get(centralId,symbol);
        if(local) db.prepare('UPDATE articles SET symbol=?,central_id=?,central_managed=1,central_active=1,central_description=? WHERE id=?').run(symbol,centralId,description,local.id);
        else db.prepare('INSERT INTO articles(symbol,active,central_id,central_managed,central_active,central_description,created_at) VALUES(?,0,?,1,1,?,?)').run(symbol,centralId,description,now());
      }
      for(const item of syncWorkers ? payload.workers : []){
        const employeeUid=cleanText(item.employee_uid,36,'Identyfikator pracownika'),name=cleanText(item.name,100,'Nazwa dziewiarza'),nameKey=normalizeWorkerName(name);
        if(!/^[0-9a-f-]{32,36}$/i.test(employeeUid)||!name) continue;
        let local=db.prepare('SELECT id FROM workers WHERE employee_uid=?').get(employeeUid);
        if(!local) local=db.prepare('SELECT id FROM workers WHERE name_key=? OR (central_managed=0 AND lower(trim(name))=lower(trim(?))) ORDER BY central_managed DESC,active DESC,id LIMIT 1').get(nameKey,name);
        if(local) db.prepare('UPDATE workers SET employee_uid=?,name=?,name_key=?,active=1,central_managed=1,central_active=1 WHERE id=?').run(employeeUid,name,nameKey,local.id);
        else db.prepare(`INSERT INTO workers(employee_uid,code,name,active,central_managed,central_active,name_key,created_at) VALUES(?,'',?,1,1,1,?,?)`).run(employeeUid,name,nameKey,now());
      }
      if (syncArticles) db.prepare(`INSERT INTO local_settings(key,value) VALUES('central_catalog_synced_at',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(payload.syncedAt||now()));
      if (syncWorkers) db.prepare(`INSERT INTO local_settings(key,value) VALUES('central_workers_synced_at',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(payload.syncedAt||now()));
    });
    return {updated:true,syncedAt:payload.syncedAt||now(),articles:syncArticles?payload.articles.length:0,workers:syncWorkers?payload.workers.length:0};
  })().finally(()=>{centralCatalogSyncPromise=null;centralCatalogSyncOptions=null;});
  return centralCatalogSyncPromise;
}
function centralCatalogStatus(key = 'central_catalog_synced_at') {
  return db.prepare('SELECT value FROM local_settings WHERE key=?').get(key)?.value||'';
}
function saveProductionConnection(body) {
  const connectionUrl = String(body.productionServerUrl || DEFAULT_PRODUCTION_SERVER_URL).trim();
  const apiToken = String(body.productionApiToken || '').trim();
  let parsed;
  try { parsed = new URL(connectionUrl); } catch { fail(400, 'Wpisz prawidłowy adres programu głównego.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail(400, 'Adres serwera musi zaczynać się od http:// lub https:// i nie może zawierać danych logowania.');
  if (apiToken && !/^[a-f0-9]{64}$/i.test(apiToken)) fail(400, 'Token serwera ma nieprawidłowy format. Wklej token wygenerowany w programie głównym.');
  transaction(() => {
    db.prepare(`INSERT INTO local_settings(key,value) VALUES('production_server_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(connectionUrl.replace(/\/$/, ''));
    if (apiToken) db.prepare(`INSERT INTO local_settings(key,value) VALUES('production_api_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(apiToken);
  });
  return productionConnection();
}
async function checkProductionToken(config) {
  const target = new URL('/api/production/upload', `${config.serverUrl}/`).toString();
  let response;
  try {
    response = await fetch(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiToken}` },
      // The main program checks authorization before validating the row ID.
      // This deliberately invalid probe is rejected before any production write.
      body: JSON.stringify({ bales: [{ id: 'token-verification-probe' }] }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) { fail(503, `Nie można połączyć z programem głównym: ${error.message}`); }
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) fail(401, 'Program główny odrzucił zapisany token. Wklej aktualny token i sprawdź go ponownie.');
  if (response.status === 400 && result.error === 'Belka 1: nieprawidłowy identyfikator.') return true;
  fail(response.status || 502, result.error || `Nieoczekiwana odpowiedź programu głównego (${response.status}). Token nie został zmieniony.`);
}
async function verifyProductionToken(body = {}) {
  const stored = productionCredentials();
  const serverUrl = String(body.productionServerUrl || stored.serverUrl || DEFAULT_PRODUCTION_SERVER_URL).trim().replace(/\/$/, '');
  const suppliedToken = String(body.productionApiToken || '').trim();
  const apiToken = suppliedToken || stored.apiToken;
  let parsed;
  try { parsed = new URL(serverUrl); } catch { fail(400, 'Nieprawidłowy adres programu głównego.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail(400, 'Nieprawidłowy adres programu głównego.');
  if (!apiToken) fail(409, 'Brak zapisanego tokenu. Wklej token z programu głównego i wybierz „Sprawdź token”.');
  if (!/^[a-f0-9]{64}$/i.test(apiToken)) fail(400, 'Token ma nieprawidłowy format. Wklej token wygenerowany w programie głównym.');

  await checkProductionToken({ serverUrl, apiToken });
  if (suppliedToken || stored.serverUrl !== serverUrl) {
    saveProductionConnection({ productionServerUrl: serverUrl, productionApiToken: suppliedToken });
  }
  return { valid: true, message: 'Token jest poprawny. Program główny potwierdził dostęp; produkcja nie została wysłana.' };
}
async function uploadProduction() {
  const config = productionCredentials();
  if (!config.configured) fail(409, 'Kierownik musi najpierw skonfigurować adres i token serwera w Ustawieniach.');
  await checkProductionToken(config);
  const rows = db.prepare(`SELECT b.*,a.symbol FROM bales b JOIN articles a ON a.id=b.article_id
    WHERE b.sync_status='pending' AND upper(replace(replace(replace(a.symbol,' ',''),char(9),''),char(10),''))='WT56-21(5)'
    ORDER BY b.production_date,b.created_at,b.id`).all();
  const workersForBale = db.prepare(`SELECT w.employee_uid employeeUid,w.name,bw.meters FROM bale_workers bw
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
  if (!response.ok) {
    if (response.status === 401) fail(401, 'Token został potwierdzony tuż przed wysyłką, ale program główny odrzucił właściwe żądanie. Produkcja nie została wysłana; sprawdź, czy token nie został w międzyczasie zmieniony i czy oba żądania trafiają do tego samego serwera.');
    fail(response.status, result.error || `Program główny odpowiedział błędem ${response.status}.`);
  }
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
function dailyReportDetails(reportDate) {
  const report = db.prepare('SELECT * FROM daily_production_reports WHERE report_date=?').get(reportDate);
  if (!report) return null;
  const bales = db.prepare(`SELECT b.*,CASE WHEN trim(b.trial_symbol)<>'' THEN b.trial_symbol ELSE a.symbol END symbol,a.symbol article_symbol FROM daily_production_report_bales rb
    JOIN bales b ON b.id=rb.bale_id JOIN articles a ON a.id=b.article_id
    WHERE rb.report_date=? AND rb.state='included' ORDER BY b.created_at,b.machine,b.serial_number,b.id`).all(reportDate).map((row,index) => ({
      ...row,
      ordinal: index + 1,
      number: `${row.machine}/${row.serial_number}`,
      needs_check: Boolean(row.needs_check),
      workers: db.prepare(`SELECT bw.worker_id workerId,w.employee_uid employeeUid,w.name,bw.meters FROM bale_workers bw
        JOIN workers w ON w.id=bw.worker_id WHERE bw.bale_id=? ORDER BY w.name COLLATE NOCASE`).all(row.id),
    }));
  return { ...report, bales };
}
function publicDailyReport(report) {
  if (!report) return null;
  const { approved_payload, ...details } = report;
  return details;
}
function dailyProductionSummaries() {
  const current = lastCompletedProductionPeriod();
  const firstDate = addCalendarDays(current.reportDate, -29);
  const savedReports = db.prepare(`SELECT r.report_date,r.status,r.sent_at,r.last_error,r.starts_at,r.ends_at,
      count(rb.bale_id) pieces,round(coalesce(sum(b.weight_kg),0),2) weight_kg
    FROM daily_production_reports r
    LEFT JOIN daily_production_report_bales rb ON rb.report_date=r.report_date AND rb.state='included'
    LEFT JOIN bales b ON b.id=rb.bale_id
    WHERE r.report_date>=? GROUP BY r.report_date ORDER BY r.report_date DESC`).all(firstDate);
  const byDate = new Map(savedReports.map(report => [report.report_date, report]));
  const reports = [];
  const totalsForPeriod = db.prepare(`SELECT count(*) pieces,round(coalesce(sum(b.weight_kg),0),2) weight_kg FROM bales b
    WHERE b.created_at>=? AND b.created_at<?
    AND NOT EXISTS (SELECT 1 FROM daily_production_report_bales rb WHERE rb.bale_id=b.id AND rb.state='included')`);
  for (let date = firstDate; date <= current.reportDate; date = addCalendarDays(date, 1)) {
    if (byDate.has(date)) { reports.push(byDate.get(date)); continue; }
    const period = { reportDate: date, startsAt: warsawSixUtc(date), endsAt: warsawSixUtc(addCalendarDays(date, 1)) };
    const totals = totalsForPeriod.get(period.startsAt, period.endsAt);
    if (totals.pieces || date === current.reportDate) {
      reports.push({ report_date: date, starts_at: period.startsAt, ends_at: period.endsAt,
        status: '', sent_at: null, last_error: null, pieces: totals.pieces, weight_kg: totals.weight_kg });
    }
  }
  return reports.reverse();
}
function attachBaleToDailyReport(reportDate, baleId) {
  return transaction(() => {
    const report = db.prepare('SELECT status FROM daily_production_reports WHERE report_date=?').get(reportDate);
    if (!report) fail(404, 'Nie znaleziono raportu dziennego.');
    if (report.status === 'sent') fail(409, 'Do wysłanego raportu nie można dopisać belki.');
    if (!db.prepare('SELECT id FROM bales WHERE id=?').get(baleId)) fail(404, 'Nie znaleziono belki.');
    const elsewhere = db.prepare(`SELECT report_date FROM daily_production_report_bales
      WHERE bale_id=? AND state='included' AND report_date<>?`).get(baleId,reportDate);
    if (elsewhere) fail(409, 'Ta belka jest już przypisana do innego raportu.');
    db.prepare(`INSERT INTO daily_production_report_bales(report_date,bale_id,state) VALUES(?,?,'included')
      ON CONFLICT(report_date,bale_id) DO UPDATE SET state='included'`).run(reportDate,baleId);
    const stamp = now();
    db.prepare(`UPDATE bales SET sync_status='pending',synced_at=NULL,updated_at=? WHERE id=?`).run(stamp,baleId);
    db.prepare(`UPDATE daily_production_reports SET status='draft',approved_at=NULL,sent_at=NULL,last_error=NULL,approved_payload='{}',updated_at=? WHERE report_date=?`)
      .run(stamp,reportDate);
    return dailyReportDetails(reportDate);
  });
}
function removeBaleFromDailyReport(reportDate, baleId) {
  return transaction(() => {
    const report = db.prepare('SELECT status FROM daily_production_reports WHERE report_date=?').get(reportDate);
    if (!report) fail(404, 'Nie znaleziono raportu dziennego.');
    if (report.status === 'sent') fail(409, 'Z wysłanego raportu nie można usunąć belki.');
    const result = db.prepare(`UPDATE daily_production_report_bales SET state='removed' WHERE report_date=? AND bale_id=? AND state='included'`)
      .run(reportDate,baleId);
    if (!result.changes) fail(404, 'Nie znaleziono belki w tym raporcie.');
    const stamp = now();
    db.prepare(`UPDATE bales SET sync_status='pending',synced_at=NULL,updated_at=? WHERE id=?`).run(stamp,baleId);
    db.prepare(`UPDATE daily_production_reports SET status='draft',approved_at=NULL,sent_at=NULL,last_error=NULL,approved_payload='{}',updated_at=? WHERE report_date=?`)
      .run(stamp,reportDate);
    return dailyReportDetails(reportDate);
  });
}
function generateDailyReport(requestedReportDate = '') {
  const lastCompleted = lastCompletedProductionPeriod();
  let period = lastCompleted;
  if (requestedReportDate) {
    const reportDate = validateProductionDate(requestedReportDate);
    if (reportDate > lastCompleted.reportDate) fail(400, 'Można wygenerować raport tylko dla zakończonej doby produkcyjnej.');
    period = { reportDate, startsAt: warsawSixUtc(reportDate), endsAt: warsawSixUtc(addCalendarDays(reportDate,1)) };
  }
  const stamp = now();
  return transaction(() => {
    const exists = db.prepare('SELECT report_date FROM daily_production_reports WHERE report_date=?').get(period.reportDate);
    if (exists) return dailyReportDetails(period.reportDate);
    db.prepare(`INSERT INTO daily_production_reports(report_date,starts_at,ends_at,status,created_at,updated_at)
      VALUES(?,?,?,'draft',?,?)`).run(period.reportDate, period.startsAt, period.endsAt, stamp, stamp);
    const rows = db.prepare(`SELECT b.id FROM bales b WHERE b.created_at>=? AND b.created_at<?
      AND NOT EXISTS (SELECT 1 FROM daily_production_report_bales rb WHERE rb.bale_id=b.id AND rb.state='included')
      ORDER BY b.created_at,b.id`).all(period.startsAt, period.endsAt);
    const add = db.prepare('INSERT INTO daily_production_report_bales(report_date,bale_id) VALUES(?,?)');
    for (const row of rows) add.run(period.reportDate, row.id);
    return dailyReportDetails(period.reportDate);
  });
}
function toRemoteBale(row) {
  return {
    id: row.id, symbol: row.article_symbol || row.symbol, trial_symbol: row.trial_symbol || '', machine: row.machine, number: `${row.machine}/${row.serial_number}`,
    production_date: row.production_date, weight_kg: row.weight_kg, meters: row.meters,
    errors: row.errors, stops: row.stops, needs_check: row.needs_check, lot: row.lot, notes: row.notes,
    created_at: row.created_at,
    workers: db.prepare(`SELECT w.employee_uid employeeUid,w.name,bw.meters FROM bale_workers bw
      JOIN workers w ON w.id=bw.worker_id WHERE bw.bale_id=? ORDER BY w.name COLLATE NOCASE`).all(row.id),
  };
}
async function postBalesToMain(bales) {
  const config = productionCredentials();
  if (!config.configured) fail(409, 'Wklej token programu głównego w Ustawieniach i sprawdź połączenie.');
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
  const acceptedIds = Array.isArray(result.acceptedIds) ? result.acceptedIds : [];
  if (bales.some(row => !acceptedIds.includes(row.id))) fail(502, 'Serwer nie potwierdził odbioru wszystkich belek. Możesz bezpiecznie ponowić wysyłkę.');
  return result;
}
async function updateBaleReviewFlag(id, needsCheck) {
  const row = db.prepare(`SELECT b.*,a.symbol article_symbol FROM bales b JOIN articles a ON a.id=b.article_id WHERE b.id=?`).get(id);
  if (!row) fail(404, 'Nie znaleziono belki do oznaczenia.');
  const value = needsCheck ? 1 : 0;
  if (row.sync_status === 'synced') {
    const remoteRow = { ...row, needs_check: value };
    await postBalesToMain([toRemoteBale(remoteRow)]);
  }
  db.prepare('UPDATE bales SET needs_check=?,updated_at=? WHERE id=?').run(value, now(), id);
  return bootstrap();
}
async function sendDailyReport(reportDate) {
  let report = dailyReportDetails(reportDate);
  if (!report) fail(404, 'Nie znaleziono raportu dziennego. Najpierw wygeneruj produkcję.');
  if (report.status === 'sent') return { report, alreadySent: true };
  if (['approved_pending', 'send_error'].includes(report.status) && report.approved_payload && report.approved_payload !== '{}') {
    // Retry the exact saved approval payload to preserve the reviewed version.
  } else {
    const payload = report.bales.map(toRemoteBale);
    const stamp = now();
    transaction(() => db.prepare(`UPDATE daily_production_reports SET status='approved_pending',approved_at=?,updated_at=?,last_error=NULL,approved_payload=? WHERE report_date=?`)
      .run(stamp, stamp, JSON.stringify(payload), reportDate));
    report = dailyReportDetails(reportDate);
  }
  const approved = JSON.parse(report.approved_payload || '[]');
  try {
    const result = await postBalesToMain(approved);
    const stamp = now();
    transaction(() => {
      db.prepare(`UPDATE daily_production_reports SET status='sent',sent_at=?,updated_at=?,last_error=NULL WHERE report_date=?`).run(stamp, stamp, reportDate);
      const mark = db.prepare("UPDATE bales SET sync_status='synced',synced_at=?,updated_at=? WHERE id=?");
      for (const row of approved) mark.run(stamp, stamp, row.id);
    });
    return { report: dailyReportDetails(reportDate), uploaded: approved.length, snapshot: result.snapshot };
  } catch (error) {
    const stamp = now();
    transaction(() => db.prepare(`UPDATE daily_production_reports SET status='send_error',updated_at=?,last_error=? WHERE report_date=?`).run(stamp, error.message, reportDate));
    throw error;
  }
}
async function testUploadBales() {
  const rows = db.prepare(`SELECT b.*,a.symbol FROM bales b JOIN articles a ON a.id=b.article_id
    WHERE b.sync_status='pending' ORDER BY b.created_at,b.id`).all();
  const result = await postBalesToMain(rows.map(toRemoteBale));
  return { uploaded: result.acceptedIds.length, total: rows.length, snapshot: result.snapshot, bootstrap: bootstrap() };
}
function createBales(body, reportDate = '') {
  const articleId = validateArticleAndMachine(body.articleId, String(body.machine || ''));
  const machine = String(body.machine);
  const productionDate = validateProductionDate(body.productionDate);
  const year = Number(productionDate.slice(0, 4));
  if (!Array.isArray(body.bales) || body.bales.length < 1 || body.bales.length > 6) fail(400, 'Dodaj od jednej do sześciu belek naraz.');
  const entries = body.bales.map(item => normalizeBale(item, articleId));
  return transaction(() => {
    if (reportDate) {
      const report = db.prepare('SELECT status FROM daily_production_reports WHERE report_date=?').get(reportDate);
      if (!report) fail(404, 'Nie znaleziono raportu dziennego.');
      if (report.status === 'sent') fail(409, 'Do wysłanego raportu nie można dopisać belki.');
    }
    const created = [];
    const insert = db.prepare(`INSERT INTO bales
      (id,machine,production_year,serial_number,article_id,production_date,weight_kg,weight_weighed,weight_source,weight_gross_kg,tube_weight_kg,meters,errors,stops,lot,notes,trial_symbol,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const addWorker = db.prepare('INSERT INTO bale_workers(bale_id,worker_id,meters) VALUES(?,?,?)');
    for (const item of entries) {
      if (item.weightSource !== 'weighed') {
        const weightInfo = touchWeightInfo(articleId, productionDate, item.meters);
        if (weightInfo.mustWeigh) {
          const reason = weightInfo.weighReason === 'startup'
            ? 'Pierwsze dwie belki nowego artykułu muszą być zważone.'
            : `Po ${weightInfo.weighInterval} belkach bez ważenia kolejna belka musi być zważona.`;
          fail(409, reason);
        }
        if (!weightInfo.suggestion || Math.abs(item.weightKg - weightInfo.suggestion.weight_kg) >= 0.051) {
          fail(409, 'Nie można ustalić wagi bez ważenia. Zważ belkę albo użyj aktualnej wagi wyliczonej z ostatnich ważeń.');
        }
      }
      const id = crypto.randomUUID();
      const serial = allocateSerial(machine, year);
      const stamp = now();
      insert.run(id,machine,year,serial,articleId,productionDate,item.weightKg,item.weightWeighed ? 1 : 0,item.weightSource,item.weightGrossKg,item.tubeWeightKg,item.meters,item.errors,item.stops,item.lot,item.notes,item.trialSymbol,stamp,stamp);
      for (const worker of item.workers) addWorker.run(id,worker.workerId,worker.meters);
      if (reportDate) db.prepare(`INSERT INTO daily_production_report_bales(report_date,bale_id,state) VALUES(?,?,'included')`).run(reportDate,id);
      created.push({ id, number: `${machine}/${serial}` });
    }
    if (reportDate) db.prepare(`UPDATE daily_production_reports SET status='draft',approved_at=NULL,sent_at=NULL,last_error=NULL,approved_payload='{}',updated_at=? WHERE report_date=?`)
      .run(now(),reportDate);
    return created;
  });
}
function updateBale(id, body) {
  return transaction(() => {
    const current = db.prepare('SELECT * FROM bales WHERE id=?').get(id);
    if (!current) fail(404, 'Nie znaleziono belki.');
    const reports = db.prepare(`SELECT r.report_date,r.status FROM daily_production_report_bales rb
      JOIN daily_production_reports r ON r.report_date=rb.report_date WHERE rb.bale_id=? AND rb.state='included'`).all(id);
    if (reports.some(report => report.status === 'sent')) fail(409, 'Raport zawierający tę belkę został już wysłany. Korektę wykonuje się w systemie głównym.');
    if (current.sync_status !== 'pending' && !reports.length) fail(409, 'Belka została już wysłana. Korektę wykonuje się w systemie głównym.');
    const articleId = validateArticleAndMachine(body.articleId ?? current.article_id, String(body.machine ?? current.machine), true);
    const productionDate = validateProductionDate(body.productionDate ?? current.production_date);
    const machine = String(body.machine ?? current.machine);
    const item = normalizeBale(body, articleId, true, articleId === current.article_id ? current.trial_symbol : undefined, Boolean(current.weight_weighed));
    const year = Number(productionDate.slice(0,4));
    const serial = machine === current.machine && year === current.production_year ? current.serial_number : allocateSerial(machine, year);
    const stamp = now();
    db.prepare(`UPDATE bales SET machine=?,production_year=?,serial_number=?,article_id=?,production_date=?,weight_kg=?,weight_weighed=?,weight_source=?,weight_gross_kg=?,tube_weight_kg=?,meters=?,errors=?,stops=?,lot=?,notes=?,trial_symbol=?,sync_status='pending',synced_at=NULL,updated_at=? WHERE id=?`)
      .run(machine,year,serial,articleId,productionDate,item.weightKg,item.weightWeighed ? 1 : 0,item.weightSource,item.weightGrossKg,item.tubeWeightKg,item.meters,item.errors,item.stops,item.lot,item.notes,item.trialSymbol,stamp,id);
    db.prepare(`UPDATE daily_production_reports SET status='draft',approved_at=NULL,sent_at=NULL,last_error=NULL,approved_payload='{}',updated_at=?
      WHERE report_date IN (SELECT report_date FROM daily_production_report_bales WHERE bale_id=? AND state='included') AND status<>'sent'`)
      .run(stamp,id);
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
    const stamp = now();
    db.prepare(`UPDATE daily_production_reports SET status='draft',approved_at=NULL,last_error=NULL,approved_payload='{}',updated_at=?
      WHERE report_date IN (SELECT report_date FROM daily_production_report_bales WHERE bale_id=?) AND status<>'sent'`).run(stamp,id);
    db.prepare("DELETE FROM bales WHERE id=? AND sync_status='pending'").run(id);
    return bootstrap();
  });
}
function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/') return sendFile(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/app.js') return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/app.css') return sendFile(res, 'app.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/marand-logo.jpg') return sendFile(res, 'marand-logo.jpg', 'image/jpeg');
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    return centralCatalogStartupSyncPromise.then(()=>json(res, 200, bootstrap()));
  }
  if (req.method === 'GET' && url.pathname === '/api/bales/weight-suggestion') {
    const articleId = Number(url.searchParams.get('articleId'));
    const productionDate = String(url.searchParams.get('productionDate') || '');
    const meters = Number(String(url.searchParams.get('meters') || '').replace(',', '.'));
    if (!Number.isInteger(articleId) || articleId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(productionDate)
      || !Number.isFinite(meters) || meters <= 0 || meters > 100000) return json(res, 400, { error: 'Nieprawidłowe dane do podpowiedzi wagi.' });
    try { return json(res, 200, touchWeightInfo(articleId, productionDate, meters)); }
    catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/daily-production') {
    try {
      const currentPeriod = lastCompletedProductionPeriod();
      const selectedDate = String(url.searchParams.get('date') || '');
      const selected = /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)
        ? db.prepare('SELECT report_date,starts_at,ends_at FROM daily_production_reports WHERE report_date=?').get(selectedDate)
        : null;
      const period = selected ? { reportDate: selected.report_date, startsAt: selected.starts_at, endsAt: selected.ends_at } : currentPeriod;
      const report = dailyReportDetails(period.reportDate);
      const reports = dailyProductionSummaries();
      return json(res, 200, { period, report: publicDailyReport(report), reports, productionConnection: productionConnection() });
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    try { return json(res, 200, { productionConnection: productionConnection(), centralCatalogSyncedAt: centralCatalogStatus(), centralWorkersSyncedAt: centralCatalogStatus('central_workers_synced_at'), weightWeighInterval: Number(localSetting('weight_weigh_interval', '20')) || 20 }); }
    catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }
  if(req.method==='GET'&&url.pathname==='/api/catalog/search'){
    const q=String(url.searchParams.get('q')||'').trim().replace(/[\\%_]/g,'\\$&');
    const rows=q?db.prepare(`SELECT central_id id,symbol,central_description description FROM articles WHERE central_managed=1 AND central_active=1
      AND (symbol LIKE ? ESCAPE '\\' COLLATE NOCASE OR central_description LIKE ? ESCAPE '\\' COLLATE NOCASE OR CAST(central_id AS TEXT) LIKE ?) ORDER BY symbol COLLATE NOCASE LIMIT 50`).all(`%${q}%`,`%${q}%`,`%${q}%`):[];
    return json(res,200,{articles:rows,syncedAt:centralCatalogStatus()});
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
      if (url.pathname === '/api/settings/workers/refresh') {
        return refreshCentralCatalog(true, { syncArticles: false, syncWorkers: true }).then(result => {
          if (!result.updated) return json(res, 409, { error: 'Najpierw skonfiguruj połączenie z programem głównym.' });
          return json(res, 200, { workers: workerCatalog(), bootstrap: bootstrap(), syncedAt: centralCatalogStatus('central_workers_synced_at') });
        }).catch(error => json(res, error.status || 502, { error: `Nie udało się zaktualizować listy pracowników: ${error.message}` }));
      }
      if (url.pathname === '/api/settings/articles/refresh') {
        return refreshCentralCatalog(true, { syncArticles: true, syncWorkers: false }).then(result => {
          if (!result.updated) return json(res, 409, { error: 'Najpierw skonfiguruj połączenie z programem głównym.' });
          return json(res, 200, { articles: result.articles, syncedAt: centralCatalogStatus() });
        }).catch(error => json(res, error.status || 502, { error: `Nie udało się zaktualizować listy artykułów: ${error.message}` }));
      }
      if (url.pathname === '/api/settings') { return json(res, 200, saveCatalogs(body)); }
      if (url.pathname === '/api/settings/production-connection') {
        return json(res, 200, { productionConnection: saveProductionConnection(body) });
      }
      if (url.pathname === '/api/production/verify-token') {
        return verifyProductionToken(body).then(result => json(res, 200, result));
      }
      if (url.pathname === '/api/daily-production/generate') {
        return json(res, 200, { report: publicDailyReport(generateDailyReport(String(body.reportDate || ''))) });
      }
      const removeDailyBale = url.pathname.match(/^\/api\/daily-production\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/bales\/([0-9a-f-]+)\/remove$/i);
      if (removeDailyBale) {
        return json(res, 200, { report: publicDailyReport(removeBaleFromDailyReport(removeDailyBale[1],removeDailyBale[2])), bootstrap: bootstrap() });
      }
      const attachDailyBale = url.pathname.match(/^\/api\/daily-production\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/attach$/);
      if (attachDailyBale) {
        return json(res, 200, { report: publicDailyReport(attachBaleToDailyReport(attachDailyBale[1],String(body.baleId || ''))), bootstrap: bootstrap() });
      }
      const addDailyBales = url.pathname.match(/^\/api\/daily-production\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/bales$/);
      if (addDailyBales) {
        const created = createBales(body,addDailyBales[1]);
        return json(res, 201, { created, report: publicDailyReport(dailyReportDetails(addDailyBales[1])), bootstrap: bootstrap() });
      }
      const editDailyBale = url.pathname.match(/^\/api\/daily-production\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/bales\/([0-9a-f-]+)$/i);
      if (editDailyBale) {
        const membership = db.prepare(`SELECT 1 FROM daily_production_report_bales rb JOIN daily_production_reports r ON r.report_date=rb.report_date
          WHERE rb.report_date=? AND rb.bale_id=? AND rb.state='included' AND r.status<>'sent'`).get(editDailyBale[1],editDailyBale[2]);
        if (!membership) fail(409, 'Tej belki nie można już edytować w tym raporcie.');
        updateBale(editDailyBale[2],body);
        return json(res, 200, { report: publicDailyReport(dailyReportDetails(editDailyBale[1])), bootstrap: bootstrap() });
      }
      const dailySend = url.pathname.match(/^\/api\/daily-production\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/send$/);
      if (dailySend) {
        return sendDailyReport(dailySend[1]).then(result => json(res, 200, { ...result, report: publicDailyReport(result.report) }));
      }
      if (url.pathname === '/api/production/test-upload') {
        return testUploadBales().then(result => json(res, 200, result));
      }
      if (url.pathname === '/api/sync') {
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
        return updateBaleReviewFlag(review[1], body.needsCheck).then(result => json(res, 200, result));
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
  centralCatalogStartupSyncPromise = refreshCentralCatalog(true, { syncArticles: true, syncWorkers: false }).catch(error=>{console.warn(`Synchronizacja artykułów: ${error.message}`);return null;});
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
