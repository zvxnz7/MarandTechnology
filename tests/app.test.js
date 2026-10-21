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



async function session(login='admin') {
 const cookie=await loginAs(login);const page=await request(`${baseUrl}/projects`,{headers:{cookie}});
 const match=page.text().match(/name="csrf" value="([^"]+)"/);assert.ok(match,page.text());
 return {cookie,csrf:match[1]};
}
async function post(s,url,fields={}) {return request(baseUrl+url,{method:'POST',headers:{cookie:s.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:s.csrf,...fields})});}
async function createArticle(s,symbol) {
 const r=await post(s,'/articles',{symbol});assert.equal(r.status,303,r.text());return Number(r.headers.location.split('/').pop());
}
test('independent article, project creation with article and cross-project association',async()=>{
 const s=await session();const aid=await createArticle(s,'INDEPENDENT');
 const db=new DatabaseSync(path.join(DATA,'marand.sqlite3'));
 assert.equal(db.prepare('SELECT project_id FROM articles WHERE id=?').get(aid).project_id,null);
 let r=await post(s,'/projects',{name:'PROJECT-A',article_mode:'existing',existing_symbol:'INDEPENDENT'});assert.equal(r.status,303,r.text());
 const pid=Number(r.headers.location.split('/').pop());
 r=await post(s,'/projects',{name:'PROJECT-B',article_mode:'new',symbol:'NEW-ARTICLE'});assert.equal(r.status,303,r.text());
 const pid2=Number(r.headers.location.split('/').pop());
 r=await post(s,`/projects/${pid2}/articles`,{article_mode:'existing',existing_symbol:'INDEPENDENT'});assert.equal(r.status,303,r.text());
 assert.equal(db.prepare('SELECT count(*) n FROM project_articles WHERE article_id=?').get(aid).n,2);
 const before=db.prepare('SELECT count(*) n FROM projects').get().n;
 r=await post(s,'/projects',{name:'INVALID-ROLLBACK',article_mode:'new',symbol:'INDEPENDENT'});assert.equal(r.status,409);
 assert.equal(db.prepare('SELECT count(*) n FROM projects').get().n,before);
 r=await post(s,`/projects/${pid}/new`,{kind:'trial',article_id:aid});assert.equal(r.status,303,r.text());
 const trialId=Number(r.headers.location.split('/')[2]);assert.equal(db.prepare('SELECT article_id FROM records WHERE id=?').get(trialId).article_id,aid);
 db.prepare('UPDATE records SET updated_at=? WHERE id=?').run('2026-03-04T10:00:00Z',trialId);
 r=await request(`${baseUrl}/articles/${aid}`,{headers:{cookie:s.cookie}});assert.equal(r.status,200);assert.match(r.text(),/PROJECT-A/);assert.match(r.text(),/PROJECT-B/);
 assert.match(r.text(),/04\.03\.2026/);
 db.close();
});
test('categories are removed; article dates and SQL pagination with 500 articles',async()=>{
 const s=await session();let r=await post(s,'/categories',{name:'Poliester-test'});assert.equal(r.status,404,r.text());
 const db=new DatabaseSync(path.join(DATA,'marand.sqlite3'));
 r=await post(s,'/articles',{symbol:'WELUR-PA'});assert.equal(r.status,303,r.text());
 db.exec('BEGIN');const insert=db.prepare('INSERT INTO articles(symbol,symbol_key,created_at,updated_at) VALUES(?,?,?,?)');
 for(let i=0;i<500;i++)insert.run('PERF-'+String(i).padStart(3,'0'),'PERF'+i,`2026-01-01T00:00:${String(i%60).padStart(2,'0')}Z`,'2026-01-01T00:00:00Z');db.exec('COMMIT');
 r=await request(`${baseUrl}/articles`,{headers:{cookie:s.cookie}});assert.equal(r.status,200,r.text());assert.match(r.text(),/WELUR-PA/);assert.doesNotMatch(r.text(),/Kategoria/);
 r=await request(`${baseUrl}/articles?q=PERF&sort=oldest&page=2`,{headers:{cookie:s.cookie}});assert.equal(r.status,200,r.text());assert.equal((r.text().match(/class="item-title"/g)||[]).length,50);assert.match(r.text(),/Strona 2/);
 r=await request(`${baseUrl}/articles?q=%25`,{headers:{cookie:s.cookie}});assert.equal(r.status,200,r.text());assert.doesNotMatch(r.text(),/PERF-001/);db.close();
});
test('GB auto numbering, finished parameters optional, approvals and immutable cards',async()=>{
 const s=await session();const aid=await createArticle(s,'READY-ARTICLE');let r=await post(s,`/articles/${aid}/new`);assert.equal(r.status,303,r.text());
 const rid=Number(r.headers.location.split('/')[2]);
 const values={revision:1,symbol:'READY-ARTICLE',tech_machine_type:'HKS',tech_gauge:'E24',tech_density:'15',tech_working_width:'130',tech_panels:'1',gb_0_yarn:'PES',gb_0_threads:'100',gb_0_run_in:'1200',gb_0_threading:'pełne',gb_0_pattern:'10/23',gb_0_number:'31'};
 r=await post(s,`/records/${rid}/edit`,values);assert.equal(r.status,303,r.text());
 const db=new DatabaseSync(path.join(DATA,'marand.sqlite3'));assert.equal(JSON.parse(db.prepare('SELECT payload FROM records WHERE id=?').get(rid).payload).gb[0].number,'1');
 r=await post(s,`/records/${rid}/submit`,{revision:2});assert.equal(r.status,303,r.text());
 r=await post(s,`/records/${rid}/approve`,{revision:3,checked:'on',review_note:'Sprawdzono ustawienia maszyny.'});assert.equal(r.status,303,r.text());
 assert.throws(()=>db.prepare("UPDATE records SET symbol='X' WHERE id=?").run(rid),/immutable/);
 r=await post(s,`/records/${rid}/issue`,{token:crypto.randomBytes(24).toString('hex'),machine:'12',instructions:'test'});assert.equal(r.status,303,r.text());const first=r.headers.location;
 r=await post(s,`/records/${rid}/copy`,{kind:'spec'});assert.equal(r.status,303,r.text());const next=Number(r.headers.location.split('/')[2]);
 r=await post(s,`/records/${next}/edit`,{...values,gb_0_run_in:'1400'});assert.equal(r.status,303,r.text());
 r=await request(`${baseUrl}/records/${next}/preview`,{headers:{cookie:s.cookie}});const previewHtml=r.text().replace(/<style>[\s\S]*?<\/style>/g,'');assert.doesNotMatch(previewHtml,/data-update-alert|class="[^"]*\bchange-alert\b/);assert.match(r.text(),/1400/);assert.match(r.text(),/Test Admin/);
 r=await post(s,`/records/${next}/submit`,{revision:2});assert.equal(r.status,303,r.text());
 r=await post(s,`/records/${next}/approve`,{revision:3,checked:'on',review_note:'Sprawdzono nową technologię.'});assert.equal(r.status,303,r.text());
 r=await request(baseUrl+first,{headers:{cookie:s.cookie}});assert.match(r.text(),/historyczna karta/);
 assert.doesNotMatch(db.prepare('SELECT html FROM cards WHERE record_id=?').get(rid).html,/historyczna karta/);
 const changedCardToken=crypto.randomBytes(24).toString('hex');
 r=await post(s,`/records/${next}/issue`,{token:changedCardToken,machine:'12',instructions:'test'});assert.equal(r.status,200,r.text());assert.match(r.text(),/data-show-modal/);assert.match(r.text(),/<section class="change-alert"/);assert.match(r.text(),/<td class="changed-value">/);
 r=await post(s,`/records/${next}/issue`,{token:changedCardToken,machine:'12',instructions:'test',confirm_changes:'1'});assert.equal(r.status,303,r.text());
 r=await request(baseUrl+r.headers.location,{headers:{cookie:s.cookie}});const issuedHtml=r.text().replace(/<style>[\s\S]*?<\/style>/g,'');assert.doesNotMatch(issuedHtml,/data-update-alert|class="[^"]*\bchange-alert\b|class="changed-value"/);db.close();
});
test('photo upload is optional, authenticated, append-only and validates the format',async()=>{
 const s=await session();const aid=await createArticle(s,'PHOTO-ARTICLE');
 let r=await post(s,'/photos',{kind:'article',id:aid,image:'data:image/jpeg;base64,PHNjcmlwdD4='});assert.equal(r.status,400);
 // Small JPEG fixture used only in tests; raster decoding happens in the browser.
 const bytes=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z','base64');
 r=await post(s,'/photos',{kind:'article',id:aid,image:'data:image/jpeg;base64,'+bytes.toString('base64'),caption:'<script>alert(1)</script>'});assert.equal(r.status,303,r.text());
 const db=new DatabaseSync(path.join(DATA,'marand.sqlite3'));const photo=db.prepare('SELECT * FROM photos WHERE article_id=?').get(aid);
 assert.ok(fs.existsSync(path.join(DATA,'photos',photo.file)));
 r=await request(`${baseUrl}/articles/${aid}`,{headers:{cookie:s.cookie}});assert.match(r.text(),/&lt;script&gt;/);
 r=await request(`${baseUrl}/photos/${photo.id}`);assert.equal(r.status,303);
 const viewer=await session('viewer');r=await post(viewer,'/photos',{kind:'article',id:aid});assert.equal(r.status,403);db.close();
});
test('editor has two initial GB rows and retains historical sparse GB numbers',()=>{
 const v={symbol:'X',gb:[],finished:[],sources:[]};const r={id:1,kind:'trial',revision:1};const user={name:'x',role:'admin'};
 let html=V.editPage({user,csrf:'x',r,v});assert.equal((html.match(/data-gb-index=/g)||[]).length,2);assert.match(html,/data-add-gb/);assert.doesNotMatch(html,/<textarea name="gb_0_(threading|pattern)"/);
 html=V.editPage({user,csrf:'x',r,v:{...v,gb:[{number:'6',yarn:'PES'}]}});assert.match(html,/GB6/);assert.match(html,/GB7/);
});
test('backup captures photo files belonging to the database snapshot',async()=>{
 const output=path.join(DATA,'snapshot.sqlite3');
 const job=spawn(process.execPath,[path.join(ROOT,'manage.js'),'backup','--output',output],{env:{...process.env,MARAND_DATA:DATA,MARAND_DATABASE:path.join(DATA,'marand.sqlite3')},stdio:['ignore','pipe','pipe']});
 let log='';job.stdout.on('data',d=>log+=d);job.stderr.on('data',d=>log+=d);const [code]=await once(job,'exit');assert.equal(code,0,log);
 const saved=new DatabaseSync(output);for(const photo of saved.prepare('SELECT file FROM photos').all())assert.deepEqual(fs.readFileSync(path.join(output+'.photos',photo.file)),fs.readFileSync(path.join(DATA,'photos',photo.file)));saved.close();
});
