import mongoose, { Schema, Document, Model } from "mongoose";

// Service Field Interface
export interface ServiceField {
  id: string;
  name: string;
  label: string;
  type: "text" | "number" | "select" | "file";
  required: boolean;
  options?: string[];
  description?: string;
  placeholder?: string;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    errorMessage?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

// Service Interface
export interface IService extends Document {
  name: string;
  description: string;
  price: number;
  instructions?: string;
  requiredFields: ServiceField[];
  isActive: boolean;
  category?: string;
  tags?: string[];
  deliveryTime?: string; // e.g., "24 hours", "3-5 days"
  featured: boolean;
  orderCount: number;
  revenue: number;
  createdAt: Date;
  updatedAt: Date;
}

// Service Schema
const ServiceFieldSchema = new Schema<ServiceField>({
  id: {
    type: String,
    required: true,
    default: () => `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: /^[a-z0-9_]+$/,
  },
  label: {
    type: String,
    required: true,
    trim: true,
  },
  type: {
    type: String,
    required: true,
    enum: ["text", "number", "select", "file"],
    default: "text",
  },
  required: {
    type: Boolean,
    required: true,
    default: true,
  },
  options: {
    type: [String],
    default: undefined,
  },
  description: {
    type: String,
    trim: true,
  },
  placeholder: {
    type: String,
    trim: true,
  },
  validation: {
    min: Number,
    max: Number,
    pattern: String,
    errorMessage: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

const ServiceSchema = new Schema<IService>(
  {
    name: {
      type: String,
      required: [true, "Service name is required"],
      trim: true,
      unique: true,
      index: true,
    },
    description: {
      type: String,
      required: [true, "Service description is required"],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, "Service price is required"],
      min: [1, "Price must be at least 1"],
      max: [1000000, "Price cannot exceed 1,000,000"],
    },
    instructions: {
      type: String,
      trim: true,
      default: "",
    },
    requiredFields: {
      type: [ServiceFieldSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    category: {
      type: String,
      trim: true,
      index: true,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    deliveryTime: {
      type: String,
      trim: true,
    },
    featured: {
      type: Boolean,
      default: false,
      index: true,
    },
    orderCount: {
      type: Number,
      required: true,
      default: 0,
    },
    revenue: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better query performance
ServiceSchema.index({ name: "text", description: "text" });
ServiceSchema.index({ price: 1 });
ServiceSchema.index({ isActive: 1, featured: 1 });
ServiceSchema.index({ createdAt: -1 });

// Virtual for average rating (if you add ratings later)
ServiceSchema.virtual("averageRating").get(function () {
  // You can implement rating logic here
  return 0;
});

// Pre-save middleware to sanitize fields
ServiceSchema.pre<IService>("save", async function (next) {
  // Ensure field names are unique within the service
  if (this.requiredFields && this.requiredFields.length > 0) {
    const fieldNames = this.requiredFields.map((f) => f.name);
    const uniqueNames = new Set(fieldNames);
    
    if (uniqueNames.size !== fieldNames.length) {
      throw new Error("Field names must be unique within a service");
    }
    await this.save();
  }
  
  // Update updatedAt for fields
  if (this.requiredFields && this.isModified("requiredFields")) {
    this.requiredFields.forEach((field) => {
      field.updatedAt = new Date();
    });
  }
});

// Static methods
ServiceSchema.statics.findActive = function () {
  return this.find({ isActive: true });
};

ServiceSchema.statics.findByCategory = function (category: string) {
  return this.find({ category, isActive: true });
};

ServiceSchema.statics.findFeatured = function () {
  return this.find({ featured: true, isActive: true });
};

// Instance methods
ServiceSchema.methods.incrementOrderCount = async function (amount: number) {
  this.orderCount += 1;
  this.revenue += amount;
  return this.save();
};

ServiceSchema.methods.toggleActive = async function () {
  this.isActive = !this.isActive;
  return this.save();
};

ServiceSchema.methods.addField = async function (fieldData: Partial<ServiceField>) {
  const newField: ServiceField = {
    id: `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: fieldData.name || "",
    label: fieldData.label || fieldData.name || "",
    type: fieldData.type || "text",
    required: fieldData.required !== undefined ? fieldData.required : true,
    options: fieldData.options || [],
    description: fieldData.description || "",
    placeholder: fieldData.placeholder || "",
    validation: fieldData.validation,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  this.requiredFields.push(newField);
  return this.save();
};

ServiceSchema.methods.removeField = async function (fieldId: string) {
  const index = this.requiredFields.findIndex((field: ServiceField) => field.id === fieldId);
  if (index !== -1) {
    this.requiredFields.splice(index, 1);
    return this.save();
  }
  throw new Error(`Field with id ${fieldId} not found`);
};

// Create and export the model
const Service: Model<IService> = mongoose.models.Service || mongoose.model<IService>("Service", ServiceSchema);

export default Service;