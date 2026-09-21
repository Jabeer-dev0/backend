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

// No longer auto-creates episode entries. Schedule info is computed from
// the weeklySchedule config on each anime and shown as "Not Out Yet" until
// the admin uploads the actual video.
export async function generateWeeklyEpisodes() {
  return 0
}

// Compute the next scheduled episode info for an anime from its weeklySchedule
// config WITHOUT creating any DB entries. Returns { episodeNo, releaseAt, status }
// or null if no schedule is configured or anime is finished airing.
export async function computeNextWeeklySchedule(anime, lastEpNoMap) {
  const ws = anime.weeklySchedule
  if (!ws || !ws.enabled) return null
  if (anime.finishedAiring) return null

  const dayOfWeek = Number(ws.dayOfWeek ?? 0)
  const time = ws.time || '18:00'
  if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null

  // Use pre-fetched last episode map if available, otherwise query individually
  let lastNo = 0
  if (lastEpNoMap) {
    lastNo = lastEpNoMap.get(String(anime._id || anime.id)) || 0
  } else {
    const lastEp = await Episode.find({ animeId: anime._id || anime.id, status: 'released' })
      .sort({ episodeNo: -1 })
      .limit(1)
      .lean()
    lastNo = lastEp.length ? Number(lastEp[0].endSerialNumber || lastEp[0].episodeNo) : 0
  }

  // For upcoming anime with no released episodes yet, show episode 1
  const nextNo = lastNo <= 0 ? 1 : lastNo + 1
  const now = new Date()
  const releaseAt = nextWeeklyOccurrence({ dayOfWeek, time }, now)

  return {
    episodeNo: nextNo,
    releaseAt,
    status: 'not_out_yet',
    title: `Episode ${nextNo}`,
    note: 'Not Out Yet',
  }
}

// Compute upcoming schedule entries for ALL ongoing anime with weekly enabled.
// Returns virtual episode-like objects for the schedule page.
export async function computeAllWeeklySchedules() {
  const animes = await Anime.find({
    'weeklySchedule.enabled': true,
    finishedAiring: false,
    status: { $in: ['ongoing', 'upcoming'] },
  }).lean()

  // Batch-fetch last released episode numbers for all anime in one query
  const animeIds = animes.map((a) => String(a._id || a.id))
  const lastEps = await Episode.find({
    animeId: { $in: animeIds },
    status: 'released',
  }).sort({ episodeNo: -1 }).lean()

  const lastEpNoMap = new Map()
  for (const ep of lastEps) {
    const aid = String(ep.animeId?._id || ep.animeId)
    if (!lastEpNoMap.has(aid)) {
      lastEpNoMap.set(aid, Number(ep.endSerialNumber || ep.episodeNo) || 0)
    }
  }

  const entries = []
  for (const anime of animes) {
    const ws = typeof anime.weeklySchedule === 'string' ? JSON.parse(anime.weeklySchedule || '{}') : (anime.weeklySchedule || {})
    const computed = await computeNextWeeklySchedule({ ...anime, weeklySchedule: ws }, lastEpNoMap)
    if (computed) {
      entries.push({
        _id: `schedule:${anime._id}`,
        animeId: anime,
        episodeNo: computed.episodeNo,
        title: computed.title,
        releaseAt: computed.releaseAt,
        status: computed.status,
        note: computed.note,
        published: true,
        scheduleMode: 'computed',
        thumbnail: anime.defaultThumbnail || anime.poster || '',
      })
    }
  }

  entries.sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt))

  return entries
}
