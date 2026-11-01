'use strict';

const fs = require('node:fs');

const [sourcePath, importedRowsPath, outputPath] = process.argv.slice(2);
if (!sourcePath || !importedRowsPath || !outputPath) throw new Error('Usage: node prepare-finishing-recipe-repair.js source-rows.json imported-rows.json output.json');

const rows = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const importedRows = JSON.parse(fs.readFileSync(importedRowsPath, 'utf8'));
const importedSourceRows = new Set(importedRows.map(recipe => Number(recipe.source_row)));
const clean = value => String(value ?? '').trim();
const isDash = value => ['', '-', '--', '—', '–'].includes(clean(value));
const yes = value => /^tak$/i.test(clean(value));
const normalized = value => clean(value).toLocaleLowerCase('pl-PL').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/\s+/g, ' ').trim();

function measurement(value) {
  const raw = clean(value).replace(/,/g, '.');
  if (!raw || isDash(raw)) return null;
  const match = raw.match(/^\s*(min\.?\s*)?(\d+(?:\.\d+)?)\s*(?:[-–—]\s*(\d+(?:\.\d+)?))?\s*$/i);
  if (!match) return null;
  return { minimum: Boolean(match[1]), low: Number(match[2]), high: match[3] ? Number(match[3]) : null };
}

function noteValues(v) {
  return ['Q', 'R', 'S', 'T', 'U'].map(key => clean(v[key])).filter(value => value && !isDash(value));
}

function notesAndBrushing(v) {
  const notes = [];
  let brushing = false;
  let brushingForVelcro = false;
  for (const original of noteValues(v)) {
    const value = original.replace(/\s+/g, ' ').trim();
    const lowered = value.toLocaleLowerCase('pl-PL');
    const isPieceException = /(?:jednej|jedno|pojedyncz\w*)\s+(?:sztuki|sztukę|belki|belk\w*)/.test(lowered);
    const explicitNo = /\bnie\s+(?:drap|wydrap)/i.test(value) && !isPieceException;
    const positiveDrape = /\b(?:drap|wydrap)/i.test(value) && !/\bnie\s+(?:drap|wydrap)/i.test(value);
    if (explicitNo) {
      notes.push('Nie drapać dzianiny.');
      const remainder = value.replace(/\bnie\s+(?:drap|wydrap)\w*\s*(?:dzianin\w*)?\s*[.!,:;–—-]?/i, '').trim();
      if (remainder && !/^[.!,:;–—-]+$/.test(remainder)) notes.push(remainder);
      continue;
    }
    if (positiveDrape) {
      brushing = true;
      if (/pod\s+rzep/i.test(value)) brushingForVelcro = true;
      let remaining = value
        .replace(/^\s*(?:drapanie|wydrapanie|wydrapać|drapać)(?:\s+pod\s+rzep)?\s*[.!:]?\s*/i, '')
        .replace(/^\s*ładnie\s+wydrapać\s*(?:[-–—:,]\s*)?/i, '')
        .replace(/^\s*drapanie\s*(?:[-–—:,]\s*)?/i, '')
        .trim();
      if (!remaining) continue;
      // Preserve the fabric-quality description when the source describes
      // fluffy bales as the result of the brushing operation.
      if (/^puchate\s+belki\.?$/i.test(remaining)) remaining = 'Puchate belki.';
      notes.push(remaining);
      continue;
    }
    notes.push(value);
  }
  return { brushing, brushingForVelcro, notes: [...new Set(notes)] };
}

