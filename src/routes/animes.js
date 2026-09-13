import express from 'express'
import Anime from '../models/Anime.js'
import Episode from '../models/Episode.js'
import Bookmark from '../models/Bookmark.js'
import Comment from '../models/Comment.js'
import Feedback from '../models/Feedback.js'
import AnimeRating from '../models/AnimeRating.js'
import { requireEditor } from './adminAuth.js'
import { pickDefined, slugify, parseListQuery, escapeRegex } from '../utils/helpers.js'
import { cacheDel, cacheDelPrefix, cacheGet, cacheSet } from '../utils/cache.js'
import { sendAnimeNotifications } from '../utils/pushNotifications.js'

const router = express.Router()
const ADMIN_LIST_FIELDS = 'title slug type country status visibility moderationStatus views homepagePinUntil accessTier isPaid createdAt'
const ADMIN_PICKER_FIELDS = 'title type status'

// The admin routes expose drafts and operational metadata, so none are public.
router.use(requireEditor)

function clearAnimePublicCaches() {
  cacheDel('public:home')
  cacheDel('public:new-additions')
  cacheDel('public:schedule')
  cacheDel('public:latest-releases')
  cacheDel('public:seo-animes')
  cacheDel('public:sitemap')
  cacheDelPrefix('public:anime:')
  cacheDelPrefix('public:anime-eps:')
  cacheDelPrefix('public:animes:')
  cacheDelPrefix('admin:picker:')
}

function notifyPublishedAnime(anime) {
  if (anime?.visibility !== 'published' || anime?.moderationStatus === 'Rejected') return
  const notificationSentAt = new Date()
  Anime.findOneAndUpdate(
    { _id: anime._id, notificationSentAt: null },
    { $set: { notificationSentAt } },
    { new: true },
  )
    .then((claimed) => {
      if (claimed) sendAnimeNotifications(anime).catch((err) => console.error('Anime push delivery error:', err.message))
    })
    .catch((err) => console.error('Anime notification update error:', err.message))
}

function buildFilter(query) {
  const filter = {}
  if (query.q) {
    const q = escapeRegex(query.q)
    filter.$or = [{ title: { $regex: q, $options: 'i' } }, { slug: { $regex: q, $options: 'i' } }]
  }
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
  const { page, limit: parsedLimit, skip: parsedSkip, sort } = parseListQuery(req.query)
  const limit = req.query.view === 'picker'
    ? Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 5000))
    : parsedLimit
  const skip = req.query.view === 'picker' ? (page - 1) * limit : parsedSkip
  const filter = buildFilter(req.query)
  const fields = req.query.view === 'picker' ? ADMIN_PICKER_FIELDS : ADMIN_LIST_FIELDS

  if (req.query.view === 'picker') {
    const cacheKey = `admin:picker:${limit}:${JSON.stringify(filter)}:${JSON.stringify(sort)}`
    const cached = cacheGet(cacheKey)
    if (cached) return res.json(cached)
    const [animes, total] = await Promise.all([
      Anime.find(filter).sort(sort).skip(skip).limit(limit).select(fields).lean(),
      Anime.countDocuments(filter),
    ])
    const payload = { animes, total, page, limit }
    cacheSet(cacheKey, payload, 300_000)
    return res.json(payload)
  }

  const [animes, total] = await Promise.all([
    Anime.find(filter).sort(sort).skip(skip).limit(limit).select(fields).lean(),
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
    const body = { ...(req.body || {}) }
    delete body.homepagePinUntil
    const title = body.title?.trim()
    if (!title) return res.status(400).json({ message: 'Title required' })

    const anime = await Anime.create({
      ...pickDefined(body),
      title,
      slug: body.slug || slugify(title),
      coverImage: body.coverImage || body.poster || '',
    })
    clearAnimePublicCaches()
    notifyPublishedAnime(anime)
    res.status(201).json({ anime })
  } catch (e) {
    res.status(400).json({ message: e.message })
  }
})

