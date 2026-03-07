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

// ── Helpers de chamada de API (tenta IG primeiro, depois FB) ──────
async function publishVideo(accessToken, igAccountId, videoUrl, caption, onProgress) {
  const prog = onProgress || (() => {});
  let creationId, lastErr = '';

  // Passo 1: criar container
  prog('container', 5, 'Criando container no Instagram...');
  const mediaParams = { media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: accessToken };
  for (const [base, useParams] of [[IG_BASE, true], [BASE, false]]) {
    try {
      const res = useParams
        ? await axios.post(`${base}/${igAccountId}/media`, null, { params: mediaParams })
        : await axios.post(`${base}/${igAccountId}/media`, mediaParams);
      creationId = res.data.id;
      break;
    } catch(e) { lastErr = igErr(e); console.warn(`[IG] ${base}/media falhou: ${lastErr}`); }
  }
  if (!creationId) throw new Error('Erro ao criar container: ' + lastErr);
  console.log('[IG] Container criado: ' + creationId);

  // Passo 2: aguardar processamento (até 3 min)
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const pct = 15 + Math.round(((i + 1) / 36) * 73);
    prog('processing', pct, 'Instagram processando... (' + (i+1) + '/36)');
    let statusData;
    for (const base of [IG_BASE, BASE]) {
      try {
        const r = await axios.get(`${base}/${creationId}`, { params: { fields: 'status_code,status,error_message', access_token: accessToken } });
        statusData = r.data; break;
      } catch(e) { console.warn('[IG] status via ' + base + ': ' + igErr(e)); }
    }
    if (!statusData) continue;
    const code = statusData.status_code || statusData.status;
    console.log('[IG] Status ' + (i+1) + '/36: ' + code);
    if (code === 'FINISHED') { prog('publishing', 90, 'Processado! Publicando...'); break; }
    if (code === 'ERROR') throw new Error('Instagram rejeitou: ' + (statusData.error_message || 'motivo desconhecido'));
    if (i === 35) throw new Error('Timeout: vídeo não processado em 3 minutos');
  }

  // Passo 3: publicar
  const publishParams = { creation_id: creationId, access_token: accessToken };
  let postId = null;
  for (const [base, useParams] of [[IG_BASE, true], [BASE, false]]) {
    try {
      const r = useParams
        ? await axios.post(`${base}/${igAccountId}/media_publish`, null, { params: publishParams })
        : await axios.post(`${base}/${igAccountId}/media_publish`, publishParams);
      postId = r.data.id; break;
    } catch(e) { lastErr = igErr(e); console.warn('[IG] media_publish via ' + base + ' falhou: ' + lastErr); }
  }
  if (!postId) throw new Error('Erro ao publicar: ' + lastErr);
  prog('publishing', 100, 'Publicado! ✅');
  return postId;
}

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

  db.updateVideo(videoId, { status: 'processando', errorMsg: 'Iniciando...' });
  console.log('[Post] ▶ ' + video.originalName + ' → @' + account.username);

  // Callback de progresso: (step, pct, msg) — salva '[pct%] msg' no errorMsg para polling
  const onProgress = (step, pct, msg) => {
    db.updateVideo(videoId, { errorMsg: '[' + pct + '%] ' + msg });
    console.log('[Post] ' + pct + '% ' + msg);
  };

  let igPostId = null;
  try {
    const caption = [video.caption, video.hashtags ? video.hashtags.split(/\s+/).map(h => h.startsWith('#') ? h : '#'+h).join(' ') : ''].filter(Boolean).join('\n\n');
    igPostId = await publishVideo(account.accessToken, account.igAccountId, video.b2Url, caption, onProgress);
  } catch(err) {
    const errMsg = err.message || 'Erro desconhecido';
    const retries = (video.retries || 0) + 1;
    console.error('[Post] ❌ ' + video.originalName + ' (tentativa ' + retries + '/3): ' + errMsg);
    if (retries < 3) {
      const retryDate = new Date(Date.now() + 10 * 60000).toISOString();
      db.updateVideo(videoId, { status: 'pendente', errorMsg: errMsg, retries, scheduledFor: retryDate });
      scheduleVideo(videoId);
      console.log('[Post] ↺ Retry ' + retries + '/3 em 10min');
    } else {
      db.updateVideo(videoId, { status: 'erro', errorMsg: errMsg, retries });
    }
    return; // sair aqui — igPostId é null
  }

  // Só chega aqui se publishVideo retornou com sucesso
  db.updateVideo(videoId, { status: 'postado', igPostId, postedAt: new Date().toISOString(), errorMsg: '' });
  console.log('[Post] ✅ ' + video.originalName + ' → ID: ' + igPostId);
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
