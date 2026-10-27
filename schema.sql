PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,login TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','technologist','approver','admin')),active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',conflict TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,archived_at TEXT,client_name TEXT NOT NULL DEFAULT '',workflow_status TEXT NOT NULL DEFAULT 'in_progress',comment TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS project_comments(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),author_user_id INTEGER REFERENCES users(id),author_name TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_comments_project ON project_comments(project_id,id);
CREATE TABLE IF NOT EXISTS articles(id INTEGER PRIMARY KEY,project_id INTEGER REFERENCES projects(id),symbol TEXT NOT NULL,symbol_key TEXT NOT NULL,active_spec INTEGER,category_id INTEGER REFERENCES categories(id),created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',pending_production_notes TEXT NOT NULL DEFAULT '',UNIQUE(project_id,symbol_key));
CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY,project_id INTEGER REFERENCES projects(id),article_id INTEGER REFERENCES articles(id),kind TEXT NOT NULL CHECK(kind IN ('trial','spec')),symbol TEXT NOT NULL,number TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted','approved')),revision INTEGER NOT NULL DEFAULT 1,version INTEGER,base_id INTEGER REFERENCES records(id),expected_active INTEGER,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,approved_at TEXT,approved_by INTEGER REFERENCES users(id),review_note TEXT NOT NULL DEFAULT '',archived_at TEXT,UNIQUE(article_id,version));
CREATE INDEX IF NOT EXISTS records_project ON records(project_id,kind,state);
CREATE INDEX IF NOT EXISTS records_symbol ON records(symbol);
CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY,record_id INTEGER NOT NULL REFERENCES records(id),machine TEXT NOT NULL,instructions TEXT NOT NULL,created_at TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),token TEXT UNIQUE NOT NULL,snapshot TEXT NOT NULL,html TEXT NOT NULL,production_notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,user_id INTEGER REFERENCES users(id),action TEXT NOT NULL,record_id INTEGER,detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until REAL NOT NULL);
CREATE TRIGGER IF NOT EXISTS approved_no_update BEFORE UPDATE ON records WHEN OLD.state='approved' BEGIN SELECT RAISE(ABORT,'Approved record is immutable'); END;
CREATE TRIGGER IF NOT EXISTS approved_no_delete BEFORE DELETE ON records WHEN OLD.state='approved' BEGIN SELECT RAISE(ABORT,'Approved record is immutable'); END;
CREATE TRIGGER IF NOT EXISTS card_no_update BEFORE UPDATE ON cards BEGIN SELECT RAISE(ABORT,'Issued card is immutable'); END;
CREATE TRIGGER IF NOT EXISTS card_no_delete BEFORE DELETE ON cards BEGIN SELECT RAISE(ABORT,'Issued card is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is immutable'); END;
CREATE TABLE IF NOT EXISTS audit_articles(audit_id INTEGER NOT NULL REFERENCES audit(id),article_id INTEGER NOT NULL REFERENCES articles(id),PRIMARY KEY(audit_id,article_id));

CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES categories(id),name TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS categories_name ON categories(coalesce(parent_id,0),name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS project_articles(project_id INTEGER NOT NULL REFERENCES projects(id),article_id INTEGER NOT NULL REFERENCES articles(id),PRIMARY KEY(project_id,article_id));
CREATE TABLE IF NOT EXISTS project_stages(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),stage_no INTEGER NOT NULL,description TEXT NOT NULL DEFAULT '',article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,stage_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','sent_finishing','sample_at_client','accepted_internal','accepted_client')),stage_status TEXT NOT NULL DEFAULT 'in_progress',comment TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,UNIQUE(project_id,stage_no));
CREATE TABLE IF NOT EXISTS project_stage_comments(id INTEGER PRIMARY KEY,stage_id INTEGER NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,author_user_id INTEGER REFERENCES users(id),author_name TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_stage_comments_stage ON project_stage_comments(stage_id,id);
CREATE TABLE IF NOT EXISTS project_stage_articles(stage_id INTEGER NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,article_id INTEGER NOT NULL REFERENCES articles(id),record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,created_at TEXT NOT NULL,PRIMARY KEY(stage_id,article_id),UNIQUE(record_id));
CREATE TABLE IF NOT EXISTS project_trial_sequences(year INTEGER PRIMARY KEY,last_value INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS project_articles_article ON project_articles(article_id);
CREATE INDEX IF NOT EXISTS project_stages_project ON project_stages(project_id,stage_no);
CREATE INDEX IF NOT EXISTS project_stage_articles_article ON project_stage_articles(article_id,stage_id);
CREATE INDEX IF NOT EXISTS audit_articles_article ON audit_articles(article_id,audit_id);
CREATE INDEX IF NOT EXISTS articles_category ON articles(category_id);
CREATE INDEX IF NOT EXISTS articles_created ON articles(created_at,id);
CREATE INDEX IF NOT EXISTS articles_symbol ON articles(symbol_key);
CREATE INDEX IF NOT EXISTS records_article ON records(article_id,updated_at);
CREATE INDEX IF NOT EXISTS projects_archived ON projects(archived_at,id);
CREATE INDEX IF NOT EXISTS records_archived ON records(archived_at,id);
CREATE INDEX IF NOT EXISTS cards_record ON cards(record_id,id);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY,article_id INTEGER REFERENCES articles(id),record_id INTEGER REFERENCES records(id),project_id INTEGER REFERENCES projects(id),file TEXT NOT NULL UNIQUE,caption TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),CHECK((article_id IS NOT NULL)+(record_id IS NOT NULL)+(project_id IS NOT NULL)=1));
CREATE INDEX IF NOT EXISTS photos_article ON photos(article_id);
CREATE INDEX IF NOT EXISTS photos_record ON photos(record_id);

CREATE TABLE IF NOT EXISTS finishing_recipes(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  finishing_plant_id INTEGER REFERENCES finishing_plants(id),
  raw_symbol TEXT NOT NULL DEFAULT '',
  recipe_text TEXT NOT NULL DEFAULT '',
  target_color TEXT NOT NULL DEFAULT '',
  target_stiffening TEXT NOT NULL DEFAULT '',
  target_width_cm REAL,
  target_grammage REAL,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finishing_recipes_search ON finishing_recipes(active,finishing_plant_id,name);
CREATE INDEX IF NOT EXISTS finishing_recipes_symbol ON finishing_recipes(raw_symbol);

CREATE TABLE IF NOT EXISTS finishing_orders(
  id INTEGER PRIMARY KEY,
  shipment_article_id INTEGER REFERENCES shipment_articles(id),
  finishing_plant_id INTEGER REFERENCES finishing_plants(id),
  source_shipment_no TEXT NOT NULL DEFAULT '',
  source_shipment_date TEXT NOT NULL DEFAULT '',
  raw_symbol TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  trade_symbol TEXT NOT NULL DEFAULT '',
  recipe_id INTEGER REFERENCES finishing_recipes(id),
  recipe_snapshot TEXT NOT NULL DEFAULT '{}',
  target_color TEXT NOT NULL DEFAULT '',
  target_stiffening TEXT NOT NULL DEFAULT '',
  target_width_cm REAL,
  target_grammage REAL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','partial','received','raw_sale','cancelled')),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finishing_orders_status ON finishing_orders(status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS finishing_orders_source ON finishing_orders(shipment_article_id,id);
CREATE INDEX IF NOT EXISTS finishing_orders_symbol ON finishing_orders(raw_symbol);

CREATE TABLE IF NOT EXISTS finishing_batches(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES finishing_orders(id) ON DELETE CASCADE,
  finishing_lot TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL,
  sent_pieces INTEGER NOT NULL CHECK(sent_pieces >= 0),
  raw_weight_kg REAL NOT NULL CHECK(raw_weight_kg >= 0),
  yarn_lot TEXT NOT NULL DEFAULT '',
  closed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finishing_batches_order ON finishing_batches(order_id,id);
CREATE INDEX IF NOT EXISTS finishing_batches_lot ON finishing_batches(finishing_lot);

CREATE TABLE IF NOT EXISTS finishing_receipts(
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES finishing_batches(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  raw_pieces_received INTEGER NOT NULL DEFAULT 0 CHECK(raw_pieces_received >= 0),
  finished_pieces INTEGER NOT NULL DEFAULT 0 CHECK(finished_pieces >= 0),
  finished_weight_kg REAL NOT NULL DEFAULT 0 CHECK(finished_weight_kg >= 0),
  finished_meters REAL NOT NULL DEFAULT 0 CHECK(finished_meters >= 0),
  actual_color TEXT NOT NULL DEFAULT '',
  actual_stiffening TEXT NOT NULL DEFAULT '',
  actual_width_cm REAL,
  actual_grammage REAL,
  rubbing_status TEXT NOT NULL DEFAULT '' CHECK(rubbing_status IN ('','ok','not_ok')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finishing_receipts_batch ON finishing_receipts(batch_id,received_at,id);

CREATE TABLE IF NOT EXISTS finishing_return_bales(
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES finishing_receipts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  meters REAL NOT NULL CHECK(meters > 0),
  weight_kg REAL NOT NULL CHECK(weight_kg > 0),
  UNIQUE(receipt_id,sequence)
);
CREATE INDEX IF NOT EXISTS finishing_return_bales_receipt ON finishing_return_bales(receipt_id,sequence);

CREATE TABLE IF NOT EXISTS finishing_incidents(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES finishing_orders(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES finishing_batches(id),
  incident_type TEXT NOT NULL CHECK(incident_type IN ('lost','wrong_order','correction','count_difference','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finishing_incidents_order ON finishing_incidents(order_id,status,id);

CREATE TABLE IF NOT EXISTS finishing_import_runs(
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  imported_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  imported_by INTEGER REFERENCES users(id)
);
