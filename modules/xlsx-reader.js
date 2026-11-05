'use strict';

const { inflateRawSync } = require('node:zlib');

function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }

function unzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > 25 * 1024 * 1024) fail('Plik Excel jest pusty lub przekracza limit 25 MB.');
  let eocd=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)fail('Nieprawidłowy plik XLSX.');
  const count=buffer.readUInt16LE(eocd+10),directoryOffset=buffer.readUInt32LE(eocd+16),files=new Map();
  let cursor=directoryOffset,totalUncompressed=0;
  for(let i=0;i<count;i++){
    if(cursor+46>buffer.length||buffer.readUInt32LE(cursor)!==0x02014b50)fail('Nie można odczytać struktury pliku XLSX.');
    const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),compressedSize=buffer.readUInt32LE(cursor+20),size=buffer.readUInt32LE(cursor+24),nameLength=buffer.readUInt16LE(cursor+28),extraLength=buffer.readUInt16LE(cursor+30),commentLength=buffer.readUInt16LE(cursor+32),localOffset=buffer.readUInt32LE(cursor+42);
    const name=buffer.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
    if(flags&1)fail('Zaszyfrowanych plików Excel nie można zaimportować.');
    totalUncompressed+=size;
    if(size>60*1024*1024||totalUncompressed>150*1024*1024)fail('Rozpakowany plik Excel jest zbyt duży.');
    if(localOffset+30>buffer.length||buffer.readUInt32LE(localOffset)!==0x04034b50)fail('Nieprawidłowy element w pliku XLSX.');
    const localNameLength=buffer.readUInt16LE(localOffset+26),localExtraLength=buffer.readUInt16LE(localOffset+28),start=localOffset+30+localNameLength+localExtraLength,end=start+compressedSize;
    if(end>buffer.length)fail('Ucięty element w pliku XLSX.');
    const compressed=buffer.subarray(start,end);let content;
    try{content=method===0?Buffer.from(compressed):method===8?inflateRawSync(compressed):null;}catch{fail('Nie można rozpakować elementu pliku XLSX.');}
    if(!content)fail('Plik XLSX używa nieobsługiwanej kompresji.');
    files.set(name,content.toString('utf8'));
    cursor+=46+nameLength+extraLength+commentLength;
  }
  return files;
}

function decodeXml(value) {
  return String(value||'').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
    if(entity[0]==='#')return String.fromCodePoint(entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10));
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()]||_;
  });
}
function attributes(source) {
  const out={};for(const match of source.matchAll(/([\w:.-]+)="([^"]*)"/g))out[match[1]]=decodeXml(match[2]);return out;
}
function textTags(source,tag='t') {
  return [...String(source||'').matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,'g'))].map(match=>decodeXml(match[1].replace(/<[^>]+>/g,''))).join('');
}
function columnIndex(reference) {
  const letters=String(reference||'').match(/^[A-Z]+/i)?.[0]?.toUpperCase()||'';let n=0;
  for(const char of letters)n=n*26+char.charCodeAt(0)-64;
  return n-1;
}
function parseSheet(xml,sharedStrings=[]) {
  const rows=[];
  for(const rowMatch of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
    const row=[];
    for(const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const attr=attributes(cellMatch[1]),body=cellMatch[2]||'',index=columnIndex(attr.r);if(index<0)continue;
      const v=body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];let value='';
      if(attr.t==='inlineStr')value=textTags(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1]||'');
      else if(attr.t==='s'&&v!==undefined)value=sharedStrings[Number(v)]??'';
      else if(v!==undefined)value=decodeXml(v);
      row[index]=attr.t==='e'?{error:value||'Błąd formuły'}:value;
    }
    rows.push(row);
  }
  return rows;
}
function normalizeHeader(value) {
  return String(value||'').toLocaleLowerCase('pl-PL').replace(/ł/g,'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
}
function normalizeSymbol(value) {
  return normalizeHeader(value).replace(/\/([^/]+)\//g,'($1)').replace(/\//g,'(').replace(/\s+/g,'');
}
function parseMoney(value) {
  if(value&&typeof value==='object'&&value.error)return {value:null,error:value.error};
  const raw=String(value??'').trim().replace(/\s/g,'').replace(',','.');
  if(!raw)return {value:null,error:'Brak wartości'};
  const parsed=Number(raw);
  if(!Number.isFinite(parsed)||parsed<0)return {value:null,error:'Nieprawidłowa wartość'};
  return {value:Math.round(parsed*100)/100,error:''};
}

function readCalculationWorkbook(buffer) {
  const files=unzip(buffer),workbook=files.get('xl/workbook.xml');
  if(!workbook)fail('Plik nie zawiera skoroszytu Excel.');
  const sharedXml=files.get('xl/sharedStrings.xml')||'';
  const sharedStrings=[...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match=>textTags(match[1]));
  const relsXml=files.get('xl/_rels/workbook.xml.rels')||'',relations={};
  for(const rel of relsXml.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)){
    const attr=attributes(rel[1]);if(attr.Id&&attr.Target)relations[attr.Id]=attr.Target.replace(/^\//,'').startsWith('xl/')?attr.Target.replace(/^\//,''):`xl/${attr.Target.replace(/^\//,'')}`;
  }
  const sheets=[];
  for(const match of workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)){
    const attr=attributes(match[1]),path=relations[attr['r:id']];if(path&&files.has(path))sheets.push({name:attr.name,rows:parseSheet(files.get(path),sharedStrings)});
  }
  const preferred=sheets.find(sheet=>normalizeHeader(sheet.name)==='kalkulacja');
  const candidates=preferred?[preferred,...sheets.filter(sheet=>sheet!==preferred)]:sheets;
  let selected=null,header=null,indexes=null;
  for(const sheet of candidates){
    for(let i=0;i<Math.min(sheet.rows.length,100);i++){
      const values=(sheet.rows[i]||[]).map(normalizeHeader),symbol=values.indexOf('symbol'),current=values.indexOf('cena do kalkulacji'),theoretical=values.findIndex(value=>['cena do kalkulacji teoretycznie','cena teoretyczna do kalkulacji'].includes(value));
      if(symbol>=0&&current>=0&&theoretical>=0){selected=sheet;header=i;indexes={symbol,current,theoretical,name:values.indexOf('nazwa')};break;}
    }
    if(selected)break;
  }
  if(!selected)fail('Nie znaleziono arkusza z kolumnami Symbol, Cena do kalkulacji i Cena do kalkulacji teoretycznie.');
  const rows=[],seen=new Set();let duplicateCount=0;
  for(const row of selected.rows.slice(header+1)){
    const rawSymbol=String(row[indexes.symbol]??'').trim();if(!rawSymbol)continue;
    const key=normalizeSymbol(rawSymbol);if(seen.has(key)){duplicateCount++;continue;}seen.add(key);
    const current=parseMoney(row[indexes.current]),theoretical=parseMoney(row[indexes.theoretical]);
    rows.push({raw_symbol:rawSymbol,raw_symbol_key:key,article_name:indexes.name>=0?String(row[indexes.name]??'').trim():'',current_price:current.value,theoretical_price:theoretical.value,current_error:current.error,theoretical_error:theoretical.error});
  }
  if(!rows.length)fail('Arkusz kalkulacji nie zawiera wierszy z symbolami artykułów.');
  return {sheet:selected.name,rows,duplicateCount};
}

module.exports={readCalculationWorkbook,normalizeHeader};
