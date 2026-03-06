require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const ig = require('./instagram');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

async function start() {
  await db.init();

  if (process.env.B2_KEY_ID) db.setSetting('b2KeyId', process.env.B2_KEY_ID);
  if (process.env.B2_APP_KEY) db.setSetting('b2AppKey', process.env.B2_APP_KEY);
  if (process.env.B2_BUCKET) db.setSetting('b2Bucket', process.env.B2_BUCKET);
  if (process.env.B2_ENDPOINT) db.setSetting('b2Endpoint', process.env.B2_ENDPOINT);
  if (process.env.B2_PUBLIC_URL) db.setSetting('b2PublicUrl', process.env.B2_PUBLIC_URL);

  const b2 = require('./b2');
  const s = db.getAllSettings();
  if (s.b2KeyId && s.b2AppKey && s.b2Bucket && s.b2Endpoint) {
    b2.configure(s.b2KeyId, s.b2AppKey, s.b2Bucket, s.b2Endpoint, s.b2PublicUrl || '');
  }

  const stats = db.getStats();
  const server = app.listen(PORT, () => {
    console.log(`\n✂️  CutTools v4.1 rodando em http://localhost:${PORT}`);
    console.log(`   Contas: ${stats.accounts} | Posts: ${stats.total} | Pendentes: ${stats.pendente}\n`);
    ig.restoreJobs();
  });

  server.timeout = 60 * 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;
}

start().catch(err => { console.error('Erro ao iniciar:', err); process.exit(1); });
