const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('./db');

const router = express.Router();

// ══ MIDDLEWARE: Autenticação ══════════════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });

  const session = db.getSession(token);
  if (!session) return res.status(401).json({ error: 'Sessão expirada' });

  const user = db.getUserById(session.userId);
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Conta suspensa' });

  req.user = user;
  req.sessionToken = token;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ══ AUTH ROUTES ═══════════════════════════════════════════════════

// Cadastro
router.post('/auth/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
  if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });

  const existing = db.getUserByEmail(email);
  if (existing) return res.status(400).json({ error: 'Este e-mail já está cadastrado' });

  try {
    const user = db.createUser({ id: uuid(), email, name, password, role: 'user', plan: 'free' });
    const token = db.createSession(user.id);
    db.logActivity(user.id, user.email, 'signup', 'Nova conta criada');

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, createdAt: user.createdAt }
    });
  } catch(e) {
    res.status(500).json({ error: 'Erro ao criar conta: ' + e.message });
  }
});

// Login
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Preencha e-mail e senha' });

  const result = db.authenticateUser(email, password);
  if (!result) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  if (result.error === 'suspended') return res.status(403).json({ error: 'Sua conta está suspensa. Contate o administrador.' });

  const token = db.createSession(result.id);
  db.logActivity(result.id, result.email, 'login', '');

  res.json({
    success: true,
    token,
    user: { id: result.id, email: result.email, name: result.name, role: result.role, plan: result.plan, createdAt: result.createdAt }
  });
});

// Logout
router.post('/auth/logout', authMiddleware, (req, res) => {
  db.deleteSession(req.sessionToken);
  res.json({ success: true });
});

// Sessão atual
router.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// Atualizar perfil
router.put('/auth/profile', authMiddleware, (req, res) => {
  const { name, phone, bio, password } = req.body;
  const patch = {};
  if (name) patch.name = name;
  if (phone !== undefined) patch.phone = phone;
  if (bio !== undefined) patch.bio = bio;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    patch.password = password;
  }

  const updated = db.updateUser(req.user.id, patch);
  db.logActivity(req.user.id, req.user.email, 'profile_update', '');
  res.json({ success: true, user: updated });
});

// ══ ADMIN ROUTES ═════════════════════════════════════════════════

// Listar todos os usuários
router.get('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.getAllUsers();
  res.json(users);
});

// Atualizar usuário (plano, role, status)
router.put('/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { role, plan, status, name } = req.body;
  const patch = {};
  if (role) patch.role = role;
  if (plan) patch.plan = plan;
  if (status) patch.status = status;
  if (name) patch.name = name;

  const updated = db.updateUser(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Usuário não encontrado' });

  db.logActivity(req.user.id, req.user.email, 'admin_update_user', `User ${req.params.id}: ${JSON.stringify(patch)}`);
  res.json({ success: true, user: updated });
});

// Deletar usuário
router.delete('/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode deletar sua própria conta' });

  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  db.deleteUser(req.params.id);
  db.logActivity(req.user.id, req.user.email, 'admin_delete_user', `Deleted: ${user.email}`);
  res.json({ success: true });
});

// Log de atividades
router.get('/admin/activity', authMiddleware, adminMiddleware, (req, res) => {
  const logs = db.getActivityLogs(200);
  res.json(logs);
});

// Stats do admin
router.get('/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.getAllUsers();
  const total = users.length;
  const active = users.filter(u => u.status === 'active').length;
  const admins = users.filter(u => u.role === 'admin').length;
  const plans = { free: 0, pro: 0, enterprise: 0 };
  users.forEach(u => plans[u.plan] = (plans[u.plan] || 0) + 1);

  const today = new Date().toISOString().split('T')[0];
  const todayLogins = db.getActivityLogs(9999).filter(l => l.action === 'login' && l.created_at && l.created_at.startsWith(today)).length;

  res.json({ total, active, admins, todayLogins, plans });
});

module.exports = { router, authMiddleware, adminMiddleware };
