#!/usr/bin/env node
// Verifies the PRODUCTION sequence: sendText* -> flush (continue:true,flush:true)
// -> [NO more text] -> continue:false -> expect single clean `done`.
// Attack #1 from the pre-deploy audit. Temp probe — delete after.
import WebSocket from 'ws';
const KEY = process.env.CARTESIA_API_KEY;
const VOICE = process.env.CARTESIA_VOICE_ID || process.env.CARTESIA_TEST_VOICE_ID;
if (!KEY || !VOICE) { console.error('need CARTESIA_API_KEY + CARTESIA_VOICE_ID'); process.exit(2); }
const URL_ = 'wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-03-01';
const SR = 24000, MODEL = 'sonic-3', CTX = 'flush-term-probe:9';
const block = { model_id: MODEL, voice: { mode:'id', id:VOICE }, output_format:{ container:'raw', encoding:'pcm_s16le', sample_rate:SR } };
const ws = new WebSocket(URL_, { headers: { 'X-API-Key': KEY }, perMessageDeflate:false });
const ev = []; let chunks=0, flushDone=false, done=false, err=null, doneCount=0;
const t0=Date.now(); const ms=()=>Date.now()-t0;
ws.on('open', async () => {
  console.log(`[${ms()}] open`);
  ws.send(JSON.stringify({ ...block, context_id:CTX, transcript:'The most important thing to focus on is your daily habits and the systems around them.', continue:true }));
  await new Promise(r=>setTimeout(r,300));
  ws.send(JSON.stringify({ ...block, context_id:CTX, transcript:'', continue:true, flush:true }));
  console.log(`[${ms()}] sent FLUSH`);
  await new Promise(r=>setTimeout(r,1500));
  ws.send(JSON.stringify({ ...block, context_id:CTX, transcript:'', continue:false }));
  console.log(`[${ms()}] sent continue:false (NO text between flush and this)`);
});
ws.on('message', (d, isBin) => {
  if (isBin) return; let m; try { m=JSON.parse(d.toString()); } catch { return; }
  if (m.type==='chunk') chunks++;
  else if (m.type==='flush_done') { flushDone=true; ev.push(`[${ms()}] flush_done id=${m.flush_id} (chunks so far=${chunks})`); }
  else if (m.type==='done') { done=true; doneCount++; ev.push(`[${ms()}] done #${doneCount} (chunks=${chunks})`); }
  else if (m.type==='error') { err=m; ev.push(`[${ms()}] ERROR ${JSON.stringify(m)}`); }
});
setTimeout(() => {
  try { ws.close(); } catch {}
  console.log('\n--- events ---'); ev.forEach(e=>console.log('  '+e));
  console.log('\n--- verdict ---');
  console.log(`  A. no error frame.................. ${err?'FAIL '+JSON.stringify(err):'PASS'}`);
  console.log(`  B. exactly one `+'`done`'+`........... ${doneCount===1?'PASS':'FAIL ('+doneCount+')'}`);
  console.log(`  C. flush_done seen................ ${flushDone?'PASS':'FAIL'}`);
  console.log(`  D. got audio chunks............... ${chunks>0?'PASS ('+chunks+')':'FAIL'}`);
  process.exit((!err && doneCount===1 && chunks>0)?0:1);
}, 12000);
