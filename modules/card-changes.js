'use strict';
const V=require('../views');
function flatten(v) {
 const rows={};
 for(const [group,title,fields] of [['tech','Maszyna',V.TECH],['raw','Dzianina surowa',V.RAW_METRICS],['targets','Dzianina wykończona',V.TARGET_METRICS]])
 for(const [key,label]of fields)rows[`${title} — ${label}`]=v[group]?.[key]||'';
 for(const g of v.gb||[])for(const [key,label]of V.GB)if(key!=='number')rows[`GB${g.number} — ${label}`]=g[key]||'';
 rows['Komentarz do dzianiny surowej']=v.raw_comments||'';
 rows['Komentarz do dzianiny wykończonej']=v.finished_comments||'';
 rows['Warianty wykończenia']=JSON.stringify(v.finished||[]);
 return rows;
}
function changes(before,after){const a=flatten(before),b=flatten(after);return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>(a[k]||'')!==(b[k]||'')).map(k=>({label:k,before:a[k]||'—',after:b[k]||'—'}));}
function notice(db,r,v) {
 if(!r.article_id)return '';
 const old=db.prepare('SELECT c.* FROM cards c JOIN records r ON r.id=c.record_id WHERE r.article_id=? ORDER BY c.id DESC LIMIT 1').get(r.article_id);
 if(!old)return '';
 const diff=changes(JSON.parse(old.snapshot).data,v);if(!diff.length)return '';
 const author=db.prepare("SELECT u.name,a.at FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.record_id=? AND a.action='Zapisano zmiany' ORDER BY a.id DESC LIMIT 1").get(r.id)||db.prepare('SELECT u.name,r.updated_at at FROM records r LEFT JOIN users u ON u.id=r.approved_by WHERE r.id=?').get(r.id);
 return `<section class="change-alert" data-update-alert><h2>Uwaga — karta została zaktualizowana</h2><p>Porównanie z ostatnią kartą wydaną do druku #${old.id} (${V.datepl(old.created_at)}). Ostatnia zmiana danych: <strong>${V.esc(author?.name||'Autor nieznany')}</strong> · ${V.datepl(author?.at)}.</p><table class="change-table"><thead><tr><th>Pole</th><th>Poprzednio</th><th>Teraz</th></tr></thead><tbody>${diff.map(d=>`<tr><td>${V.esc(d.label)}</td><td><del class="previous-value">${V.esc(d.before)}</del></td><td class="changed-value">${V.esc(d.after)}</td></tr>`).join('')}</tbody></table></section>`;
}
module.exports={changes,notice};
