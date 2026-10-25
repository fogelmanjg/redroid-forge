'use strict';

// Admin-only management of per-operator resource quotas (docs/ROADMAP.md Phase 7, 25/10/2026,
// see src/lib/quotas.js for the actual model). The shared pool half of the same model lives in
// settings.js/routes/settings.js instead -- it is one global value, not one per user, so it did
// not need its own store or its own route file.

const express = require('express');
const quotas = require('../lib/quotas');
const permissions = require('../lib/permissions');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  next();
}

router.get('/', requireAdmin, (req, res) => {
  res.json(quotas.listQuotas());
});

// Full replace of this user's quota, null/omitted on either field = unlimited for that
// dimension. Not instance-scoped (it is per PERSON, not per instance) -- a plain admin-only
// capability check, the same reasoning as settings.js.
router.put('/:userId', requireAdmin, (req, res) => {
  try {
    const { maxVcpus, maxMemoryMb } = req.body || {};
    const result = quotas.setQuota(req.params.userId, { maxVcpus, maxMemoryMb });
    res.json(result || { userId: req.params.userId, maxVcpus: null, maxMemoryMb: null });
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: e.message });
  }
});

router.delete('/:userId', requireAdmin, (req, res) => {
  quotas.deleteQuota(req.params.userId);
  res.status(204).end();
});

module.exports = router;
