import express from 'express'
import User from '../models/User.js'
import { requireAdmin } from './adminAuth.js'
import { parseListQuery, pickDefined } from '../utils/helpers.js'

const router = express.Router()

router.get('/', requireAdmin, async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = {}
  if (req.query.role) filter.role = req.query.role
  if (req.query.verified === 'true') filter.verified = true
  if (req.query.verified === 'false') filter.verified = false
  if (req.query.q) {
    filter.$or = [
      { username: { $regex: req.query.q, $options: 'i' } },
      { email: { $regex: req.query.q, $options: 'i' } },
    ]
  }

  const [users, total] = await Promise.all([
    User.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ])
  res.json({ users, total, page, limit })
})

router.get('/:id', requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id).lean()
  if (!user) return res.status(404).json({ message: 'Not found' })
  res.json({ user })
})

router.post('/', requireAdmin, async (req, res) => {
  const body = req.body || {}
  if (!body.username || !body.email) return res.status(400).json({ message: 'Username and email required' })
  const user = await User.create(pickDefined(body))
  res.status(201).json({ user })
})

router.patch('/:id', requireAdmin, async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { $set: pickDefined(req.body || {}) }, { new: true })
  if (!user) return res.status(404).json({ message: 'Not found' })
  res.json({ user })
})

router.delete('/:id', requireAdmin, async (req, res) => {
  await User.findByIdAndDelete(req.params.id)
  res.json({ ok: true })
})

export default router