function processRow(row, rawSymbol) {
  const v = row.values;
  const grammage = measurement(v.F);
  const betweenMatch = clean(v.G).match(/między\s+igłami\s*(\d+(?:[,.]\d+)?)/i);
  const width = betweenMatch ? { low: Number(betweenMatch[1].replace(',', '.')), high: null, minimum: false } : measurement(v.G);
  const complexWidth = !isDash(v.G) && !width;
  const details = {
    tradeSymbol: clean(v.C),
    rawMaterial: clean(v.D),
    widthMode: betweenMatch ? 'needles' : width?.high !== null && width?.high !== undefined ? 'range' : width?.minimum ? 'minimum' : 'exact',
    winding: [v.M, v.N, v.O].map(clean).filter(value => value && !isDash(value) && value !== '?'),
    shrinkage: !isDash(v.P) ? clean(v.P) : '',
  };
  if (grammage?.high !== null && grammage?.high !== undefined) {
    details.grammagePlus = grammage.high - grammage.low;
    details.grammageMinus = 0;
  }
  if (width) {
    if (width.high !== null && width.high !== undefined) {
      details.widthMinimum = width.low;
      details.widthMaximum = width.high;
    } else if (width.minimum) details.widthMinimum = width.low;
    if (betweenMatch) details.widthMode = 'needles';
  }
  const brushing = notesAndBrushing(v);
  if (brushing.brushing) details.brushing = 'yes';
  if (brushing.brushingForVelcro) details.brushingForVelcro = 'yes';

  const stiffening = clean(v.H);
  if (!isDash(stiffening) && !/^nie$/i.test(stiffening)) {
    details.stiffeningEnabled = 'yes';
    if (!/^tak$/i.test(stiffening)) details.stiffeningDescription = stiffening;
  }
  const softening = clean(v.I);
  if (!isDash(softening) && !/^nie$/i.test(softening)) {
    details.softeningEnabled = 'yes';
    if (!/^tak$/i.test(softening)) details.softeningDescription = softening;
  }
  if (yes(v.J)) details.trimEdges = 'yes';
  // Unknown markers are intentionally ignored. Descriptive directives turn
  // the operation on and remain visible as a separately labeled note.
  const bond = clean(v.K);
  if (yes(bond)) details.bondEdges = 'yes';
  else if (bond && !isDash(bond) && bond !== '?') {
    details.bondEdges = 'yes';
    brushing.notes.push(`Podklejanie brzegów: ${bond}`);
  }
  if (yes(v.L)) details.trimSygnits = 'yes';

  const notes = brushing.notes.slice();
  if (complexWidth) notes.push(`Szerokość z arkusza: ${clean(v.G)}`);
  if (!isDash(v.F) && !grammage) notes.push(`Gramatura z arkusza: ${clean(v.F)}`);

  const parsedWidth = betweenMatch ? Number(betweenMatch[1].replace(',', '.')) : width?.low ?? null;
  const parsedGrammage = grammage?.low ?? null;
  return {
    source_row: row.row,
    name: clean(v.B),
    raw_symbol: rawSymbol,
    target_color: clean(v.E),
    target_grammage: parsedGrammage,
    target_width_cm: parsedWidth,
    recipe_details: details,
    notes: [...new Set(notes)].join('\n'),
  };
}

let rawSymbol = '';
const recipes = [];
for (const row of rows) {
  const v = row.values;
  if (!clean(v.B)) continue;
  if (clean(v.A)) rawSymbol = clean(v.A);
  if (!importedSourceRows.has(Number(row.row))) continue;
  const name = normalized(v.B);
  const raw = normalized(rawSymbol);
  if (name === normalized('WT 140 / 01-01 /5/ RÓŻ – AF') && raw === normalized('WT 56-21 (5)')) {
    throw new Error('The pre-existing recipe must not be part of the imported correction list.');
  }
  recipes.push(processRow(row, rawSymbol));
}

if (recipes.length !== importedSourceRows.size) throw new Error(`Expected ${importedSourceRows.size} imported recipes; found ${recipes.length}.`);
const duplicateKeys = new Set();
for (const recipe of recipes) {
  const key = `${normalized(recipe.name)}\u0000${normalized(recipe.raw_symbol)}`;
  if (duplicateKeys.has(key)) throw new Error(`Duplicate source recipe identity at row ${recipe.source_row}: ${recipe.name}`);
  duplicateKeys.add(key);
}
fs.writeFileSync(outputPath, JSON.stringify({ version: 1, source_sheet: 'Dane', expected_recipes: recipes.length, recipes }, null, 2) + '\n', 'utf8');
console.log(`Prepared ${recipes.length} structured recipe corrections.`);
