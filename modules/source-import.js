'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const IMPORT_TABLE = 'marand_source_imports';
const RUN_TABLE = 'marand_source_import_runs';
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const REQUIRED_COLUMNS = {
  projects: ['trial_number', 'short_description', 'goal', 'assumptions', 'status', 'workflow_status', 'client_name', 'updated_at', 'archived_at'],
  articles: ['symbol', 'symbol_key', 'active_spec', 'created_at', 'updated_at', 'description', 'archived_at', 'purged_at'],
  records: ['project_id', 'article_id', 'kind', 'symbol', 'number', 'state', 'version', 'payload', 'created_at', 'updated_at', 'archived_at'],
  project_stages: ['project_id', 'stage_no', 'description', 'article_id', 'record_id', 'stage_date', 'status', 'stage_status', 'comment', 'updated_at'],
  project_stage_articles: ['stage_id', 'article_id', 'record_id', 'created_at'],
  project_comments: ['project_id', 'author_user_id', 'author_name', 'content', 'created_at'],
};

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sourceDateStamp(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const isoTime = text.match(/^(20\d{2})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/);
  const toWarsawTime = (y, m, d, h, min, sec) => {
    const target = Date.UTC(y, m - 1, d, h, min, sec);
    let utc = target;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(part => [part.type, part.value]));
      const displayedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      utc = target - (displayedAsUtc - utc);
    }
    return new Date(utc).toISOString();
  };
  if (isoTime) {
    const y = Number(isoTime[1]), m = Number(isoTime[2]), d = Number(isoTime[3]);
    const h = Number(isoTime[4]), min = Number(isoTime[5]), sec = Number(isoTime[6] || 0);
    const valid = new Date(Date.UTC(y, m - 1, d));
    if (valid.getUTCFullYear() !== y || valid.getUTCMonth() !== m - 1 || valid.getUTCDate() !== d || h > 23 || min > 59 || sec > 59) return '';
    if (isoTime[7]) return Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : '';
    return toWarsawTime(y, m, d, h, min, sec);
  }
  let match = text.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  let year, month, day, hour = 12, minute = 0, second = 0;
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\d{1,2})[.,/-](\d{1,2})[.,/-](\d{2}|\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return '';
    [, day, month, year, hour, minute, second] = match;
    if (year.length === 2) year = '20' + year;
    hour = hour == null ? 12 : Number(hour);
    minute = minute == null ? 0 : Number(minute);
    second = second == null ? 0 : Number(second);
  }
  const y = Number(year), m = Number(month), d = Number(day);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return '';
  const date = new Date(Date.UTC(y, m - 1, d, hour, minute, second));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return toWarsawTime(y, m, d, hour, minute, second);
}

function keyFor(symbol) {
  return String(symbol || '').toUpperCase().replace(/\s+/g, '');
}

function count(db, table, where = '') {
  return Number(db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get().n);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function validateSchema(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 9) throw new Error(`Wymagany jest schemat bazy 9; wykryto ${version}. Zaktualizuj program przed importem.`);
  for (const [table, needed] of Object.entries(REQUIRED_COLUMNS)) {
    const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const missing = needed.filter(column => !found.has(column));
    if (missing.length) throw new Error(`Baza nie ma wymaganych kolumn w ${table}: ${missing.join(', ')}.`);
  }
  for (const table of ['users', 'cards', 'audit', 'audit_articles', 'project_articles', 'project_stage_comments', 'project_trial_sequences', 'photos']) {
    if (!tableExists(db, table)) throw new Error(`W bazie brakuje wymaganej tabeli ${table}.`);
  }
}

