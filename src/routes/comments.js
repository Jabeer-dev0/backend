import express from 'express'
import Comment from '../models/Comment.js'
import { requireEditor } from './adminAuth.js'
import { parseListQuery, pickDefined } from '../utils/helpers.js'

const router = express.Router()

router.get('/', requireEditor, async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = {}
  if (req.query.status) filter.status = req.query.status
  if (req.query.animeId) filter.animeId = req.query.animeId
  if (req.query.episodeId) filter.episodeId = req.query.episodeId
  if (req.query.q) filter.content = { $regex: req.query.q, $options: 'i' }

  const [comments, total] = await Promise.all([
    Comment.find(filter)
      .populate('animeId', 'title')
      .populate('episodeId', 'title episodeNo')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Comment.countDocuments(filter),
  ])
  res.json({ comments, total, page, limit })
})

router.post('/', async (req, res) => {
  const body = req.body || {}
  if (!body.content) return res.status(400).json({ message: 'Content required' })
  const comment = await Comment.create({
    ...pickDefined(body),
    status: body.status || 'approved',
  })
  res.status(201).json({ comment })
})

router.patch('/:id', requireEditor, async (req, res) => {
  const comment = await Comment.findByIdAndUpdate(req.params.id, { $set: pickDefined(req.body || {}) }, { new: true })
  if (!comment) return res.status(404).json({ message: 'Not found' })
  res.json({ comment })
})

router.delete('/:id', requireEditor, async (req, res) => {
  await Comment.findByIdAndDelete(req.params.id)
  res.json({ ok: true })
})

router.post('/bulk', requireEditor, async (req, res) => {
  const { ids = [], action } = req.body || {}
  if (action === 'delete') {
    await Comment.deleteMany({ _id: { $in: ids } })
    return res.json({ ok: true })
  }
  const statusMap = { approve: 'approved', hide: 'hidden', pending: 'pending' }
  if (!statusMap[action]) return res.status(400).json({ message: 'Unknown action' })
  await Comment.updateMany({ _id: { $in: ids } }, { $set: { status: statusMap[action] } })
  res.json({ ok: true })
})

export default router
