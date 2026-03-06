const express = require('express');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const Busboy = require('busboy');
const db = require('./db');
const ig = require('./instagram');
const b2 = require('./b2');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '../../uploads/temp');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Mapa de progresso dos uploads em andamento
const uploadProgress = new Map();

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

function generateSchedule(total, postsPerDay, intervalMinutes, startH, startM, endH, endM, lastScheduled = null) {
  const dates = [];
  const now = new Date();
  let current;

  if (lastScheduled && lastScheduled > now) {
    // Continua depois do último agendado
    current = new Date(lastScheduled.getTime() + intervalMinutes * 60000);
  } else {
    // Começa agora + 1 minuto
    current = new Date(now.getTime() + 60000);
    const todayStart = new Date(now); todayStart.setHours(startH, startM, 0, 0);
    const todayEnd = new Date(now); todayEnd.setHours(endH, endM, 0, 0);
    if (current < todayStart) {
      current = todayStart;
    } else if (current > todayEnd) {
      current = new Date(todayStart);
      current.setDate(current.getDate() + 1);
    }
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
      const endOfDay = new Date(current); endOfDay.setHours(endH, endM, 0, 0);
      if (current > endOfDay) {
        slotInDay = 0;
        current = new Date(current);
        current.setDate(current.getDate() + 1);
        current.setHours(startH, startM, 0, 0);
      }
    }
  }
  return dates;
}