function validatePackage(data) {
  if (!data || data.format !== 'marand-application-import-v1') throw new Error('Plik nie jest paczką importu Marand.');
  if (Number(data.target_schema_user_version) !== 9) throw new Error('Paczka danych wymaga schematu bazy 9.');
  if (!Array.isArray(data.articles) || !data.articles.length || !Array.isArray(data.specifications) || !data.specifications.length || !Array.isArray(data.projects) || !data.projects.length || typeof data.notice !== 'string' || !data.notice.trim()) {
    throw new Error('Paczka importu jest niekompletna.');
  }

  const articleKeys = new Set();
  const symbolKeys = new Set();
  for (const article of data.articles) {
    if (!article.article_key || !article.symbol || !article.symbol_key) throw new Error('Paczka zawiera artykuł bez klucza lub symbolu.');
    if (articleKeys.has(article.article_key)) throw new Error(`Powtórzony klucz artykułu w paczce: ${article.article_key}.`);
    if (keyFor(article.symbol) !== article.symbol_key) throw new Error(`Nieprawidłowy klucz symbolu artykułu ${article.symbol}.`);
    articleKeys.add(article.article_key);
    if (symbolKeys.has(article.symbol_key)) throw new Error('Powtórzony symbol artykułu w paczce: ' + article.symbol + '.');
    symbolKeys.add(article.symbol_key);
  }

  const sourceKeys = new Set();
  const addKey = value => {
    if (!value || typeof value !== 'string') throw new Error('Paczka zawiera wpis bez klucza źródłowego.');
    if (sourceKeys.has(value)) throw new Error(`Powtórzony klucz źródłowy w paczce: ${value}.`);
    sourceKeys.add(value);
  };
  for (const article of data.articles) addKey(`article:${article.article_key}`);
  for (const spec of data.specifications) {
    addKey(spec.source_key);
    if (spec.kind !== 'spec' || spec.state !== 'draft' || !articleKeys.has(spec.article_key) || !spec.payload || typeof spec.payload !== 'object' || Array.isArray(spec.payload)) {
      throw new Error(`Nieprawidłowa specyfikacja źródłowa: ${spec.source_key || '(bez klucza)'}.`);
    }
  }

  for (const project of data.projects) {
    addKey(`project:${project.source_key}`);
    if (typeof project.source_key !== 'string' || !project.source_key || !project.name || typeof project.trial_number !== 'string' || !project.trial_number.trim() || !project.stage || !Array.isArray(project.stage.article_keys) || !Array.isArray(project.records) || !Array.isArray(project.comments)) {
      throw new Error(`Nieprawidłowa próba źródłowa: ${project.trial_number || project.name || '(bez nazwy)'}.`);
    }
    for (const articleKey of project.stage.article_keys) {
      if (!articleKeys.has(articleKey)) throw new Error('Etap próby ' + project.trial_number + ' odwołuje się do nieznanego artykułu: ' + articleKey + '.');
    }
    for (const record of project.records) {
      addKey(record.source_key);
      if (record.kind !== 'trial' || record.state !== 'draft' || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
        throw new Error(`Nieprawidłowy rekord próby: ${record.source_key || '(bez klucza)'}.`);
      }
      if (record.article_key && !articleKeys.has(record.article_key)) throw new Error(`Próba odwołuje się do nieznanego artykułu: ${record.article_key}.`);
    }
  }
  return { sourceKeys };
}

