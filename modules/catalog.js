'use strict';
const V = require('../views');
const Changes = require('./card-changes');
const ArchiveCleanup = require('./archive-cleanup');
const SourceImport = require('./source-import');
const { esc: e, datepl: date } = V;
const writable = u => ['admin','approver','technologist'].includes(u.role);
const input = (name, label, required = false) => `<label>${label}<input name="${name}" ${required ? 'required' : ''} maxlength="150"></label>`;
function projectArticleInput(db, { optional = true } = {}) {
  const articles = db.prepare('SELECT id,symbol FROM articles WHERE archived_at IS NULL AND purged_at IS NULL ORDER BY symbol_key,id').all();
  const options = articles.map(a => `<option value="${a.id}">${e(a.symbol)} · #${a.id}</option>`).join('');
  const modes = [
    ...(optional ? [['none', 'Dodaj później']] : []),
    ...(articles.length ? [['existing', 'Dodaj istniejący artykuł']] : []),
    ['new', 'Utwórz nowy artykuł'],
  ];
  const initialMode = optional ? 'none' : (articles.length ? 'existing' : 'new');
  return `<label>Artykuł do etapu<select name="article_mode" data-project-article-mode>${modes.map(([value,label])=>`<option value="${value}" ${value===initialMode?'selected':''}>${label}</option>`).join('')}</select></label>${articles.length?`<div data-project-article-panel="existing" hidden><label>Wybierz artykuł z kartoteki<select name="article_id"><option value="">Wybierz artykuł</option>${options}</select></label></div>`:''}<div data-project-article-panel="new" hidden>${input('symbol','Symbol nowego artykułu')}</div>`;
}
function getArticle(db, id, fail) { const a = db.prepare('SELECT * FROM articles WHERE id=?').get(id); if (!a) fail(404, 'Nie znaleziono artykułu.'); return a; }
function safeReturnTo(url,id) {
  const requested=String(url.searchParams.get('return_to')||'');
  return /^\/projects\/\d+$/.test(requested)||requested===`/articles/${id}`?requested:`/articles/${id}`;
}
function associate(ctx, pid, form) {
  const { db, fail, makeArticle } = ctx;
  if (form.article_mode === 'new') {
    const symbol = String(form.symbol || '').trim();
    if (!symbol || symbol.length > 150) fail(400, 'Podaj symbol nowego artykułu (do 150 znaków).');
    if (db.prepare('SELECT id FROM articles WHERE symbol_key=?').get(symbol.toUpperCase().replace(/\s/g,''))) fail(409, 'Artykuł już istnieje. Wybierz powiązanie z istniejącym.');
    return makeArticle(pid, symbol).id;
  }
  if (form.article_mode === 'existing') {
    let id = Number(form.article_id);
    if ((!Number.isSafeInteger(id) || id < 1) && form.existing_symbol) {
      const matches = db.prepare('SELECT id FROM articles WHERE symbol_key=?').all(String(form.existing_symbol).toUpperCase().replace(/\s/g,''));
      if (matches.length !== 1) fail(400, 'Wybierz jednoznaczny artykuł z kartoteki.');
      id = matches[0].id;
    }
    const article=db.prepare('SELECT id,archived_at,purged_at FROM articles WHERE id=?').get(id);
    if (!Number.isSafeInteger(id) || id < 1 || !article || article.archived_at || article.purged_at) fail(400, 'Wybierz aktywny artykuł z kartoteki.');
    if (!pid) fail(400, 'Artykuły można przypisać do projektu z poziomu projektu.');
    db.prepare('INSERT OR IGNORE INTO project_articles VALUES(?,?)').run(pid,id); return id;
  }
  if (form.article_mode && form.article_mode !== 'none') fail(400,'Nieprawidłowy sposób powiązania.');
  return null;
}
async function handle(ctx) {
  const { db,req,res,p,url,form,send,redirect,fail,transaction,audit,now,blank } = ctx;
  const csrf = `<input type="hidden" name="csrf" value="${e(req.session.csrf)}">`;
  const page = body => {
    const flashes=ctx.getFlashes(req);
    if(req.sourceImportNotice)flashes.push({category:'warning',message:req.sourceImportNotice});
    return send(req,res,200,V.layout({user:req.user,csrf:req.session.csrf,flashes,body}));
  };
  const edit = () => ctx.role(req.user,'admin','approver','technologist');
  if ((p === '/' || p === '/articles') && req.method === 'GET') {
    const params = [], where = ['a.archived_at IS NULL','a.purged_at IS NULL'];
    const q = (url.searchParams.get('q') || '').trim();
    for(const word of q.split(/\s+/).filter(Boolean)) { where.push('search_text(a.symbol || \' \' || a.description) LIKE ?'); params.push(`%${ctx.normalize(word).replace(/[\\%_]/g,'\\$&')}%`); }
    const sort = url.searchParams.get('sort') || 'newest';
    const order = {newest:'a.created_at DESC,a.id DESC',oldest:'a.created_at,a.id',updated:'updated DESC,a.id DESC',symbol:'a.symbol_key,a.id'}[sort] || 'a.created_at DESC,a.id DESC';
    const clause = where.length ? `WHERE ${where.map(w=>w.includes('LIKE') ? w+" ESCAPE '\\'" : w).join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) n FROM articles a ${clause}`).get(...params).n;
    const n = Math.max(1,Math.min(Math.ceil(total/50)||1,parseInt(url.searchParams.get('page'))||1));
    const rows = db.prepare(`SELECT a.*,
      max(a.updated_at,coalesce((SELECT max(updated_at) FROM records WHERE article_id=a.id),a.updated_at)) updated,
      (SELECT count(*) FROM project_articles pa WHERE pa.article_id=a.id) project_count
      FROM articles a ${clause} ORDER BY ${order} LIMIT 50 OFFSET ?`).all(...params,(n-1)*50);
    const pageUrl = n => { const sp = new URLSearchParams(url.searchParams); sp.set('page',n); return '/articles?'+sp; };
    const create = writable(req.user) ? `<button type="button" class="primary" data-open-dialog="new-article">+ Dodaj artykuł</button><dialog class="form-dialog" id="new-article"><form method="dialog" class="dialog-head"><strong>Dodaj artykuł</strong><button type="submit" aria-label="Zamknij">×</button></form><form method="post" action="/articles" class="dialog-body">${csrf}<p class="muted small">Indeks wewnętrzny artykułu zostanie nadany automatycznie.</p>${input('symbol','Symbol artykułu',true)}<label>Opis dzianiny<input name="description" maxlength="6000"></label><div class="actions"><button type="button" data-close-dialog>Anuluj</button><button class="primary">Utwórz artykuł</button></div></form></dialog>` : '';
    let backup = '';
    if(req.user.role === 'admin') { const s=ctx.readBackup(); const ok=s?.ok && s.last_success && Date.now()-Date.parse(s.last_success)<36*3600000; backup=`<div class="notice ${ok?'success':'warning'}">Kopie zapasowe: ${s?.last_success ? date(s.last_success) : 'brak potwierdzonej kopii'}${ok?'':' — sprawdź harmonogram z administratorem.'}</div>`; }
    page(`<div class="pagehead"><div><span class="eyebrow">GŁÓWNA KARTOTEKA</span><h1>Artykuły</h1><p class="muted"><span data-live-count>${total}</span> artykułów · wspólna kartoteka wszystkich produktów.</p></div>${create}</div>${backup}<form class="searchbar" data-live-search><input name="q" value="${e(q)}" placeholder="Szukaj symbolu lub opisu" aria-label="Szukaj"><select name="sort" aria-label="Sortowanie">${Object.entries({newest:'Najnowsze',oldest:'Najstarsze',updated:'Ostatnio aktualizowane',symbol:'Symbol A–Z'}).map(([k,v])=>`<option value="${k}" ${sort===k?'selected':''}>${v}</option>`).join('')}</select></form><div data-live-results aria-live="polite"><div class="panel scroll"><table class="listing"><thead><tr><th>Artykuł</th><th>Utworzono</th><th>Aktualizacja</th><th>Projekty / próby</th><th>Technologia</th><th></th></tr></thead><tbody>${rows.map(a=>`<tr><td><a class="item-title" href="/articles/${a.id}">${e(a.symbol)}</a></td><td>${date(a.created_at)}</td><td>${date(a.updated)}</td><td>${a.project_count}</td><td>${a.active_spec?'Zatwierdzona':'Do opracowania'}</td><td class="row-actions">${writable(req.user)?`<a class="delete-x" href="/articles/${a.id}/delete" aria-label="Archiwizuj artykuł ${e(a.symbol)}" title="Archiwizuj">×</a>`:''}</td></tr>`).join('')||'<tr><td colspan="6">Brak artykułów.</td></tr>'}</tbody></table></div><div class="pagination">${n>1?`<a href="${e(pageUrl(n-1))}">← Poprzednia</a>`:''}Strona ${n}${n*50<total?`<a href="${e(pageUrl(n+1))}">Następna →</a>`:''}</div></div>`);return true;
  }
  if(p === '/articles' && req.method === 'POST') {
    edit(); const id=transaction(()=> {
      const aid=associate(ctx,null,{...form,article_mode:'new'});
      db.prepare('UPDATE articles SET description=? WHERE id=?').run(String(form.description||'').slice(0,6000),aid);
      audit(req.user,'Utworzono artykuł',null,`Artykuł ${aid}`); return aid;
    });redirect(req,res,`/articles/${id}`);return true;
  }
  const match=p.match(/^\/articles\/(\d+)(?:\/(metadata|symbol|new|delete|restore|purge|production-note))?$/);
  if(!match) return false;
  const id=Number(match[1]), a=getArticle(db,id,fail), action=match[2];
  req.sourceImportNotice=SourceImport.noticeForArticle(db,id);
  if(req.method==='POST'&&action==='production-note') {
    edit();if(a.archived_at||a.purged_at)fail(409,'Zarchiwizowanego artykułu nie można edytować.');
    const note=String(form.production_notes||'').trim().slice(0,6000);
    transaction(()=>{
      const current=getArticle(db,id,fail);if(current.archived_at||current.purged_at)fail(409,'Zarchiwizowanego artykułu nie można edytować.');
      if(current.pending_production_notes===note)return;
      db.prepare('UPDATE articles SET pending_production_notes=?,updated_at=? WHERE id=?').run(note,now(),id);
      audit(req.user,'Zapisano jednorazowe informacje do produkcji',null,JSON.stringify({article:current.symbol,note}),id);
    });
    redirect(req,res,`/articles/${id}`,note?'Informacje zostaną dołączone do następnej wydanej karty.':'Usunięto oczekujące informacje do produkcji.');return true;
  }
  if(req.method==='POST'&&action==='purge') {
    edit();if(!a.archived_at||a.purged_at)fail(409,'Artykuł nie jest dostępny do usunięcia z archiwum.');
    ArchiveCleanup.purgeArticle(db,id,ctx.photos.directory);
    audit(req.user,'Usunięto artykuł z archiwum',null,`Artykuł #${id}: ${a.symbol}`);
    redirect(req,res,'/archive','Artykuł usunięto z widocznego archiwum. Historyczne specyfikacje, próby i karty pozostają dostępne.');return true;
  }
  if(req.method==='POST') {
    edit();
    if(action!=='restore'&&(a.archived_at||a.purged_at))fail(409,'Zarchiwizowanego artykułu nie można edytować. Najpierw przywróć go z archiwum.');
    let firstArticleSpec=false;
    const result=transaction(()=>{
      if(action==='delete') {
        const current=getArticle(db,id,fail);if(current.archived_at||current.purged_at)fail(409,'Ten artykuł jest już w archiwum.');
        db.prepare('UPDATE articles SET archived_at=? WHERE id=?').run(now(),id);audit(req.user,'Przeniesiono artykuł do archiwum',null,`Artykuł #${id}: ${a.symbol}`);
      } else if(action==='restore') {
        const current=getArticle(db,id,fail);if(!current.archived_at||current.purged_at)fail(409,'Tego artykułu nie można przywrócić.');
        if(Date.now()-Date.parse(current.archived_at)>30*86400000)fail(409,'Minęło 30 dni. Artykuł pozostaje zachowany w historii, ale nie można go już przywrócić.');
        db.prepare('UPDATE articles SET archived_at=NULL WHERE id=?').run(id);audit(req.user,'Przywrócono artykuł z archiwum',null,`Artykuł #${id}: ${a.symbol}`);
      } else if(action==='metadata') {
        if(String(form.updated_at)!==getArticle(db,id,fail).updated_at) fail(409,'Artykuł został zmieniony. Odśwież dane przed zapisem.');
        db.prepare('UPDATE articles SET description=?,updated_at=? WHERE id=?').run(String(form.description||'').slice(0,6000),new Date().toISOString(),id);
        audit(req.user,'Zmieniono opis artykułu',null,`Artykuł ${id}`);
      } else if(action==='symbol') {
        const current=getArticle(db,id,fail);
        if(String(form.updated_at)!==current.updated_at) fail(409,'Artykuł został zmieniony. Odśwież dane przed zapisem.');
        const symbol=String(form.symbol||'').trim();
        if(!symbol||symbol.length>150) fail(400,'Podaj symbol artykułu (do 150 znaków).');
        const symbolKey=symbol.toUpperCase().replace(/\s/g,'');
        if(db.prepare('SELECT id FROM articles WHERE symbol_key=? AND id<>? LIMIT 1').get(symbolKey,id)) fail(409,'Artykuł o takim symbolu już istnieje.');
        const stamp=now();
        db.prepare('UPDATE articles SET symbol=?,symbol_key=?,updated_at=? WHERE id=?').run(symbol,symbolKey,stamp,id);
        const linkedRecords=db.prepare('SELECT id,payload FROM records WHERE article_id=?').all(id);
        const updateRecord=db.prepare('UPDATE records SET symbol=?,payload=? WHERE id=?');
        for(const record of linkedRecords) {
          let payload={};try{payload=JSON.parse(record.payload||'{}')}catch{}
          payload.symbol=symbol;
          updateRecord.run(symbol,JSON.stringify(payload),record.id);
        }
        audit(req.user,'Zmieniono symbol artykułu',null,JSON.stringify({before:current.symbol,after:symbol}),id);
      } else if(action==='new') {
        firstArticleSpec=!db.prepare('SELECT 1 FROM records WHERE article_id=? AND archived_at IS NULL LIMIT 1').get(id);
        const source=db.prepare("SELECT * FROM records WHERE article_id=? AND kind='spec' AND archived_at IS NULL ORDER BY id DESC LIMIT 1").get(id);
        const v=source?JSON.parse(source.payload):blank();v.symbol=a.symbol;if(!source)v.date=ctx.todayWarsaw();
        const rid=db.prepare("INSERT INTO records(article_id,kind,symbol,base_id,payload,created_at,updated_at,expected_active) VALUES(?,'spec',?,?,?,?,?,?)").run(id,a.symbol,source?.id||null,JSON.stringify(v),now(),now(),a.active_spec).lastInsertRowid;
        audit(req.user,'Utworzono specyfikację artykułu',rid,source?`Na podstawie wpisu ${source.id}`:'');return Number(rid);
      } else fail(404,'Nie znaleziono operacji.');
    });redirect(req,res,result?`/records/${result}/edit${firstArticleSpec?'?new_article=1':''}`:action==='delete'?safeReturnTo(url,id):`/articles/${id}`);return true;
  }
    if(req.method==='GET'&&action==='delete') {
      edit();if(a.archived_at||a.purged_at)fail(409,'Ten artykuł jest już w archiwum.');
      page(V.confirmArchiveArticlePage({user:req.user,csrf:req.session.csrf,flashes:ctx.getFlashes(req),a,returnTo:safeReturnTo(url,id)}));return true;
    }
    if(req.method==='GET'&&action==='purge') {
      edit();if(!a.archived_at||a.purged_at)fail(409,'Ten artykuł nie jest w archiwum.');
      page(V.confirmPurgeArticlePage({user:req.user,csrf:req.session.csrf,flashes:ctx.getFlashes(req),a}));return true;
    }
    if(req.method!=='GET'||action) return false;
    const isWritable=writable(req.user)&&!a.archived_at&&!a.purged_at;
  const articleUpdated=db.prepare('SELECT max(a.updated_at,coalesce((SELECT max(updated_at) FROM records WHERE article_id=a.id),a.updated_at)) updated FROM articles a WHERE a.id=?').get(id).updated;
  const projects=db.prepare('SELECT p.* FROM projects p JOIN project_articles pa ON pa.project_id=p.id WHERE pa.article_id=? ORDER BY p.created_at DESC,p.id DESC').all(id);
  const historyPage=Math.max(1,parseInt(url.searchParams.get('history_page'))||1);
  const recordCount=db.prepare('SELECT count(*) n FROM records WHERE article_id=? AND archived_at IS NULL').get(id).n;
  const currentRecord=db.prepare('SELECT r.id,r.kind,r.symbol,r.state,r.version,r.updated_at,1 is_current FROM records r WHERE r.id=? AND r.archived_at IS NULL').get(a.active_spec);
  const historyCount=recordCount-(currentRecord?1:0);
  const historyRecords=db.prepare("SELECT r.id,r.kind,r.symbol,r.state,r.version,r.updated_at,0 is_current FROM records r WHERE r.article_id=? AND r.archived_at IS NULL AND r.id<>coalesce(?,0) ORDER BY CASE WHEN r.kind='spec' AND r.state!='approved' THEN 0 WHEN r.kind='spec' THEN 1 ELSE 2 END,r.id DESC LIMIT 50 OFFSET ?").all(id,currentRecord?.id||0,(historyPage-1)*50);
  const records=[...(currentRecord?[currentRecord]:[]),...historyRecords];
  const cards=db.prepare('SELECT c.id,c.machine,c.created_at FROM cards c JOIN records r ON r.id=c.record_id WHERE r.article_id=? ORDER BY c.id DESC LIMIT 50').all(id);
  const changeRows=db.prepare(`SELECT a.*,u.name author FROM audit a JOIN records r ON r.id=a.record_id LEFT JOIN users u ON u.id=a.user_id WHERE r.article_id=? AND r.kind='spec' AND r.state='approved' AND a.action='Zatwierdzono zmianę karty' ORDER BY a.id DESC LIMIT 100`).all(id);
  const changesHistory=changeRows.map(row=>{
    let detail={};try{detail=JSON.parse(row.detail||'{}')}catch{}
    const changes=detail.before&&detail.after?Changes.changes(detail.before,detail.after):[];
    const editor=detail.author_id?db.prepare('SELECT name FROM users WHERE id=?').get(detail.author_id):null;
    return {at:detail.edited_at||row.at,author:editor?.name||row.author||'Nieznany',action:row.action,comment:detail.comment||'',changes,version:detail.version};
  }).filter(row=>row.changes.length||row.comment);
  const changesView=changesHistory.length?`<section class="panel padded"><h3>Historia zmian</h3>${changesHistory.map(change=>`<article class="history"><strong>${date(change.at)} · ${e(change.author)}${change.version?` · zatwierdzona wersja v${e(change.version)}`:''}</strong><div>${change.changes.map(item=>`<p><b>${e(item.label)}:</b> <del>${e(item.before)}</del> → <strong>${e(item.after)}</strong></p>`).join('')}${change.comment?`<p class="preline"><b>Komentarz:</b> ${e(change.comment)}</p>`:''}</div></article>`).join('')}</section>`:'<p class="muted">Historia zmian pojawi się po zatwierdzeniu pierwszej zmiany karty.</p>';
  const descriptionEditor=isWritable?`<details class="description-edit"><summary class="button">Edytuj opis</summary><form method="post" action="/articles/${id}/metadata">${csrf}<input type="hidden" name="updated_at" value="${e(a.updated_at)}"><label>Opis<textarea name="description" maxlength="6000">${e(a.description)}</textarea></label><button>Zapisz opis</button></form></details>`:'';
  const symbolEditor=isWritable?`<details class="description-edit symbol-edit"><summary class="button">Edytuj symbol artykułu</summary><form method="post" action="/articles/${id}/symbol">${csrf}<input type="hidden" name="updated_at" value="${e(a.updated_at)}"><label>Symbol artykułu<input name="symbol" maxlength="150" value="${e(a.symbol)}" required></label><p class="muted small">Numer wewnętrzny artykułu (#${id}) pozostanie bez zmian. Zmiana symbolu uaktualni powiązane specyfikacje.</p><button>Zapisz symbol</button></form></details>`:'';
  const productionNoteButton=isWritable?`<button type="button" class="button special-production-button" data-open-dialog="production-note-${id}">POLECENIA SPECJALNE – najbliższa produkcja</button>`:'';
  const productionNoteDialog=isWritable?`<dialog class="form-dialog" id="production-note-${id}"><form method="dialog" class="dialog-head"><strong>Polecenia specjalne — najbliższa produkcja</strong><button type="submit" aria-label="Zamknij">×</button></form><form method="post" action="/articles/${id}/production-note" class="dialog-body">${csrf}<p class="muted">Pojawią się jako ostrzeżenie na ekranie wydawania karty oraz w osobnym wierszu na dole następnej wydanej karty. Po wydaniu zostaną wyczyszczone z artykułu.</p><label>Polecenia specjalne<textarea name="production_notes" maxlength="6000" placeholder="Np. sposób pakowania, paletowanie, średnica tulei…">${e(a.pending_production_notes||'')}</textarea></label><div class="actions"><button type="button" data-close-dialog>Anuluj</button><button class="primary">Zapisz polecenia</button></div></form></dialog>`:'';
  const newSpecButton=isWritable?`<form method="post" action="/articles/${id}/new" class="article-new-spec">${csrf}<button>+ Nowa specyfikacja</button></form>`:'';
  const specs=records.filter(r=>r.kind==='spec'),trials=records.filter(r=>r.kind==='trial'),current=specs.find(r=>r.is_current),drafts=specs.filter(r=>r.state!=='approved'),history=specs.filter(r=>r.state==='approved'&&!r.is_current);
  const tile=r=>`<a class="record-tile" href="/records/${r.id}"><span class="badge ${e(r.state)}">${e(V.STATE[r.state])}${r.version?` · v${r.version}`:''}</span><h3>${e(r.symbol)}</h3><p>${r.is_current?'Obowiązująca technologia':r.state==='approved'?'Archiwalna wersja':'Robocza — nie wpływa na produkcję do czasu zatwierdzenia'}</p><small>${date(r.updated_at)} · wpis ${r.id}</small></a>`;
  const currentView=current?`<section class="current-spec"><h2>Aktualna specyfikacja</h2><div class="grid">${tile(current)}</div></section>`:'<section class="panel padded"><h2>Aktualna specyfikacja</h2><p class="muted">Brak zatwierdzonej technologii dla tego artykułu.</p></section>';
  const draftsView=drafts.length?`<section class="draft-specs"><h2>Robocze zmiany</h2><p class="muted small">Wymagają zatwierdzenia i nie zastępują aktualnej specyfikacji.</p><div class="grid">${drafts.map(r=>`<div class="draft-spec-entry">${tile(r)}${isWritable&&r.state==='draft'?`<a class="delete-x" href="/records/${r.id}/delete" aria-label="Archiwizuj roboczą specyfikację ${e(r.symbol)}" title="Archiwizuj roboczą specyfikację">×</a>`:''}</div>`).join('')}</div></section>`:'';
  const historyView=history.length?`<details class="spec-history"><summary>Archiwalne wersje (${history.length})</summary><div class="grid">${history.map(tile).join('')}</div></details>`:'';
  const trialsView=trials.length?`<h2>Próby i warianty</h2><div class="grid">${trials.map(tile).join('')}</div>`:'';
  const articleArchiveNotice=a.purged_at?'<div class="notice warning"><strong>Artykuł usunięto z widocznej kartoteki.</strong> Historyczne specyfikacje, projekty i karty nadal są dostępne.</div>':a.archived_at?'<div class="notice warning"><strong>Artykuł jest w archiwum.</strong> Można go przywrócić przez 30 dni w zakładce Archiwum.</div>':'';
  const activeActions=`<div class="article-technology-actions">${a.active_spec?`<a class="button primary" href="/records/${a.active_spec}">Otwórz obowiązującą technologię</a>`:''}${productionNoteButton}</div>${newSpecButton}${a.pending_production_notes?`<p class="notice production-note-saved">Polecenia specjalne czekają na najbliższe wydanie karty.</p>`:''}${productionNoteDialog}`;
  page(`<a href="/articles">← Artykuły</a>${articleArchiveNotice}<div class="pagehead"><div><h1>${e(a.symbol)}</h1>${symbolEditor}<div class="article-description"><p class="preline">${e(a.description)}</p>${descriptionEditor}</div><p>Utworzono: ${date(a.created_at)} · Aktualizacja: ${date(articleUpdated)}</p></div></div>${activeActions}<h2>Technologia artykułu</h2>${currentView}${draftsView}${historyView}<h2>Próby i warianty artykułu</h2>${trialsView||'<p class="muted">Brak prób.</p>'}${changesView}<div class="pagination">${historyPage>1?`<a href="?history_page=${historyPage-1}">← Poprzednie wpisy</a>`:''}${historyPage*50<historyCount?`<a href="?history_page=${historyPage+1}">Kolejne wpisy →</a>`:''}</div><h2>Ostatnie wydane karty (do 50)</h2>${cards.map(c=>`<p><a href="/cards/${c.id}" target="_blank" rel="noopener">Karta #${c.id} · ${e(c.machine)} · ${date(c.created_at)} ↗</a></p>`).join('')||'<p>Brak wydanych kart.</p>'}<h2>Projekty / próby</h2>${projects.map(pr=>`<p><a href="/projects/${pr.id}">${e(pr.trial_number||`#${pr.id}`)} · ${e(pr.short_description||pr.name)}</a>${pr.archived_at?' <span class="badge archived">Archiwalny</span>':''}</p>`).join('')||'<p>Artykuł nie jest jeszcze przypisany do projektu / próby.</p>'}${ctx.photos.panel('article',id,{...req,readOnly:!isWritable})}`);return true;
}
module.exports={handle,projectArticleInput,associate};
