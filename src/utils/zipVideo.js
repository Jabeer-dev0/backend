import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'
import os from 'os'
import unzipper from 'unzipper'
import { VIDEO_EXTENSIONS, videoExtension, normalizeVideoMime } from './video.js'
import { makeStoredName, VIDEO_DIR, ensureVideoDir, useCloudStorage } from './videoStorage.js'

function safeEntryPath(entryPath = '') {
  const normalized = path.normalize(entryPath).replace(/^[/\\]+/, '')
  if (!normalized || normalized.includes('..')) return null
  return normalized
}

function isVideoEntryPath(entryPath = '') {
  const safe = safeEntryPath(entryPath)
  if (!safe) return false
  return VIDEO_EXTENSIONS.has(videoExtension(safe))
}

function pickBestVideoEntry(files = []) {
  const videoEntries = files.filter((f) => f.type !== 'Directory' && isVideoEntryPath(f.path))
  if (!videoEntries.length) return null

  videoEntries.sort((a, b) => {
    const aMp4 = videoExtension(a.path) === '.mp4' ? 1 : 0
    const bMp4 = videoExtension(b.path) === '.mp4' ? 1 : 0
    if (bMp4 !== aMp4) return bMp4 - aMp4
    return (b.vars?.uncompressedSize || 0) - (a.vars?.uncompressedSize || 0)
  })

  return videoEntries[0]
}

function getExtractDir() {
  if (useCloudStorage()) return os.tmpdir()
  ensureVideoDir()
  return VIDEO_DIR
}

export async function extractVideoFromZipToDisk(zipPath) {
  const destDir = getExtractDir()
  fs.mkdirSync(destDir, { recursive: true })

  const directory = await unzipper.Open.file(zipPath)
  const entry = pickBestVideoEntry(directory.files)

  if (!entry) {
    throw new Error('ZIP mein koi video file nahi mili. Andar mp4/mkv/webm wali video rakho.')
  }

  const safePath = safeEntryPath(entry.path)
  const originalName = path.basename(safePath)
  const storedName = makeStoredName(originalName)
  const destPath = path.join(destDir, storedName)
  const contentType = normalizeVideoMime({ originalname: originalName })

  await pipeline(entry.stream(), createWriteStream(destPath))

  const size = fs.statSync(destPath).size

  return {
    storedName,
    originalName,
    contentType,
    size,
    filePath: destPath,
  }
}
