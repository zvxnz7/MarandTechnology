import json,sqlite3,sys,re
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_app,connect,ROOT
from manage import init,add_user
@pytest.fixture
def env(tmp_path):
 c=init(tmp_path)
 for role in ['admin','technologist','approver','viewer']:add_user(c,role,role,role,'a-test-password-123')
 c.close();app=create_app({'TESTING':True,'DATABASE':str(tmp_path/'marand.sqlite3'),'SECRET_KEY':'test-only-secret'})
 return app,tmp_path

def client(env,role='admin'):
 app,path=env;cl=app.test_client();cl.get('/login')
 with cl.session_transaction() as s:token=s['csrf']
 assert cl.post('/login',data={'csrf':token,'login':role,'password':'a-test-password-123'}).status_code==302
 cl.get('/')
 return cl

def post(cl,url,data=None):
 with cl.session_transaction() as s:token=s['csrf']
 return cl.post(url,data=dict(csrf=token,**(data or {})))
def conn(env):return connect(env[1]/'marand.sqlite3')
def rec(env,rid):
 with conn(env) as c:return dict(c.execute('SELECT * FROM records WHERE id=?',(rid,)).fetchone())
def form(env,rid):
 r=rec(env,rid);v=json.loads(r['payload']);f={k:v.get(k,'') for k in ['symbol','number','date','client','description','raw_comments','comments','stages','knitter_notes']};f['revision']=str(r['revision'])
 for group in ['tech','raw','targets','tolerances']:
  for k,val in v[group].items():f[group+'_'+k]=val
 for i,gb in enumerate(v['gb']):
  for k,val in gb.items():f[f'gb_{i}_{k}']=val
 for i,ff in enumerate(v['finished']):
  for k,val in ff.items():f[f'finish_{i}_{k}']=val
 return f

def approve(env,cl,rid=14):
 f=form(env,rid);f.update(targets_weight='1000',tolerances_weight='±5%',targets_width='127',tolerances_width='±2 cm',tech_machine_type='LIBA')
 assert post(cl,f'/records/{rid}/edit',f).status_code==302
 assert post(cl,f'/records/{rid}/submit',{'revision':str(rec(env,rid)['revision'])}).status_code==302
 assert post(cl,f'/records/{rid}/approve',{'revision':str(rec(env,rid)['revision']),'checked':'on','review_note':'Sprawdzono źródła. Uzgodniono dane do testu.'}).status_code==302

def test_seed_and_views(env):
 cl=client(env)
 with conn(env) as c:
  assert c.execute('SELECT count(*) FROM records').fetchone()[0]==15
  assert c.execute("SELECT count(*) FROM records WHERE state='approved'").fetchone()[0]==0
  assert c.execute("SELECT count(*) FROM records WHERE number='15B’2026'").fetchone()[0]==1
 for path in ['/','/?q=PT+WZ','/projects/1','/projects/2']+[f'/records/{i}' for i in range(1,16)]+['/records/14/edit','/records/14/preview']:
  r=cl.get(path);assert r.status_code==200,(path,r.data[:400])
 assert b'Brak wynik' in cl.get('/?q=not-found').data
 v=json.loads(rec(env,14)['payload']);assert v['tech']['speed']=='360';assert v['gb'][2]['threads']=='3*280'
 assert cl.get('/sources/'+v['sources'][0]['file']).status_code==200
 assert cl.get('/sources/../../app.py').status_code==404

def test_auth_csrf_roles(env):
 app,_=env;anon=app.test_client()
 assert anon.get('/projects/1').status_code==302
 assert anon.post('/projects',data={'name':'x'}).status_code==400
 viewer=client(env,'viewer');tech=client(env,'technologist')
 assert post(viewer,'/projects',{'name':'Forbidden'}).status_code==403
 assert post(tech,'/records/14/approve',{}).status_code==403
 assert viewer.get('/records/14/edit').status_code==403
 assert tech.post('/projects',data={'name':'No CSRF'}).status_code==400

def test_concurrent_edit_and_dates(env):
 a=client(env);b=client(env,'technologist');f=form(env,1);old=rec(env,1)
 f['raw_weight']='101';assert post(a,'/records/1/edit',f).status_code==302
 f['raw_weight']='999';assert post(b,'/records/1/edit',f).status_code==409
 r=rec(env,1);assert json.loads(r['payload'])['raw']['weight']=='101';assert r['created_at']==old['created_at']
 f=form(env,1);f['date']='2099-01-01';assert post(a,'/records/1/edit',f).status_code==302
 assert json.loads(rec(env,1)['payload'])['date']==json.loads(old['payload'])['date']

def test_approval_and_issued_snapshot(env):
 cl=client(env)
 assert post(cl,'/records/14/issue',{'machine':'12','instructions':'x','token':'q'*32}).status_code==409
 assert post(cl,'/records/14/submit',{'revision':'1'}).status_code==400
 approve(env,cl)
 assert cl.get('/records/14/edit').status_code==409
 assert post(cl,'/records/14/edit',form(env,14)).status_code==409
 assert cl.get('/records/14/issue').status_code==200
 data={'machine':'LIBA 12','instructions':'10 belek po 150 m, reszta po 100 m.','token':'request-token-unique-12345678'}
 r=post(cl,'/records/14/issue',data);assert r.status_code==302
 url=r.location;html=cl.get(url).data
 assert b'150 m' in html and 'PODGLĄD ROBOCZY'.encode() not in html
 assert post(cl,'/records/14/issue',data).location==url
 with conn(env) as c:
  assert c.execute('SELECT count(*) FROM cards').fetchone()[0]==1
  with pytest.raises(sqlite3.IntegrityError):c.execute("UPDATE records SET symbol='changed' WHERE id=14")
  with pytest.raises(sqlite3.IntegrityError):c.execute("UPDATE cards SET html='changed'")
 clone=post(cl,'/records/14/copy',{'kind':'spec'});nid=int(clone.location.split('/')[2]);approve(env,cl,nid)
 assert post(cl,'/records/14/issue',dict(data,token='new-request-token-123456789')).status_code==409
 assert cl.get(url).data==html
 assert json.loads(rec(env,14)['payload'])['tech']['roll_length']=='55'

