'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkHealth } = require('../administracja/updater');

test('kontrola uruchomienia podaje ostatni błąd /healthz', async () => {
  let clock=0;
  await assert.rejects(
    checkHealth({health_url:'http://127.0.0.1:8765/healthz',data_dir:'C:\\Marand\\Technologia\\dane'},'0.4.55',{
      timeoutMs:2,
      now:()=>clock++,
      sleep:async()=>{},
      fetchImpl:async()=>({
        status:503,
        ok:false,
        text:async()=>JSON.stringify({ok:false,error:'Database health check failed.'}),
      }),
    }),
    /Nowa wersja 0\.4\.55 nie przeszła kontroli uruchomienia\. Lokalne \/healthz zwraca HTTP 503 lub status niezdrowy: Database health check failed\./,
  );
});
