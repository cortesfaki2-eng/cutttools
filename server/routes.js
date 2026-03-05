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

function configureB2FromDB() {
  const s = db.getAllSettings();
  if (s.b2KeyId && s.b2AppKey && s.b2Bucket && s.b2Endpoint) {
    b2.configure(s.b2KeyId, s.b2AppKey, s.b2Bucket, s.b2Endpoint, s.b2PublicUrl || '');
  }
}

function getLastScheduledTime(accountId) {
  const all = db.getVideos({ accountId, limit: 99999 });
  const pending = all.filter(v => v.status === 'pendente' && v.scheduledFor);
  if (!pending.length) return null;
  const sorted = pending.sort((a, b) => new Date(b.scheduledFor) - new Date(a.scheduledFor));
  return new Date(sorted[0].scheduledFor);
}

function generateSchedule(total, postsPerDay, intervalMinutes, startH, startM, lastScheduled = null) {
  const dates = [];
  let current;
  if (lastScheduled && lastScheduled > new Date()) {
    current = new Date(lastScheduled.getTime() + intervalMinutes * 60000);
  } else {
    current = new Date();
    current.setHours(startH, startM, 0, 0);
    if (current <= new Date()) current.setDate(current.getDate() + 1);
  }
  let slotInDay = 0;
  for (let i = 0; i < total; i++) {
    dates.push(new Date(current));
    slotInDay++;
    if (slotInDay >= postsPerDay) {
      slotInDay = 0;
      current = new Date(current);
      current.setDate(current.getDate() + 1);
      current.setHours(startH, startM, 0, 0);
    } else {
      current = new Date(current.getTime() + intervalMinutes * 60000);
    }
  }
  return dates;
}

// ══ SETTINGS ══════════════════════════════════════════════════════
router.get('/settings', (req, res) => {
  const s = db.getAllSettings();
  res.json({
    b2KeyId: s.b2KeyId || '',
    b2AppKey: s.b2AppKey ? '***' + s.b2AppKey.slice(-4) : '',
    b2Bucket: s.b2Bucket || '',
    b2Endpoint: s.b2Endpoint || '',
    b2PublicUrl: s.b2PublicUrl || '',
  });
});

router.post('/settings', (req, res) => {
  const { b2KeyId, b2AppKey, b2Bucket, b2Endpoint, b2PublicUrl } = req.body;
  if (b2KeyId) db.setSetting('b2KeyId', b2KeyId);
  if (b2AppKey && !b2AppKey.startsWith('***')) db.setSetting('b2AppKey', b2AppKey);
  if (b2Bucket) db.setSetting('b2Bucket', b2Bucket);
  if (b2Endpoint) db.setSetting('b2Endpoint', b2Endpoint);
  if (b2PublicUrl !== undefined) db.setSetting('b2PublicUrl', b2PublicUrl);
  configureB2FromDB();
  res.json({ success: true });
});

