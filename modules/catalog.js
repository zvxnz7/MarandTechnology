'use strict';
const V = require('../views');
const { esc: e, datepl: date } = V;
const writable = u => ['admin','approver','technologist'].includes(u.role);
const input = (name, label, required = false) => `<label>${label}<input name="${name}" ${required ? 'required' : ''} maxlength="150"></label>`;
function projectArticleInput(db, { optional = true } = {}) {
  const articles = db.prepare('SELECT id,symbol FROM articles ORDER BY symbol_key,id').all();
  const options = articles.map(a => `<option value="${a.id}">${e(a.symbol)} · #${a.id}</option>`).join('');
  const modes = [
    ...(optional ? [['none', 'Dodaj później']] : []),
    ...(articles.length ? [['existing', 'Dodaj istniejący artykuł']] : []),
    ['new', 'Utwórz nowy artykuł'],
  ];
  const initialMode = optional ? 'none' : (articles.length ? 'existing' : 'new');
  return `<label>Artykuł do projektu<select name="article_mode" data-project-article-mode>${modes.map(([value,label])=>`<option value="${value}" ${value===initialMode?'selected':''}>${label}</option>`).join('')}</select></label>${articles.length?`<div data-project-article-panel="existing" hidden><label>Wybierz artykuł z kartoteki<select name="article_id"><option value="">Wybierz artykuł</option>${options}</select></label></div>`:''}<div data-project-article-panel="new" hidden>${input('symbol','Symbol nowego artykułu')}</div>`;
}
function getArticle(db, id, fail) { const a = db.prepare('SELECT * FROM articles WHERE id=?').get(id); if (!a) fail(404, 'Nie znaleziono artykułu.'); return a; }
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
    if (!Number.isSafeInteger(id) || id < 1 || !db.prepare('SELECT id FROM articles WHERE id=?').get(id)) fail(400, 'Wybierz artykuł z kartoteki.');
    if (!pid) fail(400, 'Artykuły można przypisać do projektu z poziomu projektu.');
    db.prepare('INSERT OR IGNORE INTO project_articles VALUES(?,?)').run(pid,id); return id;
  }
  if (form.article_mode && form.article_mode !== 'none') fail(400,'Nieprawidłowy sposób powiązania.');
  return null;
}
async function handle(ctx) {
  const { db,req,res,p,url,form,send,redirect,fail,transaction,audit,now,blank } = ctx;
  const csrf = `<input type="hidden" name="csrf" value="${e(req.session.csrf)}">`;
  const page = body => send(req,res,200,V.layout({user:req.user,csrf:req.session.csrf,flashes:ctx.getFlashes(req),body}));
  const edit = () => ctx.role(req.user,'admin','approver','technologist');
  if ((p === '/' || p === '/articles') && req.method === 'GET') {
    const params = [], where = [];
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
    const create = writable(req.user) ? `<details class="panel padded"><summary>+ Dodaj artykuł</summary><form method="post" action="/articles">${csrf}${input('symbol','Symbol artykułu',true)}<label>Opis<textarea name="description" maxlength="6000"></textarea></label><button class="primary">Utwórz artykuł</button></form></details>` : '';
    let backup = '';
    if(req.user.role === 'admin') { const s=ctx.readBackup(); const ok=s?.ok && s.last_success && Date.now()-Date.parse(s.last_success)<36*3600000; backup=`<div class="notice ${ok?'success':'warning'}">Kopie zapasowe: ${s?.last_success ? date(s.last_success) : 'brak potwierdzonej kopii'}${ok?'':' — sprawdź harmonogram z administratorem.'}</div>`; }
    page(`<div class="pagehead"><div><span class="eyebrow">GŁÓWNA KARTOTEKA</span><h1>Artykuły</h1><p class="muted">${total} artykułów · wspólna kartoteka wszystkich produktów.</p></div></div>${backup}<form class="searchbar"><input name="q" value="${e(q)}" placeholder="Szukaj symbolu lub opisu" aria-label="Szukaj"><select name="sort" aria-label="Sortowanie">${Object.entries({newest:'Najnowsze',oldest:'Najstarsze',updated:'Ostatnio aktualizowane',symbol:'Symbol A–Z'}).map(([k,v])=>`<option value="${k}" ${sort===k?'selected':''}>${v}</option>`).join('')}</select><button>Filtruj</button></form><div class="panel scroll"><table class="listing"><thead><tr><th>Artykuł</th><th>Utworzono</th><th>Aktualizacja</th><th>Projekty / próby</th><th>Technologia</th></tr></thead><tbody>${rows.map(a=>`<tr><td><a class="item-title" href="/articles/${a.id}">${e(a.symbol)}</a></td><td>${date(a.created_at)}</td><td>${date(a.updated)}</td><td>${a.project_count}</td><td>${a.active_spec?'Zatwierdzona':'Do opracowania'}</td></tr>`).join('')||'<tr><td colspan="5">Brak artykułów.</td></tr>'}</tbody></table></div><div class="pagination">${n>1?`<a href="${e(pageUrl(n-1))}">← Poprzednia</a>`:''}Strona ${n}${n*50<total?`<a href="${e(pageUrl(n+1))}">Następna →</a>`:''}</div>${create}`);return true;
  }
  if(p === '/articles' && req.method === 'POST') {
    edit(); const id=transaction(()=> {
      const aid=associate(ctx,null,{...form,article_mode:'new'});
      db.prepare('UPDATE articles SET description=? WHERE id=?').run(String(form.description||'').slice(0,6000),aid);
      audit(req.user,'Utworzono artykuł',null,`Artykuł ${aid}`); return aid;
    });redirect(req,res,`/articles/${id}`);return true;
  }
  const match=p.match(/^\/articles\/(\d+)(?:\/(metadata|new|link))?$/);
  if(!match) return false;
  const id=Number(match[1]), a=getArticle(db,id,fail), action=match[2];
  if(req.method==='POST') {
    edit();
    const result=transaction(()=>{
      if(action==='metadata') {
        if(String(form.updated_at)!==getArticle(db,id,fail).updated_at) fail(409,'Artykuł został zmieniony. Odśwież dane przed zapisem.');
        db.prepare('UPDATE articles SET description=?,updated_at=? WHERE id=?').run(String(form.description||'').slice(0,6000),new Date().toISOString(),id);
        audit(req.user,'Zmieniono opis artykułu',null,`Artykuł ${id}`);
      } else if(action==='link') {
        const pid=Number(form.project_id);
        if(!Number.isSafeInteger(pid)||!db.prepare('SELECT id FROM projects WHERE id=?').get(pid))fail(400,'Wybierz projekt / próbę.');
        db.prepare('INSERT OR IGNORE INTO project_articles VALUES(?,?)').run(pid,id); audit(req.user,'Dodano artykuł do projektu / próby',null,`${id} / ${pid}`);
      } else if(action==='new') {
        const source=db.prepare("SELECT * FROM records WHERE article_id=? AND kind='spec' ORDER BY id DESC LIMIT 1").get(id);
        const v=source?JSON.parse(source.payload):blank();v.symbol=a.symbol;if(!source)v.date=ctx.todayWarsaw();
        const rid=db.prepare("INSERT INTO records(article_id,kind,symbol,base_id,payload,created_at,updated_at,expected_active) VALUES(?,'spec',?,?,?,?,?,?)").run(id,a.symbol,source?.id||null,JSON.stringify(v),now(),now(),a.active_spec).lastInsertRowid;
        audit(req.user,'Utworzono specyfikację artykułu',rid,source?`Na podstawie wpisu ${source.id}`:'');return Number(rid);
      } else fail(404,'Nie znaleziono operacji.');
    });redirect(req,res,result?`/records/${result}/edit`:`/articles/${id}`);return true;
  }
  if(req.method!=='GET'||action) return false;
  const articleUpdated=db.prepare('SELECT max(a.updated_at,coalesce((SELECT max(updated_at) FROM records WHERE article_id=a.id),a.updated_at)) updated FROM articles a WHERE a.id=?').get(id).updated;
  const projects=db.prepare('SELECT p.* FROM projects p JOIN project_articles pa ON pa.project_id=p.id WHERE pa.article_id=? ORDER BY p.id DESC').all(id);
  const unlinkedProjects=db.prepare('SELECT p.* FROM projects p WHERE NOT EXISTS(SELECT 1 FROM project_articles pa WHERE pa.project_id=p.id AND pa.article_id=?) ORDER BY p.name COLLATE NOCASE').all(id);
  const historyPage=Math.max(1,parseInt(url.searchParams.get('history_page'))||1);
  const recordCount=db.prepare('SELECT count(*) n FROM records WHERE article_id=?').get(id).n;
  const records=db.prepare('SELECT id,kind,symbol,state,version,updated_at FROM records WHERE article_id=? ORDER BY id DESC LIMIT 50 OFFSET ?').all(id,(historyPage-1)*50);
  const cards=db.prepare('SELECT c.id,c.machine,c.created_at FROM cards c JOIN records r ON r.id=c.record_id WHERE r.article_id=? ORDER BY c.id DESC LIMIT 50').all(id);
  const editor=writable(req.user)?`<details class="panel padded"><summary>Edytuj opis artykułu</summary><form method="post" action="/articles/${id}/metadata">${csrf}<input type="hidden" name="updated_at" value="${e(a.updated_at)}"><label>Opis<textarea name="description" maxlength="6000">${e(a.description)}</textarea></label><button>Zapisz opis</button></form></details><form method="post" action="/articles/${id}/new">${csrf}<button>+ Nowa specyfikacja</button></form>`:'';
  const links=writable(req.user)&&unlinkedProjects.length?`<form method="post" action="/articles/${id}/link" class="panel padded">${csrf}<label>Dodaj artykuł do projektu / próby<select name="project_id" required><option value="">Wybierz projekt / próbę</option>${unlinkedProjects.map(pr=>`<option value="${pr.id}">${e(pr.name)}</option>`).join('')}</select></label><button>Dodaj do projektu</button></form>`:'';
  page(`<a href="/articles">← Artykuły</a><h1>${e(a.symbol)}</h1><p class="preline">${e(a.description)}</p><p>Utworzono: ${date(a.created_at)} · Aktualizacja: ${date(articleUpdated)}</p>${a.active_spec?`<a class="button primary" href="/records/${a.active_spec}">Obowiązująca technologia</a>`:''}${editor}<h2>Próby i specyfikacje artykułu</h2><div class="grid">${records.map(r=>`<a class="record-tile" href="/records/${r.id}">${e(r.symbol)} · ${r.kind==='trial'?'Próba':'Specyfikacja'}<p>${e(V.STATE[r.state])}${r.version?' · v'+r.version:''}</p>${date(r.updated_at)}</a>`).join('')||'<p>Brak wpisów.</p>'}</div><div class="pagination">${historyPage>1?`<a href="?history_page=${historyPage-1}">← Poprzednie wpisy</a>`:''}${historyPage*50<recordCount?`<a href="?history_page=${historyPage+1}">Kolejne wpisy →</a>`:''}</div><h2>Ostatnie wydane karty (do 50)</h2>${cards.map(c=>`<p><a href="/cards/${c.id}">Karta #${c.id} · ${e(c.machine)} · ${date(c.created_at)}</a></p>`).join('')||'<p>Brak wydanych kart.</p>'}<h2>Projekty / próby</h2>${projects.map(pr=>`<p><a href="/projects/${pr.id}">#${pr.id} · ${e(pr.name)}</a></p>`).join('')||'<p>Artykuł nie jest jeszcze przypisany do projektu / próby.</p>'}${links}${ctx.photos.panel('article',id,req)}`);return true;
}
module.exports={handle,projectArticleInput,associate};
