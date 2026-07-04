import mongoose from 'mongoose'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import VideoFile from '../src/models/VideoFile.js'
import { VIDEO_DIR, resolveVideoPath } from '../src/utils/videoStorage.js'
import { isR2Configured, uploadFileToR2, testR2Connection } from '../src/utils/r2Storage.js'

dotenv.config()

if (!isR2Configured()) {
  console.error('R2 not configured. Add R2_* keys to server/.env first.')
  process.exit(1)
}

await mongoose.connect(process.env.MONGODB_URI)
console.log('Testing R2 connection...')
await testR2Connection()
console.log('R2 OK\n')

const localFiles = fs.existsSync(VIDEO_DIR)
  ? fs.readdirSync(VIDEO_DIR).filter((f) => !f.startsWith('.'))
  : []

const dbFiles = await VideoFile.find({ storage: 'local' }).lean()
console.log(`Local disk files: ${localFiles.length}`)
console.log(`DB local records: ${dbFiles.length}\n`)

for (const record of dbFiles) {
  const absPath = resolveVideoPath(record.diskPath)
  if (!absPath || !fs.existsSync(absPath)) {
    console.warn('SKIP missing file:', record.diskPath)
    continue
  }

  const filename = path.basename(record.diskPath)
  const r2Key = `videos/${filename}`

  console.log(`Uploading ${filename} (${(record.size / 1024 / 1024).toFixed(1)} MB)...`)
  const uploaded = await uploadFileToR2({
    filePath: absPath,
    key: r2Key,
    contentType: record.mimeType || 'video/mp4',
  })

  await VideoFile.findByIdAndUpdate(record._id, {
    $set: {
      storage: 'r2',
      r2Key: uploaded.key,
      publicUrl: uploaded.publicUrl || '',
      diskPath: '',
    },
  })

  console.log('  ✓ R2:', uploaded.publicUrl || uploaded.key)
}

console.log('\nDone! Videos ab Cloudflare R2 par hain.')
await mongoose.disconnect()
