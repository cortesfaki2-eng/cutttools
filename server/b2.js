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
  publicUrl = pubUrl || `https://${bucket}.${endpoint.replace('https://','')}`;
  // Detectar se é R2 (*.r2.cloudflarestorage.com) ou B2
  // R2 usa virtual-hosted style (sem forcePathStyle) — necessário para presign funcionar corretamente
  const isR2 = endpoint && endpoint.includes('r2.cloudflarestorage.com');
  client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
    forcePathStyle: !isR2, // R2: false (virtual-hosted) | B2: true (path-style)
  });
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
  // signableHeaders força o Content-Type a ser parte da assinatura
  // → R2 valida e armazena com o tipo correto
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 3600,
    signableHeaders: new Set(['content-type']),
  });
  const fileUrl = publicUrl ? publicUrl.replace(/\/$/, '') + '/' + key : uploadUrl.split('?')[0];
  return { uploadUrl, fileUrl, contentType: ct };
}

module.exports = { configure, isConfigured, uploadFile, uploadStream, deleteFile, getPresignedUploadUrl };
