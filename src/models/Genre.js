import mongoose from 'mongoose'

const GenreSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    slug: { type: String, default: '' },
    description: { type: String, default: '' },
  },
  { timestamps: true },
)

export default mongoose.model('Genre', GenreSchema)
