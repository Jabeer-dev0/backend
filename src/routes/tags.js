import express from 'express'
import Tag from '../models/Tag.js'
import { requireEditor } from './adminAuth.js'
import { pickDefined, slugify } from '../utils/helpers.js'

const router = express.Router()

router.get('/', async (req, res) => {
  const tags = await Tag.find().sort({ name: 1 }).lean()
  res.json({ tags })
})

router.post('/', requireEditor, async (req, res) => {
  const name = req.body?.name?.trim()
  if (!name) return res.status(400).json({ message: 'Name required' })
  const tag = await Tag.create({ name, slug: slugify(name) })
  res.status(201).json({ tag })
})

router.patch('/:id', requireEditor, async (req, res) => {
  const body = pickDefined(req.body || {})
  if (body.name && !body.slug) body.slug = slugify(body.name)
  const tag = await Tag.findByIdAndUpdate(req.params.id, { $set: body }, { new: true })
  if (!tag) return res.status(404).json({ message: 'Not found' })
  res.json({ tag })
})

router.delete('/:id', requireEditor, async (req, res) => {
  await Tag.findByIdAndDelete(req.params.id)
  res.json({ ok: true })
})

export default router
