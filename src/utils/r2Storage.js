import fs from 'fs'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

export function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME,
  )
}

function getR2Client() {
  if (!isR2Configured()) {
    throw new Error('Cloudflare R2 is not configured. Add R2_* keys to server/.env')
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
}

export function getR2PublicUrl(key) {
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  if (!base || !key) return null
  return `${base}/${key}`
}

export async function uploadFileToR2({ filePath, key, contentType }) {
  const client = getR2Client()
  const stat = fs.statSync(filePath)

  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: contentType || 'video/mp4',
    ContentLength: stat.size,
  }))

  return {
    key,
    size: stat.size,
    publicUrl: getR2PublicUrl(key),
  }
}

export async function streamFromR2(res, key, contentType, rangeHeader) {
  const client = getR2Client()
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Range: rangeHeader || undefined,
  })

  const obj = await client.send(command)
  const body = obj.Body

  res.set('Content-Type', contentType || obj.ContentType || 'video/mp4')
  res.set('Accept-Ranges', 'bytes')
  if (obj.ContentLength) res.set('Content-Length', String(obj.ContentLength))
  if (obj.ContentRange) {
    res.status(206)
    res.set('Content-Range', obj.ContentRange)
  }

  if (body && typeof body.pipe === 'function') {
    body.pipe(res)
    return
  }

  res.status(500).json({ message: 'R2 stream failed' })
}

export async function testR2Connection() {
  const client = getR2Client()
  const { HeadBucketCommand } = await import('@aws-sdk/client-s3')
  await client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME }))
  return true
}
