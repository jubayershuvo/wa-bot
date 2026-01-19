import mongoose, { Schema, Document, Model, Types } from 'mongoose';

// File Information Interface
export interface FileInfo {
  fileName: string;
  filePath: string;
  fileType: string;
  fileSize: string;
  uploadedAt: Date;
}

// Service Data Field Interface
export interface ServiceDataField {
  field: string;
  label: string;
  type: 'text' | 'file';
  data: string | FileInfo;
  createdAt: Date;
}

// Delivery Data Interface
export interface DeliveryData {
  deliveredAt: Date;
  deliveryMethod: 'whatsapp' | 'email' | 'download';
  deliveryType: 'text' | 'file' | 'both';
  text?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  deliveredBy?: string;
}

// Cancellation Data Interface
export interface CancellationData {
  cancelledAt: Date;
  reason: string;
  cancelledBy: string;
}

// Order Interface
export interface IOrder extends Document {
  _id: Types.ObjectId;
  orderId: string;
  userId: Types.ObjectId;
  serviceId: Types.ObjectId;
  serviceName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  serviceData: ServiceDataField[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  transactionId?: Types.ObjectId;
  deliveryData?: DeliveryData;
  cancellationData?: CancellationData;
  notes?: string;
  adminNotes?: string;
  placedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// File Info Schema
const fileInfoSchema = new Schema<FileInfo>({
  fileName: { type: String, required: true },
  filePath: { type: String, required: true },
  fileType: { type: String, required: true },
  fileSize: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now }
});

// Service Data Field Schema
const serviceDataFieldSchema = new Schema<ServiceDataField>({
  field: { type: String, required: true },
  label: { type: String, required: true },
  type: { 
    type: String, 
    required: true, 
    enum: ['text', 'file'] 
  },
  data: { 
    type: Schema.Types.Mixed, 
    required: true,
    validate: {
      validator: function(value: any): boolean {
        if ((this as any).type === 'file') {
          return value && typeof value === 'object' && value.fileName && value.filePath;
        }
        return typeof value === 'string';
      },
      message: 'Invalid data format for field type'
    }
  },
  createdAt: { type: Date, default: Date.now }
});

// Delivery Data Schema
const deliveryDataSchema = new Schema<DeliveryData>({
  deliveredAt: { type: Date, default: Date.now },
  deliveryMethod: { 
    type: String, 
    enum: ['whatsapp', 'email', 'download'],
    default: 'whatsapp' 
  },
  deliveryType: { 
    type: String, 
    required: true,
    enum: ['text', 'file', 'both'] 
  },
  text: String,
  fileUrl: String, // full filepath
  fileName: String,
  fileType: String,
  deliveredBy: String
});

// Cancellation Data Schema
const cancellationDataSchema = new Schema<CancellationData>({
  cancelledAt: { type: Date, default: Date.now },
  reason: { type: String, required: true },
  cancelledBy: { type: String, required: true }
});

// Order Schema
const orderSchema = new Schema<IOrder>({
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  serviceId: {
    type: Schema.Types.ObjectId,
    ref: 'Service',
    required: true,
    index: true
  },
  serviceName: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    default: 1,
    min: 1
  },
  unitPrice: {
    type: Number,
    required: true,
    min: 0
  },
  totalPrice: {
    type: Number,
    required: true,
    min: 0
  },
  serviceData: [serviceDataFieldSchema],
  status: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  transactionId: {
    type: Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  deliveryData: deliveryDataSchema,
  cancellationData: cancellationDataSchema,
  notes: {
    type: String,
    maxlength: 500
  },
  adminNotes: {
    type: String,
    maxlength: 1000
  },
  placedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date
}, {
  timestamps: true
});

// Type for Order model static methods
interface OrderModel extends Model<IOrder> {
  findByOrderId(orderId: string): Promise<IOrder | null>;
  findByUserId(userId: Types.ObjectId | string, limit?: number): Promise<IOrder[]>;
  findPendingOrders(limit?: number): Promise<IOrder[]>;
}

// Static methods
orderSchema.statics.findByOrderId = async function(orderId: string): Promise<IOrder | null> {
  return this.findOne({ orderId })
    .populate('userId', 'name whatsapp')
    .populate('serviceId', 'name description price');
};

orderSchema.statics.findByUserId = async function(userId: Types.ObjectId | string, limit: number = 10): Promise<IOrder[]> {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('serviceId', 'name description price');
};

orderSchema.statics.findPendingOrders = async function(limit: number = 20): Promise<IOrder[]> {
  return this.find({ 
    status: { $in: ['pending', 'processing'] } 
  })
  .sort({ createdAt: 1 })
  .limit(limit)
  .populate('userId', 'name whatsapp');
};

// Instance methods
orderSchema.methods.getFormattedOrderInfo = function(): {
  orderId: string;
  serviceName: string;
  totalPrice: string;
  status: string;
  placedAt: string;
  hasFiles: boolean;
} {
  return {
    orderId: this.orderId,
    serviceName: this.serviceName,
    totalPrice: `৳${this.totalPrice}`,
    status: this.getStatusDisplay(),
    placedAt: this.placedAt.toLocaleDateString(),
    hasFiles: this.getFileFields().length > 0
  };
};

orderSchema.methods.getFileFields = function(): ServiceDataField[] {
  return this.serviceData.filter((data: ServiceDataField) => data.type === 'file');
};

orderSchema.methods.getTextFields = function(): ServiceDataField[] {
  return this.serviceData.filter((data: ServiceDataField) => data.type === 'text');
};

orderSchema.methods.getStatusDisplay = function(): string {
  const statusMap = {
    pending: '⏳ Pending',
    processing: '🔄 Processing',
    completed: '✅ Completed',
    failed: '❌ Failed',
    cancelled: '🚫 Cancelled'
  };
  return statusMap[this.status as keyof typeof statusMap] || '📝 Unknown';
};

// Generate order ID before saving
orderSchema.pre('save', function(next) {
  if (!this.orderId) {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    this.orderId = `ORD-${timestamp}-${random}`;
  }
  
  if (this.status === 'completed' && !this.completedAt) {
    this.completedAt = new Date();
  }
  
  this.save();
});

// Update service stats when order is completed
orderSchema.post('save', async function(doc: IOrder) {
  try {
    if (doc.status === 'completed') {
      const Service = mongoose.model('Service');
      await (Service as any).updateStats(doc.serviceId, doc.totalPrice);
    }
  } catch (error) {
    console.error('Error updating service stats:', error);
  }
});

// Indexes
orderSchema.index({ userId: 1, status: 1 });
orderSchema.index({ serviceId: 1, status: 1 });
orderSchema.index({ status: 1, createdAt: 1 });
orderSchema.index({ placedAt: -1 });
orderSchema.index({ totalPrice: 1 });

// Export model
const Order = mongoose.models.Order as OrderModel || mongoose.model<IOrder, OrderModel>('Order', orderSchema);

export default Order;