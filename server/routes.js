const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const db = require('./db');
const ig = require('./instagram');
const b2 = require('./b2');

const router = express.Router();
// diskStorage — evita estourar RAM no servidor (vídeos são grandes)
const UPLOAD_DIR = path.join(__dirname, '../../uploads/temp');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, uuid() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// Lock por conta para evitar race condition
const scheduleLocks = new Map();
async function withScheduleLock(accountId, fn) {
  while (scheduleLocks.get(accountId)) await new Promise(r => setTimeout(r, 100));
  scheduleLocks.set(accountId, true);
  try { return await fn(); } finally { scheduleLocks.delete(accountId); }
}

function getLastScheduledTime(accountId) {
  const all = db.getVideos({ accountId, status: 'pendente', limit: 99999 });
  if (!all.length) return null;
  const sorted = all.sort((a, b) => new Date(b.scheduledFor) - new Date(a.scheduledFor));
  return new Date(sorted[0].scheduledFor);
}

function configureB2FromDB() {
  const s = db.getAllSettings();
  if (s.b2KeyId && s.b2AppKey && s.b2Bucket && s.b2Endpoint) {
    b2.configure(s.b2KeyId, s.b2AppKey, s.b2Bucket, s.b2Endpoint, s.b2PublicUrl || '');
  }
}

const { adminMiddleware } = require('./auth');

// helpers
const isAdmin = req => req.user && req.user.role === 'admin';
const userId = req => req.user && req.user.id;

// ══ SETTINGS ══════════════════════════════════════════════════════
router.get('/settings', (req, res) => {
  // Usuários comuns só veem se B2 está configurado, não as chaves
  if (!isAdmin(req)) return res.json({ configured: db.isConfigured ? true : !!(db.getSetting('b2KeyId') && db.getSetting('b2Bucket')) });
  const s = db.getAllSettings();
  res.json({
    b2KeyId: s.b2KeyId || '',
    b2AppKey: s.b2AppKey ? '***' + s.b2AppKey.slice(-4) : '',
    b2Bucket: s.b2Bucket || '',
    b2Endpoint: s.b2Endpoint || '',
    b2PublicUrl: s.b2PublicUrl || '',
    timezoneOffset: s.timezoneOffset || '-3',
  });
});

router.post('/settings', adminMiddleware, (req, res) => {
  const { b2KeyId, b2AppKey, b2Bucket, b2Endpoint, b2PublicUrl } = req.body;
  if (b2KeyId) db.setSetting('b2KeyId', b2KeyId);
  if (b2AppKey && !b2AppKey.startsWith('***')) db.setSetting('b2AppKey', b2AppKey);
  if (b2Bucket) db.setSetting('b2Bucket', b2Bucket);
  if (b2Endpoint) db.setSetting('b2Endpoint', b2Endpoint);
  if (b2PublicUrl !== undefined) db.setSetting('b2PublicUrl', b2PublicUrl);
  if (req.body.timezoneOffset !== undefined) db.setSetting('timezoneOffset', req.body.timezoneOffset);
  configureB2FromDB();
  res.json({ success: true });
});

// ══ ACCOUNTS ══════════════════════════════════════════════════════
router.get('/accounts', (req, res) => {
  const accounts = db.getAccounts(userId(req), isAdmin(req)).map(a => ({ ...a, accessToken: a.accessToken ? a.accessToken.slice(0,8)+'...' : '' }));
  res.json(accounts);
});

