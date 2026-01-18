import mongoose, { Schema, Document, Model, Types } from 'mongoose';

// Service Field Interface
export interface ServiceField {
  id: string;
  name: string;
  label: string;
  type: 'text' | 'file' | 'number' | 'select';
  required: boolean;
  description?: string;
  options?: string[];
  validation?: {
    min?: number;
    max?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Service Interface
export interface IService extends Document {
  _id: Types.ObjectId;
  name: string;
  description: string;
  price: number;
  instructions?: string;
  requiredFields: ServiceField[];
  isActive: boolean;
  orderCount: number;
  totalRevenue: number;
  createdAt: Date;
  updatedAt: Date;
}

// Service Field Schema
const serviceFieldSchema = new Schema<ServiceField>({
  id: {
    type: String,
    required: true,
    default: () => `field_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  },
  name: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: /^[a-z0-9_]+$/
  },
  label: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    enum: ['text', 'file', 'number', 'select'],
    default: 'text'
  },
  required: {
    type: Boolean,
    default: true
  },
  description: {
    type: String,
    default: ''
  },
  options: [{
    type: String,
    trim: true
  }],
  validation: {
    min: { type: Number },
    max: { type: Number }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Service Schema
const serviceSchema = new Schema<IService>({
  name: {
    type: String,
    required: [true, 'Service name is required'],
    trim: true,
    unique: true,
    maxlength: [100, 'Service name cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Service description is required'],
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  price: {
    type: Number,
    required: [true, 'Service price is required'],
    min: [0, 'Price cannot be negative'],
    max: [1000000, 'Price cannot exceed 1,000,000']
  },
  instructions: {
    type: String,
    default: '',
    maxlength: [1000, 'Instructions cannot exceed 1000 characters']
  },
  requiredFields: [serviceFieldSchema],
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  orderCount: {
    type: Number,
    default: 0
  },
  totalRevenue: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Type for Service model static methods
interface ServiceModel extends Model<IService> {
  updateStats(serviceId: Types.ObjectId | string, amount: number): Promise<void>;
}

// Update order count and revenue when orders are created/completed
serviceSchema.statics.updateStats = async function(serviceId: Types.ObjectId | string, amount: number): Promise<void> {
  try {
    await this.findByIdAndUpdate(serviceId, {
      $inc: {
        orderCount: 1,
        totalRevenue: amount
      }
    });
  } catch (error) {
    console.error('Error updating service stats:', error);
  }
};

// Indexes
serviceSchema.index({ name: 'text', description: 'text' });
serviceSchema.index({ isActive: 1, price: 1 });
serviceSchema.index({ createdAt: -1 });

// Middleware to update field timestamps
serviceSchema.pre('save', function(next) {
  if (this.isModified('requiredFields')) {
    this.requiredFields.forEach((field) => {
      field.updatedAt = new Date();
    });
  }
  this.save();
});

// Virtual for formatted price
serviceSchema.virtual('formattedPrice').get(function(this: IService) {
  return `৳${this.price}`;
});

// Export model
const Service = mongoose.models.Service as ServiceModel || mongoose.model<IService, ServiceModel>('Service', serviceSchema);

export default Service;