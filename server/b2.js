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
  client = new S3Client({
    endpoint,
    region: 'us-east-1', // B2 aceita qualquer região aqui
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
    forcePathStyle: true, // necessário para B2
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
  const command = new PutObjectCommand({ Bucket: bucketName, Key: key, ContentType: contentType || 'video/mp4' });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });
  const fileUrl = publicUrl ? publicUrl.replace(/\/$/, '') + '/' + key : uploadUrl.split('?')[0];
  return { uploadUrl, fileUrl };
}

module.exports = { configure, isConfigured, uploadFile, deleteFile, getPresignedUploadUrl };
