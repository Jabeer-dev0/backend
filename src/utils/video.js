import path from 'path'

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.ogv', '.mpeg', '.mpg', '.ts',
])

export const ZIP_EXTENSIONS = new Set(['.zip'])

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ts': 'video/mp2t',
}

export function videoExtension(filename = '') {
  return path.extname(filename).toLowerCase()
}

export function isZipFile(file = {}) {
  const ext = videoExtension(file.originalname || file.name || '')
  const mime = String(file.mimetype || file.type || '').toLowerCase()
  return ZIP_EXTENSIONS.has(ext) || mime === 'application/zip' || mime === 'application/x-zip-compressed'
}

export function isAllowedVideoFile(file = {}) {
  const ext = videoExtension(file.originalname || file.name || '')
  const mime = String(file.mimetype || file.type || '').toLowerCase()

  if (isZipFile(file)) return true
  if (VIDEO_EXTENSIONS.has(ext)) return true
  if (mime.startsWith('video/')) return true
  if ((mime === 'application/octet-stream' || mime === '') && ext) {
    return VIDEO_EXTENSIONS.has(ext) || ZIP_EXTENSIONS.has(ext)
  }

  return false
}

export function normalizeVideoMime(file = {}) {
  const mime = String(file.mimetype || file.type || '').toLowerCase()
  if (mime.startsWith('video/')) return mime

  const ext = videoExtension(file.originalname || file.name || '')
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}
