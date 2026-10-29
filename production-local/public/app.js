'use strict';

const $ = selector => document.querySelector(selector);
const state = { data: null, editingId: null, catalogArticles: [], catalogWorkers: [], activeNumeric: null, dailyReports: [], reportCache: new Map(), addToReportDate: null, touch: { step: 'home', articleId: '', machine: '', workerId: '', activeInput: null, currentPrompt: '', returnPrompt: '', workerPickerIndex: null, pickerCreatedIndex: -1, textShift: false, extras: [], saving: false, weightSuggestion: null, weightInfo: null, weightMode: 'calculated', weightWeighed: false, weightAutoValue: '', weightManuallyEdited: false, weightSuggestionsEnabled: true, weightSuggestionRequestId: 0 } };
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
function articleLabel(item) { const label = item.isTrial ? `${item.symbol} · Próba` : item.symbol; return item.machine ? `${label} · ${item.machine === '0' ? 'dziewiarz' : item.machine}` : label; }
function selectedArticleChoice() { return state.data?.articles.find(item => String(item.choiceId ?? item.id) === String($('#article')?.value)); }
function articleMachine(item) {
  return item?.machine || '';
}
function workerLabel(worker) { return worker.name; }
function fillCommonControls() {
  const oldArticle = $('#article').value;
  const oldMachine = $('#machine').value;
  const articles = state.data.articles;
  $('#article').innerHTML = `<option value="">Wybierz artykuł</option>${options(articles, 'choiceId', articleLabel, oldArticle)}`;
  if (oldArticle) $('#article').value = oldArticle;
  else if (articles.length === 1) $('#article').value = String(articles[0].choiceId ?? articles[0].id);
  $('#machine').innerHTML = `<option value="">—</option>${state.data.machines.map(machine => `<option value="${machine}" ${machine === oldMachine ? 'selected' : ''}>${machine}</option>`).join('')}`;
  const selected = selectedArticleChoice();
  $('#machine').value = selected?.machine ? articleMachine(selected) : '';
  $('#machine').disabled = true;
  if (!$('#production-date').value) $('#production-date').value = state.data.today;
  $('#setup-notice').hidden = articles.length > 0 && state.data.workers.length > 0;
  fillWorkerControls($('#worker-primary').value);
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
function resetBaleFields(prefill = null) {
  $('#weight-kg').value = prefill?.weightKg ?? '';
  $('#meters').value = prefill?.meters ?? '';
  $('#errors').value = '';
  $('#stops').value = '';
  $('#notes').value = prefill?.notes ?? '';
  $('#extra-workers').replaceChildren();
  if (prefill) {
    for (const worker of prefill.extraWorkers || []) addExtraWorkerRow(worker);
  }
  updateShareSummary();
}
function setFreshForm(keepCommon = true, prefill = null) {
  const common = keepCommon ? {
    article: $('#article').value,
    machine: $('#machine').value,
    date: $('#production-date').value,
    worker: $('#worker-primary').value,
  } : {};
  $('#article').value = common.article || '';
  $('#machine').value = common.machine || '';
  $('#production-date').value = common.date || state.data.today;
  fillWorkerControls(prefill?.primaryWorkerId || common.worker || '');
  resetBaleFields(prefill);
  state.editingId = null;
  $('#save-bale').textContent = 'Zapisz belkę';
  $('#save-bale').disabled = false;
  $('#bale-form-title').textContent = 'Wprowadź nową belkę do rejestru';
  $('#cancel-report-add').hidden = true;
}
function renderBales() {
  const tbody = $('#bale-list');
  if (!state.data.bales.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Brak belek na bieżącej liście. Belki przypisane do raportów są w zakładce Produkcja dzienna.</td></tr>';
    return;
  }
  const chronological = [...state.data.bales].sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const ordinals = new Map(chronological.map((row,index) => [row.id,index + 1]));
  tbody.innerHTML = state.data.bales.map(row => `<tr>
    <td>${ordinals.get(row.id)}</td><td class="bale-number">${escapeHtml(row.number)}${row.sync_status === 'pending' ? `<br><button type="button" class="table-action edit-bale edit-bale-primary" data-id="${escapeHtml(row.id)}">Edytuj belkę</button>` : ''}</td><td>${escapeHtml(row.symbol)}${row.trial_symbol ? '<small class="trial-bale-badge">Próba</small>' : ''}</td><td>${dateFmt(row.production_date)}</td>
    <td>${fmt(row.weight_kg)}${row.weight_source === 'calculated' ? '<small class="weight-calculated-badge">Waga wyliczona</small>' : ''}</td><td>${fmt(row.meters)}</td><td>${row.errors}</td><td>${row.stops}</td>
    <td>${row.workers.map(worker => `${escapeHtml(worker.name)} · ${fmt(worker.meters)} m`).join('<br>')}</td>
    <td><span class="status ${row.needs_check ? 'flagged' : row.sync_status === 'synced' ? 'synced' : ''}">${row.needs_check ? 'Błędny zapis' : row.sync_status === 'synced' ? 'Wysłano' : 'Do synchronizacji'}</span></td>
    <td class="actions-cell"><button type="button" class="table-action review-bale" data-id="${escapeHtml(row.id)}" data-check="${row.needs_check ? '0' : '1'}">${row.needs_check ? '✓ Błędny zapis' : 'Zgłoś błędny zapis'}</button>${row.sync_status === 'pending' ? `<button type="button" class="table-action delete-bale" data-id="${escapeHtml(row.id)}" aria-label="Usuń belkę ${escapeHtml(row.number)}" title="Usuń błędnie wpisaną belkę">×</button>` : ''}</td>
  </tr>`).join('');
  tbody.querySelectorAll('.edit-bale').forEach(button => button.addEventListener('click', () => startEdit(button.dataset.id)));
  tbody.querySelectorAll('.review-bale').forEach(button => button.addEventListener('click', () => setReviewFlag(button.dataset.id, button.dataset.check === '1')));
  tbody.querySelectorAll('.delete-bale').forEach(button => button.addEventListener('click', () => deleteBale(button.dataset.id)));
}
function render(data) {
  state.data = data;
  fillCommonControls();
  $('#copy-last-bale').disabled = !data.lastBale;
  $('#production-day-heading').textContent = `Produkcja dnia ${dateFmt(data.productionDay || data.today)}`;
  $('#pending-pill').textContent = `${data.pending} ${data.pending === 1 ? 'belka' : 'belek'} w kolejce lokalnej`;
  $('#history-caption').textContent = `${data.bales.length} belek w bieżącej produkcji · najnowsze na górze`;
  renderBales();
  paintTouch();
}
async function refresh() {
  try {
    render(await api('/api/bootstrap'));
    $('#boot-error').hidden = true;
    await loadDailyReports();
    return true;
  } catch (error) {
    $('#boot-error').hidden = false;
    $('#view-production').hidden = true;
    $('#view-daily-production').hidden = true;
    $('#view-settings').hidden = true;
    toast(`Nie udało się połączyć z panelem lokalnym: ${error.message}`, true);
    return false;
  }
}
function touchArticle() { return state.data?.articles.find(item => String(item.choiceId ?? item.id) === String(state.touch.articleId)); }
function touchWorker() { return state.data?.workers.find(item => String(item.id) === String(state.touch.workerId)); }
function touchReset() {
  const touch = state.touch;
  Object.assign(touch, { step: 'home', articleId: '', machine: '', workerId: '', activeInput: null, currentPrompt: '', returnPrompt: '', workerPickerIndex: null, pickerCreatedIndex: -1, textShift: false, extras: [], saving: false, weightSuggestion: null, weightInfo: null, weightMode: 'calculated', weightWeighed: false, weightAutoValue: '', weightManuallyEdited: false, weightSuggestionsEnabled: true, weightSuggestionRequestId: touch.weightSuggestionRequestId + 1 });
  $('#touch-date').value = state.data?.today || '';
  for (const id of ['meters', 'weight', 'weight-gross', 'tube-weight', 'errors', 'stops', 'notes']) $(`#touch-${id}`).value = '';
  $('#touch-weight').readOnly = false;
  $('#touch-confirm-error').hidden = true;
  $('#touch-confirm-error').textContent = '';
  paintTouch();
}
function renderTouchHome() {
  const bales = state.data?.recentBales || state.data?.bales || [];
  const latest = state.data?.lastBale || null;
  const allRows = [...new Map([...bales, ...(latest ? [latest] : [])].map(row => [row.id, row])).values()]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  const previous = allRows.filter(row => row.id !== latest?.id);
  const reviewableIds = new Set(allRows.slice(0, 3).map(row => row.id));
  $('#touch-accepted-count').textContent = `${allRows.length} ${allRows.length === 1 ? 'sztuka' : 'sztuk'}`;
  $('#touch-latest-bale').innerHTML = latest ? touchBaleCard(latest, true, reviewableIds.has(latest.id)) : '<p class="touch-empty">Nie ma jeszcze przyjętych sztuk.</p>';
  $('#touch-older-heading').hidden = !previous.length;
  $('#touch-accepted-list').innerHTML = previous.length ? previous.slice(0, 80).map(row => touchBaleCard(row, false, reviewableIds.has(row.id))).join('') : '';
}
function touchTimeFmt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'godzina niedostępna' : date.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function touchBaleCard(row, latest = false, reviewable = false) {
  const review = reviewable || row.needs_check
    ? `<button type="button" class="touch-review-button ${row.needs_check ? 'marked' : ''}" data-touch-review="${escapeHtml(row.id)}" data-check="${row.needs_check ? '0' : '1'}" ${row.sync_status === 'synced' ? 'title="Oznaczenie zostanie wysłane do programu głównego"' : ''}>${row.needs_check ? '✓ Zgłoszono błędny zapis' : 'Zgłoś błędny zapis'}</button>`
    : '<span class="touch-review-locked">Oznaczanie dostępne dla 3 ostatnich belek</span>';
  return `<article class="touch-accepted-card ${latest ? 'touch-latest-card' : ''} ${row.needs_check ? 'needs-check' : ''}"><div class="touch-bale-main">${latest ? '<span class="touch-latest-label">OSTATNIA PRZYJĘTA</span>' : ''}<strong>${escapeHtml(row.number)} <span>·</span> ${escapeHtml(row.symbol)}</strong><small>${escapeHtml(row.machine)} · ${dateFmt(row.production_date)} · przyjęto ${touchTimeFmt(row.created_at)}</small><small>${escapeHtml(row.workers.map(item => item.name).join(', '))}</small></div><span class="touch-accepted-metrics">${fmt(row.weight_kg)} kg${row.weight_source === 'calculated' ? '<small class="weight-calculated-badge">Waga wyliczona</small>' : ''}<br>${fmt(row.meters)} m</span><div class="touch-review-action">${review}</div></article>`;
}
function touchNextBaleNumber() {
  const machine = state.touch.machine;
  if (!machine) return '';
  const year = String($('#touch-date').value || state.data.today).slice(0, 4);
  const lastValue = state.data.sequences?.[year]?.[machine];
  return lastValue === undefined
    ? `Brak numeracji dla ${machine}/${year}`
    : `${machine}/${Number(lastValue) + 1}`;
}
function renderTouchSelectionSummary() {
  const { articleId, machine, workerId } = state.touch;
  const selections = [];
  if (articleId) selections.push({ text: `Artykuł: ${touchArticle()?.symbol || '—'}` });
  if (machine) selections.push({ text: `Maszyna: ${machine}` });
  if (workerId) selections.push({ text: `Dziewiarz: ${touchWorker()?.name || '—'}` });
  if (machine) selections.push({ text: `Przyjęcie belki: ${touchNextBaleNumber()}`, number: true });
  $('#touch-selection-summary').innerHTML = selections.map((item, index) => `<span class="touch-selection-chip ${item.number ? 'touch-bale-number-chip' : index === selections.length - 1 ? 'current' : ''}">${escapeHtml(item.text)}</span>`).join('');
}
function touchRenderTiles() {
  const { step, articleId, machine, workerId } = state.touch;
  $('#touch-article-tiles').innerHTML = state.data.articles.map(item => `<button type="button" class="touch-tile ${item.isTrial ? 'touch-tile-trial' : ''}" data-touch-article="${escapeHtml(item.choiceId ?? item.id)}">${escapeHtml(item.symbol)}${item.isTrial ? '<small>Próba · symbol artykułu</small>' : ''}<small>${item.machine ? `Maszyna ${escapeHtml(item.machine)}` : 'Przypisz maszynę w Ustawieniach'}</small></button>`).join('');
  $('#touch-machine-tiles').innerHTML = state.data.machines.map((item, index) => `<button type="button" class="touch-tile touch-machine-color-${index % 6}" data-touch-machine="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('');
  $('#touch-worker-tiles').innerHTML = state.data.workers.map(item => `<button type="button" class="touch-tile touch-worker-color-${touchColorIndex(item.name)}" data-touch-worker="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`).join('');
  for (const key of ['article', 'machine', 'worker', 'data', 'weight-check', 'options', 'confirm']) {
    const isDataStep = key === 'data' && ['data', 'weight'].includes(step);
    $(`#touch-step-${key}`).hidden = !(isDataStep || step === key);
  }
  $('#touch-home').hidden = step !== 'home';
  $('#touch-wizard').hidden = step === 'home';
  $('#touch-step-name').textContent = ({ article: '1 / 7', worker: '2 / 7', data: '3 / 7', 'weight-check': '4 / 7', weight: '5 / 7', options: '6 / 7', confirm: '7 / 7' })[step] || '';
  $('#touch-back').textContent = step === 'article' ? '← Do początku' : '← Cofnij';
  renderTouchSelectionSummary();
  $('#touch-data-title').textContent = `${touchArticle()?.symbol || 'Belka'}${touchArticle()?.isTrial ? ' · Próba' : ''} — wpisz dane`;
  if (step === 'data') renderTouchExtras();
  if (step === 'weight-check') renderTouchWeightCheck();
  if (step === 'options') renderTouchOptions();
  if (step === 'confirm') renderTouchConfirmation();
}
function renderTouchExtras() {
  const touch = state.touch;
  const host = $('#touch-extra-meter-fields');
  const enteringExtra = touch.returnPrompt === 'options' && touch.workerPickerIndex === null && touch.pickerCreatedIndex >= 0;
  host.hidden = !enteringExtra;
  if (!enteringExtra) { host.replaceChildren(); return; }
  const index = touch.pickerCreatedIndex;
  const item = touch.extras[index];
  if (!item) { host.replaceChildren(); return; }
  const worker = state.data.workers.find(entry => String(entry.id) === String(item.workerId));
  host.innerHTML = `<div class="touch-extra-meter-card"><strong>${escapeHtml(worker?.name || 'Dodatkowy dziewiarz')}</strong><label>Ile metrów dla tej osoby?<input type="text" inputmode="none" autocomplete="off" data-touch-numeric="decimal" data-touch-extra-meters="${index}" value="${escapeHtml(item.meters)}" placeholder="metry"></label></div>`;
}
function renderTouchWeightCheck() {
  const touch = state.touch, info = touch.weightInfo || {}, suggestion = info.suggestion || touch.weightSuggestion;
  const notice = $('#touch-weight-check-notice');
  const reminderDue = Number(info.reminderIn) > 0 && Number(info.reminderIn) <= 5;
  notice.hidden = !info.mustWeigh && !reminderDue;
  notice.textContent = info.weighReason === 'startup'
    ? `${info.startupWeighNumber === 'druga' ? 'Druga' : 'Pierwsza'} belka tego artykułu — sprawdź wagę rzeczywistą.`
    : info.weighReason === 'interval'
      ? `Sprawdź wagę rzeczywistą kolejnej belki — od ostatniego ważenia minęło ${info.balesSinceLastWeigh} belek.`
      : reminderDue ? `Uwaga: za ${info.reminderIn} ${info.reminderIn === 1 ? 'sztukę' : 'sztuki'} kontrola wagi — zważ tuleję.` : '';
  const last = info.lastWeighed;
  $('#touch-weight-check-history').innerHTML = last
    ? `Ostatnio zważona belka: <strong>${escapeHtml(last.symbol)} · ${escapeHtml(last.number)}</strong> · ${fmt(last.meters)} m · ${fmt(last.weight_kg)} kg · ${info.balesSinceLastWeigh === 0 ? 'ostatnia zważona belka' : `${info.balesSinceLastWeigh} ${info.balesSinceLastWeigh === 1 ? 'belkę' : 'belek'} temu`}.`
    : 'Brak zważonej belki w bieżącym miesiącu produkcji tego artykułu.';
  const calculateButton = $('[data-touch-weight-mode="calculated"]');
  calculateButton.disabled = Boolean(info.mustWeigh || !suggestion);
  for (const button of document.querySelectorAll('#touch-step-weight-check [data-touch-weight-mode]')) {
    const mode = button.dataset.touchWeightMode;
    button.classList.toggle('selected', touch.weightMode === mode);
    button.setAttribute('aria-pressed', String(touch.weightMode === mode));
  }
  $('#touch-weight-check-hint').textContent = suggestion
    ? `Waga wyliczana: ${fmt(suggestion.weight_kg)} kg na podstawie ${suggestion.referenceCount} ostatnich zważonych ${suggestion.referenceCount === 1 ? 'belki' : 'belek'} (${suggestion.number}).`
    : 'Brak zważonych belek do wyliczenia proporcji. Zważ tę belkę.';
  $('#touch-weight-check-continue').disabled = touch.weightMode === 'calculated' && (!suggestion || info.mustWeigh);
}
function renderTouchOptions() {
  const extras = state.touch.extras;
  const completed = extras.filter(item => item.workerId && number(item.meters) > 0);
  $('#touch-option-extra-status').textContent = completed.length
    ? `Dodano ${completed.length} ${completed.length === 1 ? 'dziewiarza' : 'dziewiarzy'}. Możesz dodać kolejną osobę.`
    : 'Jeśli przy belce pracowała dodatkowa osoba';
  const hasNotes = Boolean($('#touch-notes').value.trim());
  $('#touch-option-notes-title').textContent = hasNotes ? '✎ Edytuj opis' : '＋ Dodaj opis';
  $('#touch-option-notes-status').textContent = hasNotes ? 'Opis jest już dodany' : 'Możesz dodać opis lub uwagi';
  $('#touch-option-extra-list').innerHTML = completed.map((item, index) => {
    const actualIndex = extras.indexOf(item);
    const worker = state.data.workers.find(entry => String(entry.id) === String(item.workerId));
    return `<div class="touch-option-extra"><span>${escapeHtml(worker?.name || 'Dziewiarz')} · ${fmt(number(item.meters))} m</span><button type="button" data-touch-remove-extra="${actualIndex}" aria-label="Usuń dodatkowego dziewiarza">Usuń</button></div>`;
  }).join('');
}
function touchColorIndex(value) {
  return [...String(value || '')].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 7) % 8;
}
function renderTouchExtraPicker() {
  const index = state.touch.workerPickerIndex;
  const host = $('#touch-extra-worker-picker');
  host.hidden = index === null || index < 0 || index >= state.touch.extras.length;
  if (host.hidden) { host.replaceChildren(); return; }
  const chosen = new Set(state.touch.extras.filter((_, itemIndex) => itemIndex !== index).map(item => String(item.workerId)).filter(Boolean));
  chosen.add(String(state.touch.workerId));
  const available = state.data.workers.filter(worker => !chosen.has(String(worker.id)));
  host.innerHTML = `<strong>Wybierz dodatkowego dziewiarza</strong><div class="touch-extra-worker-tiles">${available.length ? available.map(worker => `<button type="button" class="touch-tile touch-worker-color-${touchColorIndex(worker.name)}" data-touch-extra-worker-tile="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</button>`).join('') : '<p class="touch-empty">Nie ma już innych dostępnych dziewiarzy.</p>'}</div><button type="button" class="touch-picker-cancel" data-touch-picker-cancel>Anuluj wybór</button>`;
}
function updateTouchShare() {
  if (state.touch.step === 'options') renderTouchOptions();
}
function paintTouch() {
  if (!state.data) return;
  renderTouchHome();
  touchRenderTiles();
  renderTouchExtraPicker();
  updateTouchKeyboardPanel();
  $('#touch-save').disabled = state.touch.saving;
}
function renderTouchConfirmation() {
  const touch = state.touch, article = touchArticle(), primary = touchWorker();
  const meters = number($('#touch-meters').value), extraTotal = touch.extras.reduce((sum, item) => sum + number(item.meters), 0);
  const primaryMeters = Math.round((meters - extraTotal) * 100) / 100;
  const workerLines = [`${primary?.name || '—'} · ${fmt(primaryMeters)} m`, ...touch.extras.map(item => {
    const worker = state.data.workers.find(entry => String(entry.id) === String(item.workerId));
    return `${worker?.name || 'Nie wybrano'} · ${fmt(number(item.meters))} m`;
  })];
  const rows = [
    ['Artykuł', article?.symbol || '—'], ['Maszyna', touch.machine || '—'],
    ['Data produkcji', dateFmt($('#touch-date').value)], ['Dziewiarze', workerLines.join('<br>')],
    ['Metry', `${fmt(meters)} m`], ['Waga', `${fmt(number($('#touch-weight').value))} kg${touch.weightMode === 'calculated' ? ' · Waga wyliczona' : ''}`],
    ['Błędy', $('#touch-errors').value.trim() || '—'], ['Stopy', $('#touch-stops').value.trim() || '—'],
    ['Opis / uwagi', $('#touch-notes').value.trim() || '—'],
  ];
  $('#touch-confirm-summary').innerHTML = rows.map(([label, value]) => `<div class="touch-confirm-row"><strong>${escapeHtml(label)}</strong><span>${label === 'Dziewiarze' ? value.split('<br>').map(escapeHtml).join('<br>') : escapeHtml(value)}</span></div>`).join('');
}
function updateTouchKeyboardPanel() {
  const touch = state.touch, active = touch.activeInput;
  const choosingWorker = !$('#touch-extra-worker-picker').hidden;
  const numeric = Boolean(active?.matches('[data-touch-numeric]'));
  const textEntry = Boolean(active && active.id === 'touch-notes');
  $('.touch-keyboard-panel').classList.toggle('worker-picker-open', choosingWorker);
  $('.touch-keyboard-panel').classList.toggle('numeric-keyboard-open', numeric && !choosingWorker);
  $('#touch-numeric-keyboard').hidden = choosingWorker || !numeric;
  $('#touch-text-keyboard-overlay').hidden = choosingWorker || !textEntry;
  $('#touch-keyboard-prompt').hidden = choosingWorker || !active || textEntry;
  $('#touch-keyboard-prompt').textContent = choosingWorker ? 'Wybierz dodatkowego dziewiarza' : touchPromptLabel(active);
  const activeValue = active?.value?.trim() || '';
  $('#touch-keyboard-value').hidden = choosingWorker || !numeric;
  $('#touch-keyboard-value').textContent = activeValue || '—';
  $('#touch-weight-suggestion').hidden = choosingWorker || active?.id !== 'touch-weight' || !touch.weightSuggestion;
  $('#touch-weight-suggestion').textContent = touch.weightSuggestion ? `Podpowiedź na podstawie belki ${touch.weightSuggestion.number} z ${dateFmt(touch.weightSuggestion.production_date)}.` : '';
  $('#touch-text-preview').textContent = $('#touch-notes').value.trim() || 'Wpisany opis pojawi się tutaj';
  $('#touch-next').hidden = choosingWorker || !numeric;
  const countRequired = active?.id === 'touch-errors' || active?.id === 'touch-stops';
  const positiveRequired = ['touch-meters','touch-weight','touch-weight-gross','touch-tube-weight'].includes(active?.id);
  const countInvalid = countRequired && !/^\d+$/.test(active.value.trim());
  const positiveValue = number(activeValue);
  const positiveInvalid = positiveRequired && (!Number.isFinite(positiveValue) || positiveValue <= 0);
  $('#touch-next').disabled = Boolean(countInvalid || positiveInvalid);
  $('#touch-weight').readOnly = active?.id === 'touch-weight' && !touch.weightWeighed;
  $('#touch-numeric-keyboard').querySelectorAll('[data-touch-num]').forEach(button => { button.disabled = false; });
  $('#touch-keyboard-hint').hidden = Boolean(active) || choosingWorker;
  $('.touch-decimal-key').hidden = active?.dataset.touchNumeric === 'integer';
}
function touchPromptLabel(input) {
  if (!input) return '';
  if (input.id === 'touch-meters') return 'Ile metrów?';
  if (input.id === 'touch-weight') return 'Ile kg netto?';
  if (input.id === 'touch-weight-gross') return 'Ile kg waży belka z tuleją?';
  if (input.id === 'touch-tube-weight') return 'Ile kg waży sama tuleja?';
  if (input.id === 'touch-errors') return 'Ile błędów? Wpisz 0, jeśli brak';
  if (input.id === 'touch-stops') return 'Ile stopów? Wpisz 0, jeśli brak';
  if (input.id === 'touch-notes') return 'Uwagi — wpisz opis';
  if (input.matches('[data-touch-extra-meters]')) {
    const index = Number(input.dataset.touchExtraMeters);
    const workerId = state.touch.extras[index]?.workerId;
    const worker = state.data.workers.find(item => String(item.id) === String(workerId));
    return `Ile metrów dla ${worker?.name || 'dodatkowego dziewiarza'}?`;
  }
  return 'Wpisz wartość';
}
async function updateTouchWeightSuggestion() {
  const touch = state.touch, article = touchArticle(), meters = number($('#touch-meters').value), date = $('#touch-date').value;
  const requestId = ++touch.weightSuggestionRequestId;
  let info = null;
  if (touch.weightSuggestionsEnabled && article && meters > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const query = new URLSearchParams({ articleId: article.articleId || article.id, productionDate: date, meters: String(meters) });
    try { info = await api(`/api/bales/weight-suggestion?${query}`); }
    catch { info = null; }
    if (requestId !== touch.weightSuggestionRequestId) return;
  }
  touch.weightInfo = info;
  touch.weightSuggestion = info?.suggestion || null;
  touch.weightMode = info?.mustWeigh || !info?.suggestion ? 'net' : 'calculated';
}
function touchShowConfirmation() {
  state.touch.step = 'confirm';
  state.touch.activeInput = null;
  state.touch.workerPickerIndex = null;
  state.touch.returnPrompt = '';
  paintTouch();
  $('#touch-step-confirm').scrollIntoView({ block: 'nearest' });
}
function touchStart() {
  if (!state.data.articles.length || !state.data.workers.length) { toast('Najpierw wybierz artykuły i pracowników w Ustawieniach.', true); return; }
  touchReset();
  state.touch.step = 'article';
  paintTouch();
}
function touchBack() {
  const touch = state.touch;
  if (touch.step === 'data' && touch.returnPrompt === 'options') {
    touchResumeAfterExtra(true);
    return;
  }
  const fromOptions = touch.step === 'options';
  const fromWeightCheck = touch.step === 'weight-check';
  const prev = { article: 'home', machine: 'article', worker: 'article', data: 'worker', 'weight-check': 'data', weight: 'weight-check', options: 'data', confirm: 'options' }[touch.step] || 'home';
  touch.activeInput = null;
  touch.currentPrompt = '';
  touch.returnPrompt = '';
  touch.workerPickerIndex = null;
  touch.pickerCreatedIndex = -1;
  if (prev === 'home') touchReset(); else {
    touch.step = prev;
    paintTouch();
    if (fromOptions) touchFocusInput($('#touch-stops'));
    else if (fromWeightCheck) touchFocusInput($('#touch-meters'));
  }
}
function touchFocusInput(input) {
  state.touch.activeInput = input;
  state.touch.currentPrompt = input.id || (input.matches('[data-touch-extra-meters]') ? `extra:${input.dataset.touchExtraMeters}` : '');
  state.touch.workerPickerIndex = null;
  $('#touch-extra-worker-picker').hidden = true;
  updateTouchKeyboardPanel();
  input.focus({ preventScroll: true });
}
function touchResumeAfterExtra(cancel = false) {
  const touch = state.touch;
  const index = touch.pickerCreatedIndex;
  const prompt = touch.currentPrompt || 'touch-meters';
  const returnToOptions = touch.returnPrompt === 'options';
  if (cancel && index >= 0 && (!touch.extras[index]?.workerId || !number(touch.extras[index]?.meters))) touch.extras.splice(index, 1);
  else if (!cancel && index >= 0 && (!touch.extras[index]?.workerId || number(touch.extras[index]?.meters) <= 0)) {
    toast('Wpisz metry dodatkowego dziewiarza.', true);
    return;
  }
  touch.returnPrompt = '';
  touch.workerPickerIndex = null;
  touch.pickerCreatedIndex = -1;
  touch.activeInput = null;
  touch.currentPrompt = '';
  if (returnToOptions) { touch.step = 'options'; paintTouch(); return; }
  paintTouch();
  const input = prompt.startsWith('extra:')
    ? $(`[data-touch-extra-meters="${prompt.slice(6)}"]`)
    : $(`#${prompt}`);
  touchFocusInput(input || $('#touch-notes'));
}
async function touchAdvancePrompt() {
  const touch = state.touch, active = touch.activeInput;
  if (!active) return;
  if ((active.id === 'touch-errors' || active.id === 'touch-stops') && !/^\d+$/.test(active.value.trim())) return;
  if (['touch-meters','touch-weight','touch-weight-gross','touch-tube-weight'].includes(active.id) && (!Number.isFinite(number(active.value)) || number(active.value) <= 0)) return;
  if (active.matches('[data-touch-extra-meters]')) { touchResumeAfterExtra(); return; }
  if (active.id === 'touch-meters') {
    await updateTouchWeightSuggestion();
    if (touch.activeInput !== active) return;
    touch.activeInput = null;
    touch.currentPrompt = '';
    touch.step = 'weight-check';
    paintTouch();
    return;
  }
  if (touch.activeInput !== active) return;
  if (active.id === 'touch-weight-gross') { touchFocusInput($('#touch-tube-weight')); return; }
  if (active.id === 'touch-tube-weight') {
    const net = Math.round((number($('#touch-weight-gross').value) - number(active.value)) * 10) / 10;
    if (net <= 0) { toast('Waga z tuleją musi być większa od wagi tulei.', true); return; }
    $('#touch-weight').value = String(net).replace('.', ',');
    const sequence = ['touch-errors', 'touch-stops'];
    touchFocusInput($(`#${sequence[0]}`));
    return;
  }
  const sequence = ['touch-weight', 'touch-errors', 'touch-stops'];
  const index = sequence.indexOf(active.id);
  if (index >= 0) {
    const next = sequence[index + 1];
    if (next) touchFocusInput($(`#${next}`));
    else { touch.step = 'options'; touch.activeInput = null; touch.currentPrompt = ''; paintTouch(); }
  }
}
function touchWriteNumeric(key) {
  const input = state.touch.activeInput;
  if (!input?.isConnected || !input.matches('[data-touch-numeric]')) return;
  if (input.id === 'touch-weight' && state.touch.weightMode === 'calculated') return;
  if (input.id === 'touch-weight' && /^\d$/.test(key)) {
    if (!state.touch.weightManuallyEdited && input.value.trim() === state.touch.weightAutoValue) {
      input.value = '';
      input.setSelectionRange(0, 0);
    }
    state.touch.weightManuallyEdited = true;
    state.touch.weightSuggestion = null;
  }
  let start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start, value = input.value;
  if (key === 'clear') { value = ''; start = end = 0; }
  else if (key === 'backspace') { if (start === end && start > 0) start--; value = value.slice(0, start) + value.slice(end); end = start; }
  else if (key === ',') { if (input.dataset.touchNumeric === 'integer' || /[.,]/.test(value)) return; value = value.slice(0, start) + ',' + value.slice(end); start++; end = start; }
  else if (/^\d$/.test(key)) { value = value.slice(0, start) + key + value.slice(end); start++; end = start; }
  else return;
  input.value = value; input.setSelectionRange(start, end); input.dispatchEvent(new Event('input', { bubbles: true }));
}
function touchTextAction(action) {
  const input = $('#touch-notes');
  let start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start, value = input.value;
  if (action === 'shift') { state.touch.textShift = !state.touch.textShift; $('#touch-text-keyboard [data-touch-text-action="shift"]').classList.toggle('active', state.touch.textShift); return; }
  if (action === 'clear') { input.value = ''; start = end = 0; }
  else if (action === 'backspace') { if (start === end && start > 0) start--; input.value = value.slice(0, start) + value.slice(end); end = start; }
  else if (action === 'done') {
    state.touch.activeInput = null;
    state.touch.currentPrompt = '';
    state.touch.returnPrompt = '';
    state.touch.step = 'options';
    paintTouch();
    return;
  }
  input.setSelectionRange(start, end); input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function saveTouchBale() {
  const touch = state.touch, article = touchArticle();
  const date = $('#touch-date').value, year = String(date).slice(0, 4), machine = touch.machine;
  const meters = number($('#touch-meters').value), weightKg = number($('#touch-weight').value);
  const errorsText = $('#touch-errors').value.trim(), stopsText = $('#touch-stops').value.trim();
  const extras = touch.extras.map(item => ({ workerId: Number(item.workerId), meters: number(item.meters) }));
  let message = '';
  if (!article || !touch.workerId || !machine || !date) message = 'Wybierz artykuł, maszynę, dziewiarza i datę.';
  else if (state.data.sequences?.[year]?.[machine] === undefined) message = `Najpierw ustaw numerację dla ${machine} i roku ${year} w Ustawieniach.`;
  else if (meters <= 0 || weightKg <= 0) message = 'Metry i masa belki muszą być większe od zera.';
  else if (!/^\d+$/.test(errorsText) || !/^\d+$/.test(stopsText)) message = 'Wpisz całkowitą liczbę błędów i stopów (0, jeśli ich nie ma).';
  else if (extras.some(item => !item.workerId || item.meters <= 0)) message = 'Wybierz dziewiarza i wpisz jego metry dla każdej dodatkowej osoby.';
  else if (extras.some(item => item.workerId === Number(touch.workerId)) || new Set(extras.map(item => item.workerId)).size !== extras.length) message = 'Każdego dziewiarza wybierz tylko raz.';
  const remaining = Math.round((meters - extras.reduce((sum, item) => sum + item.meters, 0)) * 100) / 100;
  if (!message && remaining <= 0) message = 'Metry dodatkowych osób muszą zostawić część dla głównego dziewiarza.';
  if (message) { $('#touch-confirm-error').textContent = message; $('#touch-confirm-error').hidden = false; return; }
  touch.saving = true; $('#touch-save').disabled = true; $('#touch-confirm-error').hidden = true;
  try {
    const result = await api('/api/bales', { method: 'POST', body: JSON.stringify({ articleId: article.articleId || article.id, machine, productionDate: date, bales: [{ weightKg, weightWeighed: touch.weightWeighed, weightSource: touch.weightMode === 'calculated' ? 'calculated' : 'weighed', weightGrossKg: touch.weightMode === 'gross' ? number($('#touch-weight-gross').value) : null, tubeWeightKg: touch.weightMode === 'gross' ? number($('#touch-tube-weight').value) : null, meters, errors: Number(errorsText), stops: Number(stopsText), notes: $('#touch-notes').value.trim(), primaryWorkerId: touch.workerId, trialSymbol: article.isTrial ? article.symbol : '', workers: [{ workerId: Number(touch.workerId), meters: remaining }, ...extras] }] }) });
    render(await api('/api/bootstrap'));
    touchReset();
    toast(`Zapisano belkę ${result.created[0].number}.`);
    await loadDailyReports();
  } catch (error) { $('#touch-confirm-error').textContent = error.message; $('#touch-confirm-error').hidden = false; }
  finally { touch.saving = false; $('#touch-save').disabled = false; }
}
function showView(name) {
  hideKeypad();
  $('#view-production').hidden = name !== 'production';
  $('#view-daily-production').hidden = name !== 'daily-production';
  $('#view-settings').hidden = name !== 'settings';
  $('#view-touch').hidden = name !== 'touch';
  document.body.classList.toggle('touch-mode', name === 'touch');
  if (name === 'touch') paintTouch();
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  if (name === 'settings') loadSettings();
}

async function loadSettings() {
  let settingsData={centralCatalogSyncedAt:'',centralWorkersSyncedAt:''};
  try {
    settingsData = await api('/api/settings');
  } catch (error) {
    toast(error.message, true);
  }
  state.catalogArticles = state.data.articles.map(item => ({ symbol: item.symbol, lot: item.lot || '', centralId: item.centralId || null, isTrial: Boolean(item.isTrial), machine: item.machine || '', weightWeighInterval: item.weightWeighInterval || 20 }));
  state.catalogWorkers = (state.data.workerCatalog || []).map(item => ({ employee_uid: item.employee_uid, name: item.name, status: item.status || 'active' }));
  const lastSync=settingsData.centralCatalogSyncedAt?new Date(settingsData.centralCatalogSyncedAt).toLocaleString('pl-PL'):'brak udanej synchronizacji';
  $('#central-catalog-sync').textContent=`Ostatnia udana synchronizacja biblioteki: ${lastSync}. Brak połączenia nie usuwa zapisanej listy.`;
  const workersSync=settingsData.centralWorkersSyncedAt?new Date(settingsData.centralWorkersSyncedAt).toLocaleString('pl-PL'):'lista nie była jeszcze aktualizowana';
  $('#worker-catalog-sync').textContent=`Ostatnia aktualizacja listy pracowników: ${workersSync}.`;
  $('#sequence-year').value = state.data.today.slice(0, 4);
  if ($('#production-server-url')) $('#production-server-url').value = settingsData.productionConnection?.serverUrl || 'http://192.168.1.14:8765';
  if ($('#production-api-token')) $('#production-api-token').value = '';
  if ($('#production-connection-status')) $('#production-connection-status').textContent = settingsData.productionConnection?.configured ? 'Token jest zapisany lokalnie. Adres programu głównego jest stały.' : 'Wklej token z programu głównego i wybierz „Sprawdź i zapisz token”.';
  const yearSequences = state.data.sequences?.[$('#sequence-year').value] || {};
  $('#sequence-list').innerHTML = state.data.machines.map(machine => `<label class="sequence-item">${machine}<input class="sequence-value" data-machine="${machine}" type="number" min="0" max="99999999" step="1" inputmode="numeric" value="${yearSequences[machine] ?? ''}" placeholder="ostatni numer"></label>`).join('');
  renderCatalogs();
}
function renderCatalogs() {
  const articleList = $('#article-list');
  articleList.innerHTML = state.catalogArticles.length ? state.catalogArticles.map((item, index) => `<div class="catalog-row article-catalog-row"><strong>${escapeHtml(item.symbol)}${item.centralId?`<small> · baza główna #${item.centralId}</small>`:''}</strong><label class="article-machine-label">Maszyna<select class="article-machine-input" data-index="${index}" aria-label="Maszyna dla ${escapeHtml(item.symbol)}" required><option value="">—</option>${state.data.machines.map(machine => `<option value="${machine}" ${item.machine === machine ? 'selected' : ''}>${machine}</option>`).join('')}</select></label><label class="article-lot-label">LOT<input class="article-lot-input" data-index="${index}" maxlength="120" value="${escapeHtml(item.lot || '')}" placeholder="LOT artykułu"></label><label class="article-weight-interval-label"><span>Ważenie co</span><input class="article-weight-interval-input" data-index="${index}" type="number" min="1" max="99" step="1" value="${Number(item.weightWeighInterval || 20)}" aria-label="Kontrola wagi co ile belek: ${escapeHtml(item.symbol)}"><span>belek</span></label><label class="article-trial-toggle"><input class="article-trial-input" data-index="${index}" type="checkbox" ${item.isTrial ? 'checked' : ''}> Próba</label><button type="button" class="catalog-remove remove-article" data-index="${index}">Wyłącz</button></div>`).join('') : '<div class="catalog-empty">Brak aktywnych artykułów.</div>';
  articleList.querySelectorAll('.article-machine-input').forEach(input => input.addEventListener('change', () => { const item=state.catalogArticles[Number(input.dataset.index)]; if(item)item.machine=input.value; }));
  articleList.querySelectorAll('.article-weight-interval-input').forEach(input => input.addEventListener('input', () => { const item=state.catalogArticles[Number(input.dataset.index)]; if(!item)return; for(const row of state.catalogArticles) if(row.symbol.toLocaleUpperCase('pl-PL')===item.symbol.toLocaleUpperCase('pl-PL')) row.weightWeighInterval=Number(input.value); articleList.querySelectorAll('.article-weight-interval-input').forEach(control=>{if(state.catalogArticles[Number(control.dataset.index)]?.symbol.toLocaleUpperCase('pl-PL')===item.symbol.toLocaleUpperCase('pl-PL'))control.value=input.value;}); }));
  articleList.querySelectorAll('.article-lot-input').forEach(input => input.addEventListener('input', () => {
    const item = state.catalogArticles[Number(input.dataset.index)];
    if (!item) return;
    for (const row of state.catalogArticles) if (row.symbol.toLocaleUpperCase('pl-PL') === item.symbol.toLocaleUpperCase('pl-PL')) row.lot = input.value;
    articleList.querySelectorAll('.article-lot-input').forEach(control => { if (state.catalogArticles[Number(control.dataset.index)]?.symbol.toLocaleUpperCase('pl-PL') === item.symbol.toLocaleUpperCase('pl-PL')) control.value = input.value; });
  }));
  articleList.querySelectorAll('.article-trial-input').forEach(input => input.addEventListener('change', () => {
    const item = state.catalogArticles[Number(input.dataset.index)];
    if (!item) return;
    for (const row of state.catalogArticles) if (row.symbol.toLocaleUpperCase('pl-PL') === item.symbol.toLocaleUpperCase('pl-PL')) row.isTrial = input.checked;
    articleList.querySelectorAll('.article-trial-input').forEach(control => { if (state.catalogArticles[Number(control.dataset.index)]?.symbol.toLocaleUpperCase('pl-PL') === item.symbol.toLocaleUpperCase('pl-PL')) control.checked = input.checked; });
  }));
  articleList.querySelectorAll('.remove-article').forEach(button => button.addEventListener('click', () => {
    state.catalogArticles.splice(Number(button.dataset.index), 1);
    renderCatalogs();
  }));
  const workerList = $('#worker-list');
  workerList.innerHTML = state.catalogWorkers.length ? state.catalogWorkers.map((item, index) => `<div class="catalog-row worker-catalog-row"><strong>${escapeHtml(item.name)}</strong><label class="worker-status-label">Status<select class="worker-status-input" data-index="${index}" aria-label="Status: ${escapeHtml(item.name)}"><option value="active" ${item.status === 'active' ? 'selected' : ''}>Aktywny</option><option value="vacation" ${item.status === 'vacation' ? 'selected' : ''}>Urlop</option><option value="sick" ${item.status === 'sick' ? 'selected' : ''}>Choroba</option></select></label></div>`).join('') : '<div class="catalog-empty">Brak pracowników z programu głównego. Kliknij „Zaktualizuj listę”.</div>';
  workerList.querySelectorAll('.worker-status-input').forEach(select => select.addEventListener('change', () => {
    const item = state.catalogWorkers[Number(select.dataset.index)];
    if (item) item.status = select.value;
  }));
}
function renderSequenceList(year) {
  const yearSequences = state.data.sequences?.[year] || {};
  $('#sequence-list').innerHTML = state.data.machines.map(machine => `<label class="sequence-item">${machine}<input class="sequence-value" data-machine="${machine}" type="number" min="0" max="99999999" step="1" inputmode="numeric" value="${yearSequences[machine] ?? ''}" placeholder="ostatni numer"></label>`).join('');
}
let catalogSearchTimer;
async function searchCentralArticles() {
  const input=$('#central-article-search'),host=$('#central-article-results'),q=input.value.trim();
  if(!q){host.replaceChildren();return;}
  host.textContent='Wyszukiwanie…';
  try{
    const data=await api(`/api/catalog/search?q=${encodeURIComponent(q)}`);
    host.innerHTML=data.articles.length?data.articles.map(item=>`<button type="button" class="central-article-result" data-central-id="${Number(item.id)}" data-symbol="${escapeHtml(item.symbol)}"><span><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.description||'')}</small></span><span>Dodaj</span></button>`).join(''):'<span class="catalog-empty">Brak dopasowań w zatwierdzonych technologiach.</span>';
  }catch(error){host.textContent=error.message;}
}
function addCentralArticleFromSearch(event) {
  const button=event.target.closest('[data-central-id]');
  if(!button)return;
  const symbol=button.dataset.symbol,centralId=Number(button.dataset.centralId);
  state.catalogArticles.push({symbol,lot:'',centralId,isTrial:false,machine:'',weightWeighInterval:20});
  renderCatalogs();
  button.disabled=true;button.lastElementChild.textContent='Dodano';
}
function setSettingsActionsDisabled(disabled) {
  document.querySelectorAll('[data-save-settings], #refresh-workers, #refresh-articles').forEach(button => { button.disabled = disabled; });
}
async function saveSettings() {
  setSettingsActionsDisabled(true);
  try {
    const unassigned = state.catalogArticles.find(item => !state.data.machines.includes(item.machine));
    if (unassigned) throw new Error(`Wybierz maszynę dla artykułu ${unassigned.symbol}.`);
    const articles = state.catalogArticles.map(item => ({ symbol: item.symbol, lot: item.lot || '', centralId: item.centralId || null, isTrial: Boolean(item.isTrial), machine: item.machine || '', weightWeighInterval: Number(item.weightWeighInterval || 20) }));
    const workers = state.catalogWorkers.map(item => ({ employeeUid: item.employee_uid || '', name: item.name, status: item.status || 'active' }));
    const sequenceYear = Number($('#sequence-year').value);
    const sequences = [...$('#sequence-list').querySelectorAll('.sequence-value')]
      .filter(input => input.value !== '')
      .map(input => ({ machine: input.dataset.machine, lastValue: Number(input.value) }));
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ articles, workers, sequenceYear, sequences }) });
    render(data);
    state.catalogArticles = data.articles.map(item => ({ symbol: item.symbol, lot: item.lot || '', centralId: item.centralId || null, isTrial: Boolean(item.isTrial), machine: item.machine || '', weightWeighInterval: item.weightWeighInterval || 20 }));
    state.catalogWorkers = (data.workerCatalog || []).map(item => ({ employee_uid: item.employee_uid || '', name: item.name, status: item.status || 'active' }));
    renderCatalogs();
    showView('settings');
    toast('Zapisano artykuły, pracowników, numerację i ustawienia ważenia.');
  } catch (error) { toast(error.message, true); }
  finally { setSettingsActionsDisabled(false); }
}

