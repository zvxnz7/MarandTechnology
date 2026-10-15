"""Marand operations protocol 1. Run from a stable folder OUTSIDE program_dir."""
from pathlib import Path, PurePosixPath
from contextlib import contextmanager
from datetime import datetime
from zoneinfo import ZoneInfo
import argparse,hashlib,json,os,re,shutil,sqlite3,subprocess,sys,tempfile,time,urllib.request,zipfile

VERSION='0.1.1'
SCHEMA=1

def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def atomic_json(path,value):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_name(path.name+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(tmp,path)
def nested(a,b):return a==b or b in a.parents

def config(path):
 cfg=json.loads(Path(path).read_text(encoding='utf-8-sig'))
 for k in ('program_dir','data_dir','backup_dir','releases_dir'):
  p=Path(cfg[k]);
  if not p.is_absolute():raise ValueError('Wymagana ścieżka bezwzględna: '+k)
  cfg[k]=str(p.resolve())
 paths=[Path(cfg[k]) for k in ('program_dir','data_dir','backup_dir','releases_dir')]
 for i,a in enumerate(paths):
  for b in paths[i+1:]:
   if nested(a,b) or nested(b,a):raise ValueError('Foldery programu, danych, kopii i wersji muszą być oddzielne.')
 for k,d in [('daily_keep',14),('weekly_keep',12)]:
  cfg[k]=int(cfg.get(k,d))
  if cfg[k]<1:raise ValueError('Retencja musi wynosić co najmniej 1.')
 return cfg

@contextmanager
def operation_lock(cfg):
 p=Path(cfg['data_dir'])/'operations.lock';p.parent.mkdir(parents=True,exist_ok=True)
 with p.open('a+b') as f:
  f.seek(0);f.write(b'0');f.flush();f.seek(0)
  try:
   if os.name=='nt':
    import msvcrt
    msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
   else:
    import fcntl
    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except OSError:raise RuntimeError('Trwa inna kopia lub aktualizacja. Spróbuj później.')
  try:yield
  finally:
   f.seek(0)
   if os.name=='nt':msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
   else:fcntl.flock(f,fcntl.LOCK_UN)

def verify_backup(path):
 with zipfile.ZipFile(path) as z:
  if z.testzip():raise ValueError('Uszkodzone archiwum kopii.')
  m=json.loads(z.read('manifest.json'))
  if 'data/marand.sqlite3' not in m['files']:raise ValueError('Brak bazy w kopii.')
  for name,digest in m['files'].items():
   if hashlib.sha256(z.read(name)).hexdigest()!=digest:raise ValueError('Błędna suma kontrolna: '+name)
  with tempfile.TemporaryDirectory() as tmp:
   db=Path(tmp)/'check.sqlite3';db.write_bytes(z.read('data/marand.sqlite3'))
   c=sqlite3.connect(db)
   try:
    if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Błędna struktura kopii bazy.')
    if c.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('Niespójne powiązania w bazie.')
   finally:c.close()
 return m

def backup_to(cfg,out,at=None):
 data=Path(cfg['data_dir']);program=Path(cfg['program_dir']);out=Path(out)
 source=data/'marand.sqlite3'
 if not source.is_file():raise ValueError('Nie znaleziono istniejącej bazy. Kopia nie została wykonana.')
 if not (data/'secret.key').is_file() and not os.environ.get('MARAND_SECRET'):raise ValueError('Brak klucza sesji; sprawdź folder danych.')
 out.parent.mkdir(parents=True,exist_ok=True)
 # Temporary output is on the same volume; replace only after complete verification.
 with tempfile.TemporaryDirectory(prefix='.marand-',dir=out.parent) as td:
  tmp=Path(td);snap=tmp/'marand.sqlite3'
  src=sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True,timeout=30);dst=sqlite3.connect(snap)
  deadline=time.monotonic()+600
  def progress(status,left,total):
   if time.monotonic()>deadline:raise TimeoutError('Przekroczono czas wykonywania kopii.')
  try:src.backup(dst,pages=256,progress=progress,sleep=.1)
  finally:src.close();dst.close()
  files={'data/marand.sqlite3':snap}
  skip={'marand.sqlite3','marand.sqlite3-wal','marand.sqlite3-shm','operations.lock','maintenance.json','backup_status.json','update_status.json'}
  for p in data.rglob('*'):
   if p.is_symlink():raise ValueError('Dowiązania w folderze danych nie są obsługiwane przez kopię.')
   if p.is_file() and p.name not in skip and not p.name.endswith('.tmp'):files['data/'+p.relative_to(data).as_posix()]=p
  srcdir=program/'seed/sources'
  if srcdir.exists():
   for p in srcdir.rglob('*'):
    if p.is_symlink():raise ValueError('Dowiązanie w źródłach.')
    if p.is_file():files['program/seed/sources/'+p.relative_to(srcdir).as_posix()]=p
  manifest={'format':1,'created_at':(at or datetime.now(ZoneInfo('Europe/Warsaw'))).isoformat(),'schema':SCHEMA,'files':{}}
  candidate=tmp/'backup.zip'
  with zipfile.ZipFile(candidate,'w',zipfile.ZIP_DEFLATED) as z:
   for name,p in files.items():
    raw=p.read_bytes();z.writestr(name,raw);manifest['files'][name]=hashlib.sha256(raw).hexdigest()
   z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False))
  verify_backup(candidate);os.replace(candidate,out)
 return out