def test_stale_approval(env):
 cl=client(env);r=post(cl,'/records/14/copy',{'kind':'spec'});nid=int(r.location.split('/')[2]);approve(env,cl,14)
 f=form(env,nid);f.update(targets_weight='1000',tolerances_weight='±5%',targets_width='127',tolerances_width='±2 cm')
 assert post(cl,f'/records/{nid}/edit',f).status_code==302
 assert post(cl,f'/records/{nid}/submit',{'revision':str(rec(env,nid)['revision'])}).status_code==302
 assert post(cl,f'/records/{nid}/approve',{'revision':str(rec(env,nid)['revision']),'checked':'on','review_note':'Sprawdzenie równoległej specyfikacji.'}).status_code==409

def test_copy_trial_and_gb_validation(env):
 cl=client(env);r=post(cl,'/records/1/copy',{'kind':'trial'});nid=int(r.location.split('/')[2]);v=json.loads(rec(env,nid)['payload'])
 assert v['raw']=={} and v['stages']=='' and v['number']=='' and len(v['gb'])==4
 f=form(env,nid);f['gb_1_number']=f['gb_0_number'];assert post(cl,f'/records/{nid}/edit',f).status_code==400
 f['gb_1_number']='7';assert post(cl,f'/records/{nid}/edit',f).status_code==302
 assert json.loads(rec(env,nid)['payload'])['gb'][1]['number']=='7'

def test_backup_restore(env,tmp_path):
 cl=client(env);approve(env,cl);p=post(cl,'/records/14/issue',{'machine':'12','instructions':'10 × 150 m','token':'backup-card-test-12345678'})
 src=conn(env);dest=sqlite3.connect(tmp_path/'restored.sqlite3');src.backup(dest)
 assert dest.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 assert dest.execute('SELECT count(*) FROM cards').fetchone()[0]==1
 assert dest.execute('SELECT active_spec FROM articles WHERE project_id=2').fetchone()[0]==14
 src.close();dest.close()

def test_xss_rendered_as_text(env):
 cl=client(env);f=form(env,1);f['comments']='<script>alert(1)</script>';post(cl,'/records/1/edit',f)
 html=cl.get('/records/1').data;assert b'<script>alert(1)</script>' not in html;assert b'&lt;script&gt;alert(1)' in html

def test_parallel_writers(env):
 from concurrent.futures import ThreadPoolExecutor
 from threading import Barrier
 a=client(env);b=client(env,'technologist');f=form(env,1);barrier=Barrier(2)
 def save(c,value):
  barrier.wait();return post(c,'/records/1/edit',dict(f,raw_weight=value)).status_code
 with ThreadPoolExecutor(max_workers=2) as pool:
  x=pool.submit(save,a,'120');y=pool.submit(save,b,'130');codes=[x.result(),y.result()]
 assert sorted(codes)==[302,409]
 assert json.loads(rec(env,1)['payload'])['raw']['weight'] in ('120','130')

def test_search_500_projects(env):
 cl=client(env)
 with conn(env) as c:
  c.execute('BEGIN IMMEDIATE')
  for n in range(500):c.execute('INSERT INTO projects(name,description,created_at) VALUES(?,?,?)',(f'LOAD-{n:04d}','Test skali','2026-10-15'))
  c.commit()
 html=cl.get('/?q=LOAD-0499').data
 assert b'LOAD-0499' in html and b'LOAD-0498' not in html
 assert cl.get('/?q=LOAD&page=2').status_code==200

def test_multiple_articles_same_project(env):
 cl=client(env);approve(env,cl,14)
 clone=post(cl,'/records/14/copy',{'kind':'spec'});nid=int(clone.location.split('/')[2])
 f=form(env,nid);f['symbol']='M3550-B';assert post(cl,f'/records/{nid}/edit',f).status_code==302
 approve(env,cl,nid)
 assert rec(env,14)['version']==1 and rec(env,nid)['version']==1
 with conn(env) as c:
  active=[r[0] for r in c.execute('SELECT active_spec FROM articles WHERE project_id=2')]
  assert set(active)=={14,nid}
 assert cl.get('/records/14/issue').status_code==200
 assert cl.get(f'/records/{nid}/issue').status_code==200

def test_maintenance_gate_and_local_health(env):
 cl=client(env)
 state=cl.get('/healthz');assert state.status_code==200 and state.json['version']=='0.1.1'
 assert cl.get('/healthz',environ_overrides={'REMOTE_ADDR':'10.0.0.8'}).status_code==404
 flag=env[1]/'maintenance.json';flag.write_text('{}')
 assert cl.get('/').status_code==503
 assert post(cl,'/projects',{'name':'Must not be created'}).status_code==503
 assert cl.get('/healthz').status_code==200
 flag.unlink()
 assert cl.get('/').status_code==200

def test_backup_status_visible_to_admin(env):
 cl=client(env)
 (env[1]/'backup_status.json').write_text(json.dumps({'ok':True,'last_success':'2020-01-01T22:00:00+01:00'}))
 assert 'sprawdź harmonogram'.encode() in cl.get('/').data
