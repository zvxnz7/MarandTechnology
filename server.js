'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const V = require('./views');
const ArchiveCleanup = require('./modules/archive-cleanup');
const SourceImport = require('./modules/source-import');
const DatabaseSnapshot = require('./modules/database-snapshot');
const Production = require('./modules/production');
const Warehouse = require('./modules/warehouse');

const ROOT = __dirname;
const DATA = path.resolve(process.env.MARAND_DATA || path.join(ROOT, 'data'));
const DB_PATH = path.resolve(process.env.MARAND_DATABASE || path.join(DATA, 'marand.sqlite3'));
const VERSION_PATH = path.join(ROOT, 'release.json');
const SECRET_PATH = path.join(DATA, 'secret.key');
const HOST = process.env.MARAND_HOST || '127.0.0.1';
const PORT = Number(process.env.MARAND_PORT || 8765);
const DEFAULT_GITHUB_REPO = 'zvxnz7/MarandTechnology';
const MAX_BODY = 3 * 1024 * 1024;
const MAX_IMPORT_BODY = 25 * 1024 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;
const execFileAsync = promisify(execFile);
const pendingSourceImports = new Map();
const nodeVersion = process.versions.node.split('.').map(Number);
if (nodeVersion[0] < 24 || (nodeVersion[0] === 24 && nodeVersion[1] < 15)) throw new Error('Wymagany jest Node.js 24.15 lub nowszy.');
const versionInfo = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
process.env.MARAND_VERSION = versionInfo.version;

if (!fs.existsSync(SECRET_PATH) && !process.env.MARAND_SECRET) {
  throw new Error('Uruchom najpierw: node manage.js init');
}
const SESSION_SECRET = process.env.MARAND_SECRET || fs.readFileSync(SECRET_PATH, 'utf8').trim();
if (SESSION_SECRET.length < 32) throw new Error('MARAND_SECRET / data/secret.key musi mieć co najmniej 32 znaki.');
if (!fs.existsSync(DB_PATH)) throw new Error('Brak bazy danych. Uruchom najpierw: node manage.js init');

const db = new DatabaseSync(DB_PATH, { timeout: 15000, enableForeignKeyConstraints: true });
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;');
require('./modules/database').migrate(db, DB_PATH);
function recoverInterruptedSourceImport() {
  const markerPath = path.join(DATA, 'maintenance.json');
  const marker = readJsonIfExists(markerPath);
  if (!marker || !['source-import', 'source-import-restore'].includes(marker.operation) || !Number.isSafeInteger(Number(marker.pid))) return;
  if (marker.operation === 'source-import') {
    try {
      process.kill(Number(marker.pid), 0);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') return;
    }
  }
  try {
    let restored = false;
    if (marker.operation === 'source-import-restore') {
      restored = !marker.package_hash || !DatabaseSnapshot.containsImportRun(DB_PATH, marker.package_hash);
      const recoverySnapshot = restored ? marker.backup_path : marker.rollback_path;
      if (recoverySnapshot && fs.existsSync(recoverySnapshot)) {
        DatabaseSnapshot.restorePhotosFromSnapshot(DATA, recoverySnapshot);
      }
    }
    DatabaseSnapshot.inspectSnapshot(DB_PATH, { photosPath: path.join(DATA, 'photos') });
    if (marker.operation === 'source-import-restore') {
      writeSourceImportRestoreStatus({
        ok: restored,
        at: now(),
        package_hash: marker.package_hash || '',
        rollback_name: marker.rollback_path ? path.basename(marker.rollback_path) : '',
        error: restored ? '' : 'Przywracanie przerwano. Baza jest poprawna, ale wybrany import nadal jest aktywny; można ponowić przywracanie.',
      });
    }
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) {
      console.error('Przerwana operacja importu pozostawiła kontrolę bazy w stanie nieprawidłowym; zachowano plik maintenance.json.');
      return;
    }
    fs.rmSync(markerPath, { force: true });
    console.warn('Usunięto blokadę po przerwanym imporcie; baza przeszła kontrolę integralności.');
  } catch (error) {
    console.error('Nie udało się sprawdzić bazy po przerwanym imporcie:', error);
  }
}
recoverInterruptedSourceImport();
function purgeExpiredArchive() {
  try {
    const removedRecords = ArchiveCleanup.purgeExpired(db, path.join(DATA, 'photos'));
    const removedArticles = ArchiveCleanup.purgeExpiredArticles(db, path.join(DATA, 'photos'));
    if (removedRecords || removedArticles) console.log(`Archiwum: oczyszczono ${removedRecords} wpisów roboczych i ${removedArticles} artykułów.`);
  } catch (error) {
    console.error('Nie udało się oczyścić wygasłych wpisów archiwum:', error);
  }
}
purgeExpiredArchive();
const TECH = V.TECH;
const RAW_METRICS = V.RAW_METRICS;
const TARGET_METRICS = V.TARGET_METRICS;
const GB = V.GB;
const Catalog = require('./modules/catalog');
const Changes = require('./modules/card-changes');
db.function('search_text', { deterministic: true }, normalize);
const Photos = require('./modules/photos').create({db,DATA,fail,role,transaction,audit,now,send,redirect});
Production.initialize(db);
Warehouse.initialize(db);


