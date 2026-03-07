const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'cuttools.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;

// ── Hash de senha ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === test;
}

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  // ── Tabelas originais ──
  db.run(`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT DEFAULT NULL, access_token TEXT NOT NULL, ig_account_id TEXT NOT NULL UNIQUE, username TEXT, label TEXT, account_type TEXT DEFAULT 'BUSINESS', posts_per_day INTEGER DEFAULT 40, start_time TEXT DEFAULT '02:00', end_time TEXT DEFAULT '23:00', interval_minutes INTEGER DEFAULT 31, interval_mode TEXT DEFAULT 'inteligente', status TEXT DEFAULT 'active', total_posts INTEGER DEFAULT 0, added_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);
  db.run(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, user_id TEXT DEFAULT NULL, account_id TEXT NOT NULL, username TEXT, original_name TEXT, batch_name TEXT, b2_url TEXT DEFAULT '', b2_file_id TEXT DEFAULT '', b2_file_name TEXT DEFAULT '', bytes INTEGER DEFAULT 0, duration REAL DEFAULT 0, caption TEXT DEFAULT '', hashtags TEXT DEFAULT '', cycle INTEGER DEFAULT 1, scheduled_for TEXT, status TEXT DEFAULT 'pendente', ig_post_id TEXT, posted_at TEXT, error_msg TEXT, retries INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);

  // Migration: adicionar user_id nas tabelas antigas se não existir
  try { db.run(`ALTER TABLE accounts ADD COLUMN user_id TEXT DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE videos ADD COLUMN user_id TEXT DEFAULT NULL`); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vs ON videos(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_va ON videos(account_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vsch ON videos(scheduled_for);`);

  // ── Tabelas de autenticação (NOVAS) ──
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    phone TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    login_count INTEGER DEFAULT 0,
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    email TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs(created_at DESC);`);

  // ── Criar admin padrão se não existir nenhum user ──
  const userCount = get('SELECT COUNT(*) as cnt FROM users');
  if (!userCount || userCount.cnt === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@admin.com';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const { v4: uuid } = require('uuid');
    run('INSERT INTO users (id, email, name, password_hash, role, plan, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), adminEmail, 'Administrador', hashPassword(adminPass), 'admin', 'enterprise', 'active']);
    console.log(`[Auth] Admin criado: ${adminEmail} / ${adminPass}`);
    console.log(`[Auth] ⚠️  TROQUE A SENHA do admin após o primeiro login!`);
  }

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

// ══ AUTH FUNCTIONS (NOVAS) ═══════════════════════════════════════

function createUser({ id, email, name, password, role, plan }) {
  const hash = hashPassword(password);
  run('INSERT INTO users (id, email, name, password_hash, role, plan, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, email.toLowerCase().trim(), name.trim(), hash, role || 'user', plan || 'free', 'active']);
  persist();
  return getUserById(id);
}

function getUserById(id) {
  const r = get('SELECT * FROM users WHERE id = ?', [id]);
  return r ? mapUser(r) : null;
}

function getUserByEmail(email) {
  const r = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  return r ? mapUser(r) : null;
}

function authenticateUser(email, password) {
  const r = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!r) return null;
  if (!verifyPassword(password, r.password_hash)) return null;
  if (r.status === 'suspended') return { error: 'suspended' };
  // Update login count
  run("UPDATE users SET login_count = login_count + 1, last_login = datetime('now') WHERE id = ?", [r.id]);
  persist();
  return mapUser(r);
}

function getAllUsers() {
  return all('SELECT * FROM users ORDER BY created_at DESC').map(mapUser);
}

function updateUser(id, patch) {
  const allowed = { name: 'name', email: 'email', phone: 'phone', bio: 'bio', role: 'role', plan: 'plan', status: 'status' };
  const f = [], v = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { f.push(col + ' = ?'); v.push(patch[k]); }
  }
  if (patch.password) {
    f.push('password_hash = ?');
    v.push(hashPassword(patch.password));
  }
  if (!f.length) return getUserById(id);
  v.push(id);
  run('UPDATE users SET ' + f.join(', ') + ' WHERE id = ?', v);
  persist();
  return getUserById(id);
}

function deleteUser(id) {
  run('DELETE FROM sessions WHERE user_id = ?', [id]);
  run('DELETE FROM users WHERE id = ?', [id]);
  persist();
}

// Sessions
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 dias
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expires]);
  persist();
  return token;
}

function getSession(token) {
  if (!token) return null;
  const r = get('SELECT * FROM sessions WHERE token = ? AND expires_at > datetime(?)', [token, new Date().toISOString()]);
  if (!r) return null;
  return { token: r.token, userId: r.user_id, expiresAt: r.expires_at };
}

function deleteSession(token) {
  run('DELETE FROM sessions WHERE token = ?', [token]);
  persist();
}

function cleanExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at < datetime('now')");
}

// Activity Logs
function logActivity(userId, email, action, detail) {
  const { v4: uuid } = require('uuid');
  run('INSERT INTO activity_logs (id, user_id, email, action, detail) VALUES (?, ?, ?, ?, ?)',
    [uuid(), userId, email, action, detail || '']);
  persist();
}

function getActivityLogs(limit = 200) {
  return all('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?', [limit]);
}

function mapUser(r) {
  if (!r) return null;
  return {
    id: r.id, email: r.email, name: r.name, role: r.role, plan: r.plan,
    status: r.status, phone: r.phone || '', bio: r.bio || '',
    loginCount: r.login_count, lastLogin: r.last_login, createdAt: r.created_at
  };
}

// ══ ORIGINAL FUNCTIONS ═══════════════════════════════════════════

function getSetting(k) { const r=get('SELECT value FROM settings WHERE key=?',[k]); return r?r.value:null; }
function setSetting(k,v) { run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',[k,v]); persist(); }
function getAllSettings() { const rows=all('SELECT key,value FROM settings'); const o={}; rows.forEach(r=>o[r.key]=r.value); return o; }

function getAccounts(userId=null, isAdmin=false) {
  if (isAdmin || !userId) return all('SELECT * FROM accounts ORDER BY added_at DESC').map(mapA);
  return all('SELECT * FROM accounts WHERE user_id=? ORDER BY added_at DESC', [userId]).map(mapA);
}
function getAccountById(id) { return mapA(get('SELECT * FROM accounts WHERE id=?',[id])); }
function getAccountByIdForUser(id, userId, isAdmin=false) {
  if (isAdmin || !userId) return mapA(get('SELECT * FROM accounts WHERE id=?',[id]));
  return mapA(get('SELECT * FROM accounts WHERE id=? AND user_id=?',[id, userId]));
}
function getAccountByIgId(igId) { return mapA(get('SELECT * FROM accounts WHERE ig_account_id=?',[igId])); }
function insertAccount(a) {
  run('INSERT INTO accounts(id,user_id,access_token,ig_account_id,username,label,account_type,posts_per_day,start_time,end_time,interval_minutes,interval_mode,status,total_posts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [a.id,a.userId||null,a.accessToken,a.igAccountId,a.username,a.label,a.accountType||'BUSINESS',a.postsPerDay||40,a.startTime||'02:00',a.endTime||'23:00',a.intervalMinutes||31,a.intervalMode||'inteligente',a.status||'active',a.totalPosts||0]);
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

function getVideos({accountId,status,date,limit=300,offset=0,userId=null,isAdmin=false}={}) {
  let sql='SELECT * FROM videos WHERE 1=1'; const p=[];
  if(!isAdmin && userId){sql+=' AND user_id=?';p.push(userId);}
  if(accountId&&accountId!=='all'){sql+=' AND account_id=?';p.push(accountId);}
  if(status&&status!=='todos'){sql+=' AND status=?';p.push(status);}
  if(date){sql+=' AND DATE(scheduled_for)=?';p.push(date);}
  sql+=' ORDER BY scheduled_for ASC LIMIT ? OFFSET ?'; p.push(limit,offset);
  return all(sql,p).map(mapV);
}
function getVideoCounts(accountId, userId=null, isAdmin=false) {
  let sql='SELECT status, COUNT(*) as cnt FROM videos WHERE 1=1'; const p=[];
  if(!isAdmin && userId){sql+=' AND user_id=?';p.push(userId);}
  if(accountId&&accountId!=='all'){sql+=' AND account_id=?';p.push(accountId);}
  sql+=' GROUP BY status';
  const rows=all(sql,p); const c={todos:0,pendente:0,processando:0,postado:0,erro:0,cancelado:0};
  rows.forEach(r=>{c[r.status]=r.cnt;c.todos+=r.cnt;}); return c;
}
function getVideoById(id) { return mapV(get('SELECT * FROM videos WHERE id=?',[id])); }
function getPendingVideos() { return all("SELECT * FROM videos WHERE status IN ('pendente','processando') ORDER BY scheduled_for ASC").map(mapV); }
function insertVideo(v) {
  run('INSERT INTO videos(id,user_id,account_id,username,original_name,batch_name,b2_url,b2_file_id,b2_file_name,bytes,duration,caption,hashtags,cycle,scheduled_for,status,retries) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [v.id,v.userId||null,v.accountId,v.username,v.originalName,v.batchName||v.originalName,v.b2Url||'',v.b2FileId||'',v.b2FileName||'',v.bytes||0,v.duration||0,v.caption||'',v.hashtags||'',v.cycle||1,v.scheduledFor,v.status||'pendente',0]);
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
function cancelPendingVideos(accountId, userId=null, isAdmin=false) {
  if(accountId&&accountId!=='all'){
    if(!isAdmin && userId) run("UPDATE videos SET status='cancelado',updated_at=datetime('now') WHERE account_id=? AND user_id=? AND status='pendente'",[accountId, userId]);
    else run("UPDATE videos SET status='cancelado',updated_at=datetime('now') WHERE account_id=? AND status='pendente'",[accountId]);
  } else {
    if(!isAdmin && userId) run("UPDATE videos SET status='cancelado',updated_at=datetime('now') WHERE user_id=? AND status='pendente'",[userId]);
    else run("UPDATE videos SET status='cancelado',updated_at=datetime('now') WHERE status='pendente'");
  }
  persist();
}
function getStats(userId=null, isAdmin=false) {
  let videoSql = "SELECT status, COUNT(*) as cnt FROM videos";
  let accountSql = "SELECT COUNT(*) as cnt FROM accounts";
  const p = [];
  if(!isAdmin && userId){ videoSql += " WHERE user_id=?"; accountSql += " WHERE user_id=?"; p.push(userId); }
  videoSql += " GROUP BY status";
  const rows=all(videoSql, p);
  const s={total:0,pendente:0,processando:0,postado:0,erro:0,cancelado:0};
  rows.forEach(r=>{s[r.status]=r.cnt;s.total+=r.cnt;});
  s.accounts=(get(accountSql, p)||{cnt:0}).cnt; return s;
}

function mapA(r) { if(!r)return null; return{id:r.id,accessToken:r.access_token,igAccountId:r.ig_account_id,username:r.username,label:r.label,accountType:r.account_type,postsPerDay:r.posts_per_day,startTime:r.start_time,endTime:r.end_time,intervalMinutes:r.interval_minutes,intervalMode:r.interval_mode,status:r.status,totalPosts:r.total_posts,addedAt:r.added_at,updatedAt:r.updated_at}; }
function mapV(r) { if(!r)return null; return{id:r.id,accountId:r.account_id,username:r.username,originalName:r.original_name,batchName:r.batch_name,b2Url:r.b2_url,cloudinaryUrl:r.b2_url,b2FileId:r.b2_file_id,b2FileName:r.b2_file_name,bytes:r.bytes,duration:r.duration,caption:r.caption,hashtags:r.hashtags,cycle:r.cycle,scheduledFor:r.scheduled_for,status:r.status,igPostId:r.ig_post_id,postedAt:r.posted_at,errorMsg:r.error_msg,retries:r.retries,createdAt:r.created_at,updatedAt:r.updated_at}; }


// ── Dashboard helpers (queries únicas, sem N+1) ──────────────────
function getVideoCountsPerAccount(userId=null, isAdmin=false) {
  let sql = "SELECT account_id, status, COUNT(*) as cnt FROM videos WHERE 1=1";
  const p = [];
  if (!isAdmin && userId) { sql += " AND user_id=?"; p.push(userId); }
  sql += " GROUP BY account_id, status";
  const rows = all(sql, p);
  const map = {};
  rows.forEach(r => {
    if (!map[r.account_id]) map[r.account_id] = { todos: 0, pendente: 0, postado: 0, erro: 0, processando: 0, cancelado: 0 };
    map[r.account_id][r.status] = r.cnt;
    map[r.account_id].todos += r.cnt;
  });
  return map;
}

function getNextScheduledPerAccount(userId=null, isAdmin=false) {
  let sql = "SELECT account_id, MIN(scheduled_for) as next FROM videos WHERE status='pendente'";
  const p = [];
  if (!isAdmin && userId) { sql += " AND user_id=?"; p.push(userId); }
  sql += " GROUP BY account_id";
  const rows = all(sql, p);
  const map = {};
  rows.forEach(r => { map[r.account_id] = r.next; });
  return map;
}

function getLastPostedPerAccount(userId=null, isAdmin=false) {
  let sql = "SELECT account_id, MAX(posted_at) as last FROM videos WHERE status='postado'";
  const p = [];
  if (!isAdmin && userId) { sql += " AND user_id=?"; p.push(userId); }
  sql += " GROUP BY account_id";
  const rows = all(sql, p);
  const map = {};
  rows.forEach(r => { map[r.account_id] = r.last; });
  return map;
}

function getLastPendingPerAccount(userId=null, isAdmin=false) {
  let sql = "SELECT account_id, MAX(scheduled_for) as last FROM videos WHERE status='pendente'";
  const p = [];
  if (!isAdmin && userId) { sql += " AND user_id=?"; p.push(userId); }
  sql += " GROUP BY account_id";
  const rows = all(sql, p);
  const map = {};
  rows.forEach(r => { map[r.account_id] = r.last; });
  return map;
}

function getDailySchedulePerAccount(userId, isAdmin, offsetHours) {
  if (offsetHours === undefined) offsetHours = -3;
  const sign = offsetHours >= 0 ? '+' : '-';
  const absH = Math.abs(offsetHours);
  const offsetExpr = "datetime(scheduled_for, '" + sign + absH + " hours')";
  const dateExpr = "DATE(" + offsetExpr + ")";
  let sql = "SELECT account_id, " + dateExpr + " as day, COUNT(*) as cnt FROM videos WHERE status='pendente'";
  const p = [];
  if (!isAdmin && userId) { sql += " AND user_id=?"; p.push(userId); }
  sql += " GROUP BY account_id, " + dateExpr + " ORDER BY day ASC";
  const rows = all(sql, p);
  const map = {};
  rows.forEach(function(r) {
    if (!map[r.account_id]) map[r.account_id] = {};
    map[r.account_id][r.day] = r.cnt;
  });
  return map;
}

function getPostedTodayCount(userId=null, isAdmin=false, today) {
  let sql = "SELECT COUNT(*) as cnt FROM videos WHERE status='postado' AND DATE(posted_at)=?";
  const p = [today];
  if (!isAdmin && userId) { sql += " AND user_id=?"; p.push(userId); }
  return (get(sql, p) || { cnt: 0 }).cnt;
}

module.exports = {
  init, persist,
  // Auth (NOVO)
  hashPassword, verifyPassword, createUser, getUserById, getUserByEmail, authenticateUser,
  getAllUsers, updateUser, deleteUser,
  createSession, getSession, deleteSession, cleanExpiredSessions,
  logActivity, getActivityLogs,
  // Original
  getSetting, setSetting, getAllSettings,
  getAccounts, getAccountById, getAccountByIgId, getAccountByIdForUser, insertAccount, updateAccount, deleteAccount,
  getVideos, getVideoCounts, getVideoById, getPendingVideos, insertVideo, updateVideo, deleteVideo, cancelPendingVideos, getStats,
  getVideoCountsPerAccount, getNextScheduledPerAccount, getLastPostedPerAccount, getLastPendingPerAccount, getDailySchedulePerAccount, getPostedTodayCount
};
