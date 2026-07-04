import express from 'express'
import Episode from '../models/Episode.js'
import Anime from '../models/Anime.js'
import { requireEditor } from './adminAuth.js'
import { pickEpisodeFields, parseListQuery } from '../utils/helpers.js'
import { releaseDueEpisodes, getUploadReminders, applyVideoUploadToSchedule } from '../utils/episodeScheduler.js'

function normalizeScheduleBody(body, { requireVideo = true } = {}) {
  if (body.status !== 'scheduled') return null

  if (!body.releaseAt) {
    throw new Error('Scheduled episode ke liye release date/time zaroori hai')
  }
  const releaseAt = new Date(body.releaseAt)
  if (Number.isNaN(releaseAt.getTime())) {
    throw new Error('Invalid release date/time')
  }

  body.releaseAt = releaseAt
  body.published = true
  if (!body.releaseDate) body.releaseDate = releaseAt.toISOString().slice(0, 10)
  if (!body.releaseTime) body.releaseTime = releaseAt.toISOString().slice(11, 16)

  const mode = body.scheduleMode === 'upload_later' ? 'upload_later' : 'ready'
  body.scheduleMode = mode

  if (mode === 'ready' && requireVideo && !body.video) {
    throw new Error('Video ready schedule ke liye pehle video upload karo')
  }

  return body
}

const router = express.Router()

router.get('/', async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = {}
  if (req.query.animeId) filter.animeId = req.query.animeId
  if (req.query.status) filter.status = req.query.status
  if (req.query.published === 'true') filter.published = true
  if (req.query.published === 'false') filter.published = false
  if (req.query.q) {
    const animes = await Anime.find({ title: { $regex: req.query.q, $options: 'i' } }).select('_id')
    filter.animeId = { $in: animes.map((a) => a._id) }
  }

  const [episodes, total] = await Promise.all([
    Episode.find(filter).populate('animeId', 'title slug').sort(sort).skip(skip).limit(limit).lean(),
    Episode.countDocuments(filter),
  ])
  res.json({ episodes, total, page, limit })
})

router.get('/schedule', async (req, res) => {
  await releaseDueEpisodes()
  const now = new Date()
  const episodes = await Episode.find({
    status: 'scheduled',
    releaseAt: { $gte: now },
  })
    .populate('animeId', 'title slug poster coverImage')
    .sort({ releaseAt: 1 })
    .lean()

  const awaitingUpload = episodes.filter((e) => e.scheduleMode === 'upload_later' && !e.video)
  const readyToRelease = episodes.filter((e) => e.scheduleMode !== 'upload_later' && e.video)

  const overdue = await Episode.countDocuments({
    status: 'scheduled',
    releaseAt: { $lt: now },
    $or: [
      { scheduleMode: 'ready', video: { $nin: ['', null] } },
      { scheduleMode: 'upload_later' },
    ],
  })

  const upcomingAnimes = await Anime.find({ status: 'upcoming' }).sort({ scheduledReleaseAt: 1 }).lean()
  res.json({ episodes, readyToRelease, awaitingUpload, upcomingAnimes, overdue })
})

router.get('/upload-reminders', requireEditor, async (req, res) => {
  const reminders = await getUploadReminders()
  res.json({ reminders, count: reminders.length })
})

router.post('/release-due', requireEditor, async (req, res) => {
  const released = await releaseDueEpisodes()
  res.json({ ok: true, released })
})

router.post('/:episodeId/release-now', requireEditor, async (req, res) => {
  const ep = await Episode.findByIdAndUpdate(
    req.params.episodeId,
    { $set: { status: 'released', published: true, releaseAt: new Date() } },
    { new: true },
  ).populate('animeId', 'title slug')
  if (!ep) return res.status(404).json({ message: 'Not found' })
  res.json({ episode: ep })
})

