/**
 * video.js — Helpers de detecção e correção de faststart em MP4
 *
 * MP4 tem dois atoms críticos:
 *   - moov: índice (codec, timeline, timestamps)
 *   - mdat: dados de mídia
 * Pra streaming progressivo (Instagram, players HTML5), moov PRECISA
 * estar antes de mdat. ffmpeg sem -movflags +faststart escreve mdat antes,
 * o que faz o IG falhar com "could not be fetched from the provided URL".
 *
 * Este módulo:
 *   1) detecta se um MP4 tem moov no início (sem precisar baixar inteiro)
 *   2) corrige (remux com -c copy +faststart) — leva ~1s/vídeo, sem re-encode
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');

const TMP = path.join(os.tmpdir(), 'cuttools-faststart');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

function makeTmpPath(suffix = '.mp4') {
  return path.join(TMP, uuid() + suffix);
}

/**
 * Lê os atoms top-level de um buffer MP4 e retorna se moov vem antes de mdat.
 * Retorna: true (faststart ok), false (moov no fim), null (indeterminado).
 */
function findMoovBeforeMdat(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (size < 8) return null;       // dado corrompido
    if (size === 1) return null;     // 64-bit size — raro, assume sem faststart
    offset += size;
  }
  return null; // buffer pequeno demais
}

/**
 * Faz range request dos primeiros bytes da URL e detecta faststart.
 * Não baixa o vídeo inteiro. Suficiente em 99%+ dos casos.
 */
async function checkRemoteFaststart(url, maxBytes = 65536) {
  const r = await axios.get(url, {
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    responseType: 'arraybuffer',
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status !== 206 && r.status !== 200) {
    throw new Error(`HTTP ${r.status} ao baixar header de ${url}`);
  }
  return findMoovBeforeMdat(Buffer.from(r.data));
}

/** Baixa URL inteira pra arquivo local via stream (não estoura RAM). */
async function downloadToFile(url, outPath) {
  const writer = fs.createWriteStream(outPath);
  const r = await axios.get(url, { responseType: 'stream', timeout: 5 * 60 * 1000 });
  await new Promise((resolve, reject) => {
    r.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    r.data.on('error', reject);
  });
}

/**
 * Roda ffmpeg pra remux com faststart. NÃO re-encoda (-c copy), só reordena
 * os atoms. Leva 1-3s por vídeo de 10-50MB.
 */
function runFaststart(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',                           // sobrescrever output sem perguntar
      '-i', inputPath,
      '-c', 'copy',                   // não re-encoda
      '-movflags', '+faststart',      // move moov pro início
      '-loglevel', 'error',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg falhou (exit ${code}): ${stderr.slice(-500)}`));
    });
    ff.on('error', err => reject(new Error('ffmpeg não encontrado: ' + err.message)));
  });
}

/**
 * Pipeline completo: dada uma URL pública e a key no R2, garante faststart.
 * Se já tem, retorna { changed: false }. Se não, baixa, processa, re-uploada
 * na mesma key (substitui), retorna { changed: true, bytes }.
 */
async function ensureFaststart(b2Module, url, key) {
  // 1) check rápido remoto
  let needsFix;
  try {
    const result = await checkRemoteFaststart(url);
    needsFix = result === false; // false = moov no fim, true = ok, null = indeterminado
    if (result === true) return { changed: false };
  } catch (e) {
    // se falhou o check, processa de qualquer jeito (defensivo)
    needsFix = true;
  }

  if (!needsFix) return { changed: false };

  // 2) baixa, processa, re-uploada
  const inPath = makeTmpPath('_in.mp4');
  const outPath = makeTmpPath('_out.mp4');
  try {
    await downloadToFile(url, inPath);
    await runFaststart(inPath, outPath);
    const stats = fs.statSync(outPath);
    await b2Module.uploadToKey(outPath, key);
    return { changed: true, bytes: stats.size };
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  }
}

module.exports = {
  findMoovBeforeMdat,
  checkRemoteFaststart,
  downloadToFile,
  runFaststart,
  ensureFaststart,
  makeTmpPath,
};
