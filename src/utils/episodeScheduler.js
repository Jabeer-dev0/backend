import Episode from '../models/Episode.js'

function hasVideo(episode) {
  return Boolean(episode?.video && String(episode.video).trim())
}

export async function releaseDueEpisodes() {
  const now = new Date()
  const result = await Episode.updateMany(
    {
      status: 'scheduled',
      scheduleMode: { $in: ['ready', null] },
      releaseAt: { $lte: now },
      video: { $exists: true, $nin: ['', null] },
    },
    {
      $set: { status: 'released', published: true, scheduleMode: 'ready' },
    },
  )
  return result.modifiedCount || 0
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

  return episodes.map((ep) => {
    const releaseAt = new Date(ep.releaseAt)
    let urgency = 'soon'
    if (releaseAt <= now) urgency = 'overdue'
    else if (releaseAt <= endOfToday) urgency = 'today'
    return { ...ep, urgency }
  })
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
    } catch (err) {
      console.error('Episode scheduler error:', err.message)
    }
  }

  tick()
  return setInterval(tick, intervalMs)
}