// ══ ACCOUNTS ══════════════════════════════════════════════════════
router.get('/accounts', (req, res) => {
  const accounts = db.getAccounts().map(a => ({ ...a, accessToken: a.accessToken ? a.accessToken.slice(0,8)+'...' : '' }));
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
      id: uuid(), accessToken, igAccountId: info.igAccountId, username: info.username,
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

router.delete('/accounts/:id', (req, res) => {
  db.deleteAccount(req.params.id);
  res.json({ success: true });
});

router.post('/accounts/:id/test', async (req, res) => {
  const acc = db.getAccountById(req.params.id);
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
  const videos = db.getVideos({ accountId, status, date, limit: parseInt(limit), offset: parseInt(offset) });
  const counts = db.getVideoCounts(accountId);
  res.json({ videos, counts });
});

router.post('/videos/upload', upload.array('videos', 500), async (req, res) => {
  const { accountId, caption, hashtags, cycles, batchName } = req.body;
  if (!accountId) return res.status(400).json({ error: 'Selecione uma conta' });

  const account = db.getAccountById(accountId);
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
  const totalSlots = videoFiles.length * numCycles;

  // Responde imediatamente
  res.json({ success: true, total: totalSlots });

  const { startTime, postsPerDay, intervalMinutes } = account;
  const [sh, sm] = startTime.split(':').map(Number);
  const lastScheduled = getLastScheduledTime(accountId);
  const scheduledDates = generateSchedule(totalSlots, postsPerDay, intervalMinutes, sh, sm, lastScheduled);

  // PASSO 1: Faz upload de CADA arquivo UMA VEZ e guarda o resultado
  const uploaded = []; // { originalname, url, fileId, fileName, bytes }
  for (let i = 0; i < videoFiles.length; i++) {
    const file = videoFiles[i];
    try {
      console.log(`[Upload] ${file.originalname} → B2... (${i+1}/${videoFiles.length})`);
      const result = await b2.uploadFile(file.path, file.originalname, account.username);
      uploaded.push({ originalname: file.originalname, ...result });
    } catch(e) {
      console.error(`[Upload] ❌ ${file.originalname}: ${e.message}`);
      uploaded.push({ originalname: file.originalname, error: e.message });
    } finally {
      // Deleta o arquivo temp APÓS o upload (independente de erro)
      fs.unlink(file.path, () => {});
    }
  }

  // PASSO 2: Cria os registros no banco para cada ciclo reutilizando a URL do B2
  let slot = 0;
  for (let cycle = 1; cycle <= numCycles; cycle++) {
    for (let i = 0; i < uploaded.length; i++) {
      const u = uploaded[i];
      if (u.error) { slot++; continue; }
      const scheduledFor = scheduledDates[slot++];
      try {
        const video = db.insertVideo({
          id: uuid(), accountId, username: account.username,
          originalName: u.originalname, batchName: batchName || u.originalname,
          b2Url: u.url, b2FileId: u.fileId, b2FileName: u.fileName,
          bytes: u.bytes, duration: 0,
          caption: caption || '', hashtags: hashtags || '',
          cycle, scheduledFor: scheduledFor.toISOString(),
          status: 'pendente',
        });
        ig.scheduleVideo(video.id);
      } catch(e) {
        console.error(`[DB] ❌ ${u.originalname} ciclo ${cycle}: ${e.message}`);
      }
    }
  }

  const ok = uploaded.filter(u => !u.error).length;
  db.updateAccount(accountId, { totalPosts: (account.totalPosts || 0) + (ok * numCycles) });
  console.log(`[Upload] ✅ Concluído: ${ok}/${videoFiles.length} arquivos × ${numCycles} ciclo(s) = ${ok * numCycles} posts agendados`);
});

router.delete('/videos/:id', async (req, res) => {
  const v = db.getVideoById(req.params.id);
  if (v && v.b2FileName) await b2.deleteFile(v.b2FileName).catch(() => {});
  ig.cancelJob(req.params.id);
  db.deleteVideo(req.params.id);
  res.json({ success: true });
});

router.post('/videos/cancel-pending', (req, res) => {
  const { accountId } = req.query;
  const pending = db.getVideos({ accountId, status: 'pendente', limit: 99999 });
  pending.forEach(v => ig.cancelJob(v.id));
  const cancelled = db.cancelPendingVideos(accountId);
  res.json({ success: true, cancelled });
});

router.post('/videos/:id/retry', (req, res) => {
  db.updateVideo(req.params.id, { status: 'pendente', errorMsg: null, retries: 0 });
  ig.scheduleVideo(req.params.id);
  res.json({ success: true });
});

router.post('/videos/:id/publish-now', (req, res) => {
  db.updateVideo(req.params.id, { status: 'pendente', scheduledFor: new Date().toISOString() });
  setTimeout(() => ig.executePost(req.params.id), 500);
  res.json({ success: true });
});

// ══ STATS ═════════════════════════════════════════════════════════
router.get('/stats', (req, res) => {
  const stats = db.getStats();
  stats.activeJobs = ig.getActiveJobCount();
  res.json(stats);
});

router.get('/export/csv', (req, res) => {
  const { accountId } = req.query;
  const videos = db.getVideos({ accountId, limit: 99999 });
  const header = ['Arquivo','Conta','Status','Agendado','Publicado','Post ID','Erro','Ciclo'];
  const rows = videos.map(v => [v.originalName, v.username, v.status, v.scheduledFor||'', v.postedAt||'', v.igPostId||'', v.errorMsg||'', v.cycle||1]);
  const csv = [header,...rows].map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition','attachment;filename="cuttools_export.csv"');
  res.send('\uFEFF'+csv);
});

module.exports = router;
