import mongoose, { Document, Schema, Types } from "mongoose";

export interface ServiceField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "file";
  options?: string[];
  required: boolean;
}

export interface IService extends Document {
  _id: Types.ObjectId;
  name: string;
  description: string;
  price: number;
  requiredFields?: ServiceField[];
  isActive: boolean;
  orderNote?: string;
  instructions?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceFieldSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["text", "number", "select", "file"],
      default: "text",
    },
    options: {
      type: [String],
      default: undefined,
    },
    required: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const ServiceSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    requiredFields: {
      type: [ServiceFieldSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    instructions: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better query performance
ServiceSchema.index({ category: 1, isActive: 1, isAvailable: 1 });
ServiceSchema.index({ price: 1 });
ServiceSchema.index({ createdAt: -1 });

// Virtual for formatted service display
ServiceSchema.virtual("displayName").get(function (this: IService) {
  return `${this.name} - ${this.price} BDT`;
});

const Service =
  mongoose.models.Service || mongoose.model<IService>("Service", ServiceSchema);

export default Service;