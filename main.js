import { createClient } from '@supabase/supabase-js';
import {
  PowerSyncDatabase,
  Schema,
  Table,
  column,
  WASQLiteOpenFactory,
  UpdateType
} from '@powersync/web';
import './styles.css';

const SUPABASE_URL = 'https://qbrledhoaufydvjxryce.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nhrn6L3OWbbw4F7DEYv3WQ_nkGCYmgp';
const TABLE_NAME = 'horsehub_legend_lab_feedings';
const DEFAULT_HORSE = 'powersync-lab-horse-1';
const CONFIG_KEY = 'horsehub-powersync-lab-config-v1';
const DB_NAME = 'horsehub-powersync-lab.sqlite';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const schema = new Schema({
  feedings: new Table({
    owner_id: column.text,
    horse_id: column.text,
    label: column.text,
    amount: column.text,
    unit: column.text,
    created_at: column.text,
    updated_at: column.text,
    deleted: column.integer
  }, { indexes: { owner: ['owner_id'], horse: ['horse_id'], updated: ['updated_at'] } })
});

const base = import.meta.env.BASE_URL;
const workerPath = `${base}@powersync/worker.js`;
let db = null;
let connector = null;
let currentSession = null;
let logLines = [];

const state = { status:'Bereit', connected:false, lastError:'', counts:{local:0,cloud:0,pending:0}, rows:[], config:loadConfig() };

function loadConfig(){ try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}')}catch{return {}} }
function saveConfig(){ localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); }
function now(){ return new Date().toISOString(); }
function log(event, payload=''){ const s=`[${new Date().toLocaleTimeString()}] ${event}${payload?` ${typeof payload==='string'?payload:JSON.stringify(payload)}`:''}`; logLines.push(s); logLines=logLines.slice(-180); renderLog(); console.log(s); }
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}

class SupabaseConnector {
  constructor(client){ this.client=client; }
  async fetchCredentials(){
    const {data:{session}} = await this.client.auth.getSession();
    if(!session) return null;
    return { endpoint: state.config.powersyncUrl.trim(), token: session.access_token, userId: session.user.id, expiresAt: session.expires_at ? new Date(session.expires_at*1000) : undefined };
  }
  async uploadData(database){
    const transaction = await database.getNextCrudTransaction();
    if(!transaction) return;
    log('UPLOAD_BATCH_START', {count: transaction.crud.length});
    try{
      for(const op of transaction.crud){
        log('UPLOAD_OP', {op:op.op, table:op.table, id:op.id, data:op.opData});
        let result;
        const table = this.client.from(op.table);
        if(op.op === UpdateType.PUT){
          result = await table.upsert({ ...(op.opData||{}), id: op.id });
        } else if(op.op === UpdateType.PATCH){
          result = await table.update(op.opData||{}).eq('id', op.id);
        } else if(op.op === UpdateType.DELETE){
          result = await table.delete().eq('id', op.id);
        } else {
          throw new Error(`Unbekannte PowerSync-Operation: ${op.op}`);
        }
        if(result.error){
          log('UPLOAD_DB_ERROR', result.error);
          throw result.error;
        }
      }
      await transaction.complete();
      log('UPLOAD_BATCH_COMPLETE');
    } catch(err){
      log('UPLOAD_FAILED', {message:err?.message, code:err?.code, details:err?.details, hint:err?.hint, stack:err?.stack});
      throw err;
    }
  }
}

function createDb(){
  const factory = new WASQLiteOpenFactory({
    logger: { log: (...args)=>console.log('[PowerSync]', ...args) },
    open: { dbFilename: DB_NAME, worker: workerPath }
  });
  return new PowerSyncDatabase({ schema, factory, sync: { worker: workerPath } });
}

async function refreshCloud(){
  if(!currentSession) return;
  const {data,error} = await supabase.from(TABLE_NAME).select('id,owner_id,horse_id,label,amount,unit,created_at,updated_at,deleted').eq('owner_id', currentSession.user.id).order('updated_at',{ascending:false}).limit(100);
  if(error){ log('CLOUD_READ_ERROR', error); return; }
  state.counts.cloud=(data||[]).filter(r=>!r.deleted).length;
  render();
}

async function refreshLocal(){
  if(!db || !currentSession) return;
  const res=await db.getAll(`SELECT * FROM feedings WHERE owner_id = ? AND deleted = 0 ORDER BY updated_at DESC`, [currentSession.user.id]);
  state.rows=res||[]; state.counts.local=state.rows.length;
  try{ state.counts.pending = await db.getNumberOfChangesInQueue(); }catch{ state.counts.pending = 0; }
  render();
}

