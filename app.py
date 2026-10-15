from pathlib import Path
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import json, os, sqlite3, secrets, hmac, time, unicodedata, base64, hashlib
from contextlib import contextmanager
from functools import wraps
from flask import Flask, g, request, session, redirect, url_for, render_template, abort, flash, send_from_directory
from werkzeug.security import check_password_hash

ROOT=Path(__file__).resolve().parent
TECH=[('machine_type','Typ maszyny'),('gauge','Podział maszyny'),('density','Ścisłość dziania (ocz/cm)'),('working_width','Szerokość robocza (cale)'),('panels','Liczba szali'),('distance','Ustawienie dystansu'),('speed','Prędkość (obr./min)'),('roll_length','Domyślna długość belki (m)')]
METRICS=[('weight','Gramatura (g/m²)'),('width','Szerokość luźna (cm)'),('roll_width','Szerokość na tulei (cm)'),('pk','Pk (ocz/cm)'),('pr','Pr (ocz/cm)'),('thickness','Grubość / dystans (mm)')]
GB=[('number','GB'),('yarn','Rodzaj przędzy'),('threads','Liczba nici'),('run_in','Wrobienie (z jednostką)'),('threading','Nawleczenie'),('pattern','Raport ogniw wzorujących'),('notes','Uwagi')]

def now(): return datetime.now(timezone.utc).isoformat(timespec='seconds')
def normalize(s): return ''.join(c for c in unicodedata.normalize('NFD',s.lower().replace('ł','l')) if unicodedata.category(c)!='Mn')
def dump(v): return json.dumps(v,ensure_ascii=False)
def blank(): return dict(symbol='',number='',date='',client='',description='',tech={},gb=[],raw={},raw_comments='',finished=[],comments='',stages='',targets={},tolerances={},knitter_notes='',sources=[])
def connect(path):
 c=sqlite3.connect(path,timeout=15,isolation_level=None);c.row_factory=sqlite3.Row
 c.execute('PRAGMA foreign_keys=ON');c.execute('PRAGMA busy_timeout=15000');return c