class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }
function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function todayWarsaw() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function nextTrialNumber() {
  const year=Number(todayWarsaw().slice(0,4));
  const saved=db.prepare('SELECT last_value FROM project_trial_sequences WHERE year=?').get(year)?.last_value||0;
  const existing=db.prepare("SELECT max(CAST(substr(trial_number,1,instr(trial_number,'/')-1) AS INTEGER)) n FROM projects WHERE trial_number LIKE ?").get(`%/${year}`).n||0;
  const number=Math.max(Number(saved),Number(existing))+1;
  db.prepare('INSERT INTO project_trial_sequences(year,last_value) VALUES(?,?) ON CONFLICT(year) DO UPDATE SET last_value=excluded.last_value').run(year,number);
  return `${number}/${year}`;
}
function normalize(value) { return String(value || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ''); }
function dump(value) { return JSON.stringify(value); }
function blank() {
  return { symbol: '', number: '', date: '', client: '', description: '', tech: {}, gb: [], raw: {}, raw_comments: '', finished_comments: '', finished: [], comments: '', stages: '', targets: {}, knitter_notes: '', sources: [] };
}
function parsePayload(row) { return JSON.parse(row.payload); }
function getUser(id) { return db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id); }
function project(id) {
  const row = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!row) fail(404, 'Nie znaleziono projektu.');
  return row;
}
function record(id) {
  const row = db.prepare('SELECT r.*,p.name project_name,p.archived_at project_archived_at,p.trial_number project_trial_number,a.active_spec,a.archived_at article_archived_at,a.pending_production_notes,p.conflict FROM records r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN articles a ON a.id=r.article_id WHERE r.id=?').get(id);
  if (!row) fail(404, 'Nie znaleziono wpisu.');
  return row;
}
function pendingProductionNotes(row) {
  if (!row?.article_id) return '';
  return String(db.prepare('SELECT pending_production_notes FROM articles WHERE id=?').get(row.article_id)?.pending_production_notes||'');
}
function makeArticle(projectId, symbol) {
  const key = String(symbol).toUpperCase().replace(/\s/g, '');
  const matches = db.prepare('SELECT * FROM articles WHERE symbol_key=?').all(key);
  if (matches.length > 1) fail(409, 'Istnieje kilka historycznych artykułów z tym symbolem. Wybierz artykuł w jego kartotece.');
  let a = matches[0];
  if (!a) {
    const id = db.prepare('INSERT INTO articles(symbol,symbol_key,created_at,updated_at) VALUES(?,?,?,?)').run(symbol, key, now(), now()).lastInsertRowid;
    a = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
  }
  if (projectId) db.prepare('INSERT OR IGNORE INTO project_articles VALUES(?,?)').run(projectId, a.id);
  return a;
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
function audit(user, action, recordId = null, detail = '', articleId = undefined) {
  const linkedArticleId=articleId===undefined&&recordId?db.prepare('SELECT article_id FROM records WHERE id=?').get(recordId)?.article_id||null:articleId||null;
  const inserted=db.prepare('INSERT INTO audit(at,user_id,action,record_id,detail) VALUES(?,?,?,?,?)').run(now(), user ? user.id : null, action, recordId, detail);
  if(linkedArticleId)db.prepare('INSERT OR IGNORE INTO audit_articles(audit_id,article_id) VALUES(?,?)').run(inserted.lastInsertRowid,linkedArticleId);
}
function auditProjectChange(user, projectId, action, detail) {
  const records = db.prepare(`SELECT pa.article_id,
      (SELECT max(sa.record_id) FROM project_stage_articles sa JOIN project_stages s ON s.id=sa.stage_id WHERE s.project_id=pa.project_id AND sa.article_id=pa.article_id AND sa.record_id IS NOT NULL) record_id
    FROM project_articles pa WHERE pa.project_id=?`).all(projectId);
  if (!records.length) { audit(user, action, null, detail); return; }
  for (const row of records) audit(user, action, row.record_id, detail, row.article_id);
}
function setProjectStatus(projectId, status, stamp = now()) {
  if (!Object.hasOwn(V.PROJECT_STATUS, status)) fail(400, 'Nieprawidłowy status próby.');
  const legacyStatus = ['accepted', 'failed', 'client_declined'].includes(status) ? status : 'in_progress';
  db.prepare('UPDATE projects SET workflow_status=?,status=?,updated_at=? WHERE id=?').run(status, legacyStatus, stamp, projectId);
}
function stageIssueContext(projectId, stageId, articleId) {
  if (projectId === 0 && stageId === 0) return null;
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(stageId) || stageId < 1) fail(400, 'Nieprawidłowe powiązanie próby z wydawaną kartą.');
  const stage = db.prepare(`SELECT s.*,p.archived_at project_archived_at
    FROM project_stages s JOIN projects p ON p.id=s.project_id
    JOIN project_stage_articles sa ON sa.stage_id=s.id
    WHERE s.id=? AND s.project_id=? AND sa.article_id=?`).get(stageId, projectId, articleId);
  if (!stage) fail(409, 'Artykuł nie jest przypisany do wskazanego etapu próby.');
  if (stage.project_archived_at) fail(409, 'Projekt/próba jest zarchiwizowany. Przywróć go przed wydaniem karty.');
  return stage;
}
function stale(row, form) {
  if (String(row.revision) !== String(form.revision || '')) fail(409, 'Ktoś zapisał nowszą wersję. Wróć do formularza, zachowaj własne uwagi i wczytaj aktualne dane.');
}
function role(user, ...allowed) {
  if (!user || !allowed.includes(user.role)) fail(403, 'Brak uprawnień do tej operacji.');
}
function formText(form, key) { return String(form[key] || '').trim(); }
function parseForm(form, old) {
  const v = blank();
  v.sources = Array.isArray(old.sources) ? old.sources : [];
  v.source_note = old.source_note || '';
  for (const key of ['symbol', 'number', 'date', 'client', 'description', 'raw_comments', 'finished_comments', 'comments', 'stages', 'knitter_notes']) v[key] = formText(form, key);
  if (!v.symbol) fail(400, 'Symbol artykułu jest wymagany.');
  for (const [group, keys] of [['tech', TECH], ['raw', RAW_METRICS], ['targets', TARGET_METRICS]]) {
    v[group] = Object.fromEntries(keys.map(([key]) => [key, formText(form, `${group}_${key}`)]));
  }
  const numbers = new Set();
  for (let i = 0; i < 12; i++) {
    const row = Object.fromEntries(GB.map(([key]) => [key, formText(form, `gb_${i}_${key}`)]));
    if (Object.entries(row).some(([k,v]) => k !== 'number' && v)) {
      row.number = (old.gb?.length ? row.number : '') || old.gb?.[i]?.number || String(Math.max(0,...(old.gb||[]).map(g=>Number(g.number))) + i - (old.gb||[]).length + 1);
      if (!/^\d+$/.test(row.number) || Number(row.number) < 1 || Number(row.number) > 32) fail(400, 'Numer GB musi być liczbą od 1 do 32.');
      if (numbers.has(row.number)) fail(400, 'Numer GB nie może się powtarzać.');
      numbers.add(row.number);
      v.gb.push(row);
    }
  }
  const finishFields = ['name', 'weight', 'width', 'pk', 'pr', 'thickness', 'finish', 'comments'];
  for (let i = 0; i < 3; i++) {
    const finish = Object.fromEntries(finishFields.map(key => [key, formText(form, `finish_${i}_${key}`)]));
    if (Object.values(finish).some(Boolean)) v.finished.push(finish);
  }
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > 120000) fail(400, 'Wpis jest zbyt długi.');
  return v;
}
function validateReady(row) {
  const v = parsePayload(row);
  if (!row.symbol || !v.gb.length) fail(400, 'Uzupełnij symbol i przynajmniej jedną GB.');
  if (['machine_type', 'gauge', 'density', 'working_width', 'panels'].some(k => !v.tech[k])) fail(400, 'Uzupełnij typ i podział maszyny, ścisłość, szerokość roboczą i liczbę szali.');
  if (v.gb.some(g => ['number', 'yarn', 'threads', 'run_in', 'threading', 'pattern'].some(k => !g[k]))) fail(400, 'Uzupełnij przędzę, liczbę nici, wrobienie, nawleczenie i raport dla każdej używanej GB.');
}
function signedCookie(session) {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const secure = process.env.MARAND_HTTPS === '1' ? '; Secure' : '';
  return `marand_session=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}
function readCookie(req) {
  const raw = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('marand_session='));
  if (!raw) return {};
  const value = raw.slice('marand_session='.length);
  const dot = value.lastIndexOf('.');
  if (dot < 1) return {};
  const payload = value.slice(0, dot), provided = value.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return {};
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Date.now() ? session : {};
  } catch { return {}; }
}
function setSessionCookie(session) {
  session.exp = Date.now() + SESSION_SECONDS * 1000;
  return signedCookie(session);
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
}
function send(req, res, status, body, contentType = 'text/html; charset=utf-8', extra = {}) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Set-Cookie', setSessionCookie(req.session));
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
  res.end(body);
}
function redirect(req, res, location, message = '', category = 'success') {
  if (message) (req.session.flashes ||= []).push({ category, message });
  securityHeaders(res);
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Set-Cookie', setSessionCookie(req.session));
  res.end();
}
function consumeFlashes(session) { const flashes = session.flashes || []; session.flashes = []; return flashes; }
function canEdit(user) { return user && ['technologist', 'approver', 'admin'].includes(user.role); }
function getFlashes(req) { return consumeFlashes(req.session); }
async function readBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') fail(400, 'Nieprawidłowy format formularza.');
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) fail(413, 'Formularz jest zbyt duży.');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}
async function readImportBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') fail(400, 'Wybierz plik paczki JSON.');
  const advertisedLength = Number(req.headers['content-length'] || 0);
  if (advertisedLength > MAX_IMPORT_BODY) fail(413, 'Paczka przekracza limit 25 MB.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_IMPORT_BODY) fail(413, 'Paczka przekracza limit 25 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
function validCsrfToken(expectedValue, providedValue) {
  const expected = Buffer.from(String(expectedValue || ''));
  const provided = Buffer.from(String(providedValue || ''));
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
function cleanPendingSourceImports() {
  const at = Date.now();
  for (const [token, pending] of pendingSourceImports) if (pending.expiresAt <= at) {
    clearTimeout(pending.timer);
    pendingSourceImports.delete(token);
  }
}
function discardPendingSourceImport(token) {
  const pending = pendingSourceImports.get(token);
  if (pending) clearTimeout(pending.timer);
  pendingSourceImports.delete(token);
}
async function createSourceImportBackup() {
  const configPath = process.env.MARAND_UPDATE_CONFIG || path.resolve(ROOT, '..', 'administracja', 'konfiguracja.json');
  if (!fs.existsSync(configPath)) throw new Error('Brak konfiguracji kopii zapasowych. Import przerwany przed zmianą bazy.');
  const config = readJsonIfExists(configPath);
  if (!config || !config.program_dir || !config.data_dir || !config.backup_dir) throw new Error('Konfiguracja kopii zapasowych jest niekompletna. Import przerwany przed zmianą bazy.');
  const norm = value => path.resolve(String(value)).toLowerCase();
  if (norm(config.program_dir) !== norm(ROOT) || norm(config.data_dir) !== norm(DATA)) throw new Error('Konfiguracja wskazuje inną instalację programu lub bazy. Import został zatrzymany.');
  const backupRoot = path.resolve(String(config.backup_dir));
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const backupPath = path.join(backupRoot, 'przed_importem', `IMPORT-${stamp}.sqlite3`);
  try {
    await execFileAsync(process.execPath, [path.join(ROOT, 'manage.js'), 'backup', '--output', backupPath], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().slice(0, 1200);
    throw new Error(`Nie udało się utworzyć sprawdzonej kopii bazy i zdjęć. Import przerwany. ${detail}`);
  }
  if (!fs.existsSync(backupPath)) throw new Error('Polecenie kopii nie utworzyło pliku. Import przerwany przed zmianą bazy.');
  return backupPath;
}
function sourceImportRestoreTarget(packageHash) {
  const run = SourceImport.importRunByHash(db, packageHash);
  if (!run) fail(404, 'Nie znaleziono importu do cofnięcia.');
  const latest = SourceImport.latestImportRun(db);
  if (!latest || latest.package_hash !== run.package_hash) fail(409, 'Można cofnąć tylko ostatni import.');

  const configPath = path.resolve(process.env.MARAND_UPDATE_CONFIG || path.resolve(ROOT, '..', 'administracja', 'konfiguracja.json'));
  if (!fs.existsSync(configPath)) throw new Error('Brak konfiguracji kopii zapasowych.');
  const config = readJsonIfExists(configPath);
  if (!config || !config.program_dir || !config.data_dir || !config.backup_dir) throw new Error('Konfiguracja kopii zapasowych jest niekompletna.');
  const norm = value => path.resolve(String(value)).toLowerCase();
  if (norm(config.program_dir) !== norm(ROOT) || norm(config.data_dir) !== norm(DATA)) throw new Error('Konfiguracja wskazuje inną instalację programu lub bazy.');
  if (config.service_type !== 'scheduled-task' || !config.service_name) throw new Error('Automatyczne przywracanie wymaga instalacji jako zadanie Windows.');

  const backupDirectory = path.resolve(String(config.backup_dir), 'przed_importem');
  const backupPath = path.resolve(String(run.backup_path || ''));
  if (path.dirname(backupPath).toLowerCase() !== backupDirectory.toLowerCase() || !/^IMPORT-\d{17}\.sqlite3$/.test(path.basename(backupPath))) {
    throw new Error('Zapisana kopia importu wskazuje niedozwoloną ścieżkę.');
  }
  const snapshot = DatabaseSnapshot.inspectSnapshot(backupPath);
  if (DatabaseSnapshot.containsImportRun(backupPath, packageHash)) throw new Error('Kopia została wykonana po imporcie i nie może go cofnąć.');
  const helper = path.join(ROOT, 'administracja', 'restore-import.ps1');
  if (!fs.existsSync(helper)) throw new Error('Brak skryptu przywracania w tej wersji programu.');
  const adminDirectory = path.dirname(configPath);
  const controlScript = path.join(adminDirectory, 'control-server.ps1');
  const settings = readJsonIfExists(path.join(adminDirectory, 'server-settings.json'));
  const configuredNodePath = String(config.node_path || settings?.node_path || '').trim();
  if (!fs.existsSync(controlScript) || !settings || !configuredNodePath) throw new Error('Brak plików wymaganych do bezpiecznego zatrzymania i uruchomienia serwera.');
  const nodePath = path.resolve(configuredNodePath);
  if (!fs.existsSync(nodePath)) throw new Error('Nie znaleziono node.exe wskazanego w konfiguracji serwera.');
  return { run, backupPath, backupName: path.basename(backupPath), configPath, helper, photoCount: snapshot.photoFiles.length };
}
function matchId(pathname, pattern) { const m = pathname.match(pattern); return m ? Number(m[1]) : null; }
function isLocal(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
function dataTag() { return crypto.createHash('sha256').update(path.resolve(path.dirname(DB_PATH)).toLowerCase()).digest('hex'); }
function versionTuple(version) {
  const m = String(version || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}
function isNewer(a, b) {
  const x = versionTuple(a), y = versionTuple(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}
async function githubLatest(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('Ustaw MARAND_GITHUB_REPO w formacie właściciel/repozytorium.');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Marand-Technologia-Updater' };
  if (process.env.MARAND_GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.MARAND_GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (response.status === 404) throw new Error('Repozytorium nie ma jeszcze wydania. Po wypchnięciu zmian na main GitHub opublikuje je automatycznie; odśwież tę stronę za chwilę.');
    throw new Error(`GitHub nie zwrócił wydania (${response.status}). Sprawdź repozytorium i dostęp do niego.`);
  }
  return response.json();
}
function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeSourceImportRestoreStatus(status) {
  const destination = path.join(DATA, 'import_restore_status.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(status), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, destination);
}
async function syncExternalUpdater(updaterPath) {
  const bundled = path.join(ROOT, 'administracja', 'updater.js');
  const target = path.resolve(updaterPath);
  const bundledKey = process.platform === 'win32' ? bundled.toLowerCase() : bundled;
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
  if (bundledKey === targetKey) return;

  let source;
  try { source = await fsp.readFile(bundled); }
  catch (error) {
    // Older installs keep only the external updater. They can still launch it
    // to install this release, which adds the bundled copy for future syncs.
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const targetStat = await fsp.lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
    throw new Error('Ścieżka zewnętrznego aktualizatora musi wskazywać zwykły plik.');
  }
  if (targetStat) {
    const current = await fsp.readFile(target);
    const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
    const currentHash = crypto.createHash('sha256').update(current).digest('hex');
    if (sourceHash === currentHash) return;
  }

  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temporary, source, { flag: 'wx' });
    await fsp.rename(temporary, target);
  } catch (error) {
    try { await fsp.rm(temporary, { force: true }); } catch {}
    throw new Error(`Nie można zaktualizować zewnętrznego aktualizatora: ${error.message}`);
  }
}
async function startGithubUpdate(req) {
  const repo = process.env.MARAND_GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const updater = process.env.MARAND_UPDATER || '';
  if (!updater || !fs.existsSync(updater)) throw new Error('Zewnętrzny aktualizator nie jest skonfigurowany. Informatyk musi skopiować administracja/updater.js poza katalog programu i ustawić MARAND_UPDATER.');
  const rel = path.relative(ROOT, path.resolve(updater));
  const insideProgram = rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  if (insideProgram) throw new Error('Aktualizator musi znajdować się poza katalogiem programu, aby przetrwać jego podmianę.');
  const updateConfig = process.env.MARAND_UPDATE_CONFIG || path.join(path.dirname(path.resolve(updater)), 'konfiguracja.json');
  if (!fs.existsSync(updateConfig)) throw new Error('Brak konfiguracja.json obok zewnętrznego aktualizatora. Skonfiguruj MARAND_UPDATE_CONFIG.');
  const release = await githubLatest(repo);
  const remoteVersion = String(release.tag_name || '').replace(/^v/, '');
  if (release.draft || release.prerelease || !versionTuple(remoteVersion)) throw new Error('Najnowsze wydanie GitHub nie ma stabilnego tagu w formacie vX.Y.Z.');
  if (!isNewer(remoteVersion, versionInfo.version)) throw new Error(`Zainstalowana wersja ${versionInfo.version} jest aktualna.`);
  const asset = (release.assets || []).find(a => a.name === 'marand-node-release.zip');
  if (!asset || !asset.url) throw new Error('Wydanie nie zawiera pliku marand-node-release.zip. Opublikuj wydanie przez workflow projektu.');
  const digest = String(asset.digest || '').match(/^sha256:([a-f0-9]{64})$/i);
  if (!digest) throw new Error('GitHub nie udostępnił sumy SHA-256 archiwum. Aktualizacja została zatrzymana.');
  const headers = { 'User-Agent': 'Marand-Technologia-Updater', Accept: 'application/octet-stream' };
  if (process.env.MARAND_GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.MARAND_GITHUB_TOKEN}`;
  const response = await fetch(asset.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Nie udało się pobrać archiwum aktualizacji (${response.status}).`);
  const limit = 100 * 1024 * 1024;
  const advertisedSize = Number(response.headers.get('content-length') || 0);
  if (advertisedSize > limit) throw new Error('Archiwum aktualizacji przekracza limit 100 MB.');
  const chunks = [];
  let total = 0;
  if (!response.body) throw new Error('GitHub zwrócił puste archiwum aktualizacji.');
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error('Archiwum aktualizacji przekracza limit 100 MB.'); }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, total);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual.toLowerCase() !== digest[1].toLowerCase()) throw new Error('Suma SHA-256 archiwum jest niezgodna. Aktualizacja została zatrzymana.');
  await syncExternalUpdater(updater);
  const staging = path.join(DATA, 'updates');
  await fsp.mkdir(staging, { recursive: true });
  const packagePath = path.join(staging, `marand-node-${remoteVersion}-${crypto.randomBytes(6).toString('hex')}.zip`);
  await fsp.writeFile(packagePath, bytes, { flag: 'wx' });
  const args = [updater, 'update', '--package', packagePath, '--version', remoteVersion, '--sha256', actual];
  const child = spawn(process.execPath, args, {
    cwd: path.dirname(updater), detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, MARAND_UPDATE_CONFIG: process.env.MARAND_UPDATE_CONFIG || '' },
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      child.once('error', onError);
      child.once('spawn', () => { child.removeListener('error', onError); resolve(); });
    });
  } catch (error) {
    try { await fsp.rm(packagePath, { force: true }); } catch {}
    throw new Error(`Nie udało się uruchomić aktualizatora: ${error.message}`);
  }
  child.unref();
  return { version: remoteVersion };
}

async function handle(req, res) {
  req.session = readCookie(req);
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('base64url');
  req.user = req.session.uid ? getUser(req.session.uid) : null;
  let form = {};
  let recovery = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = decodeURIComponent(url.pathname);
    if (p === '/api/production/upload' && req.method === 'POST') {
      const raw = await readImportBody(req);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { return send(req, res, 400, JSON.stringify({ ok: false, error: 'Nieprawidłowy format danych.' }), 'application/json; charset=utf-8'); }
      try {
        const result = Production.receiveUpload(db, req.headers.authorization, payload, { now, todayWarsaw, transaction, makeArticle, audit });
        return send(req, res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8');
      } catch (error) {
        const status = error.status || 500;
        return send(req, res, status, JSON.stringify({ ok: false, error: error.message || 'Nie udało się zapisać produkcji.' }), 'application/json; charset=utf-8');
      }
    }
    if (p === '/admin/import/preview' && req.method === 'POST') {
      try {
        if (!req.user || !req.user.active) return send(req, res, 401, JSON.stringify({ ok: false, error: 'Zaloguj się ponownie.' }), 'application/json; charset=utf-8');
        role(req.user, 'admin');
        if (fs.existsSync(path.join(DATA, 'maintenance.json'))) fail(503, 'Trwa aktualizacja programu. Spróbuj ponownie po jej zakończeniu.');
        if (!validCsrfToken(req.session.csrf, req.headers['x-csrf-token'])) fail(400, 'Sesja formularza wygasła. Odśwież stronę.');
        const bytes = await readImportBody(req);
        const pkg = SourceImport.readPackageBuffer(bytes, 'plik przesłany przez administratora');
        const report = SourceImport.preview(db, pkg);
        cleanPendingSourceImports();
        for (const [oldToken, pending] of pendingSourceImports) if (pending.userId === req.user.id) {
          clearTimeout(pending.timer);
          pendingSourceImports.delete(oldToken);
        }
        if (pendingSourceImports.size >= 3) fail(429, 'Jest już kilka oczekujących podglądów importu. Odczekaj 15 minut i spróbuj ponownie.');
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 15 * 60 * 1000;
        const timer = setTimeout(() => pendingSourceImports.delete(token), 15 * 60 * 1000);
        timer.unref();
        pendingSourceImports.set(token, { userId: req.user.id, bytes, digest: pkg.digest, expiresAt, timer });
        return send(req, res, 200, JSON.stringify({ ok: true, token, preview: report }), 'application/json; charset=utf-8');
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        return send(req, res, status, JSON.stringify({ ok: false, error: error.message || 'Nie udało się sprawdzić paczki.' }), 'application/json; charset=utf-8');
      }
    }
    if (req.method === 'POST' && !p.startsWith('/static/')) {
      form = await readBody(req);
      const csrfExpected = Buffer.from(String(req.session.csrf));
      const csrfProvided = Buffer.from(String(form.csrf || ''));
      if (csrfExpected.length !== csrfProvided.length || !crypto.timingSafeEqual(csrfExpected, csrfProvided)) fail(400, 'Sesja formularza wygasła. Odśwież stronę.');
    }

    if (p === '/healthz' && req.method === 'GET') {
      if (!isLocal(req)) fail(404, 'Nie znaleziono strony.');
      try {
        const pathExists = fs.existsSync(DB_PATH);
        const check = db.prepare('PRAGMA quick_check').get();
        if (!pathExists || !db.prepare('SELECT id FROM users LIMIT 1').get() || check.quick_check !== 'ok') fail(503, 'Database health check failed.');
      } catch { fail(503, 'Database health check failed.'); }
      return send(req, res, 200, JSON.stringify({ ok: true, version: versionInfo.version, data_tag: dataTag() }), 'application/json; charset=utf-8');
    }

    if (p.startsWith('/static/') && req.method === 'GET') {
      const relative = p.slice('/static/'.length);
      if (!relative || relative.includes('..') || relative.includes('\\')) fail(404, 'Nie znaleziono pliku.');
      const file = path.resolve(ROOT, 'static', relative);
      if (!file.startsWith(path.resolve(ROOT, 'static') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(404, 'Nie znaleziono pliku.');
      const mime = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const cacheHeaders = relative === 'logo.jpg' && url.searchParams.get('v') === V.LOGO_CACHE_VERSION
        ? { 'Cache-Control': 'private, max-age=31536000, immutable' }
        : {};
      return send(req, res, 200, fs.readFileSync(file), mime, cacheHeaders);
    }

    if (fs.existsSync(path.join(DATA, 'maintenance.json'))) return send(req, res, 503, 'Trwa aktualizacja programu. Wróć za kilka minut; dane pozostają zachowane.', 'text/plain; charset=utf-8');
    if (p !== '/login' && (!req.user || !req.user.active)) return redirect(req, res, '/login');

    if (p === '/login' && req.method === 'GET') return send(req, res, 200, V.loginPage({ csrf: req.session.csrf, flashes: getFlashes(req) }));
    if (p === '/login' && req.method === 'POST') {
      const login = formText(form, 'login').toLowerCase();
      const key = `${login}|${req.socket.remoteAddress || ''}`;
      const at = Date.now() / 1000;
      const result = transaction(() => {
        const attempt = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
        if (attempt && attempt.count >= 8 && attempt.until > at) fail(429, 'Za dużo prób logowania. Spróbuj za 15 minut.');
        const user = db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(login);
        if (user && verifyPassword(form.password || '', user.password)) {
          db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);
          return user;
        }
        const count = attempt && attempt.until > at ? attempt.count + 1 : 1;
        db.prepare('INSERT OR REPLACE INTO login_attempts(key,count,until) VALUES(?,?,?)').run(key, count, at + 900);
        return null;
      });
      if (!result) {
        req.session.flashes = [{ category: 'error', message: 'Nieprawidłowy login lub hasło.' }];
        return redirect(req, res, '/login');
      }
      req.session = { uid: result.id, csrf: crypto.randomBytes(32).toString('base64url') };
      return redirect(req, res, '/');
    }
    if (p === '/logout' && req.method === 'POST') {
      req.session = { csrf: crypto.randomBytes(32).toString('base64url') };
      return redirect(req, res, '/login');
    }

    const context = {db,req,res,p,url,form,send,redirect,fail,transaction,audit,now,blank,role,normalize,makeArticle,project,todayWarsaw,getFlashes,photos:Photos,readBackup:()=>readJsonIfExists(path.join(DATA,'backup_status.json'))};
    if (p === '/archive' && req.method === 'GET') {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const records = db.prepare('SELECT r.id,r.kind,r.symbol,r.archived_at,p.name project_name FROM records r LEFT JOIN projects p ON p.id=r.project_id WHERE r.archived_at IS NOT NULL AND r.archived_at>=? ORDER BY r.archived_at DESC,r.id DESC').all(cutoff);
      const projects = db.prepare('SELECT id,name,trial_number,short_description,archived_at FROM projects WHERE archived_at IS NOT NULL AND archived_at>=? ORDER BY archived_at DESC,id DESC').all(cutoff);
      const articles = db.prepare('SELECT id,symbol,archived_at FROM articles WHERE archived_at IS NOT NULL AND archived_at>=? AND purged_at IS NULL ORDER BY archived_at DESC,id DESC').all(cutoff);
      return send(req,res,200,V.archivePage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),records,projects,articles}));
    }
    if (Photos.handle(context) || res.writableEnded) return;
    if (Warehouse.handle(context) || res.writableEnded) return;
    if (await Production.handle(context) || res.writableEnded) return;
    if (await Catalog.handle(context) || res.writableEnded) return;

    if (p === '/projects' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const legacyState = url.searchParams.get('state') || '';
      const statusFilter = url.searchParams.get('status') || (legacyState==='approved'?'accepted':legacyState==='pending'?'in_progress':'');
      const validStatuses=Object.keys(V.PROJECT_STATUS);
      const status=validStatuses.includes(statusFilter)?statusFilter:'';
      const sortOptions={updated:'updated DESC,p.id DESC',created_desc:'p.created_at DESC,p.id DESC',created_asc:'p.created_at,p.id',status:"CASE p.workflow_status WHEN 'in_progress' THEN 1 WHEN 'to_knitter' THEN 2 WHEN 'produced' THEN 3 WHEN 'in_finishing' THEN 4 WHEN 'sample_at_client' THEN 5 WHEN 'accepted' THEN 6 WHEN 'failed' THEN 7 WHEN 'client_declined' THEN 8 ELSE 9 END,p.updated_at DESC,p.id DESC",number:"CAST(substr(p.trial_number,instr(p.trial_number,'/')+1) AS INTEGER),CAST(substr(p.trial_number,1,instr(p.trial_number,'/')-1) AS INTEGER)",name:'p.short_description COLLATE NOCASE,p.id'};
      const sort=sortOptions[url.searchParams.get('sort')]?url.searchParams.get('sort'):'updated';
      const dateFrom=/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date_from')||'')?url.searchParams.get('date_from'):'';
      const dateTo=/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date_to')||'')?url.searchParams.get('date_to'):'';
      const rawPage = Number(url.searchParams.get('page') || 1);
      const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
      const params = [], clauses=['p.archived_at IS NULL'];
      for(const word of normalize(q).split(/\s+/).filter(Boolean)) {
        clauses.push("search_text(p.trial_number || ' ' || p.short_description || ' ' || p.client_name || ' ' || p.goal || ' ' || p.assumptions || ' ' || p.comment || ' ' || coalesce((SELECT group_concat(pc.content,' ') FROM project_comments pc WHERE pc.project_id=p.id),'') || ' ' || coalesce((SELECT group_concat(a.symbol,' ') FROM project_articles pa JOIN articles a ON a.id=pa.article_id WHERE pa.project_id=p.id),'')) LIKE ? ESCAPE '\\'");
        params.push('%'+word.replace(/[\\%_]/g,'\\$&')+'%');
      }
      if(status){clauses.push('p.workflow_status=?');params.push(status);}
      if(dateFrom){clauses.push('substr(p.created_at,1,10)>=?');params.push(dateFrom);}
      if(dateTo){clauses.push('substr(p.created_at,1,10)<=?');params.push(dateTo);}
      const where='WHERE '+clauses.join(' AND ');
      const total=db.prepare(`SELECT count(*) n FROM projects p ${where}`).get(...params).n;
      const rows=db.prepare(`SELECT p.*,(SELECT count(DISTINCT pa.article_id) FROM project_articles pa WHERE pa.project_id=p.id) article_count,(SELECT count(*) FROM project_stages s WHERE s.project_id=p.id) total,max(coalesce((SELECT max(updated_at) FROM project_stages s WHERE s.project_id=p.id),''),coalesce(p.updated_at,''),p.created_at) updated FROM projects p ${where} ORDER BY ${sortOptions[sort]} LIMIT 15 OFFSET ?`).all(...params,(page-1)*15);
      const backupStatus = readJsonIfExists(path.join(DATA, 'backup_status.json'));
      if (backupStatus) {
        const stamp = backupStatus.last_success ? new Date(backupStatus.last_success) : null;
        backupStatus.stale = !stamp || Number.isNaN(stamp.getTime()) || (Date.now() - stamp.getTime() > 36 * 3600 * 1000);
      }
      return send(req, res, 200, V.homePage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), projects: rows, total, page, q, status, sort, dateFrom, dateTo, backupState: backupStatus }));
    }

    if (p === '/projects' && req.method === 'POST') {
      role(req.user, 'technologist', 'approver', 'admin');
      const shortDescription = formText(form, 'name');
      if (!shortDescription || shortDescription.length > 150) fail(400, 'Podaj krótki opis próby (do 150 znaków).');
      const goal=String(form.goal||form.description||'').trim().slice(0,6000), assumptions=String(form.assumptions||'').trim().slice(0,6000),clientName=formText(form,'client_name').slice(0,200),comment=formText(form,'comment').slice(0,3000);
      const pid = transaction(() => {
        const stamp=now(),number=nextTrialNumber(),name=`${number} · ${shortDescription}`;
        const result = db.prepare("INSERT INTO projects(name,description,created_at,trial_number,short_description,goal,assumptions,status,updated_at,client_name,workflow_status,comment) VALUES(?,?,?,?,?,?,?,'in_progress',?,?,'in_progress',?)").run(name,goal,stamp,number,shortDescription,goal,assumptions,stamp,clientName,comment);
        const projectId=Number(result.lastInsertRowid);
        db.prepare("INSERT INTO project_stages(project_id,stage_no,stage_date,status,updated_at) VALUES(?,1,?,'in_progress',?)").run(projectId,todayWarsaw(),stamp);
        if(comment)db.prepare('INSERT INTO project_comments(project_id,author_user_id,author_name,content,created_at) VALUES(?,?,?,?,?)').run(projectId,req.user.id,req.user.name,comment,stamp);
        audit(req.user, 'Utworzono próbę', null, `${number} · ${shortDescription}${clientName?` · ${clientName}`:''}${comment?` · ${comment}`:''}`);
        return projectId;
      });
      return redirect(req, res, `/projects/${pid}`);
    }

    const projectAutosave=p.match(/^\/projects\/(\d+)\/autosave$/);
    if(projectAutosave&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectAutosave[1]),pr=project(pid),field=formText(form,'field'),value=String(form.value||'').slice(0,6000);
      if(pr.archived_at)fail(409,'Nie można zmieniać zarchiwizowanej próby.');
      if(field!=='goal')fail(400,'Nieprawidłowe pole do zapisu.');
      let updatedAt=pr.updated_at;
      transaction(()=>{
        const current=project(pid);if(current.archived_at)fail(409,'Nie można zmieniać zarchiwizowanej próby.');
        const previousGoal=String(current.goal||current.description||'').trim(),previousAssumptions=String(current.assumptions||'').trim();
        const before=previousGoal&&previousAssumptions?`Cel próby:\n${previousGoal}\n\nZałożenia i pomysły:\n${previousAssumptions}`:previousGoal||previousAssumptions;
        if(before===value)return;
        updatedAt=now();
        db.prepare("UPDATE projects SET goal=?,description=?,assumptions='',updated_at=? WHERE id=?").run(value,value,updatedAt,pid);
        auditProjectChange(req.user,pid,'Zapisano założenia projektowe',JSON.stringify({trial:current.trial_number,field,before,after:value,author:req.user.name,at:updatedAt}));
      });
      return send(req,res,200,JSON.stringify({ok:true,updatedAt}),'application/json; charset=utf-8');
    }

    const projectStageAutosave=p.match(/^\/projects\/(\d+)\/stages\/(\d+)\/autosave$/);
    if(projectStageAutosave&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectStageAutosave[1]),stageId=Number(projectStageAutosave[2]),field=formText(form,'field');
      if(field!=='description')fail(400,'Nieprawidłowe pole etapu.');
      const value=String(form.value||'').trim().slice(0,300);
      let updatedAt=now();
      transaction(()=>{
        const pr=project(pid);if(pr.archived_at)fail(409,'Nie można zmieniać zarchiwizowanej próby.');
        const stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
        if(!stage)fail(404,'Nie znaleziono etapu.');
        const before=String(stage[field]||'');
        if(before===value){updatedAt=stage.updated_at||pr.updated_at;return;}
        updatedAt=now();
        db.prepare('UPDATE project_stages SET description=?,stage_date=?,updated_at=? WHERE id=?').run(value,todayWarsaw(),updatedAt,stageId);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(updatedAt,pid);
        auditProjectChange(req.user,pid,'Zapisano opis etapu',JSON.stringify({trial:pr.trial_number,stage:stage.stage_no,field,before,after:value,author:req.user.name,at:updatedAt}));
      });
      return send(req,res,200,JSON.stringify({ok:true,updatedAt}),'application/json; charset=utf-8');
    }

    const projectStageCommentDelete=p.match(/^\/projects\/(\d+)\/stages\/(\d+)\/comments\/(\d+)\/delete$/);
    if(projectStageCommentDelete&&req.method==='GET') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectStageCommentDelete[1]),stageId=Number(projectStageCommentDelete[2]),commentId=Number(projectStageCommentDelete[3]),pr=project(pid);
      if(pr.archived_at)fail(409,'Nie można usuwać komentarzy z zarchiwizowanej próby.');
      const stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
      if(!stage)fail(404,'Nie znaleziono etapu.');
      const comment=db.prepare('SELECT * FROM project_stage_comments WHERE id=? AND stage_id=?').get(commentId,stageId);
      if(!comment)fail(404,'Nie znaleziono komentarza etapu.');
      return send(req,res,200,V.confirmDeleteStageCommentPage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),p:pr,stage,comment}));
    }
    if(projectStageCommentDelete&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectStageCommentDelete[1]),stageId=Number(projectStageCommentDelete[2]),commentId=Number(projectStageCommentDelete[3]);
      transaction(()=>{
        const pr=project(pid);if(pr.archived_at)fail(409,'Nie można usuwać komentarzy z zarchiwizowanej próby.');
        const stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
        if(!stage)fail(404,'Nie znaleziono etapu.');
        const comment=db.prepare('SELECT * FROM project_stage_comments WHERE id=? AND stage_id=?').get(commentId,stageId);
        if(!comment)fail(404,'Nie znaleziono komentarza etapu.');
        db.prepare('DELETE FROM project_stage_comments WHERE id=? AND stage_id=?').run(commentId,stageId);
        const stamp=now();db.prepare('UPDATE project_stages SET updated_at=? WHERE id=?').run(stamp,stageId);db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,pid);
        auditProjectChange(req.user,pid,'Usunięto komentarz etapu',JSON.stringify({trial:pr.trial_number,stage:stage.stage_no,comment_id:commentId,author:comment.author_name,content:comment.content,at:stamp}));
      });
      return redirect(req,res,`/projects/${pid}?stage=${stageId}#trial-stage-${stageId}`,'Komentarz etapu został usunięty.');
    }

    const projectStageComment=p.match(/^\/projects\/(\d+)\/stages\/(\d+)\/comments$/);
    if(projectStageComment&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectStageComment[1]),stageId=Number(projectStageComment[2]),content=String(form.content||'').slice(0,3000),commentId=Number(form.comment_id||0);
      let saved;
      transaction(()=>{
        const pr=project(pid);if(pr.archived_at)fail(409,'Nie można dodawać komentarzy do zarchiwizowanej próby.');
        const stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
        if(!stage)fail(404,'Nie znaleziono etapu.');
        let changed=false;
        if(commentId) {
          const existing=db.prepare('SELECT * FROM project_stage_comments WHERE id=? AND stage_id=?').get(commentId,stageId);
          if(!existing||existing.author_user_id!==req.user.id)fail(409,'Nie można edytować tego komentarza. Odśwież stronę i spróbuj ponownie.');
          if(!content.trim()) { saved={...existing}; return; }
          if(existing.content!==content) { db.prepare('UPDATE project_stage_comments SET content=? WHERE id=?').run(content,commentId);saved=db.prepare('SELECT * FROM project_stage_comments WHERE id=?').get(commentId);changed=true; }
          else saved=existing;
        } else {
          if(!content.trim()) { saved=null; return; }
          const stamp=now(),result=db.prepare('INSERT INTO project_stage_comments(stage_id,author_user_id,author_name,content,created_at) VALUES(?,?,?,?,?)').run(stageId,req.user.id,req.user.name,content,stamp);
          saved=db.prepare('SELECT * FROM project_stage_comments WHERE id=?').get(Number(result.lastInsertRowid));changed=true;
        }
        if(changed) {
          const stamp=now();db.prepare('UPDATE project_stages SET updated_at=? WHERE id=?').run(stamp,stageId);db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,pid);
          auditProjectChange(req.user,pid,'Zapisano komentarz etapu',JSON.stringify({trial:pr.trial_number,stage:stage.stage_no,comment_id:saved.id,author:req.user.name,content:saved.content,at:stamp}));
        }
      });
      return send(req,res,200,JSON.stringify({ok:true,comment:saved?{id:saved.id,author_name:saved.author_name,content:saved.content,created_at:saved.created_at}:null}),'application/json; charset=utf-8');
    }

    const projectCommentDelete=p.match(/^\/projects\/(\d+)\/comments\/(\d+)\/delete$/);
    if(projectCommentDelete&&req.method==='GET') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectCommentDelete[1]),commentId=Number(projectCommentDelete[2]),pr=project(pid);
      if(pr.archived_at)fail(409,'Nie można usuwać komentarzy z zarchiwizowanej próby.');
      const comment=db.prepare('SELECT * FROM project_comments WHERE id=? AND project_id=?').get(commentId,pid);
      if(!comment)fail(404,'Nie znaleziono komentarza.');
      return send(req,res,200,V.confirmDeleteCommentPage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),p:pr,comment}));
    }
    if(projectCommentDelete&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectCommentDelete[1]),commentId=Number(projectCommentDelete[2]);
      transaction(()=>{
        const pr=project(pid);if(pr.archived_at)fail(409,'Nie można usuwać komentarzy z zarchiwizowanej próby.');
        const comment=db.prepare('SELECT * FROM project_comments WHERE id=? AND project_id=?').get(commentId,pid);
        if(!comment)fail(404,'Nie znaleziono komentarza.');
        db.prepare('DELETE FROM project_comments WHERE id=? AND project_id=?').run(commentId,pid);
        const latest=db.prepare('SELECT content FROM project_comments WHERE project_id=? ORDER BY id DESC LIMIT 1').get(pid)?.content||'';
        const stamp=now();db.prepare('UPDATE projects SET comment=?,updated_at=? WHERE id=?').run(latest,stamp,pid);
        auditProjectChange(req.user,pid,'Usunięto komentarz próby',JSON.stringify({trial:pr.trial_number,comment_id:commentId,author:comment.author_name,content:comment.content,at:stamp}));
      });
      return redirect(req,res,`/projects/${pid}`,'Komentarz został usunięty.');
    }

    const projectComment=p.match(/^\/projects\/(\d+)\/comments$/);
    if(projectComment&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectComment[1]),pr=project(pid),content=String(form.content||'').slice(0,3000),commentId=Number(form.comment_id||0);
      if(pr.archived_at)fail(409,'Nie można dodawać komentarzy do zarchiwizowanej próby.');
      let saved;
      transaction(()=>{
        const current=project(pid);if(current.archived_at)fail(409,'Nie można dodawać komentarzy do zarchiwizowanej próby.');
        if(commentId) {
          const existing=db.prepare('SELECT * FROM project_comments WHERE id=? AND project_id=?').get(commentId,pid);
          if(!existing||existing.author_user_id!==req.user.id)fail(409,'Nie można edytować tego komentarza. Odśwież stronę i spróbuj ponownie.');
          if(!content.trim()) { saved={...existing}; return; }
          if(existing.content!==content) {
            const stamp=now();
            db.prepare('UPDATE project_comments SET content=? WHERE id=?').run(content,commentId);
            db.prepare('UPDATE projects SET comment=?,updated_at=? WHERE id=?').run(content,stamp,pid);
          }
          saved=db.prepare('SELECT * FROM project_comments WHERE id=?').get(commentId);
        } else {
          if(!content.trim()) { saved=null; return; }
          const stamp=now();
          const result=db.prepare('INSERT INTO project_comments(project_id,author_user_id,author_name,content,created_at) VALUES(?,?,?,?,?)').run(pid,req.user.id,req.user.name,content,stamp);
          db.prepare('UPDATE projects SET comment=?,updated_at=? WHERE id=?').run(content,stamp,pid);
          saved=db.prepare('SELECT * FROM project_comments WHERE id=?').get(Number(result.lastInsertRowid));
        }
      });
      return send(req,res,200,JSON.stringify({ok:true,comment:saved?{id:saved.id,author_name:saved.author_name,content:saved.content,created_at:saved.created_at}:null}),'application/json; charset=utf-8');
    }

    const projectAction=p.match(/^\/projects\/(\d+)\/(update|status|stages)$/);
    if(projectAction&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectAction[1]),action=projectAction[2],pr=project(pid);
      if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
      if(action==='update'||action==='status') {
        const shortDescription=action==='status'?pr.short_description:String(form.short_description||pr.short_description||pr.name).trim().slice(0,150);
        const goal=pr.goal||pr.description||'',assumptions=pr.assumptions||'',clientName=action==='status'?pr.client_name:formText(form,'client_name').slice(0,200),comment=pr.comment||'',status=String(form.status||pr.workflow_status||pr.status);
        if(!Object.hasOwn(V.PROJECT_STATUS,status))fail(400,'Nieprawidłowy status próby.');
        transaction(()=>{
          const current=project(pid);if(current.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
          const before={short_description:current.short_description||current.name,client_name:current.client_name||'',goal:current.goal||current.description||'',assumptions:current.assumptions||'',comment:current.comment||'',status:current.workflow_status||current.status};
          const after={short_description:shortDescription,client_name:action==='status'?(current.client_name||''):clientName,goal,assumptions,comment,status:action==='status'?status:before.status};
          if(action==='status') {
            const legacyStatus=['accepted','failed','client_declined'].includes(status)?status:'in_progress';
            db.prepare('UPDATE projects SET workflow_status=?,status=?,updated_at=? WHERE id=?').run(status,legacyStatus,now(),pid);
          } else db.prepare('UPDATE projects SET name=?,short_description=?,client_name=?,updated_at=? WHERE id=?').run(`${current.trial_number} · ${shortDescription}`,shortDescription,clientName,now(),pid);
          auditProjectChange(req.user,pid,action==='status'?'Zmieniono status próby':'Zmieniono opis próby',JSON.stringify({trial:current.trial_number,before,after}));
        });
        return redirect(req,res,`/projects/${pid}`,'Zapisano zmiany próby.');
      }
      const description=formText(form,'description').slice(0,300),stageDate=todayWarsaw();
      const stageNumber=transaction(()=>{
        const current=project(pid);if(current.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
        const stamp=now();
        const number=db.prepare('SELECT coalesce(max(stage_no),0)+1 n FROM project_stages WHERE project_id=?').get(pid).n;
        db.prepare('INSERT INTO project_stages(project_id,stage_no,description,stage_date,updated_at) VALUES(?,?,?,?,?)').run(pid,number,description,stageDate,stamp);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,pid);
        auditProjectChange(req.user,pid,'Dodano etap próby',JSON.stringify({stage:number,description,date:stageDate}));
        return number;
      });
      return redirect(req,res,`/projects/${pid}`,`Dodano etap ${stageNumber}.`);
    }

    const stageDelete=p.match(/^\/projects\/(\d+)\/stages\/(\d+)\/delete$/);
    if(stageDelete&&req.method==='GET') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(stageDelete[1]),stageId=Number(stageDelete[2]),pr=project(pid);
      if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
      const stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
      if(!stage)fail(404,'Nie znaleziono etapu.');
      const articles=db.prepare('SELECT a.symbol FROM project_stage_articles sa JOIN articles a ON a.id=sa.article_id WHERE sa.stage_id=? ORDER BY a.symbol_key,a.id').all(stageId);
      return send(req,res,200,V.confirmDeleteStagePage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),p:pr,stage,articles}));
    }
    if(stageDelete&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(stageDelete[1]),stageId=Number(stageDelete[2]);
      transaction(()=>{
        const pr=project(pid);if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
        const stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
        if(!stage)fail(404,'Nie znaleziono etapu.');
        const articles=db.prepare('SELECT a.symbol FROM project_stage_articles sa JOIN articles a ON a.id=sa.article_id WHERE sa.stage_id=? ORDER BY a.symbol_key,a.id').all(stageId).map(row=>row.symbol);
        db.prepare('DELETE FROM project_stages WHERE id=? AND project_id=?').run(stageId,pid);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(),pid);
        audit(req.user,'Usunięto etap próby',null,JSON.stringify({trial:pr.trial_number,stage:stage.stage_no,description:stage.description,articles}));
      });
      return redirect(req,res,`/projects/${pid}`,'Etap próby został usunięty. Powiązane artykuły i wydane karty pozostały zachowane.');
    }

    const stageArticleLink=p.match(/^\/projects\/(\d+)\/stages\/(\d+)\/articles$/);
    if(stageArticleLink&&req.method==='POST') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(stageArticleLink[1]),stageId=Number(stageArticleLink[2]),pr=project(pid);
      if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
      transaction(()=>{
        const current=project(pid),stage=db.prepare('SELECT * FROM project_stages WHERE id=? AND project_id=?').get(stageId,pid);
        if(current.archived_at)fail(409,'Nie można modyfikować zarchiwizowanej próby.');
        if(!stage)fail(404,'Nie znaleziono etapu.');
        const articleId=Catalog.associate(context,pid,form);
        if(!articleId)fail(400,'Wybierz albo utwórz artykuł do tego etapu.');
        const article=db.prepare('SELECT * FROM articles WHERE id=?').get(articleId);
        if(!article||article.archived_at||article.purged_at)fail(400,'Wybierz aktywny artykuł.');
        if(db.prepare('SELECT 1 FROM project_stage_articles WHERE stage_id=? AND article_id=?').get(stageId,articleId))fail(409,'Ten artykuł jest już przypisany do tego etapu.');
        const stamp=now(),payload=blank();payload.symbol=article.symbol;payload.number=current.trial_number||'';payload.date=todayWarsaw();
        const rid=Number(db.prepare("INSERT INTO records(project_id,article_id,kind,symbol,number,payload,created_at,updated_at,expected_active) VALUES(?,?,'trial',?,?,?,?,?,?)").run(pid,articleId,article.symbol,current.trial_number||'',dump(payload),stamp,stamp,article.active_spec).lastInsertRowid);
        db.prepare('INSERT INTO project_stage_articles(stage_id,article_id,record_id,created_at) VALUES(?,?,?,?)').run(stageId,articleId,rid,stamp);
        db.prepare('UPDATE project_stages SET updated_at=? WHERE id=?').run(stamp,stageId);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,pid);
        audit(req.user,'Dodano artykuł do etapu próby',rid,JSON.stringify({stage:stage.stage_no,article:article.symbol}));
      });
      return redirect(req,res,`/projects/${pid}`,'Dodano artykuł do etapu.');
    }

    const projectArchiveMatch = p.match(/^\/projects\/(\d+)\/(delete|restore)$/);
    if (projectArchiveMatch && req.method === 'GET' && projectArchiveMatch[2] === 'delete') {
      role(req.user,'technologist','approver','admin');
      const pr=project(Number(projectArchiveMatch[1]));
      if(pr.archived_at) fail(409,'Ten projekt/próba jest już w archiwum.');
      return send(req,res,200,V.confirmArchiveProjectPage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),p:pr}));
    }
    if (projectArchiveMatch && req.method === 'POST' && projectArchiveMatch[2] === 'delete') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectArchiveMatch[1]);
      transaction(()=>{const pr=project(pid);if(pr.archived_at)fail(409,'Ten projekt/próba jest już w archiwum.');db.prepare('UPDATE projects SET archived_at=? WHERE id=?').run(now(),pid);audit(req.user,'Przeniesiono projekt/próbę do archiwum',null,`Projekt #${pid}: ${pr.name}`);});
      return redirect(req,res,'/archive','Projekt/próba została przeniesiona do archiwum na 30 dni.');
    }
    if (projectArchiveMatch && req.method === 'POST' && projectArchiveMatch[2] === 'restore') {
      role(req.user,'technologist','approver','admin');
      const pid=Number(projectArchiveMatch[1]);
      transaction(()=>{const pr=project(pid);if(!pr.archived_at)fail(409,'Ten projekt/próba nie jest w archiwum.');if(Date.now()-Date.parse(pr.archived_at)>30*86400000)fail(409,'Minęło 30 dni. Projekt pozostaje dostępny pod historycznym odnośnikiem, ale nie można go już przywrócić z archiwum.');db.prepare('UPDATE projects SET archived_at=NULL WHERE id=?').run(pid);audit(req.user,'Przywrócono projekt/próbę z archiwum',null,`Projekt #${pid}: ${pr.name}`);});
      return redirect(req,res,`/projects/${pid}`,'Projekt/próba została przywrócona.');
    }

    const unlinkProjectArticle=p.match(/^\/projects\/(\d+)\/articles\/(\d+)\/unlink$/);
    if(unlinkProjectArticle && req.method==='GET') {
      role(req.user,'admin','approver','technologist');
      const pid=Number(unlinkProjectArticle[1]),articleId=Number(unlinkProjectArticle[2]),pr=project(pid);
      if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanego projektu/próby.');
      const article=db.prepare('SELECT a.* FROM articles a JOIN project_articles pa ON pa.article_id=a.id WHERE pa.project_id=? AND a.id=?').get(pid,articleId);
      if(!article)fail(404,'Ten artykuł nie jest przypisany do próby.');
      const stageCount=db.prepare('SELECT count(*) n FROM project_stage_articles sa JOIN project_stages s ON s.id=sa.stage_id WHERE s.project_id=? AND sa.article_id=?').get(pid,articleId).n;
      return send(req,res,200,V.confirmRemoveProjectArticlePage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),p:pr,article,stageCount}));
    }
    if(unlinkProjectArticle && req.method==='POST') {
      role(req.user,'admin','approver','technologist');
      const pid=Number(unlinkProjectArticle[1]), articleId=Number(unlinkProjectArticle[2]);
      const pr=project(pid);if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanego projektu/próby.');
      transaction(()=>{
        const article=db.prepare('SELECT a.symbol FROM articles a JOIN project_articles pa ON pa.article_id=a.id WHERE pa.project_id=? AND a.id=?').get(pid,articleId);
        if(!article)fail(404,'Ten artykuł nie jest przypisany do próby.');
        db.prepare('DELETE FROM project_stage_articles WHERE article_id=? AND stage_id IN (SELECT id FROM project_stages WHERE project_id=?)').run(articleId,pid);
        const result=db.prepare('DELETE FROM project_articles WHERE project_id=? AND article_id=?').run(pid,articleId);
        if(!result.changes)fail(404,'To powiązanie artykułu z projektem już nie istnieje.');
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(),pid);
        audit(req.user,'Usunięto artykuł z próby',null,`${article.symbol} · próba ${pr.trial_number}`,articleId);
      });
      return redirect(req,res,`/projects/${pid}`,'Artykuł został usunięty z próby. Pozostał w kartotece.');
    }
    let id = matchId(p, /^\/projects\/(\d+)$/);
    if (id && req.method === 'GET') {
      const pr = project(id);
      const cards = db.prepare('SELECT c.*,u.name author FROM cards c JOIN records r ON r.id=c.record_id JOIN users u ON u.id=c.created_by WHERE r.project_id=? OR (r.project_id IS NULL AND EXISTS(SELECT 1 FROM project_articles pa WHERE pa.project_id=? AND pa.article_id=r.article_id)) ORDER BY c.id DESC').all(id,id);
      const stages=db.prepare('SELECT s.* FROM project_stages s WHERE s.project_id=? ORDER BY s.stage_no').all(id);
      const byStage=new Map(stages.map(stage=>[stage.id,[]]));
      const stageArticles=db.prepare('SELECT sa.stage_id,sa.article_id,sa.record_id,a.symbol,a.active_spec,a.archived_at,a.purged_at,r.payload,r.state,r.archived_at record_archived_at FROM project_stage_articles sa JOIN articles a ON a.id=sa.article_id LEFT JOIN records r ON r.id=sa.record_id JOIN project_stages s ON s.id=sa.stage_id WHERE s.project_id=? ORDER BY s.stage_no,a.symbol_key,a.id').all(id);
      for(const article of stageArticles)byStage.get(article.stage_id)?.push(article);
      for(const stage of stages)stage.articles=byStage.get(stage.id)||[];
      const commentsByStage=new Map(stages.map(stage=>[stage.id,[]]));
      const stageComments=db.prepare('SELECT c.id,c.stage_id,c.author_name,c.content,c.created_at FROM project_stage_comments c JOIN project_stages s ON s.id=c.stage_id WHERE s.project_id=? ORDER BY c.id').all(id);
      for(const comment of stageComments)commentsByStage.get(comment.stage_id)?.push(comment);
      for(const stage of stages)stage.comments=commentsByStage.get(stage.id)||[];
      const linkedArticles=db.prepare('SELECT a.* FROM articles a JOIN project_articles pa ON pa.article_id=a.id WHERE pa.project_id=? ORDER BY a.symbol_key,a.id').all(id);
      const comments=db.prepare('SELECT id,author_name,content,created_at FROM project_comments WHERE project_id=? ORDER BY id').all(id);
      pr.ai_generated_notice=SourceImport.noticeForProject(db,id);
      return send(req, res, 200, V.projectPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), p: pr, cards, stages, linkedArticles, comments, selectedStageId:Number(url.searchParams.get('stage')||0), photoPanel:Photos.panel('project',id,{...req,readOnly:Boolean(pr.archived_at)}), articleInput: Catalog.projectArticleInput(db, { optional: false }) }));
    }
    id = matchId(p, /^\/projects\/(\d+)\/new$/);
    if (id && req.method === 'POST') {
      role(req.user, 'technologist', 'approver', 'admin');
      const pr = project(id), kind = form.kind || 'trial';
      if(pr.archived_at) fail(409,'Nie można dodawać prób ani specyfikacji do zarchiwizowanego projektu/próby.');
      if (!['trial', 'spec'].includes(kind)) fail(400, 'Nieprawidłowy typ wpisu.');
      if (kind === 'trial') fail(409, 'Artykuły do próby dodaje się w wybranym etapie.');
      const v = blank(); v.date = todayWarsaw(); v.number=pr.trial_number||'';
      let newArticleFields=false;
      const rid = transaction(() => {
        const selected = Number(form.article_id);
        let a = selected ? db.prepare('SELECT a.* FROM articles a JOIN project_articles pa ON pa.article_id=a.id WHERE a.id=? AND pa.project_id=?').get(selected,id) : null;
        if(!a||a.archived_at||a.purged_at) fail(400,'Wybierz aktywny artykuł z kartoteki projektu.');
        newArticleFields=kind==='spec'&&!db.prepare('SELECT 1 FROM records WHERE article_id=? AND archived_at IS NULL LIMIT 1').get(a.id);
        v.symbol=a ? a.symbol : pr.name;
        const stamp=now();
        const result = db.prepare('INSERT INTO records(project_id,article_id,kind,symbol,number,payload,created_at,updated_at,expected_active) VALUES(?,?,?,?,?,?,?,?,?)').run(id, a ? a.id : null, kind, v.symbol, v.number, dump(v), stamp, stamp, a ? a.active_spec : null);
        const recordId = Number(result.lastInsertRowid);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,id);
        audit(req.user, 'Utworzono wpis', recordId);
        return recordId;
      });
      return redirect(req, res, `/records/${rid}/edit${newArticleFields?'?new_article=1':''}`);
    }

    id = matchId(p, /^\/records\/(\d+)$/);
    if (id && req.method === 'GET') {
      const r = record(id), history = db.prepare('SELECT a.*,u.name author FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE record_id=? ORDER BY a.id DESC').all(id);
      r.ai_generated_notice=SourceImport.noticeForRecord(db,id);
      return send(req, res, 200, V.recordPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), r, v: parsePayload(r), history, photoPanel: Photos.panel('record',id,{...req,readOnly:Boolean(r.archived_at||r.article_archived_at||r.project_archived_at)}) }));
    }

    const recordArchiveMatch=p.match(/^\/records\/(\d+)\/(delete|restore)$/);
    if(recordArchiveMatch&&req.method==='GET'&&recordArchiveMatch[2]==='delete') {
      role(req.user,'technologist','approver','admin');const r=record(Number(recordArchiveMatch[1]));
      if(r.archived_at)fail(409,'Ten wpis jest już w archiwum.');
      if(r.state!=='draft'||!['trial','spec'].includes(r.kind))fail(409,'Można archiwizować wyłącznie robocze specyfikacje i próby.');
      return send(req,res,200,V.confirmArchiveRecordPage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),r}));
    }
    if(recordArchiveMatch&&req.method==='POST'&&recordArchiveMatch[2]==='delete') {
      role(req.user,'technologist','approver','admin');const rid=Number(recordArchiveMatch[1]);
      transaction(()=>{const r=record(rid);if(r.archived_at)fail(409,'Ten wpis jest już w archiwum.');if(r.state!=='draft'||!['trial','spec'].includes(r.kind))fail(409,'Można archiwizować wyłącznie robocze specyfikacje i próby.');db.prepare('UPDATE records SET archived_at=? WHERE id=?').run(now(),rid);audit(req.user,'Przeniesiono roboczy wpis do archiwum',rid,`${r.kind==='trial'?'Próba':'Specyfikacja'} ${r.symbol}`);});
      return redirect(req,res,'/archive','Roboczy wpis został przeniesiony do archiwum na 30 dni.');
    }
    if(recordArchiveMatch&&req.method==='POST'&&recordArchiveMatch[2]==='restore') {
      role(req.user,'technologist','approver','admin');const rid=Number(recordArchiveMatch[1]);
      transaction(()=>{const r=record(rid);if(!r.archived_at)fail(409,'Ten wpis nie jest w archiwum.');if(Date.now()-Date.parse(r.archived_at)>30*86400000)fail(409,'Minęło 30 dni. Wpis pozostaje zachowany, ale nie można go już przywrócić z archiwum.');if(r.state!=='draft'||!['trial','spec'].includes(r.kind))fail(409,'Tego wpisu nie można przywrócić jako roboczego.');db.prepare('UPDATE records SET archived_at=NULL WHERE id=?').run(rid);audit(req.user,'Przywrócono roboczy wpis z archiwum',rid,`${r.kind==='trial'?'Próba':'Specyfikacja'} ${r.symbol}`);});
      return redirect(req,res,`/records/${rid}`,'Roboczy wpis został przywrócony.');
    }

    id = matchId(p, /^\/records\/(\d+)\/edit$/);
    if (id && (req.method === 'GET' || req.method === 'POST')) {
      role(req.user, 'technologist', 'approver', 'admin');
      let r = record(id);
      if(r.archived_at)fail(409,'Zarchiwizowany wpis jest tylko do odczytu. Przywróć go w zakładce Archiwum, aby edytować.');
      if(r.article_archived_at)fail(409,'Artykuł jest zarchiwizowany. Najpierw przywróć go z archiwum.');
      if(r.project_archived_at)fail(409,'Projekt/próba jest zarchiwizowany. Przywróć go w zakładce Archiwum, aby edytować etap.');
      if (r.state !== 'draft') fail(409, 'Ta wersja jest zablokowana. Utwórz nową wersję albo wycofaj wniosek o zatwierdzenie.');
      if (req.method === 'POST') {
        // Keep a copy of a valid form before BEGIN IMMEDIATE. If SQLite cannot
        // acquire a write lock, render the editor again with the user's work.
        try {
          const old = parsePayload(r), values = parseForm(form, old);
          values.date = old.date || values.date;
          values.number = r.project_trial_number || '';
          recovery = { kind: 'record-edit', record: r, values };
        } catch {
          // The normal transaction path below returns the actual validation
          // message. Recovery is only for an otherwise valid submitted form.
        }
        transaction(() => {
          r = record(id); stale(r, form);
          if (r.state !== 'draft') fail(409, 'Wpis jest już zablokowany.');
          const old = parsePayload(r), v = parseForm(form, old), changeComment=formText(form,'change_comment').slice(0,1000);
          v.date = old.date || v.date;
          v.number = r.project_trial_number || '';
          recovery = { kind: 'record-edit', record: r, values: v };
          let a = r.article_id ? db.prepare('SELECT * FROM articles WHERE id=?').get(r.article_id) : null;
          if (a && a.symbol !== v.symbol) fail(400,'Symbol powiązanego artykułu pozostaje stały. Dla innego artykułu utwórz osobny wpis.');
          if (!a && r.kind === 'spec') a = makeArticle(r.project_id,v.symbol);
          const expected = a && a.id !== r.article_id ? a.active_spec : r.expected_active;
          db.prepare('UPDATE records SET symbol=?,number=?,payload=?,article_id=?,expected_active=?,updated_at=?,revision=revision+1 WHERE id=?').run(v.symbol, v.number, dump(v), a ? a.id : null, expected, now(), id);
          if(a)db.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(new Date().toISOString(),a.id);
          if(r.project_id){const stamp=now();db.prepare('UPDATE project_stages SET updated_at=? WHERE record_id=? OR id IN (SELECT stage_id FROM project_stage_articles WHERE record_id=?)').run(stamp,id,id);db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,r.project_id);}
          audit(req.user, 'Zapisano zmiany', id, dump({ before: old, after: v, comment: changeComment }));
        });
        return redirect(req, res, `/records/${id}`, 'Zapisano zmiany.');
      }
      return send(req, res, 200, V.editPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), r, v: parsePayload(r), newArticleFields:url.searchParams.get('new_article')==='1' }));
    }

    id = matchId(p, /^\/records\/(\d+)\/copy$/);
    if (id && req.method === 'POST') {
      role(req.user, 'technologist', 'approver', 'admin');
      const next = transaction(() => {
        const r = record(id), v = parsePayload(r), kind = form.kind || 'trial';
        if(r.archived_at)fail(409,'Nie można tworzyć wpisów na podstawie zarchiwizowanej próby lub specyfikacji.');
        if(r.project_archived_at||r.article_archived_at)fail(409,'Nie można tworzyć wpisów z zarchiwizowanego projektu lub artykułu.');
        if (!['trial', 'spec'].includes(kind)) fail(400, 'Nieprawidłowy typ wpisu.');
        if (kind === 'trial') fail(409, 'Nowy artykuł do próby dodaj w wybranym etapie z zakładki Projekty / próby.');
        const a = r.article_id ? db.prepare('SELECT * FROM articles WHERE id=?').get(r.article_id) : kind === 'spec' ? makeArticle(r.project_id, r.symbol) : null;
        const result = db.prepare('INSERT INTO records(project_id,article_id,kind,symbol,number,base_id,expected_active,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.project_id, a ? a.id : null, kind, r.symbol, v.number || '', id, a ? a.active_spec : null, dump(v), now(), now());
        const newId = Number(result.lastInsertRowid);
        audit(req.user, `Utworzono ${kind === 'trial' ? 'wariant próby' : 'roboczą specyfikację'}`, newId, `Na podstawie wpisu ${id}`);
        return newId;
      });
      return redirect(req, res, `/records/${next}/edit`);
    }

    id = matchId(p, /^\/records\/(\d+)\/(submit|withdraw|approve)$/);
    const action = p.match(/^\/records\/(\d+)\/(submit|withdraw|approve)$/);
    if (id && req.method === 'POST' && action) {
      const operation = action[2];
      if (operation === 'approve') role(req.user, 'approver', 'admin');
      else role(req.user, 'technologist', 'approver', 'admin');
      let approvedVersion = null;
      transaction(() => {
        const r = record(id); stale(r, form);
        if(r.article_archived_at)fail(409,'Artykuł jest zarchiwizowany. Przywróć go przed zmianą statusu specyfikacji.');
        if(r.project_archived_at)fail(409,'Projekt/próba jest zarchiwizowany. Przywróć go przed zmianą statusu specyfikacji.');
        if (operation === 'submit') {
          if (r.kind !== 'spec' || r.state !== 'draft') fail(409, 'Nie można przekazać tego wpisu do zatwierdzenia.');
          validateReady(r);
          db.prepare("UPDATE records SET state='submitted',revision=revision+1,updated_at=? WHERE id=?").run(now(), id);
          audit(req.user, 'Przekazano do zatwierdzenia', id);
        } else if (operation === 'withdraw') {
          if (r.state !== 'submitted') fail(409, 'Wpis nie oczekuje na zatwierdzenie.');
          db.prepare("UPDATE records SET state='draft',revision=revision+1,updated_at=? WHERE id=?").run(now(), id);
          audit(req.user, 'Wycofano do poprawy', id);
        } else {
          const note = formText(form, 'review_note');
          if (r.kind !== 'spec' || r.state !== 'submitted') fail(409, 'Nie można zatwierdzić tego wpisu.');
          validateReady(r);
          if (!form.checked) fail(400, 'Potwierdź, że sprawdzono dane i rozbieżności.');
          if (r.active_spec !== r.expected_active) fail(409, 'W międzyczasie zatwierdzono inną specyfikację. Utwórz nową wersję na podstawie aktualnej i porównaj zmiany.');
          const base=r.expected_active?db.prepare("SELECT * FROM records WHERE id=? AND article_id=? AND state='approved'").get(r.expected_active,r.article_id):null;
          const beforePayload=base?parsePayload(base):null,afterPayload=parsePayload(r);
          const difference=beforePayload?Changes.changes(beforePayload,afterPayload):[];
          const lastEdit=db.prepare("SELECT detail,user_id,at FROM audit WHERE record_id=? AND action='Zapisano zmiany' ORDER BY id DESC LIMIT 1").get(id);
          let changeComment='';try{changeComment=JSON.parse(lastEdit?.detail||'{}').comment||''}catch{}
          approvedVersion = db.prepare('SELECT coalesce(max(version),0)+1 version FROM records WHERE article_id=?').get(r.article_id).version;
          db.prepare("UPDATE records SET state='approved',version=?,approved_at=?,approved_by=?,review_note=?,updated_at=?,revision=revision+1 WHERE id=?").run(approvedVersion, now(), req.user.id, note, now(), id);
          db.prepare('UPDATE articles SET active_spec=? WHERE id=?').run(id, r.article_id);
          audit(req.user, 'Zatwierdzono specyfikację', id, note);
          if(difference.length) audit(req.user,'Zatwierdzono zmianę karty',id,JSON.stringify({before:beforePayload,after:afterPayload,comment:changeComment,version:approvedVersion,author_id:lastEdit?.user_id||null,edited_at:lastEdit?.at||null}),r.article_id);
        }
      });
      return redirect(req, res, `/records/${id}`, approvedVersion ? `Zatwierdzono wersję ${approvedVersion}.` : '');
    }

    id = matchId(p, /^\/records\/(\d+)\/preview$/);
    if (id && req.method === 'GET') {
      const r = record(id), v = parsePayload(r);
      const html = V.cardPage({ r, v, machine: '—', instructions: 'Podgląd danych. Karta niewydana.', cardno: null, issuedAt: now(), author: req.user.name, logo: fs.readFileSync(path.join(ROOT, 'static', 'logo.jpg')).toString('base64'), printcss: fs.readFileSync(path.join(ROOT, 'static', 'card.css'), 'utf8') });
      return send(req, res, 200, html);
    }

    id = matchId(p, /^\/records\/(\d+)\/issue$/);
    if (id && (req.method === 'GET' || req.method === 'POST')) {
      role(req.user, 'technologist', 'approver', 'admin');
      let r = record(id);
      if (req.method === 'GET') {
        if(r.project_archived_at)fail(409,'Projekt/próba jest zarchiwizowany. Przywróć go, aby wydać kartę.');
        if(r.article_archived_at)fail(409,'Artykuł jest zarchiwizowany. Przywróć go, aby wydać kartę.');
        if (r.state !== 'approved' || r.active_spec !== id) fail(409, 'Najpierw zatwierdź aktualną specyfikację.');
        const contextProjectRaw=url.searchParams.get('project')||'',contextStageRaw=url.searchParams.get('stage')||'';
        if(Boolean(contextProjectRaw)!==Boolean(contextStageRaw))fail(400,'Niepełne powiązanie próby z wydawaną kartą.');
        const contextProjectId=contextProjectRaw?Number(contextProjectRaw):0,contextStageId=contextStageRaw?Number(contextStageRaw):0;
        stageIssueContext(contextProjectId,contextStageId,r.article_id);
        return send(req, res, 200, V.issuePage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), r, token: crypto.randomBytes(24).toString('base64url'), productionNotes:pendingProductionNotes(r), projectId:contextProjectRaw?contextProjectId:'', stageId:contextStageRaw?contextStageId:'' }));
      }
      const token = formText(form, 'token'), machine = formText(form, 'machine'), instructions = formText(form, 'instructions');
      let productionNotes=pendingProductionNotes(r);
      const contextProjectRaw=formText(form,'trial_project_id'),contextStageRaw=formText(form,'trial_stage_id');
      if(Boolean(contextProjectRaw)!==Boolean(contextStageRaw))fail(400,'Niepełne powiązanie próby z wydawaną kartą.');
      const contextProjectId=contextProjectRaw?Number(contextProjectRaw):0,contextStageId=contextStageRaw?Number(contextStageRaw):0;
      const issueStage=stageIssueContext(contextProjectId,contextStageId,r.article_id);
      if (!machine || token.length < 20) fail(400, 'Podaj maszynę, na którą ma zostać wydana karta.');
      if (machine.length > 100 || instructions.length > 6000 || productionNotes.length > 6000) fail(400, 'Skróć nazwę maszyny, polecenia lub specjalne informacje do produkcji.');
      if(r.project_archived_at)fail(409,'Projekt/próba jest zarchiwizowany. Przywróć go, aby wydać kartę.');
      if(r.article_archived_at)fail(409,'Artykuł jest zarchiwizowany. Przywróć go, aby wydać kartę.');
      if (r.state !== 'approved' || r.active_spec !== id) fail(409, 'Można wydać wyłącznie aktualną zatwierdzoną wersję. Otwórz aktualną kartę artykułu.');
      if(form.cancel_confirmation)return send(req,res,200,V.issuePage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),r,token,machine,instructions,productionNotes,projectId:contextProjectRaw?contextProjectId:'',stageId:contextStageRaw?contextStageId:''}));
      const changeNotice=Changes.notice(db,r,parsePayload(r));
      if(changeNotice&&!form.confirm_changes) {
        return send(req,res,200,V.issueConfirmPage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),r,token,machine,instructions,productionNotes,projectId:contextProjectRaw?contextProjectId:'',stageId:contextStageRaw?contextStageId:'',changeNotice}));
      }
      const cardId = transaction(() => {
        const old = db.prepare('SELECT id,record_id,created_by FROM cards WHERE token=?').get(token);
        if (old) {
          if (old.record_id !== id || old.created_by !== req.user.id) fail(409, 'Ten identyfikator karty został już wykorzystany.');
          return old.id;
        }
        r = record(id);
        if(r.project_archived_at)fail(409,'Projekt/próba jest zarchiwizowany. Przywróć go, aby wydać kartę.');
        if(r.article_archived_at)fail(409,'Artykuł jest zarchiwizowany. Przywróć go, aby wydać kartę.');
        if (r.state !== 'approved' || r.active_spec !== id) fail(409, 'Można wydać wyłącznie aktualną zatwierdzoną wersję. Otwórz aktualną kartę artykułu.');
        productionNotes=pendingProductionNotes(r);
        const v = parsePayload(r), stamp = now();
        const cardno = `K-${stamp.slice(0, 10)}-${token.slice(0, 8)}`;
        const html = V.cardPage({ r, v, machine, instructions, productionNotes, cardno, issuedAt: stamp, author: req.user.name, logo: fs.readFileSync(path.join(ROOT, 'static', 'logo.jpg')).toString('base64'), printcss: fs.readFileSync(path.join(ROOT, 'static', 'card.css'), 'utf8') });
        const result = db.prepare('INSERT INTO cards(record_id,machine,instructions,created_at,created_by,token,snapshot,html,production_notes) VALUES(?,?,?,?,?,?,?,?,?)').run(id, machine, instructions, stamp, req.user.id, token, dump({ record: r, data: v, author: req.user.name, production_notes:productionNotes }), html, productionNotes);
        const newId = Number(result.lastInsertRowid);
        if(productionNotes)db.prepare("UPDATE articles SET pending_production_notes='',updated_at=? WHERE id=?").run(stamp,r.article_id);
        audit(req.user, 'Wydano kartę na maszynę', id, `Karta ${newId} / ${machine} / ${instructions}${productionNotes?` / ${productionNotes}`:''}`);
        if(issueStage) {
          const currentStage=stageIssueContext(contextProjectId,contextStageId,r.article_id);
          setProjectStatus(contextProjectId,'to_knitter',stamp);
          auditProjectChange(req.user,contextProjectId,'Zlecono na dziewiarnię',JSON.stringify({stage:currentStage.stage_no,article:r.symbol,card:newId,machine}));
        }
        return newId;
      });
      return redirect(req, res, `/cards/${cardId}`);
    }

    id = matchId(p, /^\/cards\/(\d+)$/);
    if (id && req.method === 'GET') {
      const card = db.prepare('SELECT c.html,r.article_id,r.id record_id,a.active_spec FROM cards c JOIN records r ON r.id=c.record_id LEFT JOIN articles a ON a.id=r.article_id WHERE c.id=?').get(id);
      if (!card) fail(404, 'Nie znaleziono karty.');
      const obsolete = card.active_spec && card.active_spec !== card.record_id;
      const banner = obsolete ? '<section class="obsolete-card-alert" data-update-alert><h2>Uwaga — historyczna karta. Artykuł ma nowszą zatwierdzoną technologię.</h2><a href="/records/'+card.active_spec+'">Otwórz obowiązującą technologię</a></section>' : '';
      return send(req,res,200,card.html.replace('<body>','<body>'+banner));
    }

    const sourceMatch = p.match(/^\/sources\/([^/]+)$/);
    if (sourceMatch && req.method === 'GET') {
      const name = sourceMatch[1];
      if (name.includes('..') || name.includes('\\')) fail(404, 'Nie znaleziono pliku.');
      const file = path.resolve(ROOT, 'seed', 'sources', name);
      if (!file.startsWith(path.resolve(ROOT, 'seed', 'sources') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(404, 'Nie znaleziono pliku.');
      const basename = path.basename(file).replace(/[\r\n"\\]/g, '_');
      return send(req, res, 200, fs.readFileSync(file), 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${basename}"` });
    }

    if (p === '/admin/update' && req.method === 'GET') {
      role(req.user, 'admin');
      const repo = process.env.MARAND_GITHUB_REPO || DEFAULT_GITHUB_REPO;
      let latest = null, updateError = '';
      try { if (repo) latest = await githubLatest(repo); }
      catch (err) { updateError = err.message; }
      const updater = process.env.MARAND_UPDATER || '';
      const rel = updater ? path.relative(ROOT, path.resolve(updater)) : '';
      const outside = Boolean(updater && rel !== '' && (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)));
      const updateConfig = process.env.MARAND_UPDATE_CONFIG || (updater ? path.join(path.dirname(path.resolve(updater)), 'konfiguracja.json') : '');
      const updateStatus = readJsonIfExists(path.join(DATA, 'update_status.json'));
      const updateAvailable = Boolean(latest && isNewer(String(latest.tag_name || '').replace(/^v/, ''), versionInfo.version));
      return send(req, res, 200, V.updatePage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), current: versionInfo.version, latest, status: updateStatus, repo, canUpdate: Boolean(repo && outside && fs.existsSync(updater) && fs.existsSync(updateConfig)), updateAvailable, updateError }));
    }
    if (p === '/admin/update' && req.method === 'POST') {
      role(req.user, 'admin');
      const started = await startGithubUpdate(req);
      return redirect(req, res, '/admin/update', `Aktualizacja do wersji ${started.version} została przekazana do instalatora. Strona może być niedostępna przez chwilę.`);
    }

    if (p === '/admin/import' && req.method === 'GET') {
      role(req.user, 'admin');
      let latestImport = SourceImport.latestImportRun(db);
      if (latestImport) {
        try {
          const target = sourceImportRestoreTarget(latestImport.package_hash);
          latestImport = { ...latestImport, restore_ready: true, backup_name: target.backupName };
        } catch (error) {
          latestImport = { ...latestImport, restore_ready: false, restore_error: error.message };
        }
      }
      return send(req, res, 200, V.sourceImportPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), latestImport, restoreStatus: readJsonIfExists(path.join(DATA, 'import_restore_status.json')) }));
    }
    if (p === '/admin/import/restore' && req.method === 'GET') {
      role(req.user, 'admin');
      let target;
      try { target = sourceImportRestoreTarget(String(url.searchParams.get('package_hash') || '')); }
      catch (error) { fail(error instanceof HttpError ? error.status : 409, error.message || 'Nie można sprawdzić kopii sprzed importu.'); }
      return send(req, res, 200, V.confirmRestoreImportPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), run: target.run, backupName: target.backupName }));
    }
    if (p === '/admin/import/restore/apply' && req.method === 'POST') {
      role(req.user, 'admin');
      if (form.confirm !== 'PRZYWRÓĆ') fail(400, 'Zaznacz potwierdzenie przywrócenia bazy.');
      let target;
      const packageHash = String(form.package_hash || '');
      try { target = sourceImportRestoreTarget(packageHash); }
      catch (error) { fail(error instanceof HttpError ? error.status : 409, error.message || 'Nie można sprawdzić kopii sprzed importu.'); }
      const maintenancePath = path.join(DATA, 'maintenance.json');
      try {
        fs.writeFileSync(maintenancePath, JSON.stringify({ operation: 'source-import-restore', pid: process.pid, package_hash: packageHash, backup_path: target.backupPath, started_at: now() }), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') fail(503, 'Trwa inna operacja administracyjna. Poczekaj i spróbuj ponownie.');
        throw error;
      }
      const launch = () => {
        try {
          const child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', target.helper,
            '-ConfigPath', target.configPath, '-BackupPath', target.backupPath, '-PackageHash', packageHash,
          ], {
            cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore',
            env: { ...process.env, MARAND_DATA: DATA, MARAND_DATABASE: DB_PATH, MARAND_UPDATE_CONFIG: target.configPath },
          });
          child.once('error', error => {
            try { fs.rmSync(maintenancePath, { force: true }); } catch {}
            try { writeSourceImportRestoreStatus({ ok: false, at: now(), package_hash: packageHash, rollback_name: '', error: `Nie udało się uruchomić skryptu przywracania: ${error.message}` }); } catch {}
            console.error('Nie udało się uruchomić przywracania importu:', error);
          });
          child.unref();
        } catch (error) {
          try { fs.rmSync(maintenancePath, { force: true }); } catch {}
          try { writeSourceImportRestoreStatus({ ok: false, at: now(), package_hash: packageHash, rollback_name: '', error: `Nie udało się uruchomić skryptu przywracania: ${error.message}` }); } catch {}
          console.error('Nie udało się uruchomić przywracania importu:', error);
        }
      };
      const launchTimer = setTimeout(launch, 1200);
      launchTimer.unref();
      return redirect(req, res, '/admin/import', 'Rozpoczęto przywracanie. Program uruchomi się ponownie; odśwież stronę za chwilę.');
    }
    if (p === '/admin/import/apply' && req.method === 'POST') {
      role(req.user, 'admin');
      if (form.confirm !== 'IMPORTUJ') fail(400, 'Zaznacz potwierdzenie przed importem.');
      const token = String(form.token || '');
      const pending = pendingSourceImports.get(token);
      if (!/^[a-f0-9]{64}$/.test(token) || !pending || pending.userId !== req.user.id || pending.expiresAt <= Date.now()) {
        discardPendingSourceImport(token);
        fail(410, 'Podgląd importu wygasł. Wybierz plik ponownie i odśwież podgląd.');
      }
      const pkg = SourceImport.readPackageBuffer(pending.bytes, 'plik przesłany przez administratora');
      if (pkg.digest !== pending.digest) fail(409, 'Plik importu zmienił się po sprawdzeniu. Wybierz go ponownie.');
      const report = SourceImport.preview(db, pkg);
      if (report.conflicts.length) fail(409, 'Baza zmieniła się od czasu podglądu lub paczka ma konflikty. Odśwież podgląd przed importem.');

      const maintenancePath = path.join(DATA, 'maintenance.json');
      let maintenanceOwned = false;
      try {
        fs.writeFileSync(maintenancePath, JSON.stringify({ operation: 'source-import', pid: process.pid, started_at: now() }), { flag: 'wx', mode: 0o600 });
        maintenanceOwned = true;
      } catch (error) {
        if (error.code === 'EEXIST') fail(503, 'Trwa inna operacja administracyjna. Poczekaj i spróbuj ponownie.');
        throw error;
      }
      try {
        let backupPath;
        try {
          backupPath = await createSourceImportBackup();
        } catch (error) {
          fail(503, error.message || 'Nie udało się utworzyć kopii zapasowej. Baza nie została zmieniona.');
        }
        let result;
        try {
          result = SourceImport.importData(db, pkg, backupPath);
        } catch (error) {
          console.error('Import danych źródłowych nie został zapisany:', error);
          fail(409, 'Import został przerwany, a zmiany w bazie wycofano. ' + String(error.message || 'Sprawdź log serwera.'));
        }
        discardPendingSourceImport(token);
        fs.rmSync(path.join(DATA, 'import_restore_status.json'), { force: true });
        return redirect(req, res, '/admin/import', `Import zakończony: ${result.imported.articles} artykułów, ${result.imported.specifications} roboczych specyfikacji i ${result.imported.projects} prób. Kopia bazy: ${backupPath}.`);
      } finally {
        if (maintenanceOwned) fs.rmSync(maintenancePath, { force: true });
      }
    }

    fail(404, 'Nie znaleziono strony.');
  } catch (err) {
    if (res.writableEnded) {
      console.error('Request failed after its response was sent:', err && err.stack || err);
      return;
    }
    if (res.headersSent) {
      console.error('Request failed after response headers were sent:', err && err.stack || err);
      res.destroy();
      return;
    }
    if (err instanceof HttpError) return send(req, res, err.status, V.errorPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), error: err.message }));
    if (err && (String(err.code || '').startsWith('SQLITE_') || err.code === 'ERR_SQLITE_ERROR')) {
      const reference = crypto.randomBytes(4).toString('hex').toUpperCase();
      const sqliteCode = Number.isInteger(err.errcode) ? err.errcode & 0xff : null;
      const busy = sqliteCode === 5 || sqliteCode === 6 || err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED';
      const readOnly = sqliteCode === 8 || err.errstr === 'attempt to write a readonly database';
      const diskFull = sqliteCode === 13;
      const constraint = sqliteCode === 19;
      const hasRecovery = recovery?.kind === 'record-edit' && recovery.record && recovery.values;
      console.error(`Database operation failed [${reference}]:`, err.code || 'UNKNOWN', `sqlite=${err.errcode ?? '?'}`, err.errstr || '', err.stack || err.message);

      let status = 500;
      let message = `Nie udało się wykonać operacji (kod ${reference}). Administrator powinien sprawdzić najnowszy plik server-*.err.log w folderze administracja\\logs.`;
      if (busy) {
        status = 503;
        message = hasRecovery
          ? `Baza danych jest chwilowo zajęta (kod ${reference}). Twoje dane pozostają w formularzu. Odczekaj chwilę i kliknij „Zapisz zmiany” ponownie.`
          : `Baza danych jest chwilowo zajęta (kod ${reference}). Odczekaj chwilę i spróbuj ponownie. Administrator powinien sprawdzić najnowszy plik server-*.err.log w folderze administracja\\logs.`;
      } else if (readOnly) {
        status = 503;
        message = hasRecovery
          ? `Serwer nie ma prawa zapisu do bazy danych (kod ${reference}). Twoje dane pozostają w formularzu. Administrator musi naprawić uprawnienia folderu danych przed ponownym zapisem.`
          : `Serwer nie ma prawa zapisu do bazy danych (kod ${reference}). Administrator musi naprawić uprawnienia folderu danych.`;
      } else if (diskFull) {
        status = 507;
        message = hasRecovery
          ? `Na serwerze brakuje miejsca na zapis (kod ${reference}). Twoje dane pozostają w formularzu. Zwolnij miejsce i spróbuj ponownie.`
          : `Na serwerze brakuje miejsca na zapis (kod ${reference}). Zwolnij miejsce i spróbuj ponownie.`;
      } else if (constraint) {
        status = 409;
        message = hasRecovery
          ? `Baza odrzuciła zapis z powodu konfliktu danych (kod ${reference}). Twoje dane pozostają w formularzu. Administrator powinien sprawdzić server-*.err.log w folderze administracja\\logs.`
          : `Baza odrzuciła operację z powodu konfliktu danych (kod ${reference}). Administrator powinien sprawdzić server-*.err.log w folderze administracja\\logs.`;
      }

      if (hasRecovery) {
        return send(req, res, status, V.editPage({
          user: req.user,
          csrf: req.session.csrf,
          flashes: [...getFlashes(req), { category: 'error', message }],
          r: recovery.record,
          v: recovery.values,
        }));
      }
      return send(req, res, status, V.errorPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), error: message }));
    }
    console.error(err && err.stack || err);
    return send(req, res, 500, V.errorPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), error: 'Wystąpił błąd programu. Skontaktuj się z administratorem.' }));
  }
}

