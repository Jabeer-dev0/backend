import express from 'express'
import fs from 'fs'
import mongoose from 'mongoose'
import Anime from '../models/Anime.js'
import Episode from '../models/Episode.js'
import Genre from '../models/Genre.js'
import SiteSettings from '../models/SiteSettings.js'
import { parseListQuery } from '../utils/helpers.js'
import { getVideoBucket } from '../utils/gridfs.js'
import VideoFile from '../models/VideoFile.js'
import Comment from '../models/Comment.js'
import EpisodeWatchLog from '../models/EpisodeWatchLog.js'
import EpisodeLike from '../models/EpisodeLike.js'
import { resolveVideoPath, pipeLocalVideo } from '../utils/videoStorage.js'
import { getR2PublicUrl, streamFromR2 } from '../utils/r2Storage.js'
import { releaseDueEpisodes } from '../utils/episodeScheduler.js'

const router = express.Router()

const publishedAnimeFilter = { visibility: 'published', moderationStatus: { $ne: 'Rejected' } }

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
  let settings = await SiteSettings.findOne({ key: 'global' })
  if (!settings) {
    settings = await SiteSettings.create({
      key: 'global',
      siteName: 'AniKura',
      heroTitle: 'Watch Anime on AniKura',
      heroSubtitle: 'Discover trending series, fresh episodes, and upcoming releases — all in one place.',
    })
  }
  return settings
}

router.get('/settings', async (req, res) => {
  const settings = await getSettings()
  res.json({ settings })
})

router.get('/home', async (req, res) => {
  const settings = await getSettings()
  const featuredIds = (settings.featuredAnimeIds || []).map(String)

  const [allPublished, genres, latestEpisodes] = await Promise.all([
    Anime.find(publishedAnimeFilter).sort({ createdAt: -1 }).limit(50).lean(),
    Genre.find().sort({ name: 1 }).limit(12).lean(),
    Episode.find({
      published: true,
      $or: [{ status: 'released' }, { status: 'scheduled', releaseAt: { $lte: new Date() } }],
    })
      .populate({ path: 'animeId', match: publishedAnimeFilter, select: 'title poster coverImage banner slug status type studio' })
      .sort({ createdAt: -1 })
      .limit(12)
      .lean(),
  ])

  const published = allPublished.filter(Boolean)
  const featured = featuredIds.length
    ? published.filter((a) => featuredIds.includes(String(a._id)))
    : published.filter((a) => a.featured).slice(0, 6)

  const spotlight = featured[0] || published[0] || null
  const trending = published.filter((a) => a.trending).length
    ? published.filter((a) => a.trending).slice(0, 8)
    : [...published].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 8)

  const recommended = published.filter((a) => a.recommended).slice(0, 8)
  const ongoing = published.filter((a) => a.status === 'ongoing').slice(0, 8)
  const upcoming = published.filter((a) => a.status === 'upcoming').slice(0, 8)

  res.json({
    settings,
    spotlight,
    featured: featured.slice(0, 6),
    trending,
    recommended,
    latest: published.slice(0, 12),
    ongoing,
    upcoming,
    latestEpisodes: latestEpisodes.filter((e) => e.animeId),
    genres,
  })
})

router.get('/animes', async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = { ...publishedAnimeFilter }
  if (req.query.q) {
    filter.$or = [
      { title: { $regex: req.query.q, $options: 'i' } },
      { slug: { $regex: req.query.q, $options: 'i' } },
      { studio: { $regex: req.query.q, $options: 'i' } },
    ]
  }
  if (req.query.status) filter.status = req.query.status
  if (req.query.type) filter.type = req.query.type
  if (req.query.genre) filter.genres = req.query.genre
  if (req.query.featured === 'true') filter.featured = true
  if (req.query.trending === 'true') filter.trending = true

  const [animes, total] = await Promise.all([
    Anime.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Anime.countDocuments(filter),
  ])
  res.json({ animes, total, page, limit })
})

router.get('/animes/:animeId', async (req, res) => {
  await releaseDueEpisodes()
  const anime = await Anime.findOne({ _id: req.params.animeId, ...publishedAnimeFilter }).lean()
  if (!anime) return res.status(404).json({ message: 'Not found' })

  const nextScheduled = await Episode.findOne({
    animeId: req.params.animeId,
    status: 'scheduled',
    published: true,
    releaseAt: { $gt: new Date() },
  })
    .sort({ releaseAt: 1 })
    .select('episodeNo title releaseAt status')
    .lean()

  res.json({ anime, nextScheduled })
})

router.get('/animes/:animeId/episodes', async (req, res) => {
  await releaseDueEpisodes()
  const anime = await Anime.findOne({ _id: req.params.animeId, ...publishedAnimeFilter }).lean()
  if (!anime) return res.status(404).json({ message: 'Anime not found' })

  const episodes = await Episode.find(releasedEpisodeFilter(req.params.animeId))
    .sort({ episodeNo: 1 })
    .lean()
  res.json({ episodes })
})