async function startPowerSync(){
  if(!currentSession){ state.status='Bitte anmelden'; render(); return; }
  if(!state.config.powersyncUrl){ state.status='PowerSync-URL fehlt'; render(); return; }
  try{
    state.status='PowerSync wird gestartet …'; render();
    log('POWERSYNC_INIT_START',{url:state.config.powersyncUrl});
    if(db){ try{await db.disconnect();}catch{} }
    db=createDb();
    await db.init();
    log('POWERSYNC_DB_INIT_OK');
    connector=new SupabaseConnector(supabase);
    await db.connect(connector);
    state.connected=true;
    state.status='PowerSync verbunden';
    log('POWERSYNC_CONNECT_CALLED');
    db.onConnectionStatusChanged?.(()=>render());
    await refreshLocal();
    await refreshCloud();
    state.status='PowerSync aktiv';
    render();
  }catch(err){
    state.connected=false; state.lastError=err?.message||String(err); state.status='PowerSync-Fehler';
    log('POWERSYNC_START_ERROR',{name:err?.name,message:err?.message,code:err?.code,details:err?.details,cause:err?.cause?.message,stack:err?.stack});
    render();
  }
}

async function signIn(email,password){
  const {data,error}=await supabase.auth.signInWithPassword({email,password});
  if(error) throw error;
  currentSession=data.session; log('AUTH_SIGNED_IN',{userId:currentSession.user.id}); await afterLogin();
}
async function signOut(){
  try{await db?.disconnectAndClear?.()}catch{}
  await supabase.auth.signOut(); currentSession=null; state.connected=false; state.status='Abgemeldet'; state.rows=[]; render();
}
async function afterLogin(){
  const {data:{session}}=await supabase.auth.getSession(); currentSession=session;
  if(currentSession){state.status='Angemeldet'; render(); await startPowerSync();}
}

