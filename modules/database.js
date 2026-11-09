'use strict';
const fs = require('node:fs');
const path = require('node:path');
const STARTER_ARTICLES = ['M3550', 'PTWZ', 'WT56-21'];

function ensureStarterArticles(db) {
  const insert = db.prepare(`INSERT INTO articles(symbol,symbol_key,created_at,updated_at)
    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM articles WHERE symbol_key=?)`);
  const linked = db.prepare(`SELECT a.id article_id,pa.project_id FROM articles a
    JOIN project_articles pa ON pa.article_id=a.id WHERE a.symbol_key=?`);
  const unlink = db.prepare('DELETE FROM project_articles WHERE project_id=? AND article_id=?');
  const legacyLinks = db.prepare('SELECT id,project_id FROM articles WHERE symbol_key=? AND project_id IS NOT NULL');
  const clearLegacyLink = db.prepare('UPDATE articles SET project_id=NULL,updated_at=? WHERE id=?');
  const audit = db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)');
  const timestamp = new Date().toISOString();
  for (const symbol of STARTER_ARTICLES) {
    const key = symbol.toUpperCase().replace(/\s/g, '');
    insert.run(symbol, key, timestamp, timestamp, key);
    for (const row of linked.all(key)) {
      unlink.run(row.project_id, row.article_id);
      audit.run(timestamp, 'Migracja: odpięto artykuł od projektu', `${symbol} · artykuł #${row.article_id} · projekt #${row.project_id}`);
    }
    for (const row of legacyLinks.all(key)) {
      clearLegacyLink.run(timestamp, row.id);
      audit.run(timestamp, 'Migracja: odpięto artykuł od projektu', `${symbol} · artykuł #${row.id} · projekt #${row.project_id}`);
    }
  }
}
function migrateStarterArticles(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureStarterArticles(db);
    db.exec('PRAGMA user_version=4; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function migrateV5(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 5) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    if (db.prepare('PRAGMA table_info(audit)').all().some(column => column.name === 'article_id')) {
      db.exec('INSERT OR IGNORE INTO audit_articles(audit_id,article_id) SELECT id,article_id FROM audit WHERE article_id IS NOT NULL;');
    }
    db.exec('INSERT OR IGNORE INTO audit_articles(audit_id,article_id) SELECT a.id,r.article_id FROM audit a JOIN records r ON r.id=a.record_id WHERE r.article_id IS NOT NULL;');
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const addColumn = (table, name, definition) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    addColumn('projects', 'trial_number', 'TEXT');
    addColumn('projects', 'short_description', "TEXT NOT NULL DEFAULT ''");
    addColumn('projects', 'goal', "TEXT NOT NULL DEFAULT ''");
    addColumn('projects', 'assumptions', "TEXT NOT NULL DEFAULT ''");
    addColumn('projects', 'status', "TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','accepted','failed','client_declined'))");
    addColumn('projects', 'updated_at', "TEXT NOT NULL DEFAULT ''");
    addColumn('articles', 'archived_at', 'TEXT');
    addColumn('articles', 'purged_at', 'TEXT');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    db.exec('INSERT OR IGNORE INTO audit_articles(audit_id,article_id) SELECT a.id,r.article_id FROM audit a JOIN records r ON r.id=a.record_id WHERE r.article_id IS NOT NULL;');

    const projects = db.prepare('SELECT id,name,description,created_at,trial_number,short_description,goal,updated_at FROM projects ORDER BY created_at,id').all();
    const counters = new Map();
    const update = db.prepare('UPDATE projects SET trial_number=?,short_description=?,goal=?,updated_at=? WHERE id=?');
    for (const row of projects) {
      const created=new Date(row.created_at||'');
      const year = Number.isNaN(created.getTime()) ? String(new Date().getFullYear()) : new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw',year:'numeric'}).format(created);
      const counter = (counters.get(year) || 0) + 1;
      counters.set(year, counter);
      const number = row.trial_number || `${counter}/${year}`;
      const nextCounter = Math.max(counter, Number(number.split('/')[0]) || 0);
      counters.set(year, nextCounter);
      update.run(number, row.short_description || row.name, row.goal || row.description || '', row.updated_at || row.created_at, row.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS projects_trial_number ON projects(trial_number) WHERE trial_number IS NOT NULL;');
    const sequence = db.prepare('INSERT INTO project_trial_sequences(year,last_value) VALUES(?,?) ON CONFLICT(year) DO UPDATE SET last_value=max(last_value,excluded.last_value)');
    for (const [year, last] of counters) sequence.run(Number(year), last);

    const legacyTrials = db.prepare("SELECT r.id,r.project_id,r.article_id,r.payload,r.created_at FROM records r WHERE r.kind='trial' AND r.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_stages s WHERE s.record_id=r.id) ORDER BY r.project_id,r.created_at,r.id").all();
    const nextStage = db.prepare('SELECT coalesce(max(stage_no),0)+1 n FROM project_stages WHERE project_id=?');
    const insertStage = db.prepare("INSERT INTO project_stages(project_id,stage_no,description,article_id,record_id,stage_date,status,comment,updated_at) VALUES(?,?,?,?,?,?,'in_progress','',?)");
    for (const row of legacyTrials) {
      const payload = JSON.parse(row.payload || '{}');
      const stageNo = nextStage.get(row.project_id).n;
      insertStage.run(row.project_id, stageNo, payload.description || `Etap ${stageNo}`, row.article_id, row.id, payload.date || (row.created_at || '').slice(0, 10), row.created_at);
    }
    const projectsWithoutStages = db.prepare('SELECT id,created_at FROM projects p WHERE NOT EXISTS(SELECT 1 FROM project_stages s WHERE s.project_id=p.id)').all();
    for (const row of projectsWithoutStages) insertStage.run(row.id, 1, '', null, null, (row.created_at || '').slice(0, 10), row.created_at);
    db.exec('PRAGMA user_version=5; COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function migrateV6(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 6) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const addColumn = (table, name, definition) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    addColumn('projects', 'client_name', "TEXT NOT NULL DEFAULT ''");
    addColumn('projects', 'workflow_status', "TEXT NOT NULL DEFAULT 'in_progress'");
    addColumn('cards', 'production_notes', "TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE projects SET workflow_status=CASE
      WHEN status IN ('in_progress','accepted','failed','client_declined') THEN status
      ELSE 'in_progress' END;
      INSERT OR IGNORE INTO project_stage_articles(stage_id,article_id,record_id,created_at)
        SELECT s.id,coalesce(s.article_id,r.article_id),s.record_id,coalesce(s.updated_at,'')
        FROM project_stages s LEFT JOIN records r ON r.id=s.record_id
        WHERE coalesce(s.article_id,r.article_id) IS NOT NULL;
      INSERT OR IGNORE INTO project_articles(project_id,article_id)
        SELECT s.project_id,sa.article_id FROM project_stage_articles sa
        JOIN project_stages s ON s.id=sa.stage_id;
      PRAGMA user_version=6; COMMIT;`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function migrateV7(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 7) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const addColumn = (table, name, definition) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    addColumn('projects', 'comment', "TEXT NOT NULL DEFAULT ''");
    addColumn('project_stages', 'stage_status', "TEXT NOT NULL DEFAULT 'in_progress'");
    db.exec("UPDATE project_stages SET stage_status=status;");
    const projects=db.prepare('SELECT id,trial_number FROM projects ORDER BY id').all();
    const comments=db.prepare("SELECT detail FROM audit WHERE action='Zmieniono opis próby' ORDER BY id DESC").all();
    const saveComment=db.prepare("UPDATE projects SET comment=? WHERE id=? AND comment=''");
    for(const row of projects) {
      for(const entry of comments) {
        let detail;try{detail=JSON.parse(entry.detail||'{}')}catch{continue}
        if(detail.trial!==row.trial_number)continue;
        saveComment.run(String(detail.comment||'').trim().slice(0,3000),row.id);
        break;
      }
    }
    db.exec('PRAGMA user_version=7; COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function migrateV8(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 8) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    db.exec('CREATE INDEX IF NOT EXISTS photos_project ON photos(project_id);');
    return;
  }
  // Create any tables missing from older layouts before entering the migration.
  // The photos_project index is deliberately created after the legacy photos
  // table has been rebuilt with its new project_id column.
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  db.exec('BEGIN IMMEDIATE');
  try {
    const addColumn = (table, name, definition) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    addColumn('articles', 'pending_production_notes', "TEXT NOT NULL DEFAULT ''");

    const photoColumns = db.prepare('PRAGMA table_info(photos)').all();
    if (photoColumns.length && !photoColumns.some(column => column.name === 'project_id')) {
      db.exec(`DROP INDEX IF EXISTS photos_article;
        DROP INDEX IF EXISTS photos_record;
        ALTER TABLE photos RENAME TO photos_before_v8;
        CREATE TABLE photos(id INTEGER PRIMARY KEY,article_id INTEGER REFERENCES articles(id),record_id INTEGER REFERENCES records(id),project_id INTEGER REFERENCES projects(id),file TEXT NOT NULL UNIQUE,caption TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),CHECK((article_id IS NOT NULL)+(record_id IS NOT NULL)+(project_id IS NOT NULL)=1));
        INSERT INTO photos(id,article_id,record_id,project_id,file,caption,created_at,created_by)
          SELECT id,article_id,record_id,NULL,file,caption,created_at,created_by FROM photos_before_v8;
        DROP TABLE photos_before_v8;
        CREATE INDEX photos_article ON photos(article_id);
        CREATE INDEX photos_record ON photos(record_id);`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS photos_project ON photos(project_id);');

    const projects = db.prepare("SELECT id,trial_number,comment,updated_at,created_at FROM projects WHERE NOT EXISTS(SELECT 1 FROM project_comments pc WHERE pc.project_id=projects.id) ORDER BY id").all();
    const auditRows = db.prepare("SELECT a.user_id,u.name,a.at,a.detail FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.action='Zmieniono opis próby' ORDER BY a.id").all();
    const insertComment = db.prepare('INSERT INTO project_comments(project_id,author_user_id,author_name,content,created_at) VALUES(?,?,?,?,?)');
    for (const project of projects) {
      let lastMigrated = '';
      for (const entry of auditRows) {
        let detail;
        try { detail = JSON.parse(entry.detail || '{}'); } catch { continue; }
        if (detail.trial !== project.trial_number) continue;
        const before = String(detail.before?.comment || '').trim();
        const comment = String(detail.after?.comment ?? detail.comment ?? '').trim().slice(0,3000);
        if (!comment || comment === before) continue;
        insertComment.run(project.id, entry.user_id || null, entry.name || 'Nieznany autor', comment, entry.at || project.created_at);
        lastMigrated=comment;
      }
      const current=String(project.comment||'').trim().slice(0,3000);
      if(current&&current!==lastMigrated)insertComment.run(project.id,null,'Nieznany autor',current,project.updated_at||project.created_at);
    }
    db.exec('PRAGMA user_version=8; COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function migrateV9(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  if (version >= 9) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const legacyComments = db.prepare("SELECT id,comment,updated_at FROM project_stages WHERE trim(coalesce(comment,''))<>'' ORDER BY id").all();
    const insert = db.prepare("INSERT INTO project_stage_comments(stage_id,author_user_id,author_name,content,created_at) VALUES(?,NULL,'Nieznany autor',?,?)");
    const clear = db.prepare("UPDATE project_stages SET comment='' WHERE id=?");
    for (const row of legacyComments) {
      insert.run(row.id, String(row.comment).trim().slice(0, 3000), row.updated_at || new Date().toISOString());
      clear.run(row.id);
    }
    db.exec('PRAGMA user_version=9; COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function migrateV10(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  if (version >= 10) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('PRAGMA user_version=10; COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
function migrateV11(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=11)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_receipts')").all().map(column=>column.name));
    if(!columns.has('finished_meters'))db.exec('ALTER TABLE finishing_receipts ADD COLUMN finished_meters REAL NOT NULL DEFAULT 0 CHECK(finished_meters >= 0)');
    db.exec('PRAGMA user_version=11; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV12(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=12)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_recipes')").all().map(column=>column.name));
    if(!columns.has('recipe_details'))db.exec("ALTER TABLE finishing_recipes ADD COLUMN recipe_details TEXT NOT NULL DEFAULT '{}'");
    db.exec('PRAGMA user_version=12; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV13(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=13)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_orders')").all().map(column=>column.name));
    if(!columns.has('order_type'))db.exec("ALTER TABLE finishing_orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'standard' CHECK(order_type IN ('standard','raw_sale','trial'))");
    db.exec("UPDATE finishing_orders SET order_type='raw_sale' WHERE status='raw_sale' AND order_type='standard'");
    db.exec('PRAGMA user_version=13; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV14(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=14)return;
  const repairPath=path.join(__dirname,'..','seed','finishing-recipe-corrections-v1.json');
  const repair=JSON.parse(fs.readFileSync(repairPath,'utf8'));
  if(repair.version!==1||!Array.isArray(repair.recipes)||repair.recipes.length!==repair.expected_recipes)throw new Error('Nieprawidłowy pakiet korekty receptur wykańczania.');
  const normalize=value=>String(value??'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'').trim();
  const key=(name,raw)=>`${normalize(name)}\u0000${normalize(raw)}`;
  const existing=db.prepare('SELECT id,name,raw_symbol FROM finishing_recipes WHERE active=1').all();
  const byKey=new Map();
  for(const row of existing){const k=key(row.name,row.raw_symbol);if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(row);}
  const summary=recipe=>{
    const d=recipe.recipe_details,lines=[];
    if(d.tradeSymbol)lines.push(`Symbol handlowy: ${d.tradeSymbol}`);
    if(d.rawMaterial)lines.push(`Surowiec: ${d.rawMaterial}`);
    if(recipe.target_color)lines.push(`Kolor: ${recipe.target_color}`);
    if(recipe.target_grammage!==null&&recipe.target_grammage!==undefined)lines.push(`Gramatura: ${recipe.target_grammage} g/m²${d.grammagePlus!==undefined||d.grammageMinus!==undefined?` (+${d.grammagePlus??'—'} / −${d.grammageMinus??'—'})`:''}`);
    if(d.widthMode==='range')lines.push(`Szerokość: ${d.widthMinimum??'—'}–${d.widthMaximum??'—'} cm`);
    else if(d.widthMode==='minimum')lines.push(`Szerokość: nie mniej niż ${d.widthMinimum??'—'} cm`);
    else if(d.widthMode==='needles'&&recipe.target_width_cm!==null&&recipe.target_width_cm!==undefined)lines.push(`Szerokość między igłami: ${recipe.target_width_cm} cm`);
    else if(recipe.target_width_cm!==null&&recipe.target_width_cm!==undefined)lines.push(`Szerokość: ${recipe.target_width_cm} cm`);
    if(d.brushing==='yes')lines.push('Drapanie: tak');
    if(d.brushingForVelcro==='yes')lines.push('Drapanie pod rzep: tak');
    if(d.stiffeningEnabled==='yes')lines.push(`Usztywnienie: tak${d.stiffeningDescription?` — ${d.stiffeningDescription}`:''}`);
    if(d.softeningEnabled==='yes')lines.push(`Zmiękczenie: tak${d.softeningDescription?` — ${d.softeningDescription}`:''}`);
    if(d.trimEdges==='yes')lines.push('Obcinanie brzegów: tak');
    if(d.bondEdges==='yes')lines.push('Podklejanie brzegów: tak');
    if(d.trimSygnits==='yes')lines.push('Obcinanie sygnitów: tak');
    for(const instruction of d.winding||[])if(instruction)lines.push(`Nawijanie: ${instruction}`);
    if(d.shrinkage)lines.push(`Kurczliwości: ${d.shrinkage}`);
    return lines.join('\n');
  };
  const update=db.prepare(`UPDATE finishing_recipes SET target_color=?,target_width_cm=?,target_grammage=?,target_stiffening=?,recipe_text=?,recipe_details=?,notes=?,updated_at=?,updated_by=NULL WHERE id=? AND active=1`);
  db.exec('BEGIN IMMEDIATE');
  try{
    const stamp=new Date().toISOString(),unmatched=[],ambiguous=[];
    let updated=0;
    for(const recipe of repair.recipes){
      const matches=byKey.get(key(recipe.name,recipe.raw_symbol))||[];
      if(matches.length===0){unmatched.push({source_row:recipe.source_row,name:recipe.name,raw_symbol:recipe.raw_symbol});continue;}
      if(matches.length!==1){ambiguous.push({source_row:recipe.source_row,name:recipe.name,raw_symbol:recipe.raw_symbol,ids:matches.map(row=>row.id)});continue;}
      const stiffening=recipe.recipe_details.stiffeningEnabled==='yes'?(recipe.recipe_details.stiffeningDescription||'tak'):'';
      update.run(recipe.target_color,recipe.target_width_cm,recipe.target_grammage,stiffening,summary(recipe),JSON.stringify(recipe.recipe_details),recipe.notes,stamp,matches[0].id);
      updated++;
    }
    const result={updated,unmatched,ambiguous,expected:repair.expected_recipes};
    db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)').run(stamp,'Migracja receptur wykańczania: dane uporządkowane',JSON.stringify(result));
    db.exec('PRAGMA user_version=14; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV15(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=15)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const receiptColumns=new Set(db.prepare("PRAGMA table_info('finishing_receipts')").all().map(column=>column.name));
    if(!receiptColumns.has('color_status'))db.exec("ALTER TABLE finishing_receipts ADD COLUMN color_status TEXT NOT NULL DEFAULT '' CHECK(color_status IN ('','ok','not_ok'))");
    if(!receiptColumns.has('stiffening_status'))db.exec("ALTER TABLE finishing_receipts ADD COLUMN stiffening_status TEXT NOT NULL DEFAULT '' CHECK(stiffening_status IN ('','ok','not_ok'))");
    const baleColumns=db.prepare("PRAGMA table_info('finishing_return_bales')").all();
    const meters=baleColumns.find(column=>column.name==='meters'),weight=baleColumns.find(column=>column.name==='weight_kg');
    if(meters?.notnull||weight?.notnull){
      db.exec(`CREATE TABLE finishing_return_bales_next(
        id INTEGER PRIMARY KEY,
        receipt_id INTEGER NOT NULL REFERENCES finishing_receipts(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        meters REAL CHECK(meters IS NULL OR meters > 0),
        weight_kg REAL CHECK(weight_kg IS NULL OR weight_kg > 0),
        UNIQUE(receipt_id,sequence)
      );
      INSERT INTO finishing_return_bales_next(id,receipt_id,sequence,meters,weight_kg)
        SELECT id,receipt_id,sequence,meters,weight_kg FROM finishing_return_bales;
      DROP TABLE finishing_return_bales;
      ALTER TABLE finishing_return_bales_next RENAME TO finishing_return_bales;
      CREATE INDEX finishing_return_bales_receipt ON finishing_return_bales(receipt_id,sequence);`);
    }
    db.exec('PRAGMA user_version=15; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV16(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=16)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const receiptColumns=new Set(db.prepare("PRAGMA table_info('finishing_receipts')").all().map(column=>column.name));
    for(const column of ['width_status','grammage_status'])if(!receiptColumns.has(column))db.exec(`ALTER TABLE finishing_receipts ADD COLUMN ${column} TEXT NOT NULL DEFAULT '' CHECK(${column} IN ('','ok','warning','danger'))`);
    const incidentColumns=new Set(db.prepare("PRAGMA table_info('finishing_incidents')").all().map(column=>column.name));
    const additions=[
      ['auto_generated','INTEGER NOT NULL DEFAULT 0 CHECK(auto_generated IN (0,1))'],
      ['lost_pieces','INTEGER NOT NULL DEFAULT 0 CHECK(lost_pieces >= 0)'],
      ['lost_weight_kg','REAL NOT NULL DEFAULT 0 CHECK(lost_weight_kg >= 0)'],
      ['found_at','TEXT'],['found_by','INTEGER REFERENCES users(id)'],['settled_at','TEXT'],['settled_by','INTEGER REFERENCES users(id)']
    ];
    for(const [column,definition] of additions)if(!incidentColumns.has(column))db.exec(`ALTER TABLE finishing_incidents ADD COLUMN ${column} ${definition}`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS finishing_auto_lost_batch ON finishing_incidents(batch_id) WHERE auto_generated=1 AND incident_type='lost' AND batch_id IS NOT NULL; PRAGMA user_version=16; COMMIT");
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV17(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=17)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_receipts')").all().map(column=>column.name));
    if(!columns.has('comment_consumed_at'))db.exec('ALTER TABLE finishing_receipts ADD COLUMN comment_consumed_at TEXT');
    if(!columns.has('comment_consumed_by'))db.exec('ALTER TABLE finishing_receipts ADD COLUMN comment_consumed_by INTEGER REFERENCES finishing_receipts(id)');
    db.exec('PRAGMA user_version=17; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
function migrateV18(db) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=19){migrateV20(db);return;}
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_receipts')").all().map(column=>column.name));
    if(!columns.has('process_checks'))db.exec("ALTER TABLE finishing_receipts ADD COLUMN process_checks TEXT NOT NULL DEFAULT '{}'");
    if(!columns.has('used_weight_kg'))db.exec('ALTER TABLE finishing_receipts ADD COLUMN used_weight_kg REAL NOT NULL DEFAULT 0 CHECK(used_weight_kg >= 0)');
    if(!columns.has('settlement_unit'))db.exec("ALTER TABLE finishing_receipts ADD COLUMN settlement_unit TEXT NOT NULL DEFAULT 'mb' CHECK(settlement_unit IN ('mb','kg'))");
    const batchColumns=new Set(db.prepare("PRAGMA table_info('finishing_batches')").all().map(column=>column.name));
    if(!batchColumns.has('correction_of_batch_id'))db.exec('ALTER TABLE finishing_batches ADD COLUMN correction_of_batch_id INTEGER REFERENCES finishing_batches(id)');
    if(!batchColumns.has('complaint_status'))db.exec("ALTER TABLE finishing_batches ADD COLUMN complaint_status TEXT NOT NULL DEFAULT 'normal' CHECK(complaint_status IN ('normal','reklamowana','poprawiona'))");
    db.exec('CREATE INDEX IF NOT EXISTS finishing_batches_correction ON finishing_batches(correction_of_batch_id,id)');
    db.exec('PRAGMA user_version=19; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
  migrateV20(db);
}
function migrateV20(db){
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>=20){db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));migrateV21(db);return;}
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_calculation_imports')").all().map(column=>column.name));
    if(!columns.has('calculation_date'))db.exec("ALTER TABLE finishing_calculation_imports ADD COLUMN calculation_date TEXT NOT NULL DEFAULT ''");
    db.prepare("UPDATE finishing_calculation_imports SET calculation_date='2026-09-22' WHERE calculation_date='' AND lower(source_name) LIKE '%kalkulacja2026%'").run();
    db.exec('PRAGMA user_version=20; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
  migrateV21(db);
}
function migrateV21(db){
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=21){migrateV22(db);return;}
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_batches')").all().map(column=>column.name));
    if(!columns.has('workflow_status'))db.exec("ALTER TABLE finishing_batches ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'normal' CHECK(workflow_status IN ('normal','do_poprawy','poprawka'))");
    db.exec('PRAGMA user_version=21; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
  migrateV22(db);
}
function migrateV22(db){
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=22){migrateV23(db);return;}
  db.exec('BEGIN IMMEDIATE');
  try{
    const columns=new Set(db.prepare("PRAGMA table_info('finishing_batches')").all().map(column=>column.name));
    if(!columns.has('correction_parent_batch_id'))db.exec('ALTER TABLE finishing_batches ADD COLUMN correction_parent_batch_id INTEGER REFERENCES finishing_batches(id)');
    if(!columns.has('correction_instruction'))db.exec("ALTER TABLE finishing_batches ADD COLUMN correction_instruction TEXT NOT NULL DEFAULT ''");
    if(!columns.has('correction_notes'))db.exec("ALTER TABLE finishing_batches ADD COLUMN correction_notes TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS finishing_batches_workflow_parent ON finishing_batches(correction_parent_batch_id,id); PRAGMA user_version=22; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
  migrateV23(db);
}
function migrateV23(db){
  const version=db.prepare('PRAGMA user_version').get().user_version;
  db.exec(fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8'));
  if(version>=23)return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const orderColumns=new Set(db.prepare("PRAGMA table_info('finishing_orders')").all().map(column=>column.name));
    if(!orderColumns.has('manual_entry'))db.exec('ALTER TABLE finishing_orders ADD COLUMN manual_entry INTEGER NOT NULL DEFAULT 0 CHECK(manual_entry IN (0,1))');
    if(!orderColumns.has('manual_input_description'))db.exec("ALTER TABLE finishing_orders ADD COLUMN manual_input_description TEXT NOT NULL DEFAULT ''");
    const batchColumns=new Set(db.prepare("PRAGMA table_info('finishing_batches')").all().map(column=>column.name));
    if(!batchColumns.has('correction_trade_symbol'))db.exec("ALTER TABLE finishing_batches ADD COLUMN correction_trade_symbol TEXT NOT NULL DEFAULT ''");
    if(!batchColumns.has('correction_target_color'))db.exec("ALTER TABLE finishing_batches ADD COLUMN correction_target_color TEXT NOT NULL DEFAULT ''");
    if(!batchColumns.has('correction_target_width_cm'))db.exec('ALTER TABLE finishing_batches ADD COLUMN correction_target_width_cm REAL');
    if(!batchColumns.has('correction_target_grammage'))db.exec('ALTER TABLE finishing_batches ADD COLUMN correction_target_grammage REAL');
    if(!batchColumns.has('cancelled_at'))db.exec('ALTER TABLE finishing_batches ADD COLUMN cancelled_at TEXT');
    if(!batchColumns.has('cancelled_by'))db.exec('ALTER TABLE finishing_batches ADD COLUMN cancelled_by INTEGER REFERENCES users(id)');
    const receiptColumns=new Set(db.prepare("PRAGMA table_info('finishing_receipts')").all().map(column=>column.name));
    if(!receiptColumns.has('incomplete'))db.exec('ALTER TABLE finishing_receipts ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0 CHECK(incomplete IN (0,1))');
    db.exec('PRAGMA user_version=23; COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
}
// All schema changes are transactional. The original database is snapshotted
// before changing legacy tables; IDs, approved payloads and issued HTML survive.
function migrate(db, dbPath) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const legacy = db.prepare('PRAGMA table_info(articles)').all();
  if (!legacy.length) { db.exec(schema); migrateStarterArticles(db); migrateV5(db); migrateV6(db); migrateV7(db); migrateV8(db); migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>23)throw new Error('Baza pochodzi z nowszej wersji programu.');
  if(version===23) { db.exec(schema); return; }
  if(version===22) { migrateV23(db); return; }
  if(version===21) { migrateV22(db); return; }
  if(version===20) { migrateV21(db); return; }
  if(version===19) { migrateV20(db); return; }
  if(version===18) { migrateV18(db); return; }
  if(version===17) { migrateV18(db); return; }
  if(version===16) { migrateV17(db); migrateV18(db); return; }
  if(version===15) { migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===14) { migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===13) { migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===12) { migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===11) { migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===10) { migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===9) { migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===8) { migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===7) { migrateV8(db); migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===6) { db.exec(schema); migrateV7(db); migrateV8(db); migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===5) { db.exec(schema); migrateV5(db); migrateV6(db); migrateV7(db); migrateV8(db); migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===4) { db.exec(schema); migrateV5(db); migrateV6(db); migrateV7(db); migrateV8(db); migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if(version===3) { db.exec(schema); migrateStarterArticles(db); migrateV5(db); migrateV6(db); migrateV7(db); migrateV8(db); migrateV9(db); migrateV10(db); migrateV11(db); migrateV12(db); migrateV13(db); migrateV14(db); migrateV15(db); migrateV16(db); migrateV17(db); migrateV18(db); return; }
  if (dbPath) {
    const backup = `${dbPath}.before-schema2-${Date.now()}.sqlite3`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    if (!legacy.some(c => c.name === 'category_id')) {
      for (const table of ['articles', 'records']) {
        const create = schema.split('\n').find(line => line.startsWith(`CREATE TABLE IF NOT EXISTS ${table}(`));
        db.exec(create.replace(`IF NOT EXISTS ${table}(`, `${table}_next(`));
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',');
        db.exec(`INSERT INTO ${table}_next(${cols}) SELECT ${cols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_next RENAME TO ${table};`);
      }
    }
    const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
    if (!projectColumns.some(c => c.name === 'archived_at')) db.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
    const recordColumns = db.prepare('PRAGMA table_info(records)').all();
    if (!recordColumns.some(c => c.name === 'archived_at')) db.exec('ALTER TABLE records ADD COLUMN archived_at TEXT');
    db.exec(schema);
    db.exec('CREATE INDEX IF NOT EXISTS projects_archived ON projects(archived_at,id); CREATE INDEX IF NOT EXISTS records_archived ON records(archived_at,id); PRAGMA user_version=4;');
    db.exec(`INSERT OR IGNORE INTO project_articles SELECT project_id,id FROM articles WHERE project_id IS NOT NULL;
      UPDATE articles SET created_at=coalesce((SELECT min(created_at) FROM records WHERE article_id=articles.id),(SELECT created_at FROM projects WHERE id=articles.project_id),strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE created_at='';
      UPDATE articles SET updated_at=coalesce((SELECT max(updated_at) FROM records WHERE article_id=articles.id),created_at) WHERE updated_at='';`);
    ensureStarterArticles(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migracja: niespójne powiązania danych. Cofnięto zmiany.');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
  migrateV5(db);
  migrateV6(db);
  migrateV7(db);
  migrateV8(db);
  migrateV9(db);
  migrateV10(db);
  migrateV11(db);
  migrateV12(db);
  migrateV13(db);
  migrateV14(db);
  migrateV15(db);
  migrateV16(db);
  migrateV17(db);
  migrateV18(db);
}
module.exports = { migrate };
