import express from 'express'
import { Buffer } from 'node:buffer'
import Anime from '../models/Anime.js'
import Episode from '../models/Episode.js'
import Genre from '../models/Genre.js'
import SiteSettings from '../models/SiteSettings.js'
import { parseListQuery } from '../utils/helpers.js'
import VideoFile from '../models/VideoFile.js'
import Comment from '../models/Comment.js'
import Feedback from '../models/Feedback.js'
import EpisodeWatchLog from '../models/EpisodeWatchLog.js'
import EpisodeLike from '../models/EpisodeLike.js'
import Bookmark from '../models/Bookmark.js'
import { resolveVideoPath, pipeLocalVideo, enrichEpisodeVideo } from '../utils/videoStorage.js'
import { streamFromR2 } from '../utils/r2Storage.js'
import { releaseDueEpisodes } from '../utils/episodeScheduler.js'
import { generateWeeklyEpisodes, computeAllWeeklySchedules, computeNextWeeklySchedule } from '../utils/weeklySchedule.js'
import { applyFinishedAiringFlag, convertUpcomingToOngoing } from '../utils/newAdditionsScheduler.js'
import { extractUserToken, requireUser, verifyUserToken } from './userAuth.js'
import User from '../models/User.js'
import Post from '../models/Post.js'
import { cacheDel, cacheDelPrefix, cacheGet, cacheSet, setPublicCache, releaseDueIfNeeded, weeklyIfNeeded } from '../utils/cache.js'
import { isWorker, lazyNodeImport } from '../utils/runtime.js'
import { isAIEnabled, moderateText } from '../services/ai.js'

const router = express.Router()

const isHexId = (value) => /^[a-f0-9]{24}$/i.test(String(value || ''))

const publishedAnimeFilter = { visibility: 'published', moderationStatus: { $ne: 'Rejected' } }
const CARD_FIELDS = 'title alternateTitle japaneseTitle shortTitle poster coverImage banner slug type country studio status genres subAvailable dubAvailable featured trending views description tagline recommended finishedAiring accessTier isPaid defaultThumbnail releaseYear season ratingAvg ratingCount homepagePinUntil'
const SEO_FIELDS = 'slug title alternateTitle japaneseTitle shortTitle description tagline type country status season releaseYear releaseDate releaseStartDate ageRating studio sourceMaterial genres totalEpisodes runtime metaTitle metaDescription ratingAvg ratingCount updatedAt createdAt'
const BROWSE_SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  rating: { ratingAvg: -1, views: -1 },
  views: { views: -1, ratingAvg: -1 },
  title: { title: 1 },
  release: { releaseYear: -1, createdAt: -1 },
}
const IMAGE_FIELDS = {
  anime: ['poster', 'coverImage', 'banner', 'defaultThumbnail'],
  episode: ['thumbnail'],
}
const INLINE_IMAGE_PATTERN = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i

function publicImageUrl(req, type, doc, field) {
  const value = doc?.[field]
  if (typeof value !== 'string' || !INLINE_IMAGE_PATTERN.test(value)) return value
  return `${req.protocol}://${req.get('host')}/api/public/images/${type}/${doc._id}/${field}`
}

function publicAnime(req, anime) {
  if (!anime) return anime
  const item = { ...anime }
  for (const field of IMAGE_FIELDS.anime) item[field] = publicImageUrl(req, 'anime', anime, field)
  return item
}

