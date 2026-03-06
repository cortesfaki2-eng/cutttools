const axios = require('axios');
const schedule = require('node-schedule');
const db = require('./db');

const jobs = new Map();

async function fetchAccountFromToken(accessToken) {
  // Tenta Instagram Business Login (token IGAAh... direto do Instagram)
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/me`, {
      params: { fields: 'id,username,account_type', access_token: accessToken }
    });
    if (r.data?.id && r.data?.username) {
      return {
        igAccountId: r.data.id,
        username: r.data.username,
        accountType: r.data.account_type || 'BUSINESS',
      };
    }
  } catch(e) {
    // Se falhar, tenta via Facebook Pages (token EAAh...)
  }

  // Fallback: Facebook Login via /me/accounts
  const r2 = await axios.get(`https://graph.facebook.com/v19.0/me/accounts`, {
    params: { fields: 'instagram_business_account{id,username,account_type}', access_token: accessToken }
  });
  const pages = r2.data?.data;
  if (!pages || !pages.length) throw new Error('Nenhuma página Facebook encontrada com esse token');

  for (const page of pages) {
    const ig = page.instagram_business_account;
    if (ig) {
      return {
        igAccountId: ig.id,
        username: ig.username,
        accountType: ig.account_type || 'BUSINESS',
      };
    }
  }
  throw new Error('Nenhuma conta Instagram Business vinculada às páginas desse token');
}

async function executePost(videoId) {
  const video = db.getVideoById(videoId);
  if (!video) return;
  if (video.status !== 'pendente') return;

  db.updateVideo(videoId, { status: 'processando' });

  const account = db.getAccountById(video.accountId);
  if (!account) {
    db.updateVideo(videoId, { status: 'erro', errorMsg: 'Conta não encontrada' });
    return;
  }

  console.log(`[Post] ▶ ${video.originalName} → @${account.username}`);

  try {
    // Step 1: Create media container
    const caption = [video.caption, video.hashtags].filter(Boolean).join('\n\n');
    const containerRes = await axios.post(
      `https://graph.facebook.com/v19.0/${account.igAccountId}/media`,
      null,
      {
        params: {
          media_type: 'REELS',
          video_url: video.b2Url,
          caption,
          access_token: account.accessToken,
        },
      }
    );

    const containerId = containerRes.data?.id;
    if (!containerId) throw new Error('Container ID não retornado pela API');

    // Step 2: Poll for container status
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(10000);
      const statusRes = await axios.get(
        `https://graph.facebook.com/v19.0/${containerId}`,
        { params: { fields: 'status_code', access_token: account.accessToken } }
      );
      const statusCode = statusRes.data?.status_code;
      if (statusCode === 'FINISHED') { ready = true; break; }
      if (statusCode === 'ERROR') {
        const errDetails = statusRes.data?.error_message || statusRes.data?.status || 'Erro no processamento';
        throw new Error('Instagram rejeitou: ' + errDetails);
      }
    }

    if (!ready) throw new Error('Timeout: vídeo não processado em 5 minutos');

    // Step 3: Publish
    const publishRes = await axios.post(
      `https://graph.facebook.com/v19.0/${account.igAccountId}/media_publish`,
      null,
      { params: { creation_id: containerId, access_token: account.accessToken } }
    );

    const igPostId = publishRes.data?.id;
    if (!igPostId) throw new Error('Post ID não retornado');

    db.updateVideo(videoId, {
      status: 'postado',
      igPostId,
      postedAt: new Date().toISOString(),
      errorMsg: null,
    });

    console.log(`[Post] ✅ ${video.originalName} → ID: ${igPostId}`);
    jobs.delete(videoId);

  } catch(e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    const retries = (video.retries || 0) + 1;
    console.error(`[Post] ❌ ${video.originalName}: ${errMsg}`);

    if (retries < 3) {
      db.updateVideo(videoId, { status: 'pendente', errorMsg: errMsg, retries });
      // Retry em 30 minutos
      const retryDate = new Date(Date.now() + 30 * 60 * 1000);
      scheduleAt(videoId, retryDate);
    } else {
      db.updateVideo(videoId, { status: 'erro', errorMsg: errMsg, retries });
      jobs.delete(videoId);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scheduleAt(videoId, date) {
  if (jobs.has(videoId)) {
    jobs.get(videoId).cancel();
    jobs.delete(videoId);
  }
  if (date <= new Date()) {
    setTimeout(() => executePost(videoId), 1000);
    return;
  }
  const job = schedule.scheduleJob(date, () => executePost(videoId));
  jobs.set(videoId, job);
}

function scheduleVideo(videoId) {
  const video = db.getVideoById(videoId);
  if (!video || video.status !== 'pendente') return;
  const date = new Date(video.scheduledFor);
  scheduleAt(videoId, date);
}

function cancelJob(videoId) {
  if (jobs.has(videoId)) {
    jobs.get(videoId).cancel();
    jobs.delete(videoId);
  }
}

function restoreJobs() {
  const pending = db.getVideos({ status: 'pendente', limit: 99999 });
  // Também restaura os que ficaram em "processando" (crash durante post)
  const processing = db.getVideos({ status: 'processando', limit: 99999 });
  processing.forEach(v => db.updateVideo(v.id, { status: 'pendente' }));

  const all = [...pending, ...processing];
  all.forEach(v => scheduleVideo(v.id));
  console.log(`[Scheduler] ${all.length > 0 ? all.length + ' job(s) restaurados.' : 'Nenhum job para restaurar.'}`);
}

function getActiveJobCount() {
  return jobs.size;
}

module.exports = { fetchAccountFromToken, executePost, scheduleVideo, cancelJob, restoreJobs, getActiveJobCount };
