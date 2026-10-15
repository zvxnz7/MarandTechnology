import sys,json,sqlite3,zipfile,hashlib,shutil
from pathlib import Path
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'administracja'))
import maintenance as m

@pytest.fixture
def cfg(tmp_path):
 p=tmp_path/'program';d=tmp_path/'data';b=tmp_path/'backups';r=tmp_path/'releases'
 p.mkdir();d.mkdir();(p/'seed/sources').mkdir(parents=True)
 (p/'seed/sources/original.odt').write_bytes(b'original-source')
 for name,body in [('app.py','old app'),('manage.py','old manage'),('requirements.txt','same requirements'),('schema.sql','same schema')]: (p/name).write_text(body)
 (p/'release.json').write_text(json.dumps({'version':'0.1.1','schema':1,'protocol':1}))
 (d/'secret.key').write_text('test-secret')
 c=sqlite3.connect(d/'marand.sqlite3');c.execute('CREATE TABLE articles(id INTEGER PRIMARY KEY,name TEXT)');c.execute("INSERT INTO articles VALUES(1,'Real data')");c.commit();c.close()
 return dict(program_dir=str(p),data_dir=str(d),backup_dir=str(b),releases_dir=str(r),daily_keep=14,weekly_keep=12)

def package(cfg,tmp_path,version='0.1.2',schema=1,changed_schema=False):
 src=Path(cfg['program_dir']);files={}
 for n in ('app.py','manage.py','requirements.txt','schema.sql'):
  files[n]=src.joinpath(n).read_bytes()
 files['app.py']=b'new app'
 if changed_schema:files['schema.sql']=b'new schema'
 manifest=dict(version=version,schema=schema,protocol=1,files={n:hashlib.sha256(v).hexdigest() for n,v in files.items()})
 dest=tmp_path/'new.zip'
 with zipfile.ZipFile(dest,'w') as z:
  for n,v in files.items():z.writestr('Marand_Technologia/'+n,v)
  z.writestr('Marand_Technologia/release.json',json.dumps(manifest))
 return dest

def test_daily_weekly_retention_and_restore(cfg,tmp_path):
 start=datetime(2026,1,1,22,tzinfo=ZoneInfo('Europe/Warsaw'))
 first=None
 for i in range(95):
  p=m.scheduled_backup(cfg,start+timedelta(days=i))
  if i==0:
   first=tmp_path/'first.zip';shutil.copy2(p,first)
 daily=list((Path(cfg['backup_dir'])/'dzienne').glob('*.zip'));weekly=list((Path(cfg['backup_dir'])/'tygodniowe').glob('*.zip'))
 assert len(daily)==14 and len(weekly)==12
 dest=m.restore_to_new_folder(first,tmp_path/'recovered')
 c=sqlite3.connect(dest/'data/marand.sqlite3');assert c.execute('SELECT name FROM articles').fetchone()[0]=='Real data';c.close()
 assert (dest/'data/secret.key').read_text()=='test-secret'
 assert (dest/'program/seed/sources/original.odt').read_bytes()==b'original-source'
 with pytest.raises(ValueError):m.restore_to_new_folder(first,dest)

def test_weekly_first_copy_daily_refreshed(cfg):
 a=datetime(2026,10,12,22,tzinfo=ZoneInfo('Europe/Warsaw'));m.scheduled_backup(cfg,a)
 week=next((Path(cfg['backup_dir'])/'tygodniowe').glob('*.zip'));digest=m.sha(week)
 c=sqlite3.connect(Path(cfg['data_dir'])/'marand.sqlite3');c.execute("UPDATE articles SET name='New data'");c.commit();c.close()
 m.scheduled_backup(cfg,a+timedelta(days=1));assert m.sha(week)==digest
 assert json.loads((Path(cfg['data_dir'])/'backup_status.json').read_text())['ok']

