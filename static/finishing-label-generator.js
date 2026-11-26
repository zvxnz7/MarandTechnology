'use strict';

const generatorForm = document.querySelector('.manual-label-controls');
const labelList = document.querySelector('[data-manual-labels]');
const labelWords = {
  pl: {symbol:'SYMBOL',color:'KOLOR',lot:'NR PARTII',width:'SZEROKOŚĆ',grammage:'GRAMATURA',raw:'SYMBOL SUROWY',client:'KLIENT',distance:'DYSTANS',meters:'ILOŚĆ [mb]',weight:'WAGA [kg]',extra:'',secondaryMeters:'DŁUGOŚĆ [m]',secondaryWeight:'WAGA [kg]'},
  en: {symbol:'INDEX',color:'COLOR',lot:'BATCH NO.',width:'WIDTH',grammage:'WEIGHT',raw:'GREIGE INDEX',client:'CLIENT',distance:'DISTANCE',meters:'QUANTITY [m]',weight:'WEIGHT [kg]',extra:'',secondaryMeters:'LENGTH [m]',secondaryWeight:'WEIGHT [kg]'}
};

const inputValue = key => generatorForm?.querySelector(`[data-label-input="${key}"]`)?.value.trim() || '';
const splitValues = value => value.split(/[;\n]+/).map(item => item.trim()).filter(Boolean);
const parseMeters = value => value ? value.split(/[;,\n]+/).map(item => item.trim()).filter(Boolean) : [];
const parseWeights = (value, expectedCount=0) => {
  if (!value) return [];
  if (/[;\n]/.test(value)) return splitValues(value).map(item => item.replace(',', '.'));
  const parts = value.split(',').map(item => item.trim());
  if (parts.length === 1) return parts;
  const pairDecimals = parts.length % 2 === 0 && parts.every((part,index) => /^\d+(?:\.\d+)?$/.test(part) && (index % 2 === 1 ? /^\d{1,2}$/.test(part) : /^\d+$/.test(part)));
  if (pairDecimals && (parts.length === expectedCount * 2 || !expectedCount)) {
    return Array.from({length:parts.length/2},(_,index) => `${parts[index*2]}.${parts[index*2+1]}`);
  }
  if (expectedCount === 1) return [parts.join('.')];
  return parts;
};
const addManualRow = (label, title, value, unit='') => {
  const row = document.createElement('div');
  row.className = `label-row${label === 'extra' ? ' label-extra-text label-row-before-quantity' : ''}`;
  row.dataset.labelKey = label;
  if (label !== 'extra') {
    const name = document.createElement('span');
    name.textContent = title;
    row.append(name);
  }
  const data = document.createElement('strong');
  data.textContent = `${value || '—'}${unit}`;
  row.append(data);
  return row;
};
const applyBrand = (label, mode, brandText) => {
  label.querySelector('[data-label-brand]')?.remove();
  if (mode === 'logo') {
    const logo = document.createElement('img');
    logo.className = 'label-logo';
    logo.dataset.labelBrand = '';
    logo.src = '/static/marand-label-logo.png';
    logo.alt = 'MARAND Technical textiles';
    label.prepend(logo);
  } else if (brandText) {
    const text = document.createElement('div');
    text.className = 'label-custom-brand';
    text.dataset.labelBrand = '';
    text.textContent = brandText;
    label.prepend(text);
  }
};
const setValidation = message => {
  const validation = generatorForm?.querySelector('[data-label-validation]');
  const print = document.querySelector('[data-label-print]');
  if (validation) { validation.textContent = message; validation.hidden = !message; }
  if (print) print.disabled = Boolean(message);
};
const renderManualLabel = () => {
  if (!generatorForm || !labelList) return;
  const language = generatorForm.querySelector('[name="manual_language"]:checked')?.value === 'en' ? 'en' : 'pl';
  const words = labelWords[language];
  const enabled = new Set([...generatorForm.querySelectorAll('[data-manual-field]:checked')].map(input => input.dataset.manualField));
  const meters = parseMeters(inputValue('meters'));
  const weights = parseWeights(inputValue('weight'), meters.length);
  const hasMeters = meters.length > 0, hasWeights = weights.length > 0;
  const count = Math.max(meters.length, weights.length, 1);
  const invalidMeters = inputValue('meters') && meters.some(value => !/^\d+(?:\.\d+)?$/.test(value));
  const invalidWeights = inputValue('weight') && weights.some(value => !/^\d+(?:\.\d+)?$/.test(value));
  const validation = invalidMeters ? 'Sprawdź format metrów. Wartości oddziel przecinkami.'
    : invalidWeights ? 'Sprawdź format wag. Przecinek dziesiętny zapisuj w parach (np. 22,1,22,2) lub oddzielaj wagi średnikiem.'
      : hasMeters && hasWeights && meters.length !== weights.length ? `Wpisano ${meters.length} wartości metrów i ${weights.length} wag. Podaj tyle samo wartości, w tej samej kolejności, albo usuń wagi.`
        : !hasMeters && !hasWeights ? 'Wpisz metry lub kilogramy, aby wydrukować etykietę.' : '';
  setValidation(validation);
  const unit = generatorForm.querySelector('[name="manual_quantity_unit"]:checked')?.value || 'meters';
  const secondaryEnabled = generatorForm.querySelector('[data-label-secondary]')?.checked;
  const brandMode = generatorForm.querySelector('[name="manual_brand_mode"]:checked')?.value || 'logo';
  const brandText = inputValue('brand');
  const extraText = inputValue('extra');
  const exampleMode = !hasMeters && !hasWeights;
  const previous = [...labelList.querySelectorAll('[data-manual-label]')];
  const templates = Array.from({length:count},(_,index) => previous[index] || previous[0]?.cloneNode(true));
  labelList.replaceChildren(...templates);
  templates.forEach((label,index) => {
    const content = label.querySelector('[data-manual-label-content]');
    content.replaceChildren();
    const value = key => inputValue(key);
    const definitions = [
      ['symbol', words.symbol, value('symbol'), ''], ['raw', words.raw, value('raw'), ''], ['color', words.color, value('color'), ''],
      ['lot', words.lot, value('lot'), ''], ['width', words.width, value('width'), ' cm'], ['grammage', words.grammage, value('grammage'), ' g/m²'],
      ['distance', words.distance, value('distance'), ' mm'], ['client', words.client, value('client'), ''], ['extra', '', extraText, '']
    ];
    for (const [key,title,data,unitLabel] of definitions) if (enabled.has(key)) content.append(addManualRow(key,title,data,key==='distance'&&data?unitLabel:''));
    const metersValue = meters[index] || '';
    const weightValue = weights[index] || '';
    const mainValue = unit === 'weight' ? (weightValue || (exampleMode?'22,1':'')) : (metersValue || (exampleMode?'100':''));
    const otherValue = unit === 'weight' ? (metersValue || (exampleMode?'100':'')) : (weightValue || (exampleMode?'22,1':''));
    const quantity = document.createElement('div');
    quantity.className = 'label-quantity';
    quantity.dataset.labelKey = 'quantity';
    quantity.dataset.quantityMeters = metersValue || '—';
    quantity.dataset.quantityKg = weightValue || '—';
    const summary = document.createElement('div');
    const title = document.createElement('span');
    title.textContent = unit === 'weight' ? words.weight : words.meters;
    summary.append(title);
    const amount = document.createElement('strong');
    amount.textContent = mainValue || '—';
    if (exampleMode) amount.classList.add('label-example-value');
    const amountStack = document.createElement('div');
    amountStack.className = 'label-quantity-values';
    amountStack.append(amount);
    if (secondaryEnabled && otherValue) {
      const secondary = document.createElement('small');
      secondary.className = 'label-secondary-quantity';
      secondary.textContent = `${unit === 'weight' ? words.secondaryMeters : words.secondaryWeight}: ${otherValue}`;
      if (exampleMode) secondary.classList.add('label-example-value');
      amountStack.append(secondary);
    }
    quantity.append(summary,amountStack);
    content.append(quantity);
    label.lang = language;
    applyBrand(label,brandMode,brandText);
  });
  const countLabel = document.querySelector('[data-label-count]');
  if (countLabel) countLabel.textContent = `${count} ${count===1?'etykieta':'etykiet'} · 50 × 74 mm`;
  window.fitFinishingLabelRows?.();
};

generatorForm?.addEventListener('input',renderManualLabel);
generatorForm?.addEventListener('change',event => {
  const fieldToggle = event.target.closest('[data-manual-field]');
  if (fieldToggle) {
    const input = generatorForm.querySelector(`[data-input-for="${fieldToggle.dataset.manualField}"]`);
    if (input) input.hidden = !fieldToggle.checked;
  }
  const brandMode = event.target.closest('[name="manual_brand_mode"]');
  if (brandMode) {
    const brandInput = generatorForm.querySelector('[data-brand-text-field]');
    if (brandInput) brandInput.hidden = brandMode.value !== 'text';
  }
  renderManualLabel();
});
renderManualLabel();
