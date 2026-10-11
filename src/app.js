import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import compression from 'compression'

import publicRoutes from './routes/public.js'
import publicSearchRoutes from './routes/publicSearch.js'
import adminRoutes from './routes/admin.js'
import dashboardRoutes from './routes/dashboard.js'
import animesRoutes from './routes/animes.js'
import episodesRoutes from './routes/episodes.js'
import genresRoutes from './routes/genres.js'
import tagsRoutes from './routes/tags.js'
import commentsRoutes from './routes/comments.js'
import feedbackRoutes from './routes/feedback.js'
import authRoutes from './routes/auth.js'
import usersRoutes from './routes/users.js'
import analyticsRoutes from './routes/analytics.js'
import mediaRoutes from './routes/media.js'
import settingsRoutes from './routes/settings.js'
import subscriptionRoutes from './routes/subscription.js'
import bookmarksRoutes from './routes/bookmarks.js'
import ratingsRoutes from './routes/ratings.js'
import watchHistoryRoutes from './routes/watchHistory.js'
import postsRoutes from './routes/posts.js'
import publicPostsRoutes from './routes/publicPosts.js'
import publicMusicRoutes from './routes/publicMusic.js'
import promptsRoutes from './routes/prompts.js'
import pushRoutes from './routes/push.js'
import notificationFollowsRoutes from './routes/notificationFollows.js'
import musicCatalogRoutes from './routes/musicCatalog.js'
import aiRoutes from './routes/ai.js'
import offlineDownloadRoutes from './routes/offlineDownloads.js'
import { isD1Configured, d1Test, d1Hint, d1Run } from './db/d1.js'
import SiteSettings from './models/SiteSettings.js'
import { adminLoginLimiter, authLimiter, feedbackLimiter, commentsLimiter, viewLimiter } from './middleware/rateLimit.js'
import { isWorker, lazyNodeImport } from './utils/runtime.js'

if (!isWorker()) {
  const mod = await lazyNodeImport('dotenv')
  mod.default.config()
}

const isVercel = typeof process !== 'undefined' && Boolean(process.env?.VERCEL)

const app = express()
app.set('trust proxy', 1)

let maintenanceMode = false
let maintenanceModeExpiresAt = 0
let maintenanceModeRequest = null

function getMaintenanceMode() {
  if (Date.now() < maintenanceModeExpiresAt) return Promise.resolve(maintenanceMode)
  if (maintenanceModeRequest) return maintenanceModeRequest

  maintenanceModeRequest = SiteSettings.findOne({ key: 'global' })
    .lean()
    .then((settings) => {
      maintenanceMode = Boolean(settings?.maintenanceMode)
      maintenanceModeExpiresAt = Date.now() + 60_000
      return maintenanceMode
    })
    .catch(() => {
      maintenanceModeExpiresAt = Date.now() + 15_000
      return false
    })
    .finally(() => { maintenanceModeRequest = null })
  return maintenanceModeRequest
}