async function refreshWorkers() {
  setSettingsActionsDisabled(true);
  $('#worker-catalog-sync').textContent = 'Pobieram aktualną listę z programu głównego…';
  try {
    const pendingStatuses = new Map(state.catalogWorkers.map(item => [item.employee_uid, item.status]));
    const result = await api('/api/settings/workers/refresh', { method: 'POST', body: JSON.stringify({}) });
    render(result.bootstrap);
    state.catalogWorkers = result.workers.map(item => ({ employee_uid: item.employee_uid, name: item.name, status: pendingStatuses.get(item.employee_uid) || item.status || 'active' }));
    renderCatalogs();
    $('#worker-catalog-sync').textContent = `Lista zaktualizowana: ${new Date(result.syncedAt).toLocaleString('pl-PL')}.`;
    toast(`Zaktualizowano listę pracowników (${state.catalogWorkers.length}).`);
  } catch (error) {
    $('#worker-catalog-sync').textContent = error.message;
    toast(error.message, true);
  } finally { setSettingsActionsDisabled(false); }
}

async function refreshArticles() {
  setSettingsActionsDisabled(true);
  $('#central-catalog-sync').textContent = 'Pobieram aktualną listę zatwierdzonych artykułów z programu głównego…';
  try {
    const result = await api('/api/settings/articles/refresh', { method: 'POST', body: JSON.stringify({}) });
    $('#central-catalog-sync').textContent = `Ostatnia udana synchronizacja biblioteki: ${new Date(result.syncedAt).toLocaleString('pl-PL')}.`;
    if ($('#central-article-search').value.trim()) await searchCentralArticles();
    toast(`Zaktualizowano bibliotekę artykułów (${result.articles}).`);
  } catch (error) {
    $('#central-catalog-sync').textContent = `Nie udało się zaktualizować biblioteki: ${error.message}`;
    toast(error.message, true);
  } finally { setSettingsActionsDisabled(false); }
}

