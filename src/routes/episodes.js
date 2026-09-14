import express from 'express'
import Episode from '../models/Episode.js'
import Anime from '../models/Anime.js'
import { requireEditor } from './adminAuth.js'
import { pickEpisodeFields, parseListQuery, escapeRegex } from '../utils/helpers.js'
import { releaseDueEpisodes, getUploadReminders, applyVideoUploadToSchedule } from '../utils/episodeScheduler.js'
import { convertUpcomingToOngoing } from '../utils/newAdditionsScheduler.js'
import { sendEpisodeReleaseNotifications, sendAnimeNotifications } from '../utils/pushNotifications.js'
import { cacheDel, cacheDelPrefix } from '../utils/cache.js'
import { isAIEnabled, generateEpisodeSummary } from '../services/ai.js'
import { computeAllWeeklySchedules } from '../utils/weeklySchedule.js'
import { isR2Configured } from '../utils/r2Storage.js'
import { getHlsQueueStatus, queueHlsEpisodes } from '../utils/hlsQueue.js'

function normalizeScheduleBody(body, { requireVideo = true } = {}) {
  if (body.status !== 'scheduled') return null

  if (!body.releaseAt) {
    throw new Error('Scheduled episode requires a release date/time')
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
    throw new Error('Upload video first for Video Ready schedule')
  }

  return body
}

const router = express.Router()
const ADMIN_LIST_FIELDS = 'animeId episodeNo episodeType serialNumber endSerialNumber title status newReleases releaseAt releaseDate views'

function clearEpisodeCaches() {
  cacheDel('public:home')
  cacheDel('public:latest-releases')
  cacheDelPrefix('public:anime:')
  cacheDelPrefix('public:anime-eps:')
}

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

function episodeHasContent(episode) {
  return Boolean(episode?.video || episode?.embedUrl || episode?.videoUrl || episode?.hlsManifest)
}

async function autoPublishDraftAnime(animeId) {
  if (!animeId) return null
  const anime = await Anime.findById(animeId)
  if (!anime || anime.visibility === 'published' || anime.moderationStatus === 'Rejected') return null
  const updated = await Anime.findByIdAndUpdate(
    anime._id,
    { $set: { visibility: 'published' } },
    { new: true },
  )
  if (!updated) return null
  clearAnimePublicCaches()
  notifyPublishedAnime(updated)
  return updated
}

// Episodes and schedules contain unpublished content and video URLs.
router.use(requireEditor)

