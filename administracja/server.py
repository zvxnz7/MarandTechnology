"""Stable service entry point; service wrapper calls: python server.py --config ..."""
import argparse,json,os,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--config',required=True);a=p.parse_args()
c=json.loads(Path(a.config).read_text(encoding='utf-8-sig'))
os.environ['MARAND_DATA']=c['data_dir']
os.environ['MARAND_HTTPS']='1' if c.get('https',True) else '0'
sys.path.insert(0,c['program_dir'])
from app import create_app
from waitress import serve
serve(create_app(),host='127.0.0.1',port=int(c.get('port',8765)),threads=8,max_request_body_size=1024*1024)
