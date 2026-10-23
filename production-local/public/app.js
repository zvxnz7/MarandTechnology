'use strict';

const $ = selector => document.querySelector(selector);
const state = { data: null, editingId: null, catalogArticles: [], catalogWorkers: [], activeNumeric: null, settingsToken: null, settingsSetup: false };
const number = value => {
  const source = String(value ?? '').trim().replace(',', '.');
  return source === '' ? 0 : Number(source);
};
const fmt = value => Number(value || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFmt = value => {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
};
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function toast(message, error = false) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 5200);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Błąd ${response.status}.`), { status: response.status });
  return data;
}
function options(items, valueKey, labelFn, selected) {
  return items.map(item => `<option value="${escapeHtml(item[valueKey])}" ${String(item[valueKey]) === String(selected) ? 'selected' : ''}>${escapeHtml(labelFn(item))}</option>`).join('');
}
function articleLabel(item) { return item.symbol; }
function workerLabel(worker) { return worker.code ? `${worker.code} · ${worker.name}` : worker.name; }
function fillCommonControls() {
  const oldArticle = $('#article').value;
  const oldMachine = $('#machine').value;
  const articles = state.data.articles;
  $('#article').innerHTML = `<option value="">Wybierz artykuł</option>${options(articles, 'id', articleLabel, oldArticle)}`;
  if (oldArticle) $('#article').value = oldArticle;
  else if (articles.length === 1) $('#article').value = String(articles[0].id);
  $('#machine').innerHTML = `<option value="">Wybierz maszynę</option>${state.data.machines.map(machine => `<option value="${machine}" ${machine === oldMachine ? 'selected' : ''}>${machine}</option>`).join('')}`;
  if (!$('#production-date').value) $('#production-date').value = state.data.today;
  $('#setup-notice').hidden = articles.length > 0 && state.data.workers.length > 0;
  fillWorkerControls($('#worker-primary').value);
  updateSequenceWarning();
}
function fillWorkerControls(selected = '') {
  const workers = state.data.workers;
  $('#worker-primary').innerHTML = `<option value="">Wybierz dziewiarza</option>${options(workers, 'id', workerLabel, selected)}`;
  if (selected) $('#worker-primary').value = String(selected);
  else if (workers.length === 1) $('#worker-primary').value = String(workers[0].id);
  updateShareSummary();
}
function workerSelect(selected = '') {
  return `<select class="extra-worker-id" aria-label="Dodatkowy dziewiarz"><option value="">Wybierz osobę</option>${options(state.data.workers, 'id', workerLabel, selected)}</select>`;
}
function addExtraWorkerRow(value = {}) {
  const row = document.createElement('div');
  row.className = 'extra-worker-row';
  row.innerHTML = `${workerSelect(value.workerId)}<input class="extra-worker-meters" type="text" inputmode="none" data-numeric="decimal" aria-label="Metry dodatkowego dziewiarza" placeholder="metry" value="${escapeHtml(value.meters ?? '')}" required><button type="button" class="remove-extra-worker" aria-label="Usuń osobę">×</button>`;
  $('#extra-workers').append(row);
  row.querySelector('.remove-extra-worker').addEventListener('click', () => { row.remove(); updateShareSummary(); });
  row.addEventListener('input', updateShareSummary);
  row.addEventListener('change', updateShareSummary);
  return row;
}
function updateShareSummary() {
  if (!$('#share-summary')) return;
  const total = number($('#meters')?.value);
  const primaryId = $('#worker-primary')?.value;
  const rows = [...$('#extra-workers').querySelectorAll('.extra-worker-row')];
  const extraMeters = rows.reduce((sum, row) => sum + number(row.querySelector('.extra-worker-meters').value), 0);
  const summary = $('#share-summary');
  summary.classList.remove('invalid');
  const primary = state.data.workers.find(worker => String(worker.id) === String(primaryId));
  const primaryLabel = primary ? workerLabel(primary) : 'głównego dziewiarza';
  if (!total || !primaryId) { summary.innerHTML = '<strong>Udział głównego dziewiarza:</strong> — m'; return; }
  if (!rows.length) { summary.innerHTML = `<strong>Udział ${escapeHtml(primaryLabel)}:</strong> ${fmt(total)} m`; return; }
  const remainder = Math.round((total - extraMeters) * 100) / 100;
  if (rows.some(row => !row.querySelector('.extra-worker-id').value || number(row.querySelector('.extra-worker-meters').value) <= 0) || remainder <= 0) {
    const remainderLabel = remainder > 0 ? `${fmt(remainder)} m` : '— m';
    summary.innerHTML = `<strong>Udział ${escapeHtml(primaryLabel)}:</strong> ${remainderLabel} · sprawdź podział dodatkowych osób`;
    summary.classList.add('invalid');
    return;
  }
  summary.innerHTML = `<strong>Udział ${escapeHtml(primaryLabel)}:</strong> ${fmt(remainder)} m`;
}
function updateSequenceWarning() {
  if (!state.data) return;
  const date = $('#production-date').value || state.data.today;
  const year = String(date).slice(0, 4);
  const machine = $('#machine').value;
  const configured = Boolean(machine && state.data.sequences?.[year]?.[machine] !== undefined);
  const notice = $('#sequence-warning');
  notice.hidden = configured;
  notice.textContent = machine
    ? `Przed wpisaniem belki ustaw licznik ${machine} na rok ${year} w Ustawieniach.`
    : 'Przed produkcją ustaw liczniki używanych maszyn w Ustawieniach.';
}
function resetBaleFields(repeat = null) {
  $('#weight-kg').value = repeat?.weightKg ?? '';
  $('#meters').value = repeat?.meters ?? '';
  $('#errors').value = '';
  $('#stops').value = repeat?.stops ?? '';
  $('#notes').value = repeat?.notes ?? '';
  $('#extra-workers').replaceChildren();
  if (repeat) {
    for (const worker of repeat.extraWorkers || []) addExtraWorkerRow(worker);
  }
  updateShareSummary();
}
function setFreshForm(keepCommon = true, repeat = null) {
  const common = keepCommon ? {
    article: $('#article').value,
    machine: $('#machine').value,
    date: $('#production-date').value,
    worker: $('#worker-primary').value,
  } : {};
  $('#article').value = common.article || '';
  $('#machine').value = common.machine || '';
  $('#production-date').value = common.date || state.data.today;
  fillWorkerControls(repeat?.primaryWorkerId || common.worker || '');
  resetBaleFields(repeat);
  state.editingId = null;
  $('#save-bale').textContent = 'Zapisz belkę';
  $('#save-bale').disabled = false;
  $('#bale-form-title').textContent = 'Nowa belka';
  updateSequenceWarning();
}
function renderBales() {
  const tbody = $('#bale-list');
  if (!state.data.bales.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">Brak wpisów z ostatnich 30 dni.</td></tr>';
    return;
  }
  tbody.innerHTML = state.data.bales.map(row => `<tr>
    <td class="bale-number">${escapeHtml(row.number)}${row.sync_status === 'pending' ? `<br><button type="button" class="table-action edit-bale edit-bale-primary" data-id="${escapeHtml(row.id)}">Edytuj belkę</button>` : ''}</td><td>${escapeHtml(row.symbol)}</td><td>${dateFmt(row.production_date)}</td>
    <td>${fmt(row.weight_kg)}</td><td>${fmt(row.meters)}</td><td>${row.errors}</td><td>${row.stops}</td>
    <td>${row.workers.map(worker => `${escapeHtml(worker.code ? `${worker.code} · ${worker.name}` : worker.name)} · ${fmt(worker.meters)} m`).join('<br>')}</td>
    <td><span class="status ${row.needs_check ? 'flagged' : row.sync_status === 'synced' ? 'synced' : ''}">${row.needs_check ? 'Do sprawdzenia' : row.sync_status === 'synced' ? 'Wysłano' : 'Do synchronizacji'}</span></td>
    <td class="actions-cell">${row.sync_status === 'pending' ? `<button type="button" class="table-action copy-bale" data-id="${escapeHtml(row.id)}">Kopiuj belkę</button><button type="button" class="table-action review-bale" data-id="${escapeHtml(row.id)}" data-check="${row.needs_check ? '0' : '1'}">${row.needs_check ? 'Cofnij flagę' : 'Sprawdź'}</button><button type="button" class="table-action delete-bale" data-id="${escapeHtml(row.id)}" aria-label="Usuń belkę ${escapeHtml(row.number)}" title="Usuń błędnie wpisaną belkę">×</button>` : '—'}</td>
  </tr>`).join('');
  tbody.querySelectorAll('.edit-bale').forEach(button => button.addEventListener('click', () => startEdit(button.dataset.id)));
  tbody.querySelectorAll('.copy-bale').forEach(button => button.addEventListener('click', () => startCopy(button.dataset.id)));
  tbody.querySelectorAll('.review-bale').forEach(button => button.addEventListener('click', () => setReviewFlag(button.dataset.id, button.dataset.check === '1')));
  tbody.querySelectorAll('.delete-bale').forEach(button => button.addEventListener('click', () => deleteBale(button.dataset.id)));
}
function render(data) {
  state.data = data;
  fillCommonControls();
  $('#pending-pill').textContent = `${data.pending} ${data.pending === 1 ? 'belka' : 'belek'} w kolejce lokalnej`;
  $('#history-caption').textContent = `${data.bales.length} wpisów · ostatnie 30 dni`;
  renderBales();
}
async function refresh() {
  try {
    render(await api('/api/bootstrap'));
    $('#boot-error').hidden = true;
    $('#view-production').hidden = false;
    return true;
  } catch (error) {
    $('#boot-error').hidden = false;
    $('#view-production').hidden = true;
    $('#view-settings').hidden = true;
    toast(`Nie udało się połączyć z panelem lokalnym: ${error.message}`, true);
    return false;
  }
}
async function openSettingsGate() {
  try {
    const status = await api('/api/settings-auth/status');
    state.settingsSetup = !status.configured;
    $('#settings-auth-title').textContent = state.settingsSetup ? 'Ustaw hasło kierownika' : 'Odblokuj ustawienia';
    $('#settings-auth-description').textContent = state.settingsSetup
      ? 'To pierwsze uruchomienie ochrony. Ustal hasło, które będzie wymagane do zmian ustawień.'
      : 'Wpisz hasło kierownika, aby zmieniać artykuły, pracowników i liczniki.';
    $('#settings-password').value = '';
    $('#settings-password').autocomplete = state.settingsSetup ? 'new-password' : 'current-password';
    $('#settings-password-confirm-wrap').hidden = !state.settingsSetup;
    $('#settings-password-confirm').required = state.settingsSetup;
    $('#settings-password-confirm').value = '';
    $('#settings-auth-submit').textContent = state.settingsSetup ? 'Zapisz hasło i otwórz' : 'Odblokuj';
    $('#settings-auth-error').hidden = true;
    $('#settings-auth-modal').hidden = false;
    $('#settings-password').focus();
  } catch (error) {
    const message = error.status === 404
      ? 'Panel działa w starej wersji. Zamknij jego okno uruchomieniowe i uruchom ponownie START_DZIEWIARNIA.cmd.'
      : `Nie udało się sprawdzić dostępu do ustawień: ${error.message}`;
    toast(message, true);
  }
}
function showAuthError(message) {
  const element = $('#settings-auth-error');
  element.textContent = message;
  element.hidden = false;
}
async function authenticateSettings(event) {
  event.preventDefault();
  const password = $('#settings-password').value;
  if (password.length < 8) { showAuthError('Hasło musi mieć co najmniej 8 znaków.'); return; }
  if (state.settingsSetup && password !== $('#settings-password-confirm').value) { showAuthError('Wpisane hasła różnią się.'); return; }
  const button = $('#settings-auth-submit');
  button.disabled = true;
  try {
    const result = await api(state.settingsSetup ? '/api/settings-auth/setup' : '/api/settings-auth/unlock', {
      method: 'POST', body: JSON.stringify({ password }),
    });
    state.settingsToken = result.token;
    $('#settings-auth-modal').hidden = true;
    $('#view-production').hidden = true;
    $('#view-settings').hidden = false;
    document.querySelectorAll('.nav-button').forEach(item => item.classList.toggle('active', item.dataset.view === 'settings'));
    loadSettings();
  } catch (error) { showAuthError(error.message); }
  finally { button.disabled = false; }
}
function showView(name) {
  hideKeypad();
  if (name === 'settings' && !state.settingsToken) { openSettingsGate(); return; }
  if (name === 'production' && state.settingsToken) {
    const token = state.settingsToken;
    state.settingsToken = null;
    api('/api/settings-auth/lock', { method: 'POST', headers: { 'X-Settings-Token': token }, body: '{}' }).catch(() => {});
  }
  $('#view-production').hidden = name !== 'production';
  $('#view-settings').hidden = name !== 'settings';
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  if (name === 'settings') loadSettings();
}

async function loadSettings() {
  try {
    const data = await api('/api/settings', { headers: { 'X-Settings-Token': state.settingsToken || '' } });
    const connection = data.productionConnection || {};
    $('#production-server-url').value = connection.serverUrl || '';
    $('#production-api-token').value = '';
    $('#production-api-token').placeholder = connection.configured ? 'Token jest zapisany; wklej nowy tylko przy zmianie' : 'Wklej token wygenerowany na serwerze';
    $('#production-connection-status').textContent = connection.configured ? 'Połączenie z programem głównym jest skonfigurowane.' : 'Brak skonfigurowanego połączenia.';
  } catch (error) {
    if (/wygasła|ponownie hasło/i.test(error.message)) { state.settingsToken = null; $('#view-settings').hidden = true; openSettingsGate(); }
    toast(error.message, true);
  }
  state.catalogArticles = state.data.articles.map(item => ({ symbol: item.symbol, lot: item.lot || '' }));
  state.catalogWorkers = state.data.workers.map(item => ({ employee_uid: item.employee_uid, code: item.code, name: item.name }));
  $('#sequence-year').value = state.data.today.slice(0, 4);
  const yearSequences = state.data.sequences?.[$('#sequence-year').value] || {};
  $('#sequence-list').innerHTML = state.data.machines.map(machine => `<label class="sequence-item">${machine}<input class="sequence-value" data-machine="${machine}" type="number" min="0" max="99999999" step="1" inputmode="numeric" value="${yearSequences[machine] ?? ''}" placeholder="ostatni numer"></label>`).join('');
  renderCatalogs();
}
function renderCatalogs() {
  const articleList = $('#article-list');
  articleList.innerHTML = state.catalogArticles.length ? state.catalogArticles.map((item, index) => `<div class="catalog-row article-catalog-row"><strong>${escapeHtml(item.symbol)}</strong><label class="article-lot-label">LOT<input class="article-lot-input" data-index="${index}" maxlength="120" value="${escapeHtml(item.lot || '')}" placeholder="LOT artykułu"></label><button type="button" class="catalog-remove remove-article" data-index="${index}">Wyłącz</button></div>`).join('') : '<div class="catalog-empty">Brak aktywnych artykułów.</div>';
  articleList.querySelectorAll('.article-lot-input').forEach(input => input.addEventListener('input', () => {
    const item = state.catalogArticles[Number(input.dataset.index)];
    if (item) item.lot = input.value;
  }));
  articleList.querySelectorAll('.remove-article').forEach(button => button.addEventListener('click', () => {
    state.catalogArticles.splice(Number(button.dataset.index), 1);
    renderCatalogs();
  }));
  const workerList = $('#worker-list');
  workerList.innerHTML = state.catalogWorkers.length ? state.catalogWorkers.map((item, index) => `<div class="catalog-row"><div><strong>${escapeHtml(item.name)}</strong><small>${item.code ? `Oznaczenie: ${escapeHtml(item.code)} · ` : ''}ID: ${escapeHtml(item.employee_uid ? item.employee_uid.slice(0, 8) : 'utworzy się przy zapisie')}</small></div><button type="button" class="catalog-remove remove-worker-catalog" data-index="${index}">Wyłącz</button></div>`).join('') : '<div class="catalog-empty">Brak aktywnych pracowników.</div>';
  workerList.querySelectorAll('.remove-worker-catalog').forEach(button => button.addEventListener('click', () => {
    state.catalogWorkers.splice(Number(button.dataset.index), 1);
    renderCatalogs();
  }));
}
function renderSequenceList(year) {
  const yearSequences = state.data.sequences?.[year] || {};
  $('#sequence-list').innerHTML = state.data.machines.map(machine => `<label class="sequence-item">${machine}<input class="sequence-value" data-machine="${machine}" type="number" min="0" max="99999999" step="1" inputmode="numeric" value="${yearSequences[machine] ?? ''}" placeholder="ostatni numer"></label>`).join('');
}
function addArticle(event) {
  event.preventDefault();
  const symbol = $('#article-new').value.trim();
  if (!symbol) return;
  if (state.catalogArticles.some(item => item.symbol.toLocaleUpperCase('pl-PL') === symbol.toLocaleUpperCase('pl-PL'))) {
    toast('Ten artykuł jest już na liście.', true); return;
  }
  state.catalogArticles.push({ symbol, lot: $('#article-new-lot').value.trim() });
  $('#article-new').value = '';
  $('#article-new-lot').value = '';
  renderCatalogs();
  $('#article-new').focus();
}
function addWorker(event) {
  event.preventDefault();
  const name = $('#worker-new-name').value.trim();
  const code = $('#worker-new-code').value.trim();
  if (!name) return;
  if (state.catalogWorkers.some(item => item.name.toLocaleUpperCase('pl-PL') === name.toLocaleUpperCase('pl-PL') && item.code.toLocaleUpperCase('pl-PL') === code.toLocaleUpperCase('pl-PL'))) {
    toast('Ta osoba z takim oznaczeniem jest już na liście.', true); return;
  }
  state.catalogWorkers.push({ employee_uid: '', code, name });
  $('#worker-new-name').value = '';
  $('#worker-new-code').value = '';
  renderCatalogs();
  $('#worker-new-name').focus();
}
async function saveSettings() {
  try {
    const articles = state.catalogArticles.map(item => ({ symbol: item.symbol, lot: item.lot || '' }));
    const workers = state.catalogWorkers.map(item => ({ employeeUid: item.employee_uid || '', code: item.code || '', name: item.name }));
    const sequenceYear = Number($('#sequence-year').value);
    const sequences = [...$('#sequence-list').querySelectorAll('.sequence-value')]
      .filter(input => input.value !== '')
      .map(input => ({ machine: input.dataset.machine, lastValue: Number(input.value) }));
    const productionServerUrl = $('#production-server-url').value.trim();
    const productionApiToken = $('#production-api-token').value.trim();
    const data = await api('/api/settings', { method: 'POST', headers: { 'X-Settings-Token': state.settingsToken || '' }, body: JSON.stringify({ articles, workers, sequenceYear, sequences, productionServerUrl, productionApiToken }) });
    render(data);
    $('#production-api-token').value = '';
    $('#production-connection-status').textContent = productionServerUrl ? 'Zapisano adres serwera. Token jest przechowywany lokalnie.' : 'Brak skonfigurowanego połączenia.';
    toast('Zapisano listy i liczniki.');
    showView('production');
  } catch (error) { if (/wygasła|ponownie hasło/i.test(error.message)) { state.settingsToken = null; $('#view-settings').hidden = true; openSettingsGate(); } toast(error.message, true); }
}

async function syncProduction() {
  const button = $('#sync-production');
  button.disabled = true;
  $('#sync-production-status').textContent = 'Wysyłam produkcję do programu głównego…';
  try {
    const result = await api('/api/sync', { method: 'POST', headers: { 'X-Settings-Token': state.settingsToken || '' }, body: '{}' });
    render(result.bootstrap);
    const snapshot = result.snapshot;
    const other = result.otherPending ? ` Pozostało ${result.otherPending} belek innych artykułów; w tej wersji wysyłany jest tylko WT 56-21 (5).` : '';
    const summary = `Wysłano ${result.uploaded} belek. Stan WT 56-21 (5): ${snapshot.pieces} szt., ${fmt(snapshot.weightKg)} kg · ${dateFmt(snapshot.date)}.${other}`;
    $('#sync-production-status').textContent = summary;
    toast(summary);
  } catch (error) {
    $('#sync-production-status').textContent = error.message;
    toast(error.message, true);
  } finally { button.disabled = false; }
}

async function changeManagerPassword(event) {
  event.preventDefault();
  const currentPassword = $('#current-manager-password').value;
  const newPassword = $('#new-manager-password').value;
  if (newPassword !== $('#confirm-manager-password').value) { toast('Nowe hasła różnią się.', true); return; }
  try {
    const result = await api('/api/settings-auth/change-password', { method: 'POST', headers: { 'X-Settings-Token': state.settingsToken || '' }, body: JSON.stringify({ currentPassword, newPassword }) });
    state.settingsToken = result.token;
    $('#change-password-form').reset();
    toast('Zmieniono hasło kierownika.');
  } catch (error) {
    if (/wygasła|ponownie hasło/i.test(error.message)) { state.settingsToken = null; $('#view-settings').hidden = true; openSettingsGate(); }
    toast(error.message, true);
  }
}

function collectBale() {
  const meters = number($('#meters').value);
  const primaryId = Number($('#worker-primary').value);
  if (!primaryId) throw new Error('Wybierz dziewiarza.');
  const extraRows = [...$('#extra-workers').querySelectorAll('.extra-worker-row')];
  const extras = extraRows.map(row => ({
    workerId: Number(row.querySelector('.extra-worker-id').value),
    meters: number(row.querySelector('.extra-worker-meters').value),
  }));
  if (extras.some(item => !item.workerId || item.meters <= 0)) throw new Error('Uzupełnij dziewiarza i metry każdej dodatkowej osoby.');
  if (extras.some(item => item.workerId === primaryId) || new Set(extras.map(item => item.workerId)).size !== extras.length) {
    throw new Error('Każdego dziewiarza wybierz tylko raz.');
  }
  const remainder = Math.round((meters - extras.reduce((sum, item) => sum + item.meters, 0)) * 100) / 100;
  if (remainder <= 0) throw new Error('Dodatkowe metry muszą zostawić część dla wybranego dziewiarza.');
  return {
    weightKg: number($('#weight-kg').value),
    meters,
    errors: number($('#errors').value || 0),
    stops: number($('#stops').value || 0),
    notes: $('#notes').value,
    primaryWorkerId: String(primaryId),
    workers: [{ workerId: primaryId, meters: remainder }, ...extras],
    extraWorkers: extras,
  };
}
async function saveProduction(event) {
  event.preventDefault();
  if (!state.data.articles.length || !state.data.workers.length) { toast('Najpierw dodaj artykuły i pracowników w Ustawieniach.', true); return; }
  const common = { articleId: $('#article').value, machine: $('#machine').value, productionDate: $('#production-date').value };
  const year = String(common.productionDate).slice(0, 4);
  if (state.data.sequences?.[year]?.[common.machine] === undefined) { updateSequenceWarning(); toast('Najpierw ustaw ostatni użyty numer tej maszyny i roku w Ustawieniach.', true); return; }
  let bale;
  try { bale = collectBale(); }
  catch (error) { toast(error.message, true); return; }
  if (!$('#production-form').reportValidity()) return;
  const repeat = !state.editingId && $('#repeat-next').checked ? { ...bale } : null;
  $('#save-bale').disabled = true;
  hideKeypad();
  try {
    if (state.editingId) {
      await api(`/api/bales/${encodeURIComponent(state.editingId)}`, { method: 'POST', body: JSON.stringify({ ...common, ...bale }) });
      toast('Poprawiony wpis zapisano lokalnie.');
    } else {
      const result = await api('/api/bales', { method: 'POST', body: JSON.stringify({ ...common, bales: [bale] }) });
      toast(`Zapisano belkę ${result.created[0].number}.`);
    }
    const data = await api('/api/bootstrap');
    render(data);
    setFreshForm(true, repeat);
    if (repeat) $('#errors').focus();
  } catch (error) { toast(error.message, true); }
  finally { $('#save-bale').disabled = false; }
}
function startEdit(id) {
  const row = state.data.bales.find(item => item.id === id);
  if (!row || row.sync_status !== 'pending') { toast('Można poprawiać tylko wpisy oczekujące na synchronizację.', true); return; }
  showView('production');
  if (!state.data.articles.some(item => Number(item.id) === Number(row.article_id))) {
    state.data.articles.push({ id: row.article_id, symbol: row.symbol, lot: row.lot || '' });
    fillCommonControls();
  }
  for (const worker of row.workers) {
    if (!state.data.workers.some(item => Number(item.id) === Number(worker.workerId))) {
      state.data.workers.push({ id: worker.workerId, employee_uid: worker.employeeUid || '', code: worker.code || '', name: worker.name });
    }
  }
  $('#article').value = String(row.article_id);
  $('#machine').value = row.machine;
  $('#production-date').value = row.production_date;
  const contributions = [...row.workers].sort((a, b) => b.meters - a.meters);
  const primary = contributions[0];
  fillWorkerControls(String(primary?.workerId || ''));
  const repeat = {
    weightKg: row.weight_kg, meters: row.meters, stops: row.stops, notes: row.notes,
    extraWorkers: contributions.slice(1).map(worker => ({ workerId: worker.workerId, meters: worker.meters })),
  };
  resetBaleFields(repeat);
  $('#errors').value = String(row.errors);
  $('#repeat-next').checked = false;
  state.editingId = row.id;
  $('#save-bale').textContent = 'Zapisz poprawkę';
  $('#bale-form-title').textContent = 'Poprawa belki';
  updateSequenceWarning();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function startCopy(id) {
  const row = state.data.bales.find(item => item.id === id);
  if (!row) { toast('Nie znaleziono belki do skopiowania.', true); return; }
  if (!state.data.articles.some(item => Number(item.id) === Number(row.article_id))) {
    toast('Artykuł z tej belki jest wyłączony. Włącz go w Ustawieniach, aby skopiować wpis.', true);
    return;
  }
  if (row.workers.some(item => !state.data.workers.some(worker => Number(worker.id) === Number(item.workerId)))) {
    toast('Jeden z dziewiarzy z tej belki jest wyłączony. Włącz go w Ustawieniach, aby zachować podział pracy przy kopiowaniu.', true);
    return;
  }
  showView('production');
  $('#article').value = String(row.article_id);
  $('#machine').value = row.machine;
  $('#production-date').value = row.production_date;
  const contributions = [...row.workers].sort((a, b) => b.meters - a.meters);
  const primary = contributions[0];
  fillWorkerControls(String(primary?.workerId || ''));
  resetBaleFields({
    weightKg: row.weight_kg,
    meters: row.meters,
    stops: row.stops,
    notes: row.notes,
    extraWorkers: contributions.slice(1).map(worker => ({ workerId: worker.workerId, meters: worker.meters })),
  });
  $('#errors').value = '';
  $('#repeat-next').checked = false;
  state.editingId = null;
  $('#save-bale').textContent = 'Zapisz skopiowaną belkę';
  $('#bale-form-title').textContent = `Kopia belki ${row.number}`;
  $('#save-bale').disabled = false;
  updateSequenceWarning();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`Skopiowano dane belki ${row.number} i dziewiarza. Błędy wyzerowano; nowa belka otrzyma własny numer.`);
  $('#errors').focus();
}
async function setReviewFlag(id, needsCheck) {
  try { render(await api(`/api/bales/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ needsCheck }) })); toast(needsCheck ? 'Oznaczono wpis do sprawdzenia.' : 'Usunięto oznaczenie.'); }
  catch (error) { toast(error.message, true); }
}
async function deleteBale(id) {
  const row = state.data.bales.find(item => item.id === id);
  if (!row) { toast('Nie znaleziono belki do usunięcia.', true); return; }
  if (row.sync_status !== 'pending') { toast('Wysłanej belki nie można usunąć w panelu lokalnym.', true); return; }
  if (!window.confirm(`Usunąć błędnie wpisaną belkę ${row.number}? Tej operacji nie można cofnąć.`)) return;
  try {
    render(await api(`/api/bales/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    toast(`Usunięto belkę ${row.number}.`);
  } catch (error) { toast(error.message, true); }
}

function showKeypad(input) {
  state.activeNumeric = input;
  $('#keypad-label').textContent = input.closest('label')?.textContent.trim().replace(/\s+/g, ' ') || 'Wpisz wartość';
  $('.decimal-key').hidden = input.dataset.numeric === 'integer';
  $('#numeric-keypad').hidden = false;
  document.body.classList.add('keypad-open');
}
function hideKeypad() {
  $('#numeric-keypad').hidden = true;
  document.body.classList.remove('keypad-open');
  state.activeNumeric = null;
}
function writeKey(key) {
  const input = state.activeNumeric;
  if (!input || !input.isConnected) return;
  const current = input.value;
  input.focus({ preventScroll: true });
  let start = input.selectionStart ?? current.length;
  let end = input.selectionEnd ?? current.length;
  let value;
  if (key === 'clear') {
    value = '';
    start = end = 0;
  } else if (key === 'backspace') {
    if (start === end && start > 0) start -= 1;
    value = current.slice(0, start) + current.slice(end);
    end = start;
  } else if (key === ',') {
    if (input.dataset.numeric === 'integer' || /[.,]/.test(current)) return;
    value = current.slice(0, start) + ',' + current.slice(end);
    start += 1;
    end = start;
  } else if (/^\d$/.test(key)) {
    value = current.slice(0, start) + key + current.slice(end);
    start += key.length;
    end = start;
  } else return;
  input.value = value;
  input.setSelectionRange(start, end);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function moveToNextField() {
  const current = state.activeNumeric || document.activeElement;
  const fields = [...$('#production-form').querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea, button[type="submit"]')]
    .filter(field => !field.disabled && field.getClientRects().length);
  const index = fields.indexOf(current);
  const next = index >= 0 ? fields[index + 1] : null;
  hideKeypad();
  if (next) next.focus();
  else $('#save-bale').focus();
}

$('#production-form').addEventListener('submit', saveProduction);
$('#article-add-form').addEventListener('submit', addArticle);
$('#worker-add-form').addEventListener('submit', addWorker);
$('#add-extra-worker').addEventListener('click', () => { addExtraWorkerRow(); updateShareSummary(); });
$('#save-settings').addEventListener('click', saveSettings);
$('#sync-production').addEventListener('click', syncProduction);
$('#settings-auth-form').addEventListener('submit', authenticateSettings);
$('#change-password-form').addEventListener('submit', changeManagerPassword);
$('#settings-auth-cancel').addEventListener('click', () => { $('#settings-auth-modal').hidden = true; showView('production'); });
$('#refresh').addEventListener('click', refresh);
$('#retry-startup').addEventListener('click', refresh);
$('#back-to-production').addEventListener('click', () => showView('production'));
$('#machine').addEventListener('change', updateSequenceWarning);
$('#production-date').addEventListener('change', updateSequenceWarning);
$('#worker-primary').addEventListener('change', updateShareSummary);
$('#meters').addEventListener('input', updateShareSummary);
$('#sequence-year').addEventListener('change', () => renderSequenceList($('#sequence-year').value));
document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
// Delegation also covers numeric fields added later (for example, extra worker shares).
document.addEventListener('focusin', event => {
  const input = event.target.closest?.('[data-numeric]');
  if (input) showKeypad(input);
  else if (event.target.closest?.('#production-form') && !$('#numeric-keypad').hidden) hideKeypad();
});
document.addEventListener('click', event => {
  const input = event.target.closest?.('[data-numeric]');
  if (input) showKeypad(input);
});
$('#numeric-keypad').querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => writeKey(button.dataset.key)));
$('#keypad-close').addEventListener('click', hideKeypad);
$('#keypad-enter').addEventListener('click', moveToNextField);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#numeric-keypad').hidden) hideKeypad();
  if (event.key === 'Enter' && event.target.matches?.('#production-form [data-numeric]')) {
    event.preventDefault();
    moveToNextField();
  }
});
refresh().then(loaded => { if (loaded) setFreshForm(false); });
