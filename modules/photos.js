'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {esc:e,datepl:date}=require('../views');
// Reject malformed headers and images larger than the client resize limit.
function validJpeg(bytes) {
 if(bytes.length<20||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return false;
 let i=2,dimensions=false;
 while(i+4<bytes.length) {
  if(bytes[i++]!==255)return false;
  while(bytes[i]===255)i++;
  const marker=bytes[i++];
  if(marker===218)return dimensions;
  const length=bytes.readUInt16BE(i);
  if(length<2||i+length>bytes.length)return false;
  if([192,193,194].includes(marker)) {
   if(length<8)return false;
   const h=bytes.readUInt16BE(i+3),w=bytes.readUInt16BE(i+5);
   if(!h||!w||h>1600||w>1600)return false;
   dimensions=true;
  }
  i+=length;
 }
 return false;
}
function create({db,DATA,fail,role,transaction,audit,now,send,redirect}) {
  const directory=path.join(DATA,'photos');
  const column=kind=>({article:'article_id',record:'record_id',project:'project_id'})[kind];
  function panel(kind,id,req) {
    if(!column(kind))throw new Error('Nieprawidłowy typ zdjęcia.');
    const rows=db.prepare(`SELECT p.*,u.name author FROM photos p JOIN users u ON u.id=p.created_by WHERE ${column(kind)}=? ORDER BY p.id DESC LIMIT 100`).all(id);
    const canEdit=['admin','approver','technologist'].includes(req.user.role)&&!req.readOnly;
    const heading=kind==='project'?'Zdjęcia próby':'Zdjęcia (opcjonalnie)';
    return `<section class="panel padded"><h2>${heading}</h2><div class="photo-grid">${rows.map(p=>`<figure><a href="/photos/${p.id}" target="_blank" rel="noopener"><img src="/photos/${p.id}" loading="lazy" alt="${e(p.caption||'Zdjęcie dzianiny')}"></a><figcaption>${e(p.caption)}<br><small>${e(p.author)} · ${date(p.created_at)}</small></figcaption></figure>`).join('')||'<p>Brak zdjęć.</p>'}</div>${canEdit?`<form method="post" action="/photos" data-photo><input type="hidden" name="csrf" value="${e(req.session.csrf)}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${id}"><input type="hidden" name="image"><label>Zdjęcie z komputera<input type="file" accept="image/jpeg,image/png,image/webp" data-photo-file required></label><label>Opis zdjęcia<input name="caption" maxlength="500"></label><p class="muted">Zdjęcie zostanie zmniejszone przed wysłaniem. Nie jest automatycznie dodawane do wydruku karty.</p><button class="primary">Dodaj zdjęcie</button><p data-photo-status role="status"></p></form>`:''}</section>`;
  }
  function handle({req,res,p,form}) {
    const m=p.match(/^\/photos\/(\d+)$/);
    if(m&&req.method==='GET') {
      const row=db.prepare('SELECT file FROM photos WHERE id=?').get(Number(m[1]));if(!row) fail(404,'Nie znaleziono zdjęcia.');
      const file=path.join(directory,path.basename(row.file));if(!fs.existsSync(file)) fail(404,'Brak pliku zdjęcia.');
      send(req,res,200,fs.readFileSync(file),'image/jpeg');return true;
    }
    if(p!=='/photos'||req.method!=='POST')return false;
    role(req.user,'admin','approver','technologist');
    if(!['article','record','project'].includes(form.kind))fail(400,'Nieprawidłowe powiązanie zdjęcia.');
    const id=Number(form.id), table={article:'articles',record:'records',project:'projects'}[form.kind];
    if(!Number.isSafeInteger(id)||!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id))fail(404,'Nie znaleziono wpisu.');
    if(form.kind==='record'&&db.prepare('SELECT archived_at FROM records WHERE id=?').get(id).archived_at)fail(409,'Nie można dodawać zdjęć do zarchiwizowanej próby lub specyfikacji.');
    if(form.kind==='project'&&db.prepare('SELECT archived_at FROM projects WHERE id=?').get(id).archived_at)fail(409,'Nie można dodawać zdjęć do zarchiwizowanej próby.');
    if(form.kind==='article'&&db.prepare('SELECT archived_at,purged_at FROM articles WHERE id=?').get(id)?.archived_at)fail(409,'Nie można dodawać zdjęć do zarchiwizowanego artykułu.');
    if(form.kind==='article'&&db.prepare('SELECT purged_at FROM articles WHERE id=?').get(id)?.purged_at)fail(409,'Artykuł został usunięty z kartoteki.');
    // Append-only attachments never alter an approved specification or issued card.
    if(db.prepare(`SELECT count(*) n FROM photos WHERE ${column(form.kind)}=?`).get(id).n>=100)fail(400,'Limit 100 zdjęć dla jednego wpisu.');
    const match=String(form.image||'').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if(!match)fail(400,'Prześlij zdjęcie przez formularz. Obsługujemy JPEG po zmniejszeniu w przeglądarce.');
    const bytes=Buffer.from(match[1],'base64');
    if(bytes.length>2*1024*1024||!validJpeg(bytes))fail(400,'Nieprawidłowe zdjęcie JPEG lub przekroczono limit 2 MB.');
    fs.mkdirSync(directory,{recursive:true});const name=crypto.randomUUID()+'.jpg';const file=path.join(directory,name);
    fs.writeFileSync(file,bytes,{flag:'wx'});
    try {transaction(()=>{
      db.prepare(`INSERT INTO photos(${column(form.kind)},file,caption,created_at,created_by) VALUES(?,?,?,?,?)`).run(id,name,String(form.caption||'').slice(0,500),now(),req.user.id);
      const aid=form.kind==='article'?id:form.kind==='record'?db.prepare('SELECT article_id FROM records WHERE id=?').get(id).article_id:null;
      if(aid)db.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(new Date().toISOString(),aid);
      if(form.kind==='project')db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(),id);
      audit(req.user,'Dodano zdjęcie',form.kind==='record'?id:null,`${form.kind} ${id}: ${name}`,form.kind==='article'?id:undefined);
    });}catch(err){fs.unlinkSync(file);throw err;}
    redirect(req,res,`/${form.kind==='article'?'articles':form.kind==='project'?'projects':'records'}/${id}`,'Dodano zdjęcie.');return true;
  }
  return {panel,handle,directory};
}
module.exports={create};