def create_app(config=None):
 app=Flask(__name__)
 data=Path(os.environ.get('MARAND_DATA',ROOT/'data'));data.mkdir(parents=True,exist_ok=True)
 key=data/'secret.key'
 app.config.update(DATABASE=str(data/'marand.sqlite3'),SECRET_KEY=os.environ.get('MARAND_SECRET') or (key.read_text() if key.exists() else None),MAX_CONTENT_LENGTH=1024*1024,SESSION_COOKIE_HTTPONLY=True,SESSION_COOKIE_SAMESITE='Lax',SESSION_COOKIE_SECURE=os.environ.get('MARAND_HTTPS')=='1',PERMANENT_SESSION_LIFETIME=timedelta(hours=8))
 if config:app.config.update(config)
 if not app.config['SECRET_KEY']:raise RuntimeError('Najpierw uruchom: python manage.py init')
 def db():
  if 'db' not in g:g.db=connect(app.config['DATABASE'])
  return g.db
 @app.teardown_appcontext
 def close(exc):
  if 'db' in g:g.db.close()
 @contextmanager
 def tx():
  c=db();c.execute('BEGIN IMMEDIATE')
  try:yield c;c.commit()
  except BaseException:c.rollback();raise
 def audit(action,rid=None,detail=''):
  db().execute('INSERT INTO audit(at,user_id,action,record_id,detail) VALUES(?,?,?,?,?)',(now(),g.user['id'] if g.user else None,action,rid,detail))
 def csrf():
  if 'csrf' not in session:session['csrf']=secrets.token_urlsafe(32)
  return session['csrf']
 @app.before_request
 def auth():
  g.user=None
  if request.endpoint=='healthz':return
  if (Path(app.config['DATABASE']).parent/'maintenance.json').exists():
   return 'Trwa aktualizacja programu. Wroc za kilka minut; dane pozostaja zachowane.',503
  if session.get('uid'):g.user=db().execute('SELECT * FROM users WHERE id=? AND active=1',(session['uid'],)).fetchone()
  if request.method=='POST' and not hmac.compare_digest(str(session.get('csrf','')),str(request.form.get('csrf',''))) :abort(400,'Sesja formularza wygasła. Odśwież stronę.')
  if request.method=='POST' and not session.get('csrf'):abort(400)
  if request.endpoint not in ('login','static') and not g.user:return redirect(url_for('login'))
 @app.after_request
 def headers(r):
  r.headers['X-Content-Type-Options']='nosniff';r.headers['X-Frame-Options']='DENY';r.headers['Referrer-Policy']='same-origin';r.headers['Cache-Control']='no-store'
  r.headers['Content-Security-Policy']="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
  return r
 def roles(*allowed):
  def deco(f):
   @wraps(f)
   def wrapped(*a,**kw):
    if not g.user or g.user['role'] not in allowed:abort(403,'Brak uprawnień do tej operacji.')
    return f(*a,**kw)
   return wrapped
  return deco
 def record(rid):
  r=db().execute('SELECT r.*,p.name project_name,a.active_spec,p.conflict FROM records r JOIN projects p ON p.id=r.project_id LEFT JOIN articles a ON a.id=r.article_id WHERE r.id=?',(rid,)).fetchone()
  if not r:abort(404)
  return dict(r)
 def payload(r):return json.loads(r['payload'])
 def article(pid,symbol):
  key=''.join(symbol.upper().split())
  a=db().execute('SELECT * FROM articles WHERE project_id=? AND symbol_key=?',(pid,key)).fetchone()
  if not a:
   aid=db().execute('INSERT INTO articles(project_id,symbol,symbol_key) VALUES(?,?,?)',(pid,symbol,key)).lastrowid
   a=db().execute('SELECT * FROM articles WHERE id=?',(aid,)).fetchone()
  return a
 def project(pid):
  p=db().execute('SELECT * FROM projects WHERE id=?',(pid,)).fetchone()
  if not p:abort(404)
  return p
 def stale(r):
  if str(r['revision'])!=request.form.get('revision'):abort(409,'Ktoś zapisał nowszą wersję. Wróć do formularza, zachowaj własne uwagi i wczytaj aktualne dane.')
 def source_files(p):return p.get('sources',[])
 @app.template_filter('datepl')
 def datepl(s):
  if not s:return '—'
  try:return datetime.fromisoformat(s).astimezone(ZoneInfo('Europe/Warsaw')).strftime('%d.%m.%Y %H:%M')
  except ValueError:return s
 @app.context_processor
 def context():return dict(csrf=csrf,TECH=TECH,METRICS=METRICS,GB=GB,labels={'draft':'Robocza','submitted':'Do zatwierdzenia','approved':'Zatwierdzona'},can_edit=bool(g.user and g.user['role'] in ('technologist','approver','admin')),can_approve=bool(g.user and g.user['role'] in ('approver','admin')))
 @app.route('/login',methods=['GET','POST'])
 def login():
  if request.method=='POST':
   login=request.form.get('login','').strip().lower();k=login+'|'+str(request.remote_addr);at=time.time()
   with tx():
    a=db().execute('SELECT * FROM login_attempts WHERE key=?',(k,)).fetchone()
    if a and a['count']>=8 and a['until']>at:abort(429,'Za dużo prób logowania. Spróbuj za 15 minut.')
    u=db().execute('SELECT * FROM users WHERE login=? AND active=1',(login,)).fetchone()
    if u and check_password_hash(u['password'],request.form.get('password','')):
     db().execute('DELETE FROM login_attempts WHERE key=?',(k,));session.clear();session['uid']=u['id'];session.permanent=True
     return redirect(url_for('home'))
    count=(a['count']+1) if a and a['until']>at else 1
    db().execute('INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)',(k,count,at+900))
   flash('Nieprawidłowy login lub hasło.','error')
  return render_template('login.html')
 @app.post('/logout')
 def logout():session.clear();return redirect(url_for('login'))
 @app.get('/healthz')
 def healthz():
  if request.remote_addr not in ('127.0.0.1','::1'):abort(404)
  path=Path(app.config['DATABASE'])
  if not path.is_file():return {'ok':False},503
  try:
   db().execute('SELECT id FROM users LIMIT 1').fetchone()
   if db().execute('PRAGMA quick_check').fetchone()[0]!='ok':return {'ok':False},503
  except sqlite3.Error:return {'ok':False},503
  return {'ok':True,'version':'0.1.1','data_tag':hashlib.sha256(os.path.normcase(str(path.parent.resolve())).encode()).hexdigest()}
 @app.get('/')
 def home():
  q=request.args.get('q','').strip();state=request.args.get('state','');page=max(1,int(request.args.get('page','1')) if request.args.get('page','1').isdigit() else 1)
  rows=db().execute('SELECT p.*,(SELECT count(*) FROM articles a WHERE a.project_id=p.id AND a.active_spec IS NOT NULL) active_spec,count(r.id) total,max(r.updated_at) updated,group_concat(r.symbol, " | ") symbols FROM projects p LEFT JOIN records r ON p.id=r.project_id GROUP BY p.id ORDER BY updated DESC,p.id DESC').fetchall()
  rows=[r for r in rows if all(w in normalize(r['name']+' '+(r['symbols'] or '')+' '+r['description']) for w in normalize(q).split()) and (state!='approved' or r['active_spec']) and (state!='pending' or not r['active_spec'])]
  status_path=Path(app.config['DATABASE']).parent/'backup_status.json'
  backup_state=None
  if status_path.exists():
   try:
    backup_state=json.loads(status_path.read_text(encoding='utf-8'))
    stamp=backup_state.get('last_success')
    backup_state['stale']=not stamp or (datetime.now(timezone.utc)-datetime.fromisoformat(stamp)).total_seconds()>36*3600
   except (ValueError,TypeError):backup_state={'ok':False,'stale':True}
  return render_template('home.html',backup_state=backup_state,projects=rows[(page-1)*15:page*15],total=len(rows),page=page,q=q,state=state)
 @app.post('/projects')
 @roles('technologist','approver','admin')
 def new_project():
  name=request.form.get('name','').strip()
  if not name or len(name)>150:abort(400,'Podaj nazwę projektu (do 150 znaków).')
  with tx():
   if db().execute('SELECT 1 FROM projects WHERE lower(name)=lower(?)',(name,)).fetchone():abort(409,'Taki projekt już istnieje.')
   pid=db().execute('INSERT INTO projects(name,created_at) VALUES(?,?)',(name,now())).lastrowid;audit('Utworzono projekt',detail=name)
  return redirect(url_for('project_view',pid=pid))
 @app.get('/projects/<int:pid>')
 def project_view(pid):
  p=project(pid);rs=db().execute('SELECT r.*,CASE WHEN a.active_spec=r.id THEN 1 ELSE 0 END is_current FROM records r LEFT JOIN articles a ON a.id=r.article_id WHERE r.project_id=? ORDER BY r.id DESC',(pid,)).fetchall()
  cards=db().execute('SELECT c.*,u.name author FROM cards c JOIN records r ON r.id=c.record_id JOIN users u ON u.id=c.created_by WHERE r.project_id=? ORDER BY c.id DESC',(pid,)).fetchall()
  return render_template('project.html',p=p,records=rs,cards=cards)
 @app.post('/projects/<int:pid>/new')
 @roles('technologist','approver','admin')
 def new_record(pid):
  p=project(pid);kind=request.form.get('kind','trial')
  if kind not in ('trial','spec'):abort(400)
  v=blank();v['date']=datetime.now(ZoneInfo('Europe/Warsaw')).date().isoformat()
  with tx():
   a=article(pid,p['name']) if kind=='spec' else None
   rid=db().execute('INSERT INTO records(project_id,article_id,kind,symbol,payload,created_at,updated_at,expected_active) VALUES(?,?,?,?,?,?,?,?)',(pid,a['id'] if a else None,kind,p['name'],dump(v),now(),now(),a['active_spec'] if a else None)).lastrowid;audit('Utworzono wpis',rid)
  return redirect(url_for('edit',rid=rid))
 @app.get('/records/<int:rid>')
 def view(rid):
  r=record(rid);history=db().execute('SELECT a.*,u.name author FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE record_id=? ORDER BY a.id DESC',(rid,)).fetchall()
  return render_template('record.html',r=r,v=payload(r),history=history)
 def parse_form(old):
  v=blank();v['sources']=old.get('sources',[]);v['source_note']=old.get('source_note','')
  for k in ['symbol','number','date','client','description','raw_comments','comments','stages','knitter_notes']:v[k]=request.form.get(k,'').strip()
  if not v['symbol']:abort(400,'Symbol artykułu jest wymagany.')
  for group,keys in [('tech',TECH),('raw',METRICS),('targets',METRICS),('tolerances',METRICS)]:v[group]={k:request.form.get(group+'_'+k,'').strip() for k,_ in keys}
  numbers=[]
  for i in range(12):
   row={k:request.form.get(f'gb_{i}_{k}','').strip() for k,_ in GB}
   if any(row.values()):
    if not row['number'].isdigit() or not 1<=int(row['number'])<=32:abort(400,'Numer GB musi być liczbą od 1 do 32.')
    if row['number'] in numbers:abort(400,'Numer GB nie może się powtarzać.')
    numbers.append(row['number']);v['gb'].append(row)
  for i in range(3):
   f={k:request.form.get(f'finish_{i}_{k}','').strip() for k in ('name','weight','width','pk','pr','thickness','finish','comments')}
   if any(f.values()):v['finished'].append(f)
  if sum(len(str(x)) for x in v.values())>120000:abort(400,'Wpis jest zbyt długi.')
  return v
 @app.route('/records/<int:rid>/edit',methods=['GET','POST'])
 @roles('technologist','approver','admin')
 def edit(rid):
  r=record(rid)
  if r['state']!='draft':abort(409,'Ta wersja jest zablokowana. Utwórz nową wersję albo wycofaj wniosek o zatwierdzenie.')
  if request.method=='POST':
   with tx():
    r=record(rid);stale(r)
    if r['state']!='draft':abort(409,'Wpis jest już zablokowany.')
    v=parse_form(payload(r));v['date']=payload(r).get('date') or v['date']
    a=article(r['project_id'],v['symbol']) if r['kind']=='spec' else None
    expected=a['active_spec'] if a and a['id']!=r['article_id'] else r['expected_active']
    db().execute('UPDATE records SET symbol=?,number=?,payload=?,article_id=?,expected_active=?,updated_at=?,revision=revision+1 WHERE id=?',(v['symbol'],v['number'],dump(v),a['id'] if a else None,expected,now(),rid));audit('Zapisano zmiany',rid,dump({'before':payload(r),'after':v}))
   flash('Zapisano zmiany.','success');return redirect(url_for('view',rid=rid))
  return render_template('edit.html',r=r,v=payload(r))
 @app.post('/records/<int:rid>/copy')
 @roles('technologist','approver','admin')
 def copy_record(rid):
  with tx():
   r=record(rid);v=payload(r);kind=request.form.get('kind','trial')
   if kind not in ('trial','spec'):abort(400)
   if kind=='trial':
    v.update(raw={},raw_comments='',finished=[],comments='',stages='',targets={},tolerances={},number='',date=datetime.now(ZoneInfo('Europe/Warsaw')).date().isoformat())
   a=article(r['project_id'],r['symbol']) if kind=='spec' else None
   nid=db().execute('INSERT INTO records(project_id,article_id,kind,symbol,number,base_id,expected_active,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(r['project_id'],a['id'] if a else None,kind,r['symbol'],v.get('number',''),rid,a['active_spec'] if a else None,dump(v),now(),now())).lastrowid
   audit('Utworzono '+('wariant próby' if kind=='trial' else 'roboczą specyfikację'),nid,'Na podstawie wpisu '+str(rid))
  return redirect(url_for('edit',rid=nid))
 def ready(r):
  v=payload(r)
  if not r['symbol'] or not v['gb']:abort(400,'Uzupełnij symbol i przynajmniej jedną GB.')
  if any(not v['tech'].get(k) for k in ('machine_type','gauge','density','working_width','panels')):abort(400,'Uzupełnij typ i podział maszyny, ścisłość, szerokość roboczą i liczbę szali.')
  if any(any(not row.get(k) for k in ('number','yarn','threads','run_in','threading','pattern')) for row in v['gb']):abort(400,'Uzupełnij przędzę, liczbę nici, wrobienie, nawleczenie i raport dla każdej używanej GB.')
  if any(not v['targets'].get(k) or not v['tolerances'].get(k) for k in ('weight','width')):abort(400,'Uzupełnij docelową gramaturę, szerokość luźną i ich tolerancje. Nie przepisujemy automatycznie pomiarów z prób.')
 @app.post('/records/<int:rid>/submit')
 @roles('technologist','approver','admin')
 def submit(rid):
  with tx():
   r=record(rid);stale(r)
   if r['kind']!='spec' or r['state']!='draft':abort(409)
   ready(r);db().execute("UPDATE records SET state='submitted',revision=revision+1,updated_at=? WHERE id=?",(now(),rid));audit('Przekazano do zatwierdzenia',rid)
  return redirect(url_for('view',rid=rid))
 @app.post('/records/<int:rid>/withdraw')
 @roles('technologist','approver','admin')
 def withdraw(rid):
  with tx():
   r=record(rid);stale(r)
   if r['state']!='submitted':abort(409)
   db().execute("UPDATE records SET state='draft',revision=revision+1,updated_at=? WHERE id=?",(now(),rid));audit('Wycofano do poprawy',rid)
  return redirect(url_for('view',rid=rid))
 @app.post('/records/<int:rid>/approve')
 @roles('approver','admin')
 def approve(rid):
  note=request.form.get('review_note','').strip()
  with tx():
   r=record(rid);stale(r)
   if r['kind']!='spec' or r['state']!='submitted':abort(409)
   ready(r)
   if not request.form.get('checked') or len(note)<10:abort(400,'Potwierdź sprawdzenie i opisz decyzję (minimum 10 znaków).')
   if r['active_spec']!=r['expected_active']:abort(409,'W międzyczasie zatwierdzono inną specyfikację. Utwórz nową wersję na podstawie aktualnej i porównaj zmiany.')
   version=db().execute('SELECT coalesce(max(version),0)+1 FROM records WHERE article_id=?',(r['article_id'],)).fetchone()[0]
   db().execute("UPDATE records SET state='approved',version=?,approved_at=?,approved_by=?,review_note=?,updated_at=?,revision=revision+1 WHERE id=?",(version,now(),g.user['id'],note,now(),rid))
   db().execute('UPDATE articles SET active_spec=? WHERE id=?',(rid,r['article_id']));audit('Zatwierdzono specyfikację',rid,note)
  flash('Zatwierdzono wersję '+str(version)+'.','success');return redirect(url_for('view',rid=rid))
 def card_html(r,v,machine,instructions,cardno,issued_at,author):
  return render_template('card.html',r=r,v=v,machine=machine,instructions=instructions,cardno=cardno,issued_at=issued_at,author=author,logo=base64.b64encode((ROOT/'static/logo.jpg').read_bytes()).decode(),printcss=(ROOT/'static/card.css').read_text())
 @app.get('/records/<int:rid>/preview')
 def preview(rid):
  r=record(rid);return card_html(r,payload(r),'—','Podgląd danych. Karta niewydana.',None,now(),g.user['name'])
 @app.route('/records/<int:rid>/issue',methods=['GET','POST'])
 @roles('technologist','approver','admin')
 def issue(rid):
  r=record(rid)
  if request.method=='POST':
   token=request.form.get('token','');machine=request.form.get('machine','').strip();instructions=request.form.get('instructions','').strip()
   if not machine or not instructions or len(token)<20:abort(400,'Podaj maszynę i polecenia do tej produkcji.')
   if len(machine)>100 or len(instructions)>6000:abort(400,'Skróć nazwę maszyny lub instrukcje.')
   with tx():
    existing=db().execute('SELECT id,record_id,created_by FROM cards WHERE token=?',(token,)).fetchone()
    if existing:
     if existing['record_id']!=rid or existing['created_by']!=g.user['id']:abort(409)
     return redirect(url_for('card_view',cid=existing['id']))
    r=record(rid)
    if r['state']!='approved' or r['active_spec']!=rid:abort(409,'Można wydać wyłącznie aktualną zatwierdzoną wersję. Otwórz aktualną kartę artykułu.')
    v=payload(r);stamp=now();cid=db().execute('INSERT INTO cards(record_id,machine,instructions,created_at,created_by,token,snapshot,html) VALUES(?,?,?,?,?,?,?,?)',(rid,machine,instructions,stamp,g.user['id'],token,dump({'record':r,'data':v,'author':g.user['name']}),card_html(r,v,machine,instructions,'K-'+stamp[:10]+'-'+token[:8],stamp,g.user['name']))).lastrowid
    # HTML already immutable. Permanent visible identifier uses random token prefix, not mutable row data.
    audit('Wydano kartę na maszynę',rid,'Karta '+str(cid)+' / '+machine+' / '+instructions)
   return redirect(url_for('card_view',cid=cid))
  if r['state']!='approved' or r['active_spec']!=rid:abort(409,'Najpierw zatwierdź aktualną specyfikację.')
  return render_template('issue.html',r=r,token=secrets.token_urlsafe(24))
 @app.get('/cards/<int:cid>')
 def card_view(cid):
  c=db().execute('SELECT * FROM cards WHERE id=?',(cid,)).fetchone()
  if not c:abort(404)
  return c['html']
 @app.get('/sources/<path:name>')
 def source(name):return send_from_directory(ROOT/'seed/sources',name,as_attachment=True)
 @app.errorhandler(400)
 @app.errorhandler(403)
 @app.errorhandler(404)
 @app.errorhandler(409)
 @app.errorhandler(429)
 def error(e):return render_template('error.html',error=e),e.code
 @app.errorhandler(sqlite3.OperationalError)
 def busy(e):
  app.logger.exception('Błąd bazy danych')
  return render_template('error.html',error='Nie udało się wykonać zapisu. Odczekaj chwilę i spróbuj ponownie; nie zamykaj formularza.'),503
 return app
