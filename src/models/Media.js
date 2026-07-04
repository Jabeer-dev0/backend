import mongoose from 'mongoose'

const MediaSchema = new mongoose.Schema(
  {
    filename: { type: String, default: '' },
    url: { type: String, required: true },
    type: { type: String, enum: ['poster', 'banner', 'logo', 'gallery', 'thumbnail', 'other'], default: 'other' },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export default mongoose.model('Media', MediaSchema)