router.get('/', async (req, res) => {
  const { page, limit, skip, sort } = parseListQuery(req.query)
  const filter = {}
  if (req.query.animeId) filter.animeId = req.query.animeId
  if (req.query.status) filter.status = req.query.status
  if (req.query.published === 'true') filter.published = true
  if (req.query.published === 'false') filter.published = false
  if (req.query.q) {
    const animes = await Anime.find({ title: { $regex: escapeRegex(req.query.q), $options: 'i' } }).select('_id')
    filter.animeId = { $in: animes.map((a) => a._id) }
  }

  const [episodes, total] = await Promise.all([
    Episode.find(filter).select(ADMIN_LIST_FIELDS).populate('animeId', 'title').sort(sort).skip(skip).limit(limit).lean(),
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
    .select('animeId episodeNo episodeType title releaseAt scheduleMode video')
    .populate('animeId', 'title')
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

  // Computed "Not Out Yet" entries from weeklySchedule config
  const computedEntries = await computeAllWeeklySchedules()
  const realAnimeIds = new Set(episodes.map((e) => String(e.animeId?._id || e.animeId)))
  const awaitingUploadAnimeIds = new Set(awaitingUpload.map((e) => String(e.animeId?._id || e.animeId)))
  const notOutYet = computedEntries.filter((e) => {
    const aid = String(e.animeId?._id || e.animeId)
    return !realAnimeIds.has(aid) && !awaitingUploadAnimeIds.has(aid)
  })

  const upcomingAnimes = await Anime.find({ status: 'upcoming' })
    .select('title scheduledReleaseAt releaseStartDate')
    .sort({ scheduledReleaseAt: 1 })
    .lean()
  res.json({ episodes, readyToRelease, awaitingUpload, notOutYet, upcomingAnimes, overdue })
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
  clearEpisodeCaches()
  if (episodeHasContent(ep)) {
    autoPublishDraftAnime(ep.animeId?._id || ep.animeId).catch((err) => console.error('Auto-publish anime error:', err.message))
  }
  await convertUpcomingToOngoing()
  sendEpisodeReleaseNotifications([ep]).catch((err) => console.error('Push delivery error:', err.message))
  res.json({ episode: ep })
})

router.post('/:episodeId/finish-airing', requireEditor, async (req, res) => {
  const ep = await Episode.findById(req.params.episodeId).populate('animeId', 'title slug status')
  if (!ep) return res.status(404).json({ message: 'Not found' })
  if (ep.status !== 'released') {
    return res.status(400).json({ message: 'Finish Airing is only available from a released final episode.' })
  }

  const anime = await Anime.findById(ep.animeId._id || ep.animeId)
  if (!anime) return res.status(404).json({ message: 'Anime not found' })

  const laterScheduled = await Episode.findOne({
    animeId: anime._id,
    status: 'scheduled',
    _id: { $ne: ep._id },
  }).select('episodeNo episodeType').lean()
  if (laterScheduled) {
    const type = laterScheduled.episodeType === 'mini' ? 'Mini Episode' : 'Episode'
    return res.status(400).json({ message: `${type} ${laterScheduled.episodeNo} is still scheduled. Release or delete it before finishing the anime.` })
  }

  const update = { finishedAiring: true, status: 'completed' }
  await Anime.findByIdAndUpdate(anime._id, { $set: update })
  clearEpisodeCaches()
  cacheDel('public:new-additions')
  cacheDel('public:seo-animes')
  cacheDel('public:sitemap')
  res.json({ ok: true, anime: { _id: anime._id, title: anime.title, status: 'completed' } })
})

router.get('/hls/queue', async (_req, res) => {
  res.json({ queue: await getHlsQueueStatus() })
})

router.post('/hls/queue', async (req, res) => {
  const episodeIds = Array.isArray(req.body?.episodeIds) ? req.body.episodeIds : []
  if (!episodeIds.length) return res.status(400).json({ message: 'Provide at least one episode id.' })
  if (episodeIds.length > 20) return res.status(400).json({ message: 'Queue at most 20 episodes at a time.' })
  if (!isR2Configured()) return res.status(503).json({ message: 'Cloudflare R2 is not configured.' })
  if (!process.env.R2_PUBLIC_URL) return res.status(503).json({ message: 'R2_PUBLIC_URL is required for HLS streaming.' })

  const result = await queueHlsEpisodes(episodeIds)
  res.json({ ok: true, ...result, queue: await getHlsQueueStatus() })
})

router.post('/:episodeId/hls', requireEditor, async (req, res) => {
  if (!isR2Configured()) return res.status(503).json({ message: 'Cloudflare R2 is not configured.' })
  if (!process.env.R2_PUBLIC_URL) return res.status(503).json({ message: 'R2_PUBLIC_URL is required for HLS streaming.' })
  const result = await queueHlsEpisodes([req.params.episodeId], { regenerate: Boolean(req.body?.regenerate) })
  const id = String(req.params.episodeId)
  if (result.queued.includes(id)) {
    return res.status(202).json({ ok: true, hlsStatus: 'queued', ...result, queue: await getHlsQueueStatus() })
  }

  const skipped = result.skipped[0]
  if (skipped?.hlsStatus === 'manual_required') {
    return res.status(422).json({ message: skipped.reason, hlsStatus: 'manual_required', ...result })
  }
  if (skipped?.hlsStatus === 'queued' || skipped?.hlsStatus === 'processing') {
    return res.status(202).json({ ok: true, hlsStatus: skipped.hlsStatus, ...result, queue: await getHlsQueueStatus() })
  }
  if (skipped?.hlsStatus === 'ready') {
    return res.json({ ok: true, hlsStatus: 'ready', ...result })
  }
  return res.status(400).json({ message: skipped?.reason || 'Could not queue HLS generation.', ...result })
})

const HLS_HEIGHT_BITRATE = {
  360: 800_000, 480: 1_400_000, 720: 2_800_000, 1080: 5_000_000, 1440: 12_000_000, 2160: 30_000_000,
}
const HLS_WIDTH = { 360: 640, 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }

function parseQualityLabel(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[^0-9]/g, '')
  const h = Number(s)
  return HLS_HEIGHT_BITRATE[h] != null ? h : null
}

async function buildManualMaster({ episodeId, renditions }) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
  const { getR2Client, getR2BucketName, getR2PublicUrl, uploadBufferToR2 } = await import('../utils/r2Storage.js')

  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('R2_PUBLIC_URL is required for HLS streaming.')

  const valid = []
  for (const item of renditions) {
    const url = String(item?.url || '').split('?')[0]
    if (!url.startsWith(`${base}/`) || !url.endsWith('.m3u8')) {
      throw new Error('Each quality must be an R2 public .m3u8 playlist URL.')
    }
    const height = parseQualityLabel(item?.label || item?.height)
    if (!height) throw new Error('Each quality needs a resolution label (e.g. 1080p).')
    valid.push({ label: `${height}p`, height, width: HLS_WIDTH[height], url })
  }
  if (!valid.length) throw new Error('Provide at least one quality playlist.')

  const ep = String(episodeId || '').replace(/[^a-zA-Z0-9-]/g, '') || 'general'
  const masterKey = `hls/manual/${ep}/master-${Date.now()}.m3u8`

  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (const r of valid) {
    const bitrate = HLS_HEIGHT_BITRATE[r.height] || 5_000_000
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bitrate},AVERAGE-BANDWIDTH=${Math.round(bitrate * 0.9)},RESOLUTION=${r.width}x${r.height},NAME="${r.label}"`)
    lines.push(r.url)
  }
  lines.push('')

  await uploadBufferToR2({
    buffer: Buffer.from(lines.join('\n'), 'utf8'),
    key: masterKey,
    contentType: 'application/vnd.apple.mpegurl',
  })

  return {
    masterUrl: getR2PublicUrl(masterKey),
    renditions: valid.map((r) => ({ label: r.label, url: r.url, height: r.height })),
  }
}

router.post('/:episodeId/hls/manual', requireEditor, async (req, res) => {
  const episode = await Episode.findById(req.params.episodeId).lean()
  if (!episode) return res.status(404).json({ message: 'Episode not found' })
  if (!isR2Configured()) return res.status(503).json({ message: 'Cloudflare R2 is not configured.' })

  const renditions = Array.isArray(req.body?.renditions) ? req.body.renditions : []
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

  try {
    let manifest
    let hlsRenditions = []
    if (renditions.length) {
      const built = await buildManualMaster({ episodeId: episode._id, renditions })
      manifest = built.masterUrl
      hlsRenditions = built.renditions
    } else {
      manifest = String(req.body?.manifest || '').trim()
      if (!base || !manifest.startsWith(`${base}/`) || !manifest.split('?')[0].endsWith('.m3u8')) {
        return res.status(400).json({ message: 'Provide an R2 public URL for the uploaded HLS master .m3u8 file.' })
      }
    }

    const hls = {
      hlsManifest: manifest,
      hlsStatus: 'ready',
      hlsError: '',
      hlsRenditions,
      hlsSubtitles: [],
      hlsSourceResolution: String(req.body?.sourceResolution || episode.hlsSourceResolution || '').slice(0, 40),
      hlsGeneratedAt: new Date(),
    }
    await Episode.findByIdAndUpdate(episode._id, { $set: hls })
    res.json({ ok: true, ...hls })
  } catch (err) {
    res.status(400).json({ message: err.message || 'Could not register manual HLS.' })
  }
})

router.get('/by-anime/:animeId', async (req, res) => {
  const episodes = await Episode.find({ animeId: String(req.params.animeId) })
    .select('episodeNo episodeType serialNumber endSerialNumber')
    .lean()
  episodes.sort((a, b) => (
    (a.serialNumber ?? 1000000) - (b.serialNumber ?? 1000000)
    || a.episodeNo - b.episodeNo
  ))
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
    if (body.endSerialNumber != null) body.endSerialNumber = Number(body.endSerialNumber)
    else body.endSerialNumber = null

    try {
      normalizeScheduleBody(body, { requireVideo: body.scheduleMode !== 'upload_later' })
    } catch (err) {
      return res.status(400).json({ message: err.message })
    }

    const startNo = Number(body.episodeNo)
    const endNo = body.endSerialNumber || startNo
    if (endNo < startNo) {
      return res.status(400).json({ message: 'End serial number must be >= episode number' })
    }

    const existingRange = await Episode.find({
      animeId: body.animeId,
      episodeType: body.episodeType || 'full',
      $or: [
        { episodeNo: { $lte: endNo }, endSerialNumber: { $gte: startNo } },
        { episodeNo: { $gte: startNo, $lte: endNo } },
      ],
    }).select('_id episodeNo endSerialNumber').lean()

    if (existingRange.length) {
      const nums = existingRange.flatMap(e => {
        const s = Number(e.episodeNo)
        const en = e.endSerialNumber || s
        const range = []
        for (let i = s; i <= en; i++) range.push(i)
        return range
      })
      const overlap = [...new Set(nums)].filter(n => n >= startNo && n <= endNo)
      if (overlap.length) {
        return res.status(409).json({
          message: `Episode range ${startNo}${endNo > startNo ? '-' + endNo : ''} overlaps with existing episode(s) (${overlap.join(', ')}).`,
        })
      }
    }

    if (!body.thumbnail) {
      const animeDoc = await Anime.findById(body.animeId).select('defaultThumbnail poster').lean()
      if (animeDoc?.defaultThumbnail) body.thumbnail = animeDoc.defaultThumbnail
      else if (animeDoc?.poster) body.thumbnail = animeDoc.poster
    }

    const ep = await Episode.create(body)
    if (ep.video) {
      await queueHlsEpisodes([ep._id]).catch((err) => {
        console.error('Could not auto-queue HLS after episode creation:', err.message)
      })
    }
    clearEpisodeCaches()
    if (episodeHasContent(ep)) {
      autoPublishDraftAnime(ep.animeId).catch((err) => console.error('Auto-publish anime error:', err.message))
    }
    if (ep.published && ep.status === 'released') {
      convertUpcomingToOngoing().catch(() => {})
      const released = await Episode.findById(ep._id).populate('animeId', 'title slug').lean()
      sendEpisodeReleaseNotifications([released]).catch((err) => console.error('Push delivery error:', err.message))
    }
    res.status(201).json({ episode: ep })
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ message: 'This episode number already exists. Choose a different number.' })
    }
    res.status(400).json({ message: e.message })
  }
})

router.patch('/:episodeId', requireEditor, async (req, res) => {
  try {
    const existing = await Episode.findById(req.params.episodeId)
    if (!existing) return res.status(404).json({ message: 'Not found' })

    const body = pickEpisodeFields(req.body || {})
    const videoChanged = body.video !== undefined && body.video !== existing.video
    if (body.episodeNo != null) body.episodeNo = Number(body.episodeNo)
    if (body.endSerialNumber != null) body.endSerialNumber = Number(body.endSerialNumber)

    try {
      normalizeScheduleBody(body, { requireVideo: body.scheduleMode !== 'upload_later' })
    } catch (err) {
      return res.status(400).json({ message: err.message })
    }

    applyVideoUploadToSchedule(body, existing)

    if (videoChanged) {
      Object.assign(body, {
        hlsManifest: '',
        hlsStatus: '',
        hlsError: '',
        hlsRenditions: [],
        hlsSubtitles: [],
        hlsSourceResolution: '',
        hlsGeneratedAt: null,
      })
    }

    if (body.thumbnail === '' && existing.thumbnail) {
      const animeDoc = await Anime.findById(body.animeId || existing.animeId).select('defaultThumbnail poster').lean()
      if (animeDoc?.defaultThumbnail) body.thumbnail = animeDoc.defaultThumbnail
      else if (animeDoc?.poster) body.thumbnail = animeDoc.poster
    }

    if (body.animeId != null && body.episodeNo != null) {
      const startNo = Number(body.episodeNo)
      const endNo = body.endSerialNumber || startNo
      if (endNo < startNo) {
        return res.status(400).json({ message: 'End serial number must be >= episode number' })
      }

      const existingRange = await Episode.find({
        animeId: body.animeId,
        episodeType: body.episodeType || 'full',
        _id: { $ne: req.params.episodeId },
        $or: [
          { episodeNo: { $lte: endNo }, endSerialNumber: { $gte: startNo } },
          { episodeNo: { $gte: startNo, $lte: endNo } },
        ],
      }).select('_id episodeNo endSerialNumber').lean()

      if (existingRange.length) {
        const nums = existingRange.flatMap(e => {
          const s = Number(e.episodeNo)
          const en = e.endSerialNumber || s
          const range = []
          for (let i = s; i <= en; i++) range.push(i)
          return range
        })
        const overlap = [...new Set(nums)].filter(n => n >= startNo && n <= endNo)
        if (overlap.length) {
          return res.status(409).json({
            message: `Episode range ${startNo}${endNo > startNo ? '-' + endNo : ''} overlaps with existing episode(s) (${overlap.join(', ')}).`,
          })
        }
      }
    }

    const ep = await Episode.findByIdAndUpdate(req.params.episodeId, { $set: body }, { new: true, runValidators: true })
    if (!ep) return res.status(404).json({ message: 'Not found' })
    if (videoChanged && ep.video) {
      await queueHlsEpisodes([ep._id]).catch((err) => {
        console.error('Could not auto-queue HLS after video update:', err.message)
      })
    }
    clearEpisodeCaches()
    if (episodeHasContent(ep)) {
      autoPublishDraftAnime(ep.animeId || existing.animeId).catch((err) => console.error('Auto-publish anime error:', err.message))
    }
    if (ep.published && ep.status === 'released') {
      convertUpcomingToOngoing().catch(() => {})
      const wasReleased = existing.published && existing.status === 'released'
      if (!wasReleased) {
        const released = await Episode.findById(ep._id).populate('animeId', 'title slug').lean()
        sendEpisodeReleaseNotifications([released]).catch((err) => console.error('Push delivery error:', err.message))
      }
    }
    res.json({ episode: ep })
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ message: 'This episode number already exists.' })
    }
    res.status(400).json({ message: e.message })
  }
})

router.delete('/:episodeId', requireEditor, async (req, res) => {
  const ep = await Episode.findByIdAndDelete(req.params.episodeId)
  if (!ep) return res.status(404).json({ message: 'Not found' })
  clearEpisodeCaches()
  res.json({ ok: true })
})

router.post('/bulk', requireEditor, async (req, res) => {
  const { ids = [], action } = req.body || {}
  if (!ids.length) return res.status(400).json({ message: 'No ids provided' })

  if (action === 'delete') {
    const result = await Episode.deleteMany({ _id: { $in: ids } })
    if (result.deletedCount) clearEpisodeCaches()
    return res.json({ ok: true, deleted: result.deletedCount })
  }

  let update = {}
  if (action === 'publish') update = { published: true, status: 'released' }
  else if (action === 'unpublish') update = { published: false, status: 'draft' }
  else if (action === 'release') update = { published: true, status: 'released', releaseAt: new Date() }
  else if (action === 'schedule') update = { published: true, status: 'scheduled' }
  else return res.status(400).json({ message: 'Unknown action' })

  const result = await Episode.updateMany({ _id: { $in: ids } }, { $set: update })
  if (result.modifiedCount) clearEpisodeCaches()
  if (action === 'publish' || action === 'release') {
    const affected = await Episode.find({ _id: { $in: ids } }).select('animeId').lean()
    const animeIds = [...new Set(affected.map((e) => String(e.animeId)).filter(Boolean))]
    await Promise.all(animeIds.map((animeId) => autoPublishDraftAnime(animeId).catch((err) => console.error('Auto-publish anime error:', err.message))))
  }
  res.json({ ok: true, modified: result.modifiedCount })
})

router.post('/force-weekly/:animeId', requireEditor, async (req, res) => {
  try {
    const { generateWeeklyEpisodes } = await import('../utils/weeklySchedule.js')
    const anime = await Anime.findById(req.params.animeId).lean()
    if (!anime) return res.status(404).json({ message: 'Anime not found' })

    const ws = anime.weeklySchedule || {}
    if (!ws.enabled) {
      return res.status(400).json({ message: 'Weekly schedule not configured for this anime' })
    }

    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000
    const dayOfWeek = Number(ws.dayOfWeek ?? 0)
    const [h, m] = String(ws.time || '18:00').split(':').map(Number)

    const fullTypeFilter = { $in: ['full', '', null] }
    const existing = await Episode.find({
      animeId: anime._id,
      $or: [{ episodeType: fullTypeFilter }, { episodeType: { $exists: false } }],
    }).sort({ episodeNo: -1 }).lean()

    const lastNo = existing.length ? Number(existing[0].endSerialNumber || existing[0].episodeNo) : 0
    const nextNo = lastNo + 1

    const now = new Date()

    const dup = await Episode.findOne({
      animeId: anime._id,
      episodeNo: nextNo,
      $or: [{ episodeType: fullTypeFilter }, { episodeType: { $exists: false } }],
    }).lean()
    if (dup) return res.status(400).json({ message: `Episode ${nextNo} already exists`, episode: dup })

    let releaseAt
    if (!existing.length && ws.startDate) {
      const [sy, sm, sd] = String(ws.startDate).split('-').map(Number)
      if (sy && sm && sd) {
        releaseAt = new Date(Date.UTC(sy, sm - 1, sd, h || 0, m || 0, 0, 0) - PKT_OFFSET_MS)
      }
    }
    if (!releaseAt) {
      const pkt = new Date(now.getTime() + PKT_OFFSET_MS)
      pkt.setUTCSeconds(0, 0)
      pkt.setUTCMinutes(m || 0)
      pkt.setUTCHours(h || 0)
      let diff = (((dayOfWeek % 7) - pkt.getUTCDay()) + 7) % 7
      if (diff === 0) diff = 7
      pkt.setUTCDate(pkt.getUTCDate() + diff)
      releaseAt = new Date(pkt.getTime() - PKT_OFFSET_MS)
    }

    const ep = await Episode.create({
      animeId: anime._id,
      episodeNo: nextNo,
      episodeType: 'full',
      serialNumber: nextNo,
      status: 'scheduled',
      scheduleMode: 'upload_later',
      releaseAt,
      published: true,
      title: `Episode ${nextNo}`,
      thumbnail: anime.defaultThumbnail || anime.poster || '',
      durationMin: anime.runtime || 24,
    })

    clearEpisodeCaches()
    res.json({ ok: true, episode: ep, message: `Episode ${nextNo} scheduled for ${releaseAt.toISOString()}` })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/force-weekly-bulk', requireEditor, async (req, res) => {
  try {
    const { generateWeeklyEpisodes } = await import('../utils/weeklySchedule.js')
    const ids = req.body?.animeIds
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ message: 'Provide animeIds array' })
    }

    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000
    const results = []

    for (const id of ids) {
      try {
        const anime = await Anime.findById(id).lean()
        if (!anime) { results.push({ id, error: 'Not found' }); continue }

        const ws = anime.weeklySchedule || {}
        if (!ws.enabled) {
          results.push({ id, title: anime.title, error: 'Weekly schedule not configured' }); continue
        }

        const dayOfWeek = Number(ws.dayOfWeek ?? 0)
        const [h, m] = String(ws.time || '18:00').split(':').map(Number)
        const fullTypeFilter = { $in: ['full', '', null] }

        const existing = await Episode.find({
          animeId: anime._id,
          $or: [{ episodeType: fullTypeFilter }, { episodeType: { $exists: false } }],
        }).sort({ episodeNo: -1 }).lean()

        const lastNo = existing.length ? Number(existing[0].endSerialNumber || existing[0].episodeNo) : 0
        const nextNo = lastNo + 1
        const now = new Date()

        const dup = await Episode.findOne({
          animeId: anime._id,
          episodeNo: nextNo,
          $or: [{ episodeType: fullTypeFilter }, { episodeType: { $exists: false } }],
        }).lean()
        if (dup) { results.push({ id, title: anime.title, error: `Ep ${nextNo} already exists` }); continue }

        let releaseAt
        if (!existing.length && ws.startDate) {
          const [sy, sm, sd] = String(ws.startDate).split('-').map(Number)
          if (sy && sm && sd) {
            releaseAt = new Date(Date.UTC(sy, sm - 1, sd, h || 0, m || 0, 0, 0) - PKT_OFFSET_MS)
          }
        }
        if (!releaseAt) {
          const pkt = new Date(now.getTime() + PKT_OFFSET_MS)
          pkt.setUTCSeconds(0, 0)
          pkt.setUTCMinutes(m || 0)
          pkt.setUTCHours(h || 0)
          let diff = (((dayOfWeek % 7) - pkt.getUTCDay()) + 7) % 7
          if (diff === 0) diff = 7
          pkt.setUTCDate(pkt.getUTCDate() + diff)
          releaseAt = new Date(pkt.getTime() - PKT_OFFSET_MS)
        }

        await Episode.create({
          animeId: anime._id,
          episodeNo: nextNo,
          episodeType: 'full',
          serialNumber: nextNo,
          status: 'scheduled',
          scheduleMode: 'upload_later',
          releaseAt,
          published: true,
          title: `Episode ${nextNo}`,
          thumbnail: anime.defaultThumbnail || anime.poster || '',
          durationMin: anime.runtime || 24,
        })

        results.push({ id, title: anime.title, episodeNo: nextNo, releaseAt: releaseAt.toISOString() })
      } catch (err) {
        results.push({ id, error: err.message })
      }
    }

    if (results.some((result) => result.episodeNo != null)) clearEpisodeCaches()
    res.json({ ok: true, results })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/ai-summary', async (req, res) => {
  if (!isAIEnabled()) return res.status(503).json({ message: 'AI not configured' })
  const { episodeId, episodeIds } = req.body || {}

  if (episodeId) {
    const ep = await Episode.findById(episodeId).populate('animeId', 'title description').lean()
    if (!ep) return res.status(404).json({ message: 'Episode not found' })
    try {
      const summary = await generateEpisodeSummary(
        ep.title || `Episode ${ep.episodeNo}`,
        ep.animeId?.title || 'Unknown',
        ep.episodeNo,
        ep.animeId?.description || '',
      )
      await Episode.findByIdAndUpdate(episodeId, { $set: { aiSummary: summary } })
      return res.json({ summary, episodeId })
    } catch (err) {
      return res.status(500).json({ message: err.message })
    }
  }

  if (Array.isArray(episodeIds) && episodeIds.length > 0) {
    const limited = episodeIds.slice(0, 20)
    const results = await Promise.allSettled(limited.map(async (id) => {
      const ep = await Episode.findById(id).populate('animeId', 'title description').lean()
      if (!ep) return { episodeId: id, error: 'Not found' }
      const summary = await generateEpisodeSummary(
        ep.title || `Episode ${ep.episodeNo}`,
        ep.animeId?.title || 'Unknown',
        ep.episodeNo,
        ep.animeId?.description || '',
      )
      await Episode.findByIdAndUpdate(id, { $set: { aiSummary: summary } })
      return { episodeId: id, summary }
    }))
    return res.json({ results: results.map((r) => r.value || { error: r.reason?.message }) })
  }

  res.status(400).json({ message: 'episodeId or episodeIds required' })
})

export default router
