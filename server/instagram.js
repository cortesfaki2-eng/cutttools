const axios = require('axios');
const schedule = require('node-schedule');
const db = require('./db');

const BASE = 'https://graph.facebook.com/v19.0';
const IG_BASE = 'https://graph.instagram.com';
const jobs = new Map();

// ── Fetch account from token ──────────────────────────────────────
async function fetchAccountFromToken(accessToken) {
  const token = accessToken.trim();
  let lastError = '';

  // Estratégia 1: graph.instagram.com/me (token IGAAh do API setup)
  try {
    const res = await axios.get(`${IG_BASE}/me`, {
      params: { fields: 'id,username,account_type,media_count', access_token: token }
    });
    if (res.data && res.data.id) {
      return { igAccountId: res.data.id, username: res.data.username || res.data.id, accountType: res.data.account_type || 'BUSINESS', mediaCount: res.data.media_count || 0 };
    }
  } catch(e) { lastError = e.response?.data?.error?.message || e.message; }

  // Estratégia 2: graph.facebook.com/me
  try {
    const res = await axios.get(`${BASE}/me`, {
      params: { fields: 'id,name,username', access_token: token }
    });
    if (res.data && res.data.id) {
      try {
        const igRes = await axios.get(`${BASE}/${res.data.id}`, {
          params: { fields: 'id,username,account_type,media_count', access_token: token }
        });
        if (igRes.data.username) return { igAccountId: igRes.data.id, username: igRes.data.username, accountType: igRes.data.account_type || 'BUSINESS', mediaCount: igRes.data.media_count || 0 };
      } catch(e2) {}
      return { igAccountId: res.data.id, username: res.data.username || res.data.name || res.data.id, accountType: 'BUSINESS', mediaCount: 0 };
    }
  } catch(e) { lastError = e.response?.data?.error?.message || e.message; }

  // Estratégia 3: /me/accounts (token de página FB)
  try {
    const res = await axios.get(`${BASE}/me/accounts`, {
      params: { fields: 'id,name,instagram_business_account', access_token: token }
    });
    for (const page of (res.data.data || [])) {
      if (page.instagram_business_account?.id) {
        const igRes = await axios.get(`${BASE}/${page.instagram_business_account.id}`, {
          params: { fields: 'id,username,account_type,media_count', access_token: token }
        });
        return { igAccountId: igRes.data.id, username: igRes.data.username, accountType: igRes.data.account_type || 'BUSINESS', mediaCount: igRes.data.media_count || 0 };
      }
    }
  } catch(e) { lastError = e.response?.data?.error?.message || e.message; }

  throw new Error(`Token inválido ou expirado. Detalhe: ${lastError}`);
}

// ── Publish video ─────────────────────────────────────────────────
async function publishVideo(accessToken, igAccountId, videoUrl, caption) {
  let creationId;
  try {
    const res = await axios.post(`${IG_BASE}/${igAccountId}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: accessToken }
    });
    creationId = res.data.id;
  } catch(e) {
    const res = await axios.post(`${BASE}/${igAccountId}/media`, {
      media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: accessToken
    });
    creationId = res.data.id;
  }

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    let statusData;
    try {
      const r = await axios.get(`${IG_BASE}/${creationId}`, { params: { fields: 'status_code,error_message', access_token: accessToken } });
      statusData = r.data;
    } catch(e) {
      const r = await axios.get(`${BASE}/${creationId}`, { params: { fields: 'status_code,error_message', access_token: accessToken } });
      statusData = r.data;
    }
    const code = statusData.status_code;
    if (code === 'FINISHED') break;
    if (code === 'ERROR') {
      const reason = statusData.error_message || statusData.error?.message || 'motivo desconhecido';
      throw new Error('Instagram rejeitou o vídeo: ' + reason);
    }
    if (i === 23) throw new Error('Timeout: processamento demorou mais de 2 minutos');
  }

  let postId;
  try {
    const r = await axios.post(`${IG_BASE}/${igAccountId}/media_publish`, null, {
      params: { creation_id: creationId, access_token: accessToken }
    });
    postId = r.data.id;
  } catch(e) {
    const r = await axios.post(`${BASE}/${igAccountId}/media_publish`, {
      creation_id: creationId, access_token: accessToken
    });
    postId = r.data.id;
  }
  return postId;
}

// ── Scheduler ────────────────────────────────────────────────────
function scheduleVideo(videoId) {
  cancelJob(videoId);
  const video = db.getVideoById(videoId);
  if (!video || video.status !== 'pendente') return;

  const when = new Date(video.scheduledFor);
  if (when <= new Date()) {
    setTimeout(() => executePost(videoId), 1000);
    return;
  }

  const job = schedule.scheduleJob(when, () => executePost(videoId));
  if (job) jobs.set(videoId, job);
}

function cancelJob(videoId) {
  if (jobs.has(videoId)) { jobs.get(videoId).cancel(); jobs.delete(videoId); }
}

async function executePost(videoId) {
  const video = db.getVideoById(videoId);
  if (!video || video.status === 'postado' || video.status === 'cancelado') return;

  const account = db.getAccountById(video.accountId);
  if (!account) { db.updateVideo(videoId, { status: 'erro', errorMsg: 'Conta não encontrada' }); return; }

  db.updateVideo(videoId, { status: 'processando' });
  console.log(`[Post] ▶ ${video.originalName} → @${account.username}`);

  try {
    const caption = [video.caption, video.hashtags ? video.hashtags.split(/\s+/).map(h => h.startsWith('#') ? h : '#'+h).join(' ') : ''].filter(Boolean).join('\n\n');
    const igPostId = await publishVideo(account.accessToken, account.igAccountId, video.b2Url, caption);
    db.updateVideo(videoId, { status: 'postado', igPostId, postedAt: new Date().toISOString() });
    console.log(`[Post] ✅ ${video.originalName} → ID: ${igPostId}`);
  } catch(err) {
    const retries = (video.retries || 0) + 1;
    if (retries < 3) {
      const retryDate = new Date(Date.now() + 10 * 60000).toISOString();
      db.updateVideo(videoId, { status: 'pendente', errorMsg: err.message, retries, scheduledFor: retryDate });
      scheduleVideo(videoId);
      console.log(`[Post] ↺ Retry ${retries}/3: ${video.originalName}`);
    } else {
      db.updateVideo(videoId, { status: 'erro', errorMsg: err.message, retries });
      console.log(`[Post] ❌ ${video.originalName}: ${err.message}`);
    }
  }
}

function restoreJobs() {
  const pending = db.getPendingVideos();
  if (!pending.length) { console.log('[Scheduler] Nenhum job para restaurar.'); return; }
  console.log(`[Scheduler] Restaurando ${pending.length} jobs...`);
  pending.forEach(v => {
    if (v.status === 'processando') db.updateVideo(v.id, { status: 'pendente' });
    scheduleVideo(v.id);
  });
}

function getActiveJobCount() { return jobs.size; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchAccountFromToken, publishVideo, scheduleVideo, cancelJob, executePost, restoreJobs, getActiveJobCount };