router.post('/accounts', async (req, res) => {
  const { accessToken, label, postsPerDay, startTime, endTime, intervalMode, categoryId } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Token obrigatório' });

  try {
    const info = await ig.fetchAccountFromToken(accessToken);
    const existing = db.getAccountByIgId(info.igAccountId);
    if (existing) return res.status(400).json({ error: `Conta @${info.username} já cadastrada` });

    const ppd = parseInt(postsPerDay) || 40;
    const st = startTime || '02:00';
    const et = endTime || '23:00';
    const [sh, sm] = st.split(':').map(Number);
    const [eh, em] = et.split(':').map(Number);
    const windowMins = (eh * 60 + em) - (sh * 60 + sm);
    const intervalMins = ppd > 1 ? Math.floor(windowMins / (ppd - 1)) : windowMins;

    const account = db.insertAccount({
      id: uuid(), userId: userId(req), accessToken, igAccountId: info.igAccountId, username: info.username,
      label: label || info.username, accountType: info.accountType,
      postsPerDay: ppd, startTime: st, endTime: et, intervalMinutes: intervalMins, categoryId: categoryId||null,
      intervalMode: intervalMode || 'inteligente', status: 'active', totalPosts: 0,
    });

    res.json({ success: true, account: { ...account, accessToken: accessToken.slice(0,8)+'...' } });
  } catch(e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

router.put('/accounts/:id', (req, res) => {
  const acc = db.getAccountByIdForUser(req.params.id, userId(req), isAdmin(req));
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
  const { label, postsPerDay, startTime, endTime, intervalMode, accessToken, categoryId } = req.body;
  const ppd = parseInt(postsPerDay);
  const [sh, sm] = (startTime||'02:00').split(':').map(Number);
  const [eh, em] = (endTime||'23:00').split(':').map(Number);
  const windowMins = (eh * 60 + em) - (sh * 60 + sm);
  const intervalMins = ppd > 1 ? Math.floor(windowMins / (ppd - 1)) : windowMins;
  const patch = { label, postsPerDay: ppd, startTime, endTime, intervalMinutes: intervalMins, intervalMode, categoryId: categoryId !== undefined ? (categoryId||null) : undefined };
  if (accessToken) patch.accessToken = accessToken;
  db.updateAccount(req.params.id, patch);
  res.json({ success: true });
});


// ── PRESIGNED UPLOAD ──────────────────────────────────────────────
router.get('/videos/presign', async (req, res) => {
  const { filename, accountId, contentType } = req.query;
  if (!accountId || !filename) return res.status(400).json({ error: 'accountId e filename obrigatorios' });
  const account = db.getAccountByIdForUser(accountId, userId(req), isAdmin(req));
  if (!account) return res.status(400).json({ error: 'Conta nao encontrada' });
  configureB2FromDB();
  if (!b2.isConfigured()) return res.status(400).json({ error: 'Configure o storage primeiro' });
  try {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = account.username + '/' + Date.now() + '_' + base + ext;
    const { uploadUrl, fileUrl } = await b2.getPresignedUploadUrl(key, contentType || 'video/mp4');
    res.json({ uploadUrl, publicFileUrl: fileUrl, key });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONFIRM LEGADO (1 arquivo) — mantido para compatibilidade ──
router.post('/videos/confirm', async (req, res) => {
  const { accountId, key, publicFileUrl, originalName, bytes, caption, hashtags, batchId } = req.body;
  if (!accountId || !key) return res.status(400).json({ error: 'accountId e key obrigatorios' });
  const account = db.getAccountByIdForUser(accountId, userId(req), isAdmin(req));
  if (!account) return res.status(400).json({ error: 'Conta nao encontrada' });
  try {
    const { startTime, endTime, postsPerDay, intervalMinutes } = account;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = (endTime||'23:00').split(':').map(Number);
    const offsetHours = parseInt(db.getAllSettings().timezoneOffset || '-3');
    const uid = userId(req);
    await withScheduleLock(accountId, async () => {
      const lastScheduled = getLastScheduledTime(accountId);
      const dates = generateSchedule(1, postsPerDay, intervalMinutes, sh, sm, eh, em, lastScheduled, offsetHours);
      const video = db.insertVideo({ id: uuid(), userId: uid, accountId, username: account.username, originalName: originalName || key, batchName: batchId || originalName || key, b2Url: publicFileUrl, b2FileId: key, b2FileName: key, bytes: parseInt(bytes)||0, duration: 0, caption: caption||'', hashtags: hashtags||'', cycle: 1, scheduledFor: dates[0].toISOString(), status: 'pendente' });
      ig.scheduleVideo(video.id);
      db.updateAccount(accountId, { totalPosts: (account.totalPosts||0) + 1 });
    });
    res.json({ success: true });
  } catch(e) { console.error('[Confirm]', e.message); res.status(500).json({ error: e.message }); }
});


// ── PROGRESSO DE POSTAGEM — polling do frontend durante status 'processando'
router.get('/videos/:id/progress', (req, res) => {
  const video = db.getVideoById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video nao encontrado' });
  // errorMsg armazena '[pct%] msg' enquanto processando
  let pct = 0, msg = '';
  if (video.status === 'processando' && video.errorMsg) {
    const m = video.errorMsg.match(/^\[(\d+)%\]\s*(.*)$/);
    if (m) { pct = parseInt(m[1]); msg = m[2]; }
    else msg = video.errorMsg;
  } else if (video.status === 'postado') { pct = 100; msg = 'Publicado! ✅'; }
  else if (video.status === 'erro') { pct = 0; msg = video.errorMsg || 'Erro'; }
  res.json({ id: video.id, status: video.status, pct, msg, igPostId: video.igPostId });
});

// ── UPLOAD-ONLY — faz upload pro R2 via servidor (garante ContentType correto) e retorna url+key
router.post('/videos/upload-only', upload.single('videos'), async (req, res) => {
  const { accountId } = req.body;
  if (!accountId || !req.file) return res.status(400).json({ error: 'accountId e arquivo obrigatorios' });
  const account = db.getAccountByIdForUser(accountId, userId(req), isAdmin(req));
  if (!account) return res.status(400).json({ error: 'Conta nao encontrada' });
  configureB2FromDB();
  if (!b2.isConfigured()) return res.status(400).json({ error: 'Configure o storage primeiro' });
  try {
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const uploaded = await b2.uploadStream(req.file.path, req.file.size, originalName, account.username);
    fs.unlink(req.file.path, () => {}); // limpar disco após upload
    res.json({ success: true, url: uploaded.url, key: uploaded.fileId, fileName: uploaded.fileName, bytes: uploaded.bytes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── STATUS DE VÍDEO — polling de progresso durante processamento ──
router.get('/videos/:id/status', (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  const acc = db.getAccountByIdForUser(v.accountId, userId(req), isAdmin(req));
  if (!acc) return res.status(403).json({ error: 'forbidden' });
  res.json({ id: v.id, status: v.status, errorMsg: v.errorMsg, igPostId: v.igPostId, postedAt: v.postedAt, updatedAt: v.updatedAt });
});

// ── CONFIRM-BATCH — recebe lote inteiro já ordenado, cria ciclos corretamente ──
// Padrão de ciclos: 1-2-3-4-5-6 | 1-2-3-4-5-6 (intercalado, não em bloco)
router.post('/videos/confirm-batch', async (req, res) => {
  const { accountId, batchId, cycles, caption, hashtags, videos } = req.body;
  // videos: [{key, publicFileUrl, originalName, bytes}] — JÁ em ordem correta
  if (!accountId || !Array.isArray(videos) || !videos.length)
    return res.status(400).json({ error: 'accountId e videos obrigatorios' });

  const account = db.getAccountByIdForUser(accountId, userId(req), isAdmin(req));
  if (!account) return res.status(400).json({ error: 'Conta nao encontrada' });

  try {
    const numCycles = Math.max(1, parseInt(cycles) || 1);
    const { startTime, endTime, postsPerDay, intervalMinutes } = account;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = (endTime||'23:00').split(':').map(Number);
    const offsetHours = parseInt(db.getAllSettings().timezoneOffset || '-3');
    const uid = userId(req);
    const bName = batchId || ('batch_' + Date.now());

    // Total de slots = N vídeos × ciclos, intercalados: v1c1, v2c1, v3c1... v1c2, v2c2...
    // Construir lista ordenada: para cada ciclo, todos os vídeos em ordem
    const slots = [];
    for (let c = 1; c <= numCycles; c++) {
      for (const v of videos) {
        slots.push({ ...v, cycle: c });
      }
    }

    const totalSlots = slots.length;

    // Validar se é possível agendar postsPerDay na janela configurada
    const windowMins = (eh * 60 + em) - (sh * 60 + sm);
    const intervalCalc = postsPerDay <= 1 ? windowMins : Math.floor(windowMins / (postsPerDay - 1));
    if (intervalCalc < 1) {
      return res.status(400).json({
        error: `Impossível agendar ${postsPerDay} posts/dia na janela ${account.startTime}–${account.endTime} (${windowMins} min). ` +
               `Máximo possível: ${windowMins} posts/dia (1 por minuto). Reduza posts/dia ou amplie a janela.`
      });
    }

    const dates = generateSchedule(totalSlots, postsPerDay, intervalMinutes, sh, sm, eh, em, getLastScheduledTime(accountId), offsetHours);
    if (!dates.length) {
      return res.status(400).json({ error: 'Não foi possível gerar agenda. Verifique a configuração de horários da conta.' });
    }

    await withScheduleLock(accountId, async () => {
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const video = db.insertVideo({
          id: uuid(), userId: uid, accountId, username: account.username,
          originalName: s.originalName, batchName: bName,
          b2Url: s.publicFileUrl, b2FileId: s.key, b2FileName: s.key,
          bytes: parseInt(s.bytes)||0, duration: 0,
          caption: caption||'', hashtags: hashtags||'',
          cycle: s.cycle,
          scheduledFor: dates[i].toISOString(),
          status: 'pendente'
        });
        ig.scheduleVideo(video.id);
      }
      db.updateAccount(accountId, { totalPosts: (account.totalPosts||0) + totalSlots });
      console.log(`[ConfirmBatch] @${account.username}: ${videos.length} vídeos × ${numCycles} ciclos = ${totalSlots} agendados`);
    });

    res.json({ success: true, scheduled: totalSlots });
  } catch(e) { console.error('[ConfirmBatch]', e.message); res.status(500).json({ error: e.message }); }
});

// ── CATEGORIAS ──────────────────────────────────────────────────────────
router.get('/categories', (req, res) => {
  res.json(db.getCategories(userId(req), isAdmin(req)));
});

router.post('/categories', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const cat = db.insertCategory({ id: uuid(), userId: userId(req), name: name.trim(), color: color || '#6c63ff' });
  res.json(cat);
});

router.put('/categories/:id', (req, res) => {
  const { name, color } = req.body;
  db.updateCategory(req.params.id, { name, color });
  res.json({ success: true });
});

router.delete('/categories/:id', (req, res) => {
  db.deleteCategory(req.params.id);
  res.json({ success: true });
});

// ── RESCHEDULE ────────────────────────────────────────────────────
router.post('/accounts/:id/reschedule', async (req, res) => {
  const { label, postsPerDay, startTime, endTime } = req.body;
  const acc = db.getAccountByIdForUser(req.params.id, userId(req), isAdmin(req));
  if (!acc) return res.status(404).json({ error: 'Conta nao encontrada' });

  const ppd = parseInt(postsPerDay) || acc.postsPerDay;
  const st = startTime || acc.startTime;
  const et = endTime || acc.endTime;
  const [sh, sm] = st.split(':').map(Number);
  const [eh, em] = et.split(':').map(Number);
  const windowMins = (eh*60+em) - (sh*60+sm);
  const intervalMins = ppd > 1 ? Math.floor(windowMins/(ppd-1)) : windowMins;

  db.updateAccount(req.params.id, { label: label||acc.label, postsPerDay: ppd, startTime: st, endTime: et, intervalMinutes: intervalMins });

  const pending = db.getVideos({ accountId: req.params.id, status: 'pendente', limit: 99999 });
  if (!pending.length) return res.json({ success: true, rescheduled: 0 });

  pending.forEach(v => ig.cancelJob(v.id));

  const offsetHours = parseInt(db.getAllSettings().timezoneOffset || '-3');

  // Usar generateSchedule — mesmo algoritmo dos novos uploads, começa amanhã
  const dates = generateSchedule(pending.length, ppd, intervalMins, sh, sm, eh, em, null, offsetHours);
  if (!dates.length) return res.status(400).json({ error: 'Configuração inválida — não foi possível gerar agenda' });

  for (let i = 0; i < pending.length; i++) {
    const scheduledFor = (dates[i] || dates[dates.length - 1]).toISOString();
    db.updateVideo(pending[i].id, { scheduledFor, status: 'pendente', errorMsg: null });
    ig.scheduleVideo(pending[i].id);
  }

  console.log('[Reschedule] @' + acc.username + ': ' + pending.length + ' videos reagendados');
  res.json({ success: true, rescheduled: pending.length });
});

router.delete('/accounts/:id', (req, res) => {
  const acc = db.getAccountByIdForUser(req.params.id, userId(req), isAdmin(req));
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
  db.deleteAccount(req.params.id);
  res.json({ success: true });
});

router.post('/accounts/:id/test', async (req, res) => {
  const acc = db.getAccountByIdForUser(req.params.id, userId(req), isAdmin(req));
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
  try {
    const info = await ig.fetchAccountFromToken(acc.accessToken);
    res.json({ success: true, username: info.username });
  } catch(e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ══ VIDEOS ════════════════════════════════════════════════════════
router.get('/videos', (req, res) => {
  const { accountId, status, date, limit = 300, offset = 0, categoryId } = req.query;
  let effectiveAccountId = accountId;
  if (categoryId && categoryId !== 'all' && (!accountId || accountId === 'all')) {
    const accs = db.getAccounts(userId(req), isAdmin(req)).filter(a => a.categoryId === categoryId);
    effectiveAccountId = accs.length ? accs.map(a => a.id) : ['__none__'];
  }
  const videos = db.getVideos({ accountId: effectiveAccountId, status, date, limit: parseInt(limit), offset: parseInt(offset), userId: userId(req), isAdmin: isAdmin(req) });
  const counts = db.getVideoCounts(accountId, userId(req), isAdmin(req));
  res.json({ videos, counts });
});

router.post('/videos/upload', upload.array('videos', 500), async (req, res) => {
  const { accountId, caption, hashtags, cycles, batchName } = req.body;
  if (!accountId) return res.status(400).json({ error: 'Selecione uma conta' });

  const account = db.getAccountByIdForUser(accountId, userId(req), isAdmin(req));
  if (!account) return res.status(400).json({ error: 'Conta não encontrada' });

  configureB2FromDB();
  if (!b2.isConfigured()) return res.status(400).json({ error: 'Configure o Backblaze B2 primeiro em ⚙️ Configurações' });

  // Extrair vídeos de ZIPs
  const allFiles = [...(req.files || [])];
  const videoFiles = allFiles.filter(f => !f.originalname.toLowerCase().endsWith('.zip'));
  const zipFiles = allFiles.filter(f => f.originalname.toLowerCase().endsWith('.zip'));

  for (const zipFile of zipFiles) {
    try {
      const zip = new AdmZip(zipFile.path);
      for (const entry of zip.getEntries()) {
        if (/\.(mp4|mov|avi|mkv)$/i.test(entry.entryName) && !entry.isDirectory) {
          const outName = uuid() + '_' + path.basename(entry.entryName);
          const outPath = path.join(UPLOAD_DIR, outName);
          fs.writeFileSync(outPath, entry.getData());
          videoFiles.push({ path: outPath, originalname: path.basename(entry.entryName), size: entry.header.size });
        }
      }
      fs.unlink(zipFile.path, () => {});
    } catch(e) { console.error('[ZIP]', e.message); }
  }

  if (!videoFiles.length) return res.status(400).json({ error: 'Nenhum vídeo encontrado nos arquivos enviados' });

  const numCycles = Math.max(1, parseInt(cycles) || 1);
  const expandedFiles = [];
  for (let c = 1; c <= numCycles; c++) videoFiles.forEach(f => expandedFiles.push({ ...f, cycle: c }));

  // Gerar agenda
  const { startTime, postsPerDay, intervalMinutes } = account;
  const [sh, sm] = startTime.split(':').map(Number);
  const scheduledDates = generateSchedule(expandedFiles.length, postsPerDay, intervalMinutes, sh, sm);

  const results = [];
  for (let i = 0; i < expandedFiles.length; i++) {
    const file = expandedFiles[i];
    try {
      console.log(`[Upload] ${file.originalname} → B2... (${i+1}/${expandedFiles.length})`);
      const uploaded = await b2.uploadFile(file.path, file.originalname, account.username);
      fs.unlink(file.path, () => {});

      const video = db.insertVideo({
        id: uuid(), userId: userId(req), accountId, username: account.username,
        originalName: file.originalname, batchName: batchName || file.originalname,
        b2Url: uploaded.url, b2FileId: uploaded.fileId, b2FileName: uploaded.fileName,
        bytes: uploaded.bytes, duration: 0,
        caption: caption || '', hashtags: hashtags || '',
        cycle: file.cycle, scheduledFor: scheduledDates[i].toISOString(),
        status: 'pendente',
      });

      ig.scheduleVideo(video.id);
      results.push({ id: video.id, name: file.originalname, scheduled: scheduledDates[i] });
    } catch(e) {
      try { fs.unlinkSync(file.path); } catch {}
      console.error(`[Upload] ❌ ${file.originalname}: ${e.message}`);
      results.push({ name: file.originalname, error: e.message });
    }
  }

  const ok = results.filter(r => !r.error).length;
  db.updateAccount(accountId, { totalPosts: (account.totalPosts || 0) + ok });

  res.json({ success: true, total: results.length, ok, results });
});

// Valida e retorna o intervalo em minutos para caber postsPerDay na janela
// Retorna null se for impossível (janela menor que 1 min por post)
function calcInterval(postsPerDay, startH, startM, endH, endM) {
  const windowMins = (endH * 60 + endM) - (startH * 60 + startM);
  if (windowMins <= 0) return null;
  if (postsPerDay <= 1) return windowMins;
  const interval = Math.floor(windowMins / (postsPerDay - 1));
  if (interval < 1) return null; // impossível
  return interval;
}

// Gera datas de agendamento distribuídas uniformemente na janela diária
// Usa offsetHours para converter horário local (padrão BRT -3) para UTC
function generateSchedule(total, postsPerDay, _ignored, startH, startM, endH=23, endM=0, lastScheduled=null, offsetHours=-3) {
  const intervalMinutes = calcInterval(postsPerDay, startH, startM, endH, endM);
  if (!intervalMinutes) return [];

  const dates = [];
  const now = new Date();
  const startUTC = startH - offsetHours; // ex: 02h BRT (-3) → 05h UTC
  const windowMins = (endH * 60 + endM) - (startH * 60 + startM);

  // Início da janela do dia de uma data — sempre <= date
  function windowStartOf(date) {
    const d = new Date(date);
    d.setUTCHours(startUTC, startM, 0, 0);
    if (d > date) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }

  let current, slotInDay, dayWS;

  function goToNextDay() {
    slotInDay = 0;
    dayWS = new Date(dayWS);
    dayWS.setUTCDate(dayWS.getUTCDate() + 1);
    current = new Date(dayWS);
  }

  if (lastScheduled && lastScheduled > now) {
    dayWS = windowStartOf(lastScheduled);
    const off = (lastScheduled - dayWS) / 60000;
    const slotIndex = Math.round(off / intervalMinutes);
    const next = new Date(dayWS.getTime() + (slotIndex + 1) * intervalMinutes * 60000);
    const nextOff = (next - dayWS) / 60000;
    if (nextOff > windowMins) {
      dayWS.setUTCDate(dayWS.getUTCDate() + 1);
      current = new Date(dayWS);
      slotInDay = 0;
    } else {
      current = next;
      slotInDay = slotIndex + 1;
    }
  } else {
    dayWS = windowStartOf(now);
    const dayEnd = new Date(dayWS.getTime() + windowMins * 60000);
    const candidate = new Date(now.getTime() + 60000);

    if (candidate <= dayWS) {
      current = new Date(dayWS); slotInDay = 0;
    } else if (candidate <= dayEnd) {
      const elapsed = Math.ceil((candidate - dayWS) / (intervalMinutes * 60000));
      const snapped = new Date(dayWS.getTime() + elapsed * intervalMinutes * 60000);
      if (snapped <= dayEnd) { current = snapped; slotInDay = elapsed; }
      else { goToNextDay(); }
    } else {
      goToNextDay();
    }
  }

  for (let i = 0; i < total; i++) {
    dates.push(new Date(current));
    slotInDay++;

    if (slotInDay >= postsPerDay) {
      goToNextDay();
    } else {
      // Offset calculado a partir do dayWS fixo deste dia — nunca muda até goToNextDay
      const next = new Date(dayWS.getTime() + slotInDay * intervalMinutes * 60000);
      const off = (next - dayWS) / 60000;
      if (off > windowMins) {
        goToNextDay();
      } else {
        current = next;
      }
    }
  }
  return dates;
}

router.delete('/videos/:id', async (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (!v || (!isAdmin(req) && v.userId && v.userId !== userId(req))) return res.status(404).json({ error: 'Vídeo não encontrado' });
  if (v && v.b2FileName) await b2.deleteFile(v.b2FileName).catch(() => {});
  ig.cancelJob(req.params.id);
  db.deleteVideo(req.params.id);
  res.json({ success: true });
});

router.post('/videos/cancel-pending', (req, res) => {
  const { accountId } = req.query;
  const pending = db.getVideos({ accountId, status: 'pendente', limit: 99999, userId: userId(req), isAdmin: isAdmin(req) });
  pending.forEach(v => ig.cancelJob(v.id));
  const cancelled = db.cancelPendingVideos(accountId, userId(req), isAdmin(req));
  res.json({ success: true, cancelled });
});

router.post('/videos/:id/retry', (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (!v || (!isAdmin(req) && v.userId && v.userId !== userId(req))) return res.status(404).json({ error: 'Vídeo não encontrado' });
  db.updateVideo(req.params.id, { status: 'pendente', errorMsg: null, retries: 0 });
  ig.scheduleVideo(req.params.id);
  res.json({ success: true });
});

router.post('/videos/:id/publish-now', (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (!v || (!isAdmin(req) && v.userId && v.userId !== userId(req))) return res.status(404).json({ error: 'Vídeo não encontrado' });
  // Forçar status pendente independente do estado atual (processando, erro, etc)
  db.updateVideo(req.params.id, { status: 'pendente', scheduledFor: new Date().toISOString(), errorMsg: '', retries: 0 });
  ig.cancelJob(req.params.id); // cancelar job agendado se existir
  setTimeout(() => ig.executePost(req.params.id), 300);
  res.json({ success: true });
});

// Stats detalhadas por conta (para dashboard)
router.get('/accounts/stats', (req, res) => {
  const accounts = db.getAccounts(userId(req), isAdmin(req));
  const result = accounts.map(a => {
    const counts = db.getVideoCounts(a.id, userId(req), isAdmin(req));
    return { id: a.id, username: a.username, label: a.label, postsPerDay: a.postsPerDay, startTime: a.startTime, endTime: a.endTime, intervalMinutes: a.intervalMinutes, status: a.status, ...counts };
  });
  res.json(result);
});

// ══ PRESET CAPTIONS ═══════════════════════════════════════════════
router.get('/captions', (req, res) => {
  const raw = db.getSetting('presetCaptions_' + userId(req));
  res.json(raw ? JSON.parse(raw) : []);
});

router.post('/captions', (req, res) => {
  const { captions } = req.body; // array de {id, name, caption, hashtags}
  if (!Array.isArray(captions)) return res.status(400).json({ error: 'captions deve ser array' });
  db.setSetting('presetCaptions_' + userId(req), JSON.stringify(captions));
  res.json({ success: true });
});

router.get('/stats', (req, res) => {
  const stats = db.getStats(userId(req), isAdmin(req));
  stats.activeJobs = ig.getActiveJobCount();
  res.json(stats);
});

// Stats por conta (para cards do dashboard)
router.get('/stats/by-account', (req, res) => {
  const accounts = db.getAccounts(userId(req), isAdmin(req));
  const result = accounts.map(a => {
    const counts = db.getVideoCounts(a.id, userId(req), isAdmin(req));
    return {
      id: a.id,
      username: a.username,
      label: a.label,
      postsPerDay: a.postsPerDay,
      startTime: a.startTime,
      endTime: a.endTime,
      intervalMinutes: a.intervalMinutes,
      status: a.status,
      counts,
    };
  });
  res.json(result);
});


// ══ DASHBOARD — tudo em 1 request ══════════════════════════════
router.get('/dashboard', (req, res) => {
  const uid = userId(req);
  const adm = isAdmin(req);

  // Stats gerais
  const stats = db.getStats(uid, adm);
  stats.activeJobs = ig.getActiveJobCount();

  // Contas com counts + próximo + último por conta
  const accounts = db.getAccounts(uid, adm);

  // Uma query só: counts por conta e status
  const counts = db.getVideoCountsPerAccount(uid, adm);
  // Uma query só: próximo pendente por conta
  const nextMap = db.getNextScheduledPerAccount(uid, adm);
  // Uma query só: último postado por conta
  const lastMap = db.getLastPostedPerAccount(uid, adm);
  // Uma query só: último pendente por conta (data do último vídeo na fila)
  const lastPendMap = db.getLastPendingPerAccount(uid, adm);
  // Agendamentos por dia por conta
  const offsetHours = parseInt(db.getAllSettings().timezoneOffset || '-3');
  const dailyMap = db.getDailySchedulePerAccount(uid, adm, offsetHours);
  // Próximos 8 pendentes para lista
  const upcoming = db.getVideos({ status: 'pendente', limit: 8, userId: uid, isAdmin: adm });
  // Postados hoje
  const today = new Date().toISOString().split('T')[0];
  const todayCount = db.getPostedTodayCount(uid, adm, today);

  const accStats = accounts.map(a => ({
    id: a.id,
    username: a.username,
    label: a.label,
    postsPerDay: a.postsPerDay,
    startTime: a.startTime,
    endTime: a.endTime,
    intervalMinutes: a.intervalMinutes,
    status: a.status,
    categoryId: a.categoryId || null,
    counts: counts[a.id] || { todos: 0, pendente: 0, postado: 0, erro: 0, processando: 0, cancelado: 0 },
    nextScheduled: nextMap[a.id] || null,
    lastPosted: lastMap[a.id] || null,
    lastPending: lastPendMap[a.id] || null,
    dailySchedule: dailyMap[a.id] || {},
  }));

  res.json({ stats, accStats, upcoming, todayCount });
});

router.get('/export/csv', (req, res) => {
  const { accountId } = req.query;
  const videos = db.getVideos({ accountId, limit: 99999, userId: userId(req), isAdmin: isAdmin(req) });
  const header = ['Arquivo','Conta','Status','Agendado','Publicado','Post ID','Erro','Ciclo'];
  const rows = videos.map(v => [v.originalName, v.username, v.status, v.scheduledFor||'', v.postedAt||'', v.igPostId||'', v.errorMsg||'', v.cycle||1]);
  const csv = [header,...rows].map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition','attachment;filename="cuttools_export.csv"');
  res.send('\uFEFF'+csv);
});


module.exports = router;
