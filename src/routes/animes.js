import express from 'express'
import Anime from '../models/Anime.js'
import Episode from '../models/Episode.js'
import { requireEditor } from './adminAuth.js'
import { pickDefined, slugify, parseListQuery } from '../utils/helpers.js'

const router = express.Router()

function buildFilter(query) {
  const filter = {}
  if (query.q) filter.$or = [{ title: { $regex: query.q, $options: 'i' } }, { slug: { $regex: query.q, $options: 'i' } }]
  if (query.status) filter.status = query.status
  if (query.visibility) filter.visibility = query.visibility
  if (query.type) filter.type = query.type
  if (query.season) filter.season = query.season
  if (query.year) filter.releaseYear = parseInt(query.year, 10)
  if (query.genre) filter.genres = query.genre
  if (query.featured === 'true') filter.featured = true
  if (query.trending === 'true') filter.trending = true
  if (query.moderationStatus) filter.moderationStatus = query.moderationStatus
  if (query.published === 'true') filter.visibility = 'published'
  if (query.published === 'false') filter.visibility = { $ne: 'published' }
  return filter
}

router.get('/', async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = buildFilter(req.query)
  const [animes, total] = await Promise.all([
    Anime.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Anime.countDocuments(filter),
  ])
  res.json({ animes, total, page, limit })
})

router.get('/:animeId', async (req, res) => {
  const anime = await Anime.findById(req.params.animeId).lean()
  if (!anime) return res.status(404).json({ message: 'Not found' })
  res.json({ anime })
})

router.post('/', requireEditor, async (req, res) => {
  try {
    const body = req.body || {}
    const title = body.title?.trim()
    if (!title) return res.status(400).json({ message: 'Title required' })

    const anime = await Anime.create({
      ...pickDefined(body),
      title,
      slug: body.slug || slugify(title),
      coverImage: body.coverImage || body.poster || '',
    })
    res.status(201).json({ anime })
  } catch (e) {
    res.status(400).json({ message: e.message })
  }
})

router.patch('/:animeId', requireEditor, async (req, res) => {
  const body = pickDefined(req.body || {})
  if (body.title && !body.slug) body.slug = slugify(body.title)
  if (body.poster && !body.coverImage) body.coverImage = body.poster

  const anime = await Anime.findByIdAndUpdate(req.params.animeId, { $set: body }, { new: true })
  if (!anime) return res.status(404).json({ message: 'Not found' })
  res.json({ anime })
})

router.delete('/:animeId', requireEditor, async (req, res) => {
  const anime = await Anime.findByIdAndDelete(req.params.animeId)
  if (!anime) return res.status(404).json({ message: 'Not found' })
  await Episode.deleteMany({ animeId: req.params.animeId })
  res.json({ ok: true })
})

router.post('/bulk', requireEditor, async (req, res) => {
  const { ids = [], action } = req.body || {}
  if (!ids.length) return res.status(400).json({ message: 'No ids provided' })

  let update = {}
  if (action === 'publish') update = { visibility: 'published' }
  else if (action === 'unpublish') update = { visibility: 'draft' }
  else if (action === 'feature') update = { featured: true }
  else if (action === 'trending') update = { trending: true }
  else if (action === 'delete') {
    await Episode.deleteMany({ animeId: { $in: ids } })
    await Anime.deleteMany({ _id: { $in: ids } })
    return res.json({ ok: true, deleted: ids.length })
  } else return res.status(400).json({ message: 'Unknown action' })

  const result = await Anime.updateMany({ _id: { $in: ids } }, { $set: update })
  res.json({ ok: true, modified: result.modifiedCount })
})

router.post('/:animeId/duplicate', requireEditor, async (req, res) => {
  const source = await Anime.findById(req.params.animeId).lean()
  if (!source) return res.status(404).json({ message: 'Not found' })
  const { _id, createdAt, updatedAt, ...rest } = source
  const copy = await Anime.create({
    ...rest,
    title: `${rest.title} (Copy)`,
    slug: `${rest.slug || slugify(rest.title)}-copy-${Date.now()}`,
    visibility: 'draft',
  })
  res.status(201).json({ anime: copy })
})

export default router
