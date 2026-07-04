export function pickDefined(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v
  }
  return out
}

const EPISODE_FIELDS = new Set([
  'animeId', 'episodeNo', 'title', 'slug', 'description', 'thumbnail', 'durationMin', 'isFiller',
  'embedUrl', 'videoUrl', 'externalUrl', 'video', 'subtitles', 'releaseDate', 'releaseTime', 'releaseAt',
  'status', 'published', 'preview', 'scheduleMode',
])

export function pickEpisodeFields(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (EPISODE_FIELDS.has(k) && v !== undefined) out[k] = v
  }
  return out
}

export function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseListQuery(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1)
  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 20))
  const skip = (page - 1) * limit
  const sort = query.sort || '-createdAt'
  return { page, limit, skip, sort }
}
