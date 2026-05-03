/**
 * b2.js — Upload para Backblaze B2 via API S3-compatível
 * 
 * Backblaze B2 tem API 100% compatível com S3, então usamos @aws-sdk/client-s3
 * Custo: ~$0,006/GB/mês = 180GB ≈ $1,08/mês
 * 
 * Setup:
 * 1. backblaze.com → Create Account → Create Bucket (public)
 * 2. App Keys → Add a New Application Key → copiar keyID e applicationKey
 * 3. Bucket endpoint: s3.us-west-002.backblazeb2.com (varia por região)
 */
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

let client = null;
let bucketName = '';
let publicUrl = '';

function configure(keyId, appKey, bucket, endpoint, pubUrl) {
  bucketName = bucket;
  const isR2 = endpoint && endpoint.includes('r2.cloudflarestorage.com');

  // CRÍTICO: o endpoint S3 (r2.cloudflarestorage.com / s3.*.backblazeb2.com)
  // NÃO é público — exige assinatura AWS. Se o usuário não setou b2PublicUrl,
  // qualquer URL gerada a partir desse endpoint vai falhar quando o Instagram
  // tentar baixar. Para R2 isso é sempre fatal; o R2.dev subdomain ou Custom
  // Domain é obrigatório.
  if (!pubUrl) {
    if (isR2) {
      throw new Error(
        'Cloudflare R2 exige "URL Pública" configurada. ' +
        'Habilite o R2.dev subdomain no painel do bucket (ou um Custom Domain) ' +
        'e cole o resultado (https://pub-xxxxxxxxxxxxxxxxx.r2.dev) em ⚙️ Configurações.'
      );
    }
    // Backblaze B2: aviso visível, mas não fatal — o virtual-hosted style funciona
    // se o bucket for público. Ainda assim recomendar URL explícita.
    console.warn('[B2] AVISO: b2PublicUrl não configurado. Usando fallback baseado no endpoint S3. ' +
                 'Se o Instagram rejeitar com "could not be fetched", configure a URL pública (ex: https://f000.backblazeb2.com/file/<bucket>).');
  }

  publicUrl = (pubUrl || `https://${bucket}.${endpoint.replace('https://','')}`).replace(/\/$/, '');

  // R2 usa virtual-hosted style (sem forcePathStyle) — necessário para presign funcionar corretamente
  client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
    forcePathStyle: !isR2, // R2: false (virtual-hosted) | B2: true (path-style)
  });

  console.log(`[B2] Configurado: bucket=${bucket} publicUrl=${publicUrl} (${isR2 ? 'R2' : 'B2'})`);
}

function isConfigured() {
  return !!(client && bucketName);
}

/**
 * Faz upload de um arquivo local para o Backblaze B2
 * @returns {{ url, fileId, fileName, bytes }}
 */
async function uploadFile(localPath, originalName, folder = 'videos') {
  if (!isConfigured()) throw new Error('Backblaze B2 não configurado. Vá em ⚙️ Configurações.');

  const ext = path.extname(originalName);
  const fileName = `${folder}/${uuid()}${ext}`;
  const fileBuffer = fs.readFileSync(localPath);
  const contentType = getContentType(ext);

  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  // URL pública do arquivo
  const url = `${publicUrl}/${fileName}`;

  return {
    url,
    fileId: fileName, // no B2/S3, usamos o key como ID
    fileName,
    bytes: fileBuffer.length,
  };
}

/**
 * Faz upload via stream — nunca carrega o arquivo inteiro em RAM
 * Ideal para vídeos grandes em produção (evita OOM no servidor)
 * @returns {{ url, fileId, fileName, bytes }}
 */
async function uploadStream(localPath, fileSize, originalName, folder = 'videos') {
  if (!isConfigured()) throw new Error('Storage não configurado.');
  const ext = path.extname(originalName);
  const fileName = `${folder}/${uuid()}${ext}`;
  const contentType = getContentType(ext);

  const stream = fs.createReadStream(localPath);
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: stream,
    ContentType: contentType,
    ContentLength: fileSize, // obrigatório com stream — sem isso o SDK tenta buffer tudo
  }));

  return {
    url: `${publicUrl}/${fileName}`,
    fileId: fileName,
    fileName,
    bytes: fileSize,
  };
}

/**
 * Deleta um arquivo do B2
 */
async function deleteFile(fileName) {
  if (!isConfigured() || !fileName) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileName }));
  } catch(e) {
    console.warn('[B2] Falha ao deletar:', e.message);
  }
}

function getContentType(ext) {
  const types = { '.mp4':'video/mp4', '.mov':'video/quicktime', '.avi':'video/x-msvideo', '.mkv':'video/x-matroska', '.webm':'video/webm' };
  return types[ext.toLowerCase()] || 'video/mp4';
}


async function getPresignedUploadUrl(key, contentType) {
  if (!isConfigured()) throw new Error('Storage não configurado');
  const ct = contentType || 'video/mp4';
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: ct,
  });
  // Sem signableHeaders — não força Content-Type na assinatura
  // Assim o cliente pode enviar qualquer content-type sem invalidar a URL
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 3600,
  });
  const fileUrl = publicUrl ? publicUrl.replace(/\/$/, '') + '/' + key : uploadUrl.split('?')[0];
  return { uploadUrl, fileUrl, contentType: ct };
}

module.exports = { configure, isConfigured, uploadFile, uploadStream, deleteFile, getPresignedUploadUrl };