async function verifyProductionToken() {
  const button = $('#verify-production-token');
  button.disabled = true;
  $('#sync-production-status').textContent = 'Sprawdzam token bez wysyłania produkcji…';
  try {
    const result = await api('/api/production/verify-token', {
      method: 'POST',
      body: JSON.stringify({
        productionServerUrl: 'http://192.168.1.14:8765',
        productionApiToken: $('#production-api-token').value.trim(),
      }),
    });
    $('#production-api-token').value = '';
    $('#production-connection-status').textContent = 'Adres programu głównego jest zapisany na stałe. Token jest aktywny i zapisany.';
    $('#sync-production-status').textContent = result.message;
    toast(result.message);
  } catch (error) {
    $('#sync-production-status').textContent = error.message;
    $('#production-connection-status').textContent = error.message;
    toast(error.message, true);
  } finally { button.disabled = false; }
}

const reportStatusLabel = status => ({
  draft: 'Roboczy', approved_pending: 'Zatwierdzony, oczekuje na wysyłkę', sent: 'Wysłany', send_error: 'Błąd wysyłki',
}[status] || 'Do wygenerowania');
function reportDateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function reportSummaryStatus(item) {
  if (item.status === 'sent') return `<span class="report-status report-status-sent">Wysłano · ${escapeHtml(reportDateTime(item.sent_at))}</span>`;
  if (item.status === 'send_error') return '<span class="report-status report-status-error">Błąd wysyłki</span>';
  if (item.status) return `<span class="report-status">${escapeHtml(reportStatusLabel(item.status))}</span>`;
  return '<span class="report-status">Raport do wygenerowania</span>';
}
async function loadDailyReports() {
  try {
    const data = await api('/api/daily-production');
    state.dailyReports = data.reports || [];
    updateGenerateReportButton();
    const connection = data.productionConnection || {};
    $('#production-server-url').value = connection.serverUrl || 'http://192.168.1.14:8765';
    $('#production-api-token').placeholder = connection.configured ? 'Token zapisany; wpisz ponownie tylko po zmianie' : 'Wklej token wygenerowany na serwerze';
    $('#production-connection-status').textContent = connection.configured ? 'Token jest zapisany lokalnie. Adres programu głównego jest stały.' : 'Wklej token z programu głównego w Ustawieniach i wybierz „Sprawdź i zapisz token”.';
    renderDailyReports();
  } catch (error) { $('#daily-report-list').textContent = error.message; }
}
function updateGenerateReportButton() {
  const button = $('#generate-current-report');
  if (!button) return;
  const latest = [...state.dailyReports]
    .sort((a,b) => String(b.report_date).localeCompare(String(a.report_date)))
    .find(item => !item.status);
  button.disabled = !latest;
  button.dataset.date = latest?.report_date || '';
  button.textContent = latest
    ? `Wygeneruj raport dzienny z dnia ${dateFmt(latest.report_date)}`
    : 'Brak raportu do wygenerowania';
}
function renderDailyReports() {
  const host = $('#daily-report-list');
  host.innerHTML = state.dailyReports.map(item => {
    const dateLabel = dateFmt(item.report_date);
    return `<article class="daily-report-card" data-report-date="${escapeHtml(item.report_date)}"><div class="daily-report-summary"><details class="daily-report-details"><summary><span class="daily-report-name">Produkcja dzienna ${dateLabel}</span><span class="daily-report-totals"><strong class="summary-pieces">${Number(item.pieces || 0)} szt.</strong> · <strong class="summary-weight">${fmt(item.weight_kg)} kg</strong></span>${reportSummaryStatus(item)}</summary><div class="daily-report-content muted">Rozwiń, aby otworzyć raport.</div></details>${!item.status ? `<button type="button" class="primary generate-report" data-date="${escapeHtml(item.report_date)}">Wygeneruj raport dzienny</button>` : ''}</div></article>`;
  }).join('') || '<div class="panel padded muted">Brak raportów z ostatnich 30 dni.</div>';
  host.querySelectorAll('.daily-report-details').forEach(details => details.addEventListener('toggle', () => {
    if (details.open) loadDailyReport(details.closest('[data-report-date]').dataset.reportDate, details.querySelector('.daily-report-content'));
  }));
  host.querySelectorAll('.generate-report').forEach(button => button.addEventListener('click', () => generateDailyReport(button.dataset.date, button)));
}
async function refreshDailySummary() {
  const data = await api('/api/daily-production');
  state.dailyReports = data.reports || [];
  updateGenerateReportButton();
  for (const item of state.dailyReports) {
    const card = document.querySelector(`.daily-report-card[data-report-date="${item.report_date}"]`);
    if (!card) continue;
    card.querySelector('.summary-pieces').textContent = `${Number(item.pieces || 0)} szt.`;
    card.querySelector('.summary-weight').textContent = `${fmt(item.weight_kg)} kg`;
    const summary = card.querySelector('summary');
    summary.querySelector('.report-status')?.remove();
    summary.insertAdjacentHTML('beforeend', reportSummaryStatus(item));
  }
}
async function loadDailyReport(reportDate, container) {
  try {
    const data = await api(`/api/daily-production?date=${encodeURIComponent(reportDate)}`);
    if (!data.report) {
      container.innerHTML = '<p>Raport nie jest jeszcze wygenerowany. Wybierz „Wygeneruj raport dzienny”, aby przenieść belki z tej doby do raportu.</p>';
      return;
    }
    state.reportCache.set(reportDate, data.report);
    renderDailyReportDetails(reportDate, container, data.report);
  } catch (error) { container.textContent = error.message; }
}
function editableReportInput(bale, field, value, type = 'text') {
  return `<input class="daily-cell-edit" type="${type}" data-id="${escapeHtml(bale.id)}" data-field="${field}" value="${escapeHtml(value)}" aria-label="${field}">`;
}
function renderDailyReportDetails(reportDate, container, report) {
  const editable = report.status !== 'sent';
  const bales = [...report.bales].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
  const rows = bales.map(bale => `<tr><td>${bale.ordinal}</td><td>${escapeHtml(bale.number)}</td><td>${escapeHtml(bale.symbol)}${bale.trial_symbol ? '<small class="trial-bale-badge">Próba</small>' : ''}</td><td>${escapeHtml(bale.machine)}</td><td>${editable ? editableReportInput(bale,'production_date',bale.production_date,'date') : dateFmt(bale.production_date)}</td><td>${editable ? editableReportInput(bale,'weight_kg',String(bale.weight_kg).replace('.',',')) : fmt(bale.weight_kg)}</td><td>${editable ? editableReportInput(bale,'meters',String(bale.meters).replace('.',',')) : fmt(bale.meters)}</td><td>${editable ? editableReportInput(bale,'errors',bale.errors) : bale.errors}</td><td>${editable ? editableReportInput(bale,'stops',bale.stops) : bale.stops}</td><td>${bale.workers.map(worker => `${escapeHtml(worker.name)} · ${fmt(worker.meters)} m`).join('<br>')}</td><td>${escapeHtml(bale.lot)}</td><td>${editable ? editableReportInput(bale,'notes',bale.notes || '') : escapeHtml(bale.notes)}</td><td>${editable ? `<button class="table-action remove-report-bale" data-id="${escapeHtml(bale.id)}">Usuń z raportu</button>` : '—'}</td></tr>`).join('');
  const statusText = report.last_error ? `<p class="report-error">${escapeHtml(report.last_error)}</p>` : report.status === 'sent'
    ? `<p class="muted">Wysłano ${escapeHtml(reportDateTime(report.sent_at))}. Wysłanego raportu nie można zmieniać w panelu lokalnym; korekty wykonuje się w programie głównym.</p>`
    : `<p class="muted">Status: ${escapeHtml(reportStatusLabel(report.status))}</p>`;
  container.classList.remove('muted');
  container.innerHTML = `${statusText}<div class="table-wrap"><table class="daily-report-table"><thead><tr><th>Lp.</th><th>Belka</th><th>Artykuł</th><th>Maszyna</th><th>Data prod.</th><th>kg</th><th>Metry</th><th>Błędy</th><th>Stopy</th><th>Dziewiarze / udział</th><th>LOT</th><th>Uwagi</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="13" class="empty">Brak belek w tym raporcie.</td></tr>'}</tbody></table></div><div class="daily-actions">${editable ? `<button type="button" class="secondary add-report-bale" data-date="${escapeHtml(reportDate)}">＋ Dopisz belkę</button><button type="button" class="primary send-report" data-date="${escapeHtml(reportDate)}">${report.status === 'send_error' || report.status === 'approved_pending' ? 'Ponów wysyłkę' : 'Zatwierdź i wyślij produkcję na serwer'}</button>` : `<button type="button" class="primary sent-report" disabled>Wysłano · ${escapeHtml(reportDateTime(report.sent_at))}</button>`}</div>`;
  container.querySelectorAll('.daily-cell-edit').forEach(input => {
    input.addEventListener('change', () => saveInlineReportValue(reportDate,input,container));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
  });
  container.querySelectorAll('.remove-report-bale').forEach(button => button.addEventListener('click', () => removeReportBale(reportDate,button.dataset.id,container)));
  container.querySelector('.add-report-bale')?.addEventListener('click', () => beginAddReportBale(reportDate));
  container.querySelector('.send-report')?.addEventListener('click', () => sendDailyReport(reportDate,container));
}
async function saveInlineReportValue(reportDate,input,container) {
  const report = state.reportCache.get(reportDate);
  const bale = report?.bales.find(row => row.id === input.dataset.id);
  if (!bale) return;
  const field = input.dataset.field;
  const value = ['weight_kg','meters','errors','stops'].includes(field) ? number(input.value) : input.value;
  const body = { articleId: bale.article_id, machine: bale.machine, productionDate: field === 'production_date' ? value : bale.production_date,
    weightKg: field === 'weight_kg' ? value : bale.weight_kg, meters: field === 'meters' ? value : bale.meters,
    errors: field === 'errors' ? value : bale.errors, stops: field === 'stops' ? value : bale.stops,
    notes: field === 'notes' ? value : bale.notes,
    workers: bale.workers.map(worker => ({ workerId: worker.workerId, meters: worker.meters })) };
  input.disabled = true;
  try {
    const result = await api(`/api/daily-production/${reportDate}/bales/${encodeURIComponent(bale.id)}`, { method: 'POST', body: JSON.stringify(body) });
    state.reportCache.set(reportDate,result.report);
    render(result.bootstrap);
    await refreshDailySummary();
    renderDailyReportDetails(reportDate,container,result.report);
    toast('Zapisano zmianę w raporcie.');
  } catch (error) { input.value = field === 'production_date' || field === 'notes' ? String(bale[field] || '') : String(bale[field] ?? '').replace('.', ','); input.disabled = false; toast(error.message,true); }
}
async function removeReportBale(reportDate,baleId,container) {
  const report = state.reportCache.get(reportDate);
  const bale = report?.bales.find(row => row.id === baleId);
  if (!bale || !window.confirm(`Usunąć belkę ${bale.number} z raportu i przywrócić ją do zakładki Produkcja?`)) return;
  try {
    const result = await api(`/api/daily-production/${reportDate}/bales/${encodeURIComponent(baleId)}/remove`,{method:'POST',body:'{}'});
    state.reportCache.set(reportDate,result.report);
    render(result.bootstrap);
    await refreshDailySummary();
    renderDailyReportDetails(reportDate,container,result.report);
    toast(`Belka ${bale.number} wróciła do Produkcji.`);
  } catch (error) { toast(error.message,true); }
}
async function generateDailyReport(reportDate,button) {
  if (button) button.disabled = true;
  try {
    const result = await api('/api/daily-production/generate',{method:'POST',body:JSON.stringify(reportDate ? {reportDate} : {})});
    reportDate = result.report.report_date;
    state.reportCache.set(reportDate,result.report);
    await loadDailyReports();
    render(await api('/api/bootstrap'));
    const card = document.querySelector(`.daily-report-card[data-report-date="${reportDate}"]`);
    const details = card?.querySelector('.daily-report-details');
    if (details) {
      details.open = true;
      renderDailyReportDetails(reportDate,details.querySelector('.daily-report-content'),result.report);
    }
    toast(`Wygenerowano raport ${dateFmt(reportDate)}.`);
  } catch (error) { toast(error.message,true); }
  finally { if (button) button.disabled = false; }
}
function beginAddReportBale(reportDate) {
  state.addToReportDate = reportDate;
  state.editingId = null;
  showView('production');
  $('#article').value = '';
  $('#machine').value = '';
  $('#production-date').value = reportDate;
  fillCommonControls();
  $('#production-date').value = reportDate;
  resetBaleFields();
  $('#bale-form-title').textContent = `Dopisz belkę do raportu ${dateFmt(reportDate)}`;
  $('#save-bale').textContent = 'Zapisz i dopisz do raportu';
  $('#cancel-report-add').hidden = false;
  document.querySelector('.production-entry')?.scrollIntoView({behavior:'smooth',block:'start'});
}
async function returnToDailyReport(reportDate) {
  showView('daily-production');
  await loadDailyReports();
  const card = document.querySelector(`.daily-report-card[data-report-date="${reportDate}"]`);
  const details = card?.querySelector('.daily-report-details');
  if (details) {
    details.open = true;
    await loadDailyReport(reportDate, details.querySelector('.daily-report-content'));
  }
}
async function sendDailyReport(reportDate,container) {
  const button = container.querySelector('.send-report'); if (button) button.disabled = true;
  $('#daily-action-status').textContent = 'Zapisuję zatwierdzoną wersję i wysyłam ją na serwer…';
  try {
    const token = $('#production-api-token').value.trim();
    if (token) await api('/api/settings/production-connection',{method:'POST',body:JSON.stringify({productionServerUrl:'http://192.168.1.14:8765',productionApiToken:token})});
    const result = await api(`/api/daily-production/${reportDate}/send`,{method:'POST',body:'{}'});
    state.reportCache.set(reportDate,result.report);
    $('#production-api-token').value = '';
    $('#daily-action-status').textContent = `Serwer potwierdził odbiór ${result.uploaded} belek.`;
    render(await api('/api/bootstrap'));
    await refreshDailySummary();
    renderDailyReportDetails(reportDate,container,result.report);
    toast($('#daily-action-status').textContent);
  } catch (error) { $('#daily-action-status').textContent=error.message; toast(error.message,true); await loadDailyReport(reportDate,container); }
}
function collectBale() {
  const meters = number($('#meters').value);
  const errorsText = $('#errors').value.trim();
  const stopsText = $('#stops').value.trim();
  if (!errorsText || !stopsText) throw new Error('Wpisz liczbę błędów i stopów. Wpisz 0, jeśli ich nie ma.');
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
  const selectedArticle = selectedArticleChoice();
  return {
    weightKg: number($('#weight-kg').value),
    meters,
    errors: number(errorsText),
    stops: number(stopsText),
    notes: $('#notes').value,
    trialSymbol: selectedArticle?.isTrial ? selectedArticle.symbol : '',
    primaryWorkerId: String(primaryId),
    workers: [{ workerId: primaryId, meters: remainder }, ...extras],
    extraWorkers: extras,
  };
}
async function saveProduction(event) {
  event.preventDefault();
  if (!state.data.articles.length || !state.data.workers.length) { toast('Najpierw dodaj artykuły i pracowników w Ustawieniach.', true); return; }
  const selectedChoice = selectedArticleChoice();
  const common = { articleId: selectedChoice?.articleId || selectedChoice?.id, machine: articleMachine(selectedChoice) || $('#machine').value, productionDate: $('#production-date').value };
  if (!state.data.machines.includes(selectedChoice?.machine)) { toast(`W Ustawieniach kierownika wybierz maszynę dla artykułu „${selectedChoice?.symbol || '—'}”.`, true); return; }
  const year = String(common.productionDate).slice(0, 4);
  if (state.data.sequences?.[year]?.[common.machine] === undefined) { toast('Najpierw ustaw ostatni użyty numer tej maszyny i roku w Ustawieniach.', true); return; }
  let bale;
  try { bale = collectBale(); }
  catch (error) { toast(error.message, true); return; }
  if (!$('#production-form').reportValidity()) return;
  const returnReportDate = state.addToReportDate;
  $('#save-bale').disabled = true;
  hideKeypad();
  try {
    if (state.editingId) {
      await api(`/api/bales/${encodeURIComponent(state.editingId)}`, { method: 'POST', body: JSON.stringify({ ...common, ...bale }) });
      toast('Poprawiony wpis zapisano lokalnie.');
    } else {
      if (state.addToReportDate) {
        const result = await api(`/api/daily-production/${state.addToReportDate}/bales`, { method: 'POST', body: JSON.stringify({ ...common, bales: [bale] }) });
        toast(`Dopisano belkę ${result.created[0].number} do raportu ${dateFmt(state.addToReportDate)}.`);
        state.addToReportDate = null;
      } else {
        const result = await api('/api/bales', { method: 'POST', body: JSON.stringify({ ...common, bales: [bale] }) });
        toast(`Zapisano belkę ${result.created[0].number}.`);
      }
    }
    const data = await api('/api/bootstrap');
    render(data);
    setFreshForm(true);
    await loadDailyReports();
    if (returnReportDate) await returnToDailyReport(returnReportDate);
  } catch (error) { toast(error.message, true); }
  finally { $('#save-bale').disabled = false; }
}
function startEdit(id) {
  const row = state.data.bales.find(item => item.id === id);
  if (!row || row.sync_status !== 'pending') { toast('Można poprawiać tylko belki oczekujące na wysłanie.', true); return; }
  showView('production');
  if (!state.data.articles.some(item => Number(item.id) === Number(row.article_id))) {
    state.data.articles.push({ id: row.article_id, articleId: row.article_id, choiceId: row.article_id, symbol: row.article_symbol || row.symbol, lot: row.lot || '', machine: '' });
    fillCommonControls();
  }
  for (const worker of row.workers) {
    if (!state.data.workers.some(item => Number(item.id) === Number(worker.workerId))) {
      state.data.workers.push({ id: worker.workerId, employee_uid: worker.employeeUid || '', name: worker.name });
    }
  }
  const editChoice=state.data.articles.find(item=>Number(item.articleId||item.id)===Number(row.article_id)&&(!item.machine||item.machine===row.machine));
  $('#article').value = String(editChoice?.choiceId ?? editChoice?.id ?? row.article_id);
  $('#machine').disabled = true;
  $('#machine').value = row.machine;
  $('#production-date').value = row.production_date;
  const contributions = [...row.workers].sort((a, b) => b.meters - a.meters);
  const primary = contributions[0];
  fillWorkerControls(String(primary?.workerId || ''));
  const prefill = {
    weightKg: row.weight_kg, meters: row.meters, stops: row.stops, notes: row.notes,
    extraWorkers: contributions.slice(1).map(worker => ({ workerId: worker.workerId, meters: worker.meters })),
  };
  resetBaleFields(prefill);
  $('#errors').value = String(row.errors);
  state.editingId = row.id;
  $('#save-bale').textContent = 'Zapisz poprawkę';
  $('#bale-form-title').textContent = 'Poprawa belki';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function startCopy(id) {
  const row = id === 'last' ? state.data.lastBale : state.data.bales.find(item => item.id === id);
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
  const copyChoice=state.data.articles.find(item=>Number(item.articleId||item.id)===Number(row.article_id)&&(!item.machine||item.machine===row.machine));
  $('#article').value = String(copyChoice?.choiceId ?? copyChoice?.id ?? row.article_id);
  $('#machine').disabled = true;
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
  state.editingId = null;
  $('#save-bale').textContent = 'Zapisz skopiowaną belkę';
  $('#bale-form-title').textContent = `Kopia belki ${row.number}`;
  $('#save-bale').disabled = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`Skopiowano dane belki ${row.number} i dziewiarza. Błędy wyzerowano; nowa belka otrzyma własny numer.`);
  $('#errors').focus();
}
async function setReviewFlag(id, needsCheck) {
  const wasSynced = [...(state.data?.recentBales || []), ...(state.data?.bales || [])].find(row => row.id === id)?.sync_status === 'synced' || state.data?.lastBale?.id === id && state.data.lastBale.sync_status === 'synced';
  try {
    render(await api(`/api/bales/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ needsCheck }) }));
    const action = needsCheck ? 'Oznaczono błędny zapis do sprawdzenia.' : 'Cofnięto oznaczenie błędnego zapisu.';
    toast(wasSynced ? `${action} Zmiana została wysłana do programu głównego.` : action);
  }
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
$('#article').addEventListener('change', () => { const choice=selectedArticleChoice(); $('#machine').disabled=true; $('#machine').value=articleMachine(choice); });

$('#central-article-search').addEventListener('input',()=>{clearTimeout(catalogSearchTimer);catalogSearchTimer=setTimeout(searchCentralArticles,180);});
$('#central-article-results').addEventListener('click',addCentralArticleFromSearch);
$('#add-extra-worker').addEventListener('click', () => { addExtraWorkerRow(); updateShareSummary(); });
document.querySelectorAll('[data-save-settings]').forEach(button => button.addEventListener('click', saveSettings));
$('#refresh-workers').addEventListener('click', refreshWorkers);
$('#refresh-articles').addEventListener('click', refreshArticles);
$('#verify-production-token').addEventListener('click', verifyProductionToken);
$('#generate-current-report').addEventListener('click', event => {
  if (event.currentTarget.dataset.date) generateDailyReport(event.currentTarget.dataset.date,event.currentTarget);
});
$('#copy-last-bale').addEventListener('click', () => {
  if (!state.data?.lastBale) { toast('Nie ma jeszcze belki, którą można skopiować.', true); return; }
  startCopy('last');
});
$('#cancel-report-add').addEventListener('click', async () => {
  const reportDate = state.addToReportDate;
  state.addToReportDate = null;
  setFreshForm(true);
  if (reportDate) await returnToDailyReport(reportDate);
});
$('#refresh').addEventListener('click', refresh);
$('#retry-startup').addEventListener('click', refresh);
$('#back-to-production').addEventListener('click', () => showView('production'));
$('#worker-primary').addEventListener('change', updateShareSummary);
$('#meters').addEventListener('input', updateShareSummary);
$('#sequence-year').addEventListener('change', () => renderSequenceList($('#sequence-year').value));
document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => {
  showView(button.dataset.view);
  if (button.dataset.view === 'daily-production') loadDailyReports();
}));
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
$('#touch-exit').addEventListener('click', () => showView('production'));
$('#touch-choose-article').addEventListener('click', touchStart);
$('#touch-back').addEventListener('click', touchBack);
$('#touch-save').addEventListener('click', saveTouchBale);
$('#touch-confirm-back').addEventListener('click', () => { $('#touch-confirm-error').hidden = true; state.touch.step = 'options'; state.touch.activeInput = null; paintTouch(); });
$('#touch-options-confirm').addEventListener('click', touchShowConfirmation);
$('#touch-home').addEventListener('click', event => {
  const button = event.target.closest('[data-touch-review]');
  if (button) setReviewFlag(button.dataset.touchReview, button.dataset.check === '1');
});
$('#touch-wizard').addEventListener('click', event => {
  const weightModeButton = event.target.closest('[data-touch-weight-mode]');
  if (weightModeButton) {
    const info = state.touch.weightInfo || {};
    if (weightModeButton.dataset.touchWeightMode === 'calculated' && (info.mustWeigh || !info.suggestion)) return;
    state.touch.weightMode = weightModeButton.dataset.touchWeightMode;
    renderTouchWeightCheck();
    return;
  }
  if (event.target.closest('#touch-weight-check-continue')) {
    const touch = state.touch;
    touch.weightWeighed = touch.weightMode !== 'calculated';
    touch.weightManuallyEdited = touch.weightWeighed;
    touch.weightAutoValue = '';
    touch.weightSuggestion = touch.weightMode === 'calculated' ? touch.weightInfo?.suggestion || null : null;
    $('#touch-weight').value = '';
    $('#touch-weight-gross').value = '';
    $('#touch-tube-weight').value = '';
    touch.step = 'weight';
    paintTouch();
    if (touch.weightMode === 'calculated' && touch.weightSuggestion) {
      $('#touch-weight').value = number(touch.weightSuggestion.weight_kg).toFixed(1).replace('.', ',');
      touch.weightAutoValue = $('#touch-weight').value;
      touchFocusInput($('#touch-errors'));
    } else touchFocusInput($(touch.weightMode === 'gross' ? '#touch-weight-gross' : '#touch-weight'));
    return;
  }
  const articleButton = event.target.closest('[data-touch-article]');
  if (articleButton) {
    const touch = state.touch;
    touch.articleId = articleButton.dataset.touchArticle;
    const article = touchArticle();
    if (!state.data.machines.includes(article?.machine)) { toast(`W Ustawieniach kierownika wybierz maszynę dla artykułu „${article?.symbol || '—'}”.`, true); return; }
    touch.machine = article.machine; touch.step = 'worker';
    paintTouch(); return;
  }
  const machineButton = event.target.closest('[data-touch-machine]');
  if (machineButton) { state.touch.machine = machineButton.dataset.touchMachine; state.touch.step = 'worker'; paintTouch(); return; }
  const workerButton = event.target.closest('[data-touch-worker]');
  if (workerButton) {
    state.touch.workerId = workerButton.dataset.touchWorker;
    $('#touch-date').value ||= state.data.today;
    state.touch.step = 'data';
    paintTouch();
    touchFocusInput($('#touch-meters'));
    return;
  }
  if (event.target.closest('[data-touch-add-extra]')) {
    const touch = state.touch;
    touch.extras.push({ workerId: '', meters: '' });
    touch.returnPrompt = 'options';
    touch.workerPickerIndex = touch.extras.length - 1;
    touch.pickerCreatedIndex = touch.workerPickerIndex;
    touch.activeInput = null;
    touch.step = 'data';
    paintTouch();
    return;
  }
  if (event.target.closest('[data-touch-add-notes]')) {
    state.touch.returnPrompt = 'options';
    state.touch.activeInput = null;
    state.touch.step = 'data';
    paintTouch();
    touchFocusInput($('#touch-notes'));
    return;
  }
  const remove = event.target.closest('[data-touch-remove-extra]');
  if (remove) {
    const removedIndex = Number(remove.dataset.touchRemoveExtra);
    state.touch.extras.splice(removedIndex, 1);
    if (state.touch.workerPickerIndex === removedIndex) state.touch.workerPickerIndex = null;
    else if (state.touch.workerPickerIndex > removedIndex) state.touch.workerPickerIndex--;
    paintTouch();
    return;
  }
  const chooseExtra = event.target.closest('[data-touch-pick-extra]');
  if (chooseExtra) {
    state.touch.returnPrompt ||= state.touch.currentPrompt || 'touch-meters';
    state.touch.workerPickerIndex = Number(chooseExtra.dataset.touchPickExtra);
    state.touch.pickerCreatedIndex = -1;
    state.touch.activeInput = null;
    paintTouch();
    return;
  }
  const extraWorkerTile = event.target.closest('[data-touch-extra-worker-tile]');
  if (extraWorkerTile) {
    const index = state.touch.workerPickerIndex;
    if (state.touch.extras[index]) state.touch.extras[index].workerId = extraWorkerTile.dataset.touchExtraWorkerTile;
    state.touch.workerPickerIndex = null;
    paintTouch();
    const metersInput = $(`[data-touch-extra-meters="${index}"]`);
    if (metersInput) touchFocusInput(metersInput);
    return;
  }
  if (event.target.closest('[data-touch-picker-cancel]')) { state.touch.workerPickerIndex = null; touchResumeAfterExtra(true); return; }
  const numKey = event.target.closest('[data-touch-num]');
  if (numKey) {
    touchWriteNumeric(numKey.dataset.touchNum);
    return;
  }
  const textKey = event.target.closest('[data-touch-text]');
  if (textKey) {
    const input = $('#touch-notes');
    let start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    let value = textKey.dataset.touchText;
    if (state.touch.textShift) { value = value.toLocaleUpperCase('pl-PL'); state.touch.textShift = false; $('#touch-text-keyboard [data-touch-text-action="shift"]').classList.remove('active'); }
    input.value = input.value.slice(0, start) + value + input.value.slice(end);
    start += value.length;
    input.setSelectionRange(start, start);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const textAction = event.target.closest('[data-touch-text-action]');
  if (textAction) touchTextAction(textAction.dataset.touchTextAction);
});
$('#touch-next').addEventListener('click', touchAdvancePrompt);
$('#touch-wizard').addEventListener('focusin', event => {
  const input = event.target.closest('[data-touch-numeric], #touch-notes');
  if (input) touchFocusInput(input);
});
$('#touch-wizard').addEventListener('input', event => {
  const input = event.target;
  if (input.id === 'touch-meters' || input.matches('[data-touch-extra-meters]')) {
    const index = Number(input.dataset.touchExtraMeters);
    if (input.id !== 'touch-meters' && state.touch.extras[index]) state.touch.extras[index].meters = input.value;
    updateTouchShare();
  }
  if (input.id === 'touch-weight' && input.value.trim() !== state.touch.weightAutoValue) {
    if (!state.touch.weightWeighed) {
      input.value = state.touch.weightAutoValue;
      updateTouchKeyboardPanel();
      return;
    }
    state.touch.weightManuallyEdited = true;
    state.touch.weightSuggestion = null;
  }
  if (input.id === 'touch-notes') $('#touch-text-preview').textContent = input.value.trim() || 'Wpisany opis pojawi się tutaj';
  if (input.matches('[data-touch-numeric]')) updateTouchKeyboardPanel();
});
$('#touch-date').addEventListener('change', event => { state.touch.date = event.target.value; renderTouchSelectionSummary(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#numeric-keypad').hidden) hideKeypad();
  if (event.key === 'Enter' && event.target.matches?.('#production-form [data-numeric]')) {
    event.preventDefault();
    moveToNextField();
  }
});
refresh().then(loaded => { if (loaded) setFreshForm(false); });
