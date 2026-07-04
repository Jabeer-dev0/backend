import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import AdminUser from '../models/AdminUser.js'
import { requireAdmin } from './adminAuth.js'

const router = express.Router()

const ADMIN_CREDENTIALS = {
  username: 'jabeergaming48',
  password: 'Jabeer24680',
}

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), roles: user.roles, email: user.email, name: user.name },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  )
}

router.post('/password-login', async (req, res) => {
  try {
    const { username, password } = req.body || {}
    if (username !== ADMIN_CREDENTIALS.username || password !== ADMIN_CREDENTIALS.password) {
      return res.status(401).json({ message: 'Invalid admin credentials.' })
    }

    let user = await AdminUser.findOne({ username: ADMIN_CREDENTIALS.username })
    if (!user) {
      user = await AdminUser.findOne({ email: 'admin@animebox.local' })
    }
    if (!user) {
      user = await AdminUser.create({
        username: ADMIN_CREDENTIALS.username,
        email: 'admin@animebox.local',
        name: 'Admin',
        roles: ['ADMIN'],
      })
    } else if (!user.roles.some((r) => String(r).toUpperCase() === 'ADMIN')) {
      user.roles = ['ADMIN']
      user.username = user.username || ADMIN_CREDENTIALS.username
      await user.save()
    }

    const token = signToken(user)
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        name: user.name,
        roles: user.roles,
        avatar: user.avatar,
        twoFactorEnabled: user.twoFactorEnabled,
      },
    })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

router.post('/login', async (req, res) => {
  try {
    const { email, googleSub } = req.body || {}
    if (!email && !googleSub) return res.status(400).json({ message: 'Missing login payload' })

    let user = null
    if (googleSub) user = await AdminUser.findOne({ googleSub })
    if (!user && email) user = await AdminUser.findOne({ email })

    if (!user) {
      user = await AdminUser.create({
        googleSub: googleSub || undefined,
        email: email || 'admin@example.com',
        name: 'Admin',
        roles: ['ADMIN'],
      })
    }

    res.json({ token: signToken(user), user })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

router.get('/me', requireAdmin, async (req, res) => {
  const user = await AdminUser.findById(req.user.sub).lean()
  if (!user) return res.status(404).json({ message: 'Not found' })
  res.json({
    user: {
      id: user._id,
      username: user.username,
      email: user.email,
      name: user.name,
      roles: user.roles,
      avatar: user.avatar,
      twoFactorEnabled: user.twoFactorEnabled,
    },
  })
})

router.patch('/profile', requireAdmin, async (req, res) => {
  const body = req.body || {}
  const user = await AdminUser.findByIdAndUpdate(
    req.user.sub,
    {
      $set: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
        ...(body.twoFactorEnabled !== undefined ? { twoFactorEnabled: body.twoFactorEnabled } : {}),
      },
    },
    { new: true },
  )
  if (!user) return res.status(404).json({ message: 'Not found' })
  res.json({ user })
})

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ message: 'Email required' })

  const user = await AdminUser.findOne({ email })
  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex')
    user.resetToken = resetToken
    user.resetTokenExpiry = new Date(Date.now() + 3600000)
    await user.save()
  }

  res.json({ ok: true, message: 'If an account exists, reset instructions were sent.' })
})

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {}
  if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password required' })

  const user = await AdminUser.findOne({
    resetToken: token,
    resetTokenExpiry: { $gt: new Date() },
  })

  if (!user) return res.status(400).json({ message: 'Invalid or expired token' })

  user.resetToken = ''
  user.resetTokenExpiry = null
  await user.save()

  res.json({ ok: true, message: 'Password reset structure ready. Contact admin to finalize credentials.' })
})

export default router
