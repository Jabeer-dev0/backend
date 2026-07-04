import express from 'express'
import Media from '../models/Media.js'
import { requireEditor } from './adminAuth.js'
import { parseListQuery, pickDefined } from '../utils/helpers.js'

const router = express.Router()

router.get('/', requireEditor, async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = {}
  if (req.query.type) filter.type = req.query.type
  if (req.query.q) filter.filename = { $regex: req.query.q, $options: 'i' }

  const [media, total] = await Promise.all([
    Media.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Media.countDocuments(filter),
  ])
  res.json({ media, total, page, limit })
})

router.post('/', requireEditor, async (req, res) => {
  const body = req.body || {}
  if (!body.url) return res.status(400).json({ message: 'URL/data required' })
  const item = await Media.create(pickDefined(body))
  res.status(201).json({ media: item })
})

router.delete('/:id', requireEditor, async (req, res) => {
  await Media.findByIdAndDelete(req.params.id)
  res.json({ ok: true })
})

export default router