router.get('/animes/:animeId/recommendations', async (req, res) => {
  const anime = await Anime.findOne({ _id: req.params.animeId, ...publishedAnimeFilter }).lean()
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
      genres: { $in: genres },
    })
      .select('title poster coverImage banner type studio status genres subAvailable dubAvailable featured trending views')
      .limit(24)
      .lean()

    similar = candidates
      .map((item) => ({
        item,
        score: (item.genres || []).filter((g) => genres.includes(g)).length,
      }))
      .sort((a, b) => b.score - a.score || (b.item.views || 0) - (a.item.views || 0))
      .slice(0, 8)
      .map(({ item }) => item)
  }

  res.json({ related, similar })
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

router.get('/episodes/:episodeId', async (req, res) => {
  const episode = await getReleasedEpisode(req.params.episodeId)
  if (!episode) return res.status(404).json({ message: 'Not found' })
  res.json({ episode })
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

  const viewerId = String(req.body?.viewerId || '').trim()
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
  }

  const updated = await Episode.findById(episode._id).select('views').lean()
  res.json({ ok: true, views: updated?.views || 0 })
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

  const content = String(req.body?.content || '').trim()
  const viewerId = String(req.body?.viewerId || '').trim()
  const viewerName = String(req.body?.viewerName || 'Guest').trim() || 'Guest'
  if (!content) return res.status(400).json({ message: 'Comment likho' })
  if (content.length > 2000) return res.status(400).json({ message: 'Comment bahut lamba hai' })

  const comment = await Comment.create({
    episodeId: episode._id,
    animeId: episode.animeId._id || episode.animeId,
    username: viewerName,
    content,
    status: 'approved',
    userId: null,
  })

  await Episode.findByIdAndUpdate(episode._id, { $inc: { commentCount: 1 } })

  res.status(201).json({ comment })
})

router.get('/stream/:fileId', async (req, res) => {
  try {
    const record = await VideoFile.findById(req.params.fileId).lean()

    if (record?.storage === 'r2' && record.r2Key) {
      const publicUrl = record.publicUrl || getR2PublicUrl(record.r2Key)
      if (publicUrl) {
        return res.redirect(302, publicUrl)
      }
      return streamFromR2(res, record.r2Key, record.mimeType || 'video/mp4', req.headers.range)
    }

    if (record?.storage === 'local' && record.diskPath) {
      const absPath = resolveVideoPath(record.diskPath)
      if (!absPath || !fs.existsSync(absPath)) {
        return res.status(404).json({ message: 'Video file not found' })
      }
      const stat = fs.statSync(absPath)
      res.set('Content-Disposition', `inline; filename="${record.originalName || 'video'}"`)
      return pipeLocalVideo(res, absPath, stat.size, record.mimeType || 'video/mp4', req.headers.range)
    }

    let fileId
    try {
      fileId = new mongoose.Types.ObjectId(req.params.fileId)
    } catch {
      return res.status(404).json({ message: 'Video not found' })
    }

    const bucket = getVideoBucket()
    const files = await bucket.find({ _id: fileId }).toArray()
    if (!files.length) return res.status(404).json({ message: 'Video not found' })

    const file = files[0]
    const contentType = file.contentType || 'video/mp4'
    res.set('Content-Type', contentType)
    res.set('Content-Disposition', `inline; filename="${file.filename || 'video'}"`)
    if (file.length) res.set('Content-Length', String(file.length))
    res.set('Accept-Ranges', 'bytes')

    const range = req.headers.range
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1
      if (start >= file.length || end >= file.length) {
        res.status(416).set('Content-Range', `bytes */${file.length}`)
        return res.end()
      }
      res.status(206)
      res.set('Content-Range', `bytes ${start}-${end}/${file.length}`)
      res.set('Content-Length', String(end - start + 1))
      bucket.openDownloadStream(fileId, { start, end: end + 1 }).pipe(res)
      return
    }

    bucket.openDownloadStream(fileId).pipe(res)
  } catch (err) {
    res.status(500).json({ message: err.message || 'Stream failed' })
  }
})

router.get('/schedule', async (req, res) => {
  await releaseDueEpisodes()
  const now = new Date()
  const episodes = await Episode.find({
    published: true,
    status: 'scheduled',
    releaseAt: { $gt: now },
  })
    .populate({ path: 'animeId', match: publishedAnimeFilter, select: 'title poster coverImage slug type studio' })
    .sort({ releaseAt: 1 })
    .lean()

  const upcomingAnimes = await Anime.find({ ...publishedAnimeFilter, status: 'upcoming' })
    .sort({ scheduledReleaseAt: 1, releaseStartDate: 1 })
    .lean()

  res.json({
    episodes: episodes.filter((e) => e.animeId),
    upcomingAnimes,
  })
})

export default router