router.patch('/:animeId', requireEditor, async (req, res) => {
  const body = pickDefined(req.body || {})
  delete body.homepagePinUntil
  if (body.title && !body.slug) body.slug = slugify(body.title)
  if (body.poster && !body.coverImage) body.coverImage = body.poster
  if (body.status === 'ongoing') body.finishedAiring = false

  const oldAnime = await Anime.findById(req.params.animeId)
    .select('defaultThumbnail poster visibility moderationStatus')
    .lean()
  const wasDraft = oldAnime?.visibility !== 'published' || oldAnime?.moderationStatus === 'Rejected'
  const anime = await Anime.findByIdAndUpdate(req.params.animeId, { $set: body }, { new: true })
  if (!anime) return res.status(404).json({ message: 'Not found' })

  if (wasDraft && body.visibility === 'published') {
    await Anime.findByIdAndUpdate(req.params.animeId, {
      $set: { featured: true, trending: true, recommended: true },
    })
    anime.featured = true
    anime.trending = true
    anime.recommended = true
  }

  clearAnimePublicCaches()
  if (wasDraft) notifyPublishedAnime(anime)

  if (body.defaultThumbnail != null) {
    const newThumb = body.defaultThumbnail || body.poster || ''
    const oldThumb = oldAnime?.defaultThumbnail || ''
    if (newThumb && newThumb !== oldThumb) {
      await Episode.updateMany(
        { animeId: req.params.animeId },
        { $set: { thumbnail: newThumb } },
      )
    }
  }

  res.json({ anime })
})

router.patch('/:animeId/moderate', requireEditor, async (req, res) => {
  const { moderationStatus } = req.body || {}
  if (!['Approved', 'Rejected', 'Pending'].includes(moderationStatus)) {
    return res.status(400).json({ message: 'Invalid moderation status' })
  }
  const oldAnime = await Anime.findById(req.params.animeId).select('visibility moderationStatus').lean()
  if (!oldAnime) return res.status(404).json({ message: 'Not found' })
  const anime = await Anime.findByIdAndUpdate(
    req.params.animeId,
    { $set: { moderationStatus } },
    { new: true },
  )
  clearAnimePublicCaches()
  if (oldAnime.moderationStatus === 'Rejected') notifyPublishedAnime(anime)
  res.json({ anime })
})

router.post('/:animeId/pin-homepage', requireEditor, async (req, res) => {
  const existing = await Anime.findById(req.params.animeId).select('visibility moderationStatus').lean()
  if (!existing) return res.status(404).json({ message: 'Not found' })
  if (existing.visibility !== 'published' || existing.moderationStatus === 'Rejected') {
    return res.status(400).json({ message: 'Publish and approve the anime before pinning it' })
  }
  const homepagePinUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const anime = await Anime.findByIdAndUpdate(
    req.params.animeId,
    { $set: { homepagePinUntil } },
    { new: true },
  )
  if (!anime) return res.status(404).json({ message: 'Not found' })
  clearAnimePublicCaches()
  res.json({ anime, homepagePinUntil })
})

router.delete('/:animeId/pin-homepage', requireEditor, async (req, res) => {
  const anime = await Anime.findByIdAndUpdate(
    req.params.animeId,
    { $set: { homepagePinUntil: null } },
    { new: true },
  )
  if (!anime) return res.status(404).json({ message: 'Not found' })
  clearAnimePublicCaches()
  res.json({ anime, homepagePinUntil: null })
})

router.delete('/:animeId', requireEditor, async (req, res) => {
  const anime = await Anime.findByIdAndDelete(req.params.animeId)
  if (!anime) return res.status(404).json({ message: 'Not found' })
  clearAnimePublicCaches()
  const animeId = req.params.animeId
  await Promise.all([
    Episode.deleteMany({ animeId }),
    Bookmark.deleteMany({ animeId }),
    Comment.deleteMany({ animeId }),
    AnimeRating.deleteMany({ animeId }),
    Feedback.deleteMany({ animeTitle: anime.title }),
  ])
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
  else if (action === 'recommended') update = { recommended: true }
  else if (action === 'mark-complete') update = { featured: true, trending: true, recommended: true }
  else if (action === 'delete') {
    const targetAnimes = await Anime.find({ _id: { $in: ids } }).select('title').lean()
    const titles = targetAnimes.map((a) => a.title)
    await Promise.all([
      Episode.deleteMany({ animeId: { $in: ids } }),
      Bookmark.deleteMany({ animeId: { $in: ids } }),
      Comment.deleteMany({ animeId: { $in: ids } }),
      AnimeRating.deleteMany({ animeId: { $in: ids } }),
      Feedback.deleteMany({ animeTitle: { $in: titles } }),
      Anime.deleteMany({ _id: { $in: ids } }),
    ])
    clearAnimePublicCaches()
    return res.json({ ok: true, deleted: ids.length })
  } else return res.status(400).json({ message: 'Unknown action' })

  const toPublish = action === 'publish'
    ? await Anime.find({ _id: { $in: ids }, visibility: { $ne: 'published' } }).lean()
    : []
  const result = await Anime.updateMany({ _id: { $in: ids } }, { $set: update })
  clearAnimePublicCaches()
  for (const anime of toPublish) notifyPublishedAnime({ ...anime, visibility: 'published' })
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
    homepagePinUntil: null,
  })
  clearAnimePublicCaches()
  res.status(201).json({ anime: copy })
})

export default router
