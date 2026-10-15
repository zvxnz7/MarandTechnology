from pathlib import Path
import argparse,getpass,json,os,secrets,sqlite3,sys
from werkzeug.security import generate_password_hash
from app import ROOT,connect,now

def init(data,seed=True):
 data.mkdir(parents=True,exist_ok=True)
 key=data/'secret.key'
 if not key.exists():key.write_text(secrets.token_hex(32),encoding='utf-8')
 c=connect(data/'marand.sqlite3');c.execute('PRAGMA journal_mode=WAL');c.executescript((ROOT/'schema.sql').read_text(encoding='utf-8'))
 if seed and not c.execute('SELECT 1 FROM projects LIMIT 1').fetchone():
  c.execute('BEGIN IMMEDIATE')
  try:
   for p in json.loads((ROOT/'seed/data.json').read_text(encoding='utf-8')):
    pid=c.execute('INSERT INTO projects(name,description,conflict,created_at) VALUES(?,?,?,?)',(p['name'],p['description'],p['conflict'],now())).lastrowid
    for rec in p['records']:
     v=rec['data'];aid=None
     if rec['kind']=='spec':
      key=''.join(v['symbol'].upper().split())
      c.execute('INSERT OR IGNORE INTO articles(project_id,symbol,symbol_key) VALUES(?,?,?)',(pid,v['symbol'],key))
      aid=c.execute('SELECT id FROM articles WHERE project_id=? AND symbol_key=?',(pid,key)).fetchone()[0]
     rid=c.execute('INSERT INTO records(project_id,article_id,kind,symbol,number,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(pid,aid,rec['kind'],v['symbol'],v['number'],json.dumps(v,ensure_ascii=False),now(),now())).lastrowid
     c.execute('INSERT INTO audit(at,action,record_id,detail) VALUES(?,?,?,?)',(now(),'Import źródła — do sprawdzenia',rid,json.dumps(v['sources'],ensure_ascii=False)))
   c.commit()
  except BaseException:c.rollback();raise
 return c

def add_user(c,login,name,role,password):
 if len(password)<12:raise ValueError('Hasło musi mieć co najmniej 12 znaków.')
 c.execute('INSERT INTO users(login,name,role,password) VALUES(?,?,?,?)',(login.lower().strip(),name,role,generate_password_hash(password)))

def main():
 p=argparse.ArgumentParser();p.add_argument('command',choices=['init','add-user','backup','run']);p.add_argument('--login');p.add_argument('--name');p.add_argument('--role',choices=['viewer','technologist','approver','admin'],default='viewer');p.add_argument('--output');p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=8765);p.add_argument('--empty',action='store_true');a=p.parse_args()
 data=Path(os.environ.get('MARAND_DATA',ROOT/'data'))
 if a.command=='init':
  c=init(data,not a.empty)
  if not c.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
   print('Utwórz konto administratora. Hasło nie będzie widoczne podczas wpisywania.')
   login=input('Login [admin]: ').strip() or 'admin';name=input('Imię i nazwisko: ').strip() or 'Administrator'
   while True:
    password=getpass.getpass('Hasło (min. 12 znaków): ')
    if len(password)<12:print('Za krótkie hasło.');continue
    if password!=getpass.getpass('Powtórz hasło: '):print('Hasła są różne.');continue
    break
   add_user(c,login,name,'admin',password)
  c.close();print('Baza gotowa. Istniejące dane nie zostały zastąpione.')
 elif a.command=='add-user':
  if not a.login or not a.name:p.error('Podaj --login i --name')
  c=connect(data/'marand.sqlite3');password=getpass.getpass('Hasło nowego użytkownika (min. 12 znaków): ')
  if password!=getpass.getpass('Powtórz hasło: '):raise ValueError('Hasła są różne.')
  add_user(c,a.login,a.name,a.role,password);c.close();print('Dodano użytkownika.')
 elif a.command=='backup':
  if not a.output:p.error('Podaj --output ścieżka.sqlite3')
  out=Path(a.output)
  if out.exists():raise ValueError('Plik docelowy już istnieje. Podaj nową nazwę.')
  if not (data/'marand.sqlite3').is_file():raise ValueError('Nie ma bazy do skopiowania.')
  out.parent.mkdir(parents=True,exist_ok=True)
  src=connect(data/'marand.sqlite3');dest=sqlite3.connect(out);src.backup(dest)
  check=dest.execute('PRAGMA integrity_check').fetchone()[0];src.close();dest.close()
  if check!='ok':raise RuntimeError('Kontrola kopii nie powiodła się.')
  print('Kopia bazy gotowa: '+str(out))
 elif a.command=='run':
  from waitress import serve
  from app import create_app
  if not (data/'marand.sqlite3').is_file():raise ValueError('Najpierw uruchom init.')
  print(f'Otwórz http://{a.host}:{a.port} — aby zakończyć, Ctrl+C.',flush=True)
  serve(create_app(),host=a.host,port=a.port,threads=8,max_request_body_size=1024*1024)
if __name__=='__main__':main()
