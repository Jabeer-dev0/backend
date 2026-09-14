import Episode from '../models/Episode.js'
import { convertUpcomingToOngoing } from './newAdditionsScheduler.js'
import { generateWeeklyEpisodes } from './weeklySchedule.js'
import { sendEpisodeReleaseNotifications } from './pushNotifications.js'
import { cacheDel, cacheDelPrefix } from './cache.js'

function hasVideo(episode) {
  return Boolean(episode?.video && String(episode.video).trim())
}

function clearEpisodeCaches() {
  cacheDel('public:home')
  cacheDel('public:latest-releases')
  cacheDelPrefix('public:anime:')
  cacheDelPrefix('public:anime-eps:')
}

export async function releaseDueEpisodes() {
  const now = new Date()
  const dueFilter = {
    status: 'scheduled',
    scheduleMode: { $in: ['ready', null] },
    releaseAt: { $lte: now },
    video: { $exists: true, $nin: ['', null] },
  }
  const dueEpisodes = await Episode.find(dueFilter)
    .populate('animeId', 'title slug')
    .lean()
  if (!dueEpisodes.length) return 0

  const result = await Episode.updateMany(
    dueFilter,
    {
      $set: { status: 'released', published: true, scheduleMode: 'ready' },
    },
  )
  const released = result.modifiedCount || 0
  if (released > 0) {
    clearEpisodeCaches()
    await convertUpcomingToOngoing()
    sendEpisodeReleaseNotifications(dueEpisodes).catch((err) => console.error('Push delivery error:', err.message))
  }
  return released
}

export async function getUploadReminders() {
  const now = new Date()
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000)

  const episodes = await Episode.find({
    status: 'scheduled',
    scheduleMode: 'upload_later',
    $or: [{ video: '' }, { video: { $exists: false } }],
    releaseAt: { $lte: in48h },
  })
    .populate('animeId', 'title poster slug')
    .sort({ releaseAt: 1 })
    .lean()

  const dbReminders = episodes.map((ep) => {
    const releaseAt = new Date(ep.releaseAt)
    let urgency = 'soon'
    if (releaseAt <= now) urgency = 'overdue'
    else if (releaseAt <= endOfToday) urgency = 'today'
    return { ...ep, urgency }
  })

  // Also include computed "Not Out Yet" entries whose release is within 48h
  const { computeAllWeeklySchedules } = await import('./weeklySchedule.js')
  const computed = await computeAllWeeklySchedules()
  const dbAnimeIds = new Set(dbReminders.map((e) => String(e.animeId?._id || e.animeId)))
  const computedReminders = computed
    .filter((e) => {
      const aid = String(e.animeId?._id || e.animeId)
      if (dbAnimeIds.has(aid)) return false
      const releaseAt = new Date(e.releaseAt)
      return releaseAt <= in48h
    })
    .map((e) => {
      const releaseAt = new Date(e.releaseAt)
      let urgency = 'soon'
      if (releaseAt <= now) urgency = 'overdue'
      else if (releaseAt <= endOfToday) urgency = 'today'
      return { ...e, urgency, _computed: true }
    })

  return [...dbReminders, ...computedReminders].sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt))
}

export function applyVideoUploadToSchedule(body, existing) {
  if (!existing || existing.scheduleMode !== 'upload_later') return body
  if (!hasVideo(body) && !hasVideo(existing)) return body

  body.scheduleMode = 'ready'
  const releaseAt = body.releaseAt ? new Date(body.releaseAt) : existing.releaseAt
  if (releaseAt && releaseAt <= new Date() && (body.status === 'scheduled' || existing.status === 'scheduled')) {
    body.status = 'released'
    body.published = true
  }
  return body
}

export function startEpisodeScheduler(intervalMs = 60_000) {
  const tick = async () => {
    try {
      const released = await releaseDueEpisodes()
      if (released > 0) console.log(`Auto-released ${released} scheduled episode(s)`)
      const scheduled = await generateWeeklyEpisodes()
      if (scheduled > 0) console.log(`Auto-scheduled ${scheduled} weekly episode(s)`)
    } catch (err) {
      console.error('Episode scheduler error:', err.message)
    }
  }

  tick()
  return setInterval(tick, intervalMs)
}
