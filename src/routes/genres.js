import express from 'express'
import Genre from '../models/Genre.js'
import { requireEditor } from './adminAuth.js'
import { pickDefined, slugify } from '../utils/helpers.js'

const router = express.Router()

router.get('/', async (req, res) => {
  const genres = await Genre.find().sort({ name: 1 }).lean()
  res.json({ genres })
})

router.post('/', requireEditor, async (req, res) => {
  const name = req.body?.name?.trim()
  if (!name) return res.status(400).json({ message: 'Name required' })
  const genre = await Genre.create({ name, slug: slugify(name), ...pickDefined(req.body) })
  res.status(201).json({ genre })
})

router.patch('/:id', requireEditor, async (req, res) => {
  const body = pickDefined(req.body || {})
  if (body.name && !body.slug) body.slug = slugify(body.name)
  const genre = await Genre.findByIdAndUpdate(req.params.id, { $set: body }, { new: true })
  if (!genre) return res.status(404).json({ message: 'Not found' })
  res.json({ genre })
})

router.delete('/:id', requireEditor, async (req, res) => {
  await Genre.findByIdAndDelete(req.params.id)
  res.json({ ok: true })
})

export default router