function verifyPassword(password, stored) {
  try {
    const [method, salt, expected] = String(stored).split('$');
    if (!salt || !/^[a-f\d]+$/i.test(expected)) return false;
    let actual;
    const pbkdf = method.match(/^pbkdf2:sha256:(\d+)$/);
    const scrypt = method.match(/^scrypt:(\d+):(\d+):(\d+)$/);
    if (pbkdf) actual = crypto.pbkdf2Sync(String(password), salt, Number(pbkdf[1]), expected.length / 2, 'sha256').toString('hex');
    else if (scrypt) actual = crypto.scryptSync(String(password), salt, expected.length / 2, { N: Number(scrypt[1]), r: Number(scrypt[2]), p: Number(scrypt[3]), maxmem: 64 * 1024 * 1024 }).toString('hex');
    else return false;
    const a = Buffer.from(actual, 'hex'), b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

const server = http.createServer((req, res) => { handle(req, res).catch(err => { console.error(err); if (!res.headersSent) { res.statusCode = 500; res.end('Błąd serwera.'); } }); });
server.requestTimeout = 30000;
server.headersTimeout = 35000;
const archiveCleanupTimer = setInterval(purgeExpiredArchive, 60 * 60 * 1000);
archiveCleanupTimer.unref();
server.listen(PORT, HOST, () => console.log(`Marand Node.js ${versionInfo.version}: http://${HOST}:${PORT}`));
function shutdown() { clearInterval(archiveCleanupTimer); server.close(() => { try { db.close(); } finally { process.exit(0); } }); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