def test_failed_backup_does_not_prune(cfg):
 m.scheduled_backup(cfg);before=list(Path(cfg['backup_dir']).rglob('*.zip'))
 db=Path(cfg['data_dir'])/'marand.sqlite3';db.rename(db.with_suffix('.old'))
 with pytest.raises(ValueError):m.scheduled_backup(cfg)
 assert list(Path(cfg['backup_dir']).rglob('*.zip'))==before
 state=json.loads((Path(cfg['data_dir'])/'backup_status.json').read_text());assert not state['ok'] and state['last_success']

def test_update_keeps_data_and_sources(cfg,tmp_path):
 zip_path=package(cfg,tmp_path);data=Path(cfg['data_dir']);before=m.sha(data/'marand.sqlite3');calls=[]
 def service(c,action):calls.append(action)
 def check(c,v):
  assert json.loads((Path(c['program_dir'])/'release.json').read_text())['version']==v
 assert m.update(cfg,zip_path,service,check)=='0.1.2'
 assert calls==['stop','start'];assert m.sha(data/'marand.sqlite3')==before
 assert (Path(cfg['program_dir'])/'seed/sources/original.odt').exists()
 assert not (data/'maintenance.json').exists()
 assert len(list((Path(cfg['backup_dir'])/'przed_aktualizacja').glob('*.zip')))==1
 assert len(list(Path(cfg['releases_dir']).iterdir()))==1

def test_failed_update_rolls_back_program_not_data(cfg,tmp_path):
 zip_path=package(cfg,tmp_path);data=Path(cfg['data_dir']);before=m.sha(data/'marand.sqlite3')
 def check(c,v):
  if v=='0.1.2':raise RuntimeError('Simulated start failure')
 with pytest.raises(RuntimeError,match='Przywrócono'):
  m.update(cfg,zip_path,lambda c,a:None,check)
 assert (Path(cfg['program_dir'])/'app.py').read_text()=='old app'
 assert m.sha(data/'marand.sqlite3')==before and not (data/'maintenance.json').exists()
 assert json.loads((data/'update_status.json').read_text())['rollback_error'] is None

def test_incompatible_migration_stops_before_service(cfg,tmp_path):
 calls=[];zip_path=package(cfg,tmp_path,changed_schema=True)
 with pytest.raises(ValueError,match='strukturę'):m.update(cfg,zip_path,lambda c,a:calls.append(a),lambda c,v:None)
 assert not calls and not (Path(cfg['data_dir'])/'maintenance.json').exists()

def test_bad_manifest_and_traversal(tmp_path):
 bad=tmp_path/'bad.zip';raw=b'evil'
 with zipfile.ZipFile(bad,'w') as z:
  z.writestr('release.json',json.dumps(dict(version='0.1.2',protocol=1,schema=1,files={'../escape':hashlib.sha256(raw).hexdigest()})))
  z.writestr('../escape',raw)
 with pytest.raises(ValueError):m.unpack_release(bad,tmp_path/'stage')
 assert not (tmp_path/'escape').exists()

def test_overlapping_configuration_rejected(cfg,tmp_path):
 cfg['backup_dir']=str(Path(cfg['data_dir'])/'backups');p=tmp_path/'cfg.json';p.write_text(json.dumps(cfg))
 with pytest.raises(ValueError):m.config(p)

def test_live_wal_snapshot(cfg,tmp_path):
 c=sqlite3.connect(Path(cfg['data_dir'])/'marand.sqlite3');c.execute('PRAGMA journal_mode=WAL');c.execute("INSERT INTO articles VALUES(2,'Committed in WAL')");c.commit()
 try:out=m.backup_to(cfg,tmp_path/'wal.zip')
 finally:c.close()
 dest=m.restore_to_new_folder(out,tmp_path/'wal-restored');restored=sqlite3.connect(dest/'data/marand.sqlite3')
 assert restored.execute('SELECT count(*) FROM articles').fetchone()[0]==2;restored.close()