def scheduled_backup(cfg,at=None):
 at=at or datetime.now(ZoneInfo('Europe/Warsaw'));root=Path(cfg['backup_dir']);data=Path(cfg['data_dir'])
 with operation_lock(cfg):
  if (data/'maintenance.json').exists():raise RuntimeError('Aktualizacja w toku. Kopię ponowi harmonogram.')
  daily=root/'dzienne'/('D-'+at.strftime('%Y-%m-%d')+'.zip')
  try:
   backup_to(cfg,daily,at)
   year,week,_=at.isocalendar();weekly=root/'tygodniowe'/f'W-{year}-{week:02d}.zip'
   valid=False
   if weekly.exists():
    try:verify_backup(weekly);valid=True
    except (ValueError,KeyError,zipfile.BadZipFile):pass
   if not valid:
    weekly.parent.mkdir(parents=True,exist_ok=True);tmp=weekly.with_suffix('.tmp');shutil.copy2(daily,tmp);verify_backup(tmp);os.replace(tmp,weekly)
   # Retain newest successful periods; touch only precisely named Marand snapshots.
   for folder,pattern,keep in [('dzienne',r'D-\d{4}-\d{2}-\d{2}\.zip',cfg['daily_keep']),('tygodniowe',r'W-\d{4}-\d{2}\.zip',cfg['weekly_keep'])]:
    paths=sorted((p for p in (root/folder).iterdir() if p.is_file() and re.fullmatch(pattern,p.name)),reverse=True)
    for p in paths[keep:]:p.unlink()
   atomic_json(data/'backup_status.json',{'ok':True,'last_success':at.isoformat(),'daily':str(daily),'weekly':str(weekly),'daily_keep':cfg['daily_keep'],'weekly_keep':cfg['weekly_keep']})
  except Exception as e:
   status={}
   if (data/'backup_status.json').exists():status=json.loads((data/'backup_status.json').read_text())
   status.update(ok=False,last_failure=at.isoformat(),error=str(e));atomic_json(data/'backup_status.json',status);raise
 return daily

def restore_to_new_folder(archive,dest):
 dest=Path(dest)
 if dest.exists() and any(dest.iterdir()):raise ValueError('Odtwarzanie tylko do nowego lub pustego folderu.')
 manifest=verify_backup(archive)
 with zipfile.ZipFile(archive) as z:
  for name in manifest['files']:
   p=PurePosixPath(name)
   if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or not (name.startswith('data/') or name.startswith('program/seed/sources/')):raise ValueError('Nieprawidłowa ścieżka w kopii.')
  dest.mkdir(parents=True,exist_ok=True)
  for name in manifest['files']:
   path=dest.joinpath(*PurePosixPath(name).parts);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(z.read(name))
 return dest

