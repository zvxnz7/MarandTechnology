"""One-time, narrowly scoped import from original ZIPs. No auto-approval."""
import zipfile,io,json,re,hashlib,sys,xml.etree.ElementTree as E
from pathlib import Path
ROOT=Path(__file__).resolve().parent
BASE=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'source_oct15'
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
T='{urn:oasis:names:tc:opendocument:xmlns:table:1.0}'
def clean(s):return re.sub(r'[ \t]+',' ',s).strip()
def tables(data,docx):
 with zipfile.ZipFile(io.BytesIO(data)) as z:r=E.fromstring(z.read('word/document.xml' if docx else 'content.xml'))
 if docx:
  return [[[clean(''.join(c.itertext())) for c in row.findall(W+'tc')] for row in tab.findall(W+'tr')] for tab in r.iter(W+'tbl')]
 return [[[clean(''.join(c.itertext())) for c in row.findall(T+'table-cell')] for row in tab.findall(T+'table-row')] for tab in r.iter(T+'table')]
def empty():return dict(symbol='',number='',date='',client='',description='',tech={},gb=[],raw={},raw_comments='',finished=[],comments='',stages='',targets={},tolerances={},knitter_notes='',sources=[])
def source(archive,name,data):
 h=hashlib.sha256(data).hexdigest();fn=h[:16]+Path(name).suffix
 (ROOT/'seed/sources'/fn).write_bytes(data)
 return dict(file=fn,name=name,archive=archive,sha256=h)
def spec(archive,name,data):
 ts=tables(data,True);v=empty();v['symbol']=ts[0][1][1];row=ts[1][1]
 v['tech']=dict(density=row[0],working_width=row[2],panels=row[4],gauge=row[5],machine_type=row[6])
 raw=ts[2][2];v['date']=raw[0];v['raw']=dict(zip(['weight','width','roll_width','pk','pr','thickness'],raw[1:7]));v['raw_comments']=raw[7]
 for row in ts[3][1:]:
  if len(row)>=6 and any(row[1:]):v['gb'].append(dict(zip(['number','yarn','threads','run_in','threading','notes'],row)))
 patterns={row[0].replace('GB','').strip():row[1] for row in ts[4][1:] if len(row)>1}
 for row in v['gb']:row['pattern']=patterns.get(row['number'],'')
 v['tech'].update(roll_length=ts[5][1][1].removesuffix('m').strip(),speed=ts[5][2][1]);v['knitter_notes']=ts[6][1][0]
 for tab in ts:
  if tab and 'warianty wykończenia' in ' '.join(tab[0]):
   for i in range(3):
    f={'name':tab[1][i],'comments':''}
    for row in tab[2:]:
     if len(row)>i*2+1:
      key={'Gramatura':'weight','Szerokość':'width','Pk':'pk','Pr':'pr','Dystans':'thickness','Usztywnienie':'finish'}.get(row[i*2])
      if key:f[key]=row[i*2+1]
    if any(f.get(k) for k in ('weight','width','thickness','finish')):v['finished'].append(f)
 v['sources']=[source(archive,name,data)];v['source_note']='Karta oznaczona kropką jako aktualna w archiwum. Import roboczy: parametry docelowe i tolerancje należy ustalić przed zatwierdzeniem. Jednostki wrobienia wymagają sprawdzenia ze źródłem.'
 return v
