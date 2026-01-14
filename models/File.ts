import { Schema, model, models, Document, Types } from "mongoose";

export interface IFiles extends Document {
  _id: Types.ObjectId;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
}

const FileSchema = new Schema<IFiles>(
  {
    name: { type: String, required: true },
    path: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  {
    timestamps: true,
  }
);

// Fix for Next.js hot reload
const File = models.File || model<IFiles>("File", FileSchema);

export default File;