function publicEpisode(req, episode) {
  if (!episode) return episode
  const item = { ...episode }
  for (const field of IMAGE_FIELDS.episode) item[field] = publicImageUrl(req, 'episode', episode, field)
  if (item.animeId && typeof item.animeId === 'object') item.animeId = publicAnime(req, item.animeId)
  return item
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pickPublicSettings(settings = {}) {
  return {
    siteName: settings.siteName,
    siteLogo: settings.siteLogo,
    favicon: settings.favicon,
    footerText: settings.footerText,
    socialLinks: settings.socialLinks,
    contactEmail: settings.contactEmail,
    heroTitle: settings.heroTitle,
    heroSubtitle: settings.heroSubtitle,
    featuredAnimeIds: settings.featuredAnimeIds,
  }
}

function orderByIds(items, ids) {
  const order = new Map(ids.map((id, i) => [String(id), i]))
  return items.slice().sort((a, b) => (order.get(String(a._id)) ?? 999) - (order.get(String(b._id)) ?? 999))
}

let lastPinCleanup = 0
let seoAnimesRequest = null

function seoAnime(req, anime) {
  if (!anime) return anime
  // Fetch artwork individually so a bulk SEO export never includes base64 images.
  const poster = `${req.protocol}://${req.get('host')}/api/public/images/anime/${anime._id}/poster`
  return { ...anime, poster, coverImage: poster, banner: poster }
}

async function getSeoAnimes() {
  const cacheKey = 'public:seo-animes'
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  // A cold cache can be requested by several prerender workers at once. Share
  // the single D1 query instead of issuing one large export per request.
  if (!seoAnimesRequest) {
    seoAnimesRequest = Anime.find(publishedAnimeFilter)
      .select(SEO_FIELDS)
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean()
      .then((animes) => {
        cacheSet(cacheKey, animes, 3600_000)
        return animes
      })
      .finally(() => { seoAnimesRequest = null })
  }
  return seoAnimesRequest
}

async function clearExpiredHomepagePins() {
  const now = Date.now()
  if (now - lastPinCleanup < 60_000) return
  lastPinCleanup = now
  const result = await Anime.updateMany(
    { homepagePinUntil: { $ne: null, $lte: new Date(now) } },
    { $set: { homepagePinUntil: null } },
  )
  if (result.modifiedCount) {
    cacheDel('public:home')
    cacheDel('public:new-additions')
    cacheDelPrefix('public:animes:')
  }
}

async function refreshPublicSchedules() {
  await releaseDueIfNeeded(releaseDueEpisodes).catch((err) => console.error('Release scheduler error:', err.message))
  await weeklyIfNeeded(generateWeeklyEpisodes)
}

function mergePinned(pinned, items, limit) {
  const seen = new Set()
  return [...pinned, ...items].filter((anime) => {
    const id = String(anime?._id || '')
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }).slice(0, limit)
}

function addPinSort(sort) {
  if (sort && typeof sort === 'object') return { homepagePinUntil: -1, ...sort }
  if (!sort || typeof sort !== 'string') return { homepagePinUntil: -1, createdAt: -1 }
  const field = sort.replace(/^-/, '')
  return { homepagePinUntil: -1, [field]: sort.startsWith('-') ? -1 : 1 }
}

function releasedEpisodeFilter(animeId) {
  const now = new Date()
  return {
    animeId,
    published: true,
    $or: [
      { status: 'released' },
      { status: 'scheduled', releaseAt: { $lte: now } },
    ],
  }
}

async function getSettings() {
  const cached = cacheGet('public:settings:doc')
  if (cached) return cached

  let settings = await SiteSettings.findOne({ key: 'global' })
  if (!settings) {
    try {
      settings = await SiteSettings.create({
        key: 'global',
        siteName: 'AniKura',
        heroTitle: 'Watch Anime on AniKura',
        heroSubtitle: 'Discover trending series, fresh episodes, and upcoming releases — all in one place.',
      })
    } catch (err) {
      if (err?.code === 11000) {
        settings = await SiteSettings.findOne({ key: 'global' })
      } else {
        throw err
      }
    }
  }
  cacheSet('public:settings:doc', settings, 120_000)
  return settings
}

router.get('/settings', async (req, res) => {
  const cached = cacheGet('public:settings')
  if (cached) {
    setPublicCache(res, 120)
    return res.json({ settings: cached })
  }
  const settings = await getSettings()
  const publicSettings = pickPublicSettings(settings?.toObject?.() || settings)
  cacheSet('public:settings', publicSettings, 120_000)
  setPublicCache(res, 120)
  res.json({ settings: publicSettings })
})

router.get('/images/:type/:id/:field', async (req, res) => {
  const type = req.params.type
  const field = req.params.field
  const fields = IMAGE_FIELDS[type]
  if (!fields?.includes(field)) return res.status(404).end()

  const Model = type === 'anime' ? Anime : Episode
  const filter = type === 'anime'
    ? { _id: req.params.id, ...publishedAnimeFilter }
    : { _id: req.params.id, published: true }
  const document = type === 'anime'
    ? await Model.findOne(filter).select(fields.join(' ')).lean()
    : await Model.findOne(filter)
      .select(`animeId ${fields.join(' ')}`)
      .populate({ path: 'animeId', match: publishedAnimeFilter })
      .lean()
  if (!document || (type === 'episode' && !document.animeId)) return res.status(404).end()
  const value = type === 'anime' && field === 'poster'
    ? [document?.poster, document?.coverImage, document?.banner, document?.defaultThumbnail]
      .find((image) => typeof image === 'string' && image) || ''
    : document?.[field] || ''
  const match = INLINE_IMAGE_PATTERN.exec(value)
  if (!match) {
    if (typeof value === 'string' && value) return res.redirect(302, value)
    return res.status(404).end()
  }

  res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  res.type(match[1]).send(Buffer.from(match[2], 'base64'))
})

router.get('/home', async (req, res) => {
  await clearExpiredHomepagePins()
  const cached = cacheGet('public:home')
  if (cached) {
    setPublicCache(res, 60)
    return res.json(cached)
  }

  refreshPublicSchedules()


  const settingsDoc = await getSettings()
  const settings = settingsDoc?.toObject?.() || settingsDoc || {}
  const publicSettings = pickPublicSettings(settings)
  const featuredIds = (publicSettings.featuredAnimeIds || []).map(String)
  const now = new Date()

  const queries = [
    Anime.find(publishedAnimeFilter)
      .sort({ createdAt: -1 })
      .limit(80)
      .select(CARD_FIELDS)
      .lean(),
    Genre.find().sort({ name: 1 }).limit(12).select('name slug').lean(),
    Episode.find({
      published: true,
      $or: [{ status: 'released' }, { status: 'scheduled', releaseAt: { $lte: now } }],
    })
      .populate({ path: 'animeId', match: publishedAnimeFilter, select: 'title poster coverImage banner slug status type studio ratingAvg' })
      .sort({ createdAt: -1 })
      .limit(12)
      .select('title episodeNo episodeType serialNumber thumbnail animeId createdAt views rating')
      .lean(),
    Anime.find({ ...publishedAnimeFilter, homepagePinUntil: { $gt: now } })
      .sort({ homepagePinUntil: -1 })
      .select(CARD_FIELDS)
      .lean(),
  ]

  if (featuredIds.length) {
    queries.push(
      Anime.find({ _id: { $in: featuredIds }, ...publishedAnimeFilter })
        .select(CARD_FIELDS)
        .lean(),
    )
  }

  const [allPublished, genres, latestEpisodes, pinnedDocs, heroDocs] = await Promise.all(queries)

  const published = allPublished.filter(Boolean)
  const pinned = (pinnedDocs || []).filter(Boolean)

  const heroSpotlights = featuredIds.length
    ? orderByIds((heroDocs || []).filter(Boolean), featuredIds).slice(0, 3)
    : []

  const featured = mergePinned(pinned, published.filter((a) => a.featured && !heroSpotlights.some((h) => String(h._id) === String(a._id))), 6)

  const latest = mergePinned(pinned, published, 12)
  const spotlight = heroSpotlights[0] || latest[0] || null
  const trendingMarked = published.filter((a) => a.trending)
  const trending = mergePinned(pinned, trendingMarked.length ? trendingMarked : [...published].sort((a, b) => (b.views || 0) - (a.views || 0)), 8)

  const payload = {
    _v: '1.3.0',
    settings: publicSettings,
    spotlight: publicAnime(req, spotlight),
    heroSpotlights: heroSpotlights.map((anime) => publicAnime(req, anime)),
    featured: featured.map((anime) => publicAnime(req, anime)),
    trending: trending.map((anime) => publicAnime(req, anime)),
    recommended: mergePinned(pinned, published.filter((a) => a.recommended), 8).map((anime) => publicAnime(req, anime)),
    latest: latest.map((anime) => publicAnime(req, anime)),
    ongoing: published.filter((a) => a.status === 'ongoing').slice(0, 8).map((anime) => publicAnime(req, anime)),
    finishedAiring: published.filter((a) => a.finishedAiring && a.status === 'completed').slice(0, 8).map((anime) => publicAnime(req, anime)),
    upcoming: published.filter((a) => a.status === 'upcoming').slice(0, 8).map((anime) => publicAnime(req, anime)),
    latestEpisodes: latestEpisodes.filter((e) => e.animeId).map((episode) => publicEpisode(req, episode)),
    genres,
  }

  cacheSet('public:home', payload, 300_000)
  setPublicCache(res, 300)
  res.json(payload)
})

router.get('/animes', async (req, res) => {
  await clearExpiredHomepagePins()
  const { page, limit, skip } = parseListQuery(req.query)
  const sort = BROWSE_SORTS[req.query.sort] || BROWSE_SORTS.newest
  const cacheKey = `public:animes:${JSON.stringify({
    q: req.query.q || '',
    status: req.query.status || '',
    type: req.query.type || '',
    country: req.query.country || '',
    genre: req.query.genre || '',
    year: req.query.year || '',
    season: req.query.season || '',
    featured: req.query.featured || '',
    trending: req.query.trending || '',
    recommended: req.query.recommended || '',
    sub: req.query.sub || '',
    dub: req.query.dub || '',
    page,
    limit,
    sort: req.query.sort || 'newest',
  })}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    setPublicCache(res, 60)
    return res.json(cached)
  }


  const filter = { ...publishedAnimeFilter }
  if (req.query.q) {
    const q = escapeRegex(String(req.query.q).trim().slice(0, 80))
    filter.$or = [
      { title: { $regex: q, $options: 'i' } },
      { alternateTitle: { $regex: q, $options: 'i' } },
      { japaneseTitle: { $regex: q, $options: 'i' } },
      { shortTitle: { $regex: q, $options: 'i' } },
      { slug: { $regex: q, $options: 'i' } },
      { studio: { $regex: q, $options: 'i' } },
    ]
  }
  if (req.query.status) filter.status = req.query.status
  if (req.query.type) filter.type = req.query.type
  if (req.query.country) filter.country = req.query.country
  if (req.query.genre) filter.genres = { $contains: String(req.query.genre).slice(0, 80) }
  if (req.query.year) filter.releaseYear = parseInt(req.query.year, 10)
  if (req.query.season) filter.season = req.query.season
  if (req.query.featured === 'true') filter.featured = true
  if (req.query.trending === 'true') filter.trending = true
  if (req.query.recommended === 'true') filter.recommended = true
  if (req.query.sub === 'true') filter.subAvailable = true
  if (req.query.dub === 'true') filter.dubAvailable = true

  const pinRelevant = req.query.featured === 'true' || req.query.trending === 'true' || req.query.recommended === 'true'
  const rows = await Anime.find(filter).sort(pinRelevant ? addPinSort(sort) : sort).skip(skip).limit(limit + 1).select(CARD_FIELDS).lean()
  const hasMore = rows.length > limit
  const animes = hasMore ? rows.slice(0, limit) : rows
  const total = skip + animes.length + (hasMore ? 1 : 0)
  const payload = { animes: animes.map((anime) => publicAnime(req, anime)), total, page, limit, hasMore }
  cacheSet(cacheKey, payload, 60_000)
  setPublicCache(res, 60)
  res.json(payload)
})

router.get('/recommendations/me', requireUser, async (req, res) => {
  const userId = req.user.sub
  const cacheKey = `private:recommendations:${userId}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    res.set('Cache-Control', 'private, no-store')
    return res.json(cached)
  }
  const [bookmarks, history] = await Promise.all([
    Bookmark.find({ userId }).select('animeId').limit(100).lean(),
    EpisodeWatchLog.find({ viewerId: userId }).sort({ lastWatchedAt: -1 }).select('animeId').limit(100).lean(),
  ])

  const bookmarkedIds = new Set(bookmarks.map((item) => String(item.animeId)).filter(Boolean))
  const seenIds = new Set([...bookmarkedIds, ...history.map((item) => String(item.animeId)).filter(Boolean)])
  if (!seenIds.size) {
    const payload = { animes: [] }
    cacheSet(cacheKey, payload, 120_000)
    res.set('Cache-Control', 'private, no-store')
    return res.json(payload)
  }

  const sources = await Anime.find({ _id: { $in: [...seenIds] } }).select('genres').lean()
  const genreWeights = new Map()
  for (const anime of sources) {
    const weight = bookmarkedIds.has(String(anime._id)) ? 3 : 1
    for (const genre of anime.genres || []) {
      genreWeights.set(genre, (genreWeights.get(genre) || 0) + weight)
    }
  }

  if (!genreWeights.size) {
    const payload = { animes: [] }
    cacheSet(cacheKey, payload, 120_000)
    res.set('Cache-Control', 'private, no-store')
    return res.json(payload)
  }

  const candidates = await Anime.find({ ...publishedAnimeFilter, _id: { $nin: [...seenIds] } })
    .sort({ views: -1, ratingAvg: -1 })
    .limit(240)
    .select(CARD_FIELDS)
    .lean()
  const animes = candidates
    .map((anime) => ({
      anime,
      score: (anime.genres || []).reduce((total, genre) => total + (genreWeights.get(genre) || 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (b.anime.ratingAvg || 0) - (a.anime.ratingAvg || 0) || (b.anime.views || 0) - (a.anime.views || 0))
    .slice(0, 8)
    .map((item) => publicAnime(req, item.anime))

  const payload = { animes }
  cacheSet(cacheKey, payload, 120_000)
  res.set('Cache-Control', 'private, no-store')
  res.json(payload)
})

router.get('/animes/:animeId', async (req, res) => {
  const cacheKey = `public:anime:${req.params.animeId}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    setPublicCache(res, 90)
    return res.json(cached)
  }

  const param = req.params.animeId
  const isObjectId = isHexId(param)
  const anime = await Anime.findOne({
    ...publishedAnimeFilter,
    ...(isObjectId ? { _id: param } : { slug: param }),
  }).lean()
  if (!anime) return res.status(404).json({ message: 'Not found' })

  // Real scheduled episode (with video, waiting for releaseAt)
  const nextScheduled = await Episode.findOne({
    animeId: anime._id,
    status: 'scheduled',
    published: true,
    releaseAt: { $gt: new Date() },
  })
    .sort({ releaseAt: 1 })
    .select('episodeNo episodeType title releaseAt status')
    .lean()

  // If no real scheduled episode, compute from weeklySchedule config
  const computedSchedule = !nextScheduled ? await computeNextWeeklySchedule({
    ...anime,
    weeklySchedule: typeof anime.weeklySchedule === 'string' ? JSON.parse(anime.weeklySchedule || '{}') : (anime.weeklySchedule || {}),
  }) : null

  const payload = {
    anime: publicAnime(req, anime),
    nextScheduled: nextScheduled || (computedSchedule ? {
      episodeNo: computedSchedule.episodeNo,
      title: computedSchedule.title,
      releaseAt: computedSchedule.releaseAt,
      status: 'not_out_yet',
      note: 'Not Out Yet',
    } : null),
  }
  cacheSet(cacheKey, payload, 90_000)
  setPublicCache(res, 90)
  res.json(payload)
})

router.get('/animes/:animeId/episodes', async (req, res) => {
  const cacheKey = `public:anime-eps:${req.params.animeId}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    setPublicCache(res, 60)
    return res.json(cached)
  }

  refreshPublicSchedules()
  const param = req.params.animeId
  const isObjectId = isHexId(param)
  const anime = await Anime.findOne({
    ...publishedAnimeFilter,
    ...(isObjectId ? { _id: param } : { slug: param }),
  }).lean()
  if (!anime) return res.status(404).json({ message: 'Anime not found' })

  const episodes = await Episode.aggregate([
    {
      $match: {
        animeId: anime._id,
        published: true,
        $or: [
          { status: 'released' },
          { status: 'scheduled', releaseAt: { $lte: new Date() } },
        ],
      },
    },
    { $addFields: { _sortKey: { $ifNull: ['$serialNumber', 1000000] } } },
    { $sort: { _sortKey: 1, episodeNo: 1 } },
    { $project: { _sortKey: 0 } },
  ]).allowDiskUse(false)

  const payload = { episodes: episodes.map((episode) => publicEpisode(req, episode)) }
  cacheSet(cacheKey, payload, 60_000)
  setPublicCache(res, 60)
  res.json(payload)
})

router.get('/animes/:animeId/recommendations', async (req, res) => {
  const cacheKey = `public:anime-rec:${req.params.animeId}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    setPublicCache(res, 120)
    return res.json(cached)
  }

  const param = req.params.animeId
  const isObjectId = isHexId(param)
  const anime = await Anime.findOne({
    ...publishedAnimeFilter,
    ...(isObjectId ? { _id: param } : { slug: param }),
  }).lean()
  if (!anime) return res.status(404).json({ message: 'Not found' })

  const selfId = String(anime._id)
  const relatedIds = (anime.relatedAnimeIds || [])
    .map(String)
    .filter((id) => id && id !== selfId)

  const related = relatedIds.length
    ? await Anime.find({ _id: { $in: relatedIds }, ...publishedAnimeFilter })
      .select('title poster coverImage banner type studio status genres subAvailable dubAvailable featured trending')
      .lean()
    : []

  const relatedOrder = new Map(relatedIds.map((id, i) => [id, i]))
  related.sort((a, b) => (relatedOrder.get(String(a._id)) ?? 0) - (relatedOrder.get(String(b._id)) ?? 0))

  const genres = (anime.genres || []).filter(Boolean)
  const excludeIds = [anime._id, ...related.map((a) => a._id)]

  let similar = []
  if (genres.length) {
    const candidates = await Anime.find({
      _id: { $nin: excludeIds },
      ...publishedAnimeFilter,
    })
      .select('title poster coverImage banner type studio status genres subAvailable dubAvailable featured trending views')
      .limit(24)
      .lean()

    similar = candidates
      .map((item) => ({
        item,
        score: (item.genres || []).filter((g) => genres.includes(g)).length,
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || (b.item.views || 0) - (a.item.views || 0))
      .slice(0, 8)
      .map(({ item }) => item)
  }

  const payload = {
    related: related.map((item) => publicAnime(req, item)),
    similar: similar.map((item) => publicAnime(req, item)),
  }
  cacheSet(cacheKey, payload, 120_000)
  setPublicCache(res, 120)
  res.json(payload)
})

async function getReleasedEpisode(episodeId) {
  const episode = await Episode.findById(episodeId)
    .populate({ path: 'animeId', match: publishedAnimeFilter })
    .lean()
  if (!episode || !episode.animeId) return null

  const now = new Date()
  const released =
    episode.published &&
    (episode.status === 'released' || (episode.status === 'scheduled' && episode.releaseAt && new Date(episode.releaseAt) <= now))
  return released ? episode : null
}

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ results: [] })

  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10))
  const regex = escapeRegex(q)

  const results = await Anime.find({
    ...publishedAnimeFilter,
    $or: [
      { title: { $regex: regex, $options: 'i' } },
      { alternateTitle: { $regex: regex, $options: 'i' } },
      { japaneseTitle: { $regex: regex, $options: 'i' } },
      { shortTitle: { $regex: regex, $options: 'i' } },
    ],
  })
    .select('title alternateTitle japaneseTitle shortTitle slug poster type status studio')
    .sort({ views: -1 })
    .limit(limit)
    .lean()

  res.json({ results: results.map((anime) => publicAnime(req, anime)) })
})

const TIER_LEVEL = { free: 0, basic: 1, premium: 2, vip: 3 }

function userHasAccess(userTier, requiredTier) {
  return (TIER_LEVEL[userTier] || 0) >= (TIER_LEVEL[requiredTier] || 0)
}

router.get('/episodes/:episodeId', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const token = extractUserToken(req)
  const payload = verifyUserToken(token)
  const authed = Boolean(payload)
  const enriched = await enrichEpisodeVideo(episode, req)

  if (!authed) {
    enriched.videoPlayable = false
    enriched.hlsManifest = ''
    enriched.hlsRenditions = []
    enriched.hlsSubtitles = []
    enriched.requiresAuth = true
  } else {
    enriched.requiresAuth = false
  }

  const animeDoc = episode.animeId
  const requiredTier = animeDoc?.accessTier || 'free'
  if (requiredTier !== 'free' && authed) {
    const user = await User.findById(payload.sub).select('subscription').lean()
    const sub = user?.subscription || {}
    const userTier = sub.tier || 'free'
    const subActive = sub.expiresAt && new Date(sub.expiresAt) > new Date()

      if (!subActive || !userHasAccess(userTier, requiredTier)) {
        enriched.video = ''
        enriched.videoPlayable = false
        enriched.hlsManifest = ''
        enriched.hlsRenditions = []
        enriched.hlsSubtitles = []
        enriched.requiresSubscription = true
      enriched.requiredTier = requiredTier
    }
  } else if (requiredTier !== 'free' && !authed) {
    enriched.requiresSubscription = true
    enriched.requiredTier = requiredTier
  }

  res.json({ episode: enriched })
})

router.get('/episodes/:episodeId/engagement', async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const viewerId = req.query.viewerId || ''
  const [liked, commentCount] = await Promise.all([
    viewerId ? EpisodeLike.exists({ episodeId: episode._id, viewerId }) : false,
    Comment.countDocuments({ episodeId: episode._id, status: 'approved' }),
  ])

  res.json({
    likes: episode.likes || 0,
    views: episode.views || 0,
    commentCount,
    liked: Boolean(liked),
  })
})

router.post('/episodes/:episodeId/view', async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const token = extractUserToken(req)
  const payload = token ? verifyUserToken(token) : null
  const authViewerId = payload?.sub || ''
  const viewerId = authViewerId || String(req.body?.viewerId || '').trim()
  const viewerName = String(req.body?.viewerName || 'Guest').trim() || 'Guest'

  await Episode.findByIdAndUpdate(episode._id, { $inc: { views: 1 } })
  if (episode.animeId?._id || episode.animeId) {
    await Anime.findByIdAndUpdate(episode.animeId._id || episode.animeId, { $inc: { views: 1 } })
  }

  if (viewerId) {
    await EpisodeWatchLog.findOneAndUpdate(
      { episodeId: episode._id, viewerId },
      {
        $inc: { viewCount: 1 },
        $set: { lastWatchedAt: new Date(), viewerName, animeId: episode.animeId._id || episode.animeId },
        $setOnInsert: { firstWatchedAt: new Date() },
      },
      { upsert: true },
    )
    if (authViewerId) cacheDel(`private:recommendations:${authViewerId}`)
  }

  const updated = await Episode.findById(episode._id).select('views').lean()
  res.json({ ok: true, views: updated?.views || 0 })
})

router.get('/episodes/:episodeId/progress', requireUser, async (req, res) => {
  const log = await EpisodeWatchLog.findOne({ episodeId: req.params.episodeId, viewerId: req.user.sub })
    .select('progressSeconds durationSeconds')
    .lean()
  res.set('Cache-Control', 'private, no-store')
  res.json({ progressSeconds: log?.progressSeconds || 0, durationSeconds: log?.durationSeconds || 0 })
})

router.post('/episodes/:episodeId/progress', requireUser, async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const durationSeconds = Math.min(86_400, Math.max(0, Math.floor(Number(req.body?.durationSeconds) || 0)))
  let progressSeconds = Math.min(durationSeconds || 86_400, Math.max(0, Math.floor(Number(req.body?.progressSeconds) || 0)))
  const completed = Boolean(durationSeconds && progressSeconds >= durationSeconds * 0.95)
  if (completed) progressSeconds = 0

  await EpisodeWatchLog.findOneAndUpdate(
    { episodeId: episode._id, viewerId: req.user.sub },
    {
      $set: {
        animeId: episode.animeId._id || episode.animeId,
        viewerName: req.user.name || 'User',
        progressSeconds,
        durationSeconds,
        lastWatchedAt: new Date(),
        ...(completed ? { completedAt: new Date() } : {}),
      },
      $setOnInsert: { firstWatchedAt: new Date(), viewCount: 1 },
    },
    { upsert: true },
  )
  res.set('Cache-Control', 'private, no-store')
  res.json({ ok: true, progressSeconds, durationSeconds })
})

router.post('/episodes/:episodeId/like', async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const viewerId = String(req.body?.viewerId || '').trim()
  const viewerName = String(req.body?.viewerName || 'Guest').trim() || 'Guest'
  if (!viewerId) return res.status(400).json({ message: 'Viewer id required' })

  const existing = await EpisodeLike.findOne({ episodeId: episode._id, viewerId })
  let liked = false

  if (existing) {
    await EpisodeLike.deleteOne({ _id: existing._id })
    await Episode.findByIdAndUpdate(episode._id, { $inc: { likes: -1 } })
    liked = false
  } else {
    await EpisodeLike.create({
      episodeId: episode._id,
      animeId: episode.animeId._id || episode.animeId,
      viewerId,
      viewerName,
    })
    await Episode.findByIdAndUpdate(episode._id, { $inc: { likes: 1 } })
    liked = true
  }

  const updated = await Episode.findById(episode._id).select('likes').lean()
  res.json({ liked, likes: Math.max(0, updated?.likes || 0) })
})

router.get('/episodes/:episodeId/comments', async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const comments = await Comment.find({ episodeId: episode._id, status: 'approved' })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()

  res.json({ comments })
})

router.post('/episodes/:episodeId/comments', async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })

  const settings = await getSettings()
  if (settings.commentsEnabled === false) {
    return res.status(403).json({ message: 'Comments are currently disabled by admin' })
  }

  const content = String(req.body?.content || '').trim()
  const viewerId = String(req.body?.viewerId || '').trim()
  const viewerName = String(req.body?.viewerName || 'Guest').trim() || 'Guest'
  if (!content) return res.status(400).json({ message: 'Please write a comment' })
  if (content.length > 2000) return res.status(400).json({ message: 'Comment is too long' })

  let commentStatus = 'approved'
  if (isAIEnabled()) {
    try {
      const mod = await moderateText(content)
      if (!mod.safe) commentStatus = 'flagged'
    } catch {}
  }

  const comment = await Comment.create({
    episodeId: episode._id,
    animeId: episode.animeId._id || episode.animeId,
    username: viewerName,
    content,
    status: commentStatus,
    userId: null,
  })

  await Episode.findByIdAndUpdate(episode._id, { $inc: { commentCount: 1 } })

  res.status(201).json({ comment })
})

router.get('/stream/:fileId', requireUser, async (req, res) => {
  try {
    const record = await VideoFile.findById(req.params.fileId).lean()

    if (record?.storage === 'r2' && record.r2Key) {
      res.set('Content-Disposition', `inline; filename="${record.originalName || 'video'}"`)
      return streamFromR2(res, record.r2Key, record.mimeType || 'video/mp4', req.headers.range)
    }

    if (record?.storage === 'local' && record.diskPath) {
      if (isWorker()) return res.status(404).json({ message: 'Server down' })
      const fs = await lazyNodeImport('node:fs')
      const absPath = resolveVideoPath(record.diskPath, record.storageVolume)
      if (!absPath || !fs.existsSync(absPath)) {
        return res.status(404).json({ message: 'Server down' })
      }
      const stat = fs.statSync(absPath)
      res.set('Content-Disposition', `inline; filename="${record.originalName || 'video'}"`)
      return pipeLocalVideo(res, absPath, stat.size, record.mimeType || 'video/mp4', req.headers.range)
    }

    return res.status(404).json({ message: 'Server down' })
  } catch (err) {
    res.status(500).json({ message: 'Server down' })
  }
})

router.get('/subtitle/:r2Key(*)', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Access-Control-Allow-Origin', '*')
  try {
    const r2Key = decodeURIComponent(req.params.r2Key)
    if (!r2Key || !r2Key.endsWith('.srt')) {
      return res.status(400).json({ message: 'Invalid subtitle key' })
    }
    res.set('Content-Type', 'text/plain; charset=utf-8')
    try {
      await streamFromR2(res, r2Key, 'text/plain; charset=utf-8')
    } catch (s3Err) {
      const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
      if (!publicBase) throw s3Err
      const r = await fetch(`${publicBase}/${r2Key}`)
      if (!r.ok) return res.status(404).json({ message: 'Subtitle not found' })
      const buf = Buffer.from(await r.arrayBuffer())
      res.set('Content-Length', String(buf.length))
      res.send(buf)
    }
  } catch (err) {
    res.status(404).json({ message: 'Subtitle not found' })
  }
})

router.get('/download/:fileId', requireUser, async (req, res) => {
  try {
    const token = extractUserToken(req)
    const payload = verifyUserToken(token)
    if (!payload) return res.status(401).json({ message: 'Login required' })

    const user = await User.findById(payload.sub).select('subscription').lean()
    const sub = user?.subscription || {}
    const isActive = sub.tier !== 'free' && sub.expiresAt && new Date(sub.expiresAt) > new Date()

    if (!isActive) {
      return res.status(403).json({
        message: 'Basic, Premium, or VIP subscription required for downloads',
        requiresSubscription: true,
      })
    }

    const record = await VideoFile.findById(req.params.fileId).lean()
    if (!record) return res.status(404).json({ message: 'Video not found' })

    if (record.animeId) {
      const anime = await Anime.findById(record.animeId).select('accessTier').lean()
      const requiredTier = anime?.accessTier || 'free'
      if (requiredTier !== 'free' && !userHasAccess(sub.tier || 'free', requiredTier)) {
        return res.status(403).json({
          message: 'This anime requires a higher subscription tier',
          requiresSubscription: true,
          requiredTier,
        })
      }
    }

    res.set('X-Anikura-Offline-Tier', sub.tier || 'free')
    res.set('X-Anikura-Offline-Expires', sub.expiresAt ? new Date(sub.expiresAt).toISOString() : '')
    res.set('X-Anikura-Offline-Size', String(record.size || 0))

    const fileName = record.originalName || 'anime-episode.mp4'

    if (record?.storage === 'r2' && record.r2Key) {
      res.set('Content-Disposition', `attachment; filename="${fileName}"`)
      return streamFromR2(res, record.r2Key, record.mimeType || 'video/mp4')
    }

    if (record?.storage === 'local' && record.diskPath) {
      if (isWorker()) return res.status(404).json({ message: 'Server down' })
      const fs = await lazyNodeImport('node:fs')
      const absPath = resolveVideoPath(record.diskPath, record.storageVolume)
      if (!absPath || !fs.existsSync(absPath)) {
        return res.status(404).json({ message: 'Server down' })
      }
      const stat = fs.statSync(absPath)
      res.set('Content-Disposition', `attachment; filename="${fileName}"`)
      return pipeLocalVideo(res, absPath, stat.size, record.mimeType || 'video/mp4')
    }

    return res.status(404).json({ message: 'Server down' })
  } catch (err) {
    res.status(500).json({ message: 'Server down' })
  }
})

router.post('/feedback', async (req, res) => {
  const allowedTypes = ['anime_request', 'song_request', 'feedback', 'website_rating', 'review']
  let type = String(req.body?.type || 'feedback').trim()
  if (!allowedTypes.includes(type)) type = 'feedback'
  const message = String(req.body?.message || '').trim()
  const viewerId = String(req.body?.viewerId || '').trim()
  const viewerName = String(req.body?.viewerName || 'Guest').trim() || 'Guest'
  const email = String(req.body?.email || '').trim()
  const animeTitle = String(req.body?.animeTitle || '').trim()
  let rating = Number(req.body?.rating)
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) rating = 0

  if (!message) return res.status(400).json({ message: 'Message is required' })
  if (message.length > 3000) return res.status(400).json({ message: 'Message is too long' })
  if (['anime_request', 'song_request'].includes(type) && !animeTitle) {
    return res.status(400).json({ message: type === 'song_request' ? 'Anime and song title are required for song requests' : 'Anime title is required for requests' })
  }

  const feedback = await Feedback.create({
    type,
    viewerId,
    viewerName,
    email,
    animeTitle: ['anime_request', 'song_request'].includes(type) ? animeTitle : '',
    message,
    rating,
    status: 'open',
  })

  res.status(201).json({ feedback })
})

router.get('/feedback', async (req, res) => {
  const viewerId = String(req.query.viewerId || '').trim()
  if (!viewerId) return res.status(400).json({ message: 'viewerId required' })

  const feedback = await Feedback.find({ viewerId })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('type viewerName animeTitle message status adminResponse respondedAt createdAt updatedAt')
    .lean()

  res.json({ feedback })
})

router.get('/schedule', async (req, res) => {
  const cached = cacheGet('public:schedule')
  if (cached) {
    setPublicCache(res, 60)
    return res.json(cached)
  }

  const now = new Date()

  // Real scheduled episodes (with video uploaded, waiting for releaseAt)
  const episodes = await Episode.find({
    published: true,
    status: 'scheduled',
    releaseAt: { $gt: now },
  })
    .populate({ path: 'animeId', match: publishedAnimeFilter, select: 'title poster coverImage slug type studio ratingAvg' })
    .sort({ releaseAt: 1 })
    .lean()

  // Computed "Not Out Yet" entries from weeklySchedule config
  let computedEntries = []
  try {
    computedEntries = await computeAllWeeklySchedules()
  } catch (err) {
    console.error('[schedule] computeAllWeeklySchedules error:', err.message)
  }
  // Filter out computed entries whose anime already has a real scheduled episode
  const realAnimeIds = new Set(episodes.map((e) => String(e.animeId?._id || e.animeId)))
  const filteredComputed = computedEntries.filter((e) => !realAnimeIds.has(String(e.animeId?._id || e.animeId)))
  console.log(`[schedule] real=${episodes.length} computed=${computedEntries.length} filtered=${filteredComputed.length}`)

  const upcomingAnimes = await Anime.find({ ...publishedAnimeFilter, status: 'upcoming' })
    .sort({ scheduledReleaseAt: 1, releaseStartDate: 1 })
    .lean()

  const payload = {
    episodes: [
      ...episodes.filter((e) => e.animeId).map((episode) => publicEpisode(req, episode)),
      ...filteredComputed.map((entry) => ({
        ...publicEpisode(req, entry),
        note: 'Not Out Yet',
      })),
    ].sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt)),
    upcomingAnimes: upcomingAnimes.map((anime) => publicAnime(req, anime)),
    _debug: { real: episodes.length, computed: computedEntries.length, filtered: filteredComputed.length },
  }
  cacheSet('public:schedule', payload, 60_000)
  setPublicCache(res, 60)
  res.json(payload)
})

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

router.get('/new-additions', async (req, res) => {
  await clearExpiredHomepagePins()
  const cacheKey = 'public:new-additions'
  const cached = cacheGet(cacheKey)

  if (cached) {
    setPublicCache(res, 60)
    return res.json(cached)
  }

  const now = new Date()
  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const animes = await Anime.find({
    ...publishedAnimeFilter,
    $or: [
      { homepagePinUntil: { $gt: now } },
      { newAdditions: true, createdAt: { $gte: thirtyDaysAgo } },
    ],
  })
    .sort({ homepagePinUntil: -1, createdAt: -1 })
    .select('title poster coverImage banner slug type studio status genres createdAt newAdditions featured trending subAvailable dubAvailable ratingAvg homepagePinUntil')
    .limit(200)
    .lean()

  // Flat list, no time grouping
  const items = animes.map((anime) => ({ anime: publicAnime(req, anime) }))

  const payload = {
    items,
    total: animes.length,
    generatedAt: new Date().toISOString(),
  }

  cacheSet('public:new-additions', payload, 60_000)
  setPublicCache(res, 60)
  res.json(payload)
})

router.get('/latest-releases', async (req, res) => {
  const cached = cacheGet('public:latest-releases')
  if (cached) {
    setPublicCache(res, 60)
    return res.json(cached)
  }

  refreshPublicSchedules()
  applyFinishedAiringFlag().catch((err) => console.error('Finished-airing update error:', err.message))
  convertUpcomingToOngoing().catch((err) => console.error('Upcoming-status update error:', err.message))

  const now = new Date()
  const todayStart = startOfDay(now)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)

  const weekStart = new Date(todayStart)
  weekStart.setDate(weekStart.getDate() - 7)

  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const rows = await Episode.find({
    published: true,
    status: 'released',
    newReleases: true,
    $or: [
      { releaseAt: { $ne: null, $gte: thirtyDaysAgo } },
      { releaseAt: null, createdAt: { $gte: thirtyDaysAgo } },
    ],
  })
    .populate({ path: 'animeId', match: publishedAnimeFilter, select: 'title slug poster coverImage banner defaultThumbnail type studio status genres subAvailable dubAvailable ratingAvg' })
    .sort({ releaseAt: -1 })
    .limit(200)
    .select('title episodeNo episodeType serialNumber animeId thumbnail releaseAt views rating')
    .lean()

  const episodes = rows.filter((e) => e.animeId).map((episode) => publicEpisode(req, episode))

  const groups = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Earlier: [],
  }

  for (const ep of episodes) {
    const t = new Date(ep.releaseAt)
    const ts = t.getTime()

    if (ts >= todayStart.getTime()) {
      groups.Today.push(ep)
    } else if (ts >= yesterdayStart.getTime()) {
      groups.Yesterday.push(ep)
    } else if (ts >= weekStart.getTime()) {
      groups['This week'].push(ep)
    } else {
      groups.Earlier.push(ep)
    }
  }

  const payload = {
    groups: [
      { key: 'Today', items: groups.Today },
      { key: 'Yesterday', items: groups.Yesterday },
      { key: 'This week', items: groups['This week'] },
      { key: 'Earlier', items: groups.Earlier },
    ],
    total: episodes.length,
    generatedAt: new Date().toISOString(),
  }

  cacheSet('public:latest-releases', payload, 60_000)
  setPublicCache(res, 60)
  res.json(payload)
})

router.get('/seo/animes', async (req, res) => {
  const animes = await getSeoAnimes()
  setPublicCache(res, 3600)
  res.json({ animes: animes.map((anime) => seoAnime(req, anime)) })
})

router.get('/og/anime/:slug', async (req, res) => {
  try {
    const anime = await Anime.findOne({ slug: req.params.slug, ...publishedAnimeFilter })
      .select('title description poster coverImage banner slug type status genres ratingAvg ratingCount views')
      .lean()
    if (!anime) return res.status(404).send('Not found')

    const SITE = 'https://anikuraa.com'
    const url = `${SITE}/anime/${anime.slug || anime._id}`
    const image = anime.ogImage || anime.poster || anime.coverImage || ''
    const desc = (anime.metaDescription || anime.description || `Watch ${anime.title} on AniKura`).slice(0, 300)
    const title = anime.metaTitle || `${anime.title} - Watch on AniKura`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeXml(title)}</title>
<meta property="og:type" content="video.tv_show">
<meta property="og:title" content="${escapeXml(title)}">
<meta property="og:description" content="${escapeXml(desc)}">
<meta property="og:image" content="${escapeXml(image)}">
<meta property="og:url" content="${escapeXml(url)}">
<meta property="og:site_name" content="AniKura">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeXml(title)}">
<meta name="twitter:description" content="${escapeXml(desc)}">
<meta name="twitter:image" content="${escapeXml(image)}">
<meta http-equiv="refresh" content="0;url=${escapeXml(url)}">
<link rel="canonical" href="${escapeXml(url)}">
</head>
<body>
<p>Redirecting to <a href="${escapeXml(url)}">${escapeXml(anime.title)}</a>...</p>
<script>window.location.replace(${JSON.stringify(url)})</script>
</body>
</html>`)
  } catch {
    res.status(500).send('Error')
  }
})

router.get('/sitemap.xml', async (_req, res) => {
  try {
    const cached = await cacheGet('public:sitemap')
    if (cached) {
      res.set('Content-Type', 'application/xml')
      return res.send(cached)
    }

    const BASE = 'https://anikuraa.com'
    const animes = await Anime.find({ visibility: 'published', moderationStatus: { $ne: 'Rejected' } })
      .select('_id slug title description poster updatedAt createdAt')
      .lean()

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'

    const publishedPostFilter = {
      $or: [
        { visibility: 'published', $or: [{ publishAt: null }, { publishAt: { $lte: new Date() } }] },
        { visibility: 'scheduled', publishAt: { $lte: new Date() } },
      ],
    }
    const [communityPosts, socialPosts, musicPosts] = await Promise.all([
      Post.find({ kind: 'community', ...publishedPostFilter }).select('slug updatedAt createdAt').lean(),
      Post.find({ kind: { $in: ['youtube', 'instagram'] }, ...publishedPostFilter }).select('slug updatedAt createdAt').lean(),
      Post.find({ kind: 'music', ...publishedPostFilter }).select('slug updatedAt createdAt').lean(),
    ])

    const staticPages = ['', 'browse', 'upcoming', 'schedule', 'new-releases', 'trending', 'community', 'social-media', 'music', 'feedback']
    for (const slug of staticPages) {
      const loc = slug ? `${BASE}/${slug}` : BASE
      const lastmod = new Date().toISOString().split('T')[0]
      xml += `  <url><loc>${loc}</loc><changefreq>${slug ? 'daily' : 'weekly'}</changefreq><priority>${slug ? '0.7' : '1.0'}</priority><lastmod>${lastmod}</lastmod></url>\n`
    }

    for (const a of animes) {
      const lastmod = (a.updatedAt || a.createdAt || new Date()).toISOString().split('T')[0]
      const animePath = a.slug || String(a._id)
      xml += `  <url><loc>${BASE}/anime/${escapeXml(animePath)}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${lastmod}</lastmod></url>\n`
    }

    for (const post of communityPosts) {
      const lastmod = (post.updatedAt || post.createdAt || new Date()).toISOString().split('T')[0]
      xml += `  <url><loc>${BASE}/community/${escapeXml(post.slug)}</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${lastmod}</lastmod></url>\n`
    }

    for (const post of socialPosts) {
      const lastmod = (post.updatedAt || post.createdAt || new Date()).toISOString().split('T')[0]
      xml += `  <url><loc>${BASE}/social-media/${escapeXml(post.slug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>\n`
    }

    for (const post of musicPosts) {
      const lastmod = (post.updatedAt || post.createdAt || new Date()).toISOString().split('T')[0]
      xml += `  <url><loc>${BASE}/music/${escapeXml(post.slug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority><lastmod>${lastmod}</lastmod></url>\n`
    }

    xml += '</urlset>'

    cacheSet('public:sitemap', xml, 3600_000)
    res.set('Content-Type', 'application/xml')
    res.send(xml)
  } catch (err) {
    res.status(500).send('<?xml version="1.0"?><urlset/>')
  }
})

function escapeXml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export default router
