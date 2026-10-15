'use strict';
let dirty=false,submitting=false;
document.querySelectorAll('form[data-dirty]').forEach(f=>{f.addEventListener('input',()=>dirty=true);f.addEventListener('submit',()=>{submitting=true;});});
window.addEventListener('beforeunload',e=>{if(dirty&&!submitting){e.preventDefault();e.returnValue='';}});
document.querySelectorAll('[data-print]').forEach(b=>b.addEventListener('click',()=>window.print()));
