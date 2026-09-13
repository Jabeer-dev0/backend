const store = new Map()

export function cacheGet(key) {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    store.delete(key)
    return null
  }
  return entry.value
}

export function cacheSet(key, value, ttlMs = 60_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

export function cacheDel(key) {
  store.delete(key)
}

export function cacheDelPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}

export function setPublicCache(res, seconds = 60) {
  res.set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=120`)
}

let lastReleaseCheck = 0
export async function releaseDueIfNeeded(releaseDueEpisodes) {
  const now = Date.now()
  if (now - lastReleaseCheck < 60_000) return
  lastReleaseCheck = now
  await releaseDueEpisodes()
}

let lastWeeklyCheck = 0
export async function weeklyIfNeeded(generateWeeklyEpisodes) {
  const now = Date.now()
  if (now - lastWeeklyCheck < 60_000) return
  lastWeeklyCheck = now
  try {
    const scheduled = await generateWeeklyEpisodes()
    if (scheduled > 0) console.log(`Auto-scheduled ${scheduled} weekly episode(s)`)
  } catch (err) {
    console.error('Weekly scheduler error:', err.message)
  }
}