const ensurePromptSchema = async () => {
  if (!isD1Configured()) return
  try {
    await d1Run(`CREATE TABLE IF NOT EXISTS feedbackprompts (id TEXT PRIMARY KEY, viewerId TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'request_anime', refId TEXT, lastAskedAt TEXT, answered INTEGER NOT NULL DEFAULT 0, createdAt TEXT, updatedAt TEXT)`)
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_feedbackprompts_viewer_kind ON feedbackprompts(viewerId, kind)`)
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_feedbackprompts_kind_ref ON feedbackprompts(kind, refId)`)
    await d1Run(`ALTER TABLE feedbacks ADD COLUMN rating REAL NOT NULL DEFAULT 0`).catch(() => {})
    for (const column of ['poster', 'banner', 'releaseDate', 'format', 'episodeCount', 'studio', 'sourceMaterial', 'officialUrl']) {
      await d1Run(`ALTER TABLE posts ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`).catch(() => {})
    }
    await d1Run(`ALTER TABLE posts ADD COLUMN relatedAnimeIds TEXT NOT NULL DEFAULT '[]'`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN artistId TEXT`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN albumId TEXT`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN collectionIds TEXT NOT NULL DEFAULT '[]'`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN musicVip INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN vipAudioKey TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS musicartists (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, bio TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', createdAt TEXT, updatedAt TEXT)`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS musicalbums (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, collectionType TEXT NOT NULL DEFAULT 'album', artistId TEXT, artistIds TEXT NOT NULL DEFAULT '[]', cover TEXT NOT NULL DEFAULT '', releaseDate TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', relatedAnimeIds TEXT NOT NULL DEFAULT '[]', createdAt TEXT, updatedAt TEXT)`).catch(() => {})
    await d1Run(`ALTER TABLE musicalbums ADD COLUMN relatedAnimeIds TEXT NOT NULL DEFAULT '[]'`).catch(() => {})
    await d1Run(`ALTER TABLE musicalbums ADD COLUMN artistIds TEXT NOT NULL DEFAULT '[]'`).catch(() => {})
    await d1Run(`ALTER TABLE musicalbums ADD COLUMN collectionType TEXT NOT NULL DEFAULT 'album'`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_musicalbums_artist ON musicalbums(artistId, createdAt DESC)`).catch(() => {})
    await d1Run(`ALTER TABLE animes ADD COLUMN country TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_animes_vis_mod_country_created ON animes(visibility, moderationStatus, country, createdAt DESC)`).catch(() => {})
    await d1Run(`ALTER TABLE animes ADD COLUMN notificationFollowers INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE animes ADD COLUMN notificationSentAt TEXT`).catch(() => {})
    await d1Run(`ALTER TABLE users ADD COLUMN notificationPreferences TEXT NOT NULL DEFAULT '{}'`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS animefollows (id TEXT PRIMARY KEY, userId TEXT NOT NULL, animeId TEXT NOT NULL, createdAt TEXT, updatedAt TEXT, UNIQUE (userId, animeId))`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_animefollows_anime ON animefollows(animeId, createdAt DESC)`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_animefollows_user ON animefollows(userId, createdAt DESC)`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN shareCount INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN ratingAvg REAL NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN ratingCount INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE posts ADD COLUMN notificationSentAt TEXT`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS postshares (id TEXT PRIMARY KEY, postId TEXT NOT NULL, userId TEXT NOT NULL, createdAt TEXT, updatedAt TEXT, UNIQUE (postId, userId))`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_postshares_post ON postshares(postId, createdAt DESC)`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_postshares_user ON postshares(userId, createdAt DESC)`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS postratings (id TEXT PRIMARY KEY, postId TEXT NOT NULL, userId TEXT NOT NULL, rating INTEGER NOT NULL, createdAt TEXT, updatedAt TEXT, UNIQUE (postId, userId))`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_postratings_post ON postratings(postId, updatedAt DESC)`).catch(() => {})
    await d1Run(`ALTER TABLE episodewatchlogs ADD COLUMN progressSeconds INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE episodewatchlogs ADD COLUMN durationSeconds INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE episodewatchlogs ADD COLUMN completedAt TEXT`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN ratingCount INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN aiSummary TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsManifest TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsStatus TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsError TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsRenditions TEXT NOT NULL DEFAULT '[]'`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsSubtitles TEXT NOT NULL DEFAULT '[]'`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsSourceResolution TEXT NOT NULL DEFAULT ''`).catch(() => {})
    await d1Run(`ALTER TABLE episodes ADD COLUMN hlsGeneratedAt TEXT`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_episodes_hls_queue ON episodes(hlsStatus, updatedAt, id)`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS episoderatings (id TEXT PRIMARY KEY, userId TEXT NOT NULL, episodeId TEXT NOT NULL, rating INTEGER NOT NULL, createdAt TEXT, updatedAt TEXT, UNIQUE (userId, episodeId))`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_episoderatings_episode ON episoderatings(episodeId, createdAt DESC)`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_episoderatings_user ON episoderatings(userId, createdAt DESC)`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_ratings_anime ON anmeratings(animeId, updatedAt DESC)`).catch(() => {})
    await d1Run(`CREATE TABLE IF NOT EXISTS pushsubscriptions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)`).catch(() => {})
    await d1Run(`CREATE INDEX IF NOT EXISTS idx_pushsubscription_user ON pushsubscriptions(userId)`).catch(() => {})
  } catch (e) {
    console.warn('ensurePromptSchema failed:', e.message)
  }
}
if (!isVercel) {
  ensurePromptSchema()
}

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
  'https://jabeer-dev0.github.io',
  'https://anikuraa.com',
  'https://www.anikuraa.com',
  'http://anikuraa.com',
  'http://www.anikuraa.com',
  ...(process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    const ok =
      allowedOrigins.includes(origin) ||
      /^https?:\/\/[\w-]+\.vercel\.app$/.test(origin) ||
      /^https?:\/\/[\w-]+\.github\.io(\/[\w-]+)?$/.test(origin) ||
      /^https?:\/\/([\w-]+\.)?anikuraa\.com$/.test(origin) ||
      /^capacitor-electron:\/\//i.test(origin)
    callback(null, ok)
  },
  credentials: true,
  exposedHeaders: ['X-Anikura-Offline-Tier', 'X-Anikura-Offline-Expires', 'X-Anikura-Offline-Size'],
}))
app.use(compression())
app.use(express.json({ limit: '50mb' }))