function readPackageBuffer(file, displayPath = 'plik importu') {
  if (!Buffer.isBuffer(file)) file = Buffer.from(file);
  if (file.length > MAX_PACKAGE_BYTES) throw new Error('Plik importu przekracza limit 25 MB.');
  const text = file.toString('utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(text);
  validatePackage(data);
  return {
    data,
    digest: crypto.createHash('sha256').update(file).digest('hex'),
    path: displayPath,
  };
}

function readPackage(filePath) {
  return readPackageBuffer(fs.readFileSync(filePath), filePath);
}

function articleMatches(db, articles) {
  const select = db.prepare('SELECT id,symbol,symbol_key,active_spec FROM articles WHERE symbol_key=? AND purged_at IS NULL ORDER BY id');
  const state = db.prepare('SELECT state FROM records WHERE id=?');
  const result = new Map();
  const conflicts = [];
  for (const incoming of articles) {
    const rows = select.all(incoming.symbol_key);
    const approved = rows.filter(row => row.active_spec && state.get(row.active_spec)?.state === 'approved');
    let chosen = null;
    if (approved.length === 1) chosen = approved[0];
    else if (approved.length > 1) conflicts.push({ symbol: incoming.symbol, message: 'więcej niż jedna obowiązująca zatwierdzona technologia' });
    else if (rows.length === 1) chosen = rows[0];
    else if (rows.length > 1) conflicts.push({ symbol: incoming.symbol, message: 'więcej niż jeden artykuł o tym symbolu; wybierz właściwy ręcznie' });
    result.set(incoming.article_key, chosen ? Number(chosen.id) : null);
  }
  return { result, conflicts };
}

function planTrialNumbers(db, projects) {
  const lastByYear = new Map();
  for (const row of db.prepare('SELECT trial_number FROM projects WHERE trial_number IS NOT NULL').all()) {
    const match = String(row.trial_number).match(/^(\d+)\/(20\d{2})$/);
    if (!match) continue;
    const number = Number(match[1]), year = Number(match[2]);
    lastByYear.set(year, Math.max(lastByYear.get(year) || 0, number));
  }
  for (const row of db.prepare('SELECT year,last_value FROM project_trial_sequences').all()) {
    const year = Number(row.year);
    lastByYear.set(year, Math.max(lastByYear.get(year) || 0, Number(row.last_value) || 0));
  }

  const byYear = new Map();
  for (const project of projects) {
    const parsed = sourceDateStamp(project.created_at || project.updated_at || project.stage?.stage_date);
    const dateYear = parsed ? Number(parsed.slice(0, 4)) : 0;
    const labelYear = String(project.trial_number).match(/\/(20\d{2})(?:\b|[^0-9])/);
    const year = dateYear || (labelYear ? Number(labelYear[1]) : new Date().getFullYear());
    if (!byYear.has(year)) byYear.set(year, []);
    const dateOrder = parsed ? Date.parse(parsed) : Number.MAX_SAFE_INTEGER;
    const labelOrder = Number(String(project.trial_number).match(/^(\d+)/)?.[1] || 0);
    byYear.get(year).push({ project, original: String(project.trial_number), dateOrder, labelOrder });
  }

  const result = new Map();
  const changes = [];
  for (const [year, items] of byYear) {
    items.sort((a, b) => a.dateOrder - b.dateOrder || a.labelOrder - b.labelOrder || String(a.project.source_key).localeCompare(String(b.project.source_key)));
    let next = lastByYear.get(year) || 0;
    for (const item of items) {
      const assigned = String(++next) + '/' + year;
      result.set(item.project.source_key, assigned);
      const assignment = { from: item.original, to: assigned };
      if (assigned !== item.original) changes.push(assignment);
    }
  }
  const examples = projects.slice(0, 5).map(project => ({ from: String(project.trial_number), to: result.get(project.source_key) || '' }));
  return { result, changes, examples };
}

function countReviewFlags(data) {
  return data.specifications.reduce((n, item) => n + (item.review_flags || []).length, 0)
    + data.projects.reduce((n, project) => n + (project.review_flags || []).length
      + project.records.reduce((m, record) => m + (record.review_flags || []).length, 0), 0)
    + [...data.specifications, ...data.projects.flatMap(project => project.records)]
      .filter(record => String(record.payload?.date || '').trim() && !sourceDateStamp(record.payload.date)).length;
}

function preview(db, pkg) {
  validateSchema(db);
  const { data } = pkg;
  const matches = articleMatches(db, data.articles);
  const trialNumberPlan = planTrialNumbers(db, data.projects);
  const existingKeys = new Set();
  if (tableExists(db, IMPORT_TABLE)) {
    for (const row of db.prepare(`SELECT source_key FROM ${IMPORT_TABLE}`).all()) existingKeys.add(row.source_key);
  }
  if (tableExists(db, RUN_TABLE) && db.prepare(`SELECT 1 FROM ${RUN_TABLE} WHERE package_hash=?`).get(pkg.digest)) {
    matches.conflicts.push({ symbol: '', message: 'ta paczka została już zaimportowana' });
  }
  const repeated = [...matches.result.entries()]
    .map(([articleKey]) => `article:${articleKey}`).filter(key => existingKeys.has(key));
  for (const key of repeated) matches.conflicts.push({ symbol: key, message: 'artykuł z tej paczki został już zaimportowany' });
  for (const key of [...data.specifications.map(row => row.source_key), ...data.projects.flatMap(project => [`project:${project.source_key}`, ...project.records.map(row => row.source_key)])]) {
    if (existingKeys.has(key)) matches.conflicts.push({ symbol: key, message: 'wpis z tej paczki został już zaimportowany' });
  }

  const activeProjects = count(db, 'projects', 'WHERE archived_at IS NULL');
  const archivalDrafts = count(db, 'records', `WHERE state!='approved' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM cards c WHERE c.record_id=records.id)`);
  const matchedArticleIds = new Set([...matches.result.values()].filter(Boolean).map(Number));
  const archivalArticles = db.prepare('SELECT id FROM articles WHERE archived_at IS NULL AND purged_at IS NULL').all()
    .filter(article => !matchedArticleIds.has(Number(article.id))).length;
  const existingProjectNames = new Set(db.prepare('SELECT name FROM projects').all().map(row => row.name));
  let conflictingNames = 0;
  for (const project of data.projects) {
    if (existingProjectNames.has(project.name)) conflictingNames += 1;
    existingProjectNames.add(project.name);
  }
  const sourceNumberCounts = new Map();
  for (const project of data.projects) sourceNumberCounts.set(project.trial_number, (sourceNumberCounts.get(project.trial_number) || 0) + 1);
  const duplicateSourceTrialNumbers = [...sourceNumberCounts.values()].reduce((total, value) => total + Math.max(0, value - 1), 0);
  const archivedActiveSpecs = count(db, 'records', `WHERE state='approved' AND archived_at IS NULL`);
  const cards = count(db, 'cards');
  const users = count(db, 'users');
  const articleReuse = [...matches.result.values()].filter(Boolean).length;
  const descriptionsUpdated = data.articles.filter(article => matches.result.get(article.article_key) && String(article.description || '').trim()).length;

  return {
    mode: 'podgląd — baza bez zmian',
    file: pkg.path,
    package_sha256: pkg.digest,
    target_schema: 9,
    existing: { users, active_projects: activeProjects, active_articles: count(db, 'articles', 'WHERE archived_at IS NULL AND purged_at IS NULL'), approved_records: archivedActiveSpecs, issued_cards: cards },
    will_archive: { active_projects: activeProjects, unapproved_records_without_issued_cards: archivalDrafts, unmatched_articles: archivalArticles },
    incoming: { articles: data.articles.length, specifications: data.specifications.length, projects: data.projects.length, trial_records: data.projects.reduce((n, project) => n + project.records.length, 0), review_flags: countReviewFlags(data) },
    article_matches_to_existing: articleReuse,
    article_descriptions_updated: descriptionsUpdated,
    trial_numbers_adjusted: trialNumberPlan.changes.length,
    trial_number_examples: trialNumberPlan.examples,
    duplicate_source_trial_numbers: duplicateSourceTrialNumbers,
    project_names_that_need_a_unique_import_label: conflictingNames,
    preserved: ['konta użytkowników', 'zatwierdzone specyfikacje i wydane karty', 'klucz sesji'],
    imported_specifications: 'robocze; żadna nie zostanie ustawiona jako obowiązująca',
    ai_notice: data.notice,
    conflicts: matches.conflicts,
  };
}

function ensureTrackingTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${IMPORT_TABLE}(
    source_key TEXT PRIMARY KEY,
    object_type TEXT NOT NULL,
    article_id INTEGER,
    project_id INTEGER,
    record_id INTEGER,
    source_trial_number TEXT NOT NULL DEFAULT '',
    notice TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${RUN_TABLE}(
    package_hash TEXT PRIMARY KEY,
    imported_at TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    result_json TEXT NOT NULL
  );`);
  const columns = new Set(db.prepare('PRAGMA table_info(' + IMPORT_TABLE + ')').all().map(row => row.name));
  if (!columns.has('source_trial_number')) db.exec("ALTER TABLE " + IMPORT_TABLE + " ADD COLUMN source_trial_number TEXT NOT NULL DEFAULT ''");
  if (!columns.has('notice')) db.exec(`ALTER TABLE ${IMPORT_TABLE} ADD COLUMN notice TEXT NOT NULL DEFAULT ''`);
}

function uniqueProjectName(db, original, trialNumber, reservedNames) {
  const exists = name => reservedNames.has(name) || Boolean(db.prepare('SELECT 1 FROM projects WHERE name=?').get(name));
  let candidate = original;
  if (exists(candidate)) candidate = `${original} (import ${trialNumber})`;
  let index = 2;
  while (exists(candidate)) candidate = `${original} (import ${trialNumber} #${index++})`;
  reservedNames.add(candidate);
  return candidate;
}

function archiveReplaceableWork(db, stamp, matchedArticles) {
  const projects = db.prepare('UPDATE projects SET archived_at=? WHERE archived_at IS NULL').run(stamp).changes;
  const records = db.prepare(`UPDATE records SET archived_at=?
    WHERE state!='approved' AND archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM cards c WHERE c.record_id=records.id)`).run(stamp).changes;
  const keepIds = [...new Set([...matchedArticles.values()].filter(Boolean).map(Number))];
  let articles;
  if (keepIds.length) {
    const placeholders = keepIds.map(() => '?').join(',');
    articles = db.prepare(`UPDATE articles SET archived_at=? WHERE archived_at IS NULL AND purged_at IS NULL AND id NOT IN (${placeholders})`).run(stamp, ...keepIds).changes;
  } else {
    articles = db.prepare('UPDATE articles SET archived_at=? WHERE archived_at IS NULL AND purged_at IS NULL').run(stamp).changes;
  }
  return { projects, records, articles };
}

function importData(db, pkg, backupPath) {
  const report = preview(db, pkg);
  if (report.conflicts.length) {
    const details = report.conflicts.map(item => item.symbol ? `${item.symbol}: ${item.message}` : item.message).join('; ');
    throw new Error(`Import przerwany przed zmianami z powodu konfliktów: ${details}.`);
  }

  const stamp = now();
  const matchInfo = articleMatches(db, pkg.data.articles);
  const trialNumberPlan = planTrialNumbers(db, pkg.data.projects);
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureTrackingTables(db);
    const archived = archiveReplaceableWork(db, stamp, matchInfo.result);
    const articleIds = new Map();
    const insertSource = db.prepare(`INSERT INTO ${IMPORT_TABLE}(source_key,object_type,article_id,project_id,record_id,notice,imported_at) VALUES(?,?,?,?,?,?,?)`);
    const insertArticle = db.prepare('INSERT INTO articles(project_id,symbol,symbol_key,created_at,updated_at,description) VALUES(NULL,?,?,?,?,?)');
    const updateArticleDescription = db.prepare('UPDATE articles SET description=?,updated_at=? WHERE id=?');
    const restoreArticle = db.prepare('UPDATE articles SET archived_at=NULL WHERE id=? AND archived_at IS NOT NULL AND purged_at IS NULL');

    for (const article of pkg.data.articles) {
      let id = matchInfo.result.get(article.article_key) || null;
      if (id) {
        restoreArticle.run(id);
        if (article.description) updateArticleDescription.run(article.description, stamp, id);
      } else {
        id = Number(insertArticle.run(article.symbol, article.symbol_key, stamp, stamp, article.description || '').lastInsertRowid);
      }
      articleIds.set(article.article_key, id);
      insertSource.run(`article:${article.article_key}`, 'article', id, null, null, pkg.data.notice, stamp);
    }

    const insertRecord = db.prepare(`INSERT INTO records(project_id,article_id,kind,symbol,number,state,revision,version,payload,created_at,updated_at,archived_at)
      VALUES(?,?,?,?,?,'draft',1,NULL,?,?,?,NULL)`);
    const addRecord = (source, projectId, articleId, fallbackCreatedAt = stamp) => {
      const originalDate = String(source.payload.date || '').trim();
      const parsedDate = sourceDateStamp(originalDate);
      const createdAt = parsedDate || fallbackCreatedAt;
      const dateNeedsReview = Boolean(originalDate && !parsedDate);
      const reviewFlags = [...(Array.isArray(source.review_flags) ? source.review_flags : [])];
      const payloadData = { ...source.payload, ai_generated_notice: source.payload.ai_generated_notice || pkg.data.notice };
      if (parsedDate) payloadData.date = parsedDate.slice(0, 10);
      if (dateNeedsReview) {
        payloadData.date = '';
        payloadData.source_note = [payloadData.source_note, 'Nie odczytano daty źródłowej „' + originalDate + '”. Sprawdź ją w oryginalnej karcie.'].filter(Boolean).join('\n');
        reviewFlags.push('Nie odczytano daty źródłowej: ' + originalDate);
      }
      const payload = JSON.stringify(payloadData);
      const recordId = Number(insertRecord.run(projectId, articleId, source.kind, source.symbol || source.payload.symbol || '', source.number || '', payload, createdAt, createdAt).lastInsertRowid);
      const detail = JSON.stringify({
        source_key: source.source_key,
        review_flags: reviewFlags,
        original_source_date: dateNeedsReview ? originalDate : '',
        source_file: source.payload.source_data?.file || '',
        ai_notice: pkg.data.notice,
        package_sha256: pkg.digest,
      });
      const auditId = Number(db.prepare('INSERT INTO audit(at,action,record_id,detail) VALUES(?,?,?,?)').run(stamp, 'Import danych źródłowych AI — do sprawdzenia', recordId, detail).lastInsertRowid);
      if (articleId !== null) db.prepare('INSERT INTO audit_articles(audit_id,article_id) VALUES(?,?)').run(auditId, articleId);
      insertSource.run(source.source_key, source.kind, articleId, projectId, recordId, pkg.data.notice, stamp);
      return recordId;
    };

    for (const spec of pkg.data.specifications) addRecord({ ...spec, kind: 'spec', symbol: spec.payload.symbol, number: '' }, null, articleIds.get(spec.article_key));

    const reservedNames = new Set();
    const insertProject = db.prepare(`INSERT INTO projects(name,description,conflict,created_at,trial_number,short_description,goal,assumptions,status,updated_at,client_name,workflow_status,comment,archived_at)
      VALUES(?,?, '',?,?,?,?,?,?,?, ?,?,?,NULL)`);
    const insertStage = db.prepare(`INSERT INTO project_stages(project_id,stage_no,description,article_id,record_id,stage_date,status,stage_status,comment,updated_at)
      VALUES(?,?,?,NULL,NULL,?,?,?,?,?)`);
    const insertComment = db.prepare('INSERT INTO project_comments(project_id,author_user_id,author_name,content,created_at) VALUES(?,NULL,?,?,?)');
    let renamedProjects = 0;
    let trialRecords = 0;
    for (const project of pkg.data.projects) {
      const assignedTrialNumber = trialNumberPlan.result.get(project.source_key) || project.trial_number;
      const projectName = uniqueProjectName(db, project.name, assignedTrialNumber, reservedNames);
      if (projectName !== project.name) renamedProjects += 1;
      const projectCreatedAt = sourceDateStamp(project.created_at) || stamp;
      const projectUpdatedAt = sourceDateStamp(project.updated_at) || projectCreatedAt;
      const projectId = Number(insertProject.run(projectName, project.description || '', projectCreatedAt, assignedTrialNumber,
        project.short_description || '', project.goal || '', project.assumptions || '', project.status || 'in_progress',
        projectUpdatedAt, project.client_name || '', project.workflow_status || 'in_progress', project.comment || '').lastInsertRowid);
      insertSource.run(`project:${project.source_key}`, 'project', null, projectId, null, pkg.data.notice, stamp);
      db.prepare('UPDATE ' + IMPORT_TABLE + ' SET source_trial_number=? WHERE source_key=?').run(project.trial_number, 'project:' + project.source_key);
      const stage = project.stage;
      const stageDate = sourceDateStamp(stage.stage_date);
      const stageId = Number(insertStage.run(projectId, stage.stage_no, stage.description || '', stageDate ? stageDate.slice(0, 10) : projectCreatedAt.slice(0, 10),
        stage.status || 'in_progress', stage.stage_status || 'in_progress', stage.comment || '', projectUpdatedAt).lastInsertRowid);
      for (const comment of project.comments) insertComment.run(projectId, comment.author_name || 'Import AI', comment.content || '', sourceDateStamp(comment.created_at) || projectCreatedAt);
      const stageRecordsByArticle = new Map();
      const stageArticleKeys = new Set(project.stage.article_keys || []);
      for (const source of project.records) {
        const articleId = source.article_key ? articleIds.get(source.article_key) : null;
        const recordId = addRecord({ ...source, kind: 'trial' }, projectId, articleId || null, projectCreatedAt);
        trialRecords += 1;
        if (articleId) {
          db.prepare('INSERT OR IGNORE INTO project_articles(project_id,article_id) VALUES(?,?)').run(projectId, articleId);
          if (!stageRecordsByArticle.has(articleId)) stageRecordsByArticle.set(articleId, recordId);
          stageArticleKeys.add(source.article_key);
        }
      }
      for (const articleKey of stageArticleKeys) {
        const articleId = articleIds.get(articleKey);
        if (!articleId) continue;
        db.prepare('INSERT OR IGNORE INTO project_articles(project_id,article_id) VALUES(?,?)').run(projectId, articleId);
        db.prepare('INSERT OR IGNORE INTO project_stage_articles(stage_id,article_id,record_id,created_at) VALUES(?,?,?,?)')
          .run(stageId, articleId, stageRecordsByArticle.get(articleId) || null, projectUpdatedAt);
      }
    }

    const years = new Map();
    for (const project of pkg.data.projects) {
      const importedTrialNumber = trialNumberPlan.result.get(project.source_key) || project.trial_number;
      const m = String(importedTrialNumber).match(/^(\d+)\/(20\d{2})$/);
      if (!m) continue;
      const year = Number(m[2]);
      years.set(year, Math.max(years.get(year) || 0, Number(m[1])));
    }
    for (const [year, lastValue] of years) {
      db.prepare(`INSERT INTO project_trial_sequences(year,last_value) VALUES(?,?)
        ON CONFLICT(year) DO UPDATE SET last_value=max(last_value,excluded.last_value)`).run(year, lastValue);
    }

    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Import utworzył niespójne powiązania. Cofnięto wszystkie zmiany.');
    const result = {
      status: 'import zakończony',
      package_sha256: pkg.digest,
      backup: backupPath,
      preserved: { users: report.existing.users, approved_records: report.existing.approved_records, issued_cards: report.existing.issued_cards },
      archived,
      imported: { articles: pkg.data.articles.length, specifications: pkg.data.specifications.length, projects: pkg.data.projects.length, trial_records: trialRecords },
      trial_numbers_adjusted: trialNumberPlan.changes.length,
      project_names_adjusted_for_uniqueness: renamedProjects,
      review_flags: report.incoming.review_flags,
    };
    db.prepare(`INSERT INTO ${RUN_TABLE}(package_hash,imported_at,backup_path,result_json) VALUES(?,?,?,?)`)
      .run(pkg.digest, stamp, backupPath, JSON.stringify(result));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function importedNotice(db, column, id) {
  if (!['article_id', 'project_id', 'record_id'].includes(column) || !tableExists(db, IMPORT_TABLE)) return '';
  const row = db.prepare(`SELECT notice FROM ${IMPORT_TABLE} WHERE ${column}=? AND trim(notice)<>'' ORDER BY imported_at DESC LIMIT 1`).get(Number(id));
  return row?.notice || '';
}

module.exports = {
  readPackage,
  readPackageBuffer,
  preview,
  importData,
  validateSchema,
  noticeForArticle: (db, id) => importedNotice(db, 'article_id', id),
  noticeForProject: (db, id) => importedNotice(db, 'project_id', id),
  noticeForRecord: (db, id) => importedNotice(db, 'record_id', id),
};
