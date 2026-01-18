import mongoose, { Schema, Document, Model, Types } from "mongoose";

// Order Status Types
export type OrderStatus = 
  | "pending" 
  | "processing" 
  | "completed" 
  | "failed" 
  | "cancelled";

// Delivery Data Interface
export interface DeliveryData {
  deliveredAt?: Date;
  deliveryMethod?: string; // "whatsapp", "email", "direct"
  text?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  deliveryType?: string; // "text", "file", "both"
  deliveredBy?: string; // Admin phone number
}

// Cancellation Data Interface
export interface CancellationData {
  cancelledAt?: Date;
  reason?: string;
  cancelledBy?: string; // Admin phone number
}

// Order Interface
export interface IOrder extends Document {
  orderId: string; // Public order ID
  userId: Types.ObjectId;
  serviceId: Types.ObjectId;
  serviceName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  serviceData: Record<string, any>; // Data collected from service fields
  status: OrderStatus;
  deliveryData?: DeliveryData;
  cancellationData?: CancellationData;
  notes?: string;
  transactionId?: Types.ObjectId;
  
  // Admin fields
  assignedTo?: string; // Admin assigned to process order
  priority: "low" | "medium" | "high";
  
  // Timestamps
  placedAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Order Schema
const DeliveryDataSchema = new Schema<DeliveryData>({
  deliveredAt: Date,
  deliveryMethod: String,
  text: String,
  fileUrl: String,
  fileName: String,
  fileType: String,
  deliveryType: String,
  deliveredBy: String,
}, { _id: false });

const CancellationDataSchema = new Schema<CancellationData>({
  cancelledAt: Date,
  reason: String,
  cancelledBy: String,
}, { _id: false });

const OrderSchema = new Schema<IOrder>(
  {
    orderId: {
      type: String,
      required: [true, "Order ID is required"],
      unique: true,
      index: true,
      default: () => `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },
    serviceId: {
      type: Schema.Types.ObjectId,
      ref: "Service",
      required: [true, "Service ID is required"],
      index: true,
    },
    serviceName: {
      type: String,
      required: [true, "Service name is required"],
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: [1, "Quantity must be at least 1"],
    },
    unitPrice: {
      type: Number,
      required: [true, "Unit price is required"],
      min: [1, "Unit price must be at least 1"],
    },
    totalPrice: {
      type: Number,
      required: [true, "Total price is required"],
      min: [1, "Total price must be at least 1"],
    },
    serviceData: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    status: {
      type: String,
      required: true,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },
    deliveryData: DeliveryDataSchema,
    cancellationData: CancellationDataSchema,
    notes: {
      type: String,
      trim: true,
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      index: true,
    },
    
    // Admin fields
    assignedTo: {
      type: String,
      trim: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    
    // Timestamps
    placedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better query performance
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ serviceId: 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ "deliveryData.deliveredAt": -1 });
OrderSchema.index({ totalPrice: -1 });
OrderSchema.index({ priority: 1, createdAt: -1 });

// Virtual fields
OrderSchema.virtual("user", {
  ref: "User",
  localField: "userId",
  foreignField: "_id",
  justOne: true,
});

OrderSchema.virtual("service", {
  ref: "Service",
  localField: "serviceId",
  foreignField: "_id",
  justOne: true,
});

OrderSchema.virtual("transaction", {
  ref: "Transaction",
  localField: "transactionId",
  foreignField: "_id",
  justOne: true,
});

// Calculate duration in hours
OrderSchema.virtual("durationHours").get(function () {
  if (this.completedAt && this.placedAt) {
    const diffMs = this.completedAt.getTime() - this.placedAt.getTime();
    return Math.round(diffMs / (1000 * 60 * 60));
  }
  return null;
});

// Check if order is active
OrderSchema.virtual("isActive").get(function () {
  return ["pending", "processing"].includes(this.status);
});

// Pre-save middleware
OrderSchema.pre("save", function (next) {
  // Auto-calculate total price if not set
  if (!this.totalPrice) {
    this.totalPrice = this.unitPrice * this.quantity;
  }
  
  // Update timestamps based on status
  const now = new Date();
  
  if (this.isModified("status")) {
    switch (this.status) {
      case "processing":
        if (!this.processedAt) {
          this.processedAt = now;
        }
        break;
      case "completed":
        if (!this.completedAt) {
          this.completedAt = now;
        }
        break;
      case "failed":
      case "cancelled":
        if (!this.cancellationData?.cancelledAt) {
          this.cancellationData = {
            ...this.cancellationData,
            cancelledAt: now,
          };
        }
        break;
    }
  }
  
  // Set delivery timestamp if delivery data is added
  if (this.deliveryData && !this.deliveryData.deliveredAt) {
    this.deliveryData.deliveredAt = now;
  }
  
  this.save();
});

// Static methods
OrderSchema.statics.findByUserId = function (userId: string | Types.ObjectId) {
  return this.find({ userId }).sort({ createdAt: -1 });
};

OrderSchema.statics.findByServiceId = function (serviceId: string | Types.ObjectId) {
  return this.find({ serviceId }).sort({ createdAt: -1 });
};

OrderSchema.statics.findActiveOrders = function () {
  return this.find({ status: { $in: ["pending", "processing"] } });
};

OrderSchema.statics.findCompletedOrders = function () {
  return this.find({ status: "completed" });
};

OrderSchema.statics.findByStatus = function (status: OrderStatus | OrderStatus[]) {
  const statuses = Array.isArray(status) ? status : [status];
  return this.find({ status: { $in: statuses } });
};

OrderSchema.statics.getRevenueStats = async function (
  startDate?: Date,
  endDate?: Date
) {
  const match: any = { status: "completed" };
  
  if (startDate || endDate) {
    match.placedAt = {};
    if (startDate) match.placedAt.$gte = startDate;
    if (endDate) match.placedAt.$lte = endDate;
  }
  
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: "$totalPrice" },
        averageOrderValue: { $avg: "$totalPrice" },
      },
    },
  ]);
};

// Instance methods
OrderSchema.methods.markAsProcessing = async function (assignedTo?: string) {
  this.status = "processing";
  this.processedAt = new Date();
  if (assignedTo) {
    this.assignedTo = assignedTo;
  }
  return this.save();
};

OrderSchema.methods.markAsCompleted = async function (deliveryData?: DeliveryData) {
  this.status = "completed";
  this.completedAt = new Date();
  if (deliveryData) {
    this.deliveryData = deliveryData;
  }
  return this.save();
};

OrderSchema.methods.markAsFailed = async function (reason?: string, cancelledBy?: string) {
  this.status = "failed";
  this.cancellationData = {
    cancelledAt: new Date(),
    reason: reason || "Unknown reason",
    cancelledBy: cancelledBy,
  };
  return this.save();
};

OrderSchema.methods.markAsCancelled = async function (reason?: string, cancelledBy?: string) {
  this.status = "cancelled";
  this.cancellationData = {
    cancelledAt: new Date(),
    reason: reason || "Cancelled by user",
    cancelledBy: cancelledBy,
  };
  return this.save();
};

OrderSchema.methods.updateDelivery = async function (deliveryData: DeliveryData) {
  this.deliveryData = {
    ...this.deliveryData,
    ...deliveryData,
    deliveredAt: new Date(),
  };
  return this.save();
};

OrderSchema.methods.addNote = async function (note: string) {
  this.notes = this.notes ? `${this.notes}\n${note}` : note;
  return this.save();
};

// Create and export the model
const Order: Model<IOrder> = mongoose.models.Order || mongoose.model<IOrder>("Order", OrderSchema);

export default Order;