// ── SETTINGS ──────────────────────────────────────────
router.get('/settings', (req, res) => {
  const s = db.getAllSettings();
  res.json({ b2KeyId: s.b2KeyId||'', b2AppKey: s.b2AppKey?'***'+s.b2AppKey.slice(-4):'', b2Bucket: s.b2Bucket||'', b2Endpoint: s.b2Endpoint||'', b2PublicUrl: s.b2PublicUrl||'' });
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

// ── ACCOUNTS ──────────────────────────────────────────
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
    const account = db.insertAccount({ id: uuid(), accessToken, igAccountId: info.igAccountId, username: info.username, label: label || info.username, accountType: info.accountType, postsPerDay: ppd, startTime: st, endTime: et, intervalMinutes: intervalMins, intervalMode: intervalMode || 'inteligente', status: 'active', totalPosts: 0 });
    res.json({ success: true, account: { ...account, accessToken: accessToken.slice(0,8)+'...' } });
  } catch(e) { res.status(400).json({ error: e.response?.data?.error?.message || e.message }); }
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


router.post('/accounts/:id/reschedule', async (req, res) => {
  const { label, postsPerDay, startTime, endTime } = req.body;
  const acc = db.getAccountById(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Conta nao encontrada' });

  const ppd = parseInt(postsPerDay) || acc.postsPerDay;
  const st = startTime || acc.startTime;
  const et = endTime || acc.endTime;
  const [sh, sm] = st.split(':').map(Number);
  const [eh, em] = et.split(':').map(Number);
  const windowMins = (eh * 60 + em) - (sh * 60 + sm);
  const intervalMins = ppd > 1 ? Math.floor(windowMins / (ppd - 1)) : windowMins;

  // Atualiza dados da conta
  db.updateAccount(req.params.id, { label: label || acc.label, postsPerDay: ppd, startTime: st, endTime: et, intervalMinutes: intervalMins });

  // Busca todos os pendentes desta conta
  const pending = db.getVideos({ accountId: req.params.id, status: 'pendente', limit: 99999 });
  if (!pending.length) return res.json({ success: true, rescheduled: 0 });

  // Cancela jobs atuais
  pending.forEach(v => ig.cancelJob(v.id));

  // Reagenda a partir de amanha inicio da janela
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(sh, sm, 0, 0);

  let current = new Date(tomorrow);
  let slotInDay = 0;

  for (const video of pending) {
    db.updateVideo(video.id, { scheduledFor: current.toISOString(), status: 'pendente', errorMsg: null });
    ig.scheduleVideo(video.id);
    slotInDay++;
    if (slotInDay >= ppd) {
      // Atingiu limite do dia — pula pro dia seguinte
      slotInDay = 0;
      current = new Date(current);
      current.setDate(current.getDate() + 1);
      current.setHours(sh, sm, 0, 0);
    } else {
      current = new Date(current.getTime() + intervalMins * 60000);
      // Se passou do fim da janela — pula pro dia seguinte
      const endOfDay = new Date(current);
      endOfDay.setHours(eh, em, 0, 0);
      if (current > endOfDay) {
        slotInDay = 0;
        current = new Date(current);
        current.setDate(current.getDate() + 1);
        current.setHours(sh, sm, 0, 0);
      }
    }
  }

  console.log(`[Reschedule] @${acc.username}: ${pending.length} videos reagendados a partir de ${tomorrow.toISOString()}`);
  res.json({ success: true, rescheduled: pending.length });
});

router.delete('/accounts/:id', (req, res) => { db.deleteAccount(req.params.id); res.json({ success: true }); });

router.post('/accounts/:id/test', async (req, res) => {
  const acc = db.getAccountById(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
  try {
    const info = await ig.fetchAccountFromToken(acc.accessToken);
    res.json({ success: true, username: info.username });
  } catch(e) { res.status(400).json({ error: e.response?.data?.error?.message || e.message }); }
});

// ── VIDEOS ────────────────────────────────────────────
router.get('/videos', (req, res) => {
  const { accountId, status, date, limit = 300, offset = 0 } = req.query;
  const videos = db.getVideos({ accountId, status, date, limit: parseInt(limit), offset: parseInt(offset) });
  const counts = db.getVideoCounts(accountId);
  res.json({ videos, counts });
});

// Rota de upload usando busboy para streaming — responde imediatamente após receber os arquivos
router.post('/videos/upload', (req, res) => {
  configureB2FromDB();
  if (!b2.isConfigured()) return res.status(400).json({ error: 'Configure o Backblaze B2 primeiro em ⚙️ Configurações' });

  const fields = {};
  const savedFiles = [];
  let responded = false;

  const bb = Busboy({
    headers: req.headers,
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 500 }
  });

  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('file', (name, stream, info) => {
    const originalname = Buffer.from(info.filename, 'latin1').toString('utf8');
    const savePath = path.join(UPLOAD_DIR, uuid() + '_' + originalname);
    const writeStream = fs.createWriteStream(savePath);
    stream.pipe(writeStream);
    savedFiles.push(new Promise((resolve, reject) => {
      writeStream.on('finish', () => resolve({ path: savePath, originalname }));
      writeStream.on('error', reject);
    }));
  });

  bb.on('finish', async () => {
    const { accountId, caption, hashtags, cycles, batchName } = fields;

    if (!accountId) {
      if (!responded) { responded = true; res.status(400).json({ error: 'Selecione uma conta' }); }
      return;
    }

    const account = db.getAccountById(accountId);
    if (!account) {
      if (!responded) { responded = true; res.status(400).json({ error: 'Conta não encontrada' }); }
      return;
    }

    // Aguarda todos os arquivos serem salvos em disco
    let videoFiles = await Promise.all(savedFiles);

    // Extrai ZIPs
    const zips = videoFiles.filter(f => f.originalname.toLowerCase().endsWith('.zip'));
    videoFiles = videoFiles.filter(f => !f.originalname.toLowerCase().endsWith('.zip'));

    for (const zipFile of zips) {
      try {
        const zip = new AdmZip(zipFile.path);
        for (const entry of zip.getEntries()) {
          if (/\.(mp4|mov|avi|mkv)$/i.test(entry.entryName) && !entry.isDirectory) {
            const outName = uuid() + '_' + path.basename(entry.entryName);
            const outPath = path.join(UPLOAD_DIR, outName);
            fs.writeFileSync(outPath, entry.getData());
            videoFiles.push({ path: outPath, originalname: path.basename(entry.entryName) });
          }
        }
        fs.unlink(zipFile.path, () => {});
      } catch(e) { console.error('[ZIP]', e.message); }
    }

    if (!videoFiles.length) {
      if (!responded) { responded = true; res.status(400).json({ error: 'Nenhum vídeo encontrado' }); }
      return;
    }

    const isLastOfBatch = fields.isLastOfBatch === "true";
    const numCycles = isLastOfBatch ? Math.max(1, parseInt(cycles) || 1) : 1;
    const jobId = uuid();

    uploadProgress.set(jobId, {
      jobId, accountId, username: account.username,
      total: videoFiles.length, done: 0, errors: 0,
      currentFile: '', status: 'uploading', pct: 0,
      startedAt: Date.now()
    });

    // Responde IMEDIATAMENTE com o jobId
    if (!responded) {
      responded = true;
      res.json({ success: true, total: videoFiles.length * numCycles, jobId });
    }

    // Processa em background
    processUpload(jobId, videoFiles, account, accountId, caption, hashtags, batchName, numCycles);
  });

  bb.on('error', (err) => {
    console.error('[Upload] Busboy error:', err.message);
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });

  req.pipe(bb);
});

async function processUpload(jobId, videoFiles, account, accountId, caption, hashtags, batchName, numCycles) {
  const { startTime, endTime, postsPerDay, intervalMinutes } = account;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = (endTime||'23:00').split(':').map(Number);
  const lastScheduled = getLastScheduledTime(accountId);
  const totalSlots = videoFiles.length * numCycles;
  const scheduledDates = generateSchedule(totalSlots, postsPerDay, intervalMinutes, sh, sm, eh, em, lastScheduled);

  // Upload sequencial para B2
  const uploaded = [];
  for (let i = 0; i < videoFiles.length; i++) {
    const file = videoFiles[i];
    uploadProgress.set(jobId, {
      ...uploadProgress.get(jobId),
      done: i, currentFile: file.originalname,
      pct: Math.round(i / videoFiles.length * 100)
    });
    try {
      console.log(`[Upload] ${file.originalname} → B2... (${i+1}/${videoFiles.length})`);
      const result = await b2.uploadFile(file.path, file.originalname, account.username);
      uploaded.push({ originalname: file.originalname, ...result });
    } catch(e) {
      console.error(`[Upload] ❌ ${file.originalname}: ${e.message}`);
      uploaded.push({ originalname: file.originalname, error: e.message });
      uploadProgress.set(jobId, { ...uploadProgress.get(jobId), errors: (uploadProgress.get(jobId).errors || 0) + 1 });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  // Registra no banco para cada ciclo
  let slot = 0;
  for (let cycle = 1; cycle <= numCycles; cycle++) {
    for (const u of uploaded) {
      if (u.error) { slot++; continue; }
      const scheduledFor = scheduledDates[slot++];
      try {
        const video = db.insertVideo({ id: uuid(), accountId, username: account.username, originalName: u.originalname, batchName: batchName || u.originalname, b2Url: u.url, b2FileId: u.fileId, b2FileName: u.fileName, bytes: u.bytes, duration: 0, caption: caption || '', hashtags: hashtags || '', cycle, scheduledFor: scheduledFor.toISOString(), status: 'pendente' });
        ig.scheduleVideo(video.id);
      } catch(e) { console.error(`[DB] ❌ ${u.originalname} ciclo ${cycle}: ${e.message}`); }
    }
  }

  const ok = uploaded.filter(u => !u.error).length;
  db.updateAccount(accountId, { totalPosts: (account.totalPosts || 0) + (ok * numCycles) });

  uploadProgress.set(jobId, {
    ...uploadProgress.get(jobId),
    done: videoFiles.length, pct: 100,
    status: 'done', currentFile: '', ok,
    errors: videoFiles.length - ok
  });

  setTimeout(() => uploadProgress.delete(jobId), 10 * 60 * 1000);
  console.log(`[Upload] ✅ ${ok}/${videoFiles.length} × ${numCycles} = ${ok * numCycles} agendados`);
}

// ── UPLOAD PROGRESS ───────────────────────────────────
router.get('/upload-progress/:jobId', (req, res) => {
  const p = uploadProgress.get(req.params.jobId);
  if (!p) return res.json({ status: 'not_found' });
  res.json({ found: true, ...p });
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

// ── STATS ─────────────────────────────────────────────
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