app.use('/api/public', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  next()
})
app.use('/api/subscription/plans', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=300')
  next()
})

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'AniKura API' })
})

app.get('/favicon.ico', (req, res) => res.status(204).end())
app.get('/favicon.png', (req, res) => res.status(204).end())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/ready', async (_req, res) => {
  if (!isD1Configured()) {
    return res.status(503).json({ ok: false, db: 'd1-not-configured', hint: d1Hint() })
  }
  try {
    await d1Test()
    return res.json({ ok: true, db: 'd1' })
  } catch (err) {
    return res.status(503).json({ ok: false, db: 'd1-error', message: err.message })
  }
})

app.use(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/' || req.path === '/favicon.ico' || req.path === '/favicon.png') {
    return next()
  }

  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/settings')) {
    return next()
  }

  try {
    if (await getMaintenanceMode()) {
      return res.status(503).json({ message: 'Site is under maintenance. Please try again later.' })
    }
  } catch {
    // If settings check fails, allow the request through
  }
  next()
})

app.use('/api/admin/password-login', adminLoginLimiter)
app.use('/api/auth', authLimiter)
app.use('/api/public/feedback', feedbackLimiter)
app.use('/api/public/episodes/:id/comments', commentsLimiter)
app.use('/api/public/posts/:slug/comments', (req, res, next) => {
  if (req.method === 'POST') return commentsLimiter(req, res, next)
  next()
})
app.use('/api/public/posts/:slug/like', viewLimiter)
app.use('/api/public/episodes/:id/view', viewLimiter)

app.use('/api/public/posts', publicPostsRoutes)
app.use('/api/public/music', publicMusicRoutes)
app.use('/api/public/prompts', promptsRoutes)
app.use('/api/public', publicSearchRoutes)
// Keep the legacy episode file endpoint app-only without touching public.js.
app.use('/api/public/download', (req, res, next) => {
  if (req.get('X-Anikura-App') !== 'installed') {
    return res.status(403).json({ message: 'Install the AniKura app to save episodes for offline watching.' })
  }
  next()
})
app.use('/api/public', publicRoutes)
app.use('/api/offline', offlineDownloadRoutes)

app.get('/sitemap.xml', (req, res) => {
  res.redirect(301, '/api/public/sitemap.xml')
})
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /login\nDisallow: /profile\nDisallow: /bookmarks\nDisallow: /history\n\nSitemap: https://anikuraa.com/sitemap.xml')
})
app.use('/api/auth', authRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/animes', animesRoutes)
app.use('/api/episodes', episodesRoutes)
app.use('/api/genres', genresRoutes)
app.use('/api/tags', tagsRoutes)
app.use('/api/comments', commentsRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/media', mediaRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/subscription', subscriptionRoutes)
app.use('/api/bookmarks', bookmarksRoutes)
app.use('/api/ratings', ratingsRoutes)
app.use('/api/watch-history', watchHistoryRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/notification-follows', notificationFollowsRoutes)
app.use('/api/music-catalog', musicCatalogRoutes)
app.use('/api/posts', postsRoutes)
app.use('/api/ai', aiRoutes)

app.use((err, req, res, _next) => {
  if (err?.name === 'CastError' || err?.name === 'ValidationError') {
    return res.status(400).json({ message: err.message || 'Invalid input' })
  }
  console.error('Unhandled error:', err)
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' })
})

// The uploads router is Node-only (multer/ffmpeg/zip). The Worker mounts a
// lightweight serverless variant; Node entries (dev.js/index.cjs) mount the
// full one. This keeps Node-only dependencies out of the Worker bundle.
export function mountUploads(router) {
  app.use('/api/uploads', router)
}

export default app
