'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LOGO_CACHE_VERSION = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'static', 'logo.jpg'))).digest('hex').slice(0, 16);

const TECH = [
  ['machine_type', 'Typ maszyny'], ['gauge', 'Podział maszyny'], ['density', 'Ścisłość dziania (ocz/cm)'],
  ['working_width', 'Szerokość robocza (cale)'], ['panels', 'Liczba szali'],
  ['speed', 'Prędkość (obr./min)'], ['roll_length', 'Domyślna długość belki (m)'], ['distance', 'Ustawienie dystansu'],
];
const RAW_METRICS = [
  ['weight', 'Gramatura (g/m²)'], ['width', 'Szerokość luźna (cm)'], ['roll_width', 'Szerokość na tulei (cm)'],
  ['pk', 'Pk (ocz/cm)'], ['pr', 'Pr (ocz/cm)'], ['thickness', 'Grubość / dystans (mm)'],
];
const TARGET_METRICS = [
  ['weight', 'Gramatura (g/m²)'], ['width', 'Szerokość (cm)'],
  ['pk', 'Pk (ocz/cm)'], ['pr', 'Pr (ocz/cm)'], ['thickness', 'Grubość / dystans (mm)'],
  ['sample_batch', 'Wzorcowa partia z wykańczalni'],
];
const GB = [
  ['number', 'GB'], ['yarn', 'Rodzaj przędzy'], ['pattern', 'Raport ogniw wzorujących'], ['threads', 'Liczba nici'],
  ['run_in', 'Wrobienie (mm/rack)'], ['threading', 'Nawleczenie'],
];
const FINISH = [
  ['name', 'Nazwa'], ['weight', 'Gramatura (g/m²)'], ['width', 'Szerokość (cm)'], ['pk', 'Pk'], ['pr', 'Pr'],
  ['thickness', 'Dystans / grubość (mm)'], ['finish', 'Wykończenie / usztywnienie'], ['comments', 'Komentarz'],
];
const ROLE = { admin: 'Administrator', approver: 'Zatwierdzanie', technologist: 'Technolog', viewer: 'Podgląd' };
const STATE = { draft: 'Robocza', submitted: 'Do zatwierdzenia', approved: 'Zatwierdzona' };
const PROJECT_STATUS = { in_progress: 'W fazie projektowej', to_knitter: 'Zlecono na dziewiarnię', produced: 'Wyprodukowano dzianinę', in_finishing: 'W wykańczalni', sample_at_client: 'Próbka u klienta', accepted: 'Zaakceptowana', failed: 'Nieudana', client_declined: 'Klient nie podjął współpracy' };
const PROJECT_STATUS_CLASS = { in_progress: 'status-progress', to_knitter: 'status-knitter', produced: 'status-produced', in_finishing: 'status-finishing', sample_at_client: 'status-sample', accepted: 'status-accepted', failed: 'status-failed', client_declined: 'status-client-declined' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const INSTRUCTION_FORMAT = 'marand-instructions-v1';
const INSTRUCTION_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
function instructionRuns(value = '') {
  let parsed;
  try { parsed = JSON.parse(String(value)); } catch {}
  if (parsed?.format !== INSTRUCTION_FORMAT || !Array.isArray(parsed.runs)) return [{ text: String(value || ''), bold: false, size: 16 }];
  return parsed.runs.map(run => ({
    text: String(run?.text || ''),
    bold: Boolean(run?.bold),
    size: INSTRUCTION_SIZES.includes(Number(run?.size)) ? Number(run.size) : 16,
  }));
}
function instructionsText(value = '') { return instructionRuns(value).map(run => run.text).join(''); }
function instructionEditorHtml(value = '') {
  return instructionRuns(value).filter(run => run.text).map(run => `<span data-instruction-size="${run.size}" style="font-size:${run.size}px">${run.bold ? '<strong>' : ''}${esc(run.text).replace(/\n/g, '<br>')}${run.bold ? '</strong>' : ''}</span>`).join('');
}
function instructionCardHtml(value = '') {
  return instructionRuns(value).filter(run => run.text).map(run => `<span style="font-size:${run.size}px">${run.bold ? '<strong>' : ''}${esc(run.text).replace(/\n/g, '<br>')}${run.bold ? '</strong>' : ''}</span>`).join('');
}
function datepl(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return esc(value);
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
function todayInput() {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function field(label, name, value = '', options = {}) {
  const attrs = Object.entries(options).filter(([k]) => !['multiline', 'className', 'type'].includes(k)).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const control = options.multiline
    ? `<textarea name="${esc(name)}" ${attrs}>${esc(value)}</textarea>`
    : `<input type="${esc(options.type || 'text')}" name="${esc(name)}" value="${esc(value)}" ${attrs}>`;
  return `<label${options.className ? ` class="${esc(options.className)}"` : ''}>${esc(label)}${control}</label>`;
}
function hidden(name, value) { return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`; }
function button(text, classes = '') { return `<button${classes ? ` class="${esc(classes)}"` : ''}>${esc(text)}</button>`; }
function link(href, text, classes = '') { return `<a class="${esc(classes || 'button')}" href="${esc(href)}">${text}</a>`; }
function csrfForm(csrf, action, content, classes = '', target = '') {
  const targetAttr = target === '_blank' ? ' target="_blank" rel="noopener"' : '';
  return `<form method="post" action="${esc(action)}"${classes ? ` class="${esc(classes)}"` : ''}${targetAttr}>${hidden('csrf', csrf)}${content}</form>`;
}
function layout({ title = 'Marand · Technologia', user, csrf, body, flashes = [] }) {
  const notices = flashes.map(f => `<div class="notice ${esc(f.category || 'success')}" role="status">${esc(f.message)}</div>`).join('');
  const userBox = user ? `<div class="user">${esc(user.name)} <small>${esc(ROLE[user.role] || user.role)}</small>${csrfForm(csrf, '/logout', '<button class="link">Wyloguj</button>')}</div>` : '';
  const adminNav = user && user.role === 'admin' ? '<a class="nav-link" href="/admin/import">Import danych</a><a class="nav-link" href="/admin/update">Aktualizacje GitHub</a><a class="nav-link" href="/production/connection">Połączenie z panelem lokalnym</a>' : '';
  const navigation = require('./modules/navigation').filter(item=>!item.roles||item.roles.includes(user?.role)).map(item => item.children
    ? `<details class="nav-group"><summary>${esc(item.label)}</summary><div class="nav-children">${item.children.map(child => `<a class="nav-link nav-sublink" href="${child.href}">${esc(child.label)}</a>`).join('')}</div></details>`
    : `<a class="nav-link" href="${item.href}">${esc(item.label)}</a>`).join('');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/static/app.css"><script defer src="/static/app.js"></script></head><body>
<aside class="sidebar"><a class="brand" href="/"><img src="/static/logo.jpg?v=${LOGO_CACHE_VERSION}" alt="Marand Technical textiles"></a><div class="brand-caption">TECHNOLOGIA I ROZWÓJ</div><nav>${navigation}<div class="nav-hint">Próby · Specyfikacje · Karty na maszyny</div>${adminNav}</nav><div class="sidebar-bottom">Wersja ${esc(process.env.MARAND_VERSION || '0.3.0')}<br><small>Dokumentacja technologiczna</small></div></aside>
<div class="workspace"><header class="topbar"><span>Marand / Dokumentacja technologiczna</span>${userBox}</header><main>${notices}${body}</main></div></body></html>`;
}
function errorPage({ error, status = 400, ...base }) {
  return layout({ ...base, title: 'Operacja nie została wykonana', body: `<h1>Operacja nie została wykonana</h1><div class="notice warning">${esc(error)}</div><p>Jeżeli formularz zawiera Twoje zmiany, użyj przycisku „Wstecz” w przeglądarce i skopiuj je przed odświeżeniem.</p><a class="button" href="/">Wróć do kartoteki</a>` });
}
function loginPage(args) {
  return layout({ ...args, title: 'Logowanie · Marand', body: `<div class="login"><span class="eyebrow">WSPÓLNA DOKUMENTACJA MARAND</span><h1>Wszystko o artykule.<br>W jednym miejscu.</h1><p class="muted">Zaloguj się, aby otworzyć próby, warunki dziania i karty na maszyny.</p>${csrfForm(args.csrf, '/login', `${field('Login', 'login', '', { required: 'required', autocomplete: 'username', autofocus: 'autofocus' })}${field('Hasło', 'password', '', { type: 'password', required: 'required', autocomplete: 'current-password' })}${button('Zaloguj się', 'primary')}`)}</div>` });
}
function homePage({ user, csrf, flashes, projects, total, page, q, state = '', status = '', sort = 'updated', dateFrom = '', dateTo = '', backupState }) {
  const canCreate = ['technologist', 'approver', 'admin'].includes(user.role);
  let backup = '';
  if (user.role === 'admin') {
    const ok = backupState && backupState.ok && !backupState.stale;
    const detail = backupState && backupState.last_success
      ? `<strong>Ostatnia udana kopia:</strong> ${datepl(backupState.last_success)}${!ok ? ' — sprawdź harmonogram kopii z informatykiem.' : ''}`
      : '<strong>Kopie zapasowe:</strong> brak potwierdzonej kopii. Informatyk powinien uruchomić harmonogram przed rozpoczęciem pracy.';
    backup = `<div class="notice ${ok ? 'success' : 'warning'}">${detail}</div>`;
  }
  const selectedStatus = status || (state === 'approved' ? 'accepted' : state === 'pending' ? 'in_progress' : '');
  const emptyMessage = q || selectedStatus || dateFrom || dateTo ? 'Brak wyników wyszukiwania.' : (['technologist', 'approver', 'admin'].includes(user.role) ? 'Brak projektów / prób. Dodaj pierwsze przyciskiem u góry.' : 'Nie ma jeszcze projektów / prób. Poproś technologa o dodanie pierwszych.');
  const rows = projects.length ? projects.map(p => {
    const currentStatus=p.workflow_status||p.status||'in_progress';
    return `<tr><td><a class="item-title" href="/projects/${p.id}">${esc(p.trial_number || `#${p.id}`)} · ${esc(p.short_description || p.name)}</a><div class="muted small">${esc(p.client_name||'')}${p.client_name&&p.goal?' · ':''}${esc(p.goal || p.description || '')}</div>${p.conflict ? '<span class="flag">Rozbieżności w źródłach</span>' : ''}</td><td>${p.article_count}</td><td>${p.total}</td><td><span class="status-pill ${PROJECT_STATUS_CLASS[currentStatus]||PROJECT_STATUS_CLASS.in_progress}">${esc(PROJECT_STATUS[currentStatus] || PROJECT_STATUS.in_progress)}</span></td><td>${datepl(p.updated || p.created_at)}</td><td class="row-actions"><a class="button" href="/projects/${p.id}">Otwórz →</a>${canCreate ? `<a class="delete-x" href="/projects/${p.id}/delete" aria-label="Archiwizuj projekt/próbę ${esc(p.trial_number || p.id)}" title="Archiwizuj">×</a>` : ''}</td></tr>`;
  }).join('') : `<tr><td colspan="6">${emptyMessage}</td></tr>`;
  const search = `<form class="searchbar trial-searchbar" data-live-search><input name="q" value="${esc(q)}" placeholder="Szukaj numeru, opisu, klienta lub artykułu…" aria-label="Szukaj"><select name="status" aria-label="Status próby"><option value="">Wszystkie statusy</option>${Object.entries(PROJECT_STATUS).map(([k,v])=>`<option value="${k}" ${selectedStatus===k?'selected':''}>${v}</option>`).join('')}</select><select name="sort" aria-label="Sortowanie"><option value="updated" ${sort==='updated'?'selected':''}>Ostatnia zmiana</option><option value="created_desc" ${sort==='created_desc'?'selected':''}>Najnowsze próby</option><option value="created_asc" ${sort==='created_asc'?'selected':''}>Najstarsze próby</option><option value="status" ${sort==='status'?'selected':''}>Status próby</option><option value="number" ${sort==='number'?'selected':''}>Numer próby</option><option value="name" ${sort==='name'?'selected':''}>Opis A–Z</option></select><label class="date-filter">Od<input type="date" name="date_from" value="${esc(dateFrom)}"></label><label class="date-filter">Do<input type="date" name="date_to" value="${esc(dateTo)}"></label></form>`;
  const pageUrl = n => { const sp=new URLSearchParams({q,status:selectedStatus,sort,date_from:dateFrom,date_to:dateTo,page:String(n)}); return `/projects?${sp}`; };
  const pages = `<div class="pagination">${page > 1 ? `<a href="${pageUrl(page - 1)}">← Poprzednia</a>` : ''}<span>Strona ${page}</span>${page * 15 < total ? `<a href="${pageUrl(page + 1)}">Następna →</a>` : ''}</div>`;
  const createButton = canCreate ? '<button type="button" class="primary" data-open-dialog="new-project">+ Dodaj projekt / próbę</button>' : '';
  const createDialog = canCreate ? `<dialog class="form-dialog" id="new-project"><form method="dialog" class="dialog-head"><strong>Dodaj próbę</strong><button type="submit" aria-label="Zamknij">×</button></form><form method="post" action="/projects" class="dialog-body">${hidden('csrf', csrf)}<p class="muted small">Numer próby zostanie nadany automatycznie, np. 1/2026.</p><label>Skrócony opis próby<input name="name" required maxlength="150" autofocus></label><label>Nazwa klienta<input name="client_name" maxlength="200"></label><label>Założenia Projektowe<textarea name="goal" maxlength="6000"></textarea></label><label>Komentarz<textarea name="comment" maxlength="3000"></textarea></label><p class="muted small">Artykuły dodasz w konkretnym etapie próby.</p><div class="actions"><button type="button" data-close-dialog>Anuluj</button><button class="primary">Utwórz próbę</button></div></form></dialog>` : '';
  return layout({ user, csrf, flashes, title: 'Projekty / próby · Marand', body: `<div class="pagehead"><div><span class="eyebrow">PROJEKTY I PRÓBY</span><h1>Projekty / próby</h1><p class="muted">Jedna numerowana karta prowadzi przez kolejne etapy projektu.</p></div><div class="page-actions"><span class="count"><span data-live-count>${total}</span> prób</span>${createButton}</div></div>${createDialog}${backup}${search}<div data-live-results aria-live="polite"><div class="panel"><table class="listing"><thead><tr><th>Numer i opis próby</th><th>Artykuły</th><th>Etapy</th><th>Status</th><th>Ostatnia zmiana</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${pages}</div>` });
}
function projectPage({ user, csrf, flashes, p, cards = [], stages = [], linkedArticles = [], comments = [], photoPanel = '', articleInput = '', selectedStageId = 0, aiNotice = '' }) {
  const canEdit = !p.archived_at && ['technologist', 'approver', 'admin'].includes(user.role);
  aiNotice = aiNotice || p.ai_generated_notice || '';
  if (aiNotice) flashes = [...flashes, { category: 'warning', message: aiNotice }];
  const currentStatus=p.workflow_status||p.status||'in_progress';
  const projectStatus=PROJECT_STATUS[currentStatus]||PROJECT_STATUS.in_progress;
  const statusControls=canEdit?`<form method="post" action="/projects/${p.id}/status" class="status-buttons">${hidden('csrf',csrf)}${Object.entries(PROJECT_STATUS).map(([key,label])=>`<button name="status" value="${key}" class="status-choice ${PROJECT_STATUS_CLASS[key]}${currentStatus===key?' selected':''}" aria-pressed="${currentStatus===key?'true':'false'}">${esc(label)}</button>`).join('')}</form>`:`<span class="status-pill ${PROJECT_STATUS_CLASS[currentStatus]||PROJECT_STATUS_CLASS.in_progress}">${esc(projectStatus)}</span>`;
  const latestStageId=stages.at(-1)?.id;
  const openStageId=stages.some(stage=>stage.id===Number(selectedStageId))?Number(selectedStageId):latestStageId;
  const stageNavigation=stages.length?`<nav class="stage-quick-nav" aria-label="Przejdź do etapu">${stages.map(stage=>`<button type="button" class="stage-quick-button${stage.id===openStageId?' selected':''}" data-stage-select="${stage.id}" aria-controls="trial-stage-${stage.id}" aria-pressed="${stage.id===openStageId?'true':'false'}">Etap ${stage.stage_no}</button>`).join('')}</nav>`:'';
  const commentEntries=(items,deleteBase)=>items.map(c=>`<article class="project-comment" data-comment-entry="${c.id}"><div class="project-comment-meta"><strong data-comment-author>${esc(c.author_name||'Nieznany autor')}</strong><time data-comment-time>${datepl(c.created_at)}</time>${canEdit?`<a class="delete-x project-comment-delete" href="${deleteBase}${c.id}/delete" aria-label="Usuń komentarz: ${esc(c.content.slice(0,80))}" title="Usuń komentarz">×</a>`:''}</div><p class="preline" data-comment-content>${esc(c.content)}</p></article>`).join('');
  const archiveArticleAction=article=>canEdit&&!article.archived_at&&!article.purged_at?`<a class="delete-x" href="/articles/${article.article_id||article.id}/delete?return_to=${encodeURIComponent(`/projects/${p.id}`)}" aria-label="Przenieś artykuł ${esc(article.symbol)} do archiwum na 30 dni" title="Archiwizuj artykuł na 30 dni">×</a>`:'';
  const unlinkArticleAction=article=>canEdit?`<a class="unlink-article-action" href="/projects/${p.id}/articles/${article.article_id||article.id}/unlink" aria-label="Odepnij ${esc(article.symbol)} od próby/projektu" title="Odepnij od próby/projektu"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.72a5 5 0 0 0-7.07-7.07l-1.72 1.72"/><path d="m5.17 11.75-1.72 1.72a5 5 0 0 0 7.07 7.07l1.72-1.72"/></svg></a>`:'';
  const stageSummary = stages.length ? stages.map(stage => {
    const stageArticles=stage.articles||[];
    const stageDateText=/^\d{4}-\d{2}-\d{2}$/.test(stage.stage_date||'')?stage.stage_date.split('-').reverse().join('.'):datepl(stage.stage_date);
    const articleParameters=stageArticles.length?stageArticles.map(article=>{
      let v={};try{v=article.payload?JSON.parse(article.payload):{}}catch{}
      const metrics=`<div class="stage-metrics"><div><strong>Dzianina surowa</strong><span>Gramatura: ${esc(v.raw?.weight||'—')} g/m²</span><span>Szerokość: ${esc(v.raw?.width||'—')} cm</span></div><div><strong>Dzianina wykończona</strong><span>Gramatura: ${esc(v.targets?.weight||'—')} g/m²</span><span>Szerokość: ${esc(v.targets?.width||'—')} cm</span></div></div>`;
      const articleIsActive=!article.archived_at&&!article.purged_at;
      const fill=canEdit&&articleIsActive&&article.record_id&&!article.record_archived_at?`<a class="button parameter-link" href="/records/${article.record_id}/edit" target="_blank" rel="noopener"><span aria-hidden="true">✎</span> Uzupełnij ↗</a>`:'';
      const issue=canEdit&&articleIsActive&&article.active_spec?`<a class="button" href="/records/${article.active_spec}/issue?project=${p.id}&amp;stage=${stage.id}" target="_blank" rel="noopener">Wydaj kartę ↗</a>`:'';
      return `<article class="stage-article"><div class="stage-article-head"><a class="stage-article-symbol" href="/articles/${article.article_id}">${esc(article.symbol)}</a><div class="actions">${fill}${issue}${unlinkArticleAction(article)}${archiveArticleAction(article)}</div></div>${metrics}</article>`;
    }).join(''):'<p class="muted">Do tego etapu nie dodano jeszcze artykułów.</p>';
    const stageAutosave=(name,label,value,{multiline=false,maxlength=300}={})=>canEdit?`<form class="autosave-field stage-autosave-field" action="/projects/${p.id}/stages/${stage.id}/autosave" data-autosave>${hidden('csrf',csrf)}<input type="hidden" name="field" value="${name}"><label>${label}${multiline?`<textarea name="value" maxlength="${maxlength}" data-autosave-value>${esc(value)}</textarea>`:`<input name="value" maxlength="${maxlength}" value="${esc(value)}" data-autosave-value data-stage-description-input="${stage.id}">`}</label><span class="autosave-status muted small" data-autosave-status aria-live="polite"></span></form>`:`<p class="preline">${esc(value||'—')}</p>`;
    const addArticle=canEdit?`<button type="button" data-open-dialog="stage-article-${stage.id}">+ Dodaj artykuł</button>`:'';
    const articleDialog=canEdit?`<dialog class="form-dialog" id="stage-article-${stage.id}"><form method="dialog" class="dialog-head"><strong>Dodaj artykuł do etapu ${stage.stage_no}</strong><button type="submit" aria-label="Zamknij">×</button></form><form method="post" action="/projects/${p.id}/stages/${stage.id}/articles" class="dialog-body">${hidden('csrf',csrf)}${articleInput}<div class="actions"><button type="button" data-close-dialog>Anuluj</button><button class="primary">Dodaj do etapu</button></div></form></dialog>`:'';
    const deleteStage=canEdit?`<a class="stage-delete-link" data-stage-delete-link href="/projects/${p.id}/stages/${stage.id}/delete" aria-label="Usuń etap ${stage.stage_no}"><span>Usuń etap</span><b aria-hidden="true">×</b></a>`:'';
    const stageCommentBase=`/projects/${p.id}/stages/${stage.id}/comments/`;
    const stageCommentForm=canEdit?`<form class="comment-composer" action="/projects/${p.id}/stages/${stage.id}/comments" data-comment-composer data-comment-delete-base="${stageCommentBase}">${hidden('csrf',csrf)}<label>Dodaj komentarz<textarea name="content" maxlength="3000" data-comment-input placeholder="Dopisz komentarz do etapu…"></textarea></label><span class="autosave-status muted small" data-comment-status aria-live="polite">Komentarz zapisze się automatycznie.</span></form>`:'';
    const stageCommentJournal=`<section class="comment-journal stage-comment-journal" data-comment-journal><h4>Komentarze etapu</h4><div class="project-comment-list" data-comment-list>${commentEntries(stage.comments||[],stageCommentBase)||'<p class="muted" data-comment-empty>Nie dodano jeszcze komentarzy.</p>'}</div>${stageCommentForm}</section>`;
    return `<details class="stage-card" id="trial-stage-${stage.id}" name="trial-stage" ${stage.id===openStageId?'open':''}><summary class="stage-toggle"><div><span class="stage-number">ETAP ${stage.stage_no}</span><h3 data-stage-description-label="${stage.id}">${esc(stage.description||'Etap bez opisu')}</h3></div><div class="stage-toggle-right">${deleteStage}</div></summary><div class="stage-body"><div class="stage-top-actions">${addArticle}</div>${stageAutosave('description','Opis etapu',stage.description||'',{maxlength:300})}<p class="muted">Data zapisu: ${stageDateText}</p>${stageCommentJournal}<section class="stage-parameters"><h4>Parametry dzianiny</h4>${articleParameters}</section></div>${articleDialog}</details>`;
  }).join('') : '<p class="muted">Nie dodano jeszcze etapów.</p>';
  const cardRows = cards.length ? cards.map(c => `<tr><td><a href="/cards/${c.id}" target="_blank" rel="noopener">Karta #${c.id} ↗</a></td><td>${esc(c.machine)}</td><td class="preline">${esc(instructionsText(c.instructions))}${c.production_notes?`\nSpecjalne informacje: ${esc(c.production_notes)}`:''}</td><td>${datepl(c.created_at)}<br><small>${esc(c.author)}</small></td></tr>`).join('') : '<tr><td colspan="4">Po zatwierdzeniu specyfikacji można wydać pierwszą kartę na konkretną maszynę.</td></tr>';
  const linkedArticleRows = linkedArticles.map(a => `<div class="linked-article-row">${link(`/articles/${a.id}`,esc(a.symbol))}${a.purged_at?'<span class="badge archived">Usunięty z kartoteki</span>':a.archived_at?'<span class="badge archived">W archiwum</span>':''}${a.active_spec?`<span class="muted small"> · aktualna specyfikacja <a href="/records/${a.active_spec}">otwórz</a></span>`:''}${unlinkArticleAction(a)}${archiveArticleAction(a)}</div>`).join(' ') || '<p>Nie dodano jeszcze artykułów.</p>';
  const archivedNotice = p.archived_at ? `<div class="notice warning"><strong>Projekt/próba jest w archiwum.</strong> Powiązane artykuły, próby, zdjęcia i wydane karty pozostają zachowane. ${Date.now() - Date.parse(p.archived_at) < 30 * 86400000 ? 'Można przywrócić go przez 30 dni w zakładce Archiwum.' : 'Minęło 30 dni; wpis jest ukryty z listy projektów, a ten odnośnik historyczny nadal działa.'}</div>` : '';
  const archiveButton = canEdit ? `<a class="button danger" href="/projects/${p.id}/delete">Przenieś do archiwum…</a>` : '';
  const addStage=canEdit?`<form method="post" action="/projects/${p.id}/stages" class="panel padded stage-create">${hidden('csrf',csrf)}<h3>Dodaj etap ${stages.length+1}</h3><label>Co robimy w tym etapie<input name="description" maxlength="300" placeholder="Np. zmiana składu przędzy"></label><p class="muted small">Data ustawi się automatycznie przy zapisie. Artykuły dodasz później w etapie.</p><button class="primary">Dodaj etap</button></form>`:'';
  const projectEditor=canEdit?`<button type="button" class="button small trial-edit-button" data-open-dialog="edit-trial-${p.id}">Edytuj</button><dialog class="form-dialog" id="edit-trial-${p.id}"><form method="dialog" class="dialog-head"><strong>Edytuj nazwę próby i klienta</strong><button type="submit" aria-label="Zamknij">×</button></form><form method="post" action="/projects/${p.id}/update" class="dialog-body trial-form">${hidden('csrf',csrf)}<label>Skrócony opis<input name="short_description" maxlength="150" value="${esc(p.short_description||p.name)}" required></label><label>Nazwa klienta<input name="client_name" maxlength="200" value="${esc(p.client_name||'')}"></label><div class="actions"><button type="button" data-close-dialog>Anuluj</button><button class="primary">Zapisz</button></div></form></dialog>`:'';
  const autosaveField=(name,label,value)=>canEdit?`<form class="autosave-field" action="/projects/${p.id}/autosave" data-autosave>${hidden('csrf',csrf)}<input type="hidden" name="field" value="${name}"><label>${label}<textarea name="value" maxlength="6000" data-autosave-value>${esc(value)}</textarea></label><span class="autosave-status muted small" data-autosave-status aria-live="polite"></span></form>`:`<p class="preline">${esc(value||'—')}</p>`;
  const commentRows=commentEntries(comments,`/projects/${p.id}/comments/`);
  const commentForm=canEdit?`<form class="comment-composer" action="/projects/${p.id}/comments" data-comment-composer data-comment-delete-base="/projects/${p.id}/comments/">${hidden('csrf',csrf)}<label>Dodaj komentarz<textarea name="content" maxlength="3000" data-comment-input placeholder="Np. dzianina wyszła za gruba, zmieniamy oczka…"></textarea></label><span class="autosave-status muted small" data-comment-status aria-live="polite">Komentarz zapisze się automatycznie.</span></form>`:'';
  const commentJournal=`<section class="panel padded comment-journal" data-comment-journal><h3>Komentarze</h3><div class="project-comment-list" data-comment-list>${commentRows||'<p class="muted" data-comment-empty>Nie dodano jeszcze komentarzy.</p>'}</div>${commentForm}</section>`;
  const rawBasis=String(p.goal||p.description||'').trim(), legacyAssumptions=String(p.assumptions||'').trim();
  const projectBasis=rawBasis&&legacyAssumptions?`Cel próby:\n${rawBasis}\n\nZałożenia i pomysły:\n${legacyAssumptions}`:rawBasis||legacyAssumptions;
  return layout({ user, csrf, flashes, title: `${p.trial_number||`#${p.id}`} · ${p.short_description||p.name} · Marand`, body: `<a class="breadcrumb" href="/projects">← Projekty / próby</a>${archivedNotice}<div class="pagehead trial-pagehead"><div><span class="eyebrow trial-number">PRÓBA ${esc(p.trial_number||`#${p.id}`)}</span><div class="trial-title-line"><h1>${esc(p.short_description||p.name)}${p.client_name?` <span class="trial-client-divider">/</span> <span class="trial-client-title">${esc(p.client_name)}</span>`:''}</h1>${projectEditor}</div><p class="muted">Status: ${esc(projectStatus)}</p>${statusControls}${stageNavigation}</div><div class="page-actions">${archiveButton}</div></div><section class="panel padded trial-purpose"><h2>Założenia Projektowe</h2>${autosaveField('goal','Założenia Projektowe',projectBasis)}</section>${commentJournal}${photoPanel}<section class="trial-stages"><div class="sectionhead"><h2>Etapy próby</h2><span class="muted">${stages.length} etapów</span></div>${stageSummary}${addStage}</section>${cards.length?`<section class="sectionhead"><h2>Wydane karty na maszyny</h2><span class="muted">${cards.length} kart</span></section><div class="panel"><table class="listing"><thead><tr><th>Karta</th><th>Maszyna</th><th>Polecenia / uwagi</th><th>Wydanie</th></tr></thead><tbody>${cardRows}</tbody></table></div>`:''}<section class="panel padded project-articles"><div class="sectionhead"><h2>Artykuły w projekcie</h2></div>${linkedArticleRows}</section>` });
}
function metricInputs(v, group, metrics) {
  return metrics.map(([k, label]) => field(label, `${group}_${k}`, (v[group] || {})[k] || '', { className: 'compact-value', maxlength: 10 })).join('');
}
function threadingPosition(index, full) {
  const state = full ? 'full' : 'empty';
  const label = full ? 'pełna' : 'pusta';
  return `<span class="threading-position"><button type="button" class="threading-cell ${state}" data-threading-cell data-threading-state="${state}" aria-pressed="${full}" aria-label="Pozycja ${index + 1} — nitka ${label}" title="Kliknij, aby zmienić na nitkę ${full ? 'pustą' : 'pełną'}">${full ? '|' : '○'}</button><button type="button" class="threading-remove-cell" data-remove-threading-cell aria-label="Usuń pozycję ${index + 1}" title="Usuń pozycję">×</button></span>`;
}
function threadingEditor(index, value) {
  const raw = value ? String(value) : '|';
  const canonical = /^[|.]*$/.test(raw);
  const sequence = canonical ? raw : '';
  const positions = [...sequence].map((token, position) => threadingPosition(position, token === '|')).join('');
  const legacy = !canonical && raw
    ? `<small class="threading-legacy" data-threading-legacy>Poprzedni zapis: „${esc(raw)}”. Dodaj pozycje, aby zastąpić go nowym formatem.</small>`
    : '<small class="threading-legacy" data-threading-legacy hidden></small>';
  return `<div class="threading-field" data-threading-editor><span class="threading-field-label">Nawleczenie</span><input type="hidden" name="gb_${index}_threading" value="${esc(raw)}" data-threading-value><div class="threading-line"><div class="threading-sequence" data-threading-positions aria-label="Pozycje nawleczenia">${positions}</div><button type="button" class="threading-add" data-add-threading-cell aria-label="Dodaj pozycję nawleczenia" title="Dodaj pozycję">+</button><code data-threading-display>${canonical ? esc(sequence) : ''}</code></div>${legacy}</div>`;
}
function editPage({ user, csrf, flashes, r, v, newArticleFields = false }) {
  const tech = TECH.map(([k, label]) => field(label, `tech_${k}`, (v.tech || {})[k] || '')).join('');
  const gbCount = Math.max(2, v.gb.length);
  const gbRows = Array.from({ length: gbCount }, (_, i) => {
    const row = v.gb[i] || {};
    const number = row.number || String(Math.max(0,...v.gb.map(g=>Number(g.number))) + i - v.gb.length + 1);
    const values = GB.filter(([k]) => k !== 'number' && k !== 'threading').map(([k,label])=>field(label,`gb_${i}_${k}`,row[k]||'')).join('') + threadingEditor(i, row.threading || '');
    return `<section class="gb-row" data-gb-index="${i}" data-gb-number="${esc(number)}"><div class="gb-fields-scroll"><div class="gb-fields"><h3>GB${esc(number)}</h3>${hidden(`gb_${i}_number`,number)}${values}<button type="button" class="gb-delete-x" data-remove-gb aria-label="Usuń GB ${esc(number)}" title="Usuń GB ${esc(number)}">×</button></div></div></section>`;
  }).join('');
  const targetGrid = `<strong>Parametr</strong><strong>Wartość</strong>${TARGET_METRICS.map(([k, label]) => `<label for="target_${k}">${esc(label)}</label><input id="target_${k}" name="targets_${k}" value="${esc((v.targets || {})[k] || '')}"${k === 'sample_batch' ? ' maxlength="150"' : ' maxlength="10"'}>`).join('')}`;
  const rawGrid = `<strong>Parametr</strong><strong>Wartość</strong>${RAW_METRICS.map(([k, label]) => `<label for="raw_${k}">${esc(label)}</label><input id="raw_${k}" name="raw_${k}" value="${esc((v.raw || {})[k] || '')}" maxlength="10">`).join('')}`;
  const finishRows = Array.from({ length: 3 }, (_, i) => {
    const f = v.finished[i] || {};
    const fields = FINISH.map(([k, label]) => field(label, `finish_${i}_${k}`, f[k] || '')).join('');
    return `<details class="gb-row" ${Object.values(f).some(Boolean) ? 'open' : ''}><summary>Wariant wykończenia ${i + 1}</summary><div class="form-grid">${fields}</div></details>`;
  }).join('');
  const inheritedNotice = r.base_id ? `<div class="notice">Dane skopiowano z <a href="/records/${r.base_id}">wcześniejszego wpisu #${r.base_id}</a>. Wyszarzone wartości można edytować — po zmianie wrócą do zwykłego tła.</div>` : '';
  const descriptionField = newArticleFields
    ? field('Opis dzianiny', 'description', v.description || '', { maxlength: 6000 })
    : field('Skrócony opis dzianiny', 'description', v.description || '', { multiline: true });
  const form = `<form method="post" class="editor" data-dirty${r.base_id ? ' data-inherited-values' : ''}>${hidden('csrf', csrf)}${hidden('revision', r.revision)}
<section class="panel padded"><h2>Artykuł i opis</h2><div class="form-grid">${field('Symbol artykułu', 'symbol', v.symbol || r.symbol, { required: 'required' })}${field('Nr projektu', 'number', r.project_trial_number || '', { readonly: 'readonly' })}${field('Data źródłowa / założenia', 'date', v.date || '', v.date ? { readonly: 'readonly' } : {})}${field('Klient', 'client', v.client || '')}</div>${descriptionField}</section>
<section class="panel padded"><h2>Ustawienia maszyny</h2><div class="form-grid">${tech}</div></section>
<section class="panel padded"><h2>GB — przędze i sploty</h2><p class="muted">Domyślnie GB1 i GB2. Dodaj kolejne w razie potrzeby. Historyczne oznaczenia GB pozostają zachowane.</p><div data-gb-list>${gbRows}</div><button type="button" data-add-gb>+ Dodaj GB</button></section>
<section class="panel padded"><h2>Uwagi dla dziewiarza</h2>${field('Uwagi dla dziewiarza', 'knitter_notes', v.knitter_notes || '', { multiline: true })}</section>
<section class="panel padded"><h2>Parametry dzianiny surowej</h2><div class="target-grid raw-grid">${rawGrid}</div>${field('Komentarz do dzianiny surowej', 'raw_comments', v.raw_comments || '', { multiline: true })}</section>
<section class="panel padded"><h2>Parametry dzianiny wykończonej</h2><p class="muted">Pola opcjonalne. Wartości można uzupełnić później.</p><div class="target-grid">${targetGrid}</div>${field('Komentarz do dzianiny wykończonej', 'finished_comments', v.finished_comments || '', { multiline: true })}</section>
<section class="panel padded"><h2>Dodatkowe warianty wykończenia (opcjonalnie)</h2>${finishRows}</section>
<section class="panel padded"><h2>Etapy i uwagi</h2>${field('Etapy prób — daty, miejsca, wyniki', 'stages', v.stages || '', { multiline: true, className: 'tall' })}${field('Komentarze dodatkowe', 'comments', v.comments || '', { multiline: true })}<p class="muted">Polecenia do konkretnego uruchomienia, np. 10 belek po 150 m, wpiszesz osobno przy wydaniu karty.</p></section>
<section class="panel padded"><h2>Historia zmian artykułu</h2>${field('Komentarz do tej zmiany (opcjonalnie)', 'change_comment', '', { maxlength: 1000 })}</section><div class="savebar"><span>Utworzenie wpisu: ${datepl(r.created_at)} · rewizja ${r.revision}</span>${button('Zapisz zmiany', 'primary')}</div></form>`;
  return layout({ user, csrf, flashes, title: 'Uzupełnij dane · Marand', body: `<a class="breadcrumb" href="/records/${r.id}">← Wróć do wpisu</a><div class="pagehead"><div><span class="eyebrow">${r.kind === 'trial' ? 'PRÓBA' : 'SPECYFIKACJA ROBOCZA'}</span><h1>Uzupełnij dane</h1><p class="muted">Możesz zapisać niepełny wpis i wrócić do niego później.</p></div></div>${newArticleFields ? '<div class="notice">Pierwsza specyfikacja artykułu. Wewnętrzny indeks artykułu jest nadawany automatycznie.</div>' : ''}${inheritedNotice}${form.replace('class="editor"', `class="editor${newArticleFields ? ' new-article-fields' : ''}"`)}` });
}
function recordPage({ user, csrf, flashes, r, v, history, photoPanel = '', aiNotice = '' }) {
  const canEdit = !r.archived_at && !r.article_archived_at && !r.project_archived_at && ['technologist', 'approver', 'admin'].includes(user.role);
  const canApprove = ['approver', 'admin'].includes(user.role) && !r.archived_at && !r.article_archived_at && !r.project_archived_at;
  aiNotice = aiNotice || r.ai_generated_notice || v.ai_generated_notice || '';
  if (aiNotice) flashes = [...flashes, { category: 'warning', message: aiNotice }];
  const tech = TECH.map(([k, label]) => `<div><span>${esc(label)}</span><strong>${esc((v.tech || {})[k] || '—')}</strong></div>`).join('');
  const gbTable = v.gb.length ? v.gb.map(row => `<tr>${GB.map(([k]) => `<td class="preline">${esc(row[k] || '')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${GB.length}">Brak danych GB.</td></tr>`;
  const raw = RAW_METRICS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc((v.raw || {})[k] || '—')}</dd>`).join('');
  const targets = TARGET_METRICS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc((v.targets || {})[k] || '—')}</dd>`).join('');
  const finishes = v.finished.length ? `<section class="panel padded"><h2>Warianty wykończenia / wyniki</h2>${v.finished.map((f, i) => `<h3>${esc(f.name || `Wariant ${i + 1}`)}</h3><p>Gramatura: ${esc(f.weight || '—')} g/m² · Szerokość: ${esc(f.width || '—')} cm · Pk: ${esc(f.pk || '—')} · Pr: ${esc(f.pr || '—')} · Dystans: ${esc(f.thickness || '—')}</p><p class="preline">${esc(f.finish || '')} ${esc(f.comments || '')}</p>`).join('')}</section>` : '';
  const mayArchive = canEdit && r.state === 'draft' && ['trial','spec'].includes(r.kind);
  const actionButtons = `${canEdit && r.state === 'draft' ? link(`/records/${r.id}/edit`, 'Edytuj / uzupełnij', 'button primary') : ''}${`<a class="button" href="/records/${r.id}/preview" target="_blank" rel="noopener">Podgląd wydruku ↗</a>`}${canEdit && r.active_spec === r.id ? link(`/records/${r.id}/issue`, 'Wydaj kartę na maszynę', 'button primary') : ''}${mayArchive ? link(`/records/${r.id}/delete`, 'Przenieś do archiwum…', 'button danger') : ''}`;
  const copyActions = canEdit ? `<div class="actions space">${csrfForm(csrf, `/records/${r.id}/copy`, `${hidden('kind', 'spec')}${button(r.kind === 'spec' ? 'Nowa wersja specyfikacji' : 'Przygotuj specyfikację z próby')}`)}</div>` : '';
  let review = '';
  if (r.kind === 'spec' && ['draft', 'submitted'].includes(r.state)) {
    const reviewNote= r.state === 'submitted' ? field('Uzasadnienie / rozstrzygnięcie rozbieżności (opcjonalnie)', 'review_note', '', { multiline: true, maxlength: 3000, placeholder: 'Opcjonalny komentarz do tej wersji.' }) : '';
    const approve = canApprove ? csrfForm(csrf, `/records/${r.id}/approve`, `${hidden('revision', r.revision)}${reviewNote}<label class="check"><input type="checkbox" name="checked" required>Sprawdzono dane. Zatwierdzam do produkcji.</label>${button('Zatwierdź do produkcji', 'primary')}`) : '';
    const withdraw = r.state === 'submitted' && canEdit ? csrfForm(csrf, `/records/${r.id}/withdraw`, `${hidden('revision', r.revision)}${button('Wycofaj do poprawy')}`, 'space') : '';
    review = `<section class="panel padded"><h2>Zatwierdź specyfikację do produkcji</h2><p class="muted">Zatwierdzenie od razu ustawi tę wersję jako obowiązującą dla artykułu.</p>${r.conflict ? `<p class="notice warning">${esc(r.conflict)}</p>` : ''}${approve}${withdraw}</section>`;
  }
  const sources = v.sources.length ? v.sources.map(s => `<p><a href="/sources/${encodeURIComponent(s.file)}">${esc(s.name)}</a></p>`).join('') : '<p>Wpis utworzony w programie.</p>';
  const audit = history.map(a => `<div class="history"><strong>${esc(a.action)}</strong> · ${esc(a.author || 'Import')} · ${datepl(a.at)}<details><summary>Szczegóły</summary><pre>${esc(a.detail)}</pre></details></div>`).join('');
  const archivedNotice = r.archived_at ? `<div class="notice warning"><strong>Wpis jest w archiwum.</strong> ${Date.now() - Date.parse(r.archived_at) < 30 * 86400000 ? 'Można go przywrócić przez 30 dni w zakładce Archiwum. Po tym czasie wpis i jego własne zdjęcia zostaną usunięte.' : 'Minęło 30 dni; wpis i jego własne zdjęcia oczekują na usunięcie. Artykuł, projekt/próba i wydane karty pozostają zachowane.'}</div>` : '';
  return layout({ user, csrf, flashes, title: `${r.symbol} · Marand`, body: `<a class="breadcrumb" href="${r.article_id ? `/articles/${r.article_id}` : `/projects/${r.project_id}`}">← ${esc(r.article_id ? r.symbol : r.project_name)}</a>${archivedNotice}<div class="pagehead"><div><span class="eyebrow">${r.kind === 'trial' ? 'PRÓBA / WARIANT' : 'WARUNKI DZIANIA'}</span><h1>${esc(r.symbol)}</h1><span class="badge ${esc(r.state)}">${esc(STATE[r.state])}${r.version ? ` · wersja ${r.version}` : ''}</span> ${r.project_trial_number ? `<span class="muted">Nr projektu ${esc(r.project_trial_number)}</span>` : ''}</div><div class="actions">${actionButtons}</div></div>
<div class="metadata"><span>Data źródłowa: <b>${esc(v.date || 'niepodana')}</b></span><span>Utworzono w bazie: ${datepl(r.created_at)}</span><span>Aktualizacja: ${datepl(r.updated_at)}</span>${r.base_id ? `<a href="/records/${r.base_id}">Wpis bazowy #${r.base_id}</a>` : ''}</div>
${r.state === 'approved' ? `<div class="notice success"><strong>${r.active_spec === r.id ? 'Obowiązująca specyfikacja' : 'Historyczna zatwierdzona specyfikacja'}</strong> · zatwierdzono ${datepl(r.approved_at)}<p>${esc(r.review_note)}</p></div>` : ''}${v.source_note ? `<div class="notice warning">${esc(v.source_note)}</div>` : ''}
<div class="panel padded"><h2>Opis i przeznaczenie</h2><p><strong>Klient:</strong> ${esc(v.client || '—')}</p><p class="preline">${esc(v.description || 'Brak opisu.')}</p><div class="metric-grid">${tech}</div></div>
<div class="sectionhead"><h2>Ustawienia GB</h2></div><div class="panel scroll"><table class="listing compact"><thead><tr>${GB.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${gbTable}</tbody></table></div>
<section class="panel padded"><h2>Uwagi dla dziewiarza</h2><p class="preline">${esc(v.knitter_notes || '—')}</p></section>${review}
<div class="two-col"><section class="panel padded"><h2>Parametry dzianiny surowej</h2><dl>${raw}</dl><p class="preline">${esc(v.raw_comments || '')}</p></section><section class="panel padded"><h2>Parametry dzianiny wykończonej</h2><p class="muted small">Dane opcjonalne.</p><dl>${targets}</dl>${v.finished_comments ? `<h3>Komentarz do dzianiny wykończonej</h3><p class="preline">${esc(v.finished_comments)}</p>` : ''}</section></div>${finishes}
<section class="panel padded"><h2>Etapy prób i komentarze</h2><p class="preline">${esc(v.stages || '—')}</p><p class="preline">${esc(v.comments || '')}</p></section>${photoPanel}${copyActions}
<details class="panel padded"><summary>Pliki źródłowe (${v.sources.length})</summary>${sources}</details><details class="panel padded"><summary>Historia zmian</summary>${audit}</details>` });
}
function issuePage({ user, csrf, flashes, r, token, machine = '', instructions = '', productionNotes = '', projectId = '', stageId = '' }) {
  const stageContext=projectId&&stageId?`${hidden('trial_project_id',projectId)}${hidden('trial_stage_id',stageId)}`:'';
  const pending=productionNotes?`<div class="notice production-note-pending"><strong>POLECENIA SPECJALNE — najbliższa produkcja</strong><p class="preline">${esc(productionNotes)}</p><small>Po wydaniu karty polecenia pojawią się na jej dole, a oczekujące polecenie zostanie wyczyszczone z artykułu.</small></div>`:'<p class="muted">Artykuł nie ma oczekujących poleceń specjalnych do produkcji.</p>';
  const editorValue=esc(JSON.stringify({format:INSTRUCTION_FORMAT,runs:instructionRuns(instructions)}));
  const editorSizes=INSTRUCTION_SIZES.map(size=>`<option value="${size}"${size===16?' selected':''}>${size} px</option>`).join('');
  const editor=`<div class="instruction-editor-label"><span>Polecenia na to uruchomienie (opcjonalnie)</span><div class="instruction-editor" data-instruction-editor><div class="instruction-editor-toolbar" role="toolbar" aria-label="Formatowanie poleceń"><button type="button" data-instruction-bold title="Pogrub zaznaczony tekst"><strong>B</strong></button><label>Wielkość czcionki<select data-instruction-size>${editorSizes}</select></label><span class="muted small">Zaznacz tekst i wybierz formatowanie.</span></div><div class="instruction-editor-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Polecenia na to uruchomienie" data-instruction-content>${instructionEditorHtml(instructions)}</div><input type="hidden" name="instructions" value="${editorValue}" data-instruction-value></div></div>`;
  return layout({ user, csrf, flashes, title: 'Wydaj kartę · Marand', body: `<a class="breadcrumb" href="/records/${r.id}">← ${esc(r.symbol)}</a><div class="pagehead"><div><span class="eyebrow">KARTA NA MASZYNĘ</span><h1>Instrukcje do tej produkcji</h1><p class="muted">${esc(r.symbol)} · zatwierdzona specyfikacja v${r.version}</p></div></div>${csrfForm(csrf, `/records/${r.id}/issue`, `${hidden('token', token)}${stageContext}${field('Numer / oznaczenie maszyny', 'machine', machine, { required: 'required', maxlength: 100, placeholder: 'Np. HKS4 — maszyna 12' })}${editor}${pending}<p>Wydruk zachowa dane obowiązującej specyfikacji. Polecenia dotyczą tylko tego wydania.</p>${button('Zapisz i otwórz kartę do druku', 'primary')}`, 'panel padded', '_blank')}` });
}
function issueConfirmPage({ user, csrf, flashes, r, token, machine, instructions, productionNotes = '', projectId = '', stageId = '', changeNotice }) {
  const stageContext=projectId&&stageId?`${hidden('trial_project_id',projectId)}${hidden('trial_stage_id',stageId)}`:'';
  return layout({ user, csrf, flashes, title: 'Potwierdź zmiany karty · Marand', body: `<a class="breadcrumb" href="/records/${r.id}">← ${esc(r.symbol)}</a><div class="pagehead"><div><span class="eyebrow">KARTA NA MASZYNĘ</span><h1>Wydanie karty</h1></div></div><dialog class="form-dialog change-dialog" data-show-modal><div class="dialog-head"><strong>Sprawdź zmiany przed wydaniem karty</strong></div><div class="dialog-body change-confirm">${changeNotice}${productionNotes?`<div class="notice production-note-pending"><strong>POLECENIA SPECJALNE — najbliższa produkcja</strong><p class="preline">${esc(productionNotes)}</p></div>`:''}<form method="post" action="/records/${r.id}/issue">${hidden('csrf',csrf)}${hidden('token',token)}${hidden('machine',machine)}${hidden('instructions',instructions)}${stageContext}${hidden('confirm_changes','1')}<div class="actions"><button name="cancel_confirmation" value="1" formnovalidate>Wróć do formularza</button><button class="primary">Potwierdź i wydaj kartę</button></div></form></div></dialog>` });
}
function cardPage({ r, v, machine, instructions, productionNotes = '', cardno, issuedAt, author, logo, printcss }) {
  const th = (items, cls = '') => `<table${cls ? ` class="${cls}"` : ''}><thead><tr>${items.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody><tr>${items.map(([k]) => `<td>${esc(k === 'machine_number' ? machine : (v.tech || {})[k] || '—')}</td>`).join('')}</tr></tbody></table>`;
  const machineSpecs = TECH.slice(0, 5).map(([key, label]) => key === 'machine_type' ? ['machine_number', 'Nr maszyny'] : [key, label]);
  const yarnRows = (v.gb || []).map(row => `<tr>${['number', 'yarn', 'pattern', 'threads', 'run_in', 'threading'].map(k => `<td>${esc(row[k] || '')}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.symbol)} — karta ${esc(cardno || 'podgląd')}</title><style>${printcss}</style><script defer src="/static/app.js"></script></head><body><div class="toolbar"><button data-print>Drukuj / zapisz jako PDF</button><span>${cardno ? 'Wydana karta — zachowany egzemplarz' : 'Podgląd roboczy — nie jest kartą wydaną na produkcję'}</span></div><article class="sheet"><header><div class="logo"><img src="data:image/jpeg;base64,${logo}" alt="Marand"></div><div><div class="title">WARUNKI DZIANIA · KARTA NA MASZYNĘ</div><h1>${esc(r.symbol)}</h1></div></header>${!cardno ? '<div class="draft">PODGLĄD ROBOCZY — NIE DO PRODUKCJI</div>' : ''}<div class="identity">Specyfikacja: <b>${r.version ? `v${r.version}` : 'niezatwierdzona'}</b> · Wydanie: ${datepl(issuedAt)}<br>Karta: ${esc(cardno || 'niewydana')} · Wydał(a): ${esc(author)}</div>
${th(machineSpecs, 'machine-specs')}<h2>Parametry dzianiny surowej</h2><table><thead><tr>${RAW_METRICS.map(([,label])=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody><tr>${RAW_METRICS.map(([k])=>`<td>${esc(v.raw?.[k] || '—')}</td>`).join('')}</tr></table>${v.raw_comments ? `<div class="notes">${esc(v.raw_comments)}</div>` : ''}<h2>Przędza, raport ogniw wzorujących i nawleczenie</h2><table class="gb"><thead><tr><th>GB</th><th>Rodzaj przędzy</th><th>Raport ogniw wzorujących</th><th>Liczba nici</th><th>Wrobienie (mm/rack)</th><th>Nawleczenie</th></tr></thead><tbody>${yarnRows}</tbody></table>
<div class="production"><section><h2>Parametry dziania</h2><table><tr><th>Domyślna długość belki</th><td>${esc(v.tech.roll_length || '—')} m</td></tr><tr><th>Prędkość</th><td>${esc(v.tech.speed || '—')}</td></tr><tr><th>Ustawienie dystansu</th><td>${esc(v.tech.distance || '—')}</td></tr></table></section><section><h2>Polecenia do tej produkcji</h2><div class="instructions">${instructionCardHtml(instructions)}</div></section></div><h2>Uwagi dla dziewiarza</h2><div class="notes">${esc(v.knitter_notes || '—')}</div><table class="signatures"><tr><th>Podpis dziewiarza</th><td>1.</td><td>2.</td><td>3.</td></tr></table><h2>Notatki od dziewiarza</h2><div class="handnotes"></div>${productionNotes?`<h2 class="production-notes-heading">Jednorazowe instrukcje przy produkcji</h2><div class="notes production-notes-row">${esc(productionNotes)}</div>`:''}<footer>Marand · ${esc(r.symbol)} · ${esc(cardno || 'Podgląd roboczy')} · Specyfikacja ${r.version || 'robocza'}</footer></article></body></html>`;
}
function destructiveConfirmPage({ user, csrf, flashes, title, heading, selectedLabel, object, details, action, cancelUrl, confirmText }) {
  return layout({ user, csrf, flashes, title, body: `<dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="${esc(cancelUrl)}"><div class="dialog-head"><strong>${esc(heading)}</strong><a class="dialog-close" href="${esc(cancelUrl)}" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>${esc(selectedLabel)}</p><h2 class="delete-confirm-object">${object}</h2>${details}${csrfForm(csrf, action, `<a class="button" href="${esc(cancelUrl)}">Anuluj</a> ${button(confirmText, 'danger')}`, 'actions')}</div></dialog>` });
}
function confirmArchiveRecordPage({ user, csrf, flashes, r }) {
  const label = r.kind === 'trial' ? 'próbę' : 'roboczą specyfikację';
  return destructiveConfirmPage({user,csrf,flashes,title:'Potwierdź archiwizację · Marand',heading:'Przenieść wpis do archiwum?',selectedLabel:'Wybrany wpis:',object:`${esc(label)} „${esc(r.symbol)}” · wpis #${r.id}`,details:'<p>Można go przywrócić przez 30 dni. Po tym czasie wpis i jego własne zdjęcia zostaną usunięte; artykuł, projekt/próba i wydane karty pozostaną zachowane.</p>',action:`/records/${r.id}/delete`,cancelUrl:`/records/${r.id}`,confirmText:`Tak, archiwizuj wpis #${r.id}`});
}
function confirmArchiveProjectPage({ user, csrf, flashes, p }) {
  return destructiveConfirmPage({user,csrf,flashes,title:'Potwierdź archiwizację · Marand',heading:'Przenieść projekt/próbę do archiwum?',selectedLabel:'Wybrany projekt/próba:',object:`„${esc(p.name)}” · projekt/próba #${p.id}`,details:'<p>Przez 30 dni można go przywrócić. Powiązane artykuły, próby, zdjęcia i wydane karty pozostaną bez zmian.</p>',action:`/projects/${p.id}/delete`,cancelUrl:`/projects/${p.id}`,confirmText:`Tak, archiwizuj „${p.name}”`});
}
function confirmDeleteStagePage({ user, csrf, flashes, p, stage, articles = [] }) {
  const articleList=articles.length?`<p>Artykuły przypisane do etapu: <strong>${articles.map(article=>esc(article.symbol)).join(', ')}</strong>.</p>`:'<p>Do etapu nie przypisano artykułów.</p>';
  return destructiveConfirmPage({user,csrf,flashes,title:'Potwierdź usunięcie etapu · Marand',heading:'Potwierdź usunięcie etapu',selectedLabel:'Wybrany etap:',object:`Etap ${stage.stage_no} · ${esc(stage.description||'Etap bez opisu')}`,details:`${articleList}<p>Usunięty zostanie etap, jego opis i komentarze. Artykuły, ich specyfikacje i wydane karty pozostaną zachowane w próbie i kartotece.</p>`,action:`/projects/${p.id}/stages/${stage.id}/delete`,cancelUrl:`/projects/${p.id}`,confirmText:'Potwierdź usunięcie etapu'});
}
function confirmRemoveProjectArticlePage({ user, csrf, flashes, p, article, stageCount = 0 }) {
  return destructiveConfirmPage({user,csrf,flashes,title:'Potwierdź odpięcie artykułu · Marand',heading:'Odpiąć artykuł od próby/projektu?',selectedLabel:'Wybrany artykuł:',object:`„${esc(article.symbol)}”`,details:`<p>Usunięte zostanie powiązanie z próbą${stageCount?` i jej ${stageCount} etapami`:''}. Artykuł, specyfikacje, zdjęcia i wydane karty pozostaną aktywne w kartotece.</p>`,action:`/projects/${p.id}/articles/${article.id}/unlink`,cancelUrl:`/projects/${p.id}`,confirmText:'Potwierdź odpięcie artykułu'});
}
function confirmDeleteCommentPage({ user, csrf, flashes, p, comment }) {
  return destructiveConfirmPage({user,csrf,flashes,title:'Usuń komentarz próby · Marand',heading:'Potwierdź usunięcie komentarza',selectedLabel:'Wybrany komentarz:',object:`${esc(comment.author_name||'Nieznany autor')} · ${datepl(comment.created_at)}`,details:`<blockquote class="delete-comment-quote">${esc(comment.content)}</blockquote><p>Usunięty zostanie tylko ten komentarz.</p>`,action:`/projects/${p.id}/comments/${comment.id}/delete`,cancelUrl:`/projects/${p.id}`,confirmText:'Potwierdź usunięcie komentarza'});
}
function confirmDeleteStageCommentPage({ user, csrf, flashes, p, stage, comment }) {
  return destructiveConfirmPage({user,csrf,flashes,title:'Usuń komentarz etapu · Marand',heading:'Potwierdź usunięcie komentarza etapu',selectedLabel:`Komentarz z etapu ${stage.stage_no}:`,object:`${esc(comment.author_name||'Nieznany autor')} · ${datepl(comment.created_at)}`,details:`<blockquote class="delete-comment-quote">${esc(comment.content)}</blockquote><p>Usunięty zostanie tylko ten komentarz etapu.</p>`,action:`/projects/${p.id}/stages/${stage.id}/comments/${comment.id}/delete`,cancelUrl:`/projects/${p.id}?stage=${stage.id}#trial-stage-${stage.id}`,confirmText:'Potwierdź usunięcie komentarza'});
}
function confirmArchiveArticlePage({ user, csrf, flashes, a, returnTo = `/articles/${a.id}` }) {
  const safeReturn=/^\/(?:articles|projects)\/\d+$/.test(returnTo)?returnTo:`/articles/${a.id}`;
  const query=`?return_to=${encodeURIComponent(safeReturn)}`;
  return destructiveConfirmPage({user,csrf,flashes,title:'Potwierdź archiwizację artykułu · Marand',heading:'Przenieść artykuł do archiwum?',selectedLabel:'Wybrany artykuł:',object:`„${esc(a.symbol)}” · artykuł #${a.id}`,details:'<p>Artykuł zniknie z aktywnej kartoteki. W już istniejących projektach pozostanie oznaczony jako zarchiwizowany. Przez 30 dni można go przywrócić. Jego specyfikacje, zdjęcia i wydane karty pozostaną zachowane; wydane karty nie zostaną zmienione.</p>',action:`/articles/${a.id}/delete${query}`,cancelUrl:safeReturn,confirmText:`Tak, archiwizuj artykuł „${a.symbol}”`});
}
function confirmPurgeArticlePage({ user, csrf, flashes, a }) {
  return destructiveConfirmPage({user,csrf,flashes,title:'Usuń z archiwum · Marand',heading:'Usunąć artykuł z widocznego archiwum?',selectedLabel:'Wybrany artykuł:',object:`„${esc(a.symbol)}” · artykuł #${a.id}`,details:'<p>Artykuł zniknie z kartoteki i archiwum. Jego historyczne specyfikacje, próby, powiązania projektu i wydane karty pozostaną dostępne. Zdjęcia przypisane bezpośrednio do artykułu zostaną usunięte.</p>',action:`/articles/${a.id}/purge`,cancelUrl:'/archive',confirmText:`Tak, usuń artykuł ${a.symbol}`});
}
function archivePage({ user, csrf, flashes, records = [], projects = [], articles = [] }) {
  const canRestore = ['technologist','approver','admin'].includes(user.role);
  const recordRows = records.map(r=>`<tr><td>${r.kind==='trial'?'Próba':'Robocza specyfikacja'} „${esc(r.symbol)}”<br><small>Wpis #${r.id}${r.project_name?` · ${esc(r.project_name)}`:''}</small></td><td>${datepl(r.archived_at)}</td><td>${datepl(new Date(Date.parse(r.archived_at)+30*86400000).toISOString())}</td><td><a href="/records/${r.id}">Otwórz</a></td><td>${canRestore?csrfForm(csrf,`/records/${r.id}/restore`,button('Przywróć'),'inline-add-form'):''}</td></tr>`).join('');
  const projectRows = projects.map(p=>`<tr><td>„${esc(p.short_description||p.name)}”<br><small>Próba ${esc(p.trial_number||`#${p.id}`)}</small></td><td>${datepl(p.archived_at)}</td><td>${datepl(new Date(Date.parse(p.archived_at)+30*86400000).toISOString())}</td><td><a href="/projects/${p.id}">Otwórz</a></td><td>${canRestore?csrfForm(csrf,`/projects/${p.id}/restore`,button('Przywróć'),'inline-add-form'):''}</td></tr>`).join('');
  const articleRows=articles.map(a=>`<tr><td>„${esc(a.symbol)}”<br><small>Artykuł #${a.id}</small></td><td>${datepl(a.archived_at)}</td><td>${datepl(new Date(Date.parse(a.archived_at)+30*86400000).toISOString())}</td><td><a href="/articles/${a.id}">Otwórz</a></td><td>${canRestore?csrfForm(csrf,`/articles/${a.id}/restore`,button('Przywróć'),'inline-add-form'):''}</td><td>${canRestore?`<a class="delete-x" href="/articles/${a.id}/purge" aria-label="Usuń artykuł ${esc(a.symbol)} z archiwum" title="Usuń z archiwum">×</a>`:''}</td></tr>`).join('');
  return layout({ user, csrf, flashes, title: 'Archiwum · Marand', body: `<div class="pagehead"><div><span class="eyebrow">ARCHIWUM</span><h1>Archiwum · 30 dni</h1><p class="muted">Robocze wpisy i ich zdjęcia są usuwane po 30 dniach. Zarchiwizowane artykuły można przywrócić lub usuwać pojedynczo; powiązane próby i wydane karty pozostają zachowane.</p></div></div><section class="panel"><h2 class="archive-heading">Robocze specyfikacje i próby</h2><div class="scroll"><table class="listing"><thead><tr><th>Wpis</th><th>Przeniesiono</th><th>Termin przywrócenia</th><th></th><th></th></tr></thead><tbody>${recordRows||'<tr><td colspan="5">Brak wpisów w archiwum.</td></tr>'}</tbody></table></div></section><section class="panel"><h2 class="archive-heading">Projekty i próby</h2><div class="scroll"><table class="listing"><thead><tr><th>Projekt/próba</th><th>Przeniesiono</th><th>Termin przywrócenia</th><th></th><th></th></tr></thead><tbody>${projectRows||'<tr><td colspan="5">Brak projektów/prób w archiwum.</td></tr>'}</tbody></table></div></section><section class="panel"><h2 class="archive-heading">Artykuły</h2><div class="scroll"><table class="listing"><thead><tr><th>Artykuł</th><th>Przeniesiono</th><th>Termin przywrócenia</th><th></th><th></th><th></th></tr></thead><tbody>${articleRows||'<tr><td colspan="6">Brak artykułów w archiwum.</td></tr>'}</tbody></table></div></section>` });
}
function confirmRestoreImportPage({ user, csrf, flashes, run, backupName }) {
  const imported = run.result?.imported || {};
  const importSummary = imported.finishing_orders !== undefined
    ? `${esc(imported.finishing_recipes ?? 0)} receptur · ${esc(imported.finishing_orders ?? 0)} zleceń wykończenia · ${esc(imported.finishing_batches ?? 0)} partii`
    : `${esc(imported.articles ?? 0)} artykułów · ${esc(imported.projects ?? 0)} prób`;
  const details = `<p>Import: <strong>${datepl(run.imported_at)}</strong>${run.result?.package_sha256 ? ` · paczka SHA-256: ${esc(run.package_hash.slice(0, 12))}…` : ''}</p><p>Przywrócona zostanie kopia <strong>${esc(backupName)}</strong>, wykonana przed tym importem. Baza i zdjęcia wrócą do wcześniejszego stanu. Zmiany wykonane po imporcie znikną.</p><p>Przed przywróceniem program wykona i sprawdzi dodatkową kopię obecnej bazy i zdjęć.</p>`;
  const content = `${hidden('package_hash', run.package_hash)}<label class="check"><input type="checkbox" name="confirm" value="PRZYWRÓĆ" required> Potwierdzam przywrócenie bazy sprzed tego importu.</label>${button('Przywróć bazę sprzed importu', 'danger')}`;
  return layout({ user, csrf, flashes, title: 'Przywróć bazę sprzed importu · Marand', body: `<dialog class="form-dialog delete-confirm-dialog" data-show-modal data-cancel-url="/admin/import"><div class="dialog-head"><strong>Przywrócić bazę sprzed importu?</strong><a class="dialog-close" href="/admin/import" aria-label="Anuluj">×</a></div><div class="dialog-body"><p>Wybrany import:</p><h2 class="delete-confirm-object">${importSummary}</h2>${details}${csrfForm(csrf, '/admin/import/restore/apply', content, 'actions')}<a class="button" href="/admin/import">Anuluj</a></div></dialog>` });
}

function sourceImportPage({ user, csrf, flashes, latestImport = null, restoreStatus = null }) {
  let restorePanel = '';
  if (restoreStatus) {
    const message = restoreStatus.ok
      ? `Przywrócono bazę sprzed importu ${esc(String(restoreStatus.package_hash || '').slice(0, 12))}… · ${datepl(restoreStatus.at)}. Kopia obecnego stanu: ${esc(restoreStatus.rollback_name || '')}.`
      : `Ostatnie przywracanie nie zakończyło się poprawnie · ${datepl(restoreStatus.at)}. ${esc(restoreStatus.error || 'Sprawdź folder administracja\\logs.')}`;
    restorePanel += `<div class="notice ${restoreStatus.ok ? 'success' : 'warning'}" role="status">${message}</div>`;
  }
  if (latestImport) {
    const imported = latestImport.result?.imported || {};
    const summary = imported.finishing_orders !== undefined
      ? `${esc(imported.finishing_recipes ?? 0)} receptur · ${esc(imported.finishing_orders ?? 0)} zleceń wykończenia · ${esc(imported.finishing_batches ?? 0)} partii · ${esc(imported.finishing_receipts ?? 0)} przyjęć`
      : `${esc(imported.articles ?? 0)} artykułów · ${esc(imported.specifications ?? 0)} specyfikacji · ${esc(imported.projects ?? 0)} prób`;
    const action = latestImport.restore_ready
      ? `<a class="button danger" href="/admin/import/restore?package_hash=${encodeURIComponent(latestImport.package_hash)}">Przywróć bazę sprzed importu</a>`
      : `<div class="notice warning">Nie można przywrócić tej kopii: ${esc(latestImport.restore_error || 'kopia przed importem jest niedostępna lub uszkodzona')}.</div>`;
    restorePanel += `<section class="panel padded"><h2>Ostatni import</h2><p>Wykonano: <strong>${datepl(latestImport.imported_at)}</strong> · ${summary}.</p><p class="muted small">Kopia przed importem: ${esc(latestImport.backup_name || 'niedostępna')}.</p>${action}</section>`;
  }
  const body = `<a class="breadcrumb" href="/">← Artykuły i projekty</a><div class="pagehead"><div><span class="eyebrow">ADMINISTRACJA</span><h1>Import danych</h1><p class="muted">Wczytaj paczkę danych do kartoteki lub modułu wykańczania.</p></div></div>
<section class="panel padded"><h2>Wybierz plik</h2><p>Możesz wskazać <code>marand_application_import.json</code> albo prywatną paczkę <code>marand_finishing_import.json</code>. Program pokaże zakres i liczbę wpisów przed zapisem.</p><p class="muted small">Paczka jest przesyłana bezpośrednio do tej aplikacji, nie trafia do GitHuba. Po zatwierdzeniu program najpierw utworzy sprawdzoną kopię bazy.</p><form data-source-import-upload data-csrf="${esc(csrf)}"><label>Plik paczki JSON<input type="file" accept=".json,application/json" data-source-import-file required></label><button class="primary" data-import-upload-button>Sprawdź paczkę</button><p class="autosave-status muted" data-source-import-status role="status"></p></form></section>
<section class="panel padded" data-source-import-preview hidden><h2>Podgląd importu</h2><p data-import-summary></p><div class="import-preview-grid"><section><h3>Obecna baza</h3><ul data-import-existing></ul></section><section><h3>Po imporcie</h3><ul data-import-incoming></ul></section><section data-import-archive-section><h3>Archiwizowane na 30 dni</h3><ul data-import-archive></ul></section><section><h3>Pozostaje bez zmian</h3><ul data-import-preserved></ul></section></div><div class="notice warning" data-import-ai-notice></div><div class="notice warning" data-import-conflict-box hidden><strong>Import wymaga sprawdzenia.</strong><ul data-import-conflicts></ul></div><div class="notice" data-import-info></div><form method="post" action="/admin/import/apply" data-source-import-apply hidden>${hidden('csrf',csrf)}<input type="hidden" name="token" data-import-token><label class="check"><input type="checkbox" name="confirm" value="IMPORTUJ" required> <span data-import-confirmation>Potwierdzam import i utworzenie kopii bazy.</span></label><button class="primary">Utwórz kopię i zaimportuj dane</button></form></section>${restorePanel}`;
  return layout({ user, csrf, flashes, title: 'Import danych · Marand', body });
}

function updatePage({ user, csrf, flashes, current, latest, status, repo, canUpdate, updateAvailable, updateError }) {
  let latestInfo = latest ? `<p>Najnowsze wydanie: <strong>${esc(latest.tag_name)}</strong>${latest.name ? ` · ${esc(latest.name)}` : ''}</p>` : '<p>Nie sprawdzono jeszcze wydań.</p>';
  const updatePending=Boolean(status?.pending);
  const statusInfo = updatePending ? `<div class="notice" role="status">Instaluję wersję ${esc(status.version||'')}… Ta strona odświeży się po zakończeniu.</div>` : status ? `<div class="notice ${status.ok ? 'success' : 'warning'}">${status.ok ? `Ostatnia aktualizacja zakończyła się powodzeniem: ${esc(status.version || '')} · ${datepl(status.at)}` : `Ostatnia aktualizacja nie powiodła się: ${esc(status.error || 'sprawdź log aktualizacji')}`}</div>` : '';
  const updateForm = updatePending
    ? ''
    : !canUpdate
    ? `<div class="notice warning">Aktualizator nie jest skonfigurowany. Uruchom ponownie instalator Windows.</div>`
    : updateAvailable
      ? csrfForm(csrf, '/admin/update', button('Pobierz i zainstaluj aktualizację z GitHub', 'primary'))
      : latest
        ? '<div class="notice success">Masz już najnowszą wersję.</div>'
        : '<div class="notice">Aktualizacja pojawi się tutaj po opublikowaniu wydania na GitHub.</div>';
  const refresh=updatePending?`<div data-update-refresh data-update-version="${esc(status.version||'')}"></div>`:'';
  return layout({ user, csrf, flashes, title: 'Aktualizacje · Marand', body: `<a class="breadcrumb" href="/">← Artykuły i projekty</a><div class="pagehead"><div><span class="eyebrow">ADMINISTRACJA</span><h1>Aktualizacje programu</h1><p class="muted">Wersja zainstalowana: ${esc(current)}</p></div></div><div class="panel padded"><h2>Źródło aktualizacji</h2><p>${repo ? `Repozytorium GitHub: <strong>${esc(repo)}</strong>` : 'Repozytorium GitHub nie jest skonfigurowane.'}</p>${latestInfo}${updateError ? `<div class="notice warning">${esc(updateError)}</div>` : ''}${statusInfo}${updateForm}${refresh}<p class="muted small">Po każdym wypchnięciu zmian na main GitHub przygotowuje wydanie. Aktualizacja sprawdza sumy SHA-256, wykonuje kopię bazy i w razie problemu przywraca poprzedni program. Dane pozostają osobno.</p></div>` });
}

module.exports = { TECH, RAW_METRICS, TARGET_METRICS, GB, FINISH, STATE, PROJECT_STATUS, LOGO_CACHE_VERSION, esc, datepl, todayInput, instructionsText, layout, errorPage, loginPage, homePage, projectPage, editPage, recordPage, issuePage, issueConfirmPage, cardPage, confirmArchiveRecordPage, confirmArchiveProjectPage, confirmDeleteStagePage, confirmDeleteCommentPage, confirmDeleteStageCommentPage, confirmRemoveProjectArticlePage, confirmArchiveArticlePage, confirmPurgeArticlePage, archivePage, confirmRestoreImportPage, sourceImportPage, updatePage };