roman={'I':'1','II':'2','III':'3','IV':'4','V':'5','VI':'6','VII':'7','VIII':'8'}
def trials(archive,name,data):
 ts=tables(data,False);first=ts[0];src=source(archive,name,data);out=[]
 for table in ts:
  if not any(row and row[0].startswith('GB ') for row in table):continue
  v=empty();v.update(number=first[0][0],symbol=first[0][1],client=first[0][2],date=first[0][3],description=first[2][0],sources=[src]);v['source_note']='Dane odczytane z historycznej karty próby, wymagają sprawdzenia. Pełne opisy etapów i oryginalny plik są zachowane. Nie uzupełniono brakujących parametrów przez zgadywanie.'
  for row in first:
   if row and ('PES' in ' '.join(row)) and not row[0].startswith('GB') and len(row)>2 and "''" in row[2]:
    v['description']+='\nZałożenia źródłowe — surowiec: '+row[1]+'; szerokość: '+row[2]
  for row in table:
   if row and row[0].startswith('OPIS TECHNOLOGICZNY'):
    sym=row[0].replace('OPIS TECHNOLOGICZNY','').strip()
    if sym:v['symbol']=sym
   if row and row[0].startswith('Ścisłość') and len(row)>1:v['tech']['density']=row[1].replace('ocz/cm','').strip()
   if row and row[0].startswith('GB ') and len(row)>=6:
    v['gb'].append(dict(number=roman.get(row[0][3:].strip(),row[0][3:].strip()),yarn=row[1],threads=row[2],threading=row[3],run_in=row[4]+' mm/rack',pattern=row[5],notes=''))
  start=next((i for i,row in enumerate(table) if row and row[0]=='ETAPY PRÓB'),len(table))
  v['stages']='\n'.join(' | '.join(row) for row in table[start+2:] if any(row))
  num=r'(\d+(?:[,.]\d+)?(?:\s*[-–]\s*\d+(?:[,.]\d+)?)?)'
  for key,pat in [('weight',r'Gramatura:\s*'+num+r'\s*g'),('width',r'Szerokość:\s*'+num+r'\s*cm'),('pk',r'Pk\s*[–-]\s*'+num),('pr',r'Pr\s*[–-]\s*'+num)]:
   m=re.search(pat,v['stages'],re.I)
   if m:v['raw'][key]=m[1]
  if 'na wałku' in v['stages'] and v['raw'].get('width'):v['raw']['roll_width']=v['raw'].pop('width')
  if '15+15B' in name:
   v['number']='15B’2026' if 'PT WZ 8 ' in v['symbol'] else '15’2026'
   if v['number']=='15B’2026':v['source_note']+=' Wspólny nagłówek ma datę 26.05.2026, etap wariantu 8 ma datę 19.05.2026; zachowano obie informacje bez rozstrzygania.'
  out.append(v)
 return out
projects=[dict(name='PT WZ',description='Projekt dzianiny dla Traweny. Historia wariantów i warunki dziania.',conflict='',records=[]),dict(name='M3550',description='Artykuł standardowy — dzianina dystansowa. Dwie karty źródłowe.',conflict='Dwie aktualne karty M3550 z różnych folderów różnią się treścią. Baltexowe: prędkość 360 oraz uwaga o metalowych wałkach 136–146 cm. Dz.dystansowe: te pola puste. Przed zatwierdzeniem należy wskazać przyjęte dane i uzasadnienie.',records=[])]
with zipfile.ZipFile(BASE/'Próby - dzianiny.zip') as z:
 names=sorted([n for n in z.namelist() if '/2026/' in n and 'PT WZ' in n and n.endswith('.odt') and '/.~' not in n],key=lambda n:int(Path(n).name.split("'")[0].split('+')[0]))
 for n in names:
  for v in trials('Próby - dzianiny.zip',n,z.read(n)):projects[0]['records'].append(dict(kind='trial',data=v))
with zipfile.ZipFile(BASE/'NOWE WARUNKI DZIANIA.zip') as z:
 for n,pi in [('NOWE WARUNKI DZIANIA/Poliester/Pętelkowe/PT WZ 3 84-9(3)..docx',0),('NOWE WARUNKI DZIANIA/Baltexowe/M3550..docx',1),('NOWE WARUNKI DZIANIA/Dz.dystansowe/M3550..docx',1)]:
  projects[pi]['records'].append(dict(kind='spec',data=spec('NOWE WARUNKI DZIANIA.zip',n,z.read(n))))
(ROOT/'seed/data.json').write_text(json.dumps(projects,ensure_ascii=False,indent=2),encoding='utf-8')
for p in projects:print(p['name'],len(p['records']),[(r['data']['number'],r['data']['symbol']) for r in p['records']])
assert len(projects[0]['records'])==13
assert projects[1]['records'][0]['data']['tech']['speed']=='360'
assert projects[1]['records'][0]['data']['gb'][2]['threads']=='3*280'
