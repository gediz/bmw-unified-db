#!/usr/bin/env -S node --experimental-sqlite
// Assemble all NDJSON layers into dist/bmw.sqlite + dist/json/* views.
// Adds cross-layer ecu_node graph, dimension tables, provenance, and FTS5 search.
// NOTE: SQL(...) is a thin wrapper over node:sqlite's DatabaseSync exec() (NOT shell exec).
import { DatabaseSync } from 'node:sqlite'
import { createReadStream, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'

const ROOT = import.meta.dirname   // the repo root; rebuilds on any clone path
const BUILD = path.join(ROOT, 'build')
const DIST = path.join(ROOT, 'dist')
const DB_PATH = path.join(DIST, 'bmw.sqlite')

mkdirSync(path.join(DIST, 'json', 'variants'), { recursive: true })
if (existsSync(DB_PATH)) rmSync(DB_PATH)
const db = new DatabaseSync(DB_PATH)
const SQL = (s) => db['exec'](s)               // wrapper over node:sqlite statement runner
SQL('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;')

// ---------- schema ----------
SQL(`
CREATE TABLE ecu_variant(sgbd TEXT PRIMARY KEY, ecu_name TEXT, chassis TEXT, revision TEXT,
  comment TEXT, package TEXT, language TEXT, protocol TEXT, is_uds INT, job_count INT,
  table_count INT, has_coding INT, has_flash INT, has_dtc INT, has_actuator INT, file_kind TEXT, ecu_family TEXT,
  coding_example_count INT DEFAULT 0, has_coding_data INT DEFAULT 0, has_routing INT DEFAULT 0, is_stub INT DEFAULT 0,
  has_local_binary INT DEFAULT 0);
CREATE TABLE job(sgbd TEXT, name TEXT, description TEXT, mode TEXT, uds_services TEXT, raw_services TEXT);
CREATE TABLE uds_service(sgbd TEXT, job TEXT, service TEXT, name TEXT, did TEXT, subfn TEXT, protocol TEXT);
CREATE TABLE job_arg(sgbd TEXT, job TEXT, name TEXT, type TEXT, comment TEXT, ord INT);
CREATE TABLE job_result(sgbd TEXT, job TEXT, name TEXT, type TEXT, comment TEXT, ord INT);
CREATE TABLE ecu_table(sgbd TEXT, name TEXT, rows INT, cols INT, columns TEXT);
CREATE TABLE table_row(sgbd TEXT, "table" TEXT, idx INT, cells TEXT);
CREATE TABLE dtc(sgbd TEXT, code TEXT, location_text TEXT, event_dtc INT, source_table TEXT, location_text_en TEXT, en_lang TEXT);
CREATE TABLE english_dtc(sgbd TEXT, code TEXT, location_text_en TEXT, event_dtc INT, lang TEXT, source_table TEXT);
CREATE TABLE english_job(sgbd TEXT, job TEXT, description_en TEXT);
CREATE TABLE vehicle_ecu(chassis TEXT, ecu_group TEXT, sgbd TEXT, ecu_variant TEXT, cbd TEXT, source_file TEXT);
CREATE TABLE option_code(code TEXT, code_raw TEXT, fa TEXT, meaning TEXT, keyword TEXT, chassis TEXT, kind TEXT, section TEXT, source TEXT, source_file TEXT);
CREATE TABLE ecu_bus(scope TEXT, key TEXT, bus TEXT, chassis TEXT, source TEXT, id_dec INT, id_hex TEXT, name TEXT, tx_node TEXT, confidence TEXT, also_on TEXT);
CREATE TABLE coding_variant(chassis TEXT, fsw_label TEXT, fsw_index TEXT, psw_options TEXT, psw_index TEXT, fa_applicability TEXT, coding_block TEXT, individ TEXT, source_file TEXT);
CREATE TABLE ecu_hwnr(hwnr TEXT, ecu_type TEXT, sgbd TEXT, at_hwnr TEXT, ep_tsnr TEXT, at_name TEXT, description TEXT);
CREATE TABLE flash_map(ecu_type TEXT, sgbd TEXT, sg_address TEXT, sg_index TEXT, flash_program TEXT, flash_program_prefix TEXT, flash_driver TEXT, format_flag TEXT, sgid TEXT, at_name TEXT, sgid_source TEXT, programming_protocol TEXT, usage TEXT, description TEXT);
CREATE TABLE measurement(sgbd TEXT, screen TEXT, job TEXT, result TEXT, label TEXT, unit TEXT, scale TEXT, source_file TEXT, type TEXT, format TEXT);
CREATE TABLE can_checksum_algo(id_dec INT, id_hex TEXT, algo TEXT, seed INT, note TEXT);
CREATE TABLE coding_netto(source_car TEXT, ecu_module TEXT, sgbd TEXT, address TEXT, length TEXT, bytes TEXT, state TEXT, source_file TEXT);
CREATE TABLE translation(token TEXT, meaning_en TEXT, source TEXT, meaning_alt TEXT);
-- external openly-licensed layers (each kept under its own license, see CREDITS.md)
CREATE TABLE obd_signal(model TEXT, ecu_header TEXT, did_or_pid TEXT, name TEXT, unit TEXT, scale REAL, offset REAL, bit_offset INT, bit_length INT, signed INT, "values" TEXT, source_repo TEXT, ecu_diag_address TEXT);
CREATE TABLE generic_dtc(code TEXT, description TEXT, category TEXT, is_generic INT);
CREATE TABLE vin_wmi(wmi TEXT, make TEXT, brand TEXT, country TEXT, plant_hint TEXT, source TEXT);
CREATE TABLE vin_position(position TEXT, meaning TEXT);
CREATE TABLE uds_did_standard(did TEXT, name TEXT, range_note TEXT, source TEXT);
CREATE TABLE fdl_code(chassis_family TEXT, ecu_or_cafd TEXT, ecu TEXT, cafd TEXT, fsw_label TEXT, value_label TEXT, value_hex TEXT, meaning TEXT, "group" TEXT, byte_start TEXT, byte_end TEXT, mask TEXT, raw_value TEXT, series TEXT, comment TEXT);
CREATE TABLE routing(sgbd TEXT, ecu_group TEXT, diag_address TEXT, sgbd_index TEXT, chassis TEXT,
  ecu_name TEXT, addr_raw TEXT, source TEXT, source_file TEXT);
CREATE TABLE coding_label(ecu TEXT, chassis TEXT, fsw_label TEXT, psw_values TEXT, psw_options TEXT, meaning TEXT, source TEXT);
CREATE TABLE coding_example(source_car TEXT, ecu_module TEXT, fsw TEXT, psw TEXT, file TEXT, sgbd TEXT, fsw_meaning TEXT, psw_meaning TEXT, is_meta INT, chassis TEXT);
CREATE TABLE ds2_job(ecu TEXT, sgbd TEXT, id TEXT, name TEXT, description TEXT, formatter TEXT, ediabas_job TEXT);
CREATE TABLE ds2_fault(ecu TEXT, sgbd TEXT, kind TEXT, code TEXT, text TEXT);
CREATE TABLE can_message(chassis TEXT, id_dec INT, id_hex TEXT, name TEXT, length INT, tx_node TEXT, comment TEXT, bus TEXT, is_checksum_protected INT);
CREATE TABLE can_signal(message_id_dec INT, name TEXT, start_bit INT, length INT, byte_order TEXT, is_signed INT, factor REAL, offset REAL, min REAL, max REAL, unit TEXT, receivers TEXT, comment TEXT);
CREATE TABLE can_value(message_id_dec INT, signal TEXT, value INT, label TEXT);
`)

const TABLES = {
  ecu_variant: ['sgbd','ecu_name','chassis','revision','comment','package','language','protocol','is_uds','job_count','table_count','has_coding','has_flash','has_dtc','has_actuator','file_kind'],
  job: ['sgbd','name','description','mode','uds_services','raw_services'],
  uds_service: ['sgbd','job','service','name','did','subfn','protocol'],
  job_arg: ['sgbd','job','name','type','comment','ord'],
  job_result: ['sgbd','job','name','type','comment','ord'],
  ecu_table: ['sgbd','name','rows','cols','columns'],
  table_row: ['sgbd','table','idx','cells'],
  dtc: ['sgbd','code','location_text','event_dtc','source_table'],
  routing: ['sgbd','ecu_group','diag_address','sgbd_index','chassis','ecu_name','addr_raw','source','source_file'],
  coding_label: ['ecu','chassis','fsw_label','psw_values','psw_options','meaning','source'],
  coding_example: ['source_car','ecu_module','fsw','psw','file','sgbd','fsw_meaning','psw_meaning','is_meta','chassis'],
  ds2_job: ['ecu','sgbd','id','name','description','formatter','ediabas_job'],
  ds2_fault: ['ecu','sgbd','kind','code','text'],
  can_message: ['chassis','id_dec','id_hex','name','length','tx_node','comment','bus','is_checksum_protected'],
  can_signal: ['message_id_dec','name','start_bit','length','byte_order','is_signed','factor','offset','min','max','unit','receivers','comment'],
  can_value: ['message_id_dec','signal','value','label'],
  english_dtc: ['sgbd','code','location_text_en','event_dtc','lang','source_table'],
  english_job: ['sgbd','job','description_en'],
  vehicle_ecu: ['chassis','ecu_group','sgbd','ecu_variant','cbd','source_file'],
  option_code: ['code','code_raw','fa','meaning','keyword','chassis','kind','section','source','source_file'],
  ecu_bus: ['scope','key','bus','chassis','source','id_dec','id_hex','name','tx_node','confidence','also_on'],
  coding_variant: ['chassis','fsw_label','fsw_index','psw_options','psw_index','fa_applicability','coding_block','individ','source_file'],
  ecu_hwnr: ['hwnr','ecu_type','sgbd','at_hwnr','ep_tsnr','at_name','description'],
  flash_map: ['ecu_type','sgbd','sg_address','sg_index','flash_program','flash_program_prefix','flash_driver','format_flag','sgid','at_name','sgid_source','programming_protocol','usage','description'],
  measurement: ['sgbd','screen','job','result','label','unit','scale','source_file','type','format'],
  can_checksum_algo: ['id_dec','id_hex','algo','seed','note'],
  coding_netto: ['source_car','ecu_module','sgbd','address','length','bytes','state','source_file'],
  translation: ['token','meaning_en','source','meaning_alt'],
  obd_signal: ['model','ecu_header','did_or_pid','name','unit','scale','offset','bit_offset','bit_length','signed','values','source_repo'],
  generic_dtc: ['code','description','category','is_generic'],
  vin_wmi: ['wmi','make','brand','country','plant_hint','source'],
  vin_position: ['position','meaning'],
  uds_did_standard: ['did','name','range_note','source'],
  fdl_code: ['chassis_family','ecu_or_cafd','ecu','cafd','fsw_label','value_label','value_hex','meaning','group','byte_start','byte_end','mask','raw_value','series','comment'],
}
const SOURCES = {
  ecu_variant:'sgbd/ecu_variant', job:'sgbd/job', uds_service:'sgbd/uds_services', job_arg:'sgbd/job_arg',
  job_result:'sgbd/job_result', ecu_table:'sgbd/ecu_table', table_row:'sgbd/table_row', dtc:'sgbd/dtc',
  routing:'routing/routing', coding_label:'coding/coding_label', coding_example:'coding/coding_example',
  ds2_job:'ds2/ds2_job', ds2_fault:'ds2/ds2_fault', can_message:'can/can_message', can_signal:'can/can_signal', can_value:'can/can_value',
  english_dtc:'english/english_dtc', english_job:'english/english_job',
  vehicle_ecu:'applicability/vehicle_ecu', option_code:'applicability/option_code', ecu_bus:'topology/ecu_bus',
  coding_variant:'coding/coding_variant', ecu_hwnr:'flash/ecu_hwnr', flash_map:'flash/flash_map',
  measurement:'measurement/measurement', can_checksum_algo:'can/can_checksum_algo', coding_netto:'coding/coding_netto', translation:'translation/translation',
  obd_signal:'external/obd_signal', generic_dtc:'external/generic_dtc', vin_wmi:'external/vin_wmi',
  vin_position:'external/vin_position', uds_did_standard:'external/uds_did_standard', fdl_code:'external/fdl_code',
}
// columns that hold a JSON array value. NB: vehicle_ecu.chassis is a plain string (single chassis),
// so the loader (which only stringifies objects) leaves it as-is; option_code/ecu_bus chassis are arrays.
const JSONCOLS = new Set(['chassis','uds_services','columns','cells','psw_values','receivers','also_on','psw_options','values'])
// file-path columns are made repo-relative AT LOAD (so the absolute build-host path is never written to disk)
const FILECOLS = new Set(['file','source_file'])
const relPath = (v) => typeof v === 'string'
  ? v.replace(/^.*?\b(BMW_coding|diesel-x5m|bmw-advanced-tools|ediabasx-docs-sgbd|opendbc|openpilot|j2534)\//, '$1/') : v

async function load(tbl) {
  const cols = TABLES[tbl]
  const file = path.join(BUILD, SOURCES[tbl] + '.ndjson')
  if (!existsSync(file)) { console.log(`  ! ${tbl}: source missing`); return 0 }
  const stmt = db.prepare(`INSERT INTO ${tbl} (${cols.map(c=>'"'+c+'"').join(',')}) VALUES (${cols.map(()=>'?').join(',')})`)
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  let n = 0
  SQL('BEGIN')
  for await (const line of rl) {
    if (!line.trim()) continue
    let o; try { o = JSON.parse(line) } catch { continue }
    const vals = cols.map(c => {
      let v = o[c]
      if (v === undefined || v === null) return null
      if (JSONCOLS.has(c) && typeof v === 'object') return JSON.stringify(v)
      if (typeof v === 'boolean') return v ? 1 : 0
      if (FILECOLS.has(c) && typeof v === 'string' && v.includes('/')) return relPath(v)
      return v
    })
    stmt.run(...vals)
    if (++n % 200000 === 0) { SQL('COMMIT'); SQL('BEGIN') }
  }
  SQL('COMMIT')
  console.log(`  ${tbl.padEnd(15)} ${n}`)
  return n
}

console.log('Loading NDJSON -> SQLite ...')
const counts = {}
for (const t of Object.keys(TABLES)) counts[t] = await load(t)

// ---------- normalize / repair before deriving dimensions ----------
console.log('Normalizing (names, orphan stubs, chassis) ...')
// PII: drop author/assignment metadata tables embedded in table_row (names + internal codes; not car data).
// ZUORDNUNGSTABELLE* is a redundant raw copy of the `routing` table (engineer column); ERSTELLER is a creator list.
{ const authorTables = ['ZUORDNUNGSTABELLE','ZUORDNUNGSTABELLEUDS','ZUORDNUNGSTABELLEHYBRID','ZUORDNUNGSTABELLEMOTORRAD','ZUORDNUNGSTABELLEMOTORRADUDS','ERSTELLER']
  const ph = authorTables.map(()=>'?').join(',')
  SQL('BEGIN')
  db.prepare(`DELETE FROM table_row WHERE "table" IN (${ph})`).run(...authorTables)
  db.prepare(`DELETE FROM ecu_table WHERE name IN (${ph})`).run(...authorTables)
  SQL('COMMIT')
  SQL('UPDATE ecu_variant SET table_count = (SELECT COUNT(*) FROM ecu_table t WHERE t.sgbd=ecu_variant.sgbd)')
  // strip incidental author references (a BMW dept code plus a person name, in parentheses) from comments
  const rows = db.prepare("SELECT sgbd, comment FROM ecu_variant WHERE comment GLOB '*BMW [A-Z][A-Z]-*'").all()
  const up = db.prepare('UPDATE ecu_variant SET comment=? WHERE sgbd=?')
  SQL('BEGIN'); for (const r of rows){ const nc = r.comment.replace(/\s*\(?\bBMW\s+[A-Z]{1,3}-[A-Z0-9]+\s+[A-Za-zÄÖÜäöü_]+\)?/g,'').replace(/\s*\(\s*\)/g,'').replace(/\s{2,}/g,' ').trim(); if (nc !== r.comment) up.run(nc, r.sgbd) } SQL('COMMIT')
}
// PII: drop SGBD authorship-metadata result fields (who wrote/edited the SGBD: AUTHOR/ERSTELLER/"Bearbeiter"/
// "Name(n) aller Autoren"). These return a person list at runtime; not car-diagnostic data.
{ SQL('BEGIN')
  db.prepare(`DELETE FROM job_result WHERE name IN ('AUTHOR','AUTHORS','AUTOR','AUTOREN','ERSTELLER','BEARBEITER')
    OR comment LIKE '%aller Autoren%' OR comment LIKE '%Author List%' OR comment LIKE '%Author list%' OR comment = 'Bearbeiter'`).run()
  SQL('COMMIT')
  console.log('  job_result authorship fields dropped')
}
// PII: strip named individuals, BMW internal department codes, and supplier-company attribution from free-text
// job descriptions, keeping the technical remainder. The set is closed (full-census scan); patterns are anchored
// to the authoring boilerplate so no diagnostic text is touched.
{ const rows = db.prepare(`SELECT rowid, description FROM job WHERE description IS NOT NULL AND (
     description LIKE '%Verantwortlich für diesen%' OR description LIKE 'Author:%' OR description LIKE '%Sonderjob für%'
     OR description LIKE '%EA-363%' OR description LIKE '%EA-36%' OR description LIKE '%EI-42%' OR description LIKE '%Johnson Controls%')`).all()
  const up = db.prepare('UPDATE job SET description=? WHERE rowid=?')
  const scrub = (s) => String(s)
    .replace(/Verantwortlich für diesen [Jj]ob:\s*[^,]+,\s*[A-ZÄÖÜ]{2}-\d{2,4}\s*/g, '')        // "...: <name>, <dept> "
    .replace(/Sonderjob für (?:Hr\.|Herr|Fr\.|Frau)\s+[^,]+,\s*[A-ZÄÖÜ]{2}-\d{2,4}\s*/g, '')      // "Sonderjob für Hr. <name>, <dept>"
    .replace(/Author:\s*[^,]+,\s*Johnson Controls\s*/g, '')                                        // "Author: <name>, <company> "
    .replace(/\bAbgestimmt mit EA-363\.?\s*/g, '')                                                 // dept coordination clause
    .replace(/\s*von der EI-42\b!?/g, '!')                                                         // "...von der EI-42!" -> "...!"
    .replace(/\s*\bEA-36\b/g, '')                                                                  // bare dept token
    .replace(/\s*\bJohnson Controls(?:\s+Inc\.|\s+GmbH)?\b/g, '')                                  // residual supplier-company name
    .replace(/\b(?:TI-544|TR-443|EA-363|EA-36|EI-42)\b/g, '')                                      // any residual dept token
    .replace(/\s{2,}/g, ' ').replace(/\s+([.!,;])/g, '$1').trim()
  SQL('BEGIN'); let n = 0; for (const r of rows){ const nc = scrub(r.description); if (nc !== r.description){ up.run(nc || null, r.rowid); n++ } } SQL('COMMIT')
  console.log('  job descriptions scrubbed:', n)
}
// (a) strip address/index annotations that leaked into some ECU names
{ const rows = db.prepare('SELECT sgbd, ecu_name FROM ecu_variant WHERE ecu_name IS NOT NULL').all()
  const up = db.prepare('UPDATE ecu_variant SET ecu_name=? WHERE sgbd=?')
  const clean = s => s.replace(/[\s,;]*\b(SGBD[-\s]?Index\s*[:=]?\s*(0x)?0?F[0-9A-F]+\s*(hex)?|[0-9A-F]{1,2}\s+0F[0-9A-F]{3,5}|0x0F[0-9A-F]+)\s*\.?\s*$/i, '').replace(/\s{2,}/g, ' ').trim()
  SQL('BEGIN'); let n = 0; for (const r of rows){ const c = clean(r.ecu_name); if (c && c !== r.ecu_name){ up.run(c, r.sgbd); n++ } } SQL('COMMIT'); console.log('  cleaned ecu_name:', n) }
// (b) every routing.sgbd should resolve to an ecu_variant row; add minimal stubs for any missing
{ const orphans = db.prepare("SELECT r.sgbd, r.ecu_name, r.chassis FROM routing r LEFT JOIN ecu_variant v ON v.sgbd=r.sgbd WHERE v.sgbd IS NULL GROUP BY r.sgbd").all()
  const ins = db.prepare("INSERT OR IGNORE INTO ecu_variant(sgbd,ecu_name,chassis,protocol,is_uds,job_count,table_count,has_coding,has_flash,has_dtc,has_actuator,file_kind,is_stub) VALUES(?,?,?,?,0,0,0,0,0,0,0,?,1)")
  SQL('BEGIN'); for (const r of orphans) ins.run(r.sgbd, r.ecu_name, r.chassis || '[]', null, 'PRG'); SQL('COMMIT'); console.log('  orphan routing stubs added:', orphans.length) }
// (b2) every coding_example.sgbd should resolve too, so coding data is never dropped from the per-ECU views
{ const orphans = db.prepare("SELECT ce.sgbd, MAX(ce.ecu_module) m, MAX(ce.chassis) ch FROM coding_example ce LEFT JOIN ecu_variant v ON v.sgbd=ce.sgbd WHERE v.sgbd IS NULL AND ce.sgbd IS NOT NULL GROUP BY ce.sgbd").all()
  const ins = db.prepare("INSERT OR IGNORE INTO ecu_variant(sgbd,ecu_name,chassis,protocol,is_uds,job_count,table_count,has_coding,has_flash,has_dtc,has_actuator,file_kind,is_stub) VALUES(?,?,?,?,0,0,0,1,0,0,0,?,1)")
  SQL('BEGIN'); for (const r of orphans){ const ch = r.ch ? (r.ch.startsWith('[') ? r.ch : JSON.stringify([r.ch])) : '[]'; ins.run(r.sgbd, r.m || r.sgbd, ch, null, null) } SQL('COMMIT'); console.log('  coding-only stubs added:', orphans.length) }
// (b3) catch-all: every sgbd referenced by any layer must resolve to an ecu_variant (no dangling links)
{ const refs = db.prepare(`SELECT DISTINCT sgbd FROM (
      SELECT sgbd FROM measurement WHERE sgbd IS NOT NULL
      UNION SELECT sgbd FROM coding_netto WHERE sgbd IS NOT NULL
      UNION SELECT sgbd FROM ecu_hwnr WHERE sgbd IS NOT NULL
      UNION SELECT sgbd FROM flash_map WHERE sgbd IS NOT NULL
      UNION SELECT sgbd FROM ds2_job WHERE sgbd IS NOT NULL
      UNION SELECT sgbd FROM ds2_fault WHERE sgbd IS NOT NULL
    ) WHERE sgbd NOT IN (SELECT sgbd FROM ecu_variant)`).all()
  const nameFor = db.prepare("SELECT COALESCE((SELECT at_name FROM ecu_hwnr WHERE sgbd=:s AND at_name<>'' LIMIT 1),(SELECT ecu_type FROM ecu_hwnr WHERE sgbd=:s LIMIT 1),(SELECT ecu_module FROM coding_netto WHERE sgbd=:s LIMIT 1)) n")
  const ins = db.prepare("INSERT OR IGNORE INTO ecu_variant(sgbd,ecu_name,chassis,protocol,is_uds,job_count,table_count,has_coding,has_flash,has_dtc,has_actuator,file_kind,is_stub) VALUES(?,?,'[]',NULL,0,0,0,0,0,0,0,NULL,1)")
  SQL('BEGIN'); for (const r of refs){ const n = nameFor.get({ s: r.sgbd }).n; ins.run(r.sgbd, n || r.sgbd) } SQL('COMMIT'); console.log('  catch-all sgbd stubs added:', refs.length) }
// (c) fill empty variant chassis from the routing table where available
{ const rt = db.prepare("SELECT sgbd, chassis FROM routing WHERE chassis IS NOT NULL AND chassis<>'[]' GROUP BY sgbd").all()
  const up = db.prepare("UPDATE ecu_variant SET chassis=? WHERE sgbd=? AND (chassis IS NULL OR chassis='[]')")
  SQL('BEGIN'); let n = 0; for (const r of rt){ n += (up.run(r.chassis, r.sgbd).changes || 0) } SQL('COMMIT'); console.log('  chassis filled from routing:', n) }
// (d) UNION chassis from the applicability layer (vehicle_ecu: which ECUs are installed per chassis)
{ const rows = db.prepare("SELECT sgbd, chassis FROM vehicle_ecu WHERE sgbd IS NOT NULL AND chassis IS NOT NULL").all()
  const bySgbd = new Map()
  for (const r of rows){ if(!bySgbd.has(r.sgbd)) bySgbd.set(r.sgbd, new Set()); bySgbd.get(r.sgbd).add(r.chassis) }
  const get = db.prepare('SELECT chassis FROM ecu_variant WHERE sgbd=?')
  const up = db.prepare('UPDATE ecu_variant SET chassis=? WHERE sgbd=?')
  SQL('BEGIN'); let n = 0
  for (const [sgbd, set] of bySgbd){ const cur = get.get(sgbd); if(!cur) continue
    let arr = []; try{ arr = JSON.parse(cur.chassis||'[]') }catch{}
    const merged = Array.from(new Set([...arr, ...set])).sort()
    if (merged.length !== arr.length){ up.run(JSON.stringify(merged), sgbd); n++ } }
  SQL('COMMIT'); console.log('  chassis enriched from applicability:', n) }

// ---------- derive ecu_family ----------
function family(sgbd){
  if(!sgbd) return null
  const m = String(sgbd).toUpperCase().match(/^[A-Z]+/)
  let f = m ? m[0] : sgbd.toUpperCase()
  for (const [re,name] of [[/^ACSM/,'ACSM'],[/^MRS/,'MRS'],[/^SME/,'SME'],[/^HVS/,'HVS'],[/^DME|^ME|^MS|^MSD|^MSV|^MSS|^MEV|^MED|^BMS/,'DME'],[/^DDE|^D\d/,'DDE'],[/^EGS|^GS/,'EGS'],[/^DSC|^ASC|^ABS|^DXC/,'DSC'],[/^IHK/,'IHKA'],[/^KOMB|^IKE|^KMBI/,'KOMBI'],[/^CAS/,'CAS'],[/^EWS/,'EWS'],[/^FRM/,'FRM'],[/^LM|^LCM/,'LM'],[/^JBBF|^JBE/,'JBBF'],[/^CIC|^NBT|^CCC|^MASK/,'HU'],[/^SZL/,'SZL'],[/^ZGW|^ZGM/,'ZGW']]) if(re.test(f)) return name
  return f
}
{ const rows = db.prepare('SELECT sgbd FROM ecu_variant').all()
  const up = db.prepare('UPDATE ecu_variant SET ecu_family=? WHERE sgbd=?')
  SQL('BEGIN'); for (const r of rows) up.run(family(r.sgbd), r.sgbd); SQL('COMMIT') }

// ---------- dimension tables ----------
SQL(`
CREATE TABLE chassis(code TEXT PRIMARY KEY, variant_count INT);
CREATE TABLE chassis_variant(chassis TEXT, sgbd TEXT);
CREATE TABLE ecu_group(code TEXT PRIMARY KEY, ecu_count INT);
CREATE TABLE ecu_family_dim(name TEXT PRIMARY KEY, variant_count INT);
`)
{ const rows = db.prepare('SELECT sgbd, chassis FROM ecu_variant WHERE chassis IS NOT NULL').all()
  const ins = db.prepare('INSERT INTO chassis_variant(chassis,sgbd) VALUES(?,?)')
  const tally = {}
  SQL('BEGIN')
  for (const r of rows){ let arr=[]; try{arr=JSON.parse(r.chassis)}catch{}; for(const c of arr){ ins.run(c,r.sgbd); tally[c]=(tally[c]||0)+1 } }
  SQL('COMMIT')
  const ic = db.prepare('INSERT INTO chassis(code,variant_count) VALUES(?,?)')
  SQL('BEGIN'); for(const [c,n] of Object.entries(tally)) ic.run(c,n); SQL('COMMIT')
}
SQL(`INSERT INTO ecu_group(code,ecu_count) SELECT ecu_group,COUNT(*) FROM routing WHERE ecu_group IS NOT NULL GROUP BY ecu_group;`)
SQL(`INSERT INTO ecu_family_dim(name,variant_count) SELECT ecu_family,COUNT(*) FROM ecu_variant WHERE ecu_family IS NOT NULL GROUP BY ecu_family;`)

// ---------- cross-layer ecu_node master ----------
SQL(`CREATE TABLE ecu_node(node TEXT PRIMARY KEY, label TEXT, has_diag INT, has_routing INT, has_can INT, has_ds2 INT, has_coding INT, variant_count INT);`)
const CAN_NODE_MAP = { DSC:'DSC',DME:'DME',DDE1:'DDE',EGS:'EGS',SZL:'SZL',JBBF:'JBBF',CAS:'CAS',ACSM:'ACSM',ARS:'ARS',LDM:'LDM',ACC:'ACC',Kombi:'KOMBI',IHKA:'IHKA',AFS:'AFS',EPS:'EPS',PDC:'PDC',FRMFA:'FRM',EHC:'EHC',MRSZ:'MRS',KGM:'JBBF',ZGW:'ZGW' }
{
  const node = {}
  const touch = (n)=>{ if(!n) return null; n=String(n).toUpperCase(); node[n] = node[n] || {node:n,has_diag:0,has_routing:0,has_can:0,has_ds2:0,has_coding:0,variant_count:0}; return node[n] }
  for (const r of db.prepare('SELECT ecu_family, COUNT(*) c FROM ecu_variant WHERE ecu_family IS NOT NULL GROUP BY ecu_family').all()){ const x=touch(r.ecu_family); if(x){x.has_diag=1; x.variant_count=r.c} }
  for (const r of db.prepare("SELECT DISTINCT ecu_group FROM routing WHERE ecu_group IS NOT NULL").all()){ const g=r.ecu_group.replace(/^[GD]_/,''); const x=touch(g); if(x) x.has_routing=1 }
  for (const fam of Object.values(CAN_NODE_MAP)){ const x=touch(fam); if(x) x.has_can=1 }
  for (const r of db.prepare("SELECT DISTINCT ecu FROM ds2_job").all()){ const x=touch(r.ecu); if(x) x.has_ds2=1 }
  for (const r of db.prepare("SELECT DISTINCT ecu_module FROM coding_example WHERE ecu_module IS NOT NULL").all()){ const x=touch(String(r.ecu_module).replace(/[0-9_].*$/,'')); if(x) x.has_coding=1 }
  const ins = db.prepare('INSERT OR REPLACE INTO ecu_node(node,label,has_diag,has_routing,has_can,has_ds2,has_coding,variant_count) VALUES(?,?,?,?,?,?,?,?)')
  SQL('BEGIN'); for(const x of Object.values(node)) ins.run(x.node,x.node,x.has_diag,x.has_routing,x.has_can,x.has_ds2,x.has_coding,x.variant_count); SQL('COMMIT')
}

// ---------- indices ----------
console.log('Indices ...')
for (const ix of [
  'CREATE INDEX ix_job_sgbd ON job(sgbd)','CREATE INDEX ix_jobarg ON job_arg(sgbd,job)','CREATE INDEX ix_jobres ON job_result(sgbd,job)',
  'CREATE INDEX ix_uds_sgbd ON uds_service(sgbd)','CREATE INDEX ix_uds_svc ON uds_service(service)',
  'CREATE INDEX ix_tab_sgbd ON ecu_table(sgbd)','CREATE INDEX ix_trow ON table_row(sgbd,"table")',
  'CREATE INDEX ix_dtc_sgbd ON dtc(sgbd)','CREATE INDEX ix_dtc_code ON dtc(code)',
  'CREATE INDEX ix_route_grp ON routing(ecu_group)','CREATE INDEX ix_route_addr ON routing(diag_address)',
  'CREATE INDEX ix_cl_ecu ON coding_label(ecu)','CREATE INDEX ix_ce_mod ON coding_example(ecu_module)',
  'CREATE INDEX ix_csig ON can_signal(message_id_dec)','CREATE INDEX ix_cval ON can_value(message_id_dec,signal)',
  'CREATE INDEX ix_var_fam ON ecu_variant(ecu_family)','CREATE INDEX ix_cv ON chassis_variant(chassis)',
  'CREATE INDEX ix_edtc ON english_dtc(sgbd,code)',
  'CREATE INDEX ix_ve_ch ON vehicle_ecu(chassis)','CREATE INDEX ix_ve_sg ON vehicle_ecu(sgbd)',
  'CREATE INDEX ix_oc ON option_code(code)','CREATE INDEX ix_bus_key ON ecu_bus(scope,key)',
]) SQL(ix)

// ---------- derived presence flags (honest semantics for consumers) ----------
console.log('Derived flags ...')
SQL(`UPDATE ecu_variant SET coding_example_count =
  (SELECT COUNT(*) FROM coding_example ce WHERE ce.sgbd=ecu_variant.sgbd AND COALESCE(ce.is_meta,0)=0)`)
SQL(`UPDATE ecu_variant SET has_coding_data = CASE WHEN coding_example_count>0 THEN 1 ELSE 0 END`)
SQL(`UPDATE ecu_variant SET has_routing =
  (SELECT CASE WHEN EXISTS(SELECT 1 FROM routing r WHERE r.sgbd=ecu_variant.sgbd) THEN 1 ELSE 0 END)`)
// has_local_binary: a local original EDIABAS binary exists, so this ECU was cross-checkable against BMW's data
{ const binPath = path.join(BUILD, 'meta', 'local_binaries.txt')
  if (existsSync(binPath)) {
    const set = new Set(readFileSync(binPath, 'utf8').split('\n').map(s=>s.trim()).filter(Boolean))
    const up = db.prepare('UPDATE ecu_variant SET has_local_binary=1 WHERE sgbd=?')
    SQL('BEGIN'); let n=0; for (const s of set){ n += up.run(s).changes||0 } SQL('COMMIT'); console.log('  has_local_binary set:', n)
  }
}

// ---------- merge English fault text into dtc, but ONLY genuine translations (text must differ from German) ----------
console.log('English DTC join ...')
SQL(`UPDATE dtc SET
  location_text_en = (SELECT e.location_text_en FROM english_dtc e WHERE e.sgbd=dtc.sgbd AND e.code=dtc.code AND e.lang IN ('en','mixed') AND e.location_text_en IS NOT NULL AND e.location_text_en <> dtc.location_text ORDER BY (e.lang='en') DESC LIMIT 1),
  en_lang = (SELECT e.lang FROM english_dtc e WHERE e.sgbd=dtc.sgbd AND e.code=dtc.code AND e.lang IN ('en','mixed') AND e.location_text_en IS NOT NULL AND e.location_text_en <> dtc.location_text ORDER BY (e.lang='en') DESC LIMIT 1)
  WHERE EXISTS (SELECT 1 FROM english_dtc e WHERE e.sgbd=dtc.sgbd AND e.code=dtc.code AND e.lang IN ('en','mixed') AND e.location_text_en IS NOT NULL AND e.location_text_en <> dtc.location_text)`)

// ---------- complete the fault model: type (ART) + freeze-frame environment (with scaling) ----------
// A BMW fault = location code (ORT -> dtc) + type/status code (ART -> dtc_type). Freeze-frame values
// are defined in the environment tables with raw->engineering scaling (value = raw*mul/div + add).
console.log('Fault type + environment dictionaries ...')
// exclude unfilled source templates (codes containing the literal markers X / Y / ?)
SQL(`CREATE TABLE dtc_type AS
  SELECT sgbd, json_extract(cells,'$[0]') AS code, json_extract(cells,'$[1]') AS type_text, "table" AS source_table
  FROM table_row WHERE "table" IN ('FARTTEXTE','IARTTEXTE') AND json_array_length(cells) >= 2
    AND json_extract(cells,'$[0]') NOT GLOB '*X*' AND json_extract(cells,'$[0]') NOT GLOB '*[Yy?]*'`)
// Env tables use 18 different column layouts; MUL/DIV/ADD are NOT at fixed positions. Map by column name.
SQL(`CREATE TABLE dtc_env(sgbd TEXT, code TEXT, text TEXT, unit TEXT, name TEXT, mul TEXT, div TEXT, add_offset TEXT, source_table TEXT)`)
{
  const alias = { code:['UWNR','LABEL'], text:['UWTEXT'], unit:['UW_EINH','UWEINH'], name:['NAME'],
    mul:['MUL','UW_MULT','MUL_WORD'], div:['DIV','UW_DIV'], add_offset:['ADD','UW_ADD'] }
  const envTabs = db.prepare("SELECT sgbd, name, columns FROM ecu_table WHERE name IN ('FUMWELTTEXTE','IUMWELTTEXTE') AND columns IS NOT NULL").all()
  const qRows = db.prepare('SELECT cells FROM table_row WHERE sgbd=? AND "table"=? ORDER BY idx')
  const ins = db.prepare('INSERT INTO dtc_env(sgbd,code,text,unit,name,mul,div,add_offset,source_table) VALUES(?,?,?,?,?,?,?,?,?)')
  // scaling factors are numeric or absent: map placeholders ('-','--','?','') to NULL; treat div=0 as missing
  const numOrNull = (v) => { if (v == null) return null; const s = String(v).trim(); return /^-?\d*\.?\d+$/.test(s) ? s : null }
  const divOrNull = (v) => { const s = numOrNull(v); return (s !== null && parseFloat(s) === 0) ? null : s }
  SQL('BEGIN'); let n = 0
  for (const t of envTabs) {
    let cols = []; try { cols = JSON.parse(t.columns) } catch { continue }
    const up = cols.map(c => String(c).toUpperCase())
    const idx = {}
    for (const [field, names] of Object.entries(alias)) { idx[field] = -1; for (const nm of names){ const i = up.indexOf(nm); if (i >= 0){ idx[field] = i; break } } }
    if (idx.code < 0) idx.code = 0
    for (const r of qRows.all(t.sgbd, t.name)) {
      let cells; try { cells = JSON.parse(r.cells) } catch { continue }
      const g = (i) => (i >= 0 && i < cells.length) ? cells[i] : null
      const code = g(idx.code)
      if (code != null && /[XY?y]/.test(String(code))) continue   // skip unfilled source templates
      ins.run(t.sgbd, code, g(idx.text), g(idx.unit), g(idx.name), numOrNull(g(idx.mul)), divOrNull(g(idx.div)), numOrNull(g(idx.add_offset)), t.name); n++
    }
  }
  SQL('COMMIT'); console.log('  dtc_env (header-aware):', n)
}
// dtc_class is built from the FEHLERKLASSE source table. The query also allows FKLASSE, a variant the
// current pinned corpus does not contain, so a source_table column would be constant and is omitted.
// If a future corpus ever introduces FKLASSE rows, reintroduce `, "table" AS source_table` in the
// SELECT below to keep the two distinguishable.
SQL(`CREATE TABLE dtc_class AS
  SELECT sgbd, json_extract(cells,'$[0]') AS code, json_extract(cells,'$[1]') AS class_text
  FROM table_row WHERE "table" IN ('FEHLERKLASSE','FKLASSE') AND json_array_length(cells) >= 2`)
SQL('CREATE INDEX ix_dtype ON dtc_type(sgbd,code)')
SQL('CREATE INDEX ix_denv ON dtc_env(sgbd,code)')
SQL('CREATE INDEX ix_dclass ON dtc_class(sgbd,code)')
// new-layer indices
for (const ix of [
  'CREATE INDEX ix_cvar_ch ON coding_variant(chassis)','CREATE INDEX ix_cvar_fsw ON coding_variant(fsw_label)',
  'CREATE INDEX ix_hwnr ON ecu_hwnr(hwnr)','CREATE INDEX ix_hwnr_sg ON ecu_hwnr(sgbd)',
  'CREATE INDEX ix_flash_sg ON flash_map(sgbd)','CREATE INDEX ix_meas_sg ON measurement(sgbd)',
  'CREATE INDEX ix_trans ON translation(token)','CREATE INDEX ix_netto_sg ON coding_netto(sgbd)',
]) SQL(ix)
// backfill coding English meanings from the merged translation dictionary where missing
SQL(`UPDATE coding_label SET meaning =
  (SELECT t.meaning_en FROM translation t WHERE t.token = coding_label.fsw_label AND t.meaning_en IS NOT NULL AND t.meaning_en<>'' LIMIT 1)
  WHERE (meaning IS NULL OR meaning='') AND EXISTS (SELECT 1 FROM translation t WHERE t.token=coding_label.fsw_label AND t.meaning_en IS NOT NULL AND t.meaning_en<>'')`)

// ---------- FTS5 search ----------
console.log('FTS5 ...')
SQL(`CREATE VIRTUAL TABLE search USING fts5(kind, key, text);`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'dtc', sgbd||':'||code, location_text FROM dtc WHERE location_text IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'ecu', sgbd, ecu_name FROM ecu_variant WHERE ecu_name IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'job', sgbd||':'||name, description FROM job WHERE description IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'coding', ecu||':'||fsw_label, COALESCE(meaning,fsw_label) FROM coding_label;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'dtc_en', sgbd||':'||code, location_text_en FROM english_dtc WHERE lang IN ('en','mixed') AND location_text_en IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'option', code, meaning FROM option_code WHERE meaning IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'coding_fsw', chassis||':'||fsw_label, fsw_label FROM coding_variant;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'measurement', sgbd||':'||COALESCE(result,''), label FROM measurement WHERE label IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'generic_dtc', code, description FROM generic_dtc WHERE description IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'obd_signal', ecu_header||':'||did_or_pid, name FROM obd_signal WHERE name IS NOT NULL;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'fdl', ecu||':'||fsw_label, COALESCE(meaning,fsw_label) FROM fdl_code;`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'translation', token, meaning_en FROM translation WHERE meaning_en IS NOT NULL AND meaning_en<>'';`)
SQL(`INSERT INTO search(kind,key,text) SELECT 'std_did', did, name FROM uds_did_standard WHERE name IS NOT NULL;`)

// external-layer indices
for (const ix of [
  'CREATE INDEX ix_obd ON obd_signal(did_or_pid)','CREATE INDEX ix_gdtc ON generic_dtc(code)',
  'CREATE INDEX ix_did ON uds_did_standard(did)','CREATE INDEX ix_wmi ON vin_wmi(wmi)','CREATE INDEX ix_fdl ON fdl_code(ecu)',
]) SQL(ix)

// ---------- proper unification: normalize identifiers + a canonical alias resolver ----------
console.log('Proper unification (normalize + alias) ...')
// canonical DID form (0xHEX) so the ISO 14229 standard-name cross-link is exact, not best-effort
SQL("ALTER TABLE uds_service ADD COLUMN did_norm TEXT")
SQL("UPDATE uds_service SET did_norm='0x'||UPPER(REPLACE(REPLACE(REPLACE(did,'0x',''),'0X',''),'$','')) WHERE did IS NOT NULL AND did<>''")
SQL("ALTER TABLE uds_did_standard ADD COLUMN did_norm TEXT")
SQL("UPDATE uds_did_standard SET did_norm='0x'||UPPER(REPLACE(REPLACE(did,'0x',''),'0X',''))")
SQL("CREATE INDEX ix_uds_didnorm ON uds_service(did_norm)")
SQL("CREATE INDEX ix_stddid_norm ON uds_did_standard(did_norm)")
// canonical resolver: any identifier (part number, group, address, sgbd-index, family, type) -> sgbd
SQL("CREATE TABLE ecu_alias(alias_type TEXT, alias TEXT, sgbd TEXT)")
SQL("INSERT INTO ecu_alias SELECT 'sgbd', sgbd, sgbd FROM ecu_variant")
SQL("INSERT INTO ecu_alias SELECT 'family', ecu_family, sgbd FROM ecu_variant WHERE ecu_family IS NOT NULL")
SQL("INSERT INTO ecu_alias SELECT DISTINCT 'ecu_group', ecu_group, sgbd FROM routing WHERE ecu_group IS NOT NULL")
SQL("INSERT INTO ecu_alias SELECT DISTINCT 'sgbd_index', sgbd_index, sgbd FROM routing WHERE sgbd_index IS NOT NULL")
SQL("INSERT INTO ecu_alias SELECT DISTINCT 'diag_address', diag_address, sgbd FROM routing WHERE diag_address IS NOT NULL")
SQL("INSERT INTO ecu_alias SELECT DISTINCT 'hwnr', hwnr, sgbd FROM ecu_hwnr WHERE hwnr IS NOT NULL AND sgbd IS NOT NULL")
SQL("INSERT INTO ecu_alias SELECT DISTINCT 'ecu_type', ecu_type, sgbd FROM ecu_hwnr WHERE ecu_type IS NOT NULL AND sgbd IS NOT NULL")
SQL("INSERT INTO ecu_alias SELECT DISTINCT 'ecu_type', ecu_type, sgbd FROM flash_map WHERE ecu_type IS NOT NULL AND sgbd IS NOT NULL")
SQL("CREATE INDEX ix_alias ON ecu_alias(alias)")
SQL("CREATE INDEX ix_alias_type ON ecu_alias(alias_type, alias)")
// derived ECU diagnostic address for OBDb live signals: UDS response header 0x6XX -> address XX (0x6F1 = tester, skip)
{ const rows = db.prepare("SELECT rowid, ecu_header FROM obd_signal WHERE ecu_header IS NOT NULL").all()
  const up = db.prepare("UPDATE obd_signal SET ecu_diag_address=? WHERE rowid=?")
  SQL('BEGIN'); for (const r of rows){ const m = /^0x6([0-9A-Fa-f]{2})$/i.exec(r.ecu_header); if (m && r.ecu_header.toUpperCase() !== '0X6F1') up.run('0x'+m[1].toUpperCase(), r.rowid) } SQL('COMMIT') }

// ---------- unification views: one lookup per real task, so consumers ignore the 50-table layout ----------
console.log('Unification views ...')
SQL(`CREATE VIEW v_ecu AS
  SELECT v.sgbd, v.ecu_name, v.ecu_family, v.chassis, v.protocol, v.is_uds, v.job_count, v.table_count,
    v.is_stub, v.has_local_binary, v.has_coding, v.has_coding_data, v.coding_example_count, v.has_routing,
    (SELECT r.ecu_group FROM routing r WHERE r.sgbd=v.sgbd LIMIT 1) AS ecu_group,
    (SELECT r.diag_address FROM routing r WHERE r.sgbd=v.sgbd LIMIT 1) AS diag_address,
    (SELECT r.sgbd_index FROM routing r WHERE r.sgbd=v.sgbd LIMIT 1) AS sgbd_index,
    (SELECT b.bus FROM ecu_bus b WHERE b.scope='sgbd' AND b.key=v.sgbd LIMIT 1) AS bus,
    (SELECT COUNT(*) FROM dtc d WHERE d.sgbd=v.sgbd) AS dtc_count,
    (SELECT COUNT(*) FROM measurement m WHERE m.sgbd=v.sgbd) AS measurement_count,
    (SELECT COUNT(*) FROM ecu_hwnr h WHERE h.sgbd=v.sgbd) AS hwnr_count
  FROM ecu_variant v`)
SQL(`CREATE VIEW v_fault AS
  SELECT d.sgbd, d.code AS location_code, d.location_text, d.location_text_en, d.event_dtc, d.source_table
  FROM dtc d`)
SQL(`CREATE VIEW v_coding AS
  SELECT cv.chassis, cv.coding_block, cv.fsw_label,
    COALESCE((SELECT t.meaning_en FROM translation t WHERE LOWER(t.token)=LOWER(cv.fsw_label) AND t.meaning_en<>'' LIMIT 1),
             (SELECT cl.meaning FROM coding_label cl WHERE LOWER(cl.fsw_label)=LOWER(cv.fsw_label) AND cl.meaning IS NOT NULL LIMIT 1)) AS meaning_en,
    cv.psw_options, cv.fa_applicability, cv.individ
  FROM coding_variant cv`)
SQL(`CREATE VIEW v_did AS
  SELECT u.sgbd, u.job, u.service, u.did, u.did_norm,
    (SELECT s.name FROM uds_did_standard s WHERE s.did_norm = u.did_norm LIMIT 1) AS standard_name
  FROM uds_service u WHERE u.did IS NOT NULL`)
SQL(`CREATE VIEW v_resolve AS
  SELECT a.alias_type, a.alias, a.sgbd, v.ecu_name, v.ecu_family
  FROM ecu_alias a LEFT JOIN ecu_variant v ON v.sgbd = a.sgbd`)
SQL(`CREATE VIEW v_coding_all AS
  SELECT 'chassis' AS scope, cv.chassis AS scope_key, NULL AS sgbd, cv.fsw_label, NULL AS psw,
    cv.fa_applicability AS applicability,
    (SELECT t.meaning_en FROM translation t WHERE LOWER(t.token)=LOWER(cv.fsw_label) AND t.meaning_en<>'' LIMIT 1) AS meaning_en,
    'coding_variant (SP-DATEN CVT)' AS source
  FROM coding_variant cv
  UNION ALL
  SELECT 'car', source_car, sgbd, fsw, psw, NULL, COALESCE(fsw_meaning, psw_meaning), 'coding_example (TRC)'
  FROM coding_example WHERE COALESCE(is_meta,0)=0
  UNION ALL
  SELECT 'fchassis', chassis_family, NULL, fsw_label, value_label, NULL, meaning, 'fdl_code (packetpilot, GPL)'
  FROM fdl_code`)
SQL(`CREATE VIEW v_measurement AS
  SELECT sgbd, job, result, label, unit, scale, NULL AS offset, 'inpa:'||COALESCE(source_file,'') AS source FROM measurement
  UNION ALL
  SELECT NULL AS sgbd, NULL AS job, did_or_pid AS result, name AS label, unit, scale, offset, 'obdb:'||COALESCE(source_repo,'') AS source FROM obd_signal`)
SQL(`CREATE VIEW v_vehicle_ecu AS
  SELECT ve.chassis, ve.ecu_group, ve.sgbd, (SELECT ecu_name FROM ecu_variant v WHERE v.sgbd=ve.sgbd) AS ecu_name
  FROM vehicle_ecu ve`)

// ---------- meta / provenance ----------
SQL(`CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);`)
const stats = {}
for (const t of Object.keys(TABLES).concat(['ecu_node','chassis','ecu_group','ecu_family_dim','dtc_type','dtc_env','dtc_class','ecu_alias'])) {
  stats[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}
const variantTotal = db.prepare('SELECT COUNT(*) c FROM ecu_variant').get().c
const decoded = db.prepare("SELECT COUNT(*) c FROM ecu_variant WHERE COALESCE(is_stub,0)=0").get().c
// coverage percentages are against DECODED ECUs (is_stub=0), not catalog stubs, so they reflect real depth
const pct = (n) => { const c = db.prepare(n + " AND COALESCE(is_stub,0)=0").get().c; return `${c}/${decoded} (${(100*c/decoded).toFixed(1)}%)` }
const coverage = {
  records_total: variantTotal,
  decoded_ecus: decoded,
  catalog_stubs: variantTotal - decoded,
  pct_basis: 'percentages below are over the ' + decoded + ' decoded ECUs (stubs excluded)',
  with_routing_addressable: pct("SELECT COUNT(*) c FROM ecu_variant WHERE has_routing=1"),
  with_chassis: pct("SELECT COUNT(*) c FROM ecu_variant WHERE chassis<>'[]'"),
  binary_cross_checkable: pct("SELECT COUNT(*) c FROM ecu_variant WHERE has_local_binary=1"),
  with_coding_data: pct("SELECT COUNT(*) c FROM ecu_variant WHERE has_coding_data=1"),
  supports_coding_service_flag: pct("SELECT COUNT(*) c FROM ecu_variant WHERE has_coding=1"),
  coding_catalog_note: 'bulk coding lives in coding_variant (17,169 chassis-wide labels), not per-ECU; the low with_coding_data % is expected',
  dtc_rows_with_english: `${db.prepare('SELECT COUNT(*) c FROM dtc WHERE location_text_en IS NOT NULL').get().c}/${db.prepare('SELECT COUNT(*) c FROM dtc').get().c}`,
  applicability_scope: 'vehicle_ecu / option_code are E-series + MINI only (SP-DATEN). No F/G/I/U.',
  can_scope: 'can_* covers chassis group E8x_E9x only; ds2_* covers ECU MS43 only.',
  bus_confidence: 'ecu_bus per-ECU rows are heuristic (group-name based); see confidence column. CAN-message buses are high-confidence.',
}
const meta = { generated_from: 'bmw repo collection (ediabasx-docs-sgbd, bmw-advanced-tools, opendbc, openpilot, j2534, BMW_coding, diesel-x5m, packetpilot/bmw-f)',
  row_counts: stats, coverage,
  flag_semantics: 'has_coding/has_flash/has_dtc/has_actuator describe what the ECU SUPPORTS (derived from its jobs); has_coding_data/coding_example_count describe whether THIS DB holds coding values for it. is_stub=1 marks a minimal record created from routing/coding when the SGBD itself was not in the decoded corpus.',
  note: 'wiring/TIS layers intentionally empty (no source data locally).' }
db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('about', JSON.stringify(meta))

// ---------- machine-readable provenance + per-part licensing (the merge is explicit) ----------
console.log('data_source registry ...')
SQL(`CREATE TABLE data_source(layer TEXT, tables TEXT, origin TEXT, upstream TEXT, license TEXT, spdx TEXT, scope_note TEXT, transform TEXT, source_file TEXT)`)
// Structured layer -> input-file provenance. Most dropped "all-same" columns were just this value
// repeated per row; recording it once here, keyed by layer, is the queryable home for it. Where the
// real source varies per row, the discriminating column was kept (named in the value below).
const SOURCE_FILES = {
  'project': null,
  'bus-topology': '(derived: CAN node map + routing + can_message)',
  'diagnostics': 'decoded SGBD pages (one per ECU, keyed by sgbd)',
  'english': 'EnglishEcu/*.prg',
  'routing': 'T_GRTB.PRG',
  'coding-catalog': 'NCSEXPER/DATEN/* (SP-DATEN CVT)',
  'coding-examples': '*FSW_PSW.TRC, NETTODAT.TRC',
  'applicability': '*SGET.000 / *SGVT.000 (per-chassis; see vehicle_ecu.source_file)',
  'flash-id': 'HWNR.DA2, KFCONF10.DA2',
  'measurements': 'INPA SGDAT scripts',
  'translations': 'Translations.csv (two files, merged)',
  'can': 'bmw_e9x_e8x.dbc',
  'can-checksums': 'openpilot selfdrive/car/bmw',
  'ds2': 'reconstructed from SGBD MS430DS0',
  'ext-obdb': 'signalsets/v3/*.json (per-vehicle; see obd_signal.source_repo)',
  'ext-generic-dtc': 'obd-trouble-codes.csv',
  'ext-vin': 'ISO 3779/3780 + NHTSA vPIC',
  'ext-uds-did': 'python-udsoncan DID table',
  'ext-fdl': 'cheats/*.xml',
}
const BMW = 'BMW AG proprietary (included for interoperability / right-to-repair; removable on request)'
const DATA_SOURCES = [
  ['project','assemble.mjs, parsers/*, schema, ecu_node, ecu_alias, ecu_group, chassis*, ecu_*_dim, meta, search, data_source, all v_* views','This project (original work)','(this repo)','MIT','MIT','Permissive. The schema, parsers, cross-links, identity resolver, dimensions, and the compilation itself.','Schema design, parsing, normalization, cross-layer unification.'],
  ['bus-topology','ecu_bus','Derived: opendbc/openpilot CAN bus map + routing group names + can_message','(derived in this repo)','MIT (CAN source); BMW-derived group names','MIT','Per-ECU bus is heuristic from the routing group name; CAN-message buses are high-confidence. See the confidence column.','Derived from a CAN node map plus routing and can_message.'],
  ['diagnostics','ecu_variant, job, uds_service, job_arg, job_result, ecu_table, table_row, dtc, dtc_type, dtc_env, dtc_class','BMW EDIABAS SGBD, via ediabasx-docs-sgbd (emdzej)','github.com/emdzej/ediabasx-docs-sgbd',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted.','Decoded SGBD Markdown parsed to relational tables; fault location/type/env/class derived from SGBD tables, env scaling mapped by column name.'],
  ['english','english_dtc, english_job','BMW EDIABAS EnglishEcu binaries, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted.','PRG binaries decoded (XOR-0xF7) and parsed; only genuine English merged into dtc.'],
  ['routing','routing','BMW T_GRTB.PRG assignment table, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted.','Binary deobfuscated (XOR-0xF7) and parsed to (sgbd, address, sgbd_index, group).'],
  ['coding-catalog','coding_variant, coding_label','BMW SP-DATEN / NCS CVT Codiervarianten, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted.','Softing DATEN containers parsed; FSW/PSW labels resolved via SWTFSW/SWTPSW.'],
  ['coding-examples','coding_example, coding_netto','Applied coding dumps: BMW_coding (dzid26, E82), diesel-x5m (yarik-vv, E70)','github.com/dzid26/BMW_coding, github.com/yarik-vv/diesel-x5m','No license stated by authors','LicenseRef-unspecified','Personal coding traces, attributed; coding semantics are BMW-derived.','NCS TRC FSW_PSW and NETTODAT parsed.'],
  ['applicability','vehicle_ecu, option_code','BMW SP-DATEN, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted.','SGET/SGVT/ZST/AT DATEN parsed.'],
  ['flash-id','ecu_hwnr, flash_map','BMW WinKFP database, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted. Reference only, do not flash.','HWNR.DA2 / KFCONF10 / SGID parsed.'],
  ['measurements','measurement','BMW INPA scripts, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools',BMW,'LicenseRef-BMW-proprietary','BMW copyrighted.','INPA .ips screen/measurement definitions parsed.'],
  ['translations','translation','BMW Coding Tool + NCS Dummy Translations.csv, via bmw-advanced-tools','git.0x45.cz/em/bmw-advanced-tools','Community-contributed BMW token translations','LicenseRef-unspecified','Community data over BMW German tokens.','Both CSVs merged (union, deduped).'],
  ['can','can_message, can_signal, can_value','opendbc bmw_e9x_e8x.dbc (comma.ai, BMW-E8x-E9x fork)','github.com/BMW-E8x-E9x/opendbc','MIT','MIT','Permissive. Community-observed CAN.','DBC parsed.'],
  ['can-checksums','can_checksum_algo','openpilot selfdrive/car/bmw (comma.ai, BMW-E8x-E9x fork)','github.com/BMW-E8x-E9x/openpilot','MIT','MIT','Permissive.','Checksum algorithms extracted from source.'],
  ['ds2','ds2_job, ds2_fault','j2534 MS43 (emdzej), reconstructed from BMW SGBD MS430DS0','github.com/emdzej/j2534','MIT (code); DS2 tables BMW-derived','MIT','MIT tooling; underlying tables BMW-derived.','TS data modules parsed.'],
  ['ext-obdb','obd_signal','OBDb community signalsets','github.com/OBDb','CC-BY-SA-4.0','CC-BY-SA-4.0','SHARE-ALIKE. Redistribution of this layer, including inside this merged DB, is CC-BY-SA-4.0 with attribution to OBDb.','signalsets/v3 JSON flattened.'],
  ['ext-generic-dtc','generic_dtc','mytrile/obd-trouble-codes (ISO 15031 / SAE J2012)','github.com/mytrile/obd-trouble-codes','MIT','MIT','Permissive. Standard generic OBD2 codes.','CSV parsed.'],
  ['ext-vin','vin_wmi, vin_position','NHTSA vPIC + ISO 3779 / Wikibooks','vpic.nhtsa.dot.gov','US public domain (vPIC); CC-BY-SA (reconstructed rows)','CC-BY-SA-4.0 OR LicenseRef-public-domain','vPIC rows public domain; reconstructed rows CC-BY-SA.','WMI table and 17-position rules compiled.'],
  ['ext-uds-did','uds_did_standard','pylessard/python-udsoncan (ISO 14229 DID names)','github.com/pylessard/python-udsoncan','MIT','MIT','Permissive. Standard DID names.','DID table extracted.'],
  ['ext-fdl','fdl_code','packetpilot/bmw-f cheats/*.xml (community FDL cheats)','github.com/packetpilot/bmw-f','GPL-3.0','GPL-3.0-only','COPYLEFT. This layer is GPL-3.0; redistribution carries GPL-3.0 obligations. Underlying byte/mask/value data derives from BMW PSdZData CAFD definitions.','All 21 cheats/*.xml parsed and de-duped on the coding write; F/G/I/RR series.'],
]
{ const ins = db.prepare('INSERT INTO data_source(layer,tables,origin,upstream,license,spdx,scope_note,transform,source_file) VALUES(?,?,?,?,?,?,?,?,?)')
  SQL('BEGIN'); for (const r of DATA_SOURCES) ins.run(...r, SOURCE_FILES[r[0]] ?? null); SQL('COMMIT') }

// ---------- JSON views ----------
console.log('JSON views ...')
function safeJson(s){ if(s==null) return null; try{return JSON.parse(s)}catch{return s} }
// Our own clean schema for the flat ECU index (not modeled on any third-party file).
const slim = db.prepare(`SELECT r.ecu_group AS ecuGroup, v.protocol AS protocol, COALESCE(v.is_uds,0) AS isUds,
  r.diag_address AS diagAddress, r.sgbd_index AS sgbdIndex, r.sgbd AS sgbd, v.ecu_name AS ecuName,
  COALESCE(NULLIF(v.chassis,'[]'), NULLIF(r.chassis,'[]'), '[]') AS chassis, r.source AS routingSource
  FROM routing r LEFT JOIN ecu_variant v ON v.sgbd=r.sgbd ORDER BY r.ecu_group, r.sgbd`).all()
  .map(r => ({ ...r, chassis: safeJson(r.chassis) || [] }))
writeFileSync(path.join(DIST,'json','ecu-index.json'), JSON.stringify(slim))
writeFileSync(path.join(DIST,'json','index.json'), JSON.stringify(meta, null, 2))
const variants = db.prepare('SELECT * FROM ecu_variant').all()
const qJobs = db.prepare('SELECT name,description,mode,uds_services FROM job WHERE sgbd=? ORDER BY rowid')
const qDtc = db.prepare('SELECT code,location_text,location_text_en,en_lang,event_dtc,source_table FROM dtc WHERE sgbd=?')
const qTab = db.prepare('SELECT name,rows,cols,columns FROM ecu_table WHERE sgbd=?')
const qRoute = db.prepare('SELECT ecu_group,diag_address,sgbd_index,source FROM routing WHERE sgbd=?')
const qCoding = db.prepare('SELECT source_car,fsw,psw,fsw_meaning,psw_meaning FROM coding_example WHERE sgbd=? AND COALESCE(is_meta,0)=0')
const qBus = db.prepare("SELECT bus,confidence,also_on FROM ecu_bus WHERE scope='sgbd' AND key=?")
const qType = db.prepare('SELECT code,type_text FROM dtc_type WHERE sgbd=?')
const qEnv = db.prepare('SELECT code,text,unit,name,mul,div,add_offset FROM dtc_env WHERE sgbd=?')
const qMeas = db.prepare('SELECT screen,job,result,label,unit,type,format FROM measurement WHERE sgbd=?')
const qHwnr = db.prepare('SELECT hwnr,at_name,description FROM ecu_hwnr WHERE sgbd=?')
const qFlash = db.prepare('SELECT flash_program,sgid,programming_protocol,usage FROM flash_map WHERE sgbd=?')
const qClass = db.prepare('SELECT code,class_text FROM dtc_class WHERE sgbd=?')
const qNetto = db.prepare('SELECT address,length,bytes,state FROM coding_netto WHERE sgbd=?')
const qEnJob = db.prepare('SELECT job,description_en FROM english_job WHERE sgbd=?')
let written = 0
for (const v of variants) {
  const bus = qBus.get(v.sgbd)
  const doc = { ...v, chassis: safeJson(v.chassis), routing: qRoute.get(v.sgbd) || null,
    bus: bus ? { ...bus, also_on: safeJson(bus.also_on) } : null,
    jobs: qJobs.all(v.sgbd).map(j=>({ ...j, uds_services: safeJson(j.uds_services) })),
    tables: qTab.all(v.sgbd).map(t=>({ ...t, columns: safeJson(t.columns) })),
    dtcs: qDtc.all(v.sgbd),
    dtc_types: qType.all(v.sgbd), dtc_env: qEnv.all(v.sgbd), dtc_classes: qClass.all(v.sgbd),
    measurements: qMeas.all(v.sgbd),
    hardware_numbers: qHwnr.all(v.sgbd), flash: qFlash.all(v.sgbd),
    coding_examples: qCoding.all(v.sgbd),
    coding_netto: qNetto.all(v.sgbd),
    english_jobs: qEnJob.all(v.sgbd) }
  writeFileSync(path.join(DIST,'json','variants', v.sgbd + '.json'), JSON.stringify(doc))
  written++
}

SQL('PRAGMA optimize')
SQL('VACUUM')   // compact + purge free-page remnants (no stale bytes from updates remain in the file)
console.log('\nDONE. Row counts:'); console.log(JSON.stringify(stats,null,1))
console.log(`ecu-index.json: ${slim.length} rows; per-ECU json files: ${written}`)
db.close()
