const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');

let s3 = null;
let bucketName = '';
let publicUrl = '';
let configured = false;

function configure(keyId, appKey, bucket, endpoint, pubUrl) {
  bucketName = bucket;
  publicUrl = pubUrl || '';
  s3 = new S3Client({
    endpoint: endpoint.startsWith('http') ? endpoint : `https://${endpoint}`,
    region: 'auto',
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
    forcePathStyle: true,
  });
  configured = true;
  console.log(`[B2] Configurado: bucket=${bucket}`);
}

function isConfigured() {
  return configured && !!s3;
}

function getFileUrl(fileName) {
  return publicUrl
    ? `${publicUrl.replace(/\/$/, '')}/${fileName}`
    : `https://${bucketName}.s3.amazonaws.com/${fileName}`;
}

// Gera URL pré-assinada para upload direto do browser
async function getPresignedUploadUrl(fileName, contentType) {
  if (!isConfigured()) throw new Error('Storage não configurado');
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    ContentType: contentType || 'video/mp4',
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return { uploadUrl, publicFileUrl: getFileUrl(fileName) };
}

async function uploadFile(filePath, originalName, username) {
  if (!isConfigured()) throw new Error('Storage não configurado');

  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileName = `${username}/${Date.now()}_${base}${ext}`;
  const fileBuffer = fs.readFileSync(filePath);

  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: fileBuffer,
    ContentType: 'video/mp4',
  }));

  return {
    url: getFileUrl(fileName),
    fileId: fileName,
    fileName,
    bytes: fileBuffer.length,
  };
}

async function deleteFile(fileName) {
  if (!isConfigured()) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileName }));
  } catch(e) {
    console.error('[B2] Erro ao deletar:', e.message);
  }
}

module.exports = { configure, isConfigured, uploadFile, deleteFile, getPresignedUploadUrl, getFileUrl };
