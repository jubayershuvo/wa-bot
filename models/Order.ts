import mongoose, { Document, HydratedDocument, Schema, Types } from "mongoose";

export interface IOrder extends Document {
  orderId: string;
  userId: Types.ObjectId;
  serviceId: Types.ObjectId;
  totalPrice: number;
  serviceData: Record<string, string>;
  serviceName?: string; // Virtual field for service name
  status:
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "refunded"
    | "cancelled";
  deliveryData?: {
    deliveredAt?: Date;
    deliveryMethod?: string;
    deliveryAddress?: string;
    text?: string;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
    deliveryType?: string; // "text", "file", or "both"
    deliveredBy?: string;
  };
  cancellationData?: {
    cancelledAt?: Date;
    reason?: string;
    cancelledBy?: string;
  };
  transactionId: Types.ObjectId;
  placedAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  failureReason?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      default: () =>
        `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
      index: true,
    },
    serviceName: {
      type: String,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    serviceId: {
      type: Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    serviceData: {
      type: Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
      default: "pending",
    },
    deliveryData: {
      deliveredAt: Date,
      deliveryMethod: String,
      text: String,
      fileUrl: String,
      fileName: String,
      fileType: String,
      deliveryType: String, // Add this field to store "text", "file", or "both"
      deliveredBy: String,
    },
    cancellationData: {
      cancelledAt: Date,
      reason: String,
      cancelledBy: String,
    },

    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },
    placedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    failureReason: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes for better query performance
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ serviceId: 1, status: 1 });
OrderSchema.index({ transactionId: 1 });
OrderSchema.index({ "serviceData._id": 1 });
OrderSchema.index({ status: 1, placedAt: 1 });

// Virtual for user details (if needed)
OrderSchema.virtual("user", {
  ref: "User",
  localField: "userId",
  foreignField: "_id",
  justOne: true,
});

// Virtual for service details
OrderSchema.virtual("service", {
  ref: "Service",
  localField: "serviceId",
  foreignField: "_id",
  justOne: true,
});

// Virtual for transaction details
OrderSchema.virtual("transaction", {
  ref: "Transaction",
  localField: "transactionId",
  foreignField: "_id",
  justOne: true,
});

// Pre-save hook to generate orderId if not provided
OrderSchema.pre("save", async function (this: HydratedDocument<IOrder>) {
  if (!this.orderId) {
    this.orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }
});

// Method to update order status with timestamp
OrderSchema.methods.updateStatus = async function (
  newStatus: IOrder["status"],
  notes?: string,
) {
  this.status = newStatus;
  const now = new Date();

  switch (newStatus) {
    case "processing":
      this.processedAt = now;
      break;
    case "completed":
      this.completedAt = now;
      break;
    case "failed":
    case "cancelled":
      if (notes) this.failureReason = notes;
      break;
  }

  if (notes && newStatus !== "failed" && newStatus !== "cancelled") {
    this.notes = notes;
  }

  return this.save();
};

const Order =
  mongoose.models.Order || mongoose.model<IOrder>("Order", OrderSchema);

export default Order;
