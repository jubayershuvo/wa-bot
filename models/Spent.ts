import mongoose, { Schema, Types } from "mongoose";

const spentSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true },
    service: {
      type: String, // Changed from ObjectId to String
      required: true,
    },
    data: { type: String },
    amount: { type: Number, required: true },
    dataSchema: { type: String },
  },
  { timestamps: true },
);

export default mongoose.models.Spent || mongoose.model("Spent", spentSchema);
