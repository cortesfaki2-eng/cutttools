const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'cuttools.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, access_token TEXT NOT NULL, ig_account_id TEXT NOT NULL UNIQUE, username TEXT, label TEXT, account_type TEXT DEFAULT 'BUSINESS', posts_per_day INTEGER DEFAULT 40, start_time TEXT DEFAULT '02:00', end_time TEXT DEFAULT '23:00', interval_minutes INTEGER DEFAULT 31, interval_mode TEXT DEFAULT 'inteligente', status TEXT DEFAULT 'active', total_posts INTEGER DEFAULT 0, added_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);
  db.run(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, username TEXT, original_name TEXT, batch_name TEXT, b2_url TEXT DEFAULT '', b2_file_id TEXT DEFAULT '', b2_file_name TEXT DEFAULT '', bytes INTEGER DEFAULT 0, duration REAL DEFAULT 0, caption TEXT DEFAULT '', hashtags TEXT DEFAULT '', cycle INTEGER DEFAULT 1, scheduled_for TEXT, status TEXT DEFAULT 'pendente', ig_post_id TEXT, posted_at TEXT, error_msg TEXT, retries INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vs ON videos(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_va ON videos(account_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vsch ON videos(scheduled_for);`);
  persist();
  setInterval(persist, 30000);
  return db;
}

function persist() {
  if (!db) return;
  try { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); } catch(e) { console.error('[DB]', e.message); }
}

function run(sql, p=[]) { db.run(sql, p); }
function get(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const r=s.step()?s.getAsObject():null; s.free(); return r; }
function all(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const rows=[]; while(s.step()) rows.push(s.getAsObject()); s.free(); return rows; }

function getSetting(k) { const r=get('SELECT value FROM settings WHERE key=?',[k]); return r?r.value:null; }
function setSetting(k,v) { run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',[k,v]); persist(); }
function getAllSettings() { const rows=all('SELECT key,value FROM settings'); const o={}; rows.forEach(r=>o[r.key]=r.value); return o; }

function getAccounts() { return all('SELECT * FROM accounts ORDER BY added_at DESC').map(mapA); }
function getAccountById(id) { return mapA(get('SELECT * FROM accounts WHERE id=?',[id])); }
function getAccountByIgId(igId) { return mapA(get('SELECT * FROM accounts WHERE ig_account_id=?',[igId])); }
function insertAccount(a) {
  run('INSERT INTO accounts(id,access_token,ig_account_id,username,label,account_type,posts_per_day,start_time,end_time,interval_minutes,interval_mode,status,total_posts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [a.id,a.accessToken,a.igAccountId,a.username,a.label,a.accountType||'BUSINESS',a.postsPerDay||40,a.startTime||'02:00',a.endTime||'23:00',a.intervalMinutes||31,a.intervalMode||'inteligente',a.status||'active',a.totalPosts||0]);
  persist(); return getAccountById(a.id);
}
function updateAccount(id, patch) {
  const map={accessToken:'access_token',username:'username',label:'label',postsPerDay:'posts_per_day',startTime:'start_time',endTime:'end_time',intervalMinutes:'interval_minutes',intervalMode:'interval_mode',status:'status',totalPosts:'total_posts'};
  const f=[],v=[];
  for(const[k,col] of Object.entries(map)) if(patch[k]!==undefined){f.push(col+' = ?');v.push(patch[k]);}
  if(!f.length) return getAccountById(id);
  f.push("updated_at=datetime('now')"); v.push(id);
  run('UPDATE accounts SET '+f.join(', ')+' WHERE id=?',v); persist(); return getAccountById(id);
}
function deleteAccount(id) { run('DELETE FROM videos WHERE account_id=?',[id]); run('DELETE FROM accounts WHERE id=?',[id]); persist(); }

function getVideos({accountId,status,date,limit=300,offset=0}={}) {
  let sql='SELECT * FROM videos WHERE 1=1'; const p=[];
  if(accountId&&accountId!=='all'){sql+=' AND account_id=?';p.push(accountId);}
  if(status&&status!=='todos'){sql+=' AND status=?';p.push(status);}
  if(date){sql+=' AND DATE(scheduled_for)=?';p.push(date);}
  sql+=' ORDER BY scheduled_for ASC LIMIT ? OFFSET ?'; p.push(limit,offset);
  return all(sql,p).map(mapV);
}
function getVideoCounts(accountId) {
  let sql='SELECT status, COUNT(*) as cnt FROM videos'; const p=[];
  if(accountId&&accountId!=='all'){sql+=' WHERE account_id=?';p.push(accountId);}
  sql+=' GROUP BY status';
  const rows=all(sql,p); const c={todos:0,pendente:0,processando:0,postado:0,erro:0,cancelado:0};
  rows.forEach(r=>{c[r.status]=r.cnt;c.todos+=r.cnt;}); return c;
}
function getVideoById(id) { return mapV(get('SELECT * FROM videos WHERE id=?',[id])); }
function getPendingVideos() { return all("SELECT * FROM videos WHERE status IN ('pendente','processando') ORDER BY scheduled_for ASC").map(mapV); }
function insertVideo(v) {
  run('INSERT INTO videos(id,account_id,username,original_name,batch_name,b2_url,b2_file_id,b2_file_name,bytes,duration,caption,hashtags,cycle,scheduled_for,status,retries) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [v.id,v.accountId,v.username,v.originalName,v.batchName||v.originalName,v.b2Url||'',v.b2FileId||'',v.b2FileName||'',v.bytes||0,v.duration||0,v.caption||'',v.hashtags||'',v.cycle||1,v.scheduledFor,v.status||'pendente',0]);
  persist(); return getVideoById(v.id);
}
function updateVideo(id, patch) {
  const map={status:'status',igPostId:'ig_post_id',postedAt:'posted_at',errorMsg:'error_msg',retries:'retries',scheduledFor:'scheduled_for',b2Url:'b2_url'};
  const f=[],v=[];
  for(const[k,col] of Object.entries(map)) if(patch[k]!==undefined){f.push(col+' = ?');v.push(patch[k]);}
  if(!f.length) return getVideoById(id);
  f.push("updated_at=datetime('now')"); v.push(id);
  run('UPDATE videos SET '+f.join(', ')+' WHERE id=?',v); persist(); return getVideoById(id);
}
function deleteVideo(id) { run('DELETE FROM videos WHERE id=?',[id]); persist(); }
function cancelPendingVideos(accountId) {
  if(accountId&&accountId!=='all') run("UPDATE videos SET status='cancelado',updated_at=datetime('now') WHERE account_id=? AND status='pendente'",[accountId]);
  else run("UPDATE videos SET status='cancelado',updated_at=datetime('now') WHERE status='pendente'");
  persist();
}
function getStats() {
  const rows=all('SELECT status, COUNT(*) as cnt FROM videos GROUP BY status');
  const s={total:0,pendente:0,processando:0,postado:0,erro:0,cancelado:0};
  rows.forEach(r=>{s[r.status]=r.cnt;s.total+=r.cnt;});
  s.accounts=(get('SELECT COUNT(*) as cnt FROM accounts')||{cnt:0}).cnt; return s;
}

function mapA(r) { if(!r)return null; return{id:r.id,accessToken:r.access_token,igAccountId:r.ig_account_id,username:r.username,label:r.label,accountType:r.account_type,postsPerDay:r.posts_per_day,startTime:r.start_time,endTime:r.end_time,intervalMinutes:r.interval_minutes,intervalMode:r.interval_mode,status:r.status,totalPosts:r.total_posts,addedAt:r.added_at,updatedAt:r.updated_at}; }
function mapV(r) { if(!r)return null; return{id:r.id,accountId:r.account_id,username:r.username,originalName:r.original_name,batchName:r.batch_name,b2Url:r.b2_url,cloudinaryUrl:r.b2_url,b2FileId:r.b2_file_id,b2FileName:r.b2_file_name,bytes:r.bytes,duration:r.duration,caption:r.caption,hashtags:r.hashtags,cycle:r.cycle,scheduledFor:r.scheduled_for,status:r.status,igPostId:r.ig_post_id,postedAt:r.posted_at,errorMsg:r.error_msg,retries:r.retries,createdAt:r.created_at,updatedAt:r.updated_at}; }

module.exports = { init, persist, getSetting, setSetting, getAllSettings, getAccounts, getAccountById, getAccountByIgId, insertAccount, updateAccount, deleteAccount, getVideos, getVideoCounts, getVideoById, getPendingVideos, insertVideo, updateVideo, deleteVideo, cancelPendingVideos, getStats };
