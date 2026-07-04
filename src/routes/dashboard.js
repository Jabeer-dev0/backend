import express from 'express'
import Anime from '../models/Anime.js'
import Episode from '../models/Episode.js'
import Comment from '../models/Comment.js'
import User from '../models/User.js'
import { requireAdmin } from './adminAuth.js'

const router = express.Router()

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d
}

async function countByDay(Model, days = 14, dateField = 'createdAt') {
  const start = daysAgo(days - 1)
  const rows = await Model.aggregate([
    { $match: { [dateField]: { $gte: start } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ])
  return rows.map((r) => ({ date: r._id, count: r.count }))
}

router.get('/stats', requireAdmin, async (req, res) => {
  const [
    totalAnime,
    totalEpisodes,
    totalUsers,
    totalComments,
    ongoingAnime,
    completedAnime,
    upcomingAnime,
    publishedAnime,
    draftAnime,
    publishedEpisodes,
    draftEpisodes,
    scheduledEpisodes,
    animeAgg,
    episodeAgg,
    latestAnimes,
    latestEpisodes,
    latestUsers,
    latestComments,
    upcomingEpisodes,
    upcomingAnimes,
  ] = await Promise.all([
    Anime.countDocuments(),
    Episode.countDocuments(),
    User.countDocuments(),
    Comment.countDocuments(),
    Anime.countDocuments({ status: 'ongoing' }),
    Anime.countDocuments({ status: 'completed' }),
    Anime.countDocuments({ status: 'upcoming' }),
    Anime.countDocuments({ visibility: 'published' }),
    Anime.countDocuments({ visibility: 'draft' }),
    Episode.countDocuments({ status: 'released' }),
    Episode.countDocuments({ status: 'draft' }),
    Episode.countDocuments({ status: 'scheduled' }),
    Anime.aggregate([
      {
        $group: {
          _id: null,
          views: { $sum: '$views' },
          likes: { $sum: '$likes' },
          ratings: { $sum: '$ratingCount' },
          bookmarks: { $sum: '$bookmarks' },
        },
      },
    ]),
    Episode.aggregate([
      {
        $group: {
          _id: null,
          views: { $sum: '$views' },
          likes: { $sum: '$likes' },
        },
      },
    ]),
    Anime.find().sort({ createdAt: -1 }).limit(5).lean(),
    Episode.find().populate('animeId', 'title').sort({ createdAt: -1 }).limit(5).lean(),
    User.find().sort({ createdAt: -1 }).limit(5).lean(),
    Comment.find().sort({ createdAt: -1 }).limit(5).lean(),
    Episode.find({ status: 'scheduled', releaseAt: { $gte: new Date() } })
      .populate('animeId', 'title')
      .sort({ releaseAt: 1 })
      .limit(10)
      .lean(),
    Anime.find({ status: 'upcoming' }).sort({ scheduledReleaseAt: 1 }).limit(10).lean(),
  ])

  const a = animeAgg[0] || { views: 0, likes: 0, ratings: 0, bookmarks: 0 }
  const e = episodeAgg[0] || { views: 0, likes: 0 }

  const [viewsOverTime, usersOverTime, commentsOverTime] = await Promise.all([
    countByDay(Anime, 14),
    countByDay(User, 14),
    countByDay(Comment, 14),
  ])

  const topAnime = await Anime.find({ visibility: 'published' })
    .sort({ views: -1 })
    .limit(5)
    .select('title views likes ratingAvg')
    .lean()

  const topEpisodes = await Episode.find({ status: 'released' })
    .populate('animeId', 'title')
    .sort({ views: -1 })
    .limit(5)
    .lean()

  const alerts = []
  if (scheduledEpisodes > 0) alerts.push({ type: 'info', message: `${scheduledEpisodes} episodes scheduled for release` })
  if (draftAnime > 0) alerts.push({ type: 'warn', message: `${draftAnime} anime still in draft` })
  const pendingComments = await Comment.countDocuments({ status: 'pending' })
  if (pendingComments > 0) alerts.push({ type: 'info', message: `${pendingComments} comments awaiting moderation` })
  const missingPoster = await Anime.countDocuments({ $or: [{ poster: '' }, { coverImage: '' }], visibility: 'published' })
  if (missingPoster > 0) alerts.push({ type: 'warn', message: `${missingPoster} published anime missing poster` })

  const { getUploadReminders } = await import('../utils/episodeScheduler.js')
  const uploadReminders = await getUploadReminders()
  if (uploadReminders.length > 0) {
    const urgent = uploadReminders.filter((r) => r.urgency === 'overdue' || r.urgency === 'today').length
    alerts.unshift({
      type: urgent > 0 ? 'warn' : 'info',
      message: `${uploadReminders.length} scheduled episode(s) need video upload${urgent > 0 ? ` (${urgent} due today/overdue)` : ''}`,
      link: '/admin/schedule',
    })
  }

  res.json({
    kpis: {
      totalAnime,
      totalEpisodes,
      totalUsers,
      totalComments,
      totalViews: (a.views || 0) + (e.views || 0),
      totalLikes: (a.likes || 0) + (e.likes || 0),
      totalRatings: a.ratings || 0,
      totalBookmarks: a.bookmarks || 0,
      ongoingAnime,
      completedAnime,
      upcomingAnime,
      scheduledEpisodes,
      publishedAnime,
      draftAnime,
      publishedEpisodes,
      draftEpisodes,
    },
    charts: {
      viewsOverTime,
      usersOverTime,
      commentsOverTime,
    },
    recent: {
      latestAnimes,
      latestEpisodes,
      latestUsers,
      latestComments,
      upcomingEpisodes,
      upcomingAnimes,
    },
    top: { topAnime, topEpisodes },
    alerts,
  })
})

export default router
