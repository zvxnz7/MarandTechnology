'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const V = require('./views');

const ROOT = __dirname;
const DATA = path.resolve(process.env.MARAND_DATA || path.join(ROOT, 'data'));
const DB_PATH = path.resolve(process.env.MARAND_DATABASE || path.join(DATA, 'marand.sqlite3'));
const VERSION_PATH = path.join(ROOT, 'release.json');
const SECRET_PATH = path.join(DATA, 'secret.key');
const HOST = process.env.MARAND_HOST || '127.0.0.1';
const PORT = Number(process.env.MARAND_PORT || 8765);
const DEFAULT_GITHUB_REPO = 'zvxnz7/MarandTechnology';
const MAX_BODY = 3 * 1024 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;
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
const ArchiveCleanup = require('./modules/archive-cleanup');
function purgeExpiredArchive() {
  try {
    const removed = ArchiveCleanup.purgeExpired(db, path.join(DATA, 'photos'));
    if (removed) console.log(`Archiwum: usunięto ${removed} wygasłych roboczych wpisów.`);
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


class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }
function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function todayWarsaw() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function normalize(value) { return String(value || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
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
  const row = db.prepare('SELECT r.*,p.name project_name,p.archived_at project_archived_at,a.active_spec,p.conflict FROM records r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN articles a ON a.id=r.article_id WHERE r.id=?').get(id);
  if (!row) fail(404, 'Nie znaleziono wpisu.');
  return row;
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
function audit(user, action, recordId = null, detail = '') {
  db.prepare('INSERT INTO audit(at,user_id,action,record_id,detail) VALUES(?,?,?,?,?)').run(now(), user ? user.id : null, action, recordId, detail);
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
      row.number = old.gb?.[i]?.number || String(Math.max(0,...(old.gb||[]).map(g=>Number(g.number))) + i - (old.gb||[]).length + 1);
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
async function syncExternalUpdater(updaterPath) {
  const bundled = path.join(ROOT, 'administracja', 'updater.js');
  const target = path.resolve(updaterPath);
  const bundledKey = process.platform === 'win32' ? bundled.toLowerCase() : bundled;
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
  if (bundledKey === targetKey) return;

  const source = await fsp.readFile(bundled);
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
      return send(req, res, 200, fs.readFileSync(file), mime);
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
      const projects = db.prepare('SELECT id,name,archived_at FROM projects WHERE archived_at IS NOT NULL AND archived_at>=? ORDER BY archived_at DESC,id DESC').all(cutoff);
      return send(req,res,200,V.archivePage({user:req.user,csrf:req.session.csrf,flashes:getFlashes(req),records,projects}));
    }
    if (Photos.handle(context) || await Catalog.handle(context)) return;

    if (p === '/projects' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const state = url.searchParams.get('state') || '';
      const rawPage = Number(url.searchParams.get('page') || 1);
      const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
      const params = [], clauses=['p.archived_at IS NULL'];
      for(const word of normalize(q).split(/\s+/).filter(Boolean)) {
        clauses.push("search_text(p.name || ' ' || p.description || ' ' || coalesce((SELECT group_concat(symbol,' ') FROM records WHERE project_id=p.id AND archived_at IS NULL),'') || ' ' || coalesce((SELECT group_concat(a.symbol,' ') FROM project_articles pa JOIN articles a ON a.id=pa.article_id WHERE pa.project_id=p.id),'')) LIKE ? ESCAPE '\\'");
        params.push('%'+word.replace(/[\\%_]/g,'\\$&')+'%');
      }
      if(state==='approved')clauses.push('EXISTS(SELECT 1 FROM project_articles pa JOIN articles a ON a.id=pa.article_id WHERE pa.project_id=p.id AND a.active_spec IS NOT NULL)');
      if(state==='pending')clauses.push('NOT EXISTS(SELECT 1 FROM project_articles pa JOIN articles a ON a.id=pa.article_id WHERE pa.project_id=p.id AND a.active_spec IS NOT NULL)');
      const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
      const total=db.prepare(`SELECT count(*) n FROM projects p ${where}`).get(...params).n;
      const rows=db.prepare(`SELECT p.*,(SELECT count(*) FROM project_articles pa WHERE pa.project_id=p.id) article_count,(SELECT count(*) FROM project_articles pa JOIN articles a ON a.id=pa.article_id WHERE pa.project_id=p.id AND a.active_spec IS NOT NULL) active_spec,(SELECT count(*) FROM records r WHERE r.archived_at IS NULL AND (r.project_id=p.id OR (r.project_id IS NULL AND EXISTS(SELECT 1 FROM project_articles pa WHERE pa.project_id=p.id AND pa.article_id=r.article_id)))) total,coalesce((SELECT max(updated_at) FROM records r WHERE r.archived_at IS NULL AND (r.project_id=p.id OR (r.project_id IS NULL AND EXISTS(SELECT 1 FROM project_articles pa WHERE pa.project_id=p.id AND pa.article_id=r.article_id)))),p.created_at) updated FROM projects p ${where} ORDER BY updated DESC,p.id DESC LIMIT 15 OFFSET ?`).all(...params,(page-1)*15);
      const status = readJsonIfExists(path.join(DATA, 'backup_status.json'));
      if (status) {
        const stamp = status.last_success ? new Date(status.last_success) : null;
        status.stale = !stamp || Number.isNaN(stamp.getTime()) || (Date.now() - stamp.getTime() > 36 * 3600 * 1000);
      }
      return send(req, res, 200, V.homePage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), projects: rows, total, articleInput: Catalog.projectArticleInput(db), page, q, state, backupState: status }));
    }

    if (p === '/projects' && req.method === 'POST') {
      role(req.user, 'technologist', 'approver', 'admin');
      const name = formText(form, 'name');
      if (!name || name.length > 150) fail(400, 'Podaj nazwę projektu (do 150 znaków).');
      const pid = transaction(() => {
        if (db.prepare('SELECT 1 FROM projects WHERE lower(name)=lower(?)').get(name)) fail(409, 'Taki projekt już istnieje.');
        const result = db.prepare('INSERT INTO projects(name,description,created_at) VALUES(?,?,?)').run(name, String(form.description||'').slice(0,6000), now());
        Catalog.associate(context, Number(result.lastInsertRowid), form);
        audit(req.user, 'Utworzono projekt', null, name);
        return Number(result.lastInsertRowid);
      });
      return redirect(req, res, `/projects/${pid}`);
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

    const linkProject=p.match(/^\/projects\/(\d+)\/articles$/);
    if(linkProject && req.method==='POST') {
      role(req.user,'admin','approver','technologist');
      const pid=Number(linkProject[1]),pr=project(Number(linkProject[1]));if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanego projektu/próby.');
      transaction(()=>{Catalog.associate(context,pid,form);audit(req.user,'Powiązano artykuł z projektem',null,String(pid));});
      return redirect(req,res,`/projects/${pid}`);
    }
    const unlinkProjectArticle=p.match(/^\/projects\/(\d+)\/articles\/(\d+)\/unlink$/);
    if(unlinkProjectArticle && req.method==='POST') {
      role(req.user,'admin','approver','technologist');
      const pid=Number(unlinkProjectArticle[1]), articleId=Number(unlinkProjectArticle[2]);
      const pr=project(pid);if(pr.archived_at)fail(409,'Nie można modyfikować zarchiwizowanego projektu/próby.');
      transaction(()=>{
        const result=db.prepare('DELETE FROM project_articles WHERE project_id=? AND article_id=?').run(pid,articleId);
        if(!result.changes)fail(404,'To powiązanie artykułu z projektem już nie istnieje.');
        audit(req.user,'Odpięto artykuł od projektu',null,`${articleId} / ${pid}`);
      });
      return redirect(req,res,`/projects/${pid}`,'Artykuł został odpięty od projektu.');
    }
    let id = matchId(p, /^\/projects\/(\d+)$/);
    if (id && req.method === 'GET') {
      const pr = project(id);
      const records = db.prepare("SELECT r.*,CASE WHEN a.active_spec=r.id THEN 1 ELSE 0 END is_current FROM records r LEFT JOIN articles a ON a.id=r.article_id WHERE r.archived_at IS NULL AND (r.project_id=? OR (r.project_id IS NULL AND EXISTS(SELECT 1 FROM project_articles pa WHERE pa.project_id=? AND pa.article_id=r.article_id))) ORDER BY CASE WHEN a.active_spec=r.id THEN 0 WHEN r.kind='spec' AND r.state!='approved' THEN 1 ELSE 2 END,r.id DESC").all(id,id);
      const cards = db.prepare('SELECT c.*,u.name author FROM cards c JOIN records r ON r.id=c.record_id JOIN users u ON u.id=c.created_by WHERE r.project_id=? OR (r.project_id IS NULL AND EXISTS(SELECT 1 FROM project_articles pa WHERE pa.project_id=? AND pa.article_id=r.article_id)) ORDER BY c.id DESC').all(id,id);
      return send(req, res, 200, V.projectPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), p: pr, records, cards, linkedArticles: db.prepare('SELECT a.* FROM articles a JOIN project_articles pa ON pa.article_id=a.id WHERE pa.project_id=?').all(id), articleInput: Catalog.projectArticleInput(db, { optional: false }) }));
    }
    id = matchId(p, /^\/projects\/(\d+)\/new$/);
    if (id && req.method === 'POST') {
      role(req.user, 'technologist', 'approver', 'admin');
      const pr = project(id), kind = form.kind || 'trial';
      if(pr.archived_at) fail(409,'Nie można dodawać prób ani specyfikacji do zarchiwizowanego projektu/próby.');
      if (!['trial', 'spec'].includes(kind)) fail(400, 'Nieprawidłowy typ wpisu.');
      const v = blank(); v.date = todayWarsaw();
      let newArticleFields=false;
      const rid = transaction(() => {
        const selected = Number(form.article_id);
        let a = selected ? db.prepare('SELECT a.* FROM articles a JOIN project_articles pa ON pa.article_id=a.id WHERE a.id=? AND pa.project_id=?').get(selected,id) : null;
        if(!a) fail(400,'Wybierz artykuł z kartoteki projektu. Możesz go najpierw dodać w sekcji „Artykuły w projekcie”.');
        newArticleFields=kind==='spec'&&!db.prepare('SELECT 1 FROM records WHERE article_id=? AND archived_at IS NULL LIMIT 1').get(a.id);
        v.symbol=a ? a.symbol : pr.name;
        const result = db.prepare('INSERT INTO records(project_id,article_id,kind,symbol,payload,created_at,updated_at,expected_active) VALUES(?,?,?,?,?,?,?,?)').run(id, a ? a.id : null, kind, v.symbol, dump(v), now(), now(), a ? a.active_spec : null);
        const recordId = Number(result.lastInsertRowid);
        audit(req.user, 'Utworzono wpis', recordId);
        return recordId;
      });
      return redirect(req, res, `/records/${rid}/edit${newArticleFields?'?new_article=1':''}`);
    }

    id = matchId(p, /^\/records\/(\d+)$/);
    if (id && req.method === 'GET') {
      const r = record(id), history = db.prepare('SELECT a.*,u.name author FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE record_id=? ORDER BY a.id DESC').all(id);
      return send(req, res, 200, V.recordPage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), r, v: parsePayload(r), history, photoPanel: Photos.panel('record',id,{...req,readOnly:Boolean(r.archived_at)}) }));
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
      if (r.state !== 'draft') fail(409, 'Ta wersja jest zablokowana. Utwórz nową wersję albo wycofaj wniosek o zatwierdzenie.');
      if (req.method === 'POST') {
        // Keep a copy of a valid form before BEGIN IMMEDIATE. If SQLite cannot
        // acquire a write lock, render the editor again with the user's work.
        try {
          const old = parsePayload(r), values = parseForm(form, old);
          values.date = old.date || values.date;
          recovery = { kind: 'record-edit', record: r, values };
        } catch {
          // The normal transaction path below returns the actual validation
          // message. Recovery is only for an otherwise valid submitted form.
        }
        transaction(() => {
          r = record(id); stale(r, form);
          if (r.state !== 'draft') fail(409, 'Wpis jest już zablokowany.');
          const old = parsePayload(r), v = parseForm(form, old);
          v.date = old.date || v.date;
          recovery = { kind: 'record-edit', record: r, values: v };
          let a = r.article_id ? db.prepare('SELECT * FROM articles WHERE id=?').get(r.article_id) : null;
          if (a && a.symbol !== v.symbol) fail(400,'Symbol powiązanego artykułu pozostaje stały. Dla innego artykułu utwórz osobny wpis.');
          if (!a && r.kind === 'spec') a = makeArticle(r.project_id,v.symbol);
          const expected = a && a.id !== r.article_id ? a.active_spec : r.expected_active;
          db.prepare('UPDATE records SET symbol=?,number=?,payload=?,article_id=?,expected_active=?,updated_at=?,revision=revision+1 WHERE id=?').run(v.symbol, v.number, dump(v), a ? a.id : null, expected, now(), id);
          if(a)db.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(new Date().toISOString(),a.id);
          audit(req.user, 'Zapisano zmiany', id, dump({ before: old, after: v }));
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
        if (!['trial', 'spec'].includes(kind)) fail(400, 'Nieprawidłowy typ wpisu.');
        if (kind === 'trial') Object.assign(v, { raw: {}, raw_comments: '', finished_comments: '', finished: [], comments: '', stages: '', targets: {}, number: '', date: todayWarsaw() });
        if(kind==='trial' && !r.project_id) fail(400,'Próbę rozpocznij w projekcie powiązanym z tym artykułem.');
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
          if (!form.checked || note.length < 10) fail(400, 'Potwierdź sprawdzenie i opisz decyzję (minimum 10 znaków).');
          if (r.active_spec !== r.expected_active) fail(409, 'W międzyczasie zatwierdzono inną specyfikację. Utwórz nową wersję na podstawie aktualnej i porównaj zmiany.');
          approvedVersion = db.prepare('SELECT coalesce(max(version),0)+1 version FROM records WHERE article_id=?').get(r.article_id).version;
          db.prepare("UPDATE records SET state='approved',version=?,approved_at=?,approved_by=?,review_note=?,updated_at=?,revision=revision+1 WHERE id=?").run(approvedVersion, now(), req.user.id, note, now(), id);
          db.prepare('UPDATE articles SET active_spec=? WHERE id=?').run(id, r.article_id);
          audit(req.user, 'Zatwierdzono specyfikację', id, note);
        }
      });
      return redirect(req, res, `/records/${id}`, approvedVersion ? `Zatwierdzono wersję ${approvedVersion}.` : '');
    }

    id = matchId(p, /^\/records\/(\d+)\/preview$/);
    if (id && req.method === 'GET') {
      const r = record(id), v = parsePayload(r);
      const html = V.cardPage({ r, v, changeNotice: Changes.notice(db,r,v), machine: '—', instructions: 'Podgląd danych. Karta niewydana.', cardno: null, issuedAt: now(), author: req.user.name, logo: fs.readFileSync(path.join(ROOT, 'static', 'logo.jpg')).toString('base64'), printcss: fs.readFileSync(path.join(ROOT, 'static', 'card.css'), 'utf8') });
      return send(req, res, 200, html);
    }

    id = matchId(p, /^\/records\/(\d+)\/issue$/);
    if (id && (req.method === 'GET' || req.method === 'POST')) {
      role(req.user, 'technologist', 'approver', 'admin');
      let r = record(id);
      if (req.method === 'GET') {
        if (r.state !== 'approved' || r.active_spec !== id) fail(409, 'Najpierw zatwierdź aktualną specyfikację.');
        return send(req, res, 200, V.issuePage({ user: req.user, csrf: req.session.csrf, flashes: getFlashes(req), r, token: crypto.randomBytes(24).toString('base64url') }));
      }
      const token = formText(form, 'token'), machine = formText(form, 'machine'), instructions = formText(form, 'instructions');
      if (!machine || !instructions || token.length < 20) fail(400, 'Podaj maszynę i polecenia do tej produkcji.');
      if (machine.length > 100 || instructions.length > 6000) fail(400, 'Skróć nazwę maszyny lub instrukcje.');
      const cardId = transaction(() => {
        const old = db.prepare('SELECT id,record_id,created_by FROM cards WHERE token=?').get(token);
        if (old) {
          if (old.record_id !== id || old.created_by !== req.user.id) fail(409, 'Ten identyfikator karty został już wykorzystany.');
          return old.id;
        }
        r = record(id);
        if (r.state !== 'approved' || r.active_spec !== id) fail(409, 'Można wydać wyłącznie aktualną zatwierdzoną wersję. Otwórz aktualną kartę artykułu.');
        const v = parsePayload(r), stamp = now();
        const cardno = `K-${stamp.slice(0, 10)}-${token.slice(0, 8)}`;
        const html = V.cardPage({ r, v, changeNotice: Changes.notice(db,r,v), machine, instructions, cardno, issuedAt: stamp, author: req.user.name, logo: fs.readFileSync(path.join(ROOT, 'static', 'logo.jpg')).toString('base64'), printcss: fs.readFileSync(path.join(ROOT, 'static', 'card.css'), 'utf8') });
        const result = db.prepare('INSERT INTO cards(record_id,machine,instructions,created_at,created_by,token,snapshot,html) VALUES(?,?,?,?,?,?,?,?)').run(id, machine, instructions, stamp, req.user.id, token, dump({ record: r, data: v, author: req.user.name }), html);
        const newId = Number(result.lastInsertRowid);
        audit(req.user, 'Wydano kartę na maszynę', id, `Karta ${newId} / ${machine} / ${instructions}`);
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

    fail(404, 'Nie znaleziono strony.');
  } catch (err) {
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