async function addFeeding(){
  if(!db || !currentSession) return;
  const label=document.querySelector('#label').value.trim()||'POWERSYNC TEST';
  const amount=document.querySelector('#amount').value.trim()||'1';
  const unit=document.querySelector('#unit').value.trim()||'kg';
  const horse=document.querySelector('#horse').value.trim()||DEFAULT_HORSE;
  const id=crypto.randomUUID(); const t=now();
  await db.execute(`INSERT INTO feedings (id, owner_id, horse_id, label, amount, unit, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id,currentSession.user.id,horse,label,amount,unit,t,t,0]);
  log('LOCAL_INSERT',{id,label,amount,unit,horse});
  await refreshLocal();
}
async function updateFeeding(id){
  const next=prompt('Neue Bezeichnung:', 'POWERSYNC GEÄNDERT');
  if(!next) return;
  const t=now(); await db.execute(`UPDATE feedings SET label=?, updated_at=? WHERE id=?`,[next,t,id]); log('LOCAL_UPDATE',{id,label:next}); await refreshLocal();
}
async function deleteFeeding(id){
  if(!confirm('Diese Testfütterung lokal löschen?')) return;
  await db.execute(`DELETE FROM feedings WHERE id=?`,[id]); log('LOCAL_DELETE',{id}); await refreshLocal();
}

async function directSupabaseTest(){
  if(!currentSession) return;
  const id=crypto.randomUUID(); const t=now();
  const payload={id,owner_id:currentSession.user.id,horse_id:DEFAULT_HORSE,label:'POWERSYNC DIRECT TEST',amount:'99',unit:'kg',created_at:t,updated_at:t,deleted:false};
  const {error}=await supabase.from(TABLE_NAME).insert(payload);
  if(error){log('DIRECT_SUPABASE_ERROR',error);return;}
  log('DIRECT_SUPABASE_OK',{id}); await refreshCloud();
}
async function forcePush(){
  try{ await db?.uploadData?.(); }catch{}
  await refreshLocal(); await refreshCloud();
}

function render(){
  const app=document.querySelector('#app');
  app.innerHTML=`<main class="wrap">
    <section class="hero"><h1>🧪 HorseHub PowerSync Sync Lab</h1><p>Isolierter Test für lokale SQLite-Datenbank + PowerSync + Supabase. Keine Änderung an HorseHub-Daten.</p></section>
    <section class="card">
      <div class="grid">
        <div class="status"><div class="label">Netzwerk</div><div class="value ok">${navigator.onLine?'online':'offline'}</div></div>
        <div class="status"><div class="label">PowerSync</div><div class="value ${state.connected?'ok':'warn'}">${esc(state.status)}</div></div>
        <div class="status"><div class="label">Benutzer</div><div class="value">${currentSession?esc(currentSession.user.email||currentSession.user.id):'nicht angemeldet'}</div></div>
        <div class="status"><div class="label">Warteschlange</div><div class="value">${state.counts.pending}</div></div>
      </div>
      ${!currentSession?`<div class="row" style="margin-top:12px"><div class="field"><label>E-Mail</label><input id="email" type="email" placeholder="Supabase E-Mail"></div><div class="field"><label>Passwort</label><input id="password" type="password" placeholder="Passwort"></div></div><div class="row"><button class="btn primary" id="login">Anmelden</button></div>`:''}
      ${currentSession?`<div class="row" style="margin-top:12px"><button class="btn primary" id="start">PowerSync verbinden</button><button class="btn" id="reload">Cloud/Local neu laden</button><button class="btn" id="direct">Direkter Supabase-Test</button><button class="btn" id="logout">Abmelden</button></div>`:''}
    </section>
    <section class="card">
      <h2 style="margin-top:0">PowerSync-Konfiguration</h2>
      <div class="field"><label>PowerSync Instance URL</label><input id="powersyncUrl" value="${esc(state.config.powersyncUrl||'')}" placeholder="https://DEINE-INSTANCE.powersync.journeyapps.com"></div>
      <div class="small">Die PowerSync-Instanz muss mit deinem Supabase-Projekt verbunden sein und Supabase Auth verwenden.</div>
      <div class="row" style="margin-top:10px"><button class="btn" id="saveCfg">URL speichern</button><a class="btn" href="https://dashboard.powersync.com/" target="_blank" rel="noreferrer">PowerSync Dashboard</a></div>
    </section>
    <section class="card">
      <h2 style="margin-top:0">Testdaten</h2>
      <div class="row"><div class="field"><label>Bezeichnung</label><input id="label" value="POWERSYNC TEST A"></div><div class="field"><label>Menge</label><input id="amount" value="1"></div><div class="field"><label>Einheit</label><input id="unit" value="kg"></div></div>
      <div class="field"><label>horse_id</label><input id="horse" value="${DEFAULT_HORSE}"></div>
      <div class="row"><button class="btn primary" id="add" ${state.connected?'':'disabled'}>+ Lokal anlegen</button><button class="btn" id="push" ${state.connected?'':'disabled'}>Sync prüfen</button></div>
    </section>
    <section class="card"><h2 style="margin-top:0">Sync-Diagnose</h2><div class="grid"><div class="status"><div class="label">SQLite lokal</div><div class="value">${state.counts.local}</div></div><div class="status"><div class="label">Supabase Cloud</div><div class="value">${state.counts.cloud}</div></div></div><p class="small" style="margin-bottom:0">Lokale Änderungen werden von PowerSync als CRUD-Operationen gepuffert und über den Supabase-Connector hochgeladen.</p></section>
    <section class="card"><h2 style="margin-top:0">Lokale Fütterungen</h2><div class="list">${state.rows.length?state.rows.map(r=>`<div class="item"><strong>${esc(r.label)}</strong><div class="meta">${esc(r.amount)} ${esc(r.unit)} · ${esc(r.horse_id)} · ${esc(r.id)}</div><div class="row" style="margin-top:8px"><button class="btn" data-edit="${r.id}">Ändern</button><button class="btn danger" data-del="${r.id}">Löschen</button></div></div>`).join(''):'<div class="muted">Keine lokalen Datensätze.</div>'}</div></section>
    <section class="card"><h2 style="margin-top:0">Technischer Log</h2><div id="log" class="log"></div></section>
    <div class="help"><strong>Wichtig:</strong> PowerSync benötigt eine konfigurierte PowerSync-Instanz. Der Client verwendet den eingeloggten Supabase-Access-Token zur Authentifizierung an dieser Instanz; lokale CRUD-Änderungen werden anschließend über einen Supabase-Connector hochgeladen. Das entspricht dem offiziellen Supabase/PowerSync-Aufbau.</div>
  </main>`;
  bindEvents(); renderLog();
}
function renderLog(){ const el=document.querySelector('#log'); if(el) el.textContent=logLines.join('\n'); }
function bindEvents(){
  document.querySelector('#login')?.addEventListener('click',async()=>{try{await signIn(document.querySelector('#email').value,document.querySelector('#password').value)}catch(e){log('AUTH_ERROR',e);}});
  document.querySelector('#logout')?.addEventListener('click',signOut);
  document.querySelector('#start')?.addEventListener('click',startPowerSync);
  document.querySelector('#reload')?.addEventListener('click',async()=>{await refreshLocal();await refreshCloud();});
  document.querySelector('#direct')?.addEventListener('click',directSupabaseTest);
  document.querySelector('#saveCfg')?.addEventListener('click',()=>{state.config.powersyncUrl=document.querySelector('#powersyncUrl').value.trim().replace(/\/$/,'');saveConfig();log('CONFIG_SAVED',state.config);});
  document.querySelector('#add')?.addEventListener('click',async()=>{try{await addFeeding()}catch(e){log('LOCAL_INSERT_ERROR',e)}});
  document.querySelector('#push')?.addEventListener('click',forcePush);
  document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>updateFeeding(b.dataset.edit)));
  document.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=>deleteFeeding(b.dataset.del)));
}

supabase.auth.onAuthStateChange((_event, session)=>{ currentSession=session; if(session) afterLogin(); else {state.connected=false;state.status='Abgemeldet';render();} });

if('serviceWorker' in navigator){ window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{})); }

(async()=>{
  try{
    const {data:{session}}=await supabase.auth.getSession();
    currentSession=session;
    if(currentSession) log('AUTH_SESSION_FOUND',{userId:currentSession.user.id});
  }catch(e){log('AUTH_SESSION_ERROR',e)}
  render();
  if(currentSession && state.config.powersyncUrl) await startPowerSync();
})();
