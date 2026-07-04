import mongoose from 'mongoose'

const VideoFileSchema = new mongoose.Schema(
  {
    storage: { type: String, enum: ['local', 'gridfs', 'r2'], default: 'local' },
    diskPath: { type: String, default: '' },
    r2Key: { type: String, default: '' },
    publicUrl: { type: String, default: '' },
    gridfsId: { type: mongoose.Schema.Types.ObjectId, default: null },
    originalName: { type: String, default: '' },
    mimeType: { type: String, default: 'video/mp4' },
    size: { type: Number, default: 0 },
    sourceZip: { type: String, default: '' },
  },
  { timestamps: true },
)

export default mongoose.model('VideoFile', VideoFileSchema)
