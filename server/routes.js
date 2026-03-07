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
  const { accessToken, label, postsPerDay, startTime, endTime, intervalMode } = req.body;
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
      postsPerDay: ppd, startTime: st, endTime: et, intervalMinutes: intervalMins,
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
  const { label, postsPerDay, startTime, endTime, intervalMode, accessToken } = req.body;
  const ppd = parseInt(postsPerDay);
  const [sh, sm] = (startTime||'02:00').split(':').map(Number);
  const [eh, em] = (endTime||'23:00').split(':').map(Number);
  const windowMins = (eh * 60 + em) - (sh * 60 + sm);
  const intervalMins = ppd > 1 ? Math.floor(windowMins / (ppd - 1)) : windowMins;
  const patch = { label, postsPerDay: ppd, startTime, endTime, intervalMinutes: intervalMins, intervalMode };
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

router.post('/videos/confirm', async (req, res) => {
  const { accountId, key, publicFileUrl, originalName, bytes, caption, hashtags, batchName, cycles, isLastOfBatch, batchId } = req.body;
  if (!accountId || !key) return res.status(400).json({ error: 'accountId e key obrigatorios' });
  const account = db.getAccountByIdForUser(accountId, userId(req), isAdmin(req));
  if (!account) return res.status(400).json({ error: 'Conta nao encontrada' });

  try {
    const numCycles = Math.max(1, parseInt(cycles) || 1);
    const { startTime, endTime, postsPerDay, intervalMinutes } = account;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = (endTime||'23:00').split(':').map(Number);
    const offsetHours = parseInt(db.getAllSettings().timezoneOffset || '-3');
    const uid = userId(req);

    await withScheduleLock(accountId, async () => {
      if (!isLastOfBatch || numCycles <= 1) {
        const lastScheduled = getLastScheduledTime(accountId);
        const dates = generateSchedule(1, postsPerDay, intervalMinutes, sh, sm, eh, em, lastScheduled, offsetHours);
        const video = db.insertVideo({ id: uuid(), userId: uid, accountId, username: account.username, originalName: originalName || key, batchName: batchName || batchId || originalName || key, b2Url: publicFileUrl, b2FileId: key, b2FileName: key, bytes: parseInt(bytes)||0, duration: 0, caption: caption||'', hashtags: hashtags||'', cycle: 1, scheduledFor: dates[0].toISOString(), status: 'pendente' });
        ig.scheduleVideo(video.id);
        db.updateAccount(accountId, { totalPosts: (account.totalPosts||0) + 1 });
      } else {
        const lastScheduled = getLastScheduledTime(accountId);
        const dates1 = generateSchedule(1, postsPerDay, intervalMinutes, sh, sm, eh, em, lastScheduled, offsetHours);
        const video = db.insertVideo({ id: uuid(), userId: uid, accountId, username: account.username, originalName: originalName || key, batchName: batchName || batchId || originalName || key, b2Url: publicFileUrl, b2FileId: key, b2FileName: key, bytes: parseInt(bytes)||0, duration: 0, caption: caption||'', hashtags: hashtags||'', cycle: 1, scheduledFor: dates1[0].toISOString(), status: 'pendente' });
        ig.scheduleVideo(video.id);

        const batchVideos = db.getVideos({ accountId, status: 'pendente', limit: 99999, userId: uid, isAdmin: isAdmin(req) }).filter(v => v.batchName === (batchName || batchId));
        for (let cycle = 2; cycle <= numCycles; cycle++) {
          for (const bv of batchVideos) {
            const lastSched = getLastScheduledTime(accountId);
            const dates = generateSchedule(1, postsPerDay, intervalMinutes, sh, sm, eh, em, lastSched, offsetHours);
            const dup = db.insertVideo({ id: uuid(), userId: uid, accountId, username: account.username, originalName: bv.originalName, batchName: bv.batchName, b2Url: bv.b2Url, b2FileId: bv.b2FileId, b2FileName: bv.b2FileName, bytes: bv.bytes, duration: 0, caption: bv.caption, hashtags: bv.hashtags, cycle, scheduledFor: dates[0].toISOString(), status: 'pendente' });
            ig.scheduleVideo(dup.id);
          }
        }
        db.updateAccount(accountId, { totalPosts: (account.totalPosts||0) + (batchVideos.length * numCycles) });
        console.log('[Confirm] Ciclos: ' + batchVideos.length + ' videos x ' + numCycles + ' = ' + batchVideos.length * numCycles + ' agendados');
      }
    });
    res.json({ success: true });
  } catch(e) { console.error('[Confirm]', e.message); res.status(500).json({ error: e.message }); }
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
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow);
  tomorrowStart.setUTCHours(sh - offsetHours, sm, 0, 0);

  let current = new Date(tomorrowStart);
  let slotInDay = 0;

  function nextSlot(c) {
    const next = new Date(c.getTime() + intervalMins * 60000);
    const nextMins = next.getHours()*60 + next.getMinutes();
    const endMins = eh*60 + em;
    if (nextMins >= endMins) {
      const d = new Date(next); d.setDate(d.getDate()+1);
      d.setUTCHours(sh - offsetHours, sm, 0, 0);
      return { date: d, resetSlot: true };
    }
    return { date: next, resetSlot: false };
  }

  for (const video of pending) {
    db.updateVideo(video.id, { scheduledFor: current.toISOString(), status: 'pendente', errorMsg: null });
    ig.scheduleVideo(video.id);
    slotInDay++;
    if (slotInDay >= ppd) {
      slotInDay = 0;
      const d = new Date(current); d.setDate(d.getDate()+1);
      d.setUTCHours(sh - offsetHours, sm, 0, 0);
      current = d;
    } else {
      const { date, resetSlot } = nextSlot(current);
      if (resetSlot) slotInDay = 0;
      current = date;
    }
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
  const { accountId, status, date, limit = 300, offset = 0 } = req.query;
  const videos = db.getVideos({ accountId, status, date, limit: parseInt(limit), offset: parseInt(offset), userId: userId(req), isAdmin: isAdmin(req) });
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

function generateSchedule(total, postsPerDay, intervalMinutes, startH, startM, endH=23, endM=0, lastScheduled=null, offsetHours=-3) {
  const dates = [];
  const now = new Date();
  let current;

  if (lastScheduled && lastScheduled > now) {
    current = new Date(lastScheduled.getTime() + intervalMinutes * 60000);
  } else {
    current = new Date(now.getTime() + 60000);
    const todayStart = new Date(now); todayStart.setUTCHours(startH - offsetHours, startM, 0, 0);
    const todayEnd = new Date(now); todayEnd.setUTCHours(endH - offsetHours, endM, 0, 0);
    if (current < todayStart) current = todayStart;
    else if (current > todayEnd) { current = new Date(todayStart); current.setDate(current.getDate()+1); }
  }

  let slotInDay = 0;
  for (let i = 0; i < total; i++) {
    dates.push(new Date(current));
    slotInDay++;
    if (slotInDay >= postsPerDay) {
      slotInDay = 0;
      const d = new Date(current); d.setDate(d.getDate()+1);
      d.setUTCHours(startH - offsetHours, startM, 0, 0);
      current = d;
    } else {
      const next = new Date(current.getTime() + intervalMinutes * 60000);
      const nextMins = next.getHours()*60 + next.getMinutes();
      const endMins = endH*60 + endM;
      if (nextMins >= endMins) {
        slotInDay = 0;
        const d = new Date(next); d.setDate(d.getDate()+1);
        d.setUTCHours(startH - offsetHours, startM, 0, 0);
        current = d;
      } else {
        current = next;
      }
    }
  }
  return dates;
}

router.delete('/videos/:id', async (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (!v || (!isAdmin(req) && v.userId !== userId(req))) return res.status(404).json({ error: 'Vídeo não encontrado' });
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
  if (!v || (!isAdmin(req) && v.userId !== userId(req))) return res.status(404).json({ error: 'Vídeo não encontrado' });
  db.updateVideo(req.params.id, { status: 'pendente', errorMsg: null, retries: 0 });
  ig.scheduleVideo(req.params.id);
  res.json({ success: true });
});

router.post('/videos/:id/publish-now', (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (!v || (!isAdmin(req) && v.userId !== userId(req))) return res.status(404).json({ error: 'Vídeo não encontrado' });
  db.updateVideo(req.params.id, { status: 'pendente', scheduledFor: new Date().toISOString() });
  setTimeout(() => ig.executePost(req.params.id), 500);
  res.json({ success: true });
});

// ══ STATS ═════════════════════════════════════════════════════════
router.get('/stats', (req, res) => {
  const stats = db.getStats(userId(req), isAdmin(req));
  stats.activeJobs = ig.getActiveJobCount();
  res.json(stats);
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
