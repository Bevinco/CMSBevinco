// This pilot belongs to one persisted CMS user, not to a role or an API key.
export function invoiceAccess({enabled, reviewerId, readSession, findUser}) {
  async function allowed(session) {
    if (!enabled || !reviewerId || !session || session.apiTokenId || session.id !== reviewerId) return false;
    const user = await findUser(reviewerId);
    return Boolean(user && user.id === reviewerId && user.active !== false && !user.disabled && !user.deletedAt);
  }
  async function requireAccess(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!enabled || !reviewerId) return res.status(404).json({error:'Módulo no disponible.'});
    const session = readSession(req);
    if (!session) {
      if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect(302, '/');
      return res.status(401).json({error:'Inicia sesión en el CMS para continuar.'});
    }
    if (!await allowed(session)) return res.status(403).json({error:'No tienes acceso a esta validación.'});
    req.session = session;
    next();
  }
  return {allowed, requireAccess};
}