def unpack_release(package,dest):
 dest=Path(dest)
 with zipfile.ZipFile(package) as z:
  manifests=[n for n in z.namelist() if n.endswith('/release.json') or n=='release.json']
  if len(manifests)!=1:raise ValueError('Paczka nie zawiera jednoznacznego release.json.')
  m=json.loads(z.read(manifests[0]));prefix=manifests[0][:-len('release.json')]
  if m.get('protocol')!=1 or m.get('schema')!=SCHEMA:raise ValueError('Ta aktualizacja wymaga nowej procedury migracji od informatyka. Nie zmieniono danych.')
  if not re.fullmatch(r'\d+\.\d+\.\d+',m.get('version','')):raise ValueError('Nieprawidłowa wersja paczki.')
  for name,digest in m['files'].items():
   p=PurePosixPath(name)
   if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or p.parts[0] in ('data','dane','.venv','runtime'):raise ValueError('Niebezpieczna ścieżka paczki.')
   raw=z.read(prefix+name)
   if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('Niezgodna suma pliku: '+name)
   out=dest.joinpath(*p.parts);out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(raw)
  (dest/'release.json').write_text(json.dumps(m,ensure_ascii=False,indent=2),encoding='utf-8')
  for required in ('app.py','manage.py','requirements.txt','schema.sql'):
   if not (dest/required).exists():raise ValueError('Brak pliku programu: '+required)
 return m

def win_service(cfg,action):
 if os.name!='nt':raise RuntimeError('Sterowanie usługą wymaga Windows.')
 name=cfg.get('service_name','')
 if not name:raise ValueError('Brak service_name w konfiguracji.')
 env=dict(os.environ,MARAND_SERVICE_NAME=name)
 cmd="$ErrorActionPreference='Stop'; $s=Get-Service -Name $env:MARAND_SERVICE_NAME; "
 if action=='stop':cmd+="Stop-Service -InputObject $s -ErrorAction Stop; $s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))"
 else:cmd+="Start-Service -InputObject $s -ErrorAction Stop; $s.WaitForStatus('Running',[TimeSpan]::FromSeconds(60))"
 subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',cmd],env=env,check=True,timeout=90)

def health(cfg,version):
 url=cfg.get('health_url','http://127.0.0.1:8765/healthz')
 from urllib.parse import urlsplit
 parsed=urlsplit(url)
 if parsed.hostname not in ('127.0.0.1','localhost','::1'):raise ValueError('health_url musi wskazywać lokalny serwer.')
 end=time.monotonic()+45
 while time.monotonic()<end:
  try:
   with urllib.request.urlopen(url,timeout=3) as r:status=json.load(r)
   expected=hashlib.sha256(os.path.normcase(str(Path(cfg['data_dir']).resolve())).encode()).hexdigest()
   if status.get('ok') and status.get('version')==version and status.get('data_tag')==expected:return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Nowa wersja nie przeszła kontroli uruchomienia.')