router.get('/by-anime/:animeId', async (req, res) => {
  const episodes = await Episode.find({ animeId: req.params.animeId }).sort({ episodeNo: 1 }).lean()
  res.json({ episodes })
})

router.get('/:episodeId', async (req, res) => {
  const episode = await Episode.findById(req.params.episodeId).populate('animeId', 'title slug').lean()
  if (!episode) return res.status(404).json({ message: 'Not found' })
  res.json({ episode })
})

router.post('/', requireEditor, async (req, res) => {
  try {
    const body = pickEpisodeFields(req.body || {})
    if (!body.animeId || body.episodeNo == null) {
      return res.status(400).json({ message: 'Missing animeId/episodeNo' })
    }

    body.episodeNo = Number(body.episodeNo)
    try {
      normalizeScheduleBody(body, { requireVideo: body.scheduleMode !== 'upload_later' })
    } catch (err) {
      return res.status(400).json({ message: err.message })
    }

    const exists = await Episode.findOne({ animeId: body.animeId, episodeNo: body.episodeNo }).select('_id').lean()
    if (exists) {
      return res.status(409).json({
        message: `Episode ${body.episodeNo} pehle se maujood hai is anime ke liye. Naya episode number use karo.`,
      })
    }

    const ep = await Episode.create(body)
    res.status(201).json({ episode: ep })
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ message: 'Yeh episode number pehle se exist karta hai. Alag number choose karo.' })
    }
    res.status(400).json({ message: e.message })
  }
})

router.patch('/:episodeId', requireEditor, async (req, res) => {
  try {
    const existing = await Episode.findById(req.params.episodeId)
    if (!existing) return res.status(404).json({ message: 'Not found' })

    const body = pickEpisodeFields(req.body || {})
    if (body.episodeNo != null) body.episodeNo = Number(body.episodeNo)

    try {
      normalizeScheduleBody(body, { requireVideo: body.scheduleMode !== 'upload_later' })
    } catch (err) {
      return res.status(400).json({ message: err.message })
    }

    applyVideoUploadToSchedule(body, existing)

    if (body.animeId != null && body.episodeNo != null) {
      const clash = await Episode.findOne({
        animeId: body.animeId,
        episodeNo: body.episodeNo,
        _id: { $ne: req.params.episodeId },
      }).select('_id').lean()
      if (clash) {
        return res.status(409).json({
          message: `Episode ${body.episodeNo} pehle se maujood hai. Purana episode overwrite nahi hoga — naya record banao.`,
        })
      }
    }

    const ep = await Episode.findByIdAndUpdate(req.params.episodeId, { $set: body }, { new: true, runValidators: true })
    if (!ep) return res.status(404).json({ message: 'Not found' })
    res.json({ episode: ep })
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ message: 'Yeh episode number pehle se exist karta hai.' })
    }
    res.status(400).json({ message: e.message })
  }
})

router.delete('/:episodeId', requireEditor, async (req, res) => {
  const ep = await Episode.findByIdAndDelete(req.params.episodeId)
  if (!ep) return res.status(404).json({ message: 'Not found' })
  res.json({ ok: true })
})

router.post('/bulk', requireEditor, async (req, res) => {
  const { ids = [], action } = req.body || {}
  if (!ids.length) return res.status(400).json({ message: 'No ids provided' })

  if (action === 'delete') {
    await Episode.deleteMany({ _id: { $in: ids } })
    return res.json({ ok: true, deleted: ids.length })
  }

  let update = {}
  if (action === 'publish') update = { published: true, status: 'released' }
  else if (action === 'unpublish') update = { published: false, status: 'draft' }
  else if (action === 'release') update = { published: true, status: 'released', releaseAt: new Date() }
  else if (action === 'schedule') update = { published: true, status: 'scheduled' }
  else return res.status(400).json({ message: 'Unknown action' })

  const result = await Episode.updateMany({ _id: { $in: ids } }, { $set: update })
  res.json({ ok: true, modified: result.modifiedCount })
})

export default router
