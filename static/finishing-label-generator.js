'use strict';

const generatorForm = document.querySelector('.manual-label-controls');
const generatorLabel = document.querySelector('[data-manual-label]');
const generatorContent = generatorLabel?.querySelector('[data-manual-label-content]');
const labelWords = {
  pl: {symbol:'SYMBOL',color:'KOLOR',lot:'NR PARTII',width:'SZEROKOŚĆ',grammage:'GRAMATURA',raw:'SYMBOL SUROWY',client:'KLIENT',distance:'DYSTANS',meters:'ILOŚĆ [mb]',weight:'WAGA [kg]',extra:'',secondaryMeters:'DŁUGOŚĆ [m]',secondaryWeight:'WAGA [kg]'},
  en: {symbol:'INDEX',color:'COLOR',lot:'BATCH NO.',width:'WIDTH',grammage:'WEIGHT',raw:'GREIGE INDEX',client:'CLIENT',distance:'DISTANCE',meters:'QUANTITY [m]',weight:'WEIGHT [kg]',extra:'',secondaryMeters:'LENGTH [m]',secondaryWeight:'WEIGHT [kg]'}
};
const addManualRow = (key, title, value, unit='') => {
  const row = document.createElement('div');
  row.className = `label-row${key === 'extra' ? ' label-extra-text' : ''}`;
  row.dataset.labelKey = key;
  if (key !== 'extra') {
    const label = document.createElement('span');
    label.textContent = title;
    row.append(label);
  }
  const strong = document.createElement('strong');
  strong.textContent = `${value || '—'}${unit}`;
  row.append(strong);
  return row;
};
const renderManualLabel = () => {
  if (!generatorForm || !generatorContent) return;
  const language = generatorForm.querySelector('[name="manual_language"]:checked')?.value === 'en' ? 'en' : 'pl';
  const words = labelWords[language];
  const enabled = new Set([...generatorForm.querySelectorAll('[data-manual-field]:checked')].map(input => input.dataset.manualField));
  generatorContent.replaceChildren();
  const values = key => generatorForm.querySelector(`[data-label-input="${key}"]`)?.value.trim() || '';
  const definitions = [
    ['symbol', words.symbol, ''], ['raw', words.raw, ''], ['color', words.color, ''], ['lot', words.lot, ''],
    ['width', words.width, ' cm'], ['grammage', words.grammage, ' g/m²'], ['distance', words.distance, ' mm'],
    ['client', words.client, ''], ['extra', words.extra, '']
  ];
  for (const [key, title, unit] of definitions) {
    if (!enabled.has(key)) continue;
    const row = addManualRow(key, title, values(key), key === 'distance' && values(key) ? unit : '');
    if (key === 'extra') row.classList.add('label-row-before-quantity');
    generatorContent.append(row);
  }
  const unit = generatorForm.querySelector('[name="manual_quantity_unit"]:checked')?.value || 'meters';
  const meters = values('meters') || '—';
  const weight = values('weight') || '—';
  const quantity = document.createElement('div');
  quantity.className = 'label-quantity';
  quantity.dataset.labelKey = 'quantity';
  quantity.dataset.quantityMeters = meters;
  quantity.dataset.quantityKg = weight;
  const summary = document.createElement('div');
  const title = document.createElement('span');
  title.textContent = unit === 'weight' ? words.weight : words.meters;
  summary.append(title);
  const secondaryEnabled = generatorForm.querySelector('[data-label-secondary]')?.checked;
  const secondaryValue = unit === 'weight' ? meters : weight;
  const secondaryTitle = unit === 'weight' ? words.secondaryMeters : words.secondaryWeight;
  if (secondaryEnabled && secondaryValue !== '—') {
    const secondary = document.createElement('small');
    secondary.className = 'label-secondary-quantity';
    secondary.textContent = `${secondaryTitle}: ${secondaryValue}`;
    summary.append(secondary);
  }
  const mainValue = document.createElement('strong');
  mainValue.textContent = unit === 'weight' ? weight : meters;
  quantity.append(summary, mainValue);
  generatorContent.append(quantity);
  generatorLabel.lang = language;
  window.fitFinishingLabelRows?.();
};

generatorForm?.addEventListener('input', renderManualLabel);
generatorForm?.addEventListener('change', event => {
  const toggle = event.target.closest('[data-manual-field]');
  if (toggle) {
    const input = generatorForm.querySelector(`[data-input-for="${toggle.dataset.manualField}"]`);
    if (input) input.hidden = !toggle.checked;
  }
  renderManualLabel();
});
renderManualLabel();
