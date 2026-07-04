import express from 'express'
import fs from 'fs'
import multer from 'multer'
import os from 'os'
import path from 'path'
import { requireEditor } from './adminAuth.js'
import { isAllowedVideoFile, isZipFile, normalizeVideoMime } from '../utils/video.js'
import { extractVideoFromZipToDisk } from '../utils/zipVideo.js'
import {
  VIDEO_DIR,
  ensureVideoDir,
  makeStoredName,
  saveVideoFile,
  streamUrl,
  useCloudStorage,
} from '../utils/videoStorage.js'

if (!useCloudStorage()) ensureVideoDir()

const router = express.Router()

function uploadDestination(_req, file, cb) {
  if (isZipFile(file) || useCloudStorage()) cb(null, os.tmpdir())
  else cb(null, VIDEO_DIR)
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDestination,
    filename: (_req, file, cb) => {
      if (isZipFile(file)) {
        cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]+/g, '_')}`)
      } else {
        cb(null, makeStoredName(file.originalname))
      }
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (isAllowedVideoFile(file)) cb(null, true)
    else cb(new Error('Sirf video ya ZIP file allowed hai (mp4, mkv, zip, etc.)'))
  },
})

function handleUpload(req, res, next) {
  upload.single('video')(req, res, (err) => {
    if (!err) return next()
    return res.status(400).json({ message: err.message || 'Upload failed' })
  })
}

function removeTempFile(filePath) {
  if (!filePath) return
  fs.unlink(filePath, () => {})
}

router.get('/storage-status', requireEditor, (_req, res) => {
  res.json({
    mode: useCloudStorage() ? 'cloudflare-r2' : 'local-disk',
    localPath: VIDEO_DIR,
    r2Bucket: process.env.R2_BUCKET_NAME || null,
    r2PublicUrl: process.env.R2_PUBLIC_URL || null,
  })
})

router.post('/video', requireEditor, handleUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No video file provided' })

  const tempPath = req.file.path
  let filePathToSave = tempPath

  try {
    let storedName
    let responseFilename
    let responseSize
    let contentType
    let sourceZip = ''

    if (isZipFile(req.file)) {
      const extracted = await extractVideoFromZipToDisk(tempPath)
      storedName = extracted.storedName
      contentType = extracted.contentType
      responseFilename = `${extracted.originalName} (from ${req.file.originalname})`
      responseSize = extracted.size
      sourceZip = req.file.originalname
      filePathToSave = extracted.filePath
    } else {
      storedName = path.basename(tempPath)
      contentType = normalizeVideoMime(req.file)
      responseFilename = req.file.originalname
      responseSize = req.file.size
    }

    const { record, storage } = await saveVideoFile({
      filePath: filePathToSave,
      storedName,
      originalName: responseFilename,
      mimeType: contentType,
      size: responseSize,
      sourceZip,
    })

    if (useCloudStorage()) {
      removeTempFile(filePathToSave)
    }

    res.status(201).json({
      videoId: record._id.toString(),
      url: record.publicUrl || streamUrl(record._id.toString()),
      filename: responseFilename,
      size: responseSize,
      mimeType: contentType,
      fromZip: Boolean(sourceZip),
      storage,
    })
  } catch (err) {
    if (useCloudStorage() && filePathToSave) removeTempFile(filePathToSave)
    else if (useCloudStorage() && !isZipFile(req.file) && tempPath) removeTempFile(tempPath)
    res.status(500).json({ message: err.message || 'Upload failed' })
  } finally {
    if (isZipFile(req.file)) removeTempFile(tempPath)
  }
})

export default router
