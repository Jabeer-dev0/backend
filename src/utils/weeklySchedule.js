import Episode from '../models/Episode.js'
import Anime from '../models/Anime.js'
import { cacheDel, cacheDelPrefix } from './cache.js'

// Admin sets day/time in Pakistan Standard Time (UTC+5, no DST).
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000

function clearEpisodeCaches() {
  cacheDel('public:home')
  cacheDel('public:latest-releases')
  cacheDelPrefix('public:anime:')
  cacheDelPrefix('public:anime-eps:')
}

// Compute the next datetime that falls on `dayOfWeek` at `time` (HH:mm) in
// Pakistan time, strictly after `after`. Returns a UTC Date (releaseAt).
export function nextWeeklyOccurrence({ dayOfWeek, time }, after) {
  const [h, m] = String(time || '00:00').split(':').map(Number)

  // Work in a "PKT clock" by shifting into UTC+5 space, doing the weekday/time
  // math with UTC getters/setters, then shifting back to real UTC.
  const pkt = new Date(new Date(after).getTime() + PKT_OFFSET_MS)
  pkt.setUTCSeconds(0, 0)
  pkt.setUTCMinutes(m || 0)
  pkt.setUTCHours(h || 0)

  let diff = (((dayOfWeek % 7) - pkt.getUTCDay()) + 7) % 7
  const afterPkt = new Date(after).getTime() + PKT_OFFSET_MS
  if (diff === 0 && pkt.getTime() <= afterPkt) diff = 7
  pkt.setUTCDate(pkt.getUTCDate() + diff)

  return new Date(pkt.getTime() - PKT_OFFSET_MS)
}

// Parse "YYYY-MM-DD" + "HH:mm" as Pakistan time and return a UTC Date.
export function pktDateTimeToUtc(dateStr, time) {
  const [h, m] = String(time || '00:00').split(':').map(Number)
  const [y, mo, d] = String(dateStr).split('-').map(Number)
  if (!y || !mo || !d) return null
  const utcMs = Date.UTC(y, mo - 1, d, h || 0, m || 0, 0, 0) - PKT_OFFSET_MS
  return new Date(utcMs)
}

// For each anime with auto weekly schedule enabled (and not finished airing),
// create the next "full" episode if it does not already exist.
// Rule: a new episode is only created 1 hour after the previous episode has
// been released, and its releaseAt is the next weekly slot after that release.
export async function generateWeeklyEpisodes() {
  const animes = await Anime.find({
    'weeklySchedule.enabled': true,
    finishedAiring: false,
    status: { $in: ['ongoing', 'upcoming'] },
  }).lean()

  if (!animes.length) return 0

  let created = 0
  const now = new Date()

  for (const anime of animes) {
    const ws = anime.weeklySchedule || {}
    // Older records can have only { enabled: true }; use the same defaults the
    // admin form displays so those schedules are not silently skipped.
    const dayOfWeek = Number(ws.dayOfWeek ?? 0)
    const time = ws.time || '18:00'
    if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue

    // Self-heal: remove any wrongly auto-created scheduled episode whose number
    // already exists as a released episode (from a previous buggy run).
    const releasedNos = (await Episode.find({
      animeId: anime._id,
      status: 'released',
    })
      .select('episodeNo')
      .lean())
      .map((e) => Number(e.episodeNo))
    if (releasedNos.length) {
      await Episode.deleteMany({
        animeId: anime._id,
        status: 'scheduled',
        episodeNo: { $in: releasedNos },
      })
    }

    // Self-heal: fix any scheduled episode that is published=false (from an
    // earlier buggy deploy). They should be visible on the schedule page.
    await Episode.updateMany(
      { animeId: anime._id, status: 'scheduled', published: false, releaseAt: { $gt: now } },
      { $set: { published: true } },
    )

    const existing = await Episode.find({
      animeId: anime._id,
    })
      .sort({ episodeNo: -1 })
      .limit(1)
      .lean()

    const lastNo = existing.length ? Number(existing[0].endSerialNumber || existing[0].episodeNo) : 0
    const nextNo = lastNo + 1

    const dup = await Episode.findOne({
      animeId: anime._id,
      episodeNo: nextNo,
    }).lean()
    if (dup) continue

    let releaseAt
    if (!existing.length && ws.startDate) {
      // First episode: anchor to the provided start date at the chosen time (PKT).
      const start = pktDateTimeToUtc(ws.startDate, time)
      if (start && start.getTime() > now.getTime()) {
        releaseAt = start
      }
    }
    if (!releaseAt) {
      if (existing.length) {
        const last = existing[0]
        const lastRelease = last.releaseAt ? new Date(last.releaseAt) : null

        // The previous episode must be ACTUALLY released before we create the next one.
        const isReleased =
          last.status === 'released' ||
          (last.published && lastRelease && lastRelease.getTime() <= now.getTime())
        if (!isReleased) continue

        // And only 1 hour after that release.
        const releasedAt = lastRelease || now
        if (now.getTime() < releasedAt.getTime() + 60 * 60 * 1000) continue

        // Next episode must be the FOLLOWING week, never the same day/week.
        // Start looking from 1 day after the previous release so the same
        // weekday can't resolve to the current week.
        const searchFrom = new Date(releasedAt.getTime() + 24 * 60 * 60 * 1000)
        releaseAt = nextWeeklyOccurrence({ dayOfWeek, time }, searchFrom)
      } else {
        // No start date and no episodes yet: schedule the next weekly slot.
        releaseAt = nextWeeklyOccurrence({ dayOfWeek, time }, now)
      }
    }
    if (releaseAt.getTime() <= now.getTime()) continue

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
    created += 1
    clearEpisodeCaches()
  }

  return created
}
