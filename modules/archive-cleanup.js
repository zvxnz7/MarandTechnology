'use strict';

const fs = require('node:fs');
const path = require('node:path');
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;

// Expired draft records are removed together with their own photo metadata.
// Issued cards and the active article specification are explicit safeguards.
function purgeExpired(db, photosDirectory, { now = Date.now(), removeFile = fs.rmSync, logger = console.error } = {}) {
  const cutoff = new Date(now - RETENTION_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expired = db.prepare(`SELECT r.id,r.base_id FROM records r
    WHERE r.archived_at IS NOT NULL AND r.archived_at<=? AND r.state='draft' AND r.kind IN ('spec','trial')
      AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.record_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.active_spec=r.id)
      AND NOT EXISTS (SELECT 1 FROM records child WHERE child.base_id=r.id AND child.state='approved')
    ORDER BY r.id`).all(cutoff);
  if (!expired.length) return 0;

  const expiredIds = new Set(expired.map(row => Number(row.id)));
  const records = new Map(expired.map(row => [Number(row.id), row]));
  const resolveKeptAncestor = id => {
    let candidate = id == null ? null : Number(id);
    const seen = new Set();
    while (candidate != null && expiredIds.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      candidate = records.get(candidate)?.base_id ?? null;
    }
    return candidate != null && !expiredIds.has(candidate) ? candidate : null;
  };

  const photoFiles = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Keep child records and their payloads; only bypass the expired nodes in
    // the draft lineage so their foreign keys remain valid.
    const children = db.prepare(`SELECT id,base_id FROM records WHERE base_id IN (${[...expiredIds].map(() => '?').join(',')})`).all(...expiredIds);
    const reparent = db.prepare('UPDATE records SET base_id=? WHERE id=?');
    for (const child of children) {
      const parent = records.get(Number(child.base_id));
      reparent.run(resolveKeptAncestor(parent?.base_id), child.id);
    }

    const getPhotos = db.prepare('SELECT file FROM photos WHERE record_id=?');
    const deletePhotos = db.prepare('DELETE FROM photos WHERE record_id=?');
    const deleteRecord = db.prepare('DELETE FROM records WHERE id=?');
    for (const row of expired) {
      photoFiles.push(...getPhotos.all(row.id).map(photo => photo.file));
      deletePhotos.run(row.id);
      deleteRecord.run(row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  for (const file of photoFiles) {
    try { removeFile(path.join(photosDirectory, path.basename(file)), { force: true }); }
    catch (error) { logger(`Nie udało się usunąć zdjęcia z wygasłego wpisu: ${file}`, error); }
  }
  return expired.length;
}

function purgeArticle(db, articleId, photosDirectory, { at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), removeFile = fs.rmSync, logger = console.error } = {}) {
  const files=[];
  db.exec('BEGIN IMMEDIATE');
  try {
    const article=db.prepare('SELECT archived_at,purged_at FROM articles WHERE id=?').get(articleId);
    if(!article||!article.archived_at||article.purged_at)throw new Error('Artykuł nie jest dostępny do usunięcia z archiwum.');
    files.push(...db.prepare('SELECT file FROM photos WHERE article_id=?').all(articleId).map(row=>row.file));
    db.prepare('DELETE FROM photos WHERE article_id=?').run(articleId);
    // Keep the article row as a historical anchor for immutable specifications,
    // issued cards, project stages and links. Hide it from active and archive lists.
    db.prepare('UPDATE articles SET purged_at=? WHERE id=?').run(at,articleId);
    db.exec('COMMIT');
  } catch(error) { try{db.exec('ROLLBACK');}catch{} throw error; }
  for(const file of files) {
    try { removeFile(path.join(photosDirectory,path.basename(file)),{force:true}); }
    catch(error) { logger(`Nie udało się usunąć zdjęcia artykułu z archiwum: ${file}`,error); }
  }
  return 1;
}

function purgeExpiredArticles(db, photosDirectory, { now = Date.now(), removeFile = fs.rmSync, logger = console.error } = {}) {
  const cutoff=new Date(now-RETENTION_MS).toISOString().replace(/\.\d{3}Z$/,'Z');
  const rows=db.prepare('SELECT id FROM articles WHERE archived_at IS NOT NULL AND archived_at<=? AND purged_at IS NULL ORDER BY id').all(cutoff);
  let count=0;
  for(const row of rows) {
    try { count+=purgeArticle(db,row.id,photosDirectory,{at:new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z'),removeFile,logger}); }
    catch(error) { logger(`Nie udało się oczyścić zarchiwizowanego artykułu #${row.id}:`,error); }
  }
  return count;
}

module.exports = { purgeExpired, purgeArticle, purgeExpiredArticles, RETENTION_MS };
