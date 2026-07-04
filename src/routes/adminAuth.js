import jwt from 'jsonwebtoken'

export function requireRole(...allowed) {
  const allowedSet = new Set(allowed.map((r) => String(r).toUpperCase()))

  return (req, res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''

    if (!token) return res.status(401).json({ message: 'Missing token' })

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret')
      const rawRoles = payload?.roles || []
      const roles = rawRoles.map((r) => {
        const u = String(r).toUpperCase()
        return u === 'ADMIN' || r === 'admin' ? 'ADMIN' : u
      })
      const ok = roles.some((r) => allowedSet.has(r))
      if (!ok) return res.status(403).json({ message: 'Forbidden' })

      req.user = { ...payload, roles }
      next()
    } catch {
      return res.status(401).json({ message: 'Invalid token' })
    }
  }
}

export const requireAdmin = requireRole('ADMIN')
export const requireEditor = requireRole('ADMIN', 'EDITOR')
