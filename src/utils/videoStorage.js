import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import dotenv from 'dotenv'
import VideoFile from '../models/VideoFile.js'
import { videoExtension } from './video.js'
import { isR2Configured, uploadFileToR2, getR2PublicUrl } from './r2Storage.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_ROOT = path.join(__dirname, '../..')

function isServerlessRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL_ENV)
}

function isWindowsAbsolutePath(value = '') {
  return /^[a-zA-Z]:[\\/]/.test(String(value).trim())
}

function resolveVideoDir() {
  const envPath = (process.env.VIDEO_STORAGE_PATH || '').trim()
  const serverless = isServerlessRuntime()

  if (envPath && !(serverless && isWindowsAbsolutePath(envPath))) {
    return envPath
  }

  if (serverless) {
    return path.join(os.tmpdir(), 'anikura-videos')
  }

  return path.join(SERVER_ROOT, 'data', 'videos')
}

export const VIDEO_DIR = resolveVideoDir()

export function ensureVideoDir() {
  try {
    fs.mkdirSync(VIDEO_DIR, { recursive: true })
    return true
  } catch (err) {
    console.warn(`Could not create video dir (${VIDEO_DIR}):`, err.message)
    return false
  }
}

export function makeStoredName(originalName = 'video.mp4') {
  const ext = videoExtension(originalName) || '.mp4'
  return `${randomUUID()}${ext}`
}

export function resolveVideoPath(diskPath = '') {
  if (!diskPath) return null
  if (path.isAbsolute(diskPath) && fs.existsSync(diskPath)) return diskPath
  const filename = path.basename(diskPath.replace(/\\/g, '/'))
  return path.join(VIDEO_DIR, filename)
}

export function storeDiskPath(filename) {
  return filename
}

export function streamUrl(fileId) {
  return `/api/public/stream/${fileId}`
}

export async function createLocalVideoRecord({ filename, originalName, mimeType, size, sourceZip = '' }) {
  const record = await VideoFile.create({
    storage: 'local',
    diskPath: storeDiskPath(filename),
    originalName,
    mimeType,
    size,
    sourceZip,
  })
  return record
}

export async function createR2VideoRecord({ r2Key, publicUrl, originalName, mimeType, size, sourceZip = '' }) {
  const record = await VideoFile.create({
    storage: 'r2',
    r2Key,
    publicUrl: publicUrl || getR2PublicUrl(r2Key) || '',
    originalName,
    mimeType,
    size,
    sourceZip,
  })
  return record
}

export async function saveVideoFile({ filePath, storedName, originalName, mimeType, size, sourceZip = '' }) {
  if (isR2Configured()) {
    const r2Key = `videos/${storedName}`
    const uploaded = await uploadFileToR2({ filePath, key: r2Key, contentType: mimeType })
    const record = await createR2VideoRecord({
      r2Key: uploaded.key,
      publicUrl: uploaded.publicUrl,
      originalName,
      mimeType,
      size: uploaded.size,
      sourceZip,
    })
    return { record, storage: 'r2' }
  }

  const record = await createLocalVideoRecord({
    filename: storedName,
    originalName,
    mimeType,
    size,
    sourceZip,
  })
  return { record, storage: 'local' }
}

export function useCloudStorage() {
  return isR2Configured()
}

export function pipeLocalVideo(res, absPath, fileSize, contentType, rangeHeader) {
  res.set('Content-Type', contentType)
  res.set('Accept-Ranges', 'bytes')

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1

    if (Number.isNaN(start) || start >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`)
      return res.end()
    }

    const chunkEnd = Math.min(end, fileSize - 1)
    res.status(206)
    res.set('Content-Range', `bytes ${start}-${chunkEnd}/${fileSize}`)
    res.set('Content-Length', String(chunkEnd - start + 1))
    fs.createReadStream(absPath, { start, end: chunkEnd }).pipe(res)
    return
  }

  res.set('Content-Length', String(fileSize))
  fs.createReadStream(absPath).pipe(res)
}