def update(cfg,package,service=win_service,check=health):
 program=Path(cfg['program_dir']);data=Path(cfg['data_dir']);versions=Path(cfg['releases_dir'])
 if nested(Path(__file__).resolve(),program):raise ValueError('Aktualizator musi działać spoza folderu programu. Skopiuj administracja obok programu.')
 if not (program/'release.json').exists():raise ValueError('Pierwszą instalację i przejście z pilota 0.1 przygotowuje informatyk.')
 old=json.loads((program/'release.json').read_text());check(cfg,old['version']);stamp=datetime.now(ZoneInfo('Europe/Warsaw')).strftime('%Y%m%d-%H%M%S')
 versions.mkdir(parents=True,exist_ok=True)
 with operation_lock(cfg),tempfile.TemporaryDirectory(prefix='.update-',dir=program.parent) as tmp:
  if (data/'maintenance.json').exists():raise RuntimeError('Poprzednia aktualizacja nie została zakończona. Sprawdź update_status.json.')
  stage=Path(tmp)/'new';stage.mkdir();m=unpack_release(package,stage)
  if tuple(map(int,m['version'].split('.'))) <= tuple(map(int,old['version'].split('.'))):raise ValueError('Paczka musi mieć wyższą wersję niż zainstalowana.')
  if (stage/'requirements.txt').read_bytes()!=(program/'requirements.txt').read_bytes():raise ValueError('Zmieniono biblioteki. Tę aktualizację musi przygotować informatyk; nie zmieniono programu.')
  if (stage/'schema.sql').read_bytes()!=(program/'schema.sql').read_bytes():raise ValueError('Zmieniono strukturę bazy. Wymagana osobna migracja; nie zmieniono programu.')
  # Existing source files must remain downloadable even if omitted from a future release.
  sources=program/'seed/sources'
  if sources.exists():
   for p in sources.rglob('*'):
    if p.is_symlink():raise ValueError('Dowiązanie w źródłach.')
    if p.is_file():
     q=stage/'seed/sources'/p.relative_to(sources);q.parent.mkdir(parents=True,exist_ok=True)
     if q.exists() and sha(q)!=sha(p):raise ValueError('Próba nadpisania historycznego pliku źródłowego.')
     if not q.exists():shutil.copy2(p,q)
  atomic_json(data/'maintenance.json',{'since':stamp,'target':m['version']})
  previous=versions/(old['version']+'-'+stamp);swapped=False;stopped=False
  try:
   service(cfg,'stop');stopped=True
   b=backup_to(cfg,Path(cfg['backup_dir'])/'przed_aktualizacja'/f'PRE-{stamp}.zip')
   # Preserve program without moving the data or virtual environment.
   shutil.copytree(program,previous)
   oldlocal=Path(tmp)/'old';program.rename(oldlocal)
   try:stage.rename(program)
   except BaseException:oldlocal.rename(program);raise
   swapped=True
   service(cfg,'start');check(cfg,m['version'])
   atomic_json(data/'update_status.json',{'ok':True,'version':m['version'],'at':stamp,'previous_program':str(previous),'backup':str(b)})
   (data/'maintenance.json').unlink()
  except Exception as error:
   rollback_error=None
   try:
    if swapped:
     service(cfg,'stop')
     failed=versions/('FAILED-'+m['version']+'-'+stamp);shutil.move(str(program),failed)
     shutil.copytree(previous,program)
    service(cfg,'start');check(cfg,old['version'])
    (data/'maintenance.json').unlink(missing_ok=True)
   except Exception as e:rollback_error=str(e)
   atomic_json(data/'update_status.json',{'ok':False,'at':stamp,'error':str(error),'rollback_error':rollback_error,'previous_program':str(previous)})
   if rollback_error:raise RuntimeError('Aktualizacja i automatyczny powrót nie powiodły się. Zachowano tryb serwisowy; potrzebny informatyk.') from error
   raise RuntimeError('Aktualizacja nieudana. Przywrócono poprzednią wersję programu; baza nie została cofnięta.') from error
 return m['version']

def main():
 p=argparse.ArgumentParser();p.add_argument('operation',choices=['backup','verify','update','restore']);p.add_argument('--config');p.add_argument('--file');p.add_argument('--destination');args=p.parse_args()
 try:
  if args.operation=='verify':print(json.dumps(verify_backup(args.file),ensure_ascii=False));return
  if args.operation=='restore':
   if not args.destination:raise ValueError('Podaj --destination: nowy folder do próby odtworzenia.')
   print(restore_to_new_folder(args.file,args.destination));return
  cfg=config(args.config)
  if args.operation=='backup':print('Kopia gotowa: '+str(scheduled_backup(cfg)))
  else:print('Zaktualizowano do '+update(cfg,args.file))
 except Exception as e:print('BŁĄD: '+str(e),file=sys.stderr);sys.exit(1)
if __name__=='__main__':main()
