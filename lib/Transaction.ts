import mongoose, { Document, Schema, ObjectId, Types } from "mongoose";

export interface ITransaction extends Document {
  trxId: string;
  amount: number;
  method: string;
  status: string;
  number?: string;
  user: ObjectId;
  createdAt: Date;
}

const trxSchema = new Schema<ITransaction>({
  trxId: { type: String, required: true },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  status: { type: String, default:"SUCCESS" },
  number: { type: String },
  user: { type: Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.Transaction ||
  mongoose.model("Transaction", trxSchema);
