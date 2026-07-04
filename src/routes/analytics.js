import express from 'express'
import Anime from '../models/Anime.js'
import Episode from '../models/Episode.js'
import Comment from '../models/Comment.js'
import EpisodeWatchLog from '../models/EpisodeWatchLog.js'
import EpisodeLike from '../models/EpisodeLike.js'
import { requireAdmin } from './adminAuth.js'
import { parseListQuery } from '../utils/helpers.js'

const router = express.Router()

router.get('/', requireAdmin, async (req, res) => {
  const period = req.query.period || 'daily'
  const days = period === 'monthly' ? 30 : period === 'weekly' ? 7 : 14

  const start = new Date()
  start.setDate(start.getDate() - days)
  start.setHours(0, 0, 0, 0)

  const [animeViews, episodeViews, newUsers, comments, topAnime, topEpisodes, topRated] = await Promise.all([
    Anime.aggregate([
      { $match: { updatedAt: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } }, views: { $sum: '$views' } } },
      { $sort: { _id: 1 } },
    ]),
    Episode.aggregate([
      { $match: { updatedAt: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } }, views: { $sum: '$views' } } },
      { $sort: { _id: 1 } },
    ]),
    Comment.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Comment.countDocuments({ createdAt: { $gte: start } }),
    Anime.find({ visibility: 'published' }).sort({ views: -1 }).limit(10).lean(),
    Episode.find({ status: 'released' }).populate('animeId', 'title').sort({ views: -1 }).limit(10).lean(),
    Anime.find({ ratingCount: { $gt: 0 } }).sort({ ratingAvg: -1 }).limit(10).lean(),
  ])

  res.json({
    period,
    charts: {
      animeViews: animeViews.map((r) => ({ date: r._id, count: r.views })),
      episodeViews: episodeViews.map((r) => ({ date: r._id, count: r.views })),
      comments: comments.map((r) => ({ date: r._id, count: r.count })),
    },
    summary: { commentsInPeriod: comments },
    topAnime,
    topEpisodes,
    topRated,
  })
})

router.get('/engagement', requireAdmin, async (req, res) => {
  const animes = await Anime.find()
    .select('title views likes ratingAvg ratingCount bookmarks commentCount genres')
    .sort({ views: -1 })
    .lean()

  const episodes = await Episode.find()
    .populate('animeId', 'title')
    .select('title episodeNo views likes rating commentCount animeId')
    .sort({ views: -1 })
    .lean()

  res.json({
    animes,
    episodes,
    mostViewedAnime: animes.slice(0, 10),
    mostLikedAnime: [...animes].sort((a, b) => b.likes - a.likes).slice(0, 10),
    highestRatedAnime: [...animes].sort((a, b) => b.ratingAvg - a.ratingAvg).slice(0, 10),
    mostViewedEpisodes: episodes.slice(0, 10),
    mostLikedEpisodes: [...episodes].sort((a, b) => b.likes - a.likes).slice(0, 10),
  })
})

router.get('/watch-history', requireAdmin, async (req, res) => {
  const { page, limit, skip } = parseListQuery(req.query)
  const filter = {}
  if (req.query.episodeId) filter.episodeId = req.query.episodeId
  if (req.query.animeId) filter.animeId = req.query.animeId
  if (req.query.viewerId) filter.viewerId = req.query.viewerId
  if (req.query.q) {
    filter.$or = [
      { viewerName: { $regex: req.query.q, $options: 'i' } },
      { viewerId: { $regex: req.query.q, $options: 'i' } },
    ]
  }

  const [logs, total, episodeSummary] = await Promise.all([
    EpisodeWatchLog.find(filter)
      .populate('animeId', 'title')
      .populate('episodeId', 'title episodeNo')
      .sort({ lastWatchedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    EpisodeWatchLog.countDocuments(filter),
    EpisodeWatchLog.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$episodeId',
          totalViews: { $sum: '$viewCount' },
          uniqueViewers: { $sum: 1 },
        },
      },
      { $sort: { totalViews: -1 } },
      { $limit: 20 },
    ]),
  ])

  const episodeIds = episodeSummary.map((s) => s._id).filter(Boolean)
  const episodeMeta = await Episode.find({ _id: { $in: episodeIds } })
    .populate('animeId', 'title')
    .select('title episodeNo animeId')
    .lean()
  const metaMap = Object.fromEntries(episodeMeta.map((e) => [String(e._id), e]))

  res.json({
    logs,
    total,
    page,
    limit,
    episodeSummary: episodeSummary.map((s) => ({
      ...s,
      episode: metaMap[String(s._id)] || null,
    })),
  })
})

router.get('/episode-likes', requireAdmin, async (req, res) => {
  const filter = {}
  if (req.query.episodeId) filter.episodeId = req.query.episodeId
  const likes = await EpisodeLike.find(filter)
    .populate('animeId', 'title')
    .populate('episodeId', 'title episodeNo')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()
  res.json({ likes })
})

export default router
