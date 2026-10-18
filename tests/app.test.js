'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { after, before, test } = require('node:test');
const V = require('../views');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(os.tmpdir(), `marand-node-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
const SECRET = 'node-test-session-secret-long-enough-to-sign';
let child;
let baseUrl;
let serverOutput = '';

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  }).toString('hex');
  return `scrypt:32768:8:1$${salt}$${hash}`;
}

function seedTestDatabase() {
  fs.mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(path.join(DATA, 'marand.sqlite3'));
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const password = makePassword('test-password-123');
  const insertUser = db.prepare('INSERT INTO users(login,name,password,role) VALUES(?,?,?,?)');
  insertUser.run('admin', 'Test Admin', password, 'admin');
  insertUser.run('viewer', 'Test Viewer', password, 'viewer');
  const projectId = Number(db.prepare('INSERT INTO projects(name,created_at) VALUES(?,?)').run('TEST-PROJECT', new Date().toISOString()).lastInsertRowid);
  const payload = JSON.stringify({
    symbol: 'M3550', number: '1', date: '2026-10-18', client: '', description: '', tech: {}, gb: [],
    raw: {}, raw_comments: '', finished: [], comments: '', stages: '', targets: {}, tolerances: {},
    knitter_notes: '', sources: [],
  });
  db.prepare('INSERT INTO records(project_id,kind,symbol,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(projectId, 'trial', 'M3550', payload, new Date().toISOString(), new Date().toISOString());
  db.close();
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function cookiePair(header) {
  assert.ok(header, 'server should set a session cookie');
  return header.split(';', 1)[0];
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body;
    const headers = { ...(options.headers || {}) };
    if (body != null && !headers['content-length']) headers['content-length'] = Buffer.byteLength(body);
    const req = http.request(url, { method: options.method || 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: () => Buffer.concat(chunks).toString('utf8'),
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function hidden(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<input type="hidden" name="${escaped}" value="([^"]*)">`));
  assert.ok(match, `missing hidden ${name} field`);
  return match[1];
}

async function loginAs(login) {
  const page = await request(`${baseUrl}/login`);
  const html = page.text();
  const cookie = cookiePair(page.headers['set-cookie']?.[0]);
  const response = await request(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: hidden(html, 'csrf'), login, password: 'test-password-123' }),
  });
  assert.equal(response.status, 303, `login failed: ${response.text()}`);
  return cookiePair(response.headers['set-cookie']?.[0]);
}

before(async () => {
  seedTestDatabase();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'manage.js'), 'run', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, MARAND_DATA: DATA, MARAND_DATABASE: path.join(DATA, 'marand.sqlite3'), MARAND_SECRET: SECRET },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  let healthState = 'no response';
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${serverOutput}`);
    try {
      const response = await request(`${baseUrl}/healthz`);
      if (response.status === 200) return;
      healthState = `${response.status}: ${response.text()}`;
    } catch (error) { healthState = `${error.message}${error.cause ? `: ${error.cause.message}` : ''}`; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy (${healthState}):\n${serverOutput}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await fsp.rm(DATA, { recursive: true, force: true });
});

test('Node server health and anonymous access', async () => {
  const health = await request(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.json().ok, true);
  const protectedPage = await request(`${baseUrl}/projects/1`);
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.location, '/login');
});

test('administrator can save a record; stale submissions are rejected', async () => {
  let cookie = await loginAs('admin');
  const page = await request(`${baseUrl}/records/1/edit`, { headers: { cookie } });
  const html = page.text();
  assert.equal(page.status, 200);
  const csrf = hidden(html, 'csrf');
  const revision = hidden(html, 'revision');
  const body = new URLSearchParams({ csrf, revision, symbol: 'M3550-EDITED' });
  const saved = await request(`${baseUrl}/records/1/edit`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  assert.equal(saved.status, 303, `save failed:\n${serverOutput}`);
  cookie = cookiePair(saved.headers['set-cookie']?.[0]);
  const record = await request(`${baseUrl}/records/1`, { headers: { cookie } });
  assert.match(record.text(), /M3550-EDITED/);

  const stale = await request(`${baseUrl}/records/1/edit`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, revision, symbol: 'STALE-OVERWRITE' }),
  });
  assert.equal(stale.status, 409);
  assert.match(stale.text(), /nowszą wersję/);
});

test('viewer role cannot open the record editor', async () => {
  const cookie = await loginAs('viewer');
  const response = await request(`${baseUrl}/records/1/edit`, { headers: { cookie } });
  assert.equal(response.status, 403);
});

test('administrator sees the GitHub update link and install button only for a newer release', () => {
  const user = { name: 'Test Admin', role: 'admin' };
  const home = V.homePage({ user, csrf: 'csrf', flashes: [], projects: [], total: 0, page: 1, q: '', state: '', backupState: null });
  assert.match(home, /href="\/admin\/update">Aktualizacje GitHub/);
  const update = V.updatePage({
    user, csrf: 'csrf', flashes: [], current: '0.3.0', latest: { tag_name: 'v0.3.1', name: 'Update' },
    status: null, repo: 'zvxnz7/MarandTechnology', canUpdate: true, updateAvailable: true, updateError: '',
  });
  assert.match(update, /Pobierz i zainstaluj aktualizację z GitHub/);
  const current = V.updatePage({
    user, csrf: 'csrf', flashes: [], current: '0.3.1', latest: { tag_name: 'v0.3.1', name: 'Update' },
    status: null, repo: 'zvxnz7/MarandTechnology', canUpdate: true, updateAvailable: false, updateError: '',
  });
  assert.match(current, /Masz już najnowszą wersję/);
  assert.doesNotMatch(current, /Pobierz i zainstaluj aktualizację z GitHub/);
});


