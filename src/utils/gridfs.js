import mongoose from 'mongoose'

export const VIDEO_BUCKET = 'episodeVideos'

export function getVideoBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: VIDEO_BUCKET })
}

export function streamUrl(fileId) {
  return `/api/public/stream/${fileId}`
}
