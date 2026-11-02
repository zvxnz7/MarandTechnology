'use strict';

function inflect(count, full) {
  if (full) {
    if (count === 1) return 'pełna';
    if (count >= 2 && count <= 4) return 'pełne';
    return 'pełnych';
  }
  if (count === 1) return 'pusta';
  if (count >= 2 && count <= 4) return 'puste';
  return 'pustych';
}

function describe(sequence) {
  const raw = String(sequence || '');
  if (!/^[|.]+$/.test(raw)) return '';
  const runs = raw.match(/(\|+|\.+)/g) || [];
  return runs.map(run => `${run.length} ${inflect(run.length, run[0] === '|')}`).join(', ');
}

function parse(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[|.]+$/.test(raw)) return describe(raw);
  const normalized = raw.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const pattern = /(\d+)\s*(pelne|pelnych|pelna|pelny|puste|pustych|pusta|pusty)/g;
  let cursor = 0;
  let sequence = '';
  for (const match of normalized.matchAll(pattern)) {
    const separator = normalized.slice(cursor, match.index);
    if (cursor && !/^[\s,;/]+$/.test(separator)) return '';
    if (!cursor && normalized.slice(0, match.index).trim()) return '';
    const count = Number(match[1]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000) return '';
    const isFull = match[2].startsWith('peln');
    sequence += (isFull ? '|' : '.').repeat(count);
    cursor = match.index + match[0].length;
  }
  if (!sequence || !/^[\s,;/]*$/.test(normalized.slice(cursor))) return '';
  return describe(sequence);
}

module.exports = { describe, parse };
