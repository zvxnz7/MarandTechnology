'use strict';
const V = require('../views');
const { esc: e, datepl: date } = V;
const writable = u => ['admin','approver','technologist'].includes(u.role);
const input = (name, label, required = false) => `<label>${label}<input name="${name}" ${required ? 'required' : ''} maxlength="150"></label>`;
const select = (name, rows, value, placeholder) => `<select name="${name}" aria-label="${e(placeholder)}"><option value="">${e(placeholder)}</option>${rows.map(r => `<option value="${r.id}" ${String(value) === String(r.id) ? 'selected' : ''}>${e(r.label || r.name || r.symbol)}</option>`).join('')}</select>`;
function categories(db) { return db.prepare("SELECT c.*, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' → ' || c.name END label FROM categories c LEFT JOIN categories p ON p.id=c.parent_id ORDER BY label COLLATE NOCASE").all(); }
function categoryInput(db, value = '') { return select('category_id', categories(db), value, 'Grupa / podkategoria (opcjonalnie)'); }
function projectArticleInput(db) {
  return `<label>Powiązanie z artykułem<select name="article_mode"><option value="none">Na razie bez artykułu</option><option value="new">Utwórz również nowy artykuł</option><option value="existing">Powiąż z istniejącym</option></select></label>${input('symbol','Symbol nowego artykułu')}${categoryInput(db)}<label>Istniejący artykuł — wpisz symbol<input name="existing_symbol" maxlength="150" placeholder="Dokładny symbol artykułu"></label>`;
}
function getArticle(db, id, fail) { const a = db.prepare('SELECT * FROM articles WHERE id=?').get(id); if (!a) fail(404, 'Nie znaleziono artykułu.'); return a; }
function checkedCategory(db, raw, fail) {
  if (!raw) return null;
  const id = Number(raw); if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM categories WHERE id=?').get(id)) fail(400, 'Nieprawidłowa kategoria.');
  return id;
}
function associate(ctx, pid, form) {
  const { db, fail, makeArticle } = ctx;
  if (form.article_mode === 'new') {
    const symbol = String(form.symbol || '').trim();
    if (!symbol || symbol.length > 150) fail(400, 'Podaj symbol nowego artykułu (do 150 znaków).');
    if (db.prepare('SELECT id FROM articles WHERE symbol_key=?').get(symbol.toUpperCase().replace(/\s/g,''))) fail(409, 'Artykuł już istnieje. Wybierz powiązanie z istniejącym.');
    const a = makeArticle(pid, symbol);
    db.prepare('UPDATE articles SET category_id=? WHERE id=?').run(checkedCategory(db,form.category_id,fail), a.id);
    return a.id;
  }
  if (form.article_mode === 'existing') {
    const matches = db.prepare('SELECT id FROM articles WHERE symbol_key=?').all(String(form.existing_symbol || '').toUpperCase().replace(/\s/g,''));
    if (matches.length !== 1) fail(400, 'Podaj jednoznaczny symbol istniejącego artykułu. Jeśli są duplikaty, połącz projekt z poziomu wybranego artykułu.');
    db.prepare('INSERT OR IGNORE INTO project_articles VALUES(?,?)').run(pid,matches[0].id); return matches[0].id;
  }
  if (form.article_mode && form.article_mode !== 'none') fail(400,'Nieprawidłowy sposób powiązania.');
  return null;
}
async function handle(ctx) {
  const { db,req,res,p,url,form,send,redirect,fail,transaction,audit,now,blank } = ctx;
  const csrf = `<input type="hidden" name="csrf" value="${e(req.session.csrf)}">`;
  const page = body => send(req,res,200,V.layout({user:req.user,csrf:req.session.csrf,flashes:ctx.getFlashes(req),body}));
  const edit = () => ctx.role(req.user,'admin','approver','technologist');
  if (p === '/categories') {
    edit();
    if (req.method === 'POST') transaction(() => {
      const name = String(form.name || '').trim();
      if (!name || name.length > 100) fail(400,'Podaj nazwę kategorii (do 100 znaków).');
      const parent = checkedCategory(db,form.parent_id,fail);
      if (parent && db.prepare('SELECT parent_id FROM categories WHERE id=?').get(parent).parent_id) fail(400,'Podkategorię dodaj do głównej grupy.');
      if(db.prepare('SELECT id FROM categories WHERE coalesce(parent_id,0)=? AND name=? COLLATE NOCASE').get(parent || 0,name)) fail(409,'Taka kategoria już istnieje.');
      db.prepare('INSERT INTO categories(parent_id,name) VALUES(?,?)').run(parent,name); audit(req.user,'Dodano kategorię',null,name);
    });
    if(req.method === 'POST') { redirect(req,res,'/categories','Dodano kategorię.'); return true; }
    page(`<h1>Kategorie dzianin</h1><p>Dodawaj własne grupy i podkategorie. Kategorie służą do filtrowania katalogu artykułów.</p><div class="panel padded">${categories(db).map(c=>`<p>${e(c.label)}</p>`).join('') || 'Brak kategorii.'}</div><form method="post" class="panel padded">${csrf}${input('name','Nazwa',true)}${select('parent_id',categories(db).filter(c=>!c.parent_id),'','Nowa główna grupa')}<button class="primary">Dodaj kategorię</button></form>`); return true;
  }
  if ((p === '/' || p === '/articles') && req.method === 'GET') {
    const params = [], where = [];
    const q = (url.searchParams.get('q') || '').trim();
    for(const word of q.split(/\s+/).filter(Boolean)) { where.push('search_text(a.symbol || \' \' || a.description) LIKE ?'); params.push(`%${ctx.normalize(word).replace(/[\\%_]/g,'\\$&')}%`); }
    const category = url.searchParams.get('category') || '';
    if(category) { where.push('(a.category_id=? OR a.category_id IN(SELECT id FROM categories WHERE parent_id=?))');params.push(Number(category),Number(category)); }
    const type = url.searchParams.get('type') || '';
    if(type) { where.push('a.category_id IN(SELECT id FROM categories WHERE name=?)');params.push(type); }
    const sort = url.searchParams.get('sort') || 'newest';
    const order = {newest:'a.created_at DESC,a.id DESC',oldest:'a.created_at,a.id',updated:'updated DESC,a.id DESC',symbol:'a.symbol_key,a.id'}[sort] || 'a.created_at DESC,a.id DESC';
    const clause = where.length ? `WHERE ${where.map(w=>w.includes('LIKE') ? w+" ESCAPE '\\'" : w).join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) n FROM articles a ${clause}`).get(...params).n;
    const n = Math.max(1,Math.min(Math.ceil(total/50)||1,parseInt(url.searchParams.get('page'))||1));
    const rows = db.prepare(`SELECT a.*,c.name category,max(a.updated_at,coalesce((SELECT max(updated_at) FROM records WHERE article_id=a.id),a.updated_at)) updated FROM articles a LEFT JOIN categories c ON c.id=a.category_id ${clause} ORDER BY ${order} LIMIT 50 OFFSET ?`).all(...params,(n-1)*50);
    const types = db.prepare('SELECT DISTINCT name FROM categories WHERE parent_id IS NOT NULL ORDER BY name').all();
    const pageUrl = n => { const sp = new URLSearchParams(url.searchParams); sp.set('page',n); return '/articles?'+sp; };
    const create = writable(req.user) ? `<details class="panel padded"><summary>+ Dodaj artykuł</summary><form method="post" action="/articles">${csrf}${input('symbol','Symbol artykułu',true)}${categoryInput(db)}<label>Opis<textarea name="description" maxlength="6000"></textarea></label><button class="primary">Utwórz artykuł</button></form></details>` : '';
    let backup = '';
    if(req.user.role === 'admin') { const s=ctx.readBackup(); const ok=s?.ok && s.last_success && Date.now()-Date.parse(s.last_success)<36*3600000; backup=`<div class="notice ${ok?'success':'warning'}">Kopie zapasowe: ${s?.last_success ? date(s.last_success) : 'brak potwierdzonej kopii'}${ok?'':' — sprawdź harmonogram z administratorem.'}</div>`; }
    page(`<h1>Artykuły</h1><p>${total} artykułów · katalog dzianin i zatwierdzonych technologii</p>${backup}<form class="searchbar"><input name="q" value="${e(q)}" placeholder="Symbol lub opis" aria-label="Szukaj">${select('category',categories(db),category,'Wszystkie grupy / podkategorie')}<select name="type" aria-label="Rodzaj dzianiny"><option value="">Wszystkie rodzaje</option>${types.map(t=>`<option ${type===t.name?'selected':''}>${e(t.name)}</option>`).join('')}</select><select name="sort" aria-label="Sortowanie">${Object.entries({newest:'Najnowsze',oldest:'Najstarsze',updated:'Ostatnio aktualizowane',symbol:'Symbol A–Z'}).map(([k,v])=>`<option value="${k}" ${sort===k?'selected':''}>${v}</option>`).join('')}</select><button>Filtruj</button></form><div class="panel scroll"><table class="listing"><thead><tr><th>Symbol</th><th>Kategoria</th><th>Utworzono</th><th>Aktualizacja</th><th>Technologia</th></tr></thead><tbody>${rows.map(a=>`<tr><td><a class="item-title" href="/articles/${a.id}">${e(a.symbol)}</a></td><td>${e(a.category||'—')}</td><td>${date(a.created_at)}</td><td>${date(a.updated)}</td><td>${a.active_spec?'Zatwierdzona':'Do opracowania'}</td></tr>`).join('')||'<tr><td colspan="5">Brak artykułów.</td></tr>'}</tbody></table></div><div class="pagination">${n>1?`<a href="${e(pageUrl(n-1))}">← Poprzednia</a>`:''}Strona ${n}${n*50<total?`<a href="${e(pageUrl(n+1))}">Następna →</a>`:''}</div>${create}`);return true;
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
        db.prepare('UPDATE articles SET category_id=?,description=?,updated_at=? WHERE id=?').run(checkedCategory(db,form.category_id,fail),String(form.description||'').slice(0,6000),new Date().toISOString(),id);
        audit(req.user,'Zmieniono opis/kategorię artykułu',null,`Artykuł ${id}`);
      } else if(action==='link') {
        const pr=db.prepare('SELECT id FROM projects WHERE name=? COLLATE NOCASE').get(String(form.project_name||'').trim()); if(!pr)fail(400,'Nie znaleziono projektu o tej nazwie.'); const pid=pr.id; db.prepare('INSERT OR IGNORE INTO project_articles VALUES(?,?)').run(pid,id); audit(req.user,'Powiązano artykuł z projektem',null,`${id} / ${pid}`);
      } else if(action==='new') {
        const v=blank();v.symbol=a.symbol;v.date=ctx.todayWarsaw();
        const rid=db.prepare("INSERT INTO records(article_id,kind,symbol,payload,created_at,updated_at,expected_active) VALUES(?,'spec',?,?,?,?,?)").run(id,a.symbol,JSON.stringify(v),now(),now(),a.active_spec).lastInsertRowid;
        audit(req.user,'Utworzono specyfikację artykułu',rid);return Number(rid);
      } else fail(404,'Nie znaleziono operacji.');
    });redirect(req,res,result?`/records/${result}/edit`:`/articles/${id}`);return true;
  }
  if(req.method!=='GET'||action) return false;
  const articleUpdated=db.prepare('SELECT max(a.updated_at,coalesce((SELECT max(updated_at) FROM records WHERE article_id=a.id),a.updated_at)) updated FROM articles a WHERE a.id=?').get(id).updated;
  const projects=db.prepare('SELECT p.* FROM projects p JOIN project_articles pa ON pa.project_id=p.id WHERE pa.article_id=? ORDER BY p.id DESC').all(id);
  const historyPage=Math.max(1,parseInt(url.searchParams.get('history_page'))||1);
  const recordCount=db.prepare('SELECT count(*) n FROM records WHERE article_id=?').get(id).n;
  const records=db.prepare('SELECT id,kind,symbol,state,version,updated_at FROM records WHERE article_id=? ORDER BY id DESC LIMIT 50 OFFSET ?').all(id,(historyPage-1)*50);
  const cards=db.prepare('SELECT c.id,c.machine,c.created_at FROM cards c JOIN records r ON r.id=c.record_id WHERE r.article_id=? ORDER BY c.id DESC LIMIT 50').all(id);
  const editor=writable(req.user)?`<details class="panel padded"><summary>Edytuj opis i kategorię</summary><form method="post" action="/articles/${id}/metadata">${csrf}<input type="hidden" name="updated_at" value="${e(a.updated_at)}">${categoryInput(db,a.category_id)}<label>Opis<textarea name="description" maxlength="6000">${e(a.description)}</textarea></label><button>Zapisz</button></form></details><form method="post" action="/articles/${id}/new">${csrf}<button>+ Nowa specyfikacja</button></form>`:'';
  const links=writable(req.user)?`<form method="post" action="/articles/${id}/link" class="panel padded">${csrf}<label>Powiąż z projektem — dokładna nazwa<input name="project_name" maxlength="150" required></label><button>Powiąż</button></form>`:'';
  page(`<a href="/articles">← Artykuły</a><h1>${e(a.symbol)}</h1><p class="preline">${e(a.description)}</p><p>Kategoria: ${e(categories(db).find(c=>c.id===a.category_id)?.label || '—')}</p><p>Utworzono: ${date(a.created_at)} · Aktualizacja: ${date(articleUpdated)}</p>${a.active_spec?`<a class="button primary" href="/records/${a.active_spec}">Obowiązująca technologia</a>`:''}${editor}<h2>Technologie i powiązane próby</h2><div class="grid">${records.map(r=>`<a class="record-tile" href="/records/${r.id}">${e(r.symbol)} · ${r.kind==='trial'?'Próba':'Specyfikacja'}<p>${e(V.STATE[r.state])}${r.version?' · v'+r.version:''}</p>${date(r.updated_at)}</a>`).join('')||'<p>Brak wpisów.</p>'}</div><div class="pagination">${historyPage>1?`<a href="?history_page=${historyPage-1}">← Poprzednie wpisy</a>`:''}${historyPage*50<recordCount?`<a href="?history_page=${historyPage+1}">Kolejne wpisy →</a>`:''}</div><h2>Ostatnie wydane karty (do 50)</h2>${cards.map(c=>`<p><a href="/cards/${c.id}">Karta #${c.id} · ${e(c.machine)} · ${date(c.created_at)}</a></p>`).join('')||'<p>Brak wydanych kart.</p>'}<h2>Projekty</h2>${projects.map(pr=>`<p><a href="/projects/${pr.id}">#${pr.id} · ${e(pr.name)}</a></p>`).join('')||'<p>Artykuł nie jest powiązany z projektem.</p>'}${links}${ctx.photos.panel('article',id,req)}`);return true;
}
module.exports={handle,categories,categoryInput,projectArticleInput,associate};
