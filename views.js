'use strict';

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
];
const GB = [
  ['number', 'GB'], ['pattern', 'Raport ogniw wzorujących'], ['yarn', 'Rodzaj przędzy'], ['threads', 'Liczba nici'],
  ['run_in', 'Wrobienie (mm/rack)'], ['threading', 'Nawleczenie'],
];
const FINISH = [
  ['name', 'Nazwa'], ['weight', 'Gramatura (g/m²)'], ['width', 'Szerokość (cm)'], ['pk', 'Pk'], ['pr', 'Pr'],
  ['thickness', 'Dystans / grubość (mm)'], ['finish', 'Wykończenie / usztywnienie'], ['comments', 'Komentarz'],
];
const ROLE = { admin: 'Administrator', approver: 'Zatwierdzanie', technologist: 'Technolog', viewer: 'Podgląd' };
const STATE = { draft: 'Robocza', submitted: 'Do zatwierdzenia', approved: 'Zatwierdzona' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function datepl(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return esc(value);
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
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
  const adminNav = user && user.role === 'admin' ? '<a class="nav-link" href="/admin/update">Aktualizacje GitHub</a>' : '';
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/static/app.css"><script defer src="/static/app.js"></script></head><body>
<aside class="sidebar"><a class="brand" href="/"><img src="/static/logo.jpg" alt="Marand Technical textiles"></a><div class="brand-caption">TECHNOLOGIA I ROZWÓJ</div><nav>${require('./modules/navigation').filter(m=>!m.roles || (user && m.roles.includes(user.role))).map(m=>`<a class="nav-link" href="${m.href}">${esc(m.label)}</a>`).join('')}<div class="nav-hint">Próby · Specyfikacje · Karty na maszyny</div>${adminNav}</nav><div class="sidebar-bottom">Wersja ${esc(process.env.MARAND_VERSION || '0.3.0')}<br><small>Dokumentacja technologiczna</small></div></aside>
<div class="workspace"><header class="topbar"><span>Marand / Dokumentacja technologiczna</span>${userBox}</header><main>${notices}${body}</main></div></body></html>`;
}
function errorPage({ error, status = 400, ...base }) {
  return layout({ ...base, title: 'Operacja nie została wykonana', body: `<h1>Operacja nie została wykonana</h1><div class="notice warning">${esc(error)}</div><p>Jeżeli formularz zawiera Twoje zmiany, użyj przycisku „Wstecz” w przeglądarce i skopiuj je przed odświeżeniem.</p><a class="button" href="/">Wróć do kartoteki</a>` });
}
function loginPage(args) {
  return layout({ ...args, title: 'Logowanie · Marand', body: `<div class="login"><span class="eyebrow">WSPÓLNA DOKUMENTACJA MARAND</span><h1>Wszystko o artykule.<br>W jednym miejscu.</h1><p class="muted">Zaloguj się, aby otworzyć próby, warunki dziania i karty na maszyny.</p>${csrfForm(args.csrf, '/login', `${field('Login', 'login', '', { required: 'required', autocomplete: 'username', autofocus: 'autofocus' })}${field('Hasło', 'password', '', { type: 'password', required: 'required', autocomplete: 'current-password' })}${button('Zaloguj się', 'primary')}`)}</div>` });
}
function homePage({ user, csrf, flashes, projects, total, page, q, state, backupState, articleInput = '' }) {
  let backup = '';
  if (user.role === 'admin') {
    const ok = backupState && backupState.ok && !backupState.stale;
    const detail = backupState && backupState.last_success
      ? `<strong>Ostatnia udana kopia:</strong> ${datepl(backupState.last_success)}${!ok ? ' — sprawdź harmonogram kopii z informatykiem.' : ''}`
      : '<strong>Kopie zapasowe:</strong> brak potwierdzonej kopii. Informatyk powinien uruchomić harmonogram przed rozpoczęciem pracy.';
    backup = `<div class="notice ${ok ? 'success' : 'warning'}">${detail}</div><div class="actions space"><a class="button" href="/admin/update">Sprawdź aktualizacje</a></div>`;
  }
  const emptyMessage = q || state ? 'Brak wyników wyszukiwania.' : (['technologist', 'approver', 'admin'].includes(user.role) ? 'Brak projektów / prób. Dodaj pierwsze poniżej.' : 'Nie ma jeszcze projektów / prób. Poproś technologa o dodanie pierwszych.');
  const rows = projects.length ? projects.map(p => `<tr><td><a class="item-title" href="/projects/${p.id}">${esc(p.name)}</a><div class="muted small">${esc(p.description)}</div>${p.conflict ? '<span class="flag">Rozbieżności w źródłach</span>' : ''}</td><td>${p.article_count}</td><td>${p.total}</td><td><span class="badge ${p.active_spec ? 'approved' : 'draft'}">${p.active_spec ? `Zatwierdzone artykuły: ${p.active_spec}` : 'Do opracowania'}</span></td><td>${datepl(p.updated)}</td><td><a class="button" href="/projects/${p.id}">Otwórz →</a></td></tr>`).join('') : `<tr><td colspan="6">${emptyMessage}</td></tr>`;
  const search = `<form class="searchbar"><input name="q" value="${esc(q)}" placeholder="Szukaj projektu, artykułu lub opisu…" aria-label="Szukaj"><select name="state" aria-label="Stan zatwierdzenia"><option value="" ${state === '' ? 'selected' : ''}>Wszystkie projekty / próby</option><option value="approved" ${state === 'approved' ? 'selected' : ''}>Z zatwierdzoną specyfikacją</option><option value="pending" ${state === 'pending' ? 'selected' : ''}>Bez zatwierdzenia</option></select><button class="primary">Szukaj</button></form>`;
  const pageUrl = n => `/projects?q=${encodeURIComponent(q)}&state=${encodeURIComponent(state)}&page=${n}`;
  const pages = `<div class="pagination">${page > 1 ? `<a href="${pageUrl(page - 1)}">← Poprzednia</a>` : ''}<span>Strona ${page}</span>${page * 15 < total ? `<a href="${pageUrl(page + 1)}">Następna →</a>` : ''}</div>`;
  const create = ['technologist', 'approver', 'admin'].includes(user.role) ? `<details class="panel newproject"><summary>+ Dodaj projekt / próbę</summary>${csrfForm(csrf, '/projects', `<label>Nazwa projektu / próby<input name="name" required maxlength="150"></label><label>Cel / opis<textarea name="description" maxlength="6000"></textarea></label>${articleInput}<button>Utwórz</button>`)}</details>` : '';
  return layout({ user, csrf, flashes, title: 'Projekty / próby · Marand', body: `<div class="pagehead"><div><span class="eyebrow">PROJEKTY I PRÓBY</span><h1>Projekty / próby</h1><p class="muted">Osobny obszar do grupowania artykułów, prób i wariantów.</p></div><span class="count">${total} projektów / prób</span></div>${backup}${search}<div class="panel"><table class="listing"><thead><tr><th>Projekt / próba</th><th>Artykuły</th><th>Próby i specyfikacje</th><th>Stan</th><th>Ostatnia zmiana</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${pages}${create}` });
}
function projectPage({ user, csrf, flashes, p, records, cards, linkedArticles = [], articleInput = '' }) {
  const specs = records.filter(r => r.kind === 'spec');
  const trials = records.filter(r => r.kind === 'trial');
  const canEdit = ['technologist', 'approver', 'admin'].includes(user.role);
  const add = kind => canEdit && linkedArticles.length ? csrfForm(csrf, `/projects/${p.id}/new`, `${hidden('kind', kind)}<label class="inline-add"><span>Artykuł</span><select name="article_id" aria-label="Artykuł" required><option value="">Wybierz artykuł</option>${linkedArticles.map(a=>`<option value="${a.id}">${esc(a.symbol)}</option>`).join('')}</select></label>${button(kind === 'spec' ? '+ Nowa specyfikacja' : '+ Nowa próba / wariant')}`, 'inline-add-form') : '';
  const specTiles = specs.length ? specs.map(r => `<a class="record-tile" href="/records/${r.id}"><span class="badge ${esc(r.state)}">${esc(STATE[r.state])}${r.version ? ` · v${r.version}` : ''}</span><h3>${esc(r.symbol)}</h3><p>${r.is_current ? 'Obowiązująca' : r.state === 'approved' ? 'Historyczna' : 'Przed wydaniem na produkcję wymaga zatwierdzenia'}</p><small>${datepl(r.updated_at)} · wpis ${r.id}</small></a>`).join('') : '<p class="muted">Brak specyfikacji. Możesz przygotować ją na podstawie wybranej próby lub od początku.</p>';
  const trialRows = trials.length ? trials.map(r => `<tr><td><a class="item-title" href="/records/${r.id}">${esc(r.symbol)}</a></td><td>${esc(r.number || '—')}</td><td>${datepl(r.updated_at)}</td><td><a href="/records/${r.id}">Otwórz →</a></td></tr>`).join('') : '<tr><td colspan="4">Artykuł standardowy może mieć specyfikację bez kart prób.</td></tr>';
  const cardRows = cards.length ? cards.map(c => `<tr><td><a href="/cards/${c.id}" target="_blank" rel="noopener">Karta #${c.id} ↗</a></td><td>${esc(c.machine)}</td><td class="preline">${esc(c.instructions)}</td><td>${datepl(c.created_at)}<br><small>${esc(c.author)}</small></td></tr>`).join('') : '<tr><td colspan="4">Po zatwierdzeniu specyfikacji można wydać pierwszą kartę na konkretną maszynę.</td></tr>';
  const linkedArticleRows = linkedArticles.map(a => `<div class="linked-article-row">${link(`/articles/${a.id}`,esc(a.symbol))}${canEdit ? csrfForm(csrf,`/projects/${p.id}/articles/${a.id}/unlink`,button('Odepnij','link'),'inline-add-form') : ''}</div>`).join(' ') || '<p>Nie dodano jeszcze artykułów.</p>';
  return layout({ user, csrf, flashes, title: `${p.name} · Marand`, body: `<a class="breadcrumb" href="/projects">← Projekty / próby</a><div class="pagehead"><div><span class="eyebrow">PROJEKT / PRÓBA #${p.id}</span><h1>${esc(p.name)}</h1><p class="muted">${esc(p.description)}</p></div></div><section class="panel padded"><h2>Artykuły w projekcie</h2>${linkedArticleRows}${canEdit && linkedArticles.length ? '<p class="muted small">Odpięcie usuwa tylko powiązanie z projektem. Artykuł i jego historia pozostają w kartotece.</p>' : ''}${canEdit ? `<details><summary>+ Dodaj artykuł do projektu</summary>${csrfForm(csrf,`/projects/${p.id}/articles`,articleInput+button('Dodaj artykuł'))}</details>` : ''}</section>${p.conflict ? `<div class="notice warning"><strong>Do rozstrzygnięcia przed zatwierdzeniem</strong><p>${esc(p.conflict)}</p></div>` : ''}<div class="sectionhead"><h2>Specyfikacje</h2>${add('spec')}</div><div class="grid">${specTiles}</div><div class="sectionhead"><h2>Próby i warianty</h2>${add('trial')}</div><div class="panel"><table class="listing"><thead><tr><th>Artykuł</th><th>Numer próby</th><th>Ostatnia aktualizacja</th><th></th></tr></thead><tbody>${trialRows}</tbody></table></div><div class="sectionhead"><h2>Wydane karty na maszyny</h2><span class="muted">${cards.length} kart</span></div><div class="panel"><table class="listing"><thead><tr><th>Karta</th><th>Maszyna</th><th>Polecenia</th><th>Wydanie</th></tr></thead><tbody>${cardRows}</tbody></table></div>` });
}
function metricInputs(v, group, metrics) {
  return metrics.map(([k, label]) => field(label, `${group}_${k}`, (v[group] || {})[k] || '', { className: 'compact-value' })).join('');
}
function editPage({ user, csrf, flashes, r, v }) {
  const tech = TECH.map(([k, label]) => field(label, `tech_${k}`, (v.tech || {})[k] || '')).join('');
  const gbCount = Math.max(2, v.gb.length);
  const gbRows = Array.from({ length: gbCount }, (_, i) => {
    const row = v.gb[i] || {};
    const number = row.number || String(Math.max(0,...v.gb.map(g=>Number(g.number))) + i - v.gb.length + 1);
    const values = GB.filter(([k]) => k !== 'number').map(([k,label])=>field(label,`gb_${i}_${k}`,row[k]||'',{className:['yarn','threads','run_in','threading'].includes(k)?'compact-gb-field':''})).join('');
    return `<section class="gb-row" data-gb-index="${i}" data-gb-number="${esc(number)}"><div class="gb-fields-scroll"><div class="gb-fields"><h3>GB${esc(number)}</h3>${hidden(`gb_${i}_number`,number)}${values}</div></div></section>`;
  }).join('');
  const targetGrid = `<strong>Parametr</strong><strong>Wartość</strong>${TARGET_METRICS.map(([k, label]) => `<label for="target_${k}">${esc(label)}</label><input id="target_${k}" name="targets_${k}" value="${esc((v.targets || {})[k] || '')}">`).join('')}`;
  const finishRows = Array.from({ length: 3 }, (_, i) => {
    const f = v.finished[i] || {};
    const fields = FINISH.map(([k, label]) => field(label, `finish_${i}_${k}`, f[k] || '')).join('');
    return `<details class="gb-row" ${Object.values(f).some(Boolean) ? 'open' : ''}><summary>Wariant wykończenia ${i + 1}</summary><div class="form-grid">${fields}</div></details>`;
  }).join('');
  const form = `<form method="post" class="editor" data-dirty>${hidden('csrf', csrf)}${hidden('revision', r.revision)}
<section class="panel padded"><h2>Artykuł i opis</h2><div class="form-grid">${field('Symbol artykułu', 'symbol', v.symbol || r.symbol, { required: 'required' })}${field('Numer próby / odniesienie', 'number', v.number || '')}${field('Data źródłowa / założenia', 'date', v.date || '', v.date ? { readonly: 'readonly' } : {})}${field('Klient', 'client', v.client || '')}</div>${field('Opis / założenia projektu', 'description', v.description || '', { multiline: true })}</section>
<section class="panel padded"><h2>Ustawienia maszyny</h2><div class="form-grid">${tech}</div></section>
<section class="panel padded"><h2>GB — przędze i sploty</h2><p class="muted">Domyślnie GB1 i GB2. Dodaj kolejne w razie potrzeby. Historyczne oznaczenia GB pozostają zachowane.</p><div data-gb-list>${gbRows}</div><button type="button" data-add-gb>+ Dodaj GB</button></section>
<section class="panel padded"><h2>Parametry dzianiny surowej</h2><div class="form-grid">${metricInputs(v, 'raw', RAW_METRICS)}</div>${field('Komentarz do dzianiny surowej', 'raw_comments', v.raw_comments || '', { multiline: true })}</section>
<section class="panel padded"><h2>Parametry dzianiny wykończonej</h2><p class="muted">Pola opcjonalne. Wartości można uzupełnić później.</p><div class="target-grid">${targetGrid}</div></section>
<section class="panel padded"><h2>Dodatkowe warianty wykończenia (opcjonalnie)</h2>${finishRows}</section>
<section class="panel padded"><h2>Etapy i uwagi</h2>${field('Etapy prób — daty, miejsca, wyniki', 'stages', v.stages || '', { multiline: true, className: 'tall' })}${field('Komentarze dodatkowe', 'comments', v.comments || '', { multiline: true })}${field('Stałe uwagi dla dziewiarza', 'knitter_notes', v.knitter_notes || '', { multiline: true })}<p class="muted">Polecenia do konkretnego uruchomienia, np. 10 belek po 150 m, wpiszesz osobno przy wydaniu karty.</p></section>
<div class="savebar"><span>Utworzenie wpisu: ${datepl(r.created_at)} · rewizja ${r.revision}</span>${button('Zapisz zmiany', 'primary')}</div></form>`;
  return layout({ user, csrf, flashes, title: 'Uzupełnij dane · Marand', body: `<a class="breadcrumb" href="/records/${r.id}">← Wróć do wpisu</a><div class="pagehead"><div><span class="eyebrow">${r.kind === 'trial' ? 'PRÓBA' : 'SPECYFIKACJA ROBOCZA'}</span><h1>Uzupełnij dane</h1><p class="muted">Możesz zapisać niepełny wpis i wrócić do niego później.</p></div></div>${form}` });
}
function recordPage({ user, csrf, flashes, r, v, history, photoPanel = '' }) {
  const canEdit = ['technologist', 'approver', 'admin'].includes(user.role);
  const canApprove = ['approver', 'admin'].includes(user.role);
  const tech = TECH.map(([k, label]) => `<div><span>${esc(label)}</span><strong>${esc((v.tech || {})[k] || '—')}</strong></div>`).join('');
  const gbTable = v.gb.length ? v.gb.map(row => `<tr>${GB.map(([k]) => `<td class="preline">${esc(row[k] || '')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${GB.length}">Brak danych GB.</td></tr>`;
  const raw = RAW_METRICS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc((v.raw || {})[k] || '—')}</dd>`).join('');
  const targets = TARGET_METRICS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc((v.targets || {})[k] || '—')}</dd>`).join('');
  const finishes = v.finished.length ? `<section class="panel padded"><h2>Warianty wykończenia / wyniki</h2>${v.finished.map((f, i) => `<h3>${esc(f.name || `Wariant ${i + 1}`)}</h3><p>Gramatura: ${esc(f.weight || '—')} g/m² · Szerokość: ${esc(f.width || '—')} cm · Pk: ${esc(f.pk || '—')} · Pr: ${esc(f.pr || '—')} · Dystans: ${esc(f.thickness || '—')}</p><p class="preline">${esc(f.finish || '')} ${esc(f.comments || '')}</p>`).join('')}</section>` : '';
  const actionButtons = `${canEdit && r.state === 'draft' ? link(`/records/${r.id}/edit`, 'Edytuj / uzupełnij', 'button primary') : ''}${link(`/records/${r.id}/preview`, 'Podgląd wydruku', 'button')}${canEdit && r.active_spec === r.id ? link(`/records/${r.id}/issue`, 'Wydaj kartę na maszynę', 'button primary') : ''}`;
  const copyActions = canEdit ? `<div class="actions space">${r.project_id ? csrfForm(csrf, `/records/${r.id}/copy`, `${hidden('kind', 'trial')}${button('Kontynuuj jako nową próbę')}`) : ''}${csrfForm(csrf, `/records/${r.id}/copy`, `${hidden('kind', 'spec')}${button(r.kind === 'spec' ? 'Nowa wersja specyfikacji' : 'Przygotuj specyfikację z próby')}`)}</div>` : '';
  const submit = canEdit && r.kind === 'spec' && r.state === 'draft' ? `<section class="panel padded"><h2>Przekaż do zatwierdzenia</h2><p>Uzupełnij ustawienia maszyny i używane GB. Parametry dzianiny wykończonej są opcjonalne. Po przekazaniu edycja zostaje zablokowana.</p>${csrfForm(csrf, `/records/${r.id}/submit`, `${hidden('revision', r.revision)}${button('Przekaż do zatwierdzenia', 'primary')}`)}</section>` : '';
  let review = '';
  if (r.state === 'submitted') {
    const approve = canApprove ? csrfForm(csrf, `/records/${r.id}/approve`, `${hidden('revision', r.revision)}${field('Uzasadnienie / rozstrzygnięcie rozbieżności', 'review_note', '', { multiline: true, required: 'required', minlength: 10, placeholder: 'Co sprawdzono i którą wersję danych przyjęto?' })}<label class="check"><input type="checkbox" name="checked" required>Sprawdzono dane i rozbieżności ze źródłami. Zatwierdzam do stosowania od teraz.</label>${button('Zatwierdź jako obowiązującą', 'primary')}`) : '';
    const withdraw = canEdit ? csrfForm(csrf, `/records/${r.id}/withdraw`, `${hidden('revision', r.revision)}${button('Wycofaj do poprawy')}`, 'space') : '';
    review = `<section class="panel padded"><h2>Zatwierdzenie specyfikacji</h2>${r.conflict ? `<p class="notice warning">${esc(r.conflict)}</p>` : ''}${approve}${withdraw}</section>`;
  }
  const sources = v.sources.length ? v.sources.map(s => `<p><a href="/sources/${encodeURIComponent(s.file)}">${esc(s.name)}</a></p>`).join('') : '<p>Wpis utworzony w programie.</p>';
  const audit = history.map(a => `<div class="history"><strong>${esc(a.action)}</strong> · ${esc(a.author || 'Import')} · ${datepl(a.at)}<details><summary>Szczegóły</summary><pre>${esc(a.detail)}</pre></details></div>`).join('');
  return layout({ user, csrf, flashes, title: `${r.symbol} · Marand`, body: `<a class="breadcrumb" href="${r.article_id ? `/articles/${r.article_id}` : `/projects/${r.project_id}`}">← ${esc(r.article_id ? r.symbol : r.project_name)}</a><div class="pagehead"><div><span class="eyebrow">${r.kind === 'trial' ? 'PRÓBA / WARIANT' : 'WARUNKI DZIANIA'}</span><h1>${esc(r.symbol)}</h1><span class="badge ${esc(r.state)}">${esc(STATE[r.state])}${r.version ? ` · wersja ${r.version}` : ''}</span> ${r.number ? `<span class="muted">Próba ${esc(r.number)}</span>` : ''}</div><div class="actions">${actionButtons}</div></div>
<div class="metadata"><span>Data źródłowa: <b>${esc(v.date || 'niepodana')}</b></span><span>Utworzono w bazie: ${datepl(r.created_at)}</span><span>Aktualizacja: ${datepl(r.updated_at)}</span>${r.base_id ? `<a href="/records/${r.base_id}">Wpis bazowy #${r.base_id}</a>` : ''}</div>
${r.state === 'approved' ? `<div class="notice success"><strong>${r.active_spec === r.id ? 'Obowiązująca specyfikacja' : 'Historyczna zatwierdzona specyfikacja'}</strong> · zatwierdzono ${datepl(r.approved_at)}<p>${esc(r.review_note)}</p></div>` : ''}${v.source_note ? `<div class="notice warning">${esc(v.source_note)}</div>` : ''}
<div class="panel padded"><h2>Opis i przeznaczenie</h2><p><strong>Klient:</strong> ${esc(v.client || '—')}</p><p class="preline">${esc(v.description || 'Brak opisu.')}</p><div class="metric-grid">${tech}</div></div>
<div class="sectionhead"><h2>Ustawienia GB</h2></div><div class="panel scroll"><table class="listing compact"><thead><tr>${GB.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${gbTable}</tbody></table></div>
<div class="two-col"><section class="panel padded"><h2>Parametry dzianiny surowej</h2><dl>${raw}</dl><p class="preline">${esc(v.raw_comments || '')}</p></section><section class="panel padded"><h2>Parametry dzianiny wykończonej</h2><p class="muted small">Dane opcjonalne.</p><dl>${targets}</dl></section></div>${finishes}
<section class="panel padded"><h2>Etapy prób i komentarze</h2><p class="preline">${esc(v.stages || '—')}</p><p class="preline">${esc(v.comments || '')}</p><h3>Stałe uwagi dla dziewiarza</h3><p class="preline">${esc(v.knitter_notes || '—')}</p></section>${photoPanel}${copyActions}${submit}${review}
<details class="panel padded"><summary>Pliki źródłowe (${v.sources.length})</summary>${sources}</details><details class="panel padded"><summary>Historia zmian</summary>${audit}</details>` });
}
function issuePage({ user, csrf, flashes, r, token }) {
  return layout({ user, csrf, flashes, title: 'Wydaj kartę · Marand', body: `<a class="breadcrumb" href="/records/${r.id}">← ${esc(r.symbol)}</a><div class="pagehead"><div><span class="eyebrow">KARTA NA MASZYNĘ</span><h1>Instrukcje do tej produkcji</h1><p class="muted">${esc(r.symbol)} · zatwierdzona specyfikacja v${r.version}</p></div></div>${csrfForm(csrf, `/records/${r.id}/issue`, `${hidden('token', token)}${field('Numer / oznaczenie maszyny', 'machine', '', { required: 'required', maxlength: 100, placeholder: 'Np. HKS4 — maszyna 12' })}${field('Polecenia na to uruchomienie', 'instructions', '', { multiline: true, required: 'required', maxlength: 6000, placeholder: 'Np. wykonać 10 belek po 150 m, pozostałe po 100 m. Uwagi do pakowania…', className: 'tall' })}<p>Powstanie jedna karta z warunkami dziania i powyższymi poleceniami. Wydana treść zostanie zachowana bez możliwości nadpisania. Polecenia nie zmieniają stałej specyfikacji.</p>${button('Zapisz i otwórz kartę do druku', 'primary')}`, 'panel padded', '_blank')}` });
}
function cardPage({ r, v, machine, instructions, cardno, issuedAt, author, logo, printcss, changeNotice = '' }) {
  const th = (items, cls = '') => `<table${cls ? ` class="${cls}"` : ''}><thead><tr>${items.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody><tr>${items.map(([k]) => `<td>${esc((v.tech || {})[k] || '—')}</td>`).join('')}</tr></tbody></table>`;
  const targetHeaders = `<table><thead><tr>${TARGET_METRICS.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody><tr>${TARGET_METRICS.map(([k]) => `<td>${esc((v.targets || {})[k] || '—')}</td>`).join('')}</tr></tbody></table>`;
  const yarnRows = (v.gb || []).map(row => `<tr>${['number', 'pattern', 'yarn', 'threads', 'run_in', 'threading'].map(k => `<td>${esc(row[k] || '')}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.symbol)} — karta ${esc(cardno || 'podgląd')}</title><style>${printcss}</style><script defer src="/static/app.js"></script></head><body><div class="toolbar"><button data-print>Drukuj / zapisz jako PDF</button><span>${cardno ? 'Wydana karta — zachowany egzemplarz' : 'Podgląd roboczy — nie jest kartą wydaną na produkcję'}</span></div>${changeNotice}<article class="sheet"><header><div class="logo"><img src="data:image/jpeg;base64,${logo}" alt="Marand"></div><div><div class="title">WARUNKI DZIANIA · KARTA NA MASZYNĘ</div><h1>${esc(r.symbol)}</h1></div></header>${!cardno ? '<div class="draft">PODGLĄD ROBOCZY — NIE DO PRODUKCJI</div>' : ''}<div class="identity">Maszyna: <b>${esc(machine)}</b> · Specyfikacja: <b>${r.version ? `v${r.version}` : 'niezatwierdzona'}</b> · Wydanie: ${datepl(issuedAt)}<br>Karta: ${esc(cardno || 'niewydana')} · Wydał(a): ${esc(author)}</div>
${th(TECH.slice(0, 5))}<h2>Parametry dzianiny wykończonej (opcjonalnie)</h2>${targetHeaders}<h2>Parametry dzianiny surowej</h2><table><thead><tr>${RAW_METRICS.map(([,label])=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody><tr>${RAW_METRICS.map(([k])=>`<td>${esc(v.raw?.[k] || '—')}</td>`).join('')}</tr></tbody></table>${v.raw_comments ? `<div class="notes">${esc(v.raw_comments)}</div>` : ''}<h2>GB — raport ogniw, przędze i nawleczenie</h2><table class="gb"><thead><tr><th>GB</th><th>Raport ogniw wzorujących</th><th>Rodzaj przędzy</th><th>Liczba nici</th><th>Wrobienie (mm/rack)</th><th>Nawleczenie</th></tr></thead><tbody>${yarnRows}</tbody></table>
<div class="production"><section><h2>Parametry dziania</h2><table><tr><th>Domyślna długość belki</th><td>${esc(v.tech.roll_length || '—')} m</td></tr><tr><th>Prędkość</th><td>${esc(v.tech.speed || '—')}</td></tr><tr><th>Ustawienie dystansu</th><td>${esc(v.tech.distance || '—')}</td></tr></table></section><section><h2>Polecenia do tej produkcji</h2><div class="instructions">${esc(instructions)}</div></section></div><h2>Stałe uwagi dla dziewiarza</h2><div class="notes">${esc(v.knitter_notes || '—')}</div><table class="signatures"><tr><th>Podpis dziewiarza</th><td>1.</td><td>2.</td><td>3.</td></tr></table><h2>Notatki od dziewiarza</h2><div class="handnotes"></div><footer>Marand · ${esc(r.symbol)} · ${esc(cardno || 'Podgląd roboczy')} · Specyfikacja ${r.version || 'robocza'}</footer></article></body></html>`;
}
function updatePage({ user, csrf, flashes, current, latest, status, repo, canUpdate, updateAvailable, updateError }) {
  let latestInfo = latest ? `<p>Najnowsze wydanie: <strong>${esc(latest.tag_name)}</strong>${latest.name ? ` · ${esc(latest.name)}` : ''}</p>` : '<p>Nie sprawdzono jeszcze wydań.</p>';
  const statusInfo = status ? `<div class="notice ${status.ok ? 'success' : 'warning'}">${status.ok ? `Ostatnia aktualizacja zakończyła się powodzeniem: ${esc(status.version || '')} · ${datepl(status.at)}` : `Ostatnia aktualizacja nie powiodła się: ${esc(status.error || 'sprawdź log aktualizacji')}`}</div>` : '';
  const updateForm = !canUpdate
    ? `<div class="notice warning">Aktualizator nie jest skonfigurowany. Uruchom ponownie instalator Windows.</div>`
    : updateAvailable
      ? csrfForm(csrf, '/admin/update', button('Pobierz i zainstaluj aktualizację z GitHub', 'primary'))
      : latest
        ? '<div class="notice success">Masz już najnowszą wersję.</div>'
        : '<div class="notice">Aktualizacja pojawi się tutaj po opublikowaniu wydania na GitHub.</div>';
  return layout({ user, csrf, flashes, title: 'Aktualizacje · Marand', body: `<a class="breadcrumb" href="/">← Artykuły i projekty</a><div class="pagehead"><div><span class="eyebrow">ADMINISTRACJA</span><h1>Aktualizacje programu</h1><p class="muted">Wersja zainstalowana: ${esc(current)}</p></div></div><div class="panel padded"><h2>Źródło aktualizacji</h2><p>${repo ? `Repozytorium GitHub: <strong>${esc(repo)}</strong>` : 'Repozytorium GitHub nie jest skonfigurowane.'}</p>${latestInfo}${updateError ? `<div class="notice warning">${esc(updateError)}</div>` : ''}${statusInfo}${updateForm}<p class="muted small">Po każdym wypchnięciu zmian na main GitHub przygotowuje wydanie. Aktualizacja sprawdza sumy SHA-256, wykonuje kopię bazy i w razie problemu przywraca poprzedni program. Dane pozostają osobno.</p></div>` });
}

module.exports = { TECH, RAW_METRICS, TARGET_METRICS, GB, FINISH, STATE, esc, datepl, layout, errorPage, loginPage, homePage, projectPage, editPage, recordPage, issuePage, cardPage, updatePage };
