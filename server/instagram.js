const axios = require('axios');
const schedule = require('node-schedule');
const db = require('./db');

const BASE = 'https://graph.facebook.com/v19.0';
const IG_BASE = 'https://graph.instagram.com';
const jobs = new Map();

// Extrai mensagem de erro real do Instagram (dentro de err.response.data)
function igErr(e) {
  const d = e.response?.data;
  if (!d) return e.message;
  const ig = d.error || d;
  const msg = ig.error_user_msg || ig.message || ig.error_message || JSON.stringify(d).slice(0, 200);
  const code = ig.code ? ` (código ${ig.code})` : '';
  const sub = ig.error_subcode ? `/${ig.error_subcode}` : '';
  return msg + code + sub;
}

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

  // Passo 1: criar container de mídia
  const mediaParams = { media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: accessToken };
  try {
    const res = await axios.post(`${IG_BASE}/${igAccountId}/media`, null, { params: mediaParams });
    creationId = res.data.id;
  } catch(e1) {
    console.warn(`[IG] graph.instagram.com/media falhou: ${igErr(e1)} — tentando graph.facebook.com`);
    try {
      const res = await axios.post(`${BASE}/${igAccountId}/media`, mediaParams);
      creationId = res.data.id;
    } catch(e2) {
      throw new Error(`Erro ao criar container: ${igErr(e2)}`);
    }
  }
  console.log(`[IG] Container criado: ${creationId}`);

  // Passo 2: aguardar processamento (até 3 min)
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    let statusData;
    try {
      const r = await axios.get(`${IG_BASE}/${creationId}`, { params: { fields: 'status_code,status,error_message', access_token: accessToken } });
      statusData = r.data;
    } catch(e) {
      try {
        const r = await axios.get(`${BASE}/${creationId}`, { params: { fields: 'status_code,status,error_message', access_token: accessToken } });
        statusData = r.data;
      } catch(e2) {
        console.warn(`[IG] Erro ao checar status (tentativa ${i+1}): ${igErr(e2)}`);
        continue;
      }
    }
    const code = statusData.status_code || statusData.status;
    console.log(`[IG] Status ${i+1}/36: ${code}`);
    if (code === 'FINISHED') break;
    if (code === 'ERROR') {
      const reason = statusData.error_message || igErr({ response: { data: statusData } }) || 'motivo desconhecido';
      throw new Error(`Instagram rejeitou o vídeo: ${reason}`);
    }
    if (i === 35) throw new Error('Timeout: processamento demorou mais de 3 minutos');
  }

  // Passo 3: publicar
  const publishParams = { creation_id: creationId, access_token: accessToken };
  try {
    const r = await axios.post(`${IG_BASE}/${igAccountId}/media_publish`, null, { params: publishParams });
    return r.data.id;
  } catch(e1) {
    console.warn(`[IG] media_publish via IG falhou: ${igErr(e1)} — tentando FB`);
    try {
      const r = await axios.post(`${BASE}/${igAccountId}/media_publish`, publishParams);
      return r.data.id;
    } catch(e2) {
      throw new Error(`Erro ao publicar: ${igErr(e2)}`);
    }
  }
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
    // Extrair mensagem real (axios envolve o erro do IG em err.response.data)
    const errMsg = err.message || igErr(err);
    const retries = (video.retries || 0) + 1;
    console.error(`[Post] ❌ ${video.originalName} (tentativa ${retries}/3): ${errMsg}`);
    if (err.response?.data) console.error(`[Post] Resposta IG:`, JSON.stringify(err.response.data).slice(0, 500));

    // Não retentar erros permanentes (400 = config errada, token inválido, URL inacessível)
    const isPermanent = err.response?.status === 400 || errMsg.includes('token') || errMsg.includes('Token') || errMsg.includes('URL') || errMsg.includes('invalid');
    if (!isPermanent && retries < 3) {
      const retryDate = new Date(Date.now() + 10 * 60000).toISOString();
      db.updateVideo(videoId, { status: 'pendente', errorMsg: errMsg, retries, scheduledFor: retryDate });
      scheduleVideo(videoId);
      console.log(`[Post] ↺ Retry ${retries}/3 em 10min: ${video.originalName}`);
    } else {
      db.updateVideo(videoId, { status: 'erro', errorMsg: errMsg, retries });
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
