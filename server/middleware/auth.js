const ROLE_RANK = { user: 0, reviewer: 1, admin: 2 };

// Shared by requireAuthenticatedUser and requireRole so the disabled check lives in
// exactly one place — a route that only needs "any logged-in user" must still reject a
// disabled account, not just routes gated by a specific role.
function resolveActiveUser(req) {
  if (!req.user) return { user: null, error: { status: 401, message: 'Authentication required' } };
  if (req.user.disabled) return { user: null, error: { status: 403, message: 'Account disabled' } };
  return { user: req.user, error: null };
}

function requireAuthenticatedUser(req, res, next) {
  const { error } = resolveActiveUser(req);
  if (error) return res.status(error.status).json({ error: error.message });
  next();
}

// requireRole('reviewer') also admits admins (rank comparison, not exact match) —
// role checks always read req.user fresh via Passport's deserializeUser (see
// passportConfig.js), never a value cached in the session/cookie, so a role change or
// disable takes effect on the user's very next request.
function requireRole(role) {
  const requiredRank = ROLE_RANK[role];
  return (req, res, next) => {
    const { user, error } = resolveActiveUser(req);
    if (error) return res.status(error.status).json({ error: error.message });
    const userRank = ROLE_RANK[user.role] ?? -1;
    if (userRank < requiredRank) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuthenticatedUser, requireRole, resolveActiveUser, ROLE_RANK };
