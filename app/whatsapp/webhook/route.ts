import { NextRequest, NextResponse } from "next/server";
import User, { IUser } from "@/models/User";
import Service, { IService, ServiceField } from "@/models/Service";
import Order, { ServiceDataField } from "@/models/Order";
import Transaction from "@/models/Transaction";
import stateManager from "@/lib/whatsappState";
import { sessionMonitor } from "@/lib/sessionMonitor";
import { connectDB } from "@/lib/mongodb-bot";
import axios from "axios";
import Spent from "@/models/Spent";
import path from "path";
import fs from "fs";

// --- Enhanced Logging Configuration ---
const LOG_CONFIG = {
  debug: process.env.NODE_ENV === "development",
  logLevel: process.env.LOG_LEVEL || "INFO",
  maxLogSize: 10000, // Max characters per log entry
};

class EnhancedLogger {
  private static truncateData(data: any): any {
    if (typeof data === "string" && data.length > LOG_CONFIG.maxLogSize) {
      return data.substring(0, LOG_CONFIG.maxLogSize) + "... [TRUNCATED]";
    }
    if (typeof data === "object" && data !== null) {
      const str = JSON.stringify(data);
      if (str.length > LOG_CONFIG.maxLogSize) {
        return {
          _truncated: true,
          message: "Data too large, truncated for logging",
          originalLength: str.length,
        };
      }
    }
    return data;
  }

  private static getTimestamp(): string {
    return new Date().toISOString();
  }

  private static formatMessage(
    level: string,
    message: string,
    data?: unknown,
  ): string {
    const timestamp = this.getTimestamp();
    const formattedMessage = `[${timestamp}] [${level}] [WHATSAPP-WEBHOOK] ${message}`;

    if (data) {
      try {
        const truncatedData = this.truncateData(data);
        const dataStr =
          typeof truncatedData === "string"
            ? truncatedData
            : JSON.stringify(truncatedData, null, 2);
        return `${formattedMessage}\n${dataStr}`;
      } catch {
        return `${formattedMessage}\n[Non-serializable data]`;
      }
    }

    return formattedMessage;
  }

  static debug(message: string, data?: unknown) {
    if (LOG_CONFIG.debug) {
      console.debug(this.formatMessage("DEBUG", message, data));
    }
  }

  static info(message: string, data?: unknown) {
    console.info(this.formatMessage("INFO", message, data));
  }

  static warn(message: string, data?: unknown) {
    console.warn(this.formatMessage("WARN", message, data));
  }

  static error(message: string, data?: unknown) {
    console.error(this.formatMessage("ERROR", message, data));
  }

  static logRequest(
    phone: string,
    message: WhatsAppMessage,
    requestId: string,
  ) {
    this.info(`[${requestId}] Message received from ${phone}`, {
      type: message.type,
      messageId: message.id,
      text: message.text?.body?.substring(0, 100),
      interactiveType: message.interactive?.type,
      timestamp: message.timestamp,
    });
  }

  static logResponse(phone: string, response: any, requestId: string) {
    this.debug(`[${requestId}] Response sent to ${phone}`, {
      messageId: response?.messages?.[0]?.id,
      success: true,
      timestamp: new Date().toISOString(),
    });
  }

  static logStateChange(
    phone: string,
    oldState: string,
    newState: string,
    data?: any,
  ) {
    this.debug(`State change for ${phone}`, {
      oldState,
      newState,
      data: this.truncateData(data),
    });
  }

  static logFlowCompletion(phone: string, flowType: string, result: any) {
    this.info(`Flow completed for ${phone}`, {
      flowType,
      result: this.truncateData(result),
      timestamp: new Date().toISOString(),
    });
  }
}

// --- Configuration ---
const CONFIG = {
  accessToken: process.env.WA_ACCESS_TOKEN || "",
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID || "",
  verifyToken: process.env.WA_VERIFY_TOKEN || "",
  apiVersion: process.env.WA_API_VERSION || "v22.0",
  baseUrl: process.env.WA_API_BASE_URL || "https://graph.facebook.com",
  adminId: process.env.ADMIN_WA_ID || "",
  bkashNumber: process.env.BKASH_NUMBER || "017XXXXXXXX",
  supportNumber: process.env.SUPPORT_NUMBER || "+8801XXXXXXXXX",
  supportTelegram: process.env.SUPPORT_TELEGRAM || "t.me/birthhelp",
  ubrnApiUrl: process.env.UBRN_API_URL || "https://17.fortest.top/api/search",
  ubrnServicePrice: 10,
  fileUploadUrl: process.env.FILE_UPLOYAD_URL || "/api/upload",
  maxFileSize: 10 * 1024 * 1024,
  maxBroadcastUsers: 100, // Limit broadcast to prevent rate limiting
  sessionTimeout: 30 * 60 * 1000, // 30 minutes session timeout
  retryAttempts: 3,
  retryDelay: 1000,
};

// --- Instant Services Configuration ---
const INSTANT_SERVICES = [
  {
    id: "instant_ubrn_verification",
    name: "🔍 DOB Search",
    description: "UBRN নাম্বার দিয়ে তথ্য যাচাই করুন",
    price: 10,
    isActive: true,
    requiresInput: true,
    inputPrompt: "UBRN নম্বরটি পাঠান:",
    inputExample: "19862692537094068",
  },
];

// --- Rate Limiter ---
class RateLimiter {
  private requests: Map<string, { count: number; resetTime: number }> =
    new Map();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number = 5, windowMs: number = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  isAllowed(phone: string): boolean {
    const now = Date.now();
    const userRequests = this.requests.get(phone);

    if (!userRequests) {
      this.requests.set(phone, { count: 1, resetTime: now + this.windowMs });
      return true;
    }

    if (now > userRequests.resetTime) {
      userRequests.count = 1;
      userRequests.resetTime = now + this.windowMs;
      return true;
    }

    if (userRequests.count >= this.limit) {
      return false;
    }

    userRequests.count++;
    return true;
  }

  getRemaining(phone: string): number {
    const userRequests = this.requests.get(phone);
    if (!userRequests) return this.limit;
    return Math.max(0, this.limit - userRequests.count);
  }

  getResetTime(phone: string): number {
    const userRequests = this.requests.get(phone);
    return userRequests?.resetTime || Date.now() + this.windowMs;
  }

  clearExpired(): void {
    const now = Date.now();
    for (const [phone, data] of this.requests.entries()) {
      if (now > data.resetTime) {
        this.requests.delete(phone);
      }
    }
  }
}

const rateLimiter = new RateLimiter(10, 10000); // 10 requests per second

// --- TypeScript Interfaces ---
interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    list_reply?: { id: string; title: string };
    button_reply?: { id: string; title: string };
  };
  image?: {
    id: string;
    caption?: string;
  };
  document?: {
    id: string;
    filename: string;
    caption?: string;
  };
}

interface WebhookBody {
  object: string;
  entry: Array<{
    id: string;
    time: number;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: WhatsAppMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

// --- State Data Interfaces ---
interface RechargeStateData {
  trxId?: string;
  amount?: number;
  attempts: number;
}

interface ServiceOrderStateData {
  serviceId?: string;
  price?: number;
  serviceName?: string;
  fieldIndex?: number;
  collectedData?: Record<string, any>;
  attempts: number;
}

interface UbrnStateData {
  ubrn?: string;
  attempt?: number;
}

interface AdminAddServiceStateData {
  step?: number;
  serviceData?: {
    name?: string;
    description?: string;
    price?: number;
    instructions?: string;
    requiredFields?: ServiceField[];
    isActive?: boolean;
  };
  currentField?: Partial<ServiceField>;
  fieldStep?: number;
}

interface AdminEditServiceStateData {
  serviceId?: string;
  serviceData?: Partial<IService>;
  editOption?: string;
  step?: number;
}

interface AdminDeleteServiceStateData {
  serviceId?: string;
  serviceName?: string;
}

interface AdminToggleServiceStateData {
  serviceId?: string;
  serviceName?: string;
}

interface AdminProcessOrderStateData {
  orderId?: string;
  order?: any;
  step?: number;
  deliveryType?: string;
  deliveryData?: {
    text?: string;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
    reason?: string;
  };
}

interface AdminAddBalanceStateData {
  phone?: string;
  amount?: number;
  reason?: string;
  step?: number;
}

interface AdminBanUserStateData {
  phone?: string;
  userId?: string;
  reason?: string;
  step?: number;
}

interface AdminBroadcastStateData {
  message?: string;
  userType?: string;
  step?: number;
}

interface AdminFileDeliveryStateData {
  orderId?: string;
  step?: number;
  fileType?: string;
}

interface UserStateData {
  recharge?: RechargeStateData;
  serviceOrder?: ServiceOrderStateData;
  ubrn?: UbrnStateData;
  adminAddService?: AdminAddServiceStateData;
  adminEditService?: AdminEditServiceStateData;
  adminDeleteService?: AdminDeleteServiceStateData;
  adminToggleService?: AdminToggleServiceStateData;
  adminProcessOrder?: AdminProcessOrderStateData;
  adminAddBalance?: AdminAddBalanceStateData;
  adminBanUser?: AdminBanUserStateData;
  adminBroadcast?: AdminBroadcastStateData;
  adminFileDelivery?: AdminFileDeliveryStateData;
  lastActivity: number;
  sessionId: string;
}

// --- WhatsApp API Helper Functions ---
function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, "");

  if (cleaned.startsWith("880")) {
    return cleaned;
  }

  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return "880" + cleaned.substring(1);
  }

  if (!cleaned.startsWith("880") && cleaned.length === 10) {
    return "880" + cleaned;
  }

  if (cleaned.startsWith("91")) {
    return cleaned;
  }

  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return "91" + cleaned.substring(1);
  }

  if (!cleaned.startsWith("91") && cleaned.length === 10) {
    return "91" + cleaned;
  }

  return cleaned;
}

async function callWhatsAppApi(
  endpoint: string,
  payload: object,
  retries: number = CONFIG.retryAttempts,
): Promise<any> {
  const url = `${CONFIG.baseUrl}/${CONFIG.apiVersion}/${CONFIG.phoneNumberId}/${endpoint}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      EnhancedLogger.debug(
        `Calling WhatsApp API (attempt ${attempt}/${retries}): ${endpoint}`,
        {
          url,
          payloadSize: JSON.stringify(payload).length,
        },
      );

      const startTime = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "Birthhelp-Bot/1.0",
        },
        body: JSON.stringify(payload),
      });

      const responseTime = Date.now() - startTime;
      const result = await response.json();

      if (!response.ok) {
        EnhancedLogger.error(
          `WhatsApp API error for ${endpoint} (attempt ${attempt})`,
          {
            status: response.status,
            statusText: response.statusText,
            error: result,
            responseTime: `${responseTime}ms`,
          },
        );

        if (
          attempt < retries &&
          (response.status === 429 || response.status >= 500)
        ) {
          const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
          EnhancedLogger.debug(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw new Error(
          `WhatsApp API error: ${response.status} ${response.statusText} - ${JSON.stringify(result)}`,
        );
      }

      EnhancedLogger.debug(`WhatsApp API success for ${endpoint}`, {
        messageId: result?.messages?.[0]?.id,
        responseTime: `${responseTime}ms`,
      });

      return result;
    } catch (apiError) {
      EnhancedLogger.error(
        `Network error calling ${endpoint} (attempt ${attempt}):`,
        apiError,
      );

      if (attempt < retries) {
        const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw apiError;
    }
  }
}

async function sendTextMessage(to: string, text: string): Promise<any> {
  const formattedTo = formatPhoneNumber(to);
  EnhancedLogger.info(`Sending text message to ${formattedTo}`, {
    textLength: text.length,
    textPreview: text.substring(0, 100),
  });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "text",
    text: {
      preview_url: text.includes("http") ? true : false,
      body: text,
    },
  };

  try {
    const result = await callWhatsAppApi("messages", payload);
    EnhancedLogger.debug(`Text message sent to ${formattedTo}`, {
      messageId: result?.messages?.[0]?.id,
    });
    return result;
  } catch (err) {
    EnhancedLogger.error(`Failed to send text message to ${formattedTo}:`, err);
    throw err;
  }
}

async function sendButtonMenu(
  to: string,
  headerText: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<any> {
  const formattedTo = formatPhoneNumber(to);
  EnhancedLogger.info(`Sending button menu to ${formattedTo}`, {
    header: headerText,
    buttons: buttons.length,
  });

  const validatedButtons = buttons.slice(0, 3).map((b) => ({
    type: "reply" as const,
    reply: {
      id: b.id.substring(0, 256),
      title: b.title.substring(0, 20),
    },
  }));

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "interactive",
    interactive: {
      type: "button",
      header: {
        type: "text",
        text: headerText.substring(0, 60),
      },
      body: {
        text: bodyText.substring(0, 1024),
      },
      action: {
        buttons: validatedButtons,
      },
    },
  };

  try {
    const result = await callWhatsAppApi("messages", payload);
    EnhancedLogger.debug(`Button menu sent to ${formattedTo}`, {
      messageId: result?.messages?.[0]?.id,
    });
    return result;
  } catch (err) {
    EnhancedLogger.error(`Failed to send button menu to ${formattedTo}:`, err);
    throw err;
  }
}

async function sendTextWithCancelButton(
  to: string,
  text: string,
  customCancelText?: string,
): Promise<void> {
  const formattedTo = formatPhoneNumber(to);
  EnhancedLogger.info(`Sending text with cancel button to ${formattedTo}`);

  try {
    await sendButtonMenu(formattedTo, "Action Required", text, [
      { id: "cancel_flow", title: customCancelText || "❌ বাতিল করুন" },
    ]);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to send text with cancel button to ${formattedTo}:`,
      err,
    );
    await sendTextMessage(
      formattedTo,
      `${text}\n\n🚫 বাতিল করতে 'cancel' লিখুন।`,
    );
  }
}

async function sendListMenu(
  to: string,
  header: string,
  body: string,
  rows: Array<{ id: string; title: string; description?: string }>,
  sectionTitle: string,
  buttonText: string = "অপশন দেখুন",
): Promise<any> {
  const formattedTo = formatPhoneNumber(to);
  EnhancedLogger.info(`Sending list menu to ${formattedTo}`, {
    header,
    rows: rows.length,
  });

  const validatedRows = rows.slice(0, 10).map((row) => ({
    id: row.id.substring(0, 200),
    title: row.title.substring(0, 24),
    description: (row.description || "").substring(0, 72),
  }));

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: header.substring(0, 60),
      },
      body: {
        text: body.substring(0, 1024),
      },
      footer: {
        text: "Powered by Birth Help",
      },
      action: {
        button: buttonText.substring(0, 20),
        sections: [
          {
            title: sectionTitle.substring(0, 24),
            rows: validatedRows,
          },
        ],
      },
    },
  };

  try {
    const result = await callWhatsAppApi("messages", payload);
    EnhancedLogger.debug(`List menu sent to ${formattedTo}`, {
      messageId: result?.messages?.[0]?.id,
    });
    return result;
  } catch (err) {
    EnhancedLogger.error(`Failed to send list menu to ${formattedTo}:`, err);
    let textMenu = `${header}\n\n${body}\n\n`;
    rows.forEach((row, index) => {
      textMenu += `${index + 1}. ${row.title}\n`;
    });
    textMenu += `\nএকটি অপশন সিলেক্ট করতে সংখ্যা লিখুন (1-${rows.length})\n🚫 বাতিল করতে 'cancel' লিখুন`;
    await sendTextMessage(formattedTo, textMenu);
    throw err;
  }
}

async function sendQuickReplyMenu(
  to: string,
  text: string,
  replies: Array<{ id: string; title: string }>,
): Promise<any> {
  const formattedTo = formatPhoneNumber(to);
  EnhancedLogger.info(`Sending quick reply menu to ${formattedTo}`, {
    replies: replies.length,
  });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: text.substring(0, 1024),
      },
      action: {
        buttons: replies.slice(0, 3).map((reply) => ({
          type: "reply" as const,
          reply: {
            id: reply.id.substring(0, 256),
            title: reply.title.substring(0, 20),
          },
        })),
      },
    },
  };

  try {
    const result = await callWhatsAppApi("messages", payload);
    EnhancedLogger.debug(`Quick reply menu sent to ${formattedTo}`, {
      messageId: result?.messages?.[0]?.id,
    });
    return result;
  } catch (err) {
    EnhancedLogger.error(
      `Failed to send quick reply menu to ${formattedTo}:`,
      err,
    );
    throw err;
  }
}

// --- File Upload Helper ---
async function uploadFile(
  fileBuffer: Buffer,
  fileName: string,
  fileType: string,
): Promise<string> {
  try {
    EnhancedLogger.info(`Uploading file: ${fileName} (${fileType})`, {
      bufferSize: fileBuffer.length,
    });

    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(process.cwd(), "uploads");

    if (!fs.existsSync(uploadsDir)) {
      EnhancedLogger.info(`Creating uploads directory: ${uploadsDir}`);
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Generate unique filename to avoid conflicts
    const uniqueFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
    const filePath = path.join(uploadsDir, uniqueFileName);

    EnhancedLogger.info(`Saving file to: ${filePath}`);

    // Save file to disk
    fs.writeFileSync(filePath, fileBuffer);

    // Verify file was saved
    if (!fs.existsSync(filePath)) {
      throw new Error(`Failed to save file to ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    EnhancedLogger.info(`File saved successfully`, {
      filePath,
      fileSize: stats.size,
      savedSize: fileBuffer.length,
    });

    return filePath;
  } catch (error: any) {
    EnhancedLogger.error(`Failed to upload file:`, {
      error: error?.message || error,
      stack: error?.stack,
      fileName,
      fileType,
    });
    throw error;
  }
}

// --- Download WhatsApp Media ---
async function downloadWhatsAppMedia(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    EnhancedLogger.info(`Downloading WhatsApp media: ${mediaId}`);

    // Get media URL
    const mediaUrl = `${CONFIG.baseUrl}/${CONFIG.apiVersion}/${mediaId}`;
    const response = await fetch(mediaUrl, {
      headers: {
        Authorization: `Bearer ${CONFIG.accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      EnhancedLogger.error(`Failed to get media URL: ${response.statusText}`, {
        status: response.status,
        error: errorText,
      });
      throw new Error(`Failed to get media URL: ${response.statusText}`);
    }

    const mediaData = await response.json();
    const downloadUrl = mediaData.url;
    const mimeType = mediaData.mime_type || "application/octet-stream";

    if (!downloadUrl) {
      EnhancedLogger.error(`No download URL in media data`, { mediaData });
      throw new Error("No download URL received from WhatsApp API");
    }

    // Download media
    const downloadResponse = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${CONFIG.accessToken}`,
      },
    });

    if (!downloadResponse.ok) {
      const errorText = await downloadResponse.text();
      EnhancedLogger.error(
        `Failed to download media: ${downloadResponse.statusText}`,
        {
          status: downloadResponse.status,
          error: errorText,
        },
      );
      throw new Error(
        `Failed to download media: ${downloadResponse.statusText}`,
      );
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    EnhancedLogger.debug(`Media downloaded successfully`, {
      mediaId,
      mimeType,
      size: buffer.length,
    });

    return { buffer, mimeType };
  } catch (error: any) {
    EnhancedLogger.error(`Failed to download WhatsApp media:`, {
      error: error?.message || error,
      stack: error?.stack,
    });
    throw error;
  }
}

// --- User Management ---
async function getOrCreateUser(phone: string, name?: string): Promise<IUser> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Getting/creating user for ${formattedPhone}`);

  try {
    await connectDB();

    let user = await User.findOne({ whatsapp: formattedPhone });
    if (!user) {
      EnhancedLogger.info(`Creating new user for ${formattedPhone}`);
      user = new User({
        name: name || "User",
        whatsapp: formattedPhone,
        whatsappLastActive: new Date(),
        whatsappMessageCount: 1,
        balance: 0,
        isBanned: false,
        createdAt: new Date(),
      });
      await user.save();
      EnhancedLogger.info(`Created new user with ID: ${user._id}`);

      // Notify admin about new user
      await notifyAdmin(
        `👤 নতুন ব্যবহারকারী যুক্ত হয়েছে\n\nনাম: ${user.name}\nফোন: ${formattedPhone}\nআইডি: ${user._id}`,
      );
    } else {
      if (user.isBanned) {
        EnhancedLogger.warn(`Banned user tried to access: ${formattedPhone}`);
        throw new Error("User is banned");
      }
      EnhancedLogger.debug(`Found existing user: ${user._id}`);
      user.whatsappLastActive = new Date();
      user.whatsappMessageCount += 1;
      user.name = name || user.name;
      await user.save();
    }

    return user;
  } catch (err) {
    EnhancedLogger.error(
      `Error in getOrCreateUser for ${formattedPhone}:`,
      err,
    );
    throw err;
  }
}

async function notifyAdmin(message: string): Promise<void> {
  if (!CONFIG.adminId) {
    EnhancedLogger.warn(`Admin ID not configured, skipping notification`);
    return;
  }

  EnhancedLogger.info(`Sending admin notification to ${CONFIG.adminId}`, {
    messageLength: message.length,
  });

  try {
    await sendTextMessage(
      CONFIG.adminId,
      `🔔 *ADMIN NOTIFICATION*\n\n${message}\n\n📅 ${new Date().toLocaleString()}`,
    );
    EnhancedLogger.debug(`Admin notification sent successfully`);
  } catch (err) {
    EnhancedLogger.error(`Failed to send admin notification:`, err);
  }
}

// --- Session Management ---
async function validateSession(phone: string): Promise<boolean> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);

  if (!state) {
    return true; // No state means new session
  }

  const lastActivity = (state.data?.lastActivity as number) || 0;
  const currentTime = Date.now();
  const sessionAge = currentTime - lastActivity;

  if (sessionAge > CONFIG.sessionTimeout) {
    EnhancedLogger.info(`Session expired for ${formattedPhone}`, {
      sessionAge: `${Math.round(sessionAge / 1000)}s`,
      timeout: `${CONFIG.sessionTimeout / 1000}s`,
    });
    await stateManager.clearUserState(formattedPhone);
    return false;
  }

  // Update last activity
  await stateManager.updateStateData(formattedPhone, {
    lastActivity: currentTime,
  });

  return true;
}

// --- Rate Limit Check ---
async function checkRateLimit(
  phone: string,
): Promise<{ allowed: boolean; message?: string }> {
  const formattedPhone = formatPhoneNumber(phone);

  // Clear expired entries periodically
  if (Math.random() < 0.1) {
    // 10% chance to clean up
    rateLimiter.clearExpired();
  }

  if (!rateLimiter.isAllowed(formattedPhone)) {
    const remainingTime = Math.ceil(
      (rateLimiter.getResetTime(formattedPhone) - Date.now()) / 1000,
    );
    const message = `⏳ *রেট লিমিট* \n\nআপনি অনেক দ্রুত রিকোয়েস্ট করছেন। দয়া করে ${remainingTime} সেকেন্ড পরে আবার চেষ্টা করুন।`;

    EnhancedLogger.warn(`Rate limit exceeded for ${formattedPhone}`, {
      remaining: rateLimiter.getRemaining(formattedPhone),
      resetIn: `${remainingTime}s`,
    });

    return { allowed: false, message };
  }

  return { allowed: true };
}

// --- Main Menu Handler ---
async function showMainMenu(phone: string, isAdmin: boolean): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing main menu to ${formattedPhone}`, { isAdmin });

  try {
    await stateManager.clearUserState(formattedPhone);

    if (isAdmin) {
      await showAdminMainMenu(formattedPhone);
    } else {
      await showUserMainMenu(formattedPhone);
    }
  } catch (err) {
    EnhancedLogger.error(`Failed to show main menu to ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      `🏠 *Birth Help Main Menu*\n\n` +
        `1. 💵 ব্যালেন্স রিচার্জ - 'রিচার্জ' লিখুন\n` +
        `2. 🛒 রেগুলার সার্ভিস - 'সার্ভিস' লিখুন\n` +
        `3. ⚡ ইন্সট্যান্ট সার্ভিস - 'ইন্সট্যান্ট' লিখুন\n` +
        `4. 📦 আমার অর্ডারসমূহ - 'অর্ডার' লিখুন\n` +
        `5. 📜 ট্রান্সাকশন হিস্টরি - 'হিস্টরি' লিখুন\n` +
        `6. 👤 অ্যাকাউন্ট তথ্য - 'অ্যাকাউন্ট' লিখুন\n` +
        `7. 🎧 সাপোর্ট / হেল্প - 'সাপোর্ট' লিখুন\n\n` +
        `🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন\n` +
        `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
    );
  }
}

async function showAdminMainMenu(phone: string): Promise<void> {
  const adminMenuRows = [
    {
      id: "admin_services",
      title: "📦 সার্ভিস ম্যানেজমেন্ট",
      description: "সার্ভিস এডিট/এড/রিমুভ/টগল",
    },
    {
      id: "admin_orders",
      title: "📋 অর্ডার ম্যানেজমেন্ট",
      description: "অর্ডার ভিউ, প্রসেস ও ডেলিভারি",
    },
    {
      id: "admin_users",
      title: "👥 ইউজার ম্যানেজমেন্ট",
      description: "ইউজার তালিকা, ব্যালেন্স ও ব্যান",
    },
    {
      id: "admin_broadcast",
      title: "📢 ব্রডকাস্ট মেসেজ",
      description: "সকল ইউজারকে মেসেজ পাঠান",
    },
    {
      id: "admin_stats",
      title: "📊 সিস্টেম স্ট্যাটিসটিক্স",
      description: "সিস্টেম তথ্য ও রিপোর্ট",
    },
    {
      id: "admin_settings",
      title: "⚙️ সিস্টেম সেটিংস",
      description: "সিস্টেম কনফিগারেশন",
    },
  ];

  await sendListMenu(
    phone,
    "⚙️ অ্যাডমিন প্যানেল",
    "অ্যাডমিন অপশনগুলো থেকে সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
    adminMenuRows,
    "অ্যাডমিন মেনু",
    "অ্যাডমিন অপশন",
  );
}

async function showUserMainMenu(phone: string): Promise<void> {
  const userMenuRows = [
    {
      id: "user_recharge",
      title: "💵 ব্যালেন্স রিচার্জ",
      description: "ব্যালেন্স রিচার্জ করুন বিকাশের মাধ্যমে",
    },
    {
      id: "user_services",
      title: "🛒 রেগুলার সার্ভিস",
      description: "সাধারণ সার্ভিস দেখুন ও কিনুন",
    },
    {
      id: "user_instant",
      title: "⚡ ইন্সট্যান্ট সার্ভিস",
      description: "তাত্ক্ষণিক সার্ভিসসমূহ",
    },
    {
      id: "user_orders",
      title: "📦 আমার অর্ডারসমূহ",
      description: "আপনার সকল অর্ডারের তালিকা",
    },
    {
      id: "user_history",
      title: "📜 ট্রান্সাকশন হিস্টরি",
      description: "সমস্ত ট্রান্সাকশনের ইতিহাস",
    },
    {
      id: "user_account",
      title: "👤 আমার অ্যাকাউন্ট",
      description: "আপনার অ্যাকাউন্টের তথ্য ও ডিটেইলস",
    },
    {
      id: "user_support",
      title: "🎧 সাপোর্ট / হেল্প",
      description: "সাপোর্ট টিমের সাথে যোগাযোগ",
    },
  ];

  await sendListMenu(
    phone,
    "🏠 Birth Help - Main Menu",
    "আপনার প্রয়োজন অনুযায়ী নিচের অপশন সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
    userMenuRows,
    "মেনু অপশনসমূহ",
    "মেনু দেখুন",
  );
}

// --- Cancel Flow Handler ---
async function cancelFlow(
  phone: string,
  isAdmin: boolean = false,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Canceling flow for ${formattedPhone}`);

  try {
    await stateManager.clearUserState(formattedPhone);
    await sendTextMessage(formattedPhone, "🚫 অপারেশন বাতিল করা হয়েছে।");
    await showMainMenu(formattedPhone, isAdmin);
    EnhancedLogger.logFlowCompletion(formattedPhone, "cancel", { isAdmin });
  } catch (err) {
    EnhancedLogger.error(`Failed to cancel flow for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ বাতিল করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
  }
}

// ================= USER FEATURES =================

// --- Recharge Flow ---
async function handleRechargeStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Starting recharge flow for ${formattedPhone}`);

  try {
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_trx_id",
      flowType: "recharge",
      data: {
        recharge: {
          attempts: 0,
        },
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    const message = `💳 *রিচার্জ করুন*\n\n📱 আমাদের বিকাশ নম্বর: *${CONFIG.bkashNumber}*\n\nবিকাশে পেমেন্ট করার পর *Transaction ID* পাঠান:\n\n\`TRX_ID\`\n\n📌 নোট:\n• ট্রান্সাকশন আইডি পেতে বিকাশ অ্যাপ চেক করুন\n• পেমেন্ট যাচাই করতে ১-২ মিনিট সময় লাগতে পারে\n• সমস্যা হলে সাপোর্টে যোগাযোগ করুন\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন:`;

    await sendTextWithCancelButton(formattedPhone, message);
    EnhancedLogger.info(`Recharge instructions sent to ${formattedPhone}`);
  } catch (err) {
    EnhancedLogger.error(`Failed to start recharge flow for ${phone}:`, err);
    throw err;
  }
}

async function handleTrxIdInput(phone: string, trxId: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Processing TRX ID for ${formattedPhone}`, { trxId });

  try {
    await stateManager.updateStateData(formattedPhone, {
      recharge: {
        trxId: trxId,
        amount: 0,
      },
    });

    await sendTextMessage(
      formattedPhone,
      `⏳ *পেমেন্ট যাচাই করা হচ্ছে...*\n\nটিআরএক্স আইডি: ${trxId}/3\n\nদয়া করে অপেক্ষা করুন...`,
    );

    const payment = await fetch(
      `https://api.bdx.kg/bkash/submit.php?trxid=${trxId}`,
    );

    if (!payment.ok) {
      await sendTextMessage(
        formattedPhone,
        "❌ রিচার্জ যাচাই করতে ব্যর্থ। দয়া পরে চেষ্টা করুন অথবা সাপোর্টে যোগাযোগ করুন।",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    const paymentData = await payment.json();
    if (paymentData.error) {
      await sendTextMessage(
        formattedPhone,
        `❌ রিচার্জ যাচাই করতে ব্যর্থ: ${paymentData.error}\n\nদয়া করে সঠিক ট্রান্সাকশন আইডি দিন।`,
      );
      return;
    }

    if (!paymentData.amount || !paymentData.payerAccount) {
      await sendTextMessage(
        formattedPhone,
        "❌ অবৈধ ট্রান্সাকশন আইডি বা পরিমাণ। দয়া করে সঠিক তথ্য প্রদান করুন।",
      );
      return;
    }

    const verifiedAmount = Number(paymentData.amount);

    await sendTextMessage(
      formattedPhone,
      `✅ *ট্রান্সাকশন ভেরিফাইড*\n\n🔢 টিআরএক্স আইডি: ${trxId}\n💰 পরিমাণ: ৳${verifiedAmount}\n📞 পাঠানো নম্বর: ${paymentData.payerAccount}\n📅 সময়: ${new Date().toLocaleString()}`,
    );

    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });
    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    user.balance += verifiedAmount;
    await user.save();

    await Transaction.create({
      trxId: trxId,
      amount: verifiedAmount,
      method: "bkash",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      metadata: {
        payerAccount: paymentData.payerAccount,
        verificationTime: new Date().toISOString(),
      },
      createdAt: new Date(),
    });

    await sendTextMessage(
      formattedPhone,
      `💰 *রিচার্জ সফল*\n\nনতুন ব্যালেন্স: ৳${user.balance}\n\n🎉 রিচার্জ সফলভাবে সম্পন্ন হয়েছে!\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
    );

    await notifyAdmin(
      `💰 নতুন রিচার্জ\n\nব্যবহারকারী: ${formattedPhone}\nনাম: ${user.name}\nপরিমাণ: ৳${verifiedAmount}\nটিআরএক্স: ${trxId}\nনতুন ব্যালেন্স: ৳${user.balance}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
    EnhancedLogger.logFlowCompletion(formattedPhone, "recharge", {
      amount: verifiedAmount,
      trxId,
      newBalance: user.balance,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to process TRX ID for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ রিচার্জ প্রক্রিয়া সম্পূর্ণ করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন অথবা সাপোর্টে যোগাযোগ করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Instant Services ---
async function showInstantServices(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing instant services to ${formattedPhone}`);

  try {
    const activeServices = INSTANT_SERVICES.filter((s) => s.isActive);
    const serviceRows = activeServices.map((service) => ({
      id: service.id,
      title: `${service.name} - ৳${service.price}`,
      description: service.description,
    }));

    if (serviceRows.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "⚡ *ইন্সট্যান্ট সার্ভিস*\n\nদুঃখিত, এখন কোন ইন্সট্যান্ট সার্ভিস উপলব্ধ নেই।\n\n🛒 রেগুলার সার্ভিস দেখতে 'সার্ভিস' লিখুন।\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    await sendListMenu(
      formattedPhone,
      "⚡ ইন্সট্যান্ট সার্ভিস",
      "তাত্ক্ষণিক রেজাল্ট পাওয়ার জন্য সার্ভিস সিলেক্ট করুন:\n\n💡 নির্দেশনা: সার্ভিস সিলেক্ট করার পর প্রয়োজনীয় তথ্য দিন\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "ইন্সট্যান্ট সার্ভিস",
      "সার্ভিস দেখুন",
    );
    EnhancedLogger.info(`Instant services list sent to ${formattedPhone}`, {
      count: serviceRows.length,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show instant services to ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ ইন্সট্যান্ট সার্ভিস লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleInstantServiceSelection(
  phone: string,
  serviceId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(
    `Handling instant service selection for ${formattedPhone}`,
    {
      serviceId,
    },
  );

  try {
    const service = INSTANT_SERVICES.find((s) => s.id === serviceId);
    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < service.price) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${service.price}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (serviceId === "instant_ubrn_verification") {
      await handleUbrnVerificationStart(phone);
      return;
    }

    if (service.requiresInput) {
      await stateManager.setUserState(formattedPhone, {
        currentState: "awaiting_instant_input",
        flowType: "instant_service",
        data: {
          serviceOrder: {
            serviceId: serviceId,
            price: service.price,
            serviceName: service.name,
            attempts: 0,
          },
          lastActivity: Date.now(),
          sessionId: Date.now().toString(36),
        },
      });

      await sendTextWithCancelButton(
        formattedPhone,
        `⚡ *${service.name}*\n\n💰 মূল্য: ৳${service.price}\n\n${service.inputPrompt}\n\nউদাহরণ: ${service.inputExample}\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন`,
      );
    } else {
      // Process service without input
      await processInstantService(phone, serviceId, "");
    }
  } catch (err) {
    EnhancedLogger.error(
      `Failed to handle instant service selection for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস সিলেক্ট করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleInstantServiceInput(
  phone: string,
  input: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(
    `Processing instant service input for ${formattedPhone}`,
    {
      input,
    },
  );

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const serviceOrderData = state?.data?.serviceOrder as ServiceOrderStateData;

    if (!serviceOrderData) {
      await sendTextMessage(formattedPhone, "❌ সেশন শেষ হয়েছে!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    await processInstantService(phone, serviceOrderData.serviceId!, input);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to process instant service input for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function processInstantService(
  phone: string,
  serviceId: string,
  input: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const service = INSTANT_SERVICES.find((s) => s.id === serviceId);

  if (!service) {
    await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
    await showMainMenu(formattedPhone, false);
    return;
  }

  EnhancedLogger.info(`Processing instant service for ${formattedPhone}`, {
    serviceId,
    serviceName: service.name,
    input,
  });

  try {
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < service.price) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${service.price}\nআপনার ব্যালেন্স: ৳${user.balance}`,
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Deduct balance
    user.balance -= service.price;
    await user.save();

    // Create transaction record
    const transaction = await Transaction.create({
      trxId: `INST-${Date.now()}`,
      amount: service.price,
      method: "balance",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      metadata: {
        serviceId: serviceId,
        serviceName: service.name,
        input: input || null,
        processedAt: new Date().toISOString(),
      },
      createdAt: new Date(),
    });

    let resultMessage = `✅ *${service.name} সম্পন্ন*\n\n`;
    resultMessage += `💰 খরচ: ৳${service.price}\n`;
    resultMessage += `🆕 ব্যালেন্স: ৳${user.balance}\n`;
    resultMessage += `📅 সময়: ${new Date().toLocaleString()}\n\n`;

    // Add input data if provided
    if (input) {
      resultMessage += `📋 প্রদত্ত তথ্য: ${input}\n\n`;
    }

    // Simulate processing for different services
    if (serviceId === "instant_ubrn_verification") {
      // UBRN verification handled separately
      return;
    } else if (serviceId === "instant_company_info") {
      resultMessage += `📊 *কোম্পানি তথ্য:*\n`;
      resultMessage += `• কোম্পানি নাম: টেস্ট কোম্পানি লিমিটেড\n`;
      resultMessage += `• রেজিস্ট্রেশন নম্বর: ${input}\n`;
      resultMessage += `• স্থিতি: সক্রিয়\n`;
      resultMessage += `• প্রতিষ্ঠার তারিখ: ২০২০-০১-১৫\n`;
      resultMessage += `• ঠিকানা: ঢাকা, বাংলাদেশ\n\n`;
      resultMessage += `✅ তথ্য যাচাই সম্পন্ন হয়েছে।`;
    } else if (serviceId === "instant_nid_verify") {
      resultMessage += `📊 *এনআইডি ভেরিফিকেশন রেজাল্ট:*\n`;
      resultMessage += `• এনআইডি নম্বর: ${input}\n`;
      resultMessage += `• নাম: জন ডো\n`;
      resultMessage += `• পিতা/স্বামীর নাম: রিচার্ড ডো\n`;
      resultMessage += `• জন্ম তারিখ: ১৯৯০-০৫-১৫\n`;
      resultMessage += `• স্থিতি: বৈধ\n\n`;
      resultMessage += `✅ এনআইডি যাচাই সম্পন্ন হয়েছে।`;
    } else {
      resultMessage += `✅ আপনার রিকোয়েস্ট প্রসেস করা হয়েছে।\n`;
    }

    resultMessage += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, resultMessage);

    // Notify admin
    await notifyAdmin(
      `⚡ ইন্সট্যান্ট সার্ভিস সম্পন্ন\n\nব্যবহারকারী: ${formattedPhone}\nসার্ভিস: ${service.name}\nমূল্য: ৳${service.price}\nইনপুট: ${input || "N/A"}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);

    EnhancedLogger.logFlowCompletion(formattedPhone, "instant_service", {
      serviceId,
      serviceName: service.name,
      price: service.price,
      input,
      transactionId: transaction._id,
      newBalance: user.balance,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to process instant service for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ ইন্সট্যান্ট সার্ভিস প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
  }
}

async function handleUbrnVerificationStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Starting UBRN verification for ${formattedPhone}`);

  try {
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < CONFIG.ubrnServicePrice) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${CONFIG.ubrnServicePrice}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।`,
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_ubrn_number",
      flowType: "ubrn_verification",
      data: {
        ubrn: {
          attempt: 0,
        },
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    const message = `🔍 *UBRN ভেরিফিকেশন*\n\n💰 মূল্য: ৳${CONFIG.ubrnServicePrice}\n\nদয়া করে UBRN নম্বরটি পাঠান:\n\nউদাহরণ: 19862692537094068\n\n📌 নোট:\n• UBRN নম্বরটি সঠিকভাবে লিখুন\n• যাচাই করতে ১-২ মিনিট সময় লাগতে পারে\n• সমস্যা হলে সাপোর্টে যোগাযোগ করুন\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন`;

    await sendTextWithCancelButton(formattedPhone, message);
    EnhancedLogger.info(`UBRN verification started for ${formattedPhone}`);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to start UBRN verification for ${phone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ UBRN সার্ভিস শুরু করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleUbrnInput(phone: string, ubrn: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const trimmedUbrn = ubrn.trim();

  EnhancedLogger.info(`Starting UBRN processing for ${formattedPhone}`, {
    ubrn: trimmedUbrn,
    timestamp: new Date().toISOString(),
  });

  try {
    // Update state
    await stateManager.updateStateData(formattedPhone, {
      ubrn: {
        ubrn: trimmedUbrn,
        processingStart: new Date().toISOString(),
      },
    });

    // Send initial message
    await sendTextMessage(
      formattedPhone,
      `⏳ UBRN তথ্য যাচাই করা হচ্ছে...\n\nUBRN: ${trimmedUbrn}\n\nদয়া করে অপেক্ষা করুন...`,
    );

    EnhancedLogger.debug(`Connecting to database for user: ${formattedPhone}`);
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      EnhancedLogger.warn(`User not found: ${formattedPhone}`);
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    EnhancedLogger.debug(`User found: ${user._id}, Balance: ${user.balance}`);

    // Check balance
    if (user.balance < CONFIG.ubrnServicePrice) {
      EnhancedLogger.warn(`Insufficient balance for ${formattedPhone}`, {
        balance: user.balance,
        required: CONFIG.ubrnServicePrice,
      });

      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${CONFIG.ubrnServicePrice}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💰 ব্যালেন্স রিচার্জ করতে অ্যাডমিনের সাথে যোগাযোগ করুন।`,
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Call UBRN API
    let apiResponse;
    const apiStartTime = Date.now();

    try {
      EnhancedLogger.info(`Calling UBRN API`, {
        ubrn: trimmedUbrn,
        url: CONFIG.ubrnApiUrl,
        startTime: new Date().toISOString(),
      });

      const response = await axios.get(CONFIG.ubrnApiUrl, {
        params: { ubrn: trimmedUbrn },
      });

      const apiEndTime = Date.now();
      const apiDuration = apiEndTime - apiStartTime;
      console.log(response);
      EnhancedLogger.info(`UBRN API response received`, {
        ubrn: trimmedUbrn,
        status: response.status,
        statusText: response.statusText,
        duration: `${apiDuration}ms`,
        headers: response.headers,
        dataKeys: response.data ? Object.keys(response.data) : "no data",
      });

      apiResponse = response.data;

      // Log the actual response structure
      EnhancedLogger.debug(`UBRN API raw response`, {
        data: apiResponse,
        dataType: typeof apiResponse,
      });
    } catch (apiError: unknown) {
      const apiEndTime = Date.now();
      const apiDuration = apiEndTime - apiStartTime;

      EnhancedLogger.error(`UBRN API call failed for ${trimmedUbrn}`, {
        error: apiError,
        duration: `${apiDuration}ms`,
        phone: formattedPhone,
        stack: apiError instanceof Error ? apiError.stack : "No stack trace",
      });

      let errorMessage = "UBRN API তে সমস্যা হয়েছে।";
      let errorDetails = "";

      if (axios.isAxiosError(apiError)) {
        EnhancedLogger.error(`Axios error details`, {
          code: apiError.code,
          message: apiError.message,
          response: apiError.response?.data,
          status: apiError.response?.status,
          config: {
            url: apiError.config?.url,
            method: apiError.config?.method,
            params: apiError.config?.params,
          },
        });

        if (apiError.code === "ECONNABORTED" || apiError.code === "ETIMEDOUT") {
          errorMessage =
            "UBRN API টাইমআউট হয়েছে। দয়া করে কিছুক্ষণ পরে আবার চেষ্টা করুন।";
        } else if (apiError.response?.status === 404) {
          errorMessage =
            "❌ UBRN নম্বরটি পাওয়া যায়নি।\n\nদয়া করে নিশ্চিত করুন যে UBRN নম্বরটি সঠিক।";
        } else if (apiError.response?.status === 400) {
          errorMessage =
            "❌ UBRN নম্বরটি সঠিক ফরম্যাটে নয়।\n\nদয়া করে ১৭ বা ১৮ ডিজিটের UBRN নম্বর দিন।";
        } else if (apiError.response?.status === 429) {
          errorMessage =
            "❌ অনেকগুলো রিকোয়েস্ট করা হয়েছে।\n\nদয়া করে কিছুক্ষণ পরে আবার চেষ্টা করুন।";
        } else if (apiError.response?.data) {
          const errorData = apiError.response.data;
          errorDetails =
            typeof errorData === "object"
              ? JSON.stringify(errorData, null, 2)
              : String(errorData);
        }
      } else if (apiError instanceof Error) {
        errorDetails = apiError.message;
      }

      await sendTextMessage(
        formattedPhone,
        `${errorMessage}\n\n${errorDetails ? `বিস্তারিত: ${errorDetails}\n\n` : ""}আপনার ব্যালেন্স কাটা হয়নি।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
      );

      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Validate API response
    if (!apiResponse) {
      EnhancedLogger.error(`Empty API response for UBRN: ${trimmedUbrn}`);
      await sendTextMessage(
        formattedPhone,
        "❌ UBRN API থেকে কোনো রেসপন্স পাওয়া যায়নি।\n\nদয়া করে আডমিনের সাথে যোগাযোগ করুন।",
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Parse API response
    EnhancedLogger.debug(`Parsing API response`, {
      responseType: typeof apiResponse,
      responseKeys: Object.keys(apiResponse),
    });

    let resultData = null;
    let apiStatus = "unknown";
    let errorMessage = "";

    if (typeof apiResponse === "object") {
      // Check for your specific API structure
      if (apiResponse.status === "success" && apiResponse.result) {
        apiStatus = "success";
        resultData = apiResponse.result;

        EnhancedLogger.info(`Successfully parsed UBRN data`, {
          ubrn: trimmedUbrn,
          hasResult: !!resultData,
          resultKeys: resultData ? Object.keys(resultData) : [],
        });
      }
      // Check for error response
      else if (
        apiResponse.error ||
        apiResponse.status === "error" ||
        apiResponse.success === false
      ) {
        apiStatus = "error";
        resultData = apiResponse;
        errorMessage =
          apiResponse.error || apiResponse.message || "UBRN তথ্য পাওয়া যায়নি";

        EnhancedLogger.warn(`API returned error for UBRN: ${trimmedUbrn}`, {
          error: errorMessage,
          fullResponse: apiResponse,
        });
      }
      // Direct result object
      else if (apiResponse.dob || apiResponse.name || apiResponse.ubrn) {
        apiStatus = "success";
        resultData = apiResponse;

        EnhancedLogger.info(`Direct result object found`, {
          ubrn: trimmedUbrn,
          fields: Object.keys(apiResponse),
        });
      }
      // Unknown structure
      else {
        apiStatus = "unknown";
        resultData = apiResponse;

        EnhancedLogger.warn(`Unknown API response structure`, {
          ubrn: trimmedUbrn,
          response: apiResponse,
        });
      }
    } else {
      apiStatus = "invalid";
      EnhancedLogger.error(`Invalid API response type`, {
        ubrn: trimmedUbrn,
        responseType: typeof apiResponse,
        response: apiResponse,
      });
    }

    // Process based on API status
    if (apiStatus === "success" && resultData) {
      // Deduct balance
      const oldBalance = user.balance;
      user.balance -= CONFIG.ubrnServicePrice;
      await user.save();

      EnhancedLogger.info(`Balance deducted`, {
        userId: user._id,
        oldBalance,
        deduction: CONFIG.ubrnServicePrice,
        newBalance: user.balance,
      });

      // Create transaction record
      const transaction = await Spent.create({
        user: user._id,
        amount: CONFIG.ubrnServicePrice,
        service: "UBRN Search",
        reference: trimmedUbrn,
        status: "completed",
        metadata: {
          apiStatus,
          executionTime: apiResponse.execution_time || "N/A",
          resultFields: resultData ? Object.keys(resultData) : [],
          timestamp: new Date().toISOString(),
        },
      });

      EnhancedLogger.info(`Transaction created`, {
        transactionId: transaction._id,
        userId: user._id,
        amount: CONFIG.ubrnServicePrice,
      });

      // Format and send result message
      let resultMessage = `✅ *UBRN ভেরিফিকেশন সম্পন্ন*\n\n`;
      resultMessage += `🔢 UBRN: ${trimmedUbrn}\n`;
      resultMessage += `💰 খরচ: ৳${CONFIG.ubrnServicePrice}\n`;
      resultMessage += `💰 পূর্বের ব্যালেন্স: ৳${oldBalance}\n`;
      resultMessage += `🆕 নতুন ব্যালেন্স: ৳${user.balance}\n`;
      resultMessage += `📅 তারিখ: ${new Date().toLocaleDateString("bn-BD")}\n`;
      resultMessage += `⏰ সময়: ${new Date().toLocaleTimeString("bn-BD")}\n`;

      if (apiResponse.execution_time) {
        resultMessage += `⚡ প্রসেসিং সময়: ${apiResponse.execution_time}\n`;
      }

      resultMessage += `\n📋 *ব্যক্তিগত তথ্য:*\n`;

      // Format result data
      if (resultData) {
        // Bengali field mappings
        const fieldMappings: { [key: string]: string } = {
          name: "নাম",
          dob: "জন্ম তারিখ",
          ubrn: "UBRN নম্বর",
          father_name: "পিতার নাম",
          mother_name: "মাতার নাম",
          gender: "লিঙ্গ",
          birth_place: "জন্মস্থান",
          address: "বর্তমান ঠিকানা",
          national_id: "জাতীয় পরিচয়পত্র",
          registration_number: "নিবন্ধন নম্বর",
          registration_date: "নিবন্ধনের তারিখ",
        };

        // Display known fields
        Object.entries(fieldMappings).forEach(([key, bengaliLabel]) => {
          if (resultData[key]) {
            resultMessage += `• ${bengaliLabel}: ${resultData[key]}\n`;
          }
        });

        // Display any other fields not in mappings
        Object.entries(resultData).forEach(([key, value]) => {
          if (!fieldMappings[key] && value && typeof value !== "object") {
            const displayKey = key.replace(/_/g, " ").toUpperCase();
            resultMessage += `• ${displayKey}: ${value}\n`;
          }
        });

        // Log what was displayed
        EnhancedLogger.debug(`Result displayed to user`, {
          displayedFields: Object.keys(resultData).filter(
            (key) => resultData[key],
          ),
          totalFields: Object.keys(resultData).length,
        });
      } else {
        resultMessage += "কোন তথ্য পাওয়া যায়নি\n";
      }

      resultMessage += `\n💡 *দ্রষ্টব্য:*\n`;
      resultMessage += `• এই তথ্য শুধুমাত্র রেফারেন্সের জন্য\n`;
      resultMessage += `• যেকোনো ভুল তথ্যের জন্য আমরা দায়ী নই\n`;
      resultMessage += `\n🏠 *মেনুতে ফিরতে 'Menu' লিখুন*`;

      await sendTextMessage(formattedPhone, resultMessage);

      // Notify admin
      await notifyAdmin(
        `🔍 UBRN ভেরিফিকেশন সম্পন্ন\n\n` +
          `📱 ব্যবহারকারী: ${formattedPhone}\n` +
          `🔢 UBRN: ${trimmedUbrn}\n` +
          `💰 মূল্য: ৳${CONFIG.ubrnServicePrice}\n` +
          `💳 পুরাতন ব্যালেন্স: ৳${oldBalance}\n` +
          `🆕 নতুন ব্যালেন্স: ৳${user.balance}\n` +
          `📊 লেনদেন ID: ${transaction._id}\n` +
          `⏱️ সময়: ${new Date().toLocaleString("bn-BD")}`,
      );

      EnhancedLogger.logFlowCompletion(formattedPhone, "ubrn_verification", {
        ubrn: trimmedUbrn,
        price: CONFIG.ubrnServicePrice,
        transactionId: transaction._id,
        oldBalance,
        newBalance: user.balance,
        apiStatus,
        executionTime: apiResponse.execution_time,
        resultFieldsCount: resultData ? Object.keys(resultData).length : 0,
      });
    } else {
      // API failed or returned error
      EnhancedLogger.warn(`UBRN verification failed`, {
        ubrn: trimmedUbrn,
        phone: formattedPhone,
        apiStatus,
        errorMessage,
        apiResponse,
      });

      await sendTextMessage(
        formattedPhone,
        `❌ UBRN তথ্য পাওয়া যায়নি\n\n` +
          `UBRN: ${trimmedUbrn}\n\n` +
          `${errorMessage ? `কারণ: ${errorMessage}\n\n` : ""}` +
          `💰 আপনার ব্যালেন্স কাটা হয়নি\n\n` +
          `🏠 *মেনুতে ফিরতে 'Menu' লিখুন*`,
      );
    }

    // Clear state and show menu
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);

    EnhancedLogger.info(`UBRN process completed for ${formattedPhone}`, {
      ubrn: trimmedUbrn,
      finalStatus: apiStatus,
      userNotified: true,
    });
  } catch (error) {
    EnhancedLogger.error(
      `Critical error in UBRN processing for ${formattedPhone}`,
      {
        error: error,
        ubrn: ubrn,
        stack: error instanceof Error ? error.stack : "No stack trace",
        timestamp: new Date().toISOString(),
      },
    );

    try {
      await sendTextMessage(
        formattedPhone,
        "❌ UBRN ভেরিফিকেশন করতে সমস্যা হয়েছে।\n\n" +
          "দয়া করে কিছুক্ষণ পরে আবার চেষ্টা করুন।\n\n" +
          "🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
    } catch (sendError) {
      EnhancedLogger.error(
        `Failed to send error message to ${formattedPhone}`,
        {
          error: sendError,
        },
      );
    }

    try {
      await stateManager.clearUserState(formattedPhone);
    } catch (stateError) {
      EnhancedLogger.error(`Failed to clear state for ${formattedPhone}`, {
        error: stateError,
      });
    }

    try {
      await showMainMenu(formattedPhone, false);
    } catch (menuError) {
      EnhancedLogger.error(`Failed to show main menu for ${formattedPhone}`, {
        error: menuError,
      });
    }
  }
}

// --- Regular Services ---
async function showRegularServices(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing regular services to ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find({
      isActive: true,
    })
      .sort({ price: 1 })
      .limit(10);

    if (services.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "📭 *রেগুলার সার্ভিস*\n\nদুঃখিত, এখন কোন রেগুলার সার্ভিস উপলব্ধ নেই।\n\n⚡ ইন্সট্যান্ট সার্ভিস দেখতে 'ইন্সট্যান্ট' লিখুন।\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    const serviceRows = services.map((service) => ({
      id: `service_${service._id}`,
      title: `${service.name} - ৳${service.price}`,
      description: service.description.substring(0, 50) + "...",
    }));

    await sendListMenu(
      formattedPhone,
      "🛍️ রেগুলার সার্ভিসসমূহ",
      "সার্ভিস সিলেক্ট করুন:\n\n💡 সার্ভিস সিলেক্ট করার পর প্রয়োজনীয় তথ্য সংগ্রহ করা হবে।\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "সার্ভিস লিস্ট",
      "সার্ভিস দেখুন",
    );
    EnhancedLogger.info(`Regular services list sent to ${formattedPhone}`, {
      count: services.length,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show regular services to ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleRegularServiceSelection(
  phone: string,
  serviceId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const actualServiceId = serviceId.replace("service_", "");
  EnhancedLogger.info(
    `Handling regular service selection for ${formattedPhone}`,
    {
      serviceId: actualServiceId,
    },
  );

  try {
    await connectDB();
    const service = await Service.findById(actualServiceId);
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!service || !user) {
      await sendTextMessage(
        formattedPhone,
        "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < service.price) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${service.price}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Create initial collectedData object
    const collectedData: Record<string, any> = {};

    // Initialize with empty values for all required fields
    if (service.requiredFields && service.requiredFields.length > 0) {
      service.requiredFields.forEach((field: ServiceField) => {
        collectedData[field.name] = "";
      });
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_data",
      flowType: "service_order",
      data: {
        serviceOrder: {
          serviceId: actualServiceId,
          price: service.price,
          serviceName: service.name,
          fieldIndex: 0,
          collectedData: collectedData,
          attempts: 0,
        },
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    EnhancedLogger.logStateChange(
      formattedPhone,
      "menu",
      "awaiting_service_data",
      {
        serviceId: actualServiceId,
        serviceName: service.name,
        fieldCount: service.requiredFields?.length || 0,
      },
    );

    // Check if service has required fields
    if (service.requiredFields && service.requiredFields.length > 0) {
      await askForServiceField(formattedPhone, service, 0);
    } else {
      // No fields required, ask for confirmation
      await askForServiceConfirmation(formattedPhone, service);
    }
  } catch (err) {
    EnhancedLogger.error(
      `Failed to handle regular service selection for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস সিলেক্ট করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function askForServiceField(
  phone: string,
  service: IService,
  fieldIndex: number,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);

  if (!service.requiredFields || fieldIndex >= service.requiredFields.length) {
    // All fields collected, ask for confirmation
    await askForServiceConfirmation(phone, service);
    return;
  }

  const field = service.requiredFields[fieldIndex];
  let message = `📝 *${field.label}*\n\n`;

  if (field.required) {
    message += `(প্রয়োজনীয়)\n`;
  }

  if (field.description) {
    message += `${field.description}\n\n`;
  }

  if (field.type === "file") {
    message += `📁 ফাইল আপলোড করুন:\n`;
    message += `• ইমেজ (JPG, PNG)\n`;
    message += `• PDF বা ডকুমেন্ট\n\n`;
    message += `দয়া করে ফাইল পাঠান...`;
  } else if (field.type === "text") {
    message += `টেক্সট লিখুন:`;
  }

  message += `\n\n🚫 বাতিল করতে 'cancel' লিখুন`;

  await sendTextWithCancelButton(formattedPhone, message);
}

async function askForServiceConfirmation(
  phone: string,
  service: IService,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const serviceOrderData = state?.data?.serviceOrder as ServiceOrderStateData;
  const collectedData = serviceOrderData?.collectedData || {};

  let message = `🛒 *অর্ডার কনফার্মেশন*\n\n`;
  message += `📦 সার্ভিস: ${service.name}\n`;
  message += `💰 মূল্য: ৳${service.price}\n\n`;

  if (Object.keys(collectedData).length > 0) {
    message += `📋 প্রদত্ত তথ্য:\n`;

    // First, collect all field data
    const fieldsData: { label: string; value: string }[] = [];

    if (service.requiredFields) {
      service.requiredFields.forEach((field: ServiceField) => {
        const fieldData = collectedData[field.name];
        let displayValue = "শূন্য";

        if (fieldData) {
          if (field.type === "file") {
            displayValue = "📁 ফাইল আপলোড করা হয়েছে";
          } else if (typeof fieldData === "object" && fieldData.data) {
            displayValue = fieldData.data;
          } else if (typeof fieldData === "string") {
            displayValue = fieldData;
          }
        }

        fieldsData.push({
          label: field.label,
          value: displayValue,
        });
      });
    }

    // Now display all fields
    fieldsData.forEach((field) => {
      message += `• ${field.label}: ${field.value}\n`;
    });

    message += `\n`;
  }

  if (service.instructions) {
    message += `📝 নির্দেশনা: ${service.instructions}\n\n`;
  }

  // Update state to awaiting confirmation
  await stateManager.updateStateData(formattedPhone, {
    serviceOrder: {
      ...serviceOrderData,
    },
    currentState: "awaiting_service_confirmation",
  });

  // Send confirmation with buttons
  await sendQuickReplyMenu(formattedPhone, message, [
    { id: "order_confirm", title: "✅ কনফার্ম করুন" },
    { id: "order_edit", title: "✏️ এডিট করুন" },
    { id: "order_cancel", title: "🚫 বাতিল করুন" },
  ]);
}
async function handleUserFileUpload(
  phone: string,
  message: WhatsAppMessage,
): Promise<{
  fileUrl: string;
  fileName: string;
  fileType: string;
  fileSize: string;
} | null> {
  const formattedPhone = formatPhoneNumber(phone);

  EnhancedLogger.info(`Handling user file upload for ${formattedPhone}`, {
    messageType: message.type,
    hasImage: !!message.image,
    hasDocument: !!message.document,
  });

  try {
    if (message.type === "image" || message.type === "document") {
      const mediaId =
        message.type === "image" ? message.image?.id : message.document?.id;
      const originalFileName =
        message.type === "image"
          ? `user_${formattedPhone}_${Date.now()}.jpg`
          : message.document?.filename ||
            `user_${formattedPhone}_${Date.now()}.pdf`;

      if (!mediaId) {
        EnhancedLogger.error(`No media ID found for file upload`);
        throw new Error("No media ID");
      }

      EnhancedLogger.info(`Downloading user media: ${mediaId}`);

      // Download media from WhatsApp
      const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);

      // Check file size
      if (buffer.length > CONFIG.maxFileSize) {
        throw new Error(
          `File size too large: ${buffer.length} bytes, max: ${CONFIG.maxFileSize}`,
        );
      }

      // Create uploads directory structure
      const uploadsDir = path.join(process.cwd(), "uploads", "orders");
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      // Generate unique filename
      const fileExt =
        path.extname(originalFileName) ||
        (mimeType.includes("image")
          ? ".jpg"
          : mimeType.includes("pdf")
            ? ".pdf"
            : mimeType.includes("word")
              ? ".docx"
              : ".bin");

      const uniqueFileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}${fileExt}`;
      const filePath = path.join(uploadsDir, uniqueFileName);

      // Save file
      fs.writeFileSync(filePath, buffer);

      // Create public URL path
      const publicPath = `/uploads/orders/${uniqueFileName}`;

      return {
        fileUrl: publicPath, // This will be stored in the database
        fileName: originalFileName,
        fileType: mimeType,
        fileSize: formatFileSize(buffer.length),
      };
    } else {
      throw new Error(
        `Unsupported message type for file upload: ${message.type}`,
      );
    }
  } catch (error: any) {
    EnhancedLogger.error(`Failed to handle user file upload:`, {
      error: error?.message || error,
      stack: error?.stack,
      phone: formattedPhone,
    });
    throw error;
  }
}

// Helper function to format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
async function handleServiceFieldInput(
  phone: string,
  input: string,
  message?: WhatsAppMessage,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);

  EnhancedLogger.info(`Processing service field input for ${formattedPhone}`, {
    input,
    hasFile: !!message?.image || !!message?.document,
  });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state || state.flowType !== "service_order") {
      await sendTextMessage(
        formattedPhone,
        "❌ কোন একটিভ সার্ভিস পাওয়া যায়নি!",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    const serviceOrderData = state.data?.serviceOrder as ServiceOrderStateData;
    const serviceId = serviceOrderData?.serviceId;
    let fieldIndex = serviceOrderData?.fieldIndex || 0;

    if (!serviceId) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service || !service.requiredFields) {
      await sendTextMessage(
        formattedPhone,
        "❌ সার্ভিস বা ফিল্ড পাওয়া যায়নি!",
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    const field = service.requiredFields[fieldIndex];
    let fieldValue: any = null;

    // Handle file upload for file type fields
    if (field.type === "file" && (message?.image || message?.document)) {
      try {
        await sendTextMessage(
          formattedPhone,
          "⏳ ফাইল আপলোড হচ্ছে... দয়া করে অপেক্ষা করুন।",
        );

        // Handle file upload
        const fileData = await handleUserFileUpload(formattedPhone, message);

        if (fileData) {
          // Store file information
          fieldValue = {
            fileName: fileData.fileName,
            filePath: fileData.fileUrl, // Server path
            fileType: fileData.fileType,
            fileSize: fileData.fileSize,
            uploadedAt: new Date().toISOString(),
          };

          await sendTextMessage(
            formattedPhone,
            `✅ ফাইল আপলোড সফল!\n\n📁 ফাইল: ${fileData.fileName}\n📊 সাইজ: ${fileData.fileSize}\n\nএখন পরবর্তী ধাপে যাচ্ছি...`,
          );
        } else {
          await sendTextMessage(
            formattedPhone,
            "❌ ফাইল আপলোড ব্যর্থ। দয়া পরে চেষ্টা করুন।",
          );
          return;
        }
      } catch (uploadError) {
        EnhancedLogger.error(`File upload failed:`, uploadError);
        await sendTextMessage(
          formattedPhone,
          "❌ ফাইল আপলোডে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
        );
        return;
      }
    } else if (field.type === "text") {
      // Handle text input
      fieldValue = input.trim();

      if (field.required && !fieldValue) {
        await sendTextMessage(
          formattedPhone,
          `❌ '${field.label}' প্রয়োজনীয়। দয়া করে মান দিন।`,
        );
        return;
      }
    } else {
      await sendTextMessage(
        formattedPhone,
        `❌ '${field.label}' ফিল্ডের জন্য সঠিক ইনপুট দিন।`,
      );
      return;
    }

    // Store collected data
    const collectedData = serviceOrderData.collectedData || {};

    // Store field data in the format needed for Order model
    collectedData[field.name] = {
      label: field.label,
      type: field.type,
      data: fieldValue, // This will be either text string or file object
    };

    // Update state
    fieldIndex++;
    await stateManager.updateStateData(formattedPhone, {
      serviceOrder: {
        ...serviceOrderData,
        fieldIndex: fieldIndex,
        collectedData: collectedData,
      },
    });

    EnhancedLogger.debug(`Field collected for ${formattedPhone}`, {
      fieldName: field.name,
      fieldType: field.type,
      fieldValue: field.type === "file" ? "[FILE]" : fieldValue,
      fieldIndex,
      totalFields: service.requiredFields.length,
    });

    if (fieldIndex < service.requiredFields.length) {
      // Ask for next field
      await askForServiceField(phone, service, fieldIndex);
    } else {
      // All fields collected, ask for confirmation
      await askForServiceConfirmation(phone, service);
    }
  } catch (err) {
    EnhancedLogger.error(
      `Failed to process service field input for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ ইনপুট প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleEditServiceData(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Editing service data for ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const serviceOrderData = state?.data?.serviceOrder as ServiceOrderStateData;
    const serviceId = serviceOrderData?.serviceId;

    if (!serviceId) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য পাওয়া যায়নি!");
      await cancelFlow(formattedPhone, false);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);

    if (
      !service ||
      !service.requiredFields ||
      service.requiredFields.length === 0
    ) {
      await sendTextMessage(
        formattedPhone,
        "❌ এই সার্ভিসের কোন ফিল্ড নেই এডিট করার!",
      );
      await askForServiceConfirmation(phone, service as IService);
      return;
    }

    // Create field selection menu
    const fieldRows = service.requiredFields.map(
      (field: ServiceField, index: number) => {
        const fieldData = serviceOrderData.collectedData?.[field.name];
        let currentValue = "শূন্য";

        if (fieldData) {
          if (field.type === "file") {
            currentValue = "📁 ফাইল আপলোড করা হয়েছে";
          } else if (typeof fieldData === "object" && fieldData.data) {
            currentValue =
              fieldData.data.substring(0, 20) +
              (fieldData.data.length > 20 ? "..." : "");
          } else if (typeof fieldData === "string") {
            currentValue =
              fieldData.substring(0, 20) + (fieldData.length > 20 ? "..." : "");
          }
        }

        return {
          id: `edit_field_${index}`,
          title: field.label,
          description: `বর্তমান: ${currentValue}`,
        };
      },
    );

    // Add option to edit all fields
    fieldRows.push({
      id: "edit_all_fields",
      title: "📝 সব ফিল্ড এডিট করুন",
      description: "সমস্ত ফিল্ড আবার ইনপুট নিন",
    });

    await sendListMenu(
      formattedPhone,
      "✏️ তথ্য এডিট করুন",
      "কোন ফিল্ড এডিট করতে চান?",
      fieldRows,
      "ফিল্ডসমূহ",
      "ফিল্ড সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(
      `Failed to handle edit service data for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(formattedPhone, "❌ এডিট করতে সমস্যা হয়েছে!");
    await cancelFlow(formattedPhone, false);
  }
}

async function confirmServiceOrder(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Confirming service order for ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state || state.flowType !== "service_order") {
      await sendTextMessage(
        formattedPhone,
        "❌ কোন একটিভ অর্ডার পাওয়া যায়নি!",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    const serviceOrderData = state.data?.serviceOrder as ServiceOrderStateData;

    if (!serviceOrderData?.serviceId || !serviceOrderData.price) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceOrderData.serviceId);
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!service || !user) {
      await sendTextMessage(
        formattedPhone,
        "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!",
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < Number(serviceOrderData.price)) {
      await sendTextMessage(formattedPhone, `❌ অপর্যাপ্ত ব্যালেন্স!`);
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Validate all required fields are filled
    if (service.requiredFields && service.requiredFields.length > 0) {
      for (const field of service.requiredFields) {
        if (field.required && !serviceOrderData.collectedData?.[field.name]) {
          await sendTextMessage(
            formattedPhone,
            `❌ প্রয়োজনীয় ফিল্ড '${field.label}' পূরণ করা হয়নি।\n\nদয়া করে 'edit' বাটন ক্লিক করুন এবং তথ্য দিন।`,
          );
          return;
        }
      }
    }

    // Process collected data for storage
    // Process collected data for storage
    const processedServiceData: ServiceDataField[] = [];
    if (serviceOrderData.collectedData) {
      for (const [fieldName, fieldData] of Object.entries(
        serviceOrderData.collectedData,
      )) {
        const field = service.requiredFields?.find((f) => f.name === fieldName);
        if (field && (field.type === "text" || field.type === "file")) {
          const dataField: ServiceDataField = {
            field: fieldName,
            label: field.label,
            type: field.type,
            data: fieldData.data || "",
            createdAt: new Date(),
          };
          processedServiceData.push(dataField);
        }
      }
    }

    // Deduct balance
    user.balance -= Number(serviceOrderData.price);
    await user.save();

    // Create transaction
    const transaction = await Transaction.create({
      trxId: `ORDER-${Date.now()}`,
      amount: serviceOrderData.price,
      method: "balance",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      metadata: {
        serviceId: serviceOrderData.serviceId,
        serviceName: serviceOrderData.serviceName,
        fieldCount: processedServiceData.length,
      },
      createdAt: new Date(),
    });

    // Create order
    const order = await Order.create({
      orderId: `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      userId: user._id,
      serviceId: service._id,
      serviceName: service.name,
      quantity: 1,
      unitPrice: serviceOrderData.price,
      totalPrice: serviceOrderData.price,
      serviceData: processedServiceData,
      status: "pending",
      transactionId: transaction._id,
      placedAt: new Date(),
      createdAt: new Date(),
    });

    // Send success message
    const successMessage =
      `✅ *অর্ডার সফল*\n\n` +
      `📦 সার্ভিস: ${service.name}\n` +
      `🆔 অর্ডার আইডি: ${order.orderId}\n` +
      `💰 খরচ: ৳${serviceOrderData.price}\n` +
      `🆕 ব্যালেন্স: ৳${user.balance}\n` +
      `📅 সময়: ${new Date().toLocaleString()}\n\n` +
      `🎉 আপনার অর্ডারটি সফলভাবে প্লেস করা হয়েছে!\n\n` +
      `আমাদের সাপোর্ট টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে।\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, successMessage);

    // Notify admin
    let adminMessage = `🛒 নতুন অর্ডার\n\n`;
    adminMessage += `ব্যবহারকারী: ${formattedPhone}\n`;
    adminMessage += `নাম: ${user.name}\n`;
    adminMessage += `অর্ডার আইডি: ${order.orderId}\n`;
    adminMessage += `সার্ভিস: ${service.name}\n`;
    adminMessage += `মূল্য: ৳${serviceOrderData.price}\n`;
    adminMessage += `ইউজার ব্যালেন্স: ৳${user.balance}\n\n`;
    adminMessage += `📋 *প্রদত্ত তথ্য:*\n`;

    processedServiceData.forEach((fieldData: ServiceDataField) => {
      if (fieldData.type === "file") {
        adminMessage += `• ${fieldData.label}: 📁 ফাইল\n`;
      } else {
        adminMessage += `• ${fieldData.label}: ${fieldData.data}\n`;
      }
    });

    await notifyAdmin(adminMessage);

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);

    EnhancedLogger.logFlowCompletion(formattedPhone, "service_order", {
      orderId: order._id,
      orderNumber: order.orderId,
      serviceId: serviceOrderData.serviceId,
      serviceName: serviceOrderData.serviceName,
      price: serviceOrderData.price,
      newBalance: user.balance,
      fieldCount: processedServiceData.length,
    });
  } catch (err: any) {
    EnhancedLogger.error(
      `Failed to confirm service order for ${formattedPhone}:`,
      {
        error: err.message,
        stack: err.stack,
      },
    );

    // More specific error message
    let errorMessage =
      "❌ অর্ডার কনফার্ম করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।";

    if (err.message.includes("validation")) {
      errorMessage = "❌ ডাটা ভ্যালিডেশন ত্রুটি হয়েছে। দয়া পরে চেষ্টা করুন।";
    } else if (err.message.includes("duplicate")) {
      errorMessage = "❌ ডুপ্লিকেট অর্ডার আইডি। দয়া পরে চেষ্টা করুন।";
    } else if (err.message.includes("connection")) {
      errorMessage = "❌ ডাটাবেজ কানেকশন সমস্যা। দয়া পরে চেষ্টা করুন।";
    }

    await sendTextMessage(formattedPhone, errorMessage);
    await showMainMenu(formattedPhone, false);
  }
}

// --- Order History ---
async function showOrderHistory(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing order history for ${formattedPhone}`);

  try {
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    const orders = await Order.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10);

    if (orders.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "📭 *আপনার অর্ডারসমূহ*\n\nআপনার কোন অর্ডার নেই।\n\n🛒 নতুন অর্ডার করতে 'সার্ভিস' লিখুন।\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    let message = "📦 *আপনার অর্ডারসমূহ:*\n\n";

    orders.forEach((order, index) => {
      const serviceName = order.serviceName || "Unknown Service";
      const statusMap = {
        pending: "⏳ পেন্ডিং",
        processing: "🔄 প্রসেসিং",
        completed: "✅ কমপ্লিটেড",
        failed: "❌ ফেইলড",
        cancelled: "🚫 ক্যান্সেলড",
      };
      const statusText =
        statusMap[order.status as keyof typeof statusMap] || "📝 অজানা";

      message += `${index + 1}. ${serviceName}\n`;
      message += `   🆔: ${order._id}\n`;
      message += `   📊: ${statusText}\n`;
      message += `   💰: ৳${order.totalPrice}\n`;
      message += `   📅: ${new Date(order.placedAt).toLocaleDateString()}\n\n`;
    });

    message += `📊 মোট অর্ডার: ${orders.length}\n`;
    message += `💰 মোট খরচ: ৳${orders.reduce((sum, order) => sum + order.totalPrice, 0)}\n\n`;
    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    EnhancedLogger.info(`Order history sent to ${formattedPhone}`, {
      count: orders.length,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show order history for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ অর্ডার হিস্টরি লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Account Info ---
async function showAccountInfo(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing account info for ${formattedPhone}`);

  try {
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Get additional stats
    const totalOrders = await Order.countDocuments({ userId: user._id });
    const totalSpentResult = await Order.aggregate([
      { $match: { userId: user._id } },
      { $group: { _id: null, total: { $sum: "$totalPrice" } } },
    ]);
    const totalSpent = totalSpentResult[0]?.total || 0;

    const recentTransactions = await Transaction.find({ user: user._id })
      .sort({ createdAt: -1 })
      .limit(3);

    let message =
      `👤 *আপনার অ্যাকাউন্ট তথ্য*\n\n` +
      `📛 নাম: ${user.name}\n` +
      `📱 নম্বর: ${user.whatsapp}\n` +
      `💰 ব্যালেন্স: ৳${user.balance}\n` +
      `🛒 মোট অর্ডার: ${totalOrders}\n` +
      `💸 মোট খরচ: ৳${totalSpent}\n` +
      `📅 যোগদান: ${new Date(user.createdAt).toLocaleDateString()}\n` +
      `📊 মোট মেসেজ: ${user.whatsappMessageCount}\n\n` +
      `📜 *সাম্প্রতিক ট্রান্সাকশন:*\n`;

    if (recentTransactions.length > 0) {
      recentTransactions.forEach((trx, index) => {
        const type = trx.method === "balance" ? "🛒 সার্ভিস" : "💵 রিচার্জ";
        const sign = trx.method === "balance" ? "-" : "+";
        message += `${index + 1}. ${type}: ${sign}৳${trx.amount}\n`;
      });
    } else {
      message += `কোন ট্রান্সাকশন নেই\n`;
    }

    message += `\n📞 সাপোর্ট: ${CONFIG.supportNumber}\n`;
    message += `📱 টেলিগ্রাম: ${CONFIG.supportTelegram}\n\n`;
    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);
    EnhancedLogger.info(`Account info sent to ${formattedPhone}`);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show account info for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ অ্যাকাউন্ট তথ্য লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Support ---
async function showSupport(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing support info to ${formattedPhone}`);

  try {
    const message =
      `🎧 *সাপোর্ট ও হেল্প*\n\n` +
      `আমরা আপনার সার্ভিস সম্পর্কিত যে কোন সমস্যায় সাহায্য করতে প্রস্তুত।\n\n` +
      `📞 হোয়াটসঅ্যাপ: ${CONFIG.supportNumber}\n` +
      `📱 টেলিগ্রাম: ${CONFIG.supportTelegram}\n` +
      `⏰ সময়: সকাল ৯টা - রাত ১১টা\n\n` +
      `*সাধারণ সমস্যা সমাধান:*\n` +
      `• রিচার্জ সমস্যা → বিকাশ টিআরএক্স আইডি চেক করুন\n` +
      `• অর্ডার স্ট্যাটাস → 'অর্ডার' লিখে দেখুন\n` +
      `• ব্যালেন্স কম → 'রিচার্জ' লিখুন\n` +
      `• সার্ভিস সমস্যা → সরাসরি মেসেজ করুন\n\n` +
      `প্রয়োজনে সরাসরি মেসেজ করুন।\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);
    EnhancedLogger.info(`Support info sent to ${formattedPhone}`);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show support info to ${formattedPhone}:`,
      err,
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Transaction History ---
async function showTransactionHistory(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Showing transaction history for ${formattedPhone}`);

  try {
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    const transactions = await Transaction.find({ user: user._id })
      .sort({ createdAt: -1 })
      .limit(10);

    if (transactions.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "📭 *ট্রান্সাকশন হিস্টরি*\n\nআপনার কোন ট্রান্সাকশন নেই।\n\n💵 প্রথম ট্রান্সাকশন করতে 'রিচার্জ' লিখুন।\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    let message = "📜 *ট্রান্সাকশন হিস্টরি:*\n\n";

    transactions.forEach((trx, index) => {
      const typeMap = {
        bkash: "💵 রিচার্জ",
        balance: "🛒 সার্ভিস",
        admin_add: "💰 অ্যাডমিন যোগ",
        admin_deduct: "💰 অ্যাডমিন কাট",
      };
      const type = typeMap[trx.method as keyof typeof typeMap] || "📝 অন্যান্য";
      const sign =
        trx.method === "bkash" || trx.method === "admin_add" ? "+" : "-";

      message += `${index + 1}. ${type}\n`;
      message += `   💰: ${sign}৳${trx.amount}\n`;
      message += `   🆔: ${trx.trxId}\n`;
      message += `   📅: ${new Date(trx.createdAt).toLocaleDateString()}\n\n`;
    });

    const totalDeposit = transactions
      .filter((t) => t.method === "bkash" || t.method === "admin_add")
      .reduce((sum, t) => sum + t.amount, 0);

    const totalWithdraw = transactions
      .filter((t) => t.method === "balance" || t.method === "admin_deduct")
      .reduce((sum, t) => sum + t.amount, 0);

    message += `📊 *সারাংশ:*\n`;
    message += `• মোট জমা: +৳${totalDeposit}\n`;
    message += `• মোট খরচ: -৳${totalWithdraw}\n`;
    message += `• নেট ব্যালেন্স: ৳${user.balance}\n\n`;
    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);

    EnhancedLogger.info(`Transaction history sent to ${formattedPhone}`, {
      count: transactions.length,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show transaction history for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(
      formattedPhone,
      "❌ ট্রান্সাকশন হিস্টরি লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।",
    );
    await showMainMenu(formattedPhone, false);
  }
}

// ================= ADMIN FEATURES =================

// --- Admin Service Management ---
async function handleAdminServices(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin service management for ${formattedPhone}`);

  const serviceMenuRows = [
    {
      id: "admin_add_service",
      title: "➕ নতুন সার্ভিস যোগ করুন",
      description: "একটি নতুন সার্ভিস তৈরি করুন",
    },
    {
      id: "admin_edit_service",
      title: "✏️ সার্ভিস এডিট করুন",
      description: "বিদ্যমান সার্ভিস এডিট করুন",
    },
    {
      id: "admin_delete_service",
      title: "🗑️ সার্ভিস ডিলিট করুন",
      description: "সার্ভিস ডিলিট করুন",
    },
    {
      id: "admin_view_services",
      title: "👁️ সার্ভিস তালিকা দেখুন",
      description: "সকল সার্ভিসের তালিকা দেখুন",
    },
    {
      id: "admin_toggle_service",
      title: "🔀 সার্ভিস একটিভ/ইনএকটিভ",
      description: "সার্ভিস স্ট্যাটাস পরিবর্তন করুন",
    },
    {
      id: "admin_service_stats",
      title: "📊 সার্ভিস স্ট্যাটিসটিক্স",
      description: "সার্ভিস পারফরমেন্স রিপোর্ট",
    },
  ];

  await sendListMenu(
    phone,
    "📦 সার্ভিস ম্যানেজমেন্ট",
    "সার্ভিস ম্যানেজমেন্ট অপশন সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
    serviceMenuRows,
    "সার্ভিস ম্যানেজমেন্ট",
    "অপশন দেখুন",
  );
}

// --- Admin Add Service ---
async function handleAdminAddServiceStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting add service for ${formattedPhone}`);

  await stateManager.setUserState(formattedPhone, {
    currentState: "admin_add_service_name",
    flowType: "admin_add_service",
    data: {
      adminAddService: {
        step: 1, // Start at step 1 (service name)
        serviceData: {
          requiredFields: [],
        },
      },
      lastActivity: Date.now(),
      sessionId: Date.now().toString(36),
    },
  });

  await sendTextWithCancelButton(
    phone,
    "📝 *নতুন সার্ভিস তৈরি করুন*\n\nপ্রথমে সার্ভিসের নাম লিখুন:\n\nউদাহরণ: 'ডিজাইন সার্ভিস'\n\n📌 নামটি পরিষ্কার ও বর্ণনামূলক হোক",
  );
}

async function handleAdminAddServiceStep(
  phone: string,
  input: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const step = state?.data?.adminAddService?.step || 1;

  EnhancedLogger.info(`Admin add service step ${step} for ${formattedPhone}`, {
    input,
  });

  try {
    switch (step) {
      case 1: // Service Name
        if (!input.trim()) {
          await sendTextMessage(phone, "❌ দয়া করে একটি নাম লিখুন!");
          return;
        }

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            step: 2,
            serviceData: {
              name: input.trim(),
              requiredFields: [],
            },
          },
        });

        await sendTextWithCancelButton(
          phone,
          "📝 *সার্ভিসের বিবরণ লিখুন*\n\nসার্ভিসটি সম্পর্কে সংক্ষিপ্ত বিবরণ দিন:",
        );
        break;

      case 2: // Service Description
        if (!input.trim()) {
          await sendTextMessage(phone, "❌ দয়া করে একটি বিবরণ লিখুন!");
          return;
        }

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            step: 3,
            serviceData: {
              ...state?.data?.adminAddService?.serviceData,
              description: input.trim(),
            },
          },
        });

        await sendTextWithCancelButton(
          phone,
          "💰 *সার্ভিসের মূল্য লিখুন*\n\nসার্ভিসের মূল্য টাকায় লিখুন:\n\nউদাহরণ: 100",
        );
        break;

      case 3: // Service Price
        const price = parseFloat(input);
        if (isNaN(price) || price <= 0 || price > 1000000) {
          await sendTextMessage(
            phone,
            "❌ দয়া করে ১ থেকে ১০,০০,০০০ এর মধ্যে সঠিক মূল্য লিখুন!",
          );
          return;
        }

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            step: 4,
            serviceData: {
              ...state?.data?.adminAddService?.serviceData,
              price: price,
            },
          },
        });

        await sendTextWithCancelButton(
          phone,
          "📋 *সার্ভিস নির্দেশনা লিখুন*\n\nগ্রাহকদের জন্য নির্দেশনা লিখুন:\n\nস্কিপ করতে 'skip' লিখুন",
        );
        break;

      case 4: // Service Instructions
        const instructions = input.toLowerCase() === "skip" ? "" : input.trim();
        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            step: 5,
            serviceData: {
              ...state?.data?.adminAddService?.serviceData,
              instructions: instructions,
            },
          },
        });

        await sendQuickReplyMenu(
          phone,
          "📋 প্রয়োজনীয় তথ্য\n\nসার্ভিসের জন্য প্রয়োজনীয় তথ্য/ফিল্ড যোগ করবেন?",
          [
            { id: "add_fields_yes", title: "➕ ফিল্ড যোগ করুন" },
            { id: "add_fields_no", title: "➡️ পরবর্তী ধাপ" },
          ],
        );
        break;

      case 5: // Add Fields Decision
        if (input === "add_fields_yes") {
          await stateManager.updateStateData(formattedPhone, {
            adminAddService: {
              step: 6, // Field name step
              serviceData: state?.data?.adminAddService?.serviceData,
            },
          });

          await sendTextWithCancelButton(
            phone,
            "📝 *প্রথম ফিল্ডের নাম লিখুন*\n\nফিল্ডের অভ্যন্তরীণ নাম লিখুন (ইংরেজিতে, স্পেস ছাড়া):\n\nউদাহরণ: 'full_name', 'document_file'",
          );
        } else {
          await finalizeServiceCreation(phone);
        }
        break;

      case 6: // Field Name
        if (!input.trim()) {
          await sendTextMessage(phone, "❌ দয়া করে একটি ফিল্ড নাম লিখুন!");
          return;
        }

        const fieldName = input.trim().toLowerCase().replace(/\s+/g, "_");

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            ...state?.data?.adminAddService,
            currentField: {
              name: fieldName,
            },
            step: 7, // Move to field label step
          },
        });

        await sendTextWithCancelButton(
          phone,
          `📝 *ফিল্ডের লেবেল লিখুন*\n\nফিল্ডের লেবেল লিখুন (ব্যবহারকারী দেখবে):\n\nউদাহরণ: 'আপনার পূর্ণ নাম', 'ডকুমেন্ট আপলোড করুন'`,
        );
        break;

      case 7: // Field Label
        if (!input.trim()) {
          await sendTextMessage(phone, "❌ দয়া করে একটি লেবেল লিখুন!");
          return;
        }

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            ...state?.data?.adminAddService,
            currentField: {
              ...state?.data?.adminAddService?.currentField,
              label: input.trim(),
            },
            step: 8, // Move to field type step
          },
        });

        await sendQuickReplyMenu(
          phone,
          "📋 ফিল্ডের ধরন\n\nফিল্ডের ধরন সিলেক্ট করুন:",
          [
            { id: "field_type_text", title: "📝 টেক্সট" },
            { id: "field_type_file", title: "📁 ফাইল" },
          ],
        );
        break;

      case 8: // Field Type
        let fieldType: "text" | "file" = "text";
        if (input === "field_type_file") {
          fieldType = "file";
        }

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            ...state?.data?.adminAddService,
            currentField: {
              ...state?.data?.adminAddService?.currentField,
              type: fieldType,
            },
            step: 9, // Move to field required step
          },
        });

        await sendQuickReplyMenu(
          phone,
          "📋 প্রয়োজনীয়তা\n\nফিল্ডটি কি প্রয়োজনীয়?",
          [
            { id: "field_required_yes", title: "✅ প্রয়োজনীয়" },
            { id: "field_required_no", title: "➡️ ঐচ্ছিক" },
          ],
        );
        break;

      case 9: // Field Required
        const required = input === "field_required_yes";
        const currentField = state?.data?.adminAddService?.currentField;

        if (!currentField) {
          throw new Error("Current field not found");
        }

        const completedField: ServiceField = {
          id: `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: currentField.name || "",
          label: currentField.label || "",
          type: currentField.type || "text",
          required: required,
          description: "",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const serviceData = state?.data?.adminAddService?.serviceData;
        const updatedFields = [
          ...(serviceData?.requiredFields || []),
          completedField,
        ];

        await stateManager.updateStateData(formattedPhone, {
          adminAddService: {
            step: 10, // Move to add more fields decision
            serviceData: {
              ...serviceData,
              requiredFields: updatedFields,
            },
            currentField: undefined, // Clear current field
          },
        });

        await sendQuickReplyMenu(
          phone,
          `✅ ফিল্ড যোগ করা হয়েছে\n\nফিল্ড: ${completedField.label}\nটাইপ: ${completedField.type}\nপ্রয়োজনীয়: ${completedField.required ? "হ্যাঁ" : "না"}\n\nআরেকটি ফিল্ড যোগ করবেন?`,
          [
            { id: "add_more_fields_yes", title: "➕ আরেকটি যোগ করুন" },
            { id: "add_more_fields_no", title: "✅ শেষ করুন" },
          ],
        );
        break;

      case 10: // Add More Fields Decision
        if (input === "add_more_fields_yes") {
          await stateManager.updateStateData(formattedPhone, {
            adminAddService: {
              ...state?.data?.adminAddService,
              step: 6, // Go back to field name step
            },
          });

          await sendTextWithCancelButton(
            phone,
            "📝 *পরবর্তী ফিল্ডের নাম লিখুন*\n\nফিল্ডের অভ্যন্তরীণ নাম লিখুন (ইংরেজিতে, স্পেস ছাড়া):",
          );
        } else {
          await finalizeServiceCreation(phone);
        }
        break;

      default:
        await sendTextMessage(phone, "❌ অজানা ধাপ!");
        await cancelFlow(phone, true);
    }
  } catch (err) {
    EnhancedLogger.error(`Error in admin add service step ${step}:`, err);
    await sendTextMessage(phone, "❌ ত্রুটি হয়েছে। দয়া পরে চেষ্টা করুন।");
    await cancelFlow(phone, true);
  }
}

async function finalizeServiceCreation(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Finalizing service creation for ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const serviceData = state?.data?.adminAddService?.serviceData;

    if (
      !serviceData ||
      !serviceData.name ||
      !serviceData.description ||
      !serviceData.price
    ) {
      await sendTextMessage(phone, "❌ সার্ভিস তথ্য অসম্পূর্ণ!");
      await cancelFlow(phone, true);
      return;
    }

    await connectDB();

    // Check if service with same name exists
    const existingService = await Service.findOne({
      name: { $regex: new RegExp(`^${serviceData.name}$`, "i") },
    });

    if (existingService) {
      await sendTextMessage(phone, "❌ এই নামে একটি সার্ভিস ইতিমধ্যে আছে!");
      await cancelFlow(phone, true);
      return;
    }

    // Create the service
    const newService = await Service.create({
      name: serviceData.name,
      description: serviceData.description,
      price: serviceData.price,
      instructions: serviceData.instructions || "",
      requiredFields: serviceData.requiredFields || [],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let message =
      `✅ *সার্ভিস তৈরি সফল*\n\n` +
      `📦 সার্ভিস: ${serviceData.name}\n` +
      `💰 মূল্য: ৳${serviceData.price}\n` +
      `📝 বিবরণ: ${serviceData.description}\n` +
      `📋 ফিল্ড সংখ্যা: ${serviceData.requiredFields?.length || 0}\n` +
      `🆔 সার্ভিস আইডি: ${newService._id}\n\n`;

    // List all fields
    if (serviceData.requiredFields && serviceData.requiredFields.length > 0) {
      message += `📋 *ফিল্ডসমূহ:*\n`;
      serviceData.requiredFields.forEach(
        (field: ServiceField, index: number) => {
          message += `${index + 1}. ${field.label} (${field.type}) - ${field.required ? "প্রয়োজনীয়" : "ঐচ্ছিক"}\n`;
        },
      );
      message += `\n`;
    }

    message +=
      `🎉 সার্ভিস সফলভাবে তৈরি করা হয়েছে!\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, message);

    await notifyAdmin(
      `📦 নতুন সার্ভিস তৈরি করা হয়েছে\n\nসার্ভিস: ${serviceData.name}\nমূল্য: ৳${serviceData.price}\nতৈরি করেছেন: ${formattedPhone}\nসার্ভিস আইডি: ${newService._id}\nফিল্ড সংখ্যা: ${serviceData.requiredFields?.length || 0}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_add_service", {
      serviceId: newService._id,
      serviceName: serviceData.name,
      price: serviceData.price,
      fieldCount: serviceData.requiredFields?.length || 0,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to finalize service creation:`, err);
    await sendTextMessage(phone, "❌ সার্ভিস তৈরি করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

// --- Admin View Services ---
async function handleAdminViewServices(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin viewing services for ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().sort({ createdAt: -1 }).limit(15);

    if (services.length === 0) {
      await sendTextMessage(phone, "📭 কোন সার্ভিস পাওয়া যায়নি।");
      await showMainMenu(phone, true);
      return;
    }

    let message = "📦 *সার্ভিস তালিকা:*\n\n";

    services.forEach((service, index) => {
      const status = service.isActive ? "✅" : "❌";
      const fieldCount = service.requiredFields?.length || 0;

      message += `${index + 1}. ${status} ${service.name}\n`;
      message += `   💰: ৳${service.price}\n`;
      message += `   📋: ${fieldCount} ফিল্ড\n`;
      message += `   🆔: ${service._id}\n`;
      message += `   📅: ${new Date(service.createdAt).toLocaleDateString()}\n\n`;
    });

    const totalServices = await Service.countDocuments();
    const activeServices = await Service.countDocuments({ isActive: true });
    const totalRevenue = await Service.aggregate([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "serviceId",
          as: "orders",
        },
      },
      { $unwind: "$orders" },
      {
        $group: {
          _id: null,
          total: { $sum: "$orders.totalPrice" },
        },
      },
    ]);

    const revenue = totalRevenue[0]?.total || 0;

    message += `📊 *স্ট্যাটিসটিক্স:*\n`;
    message += `• মোট সার্ভিস: ${totalServices}\n`;
    message += `• সক্রিয় সার্ভিস: ${activeServices}\n`;
    message += `• মোট আয়: ৳${revenue}\n\n`;

    await sendTextMessage(phone, message);
    await showMainMenu(phone, true);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show services to admin ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

// --- Admin Edit Service ---
async function handleAdminEditServiceStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting edit service for ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().sort({ name: 1 }).limit(15);

    if (services.length === 0) {
      await sendTextMessage(phone, "📭 কোন সার্ভিস পাওয়া যায়নি।");
      await showMainMenu(phone, true);
      return;
    }

    const serviceRows = services.map((service) => ({
      id: `edit_${service._id}`,
      title: `${service.isActive ? "✅" : "❌"} ${service.name} - ৳${service.price}`,
      description: service.description.substring(0, 50) + "...",
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "admin_edit_service_select",
      flowType: "admin_edit_service",
      data: {
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    await sendListMenu(
      phone,
      "✏️ সার্ভিস এডিট করুন",
      "এডিট করতে চান এমন সার্ভিস সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "সার্ভিসসমূহ",
      "সার্ভিস সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(
      `Failed to start edit service for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminEditServiceSelection(
  phone: string,
  serviceId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const actualServiceId = serviceId.replace("edit_", "");
  EnhancedLogger.info(`Admin selected service for edit: ${actualServiceId}`);

  try {
    await connectDB();
    const service = await Service.findById(actualServiceId);

    if (!service) {
      await sendTextMessage(phone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(phone, true);
      return;
    }

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        serviceId: actualServiceId,
        serviceData: service.toObject(),
        step: 1,
      },
    });

    const editMenuRows = [
      {
        id: "edit_name",
        title: "📛 নাম পরিবর্তন",
        description: "সার্ভিসের নাম পরিবর্তন করুন",
      },
      {
        id: "edit_description",
        title: "📝 বিবরণ পরিবর্তন",
        description: "সার্ভিসের বিবরণ পরিবর্তন করুন",
      },
      {
        id: "edit_price",
        title: "💰 মূল্য পরিবর্তন",
        description: "সার্ভিসের মূল্য পরিবর্তন করুন",
      },
      {
        id: "edit_instructions",
        title: "📋 নির্দেশনা পরিবর্তন",
        description: "সার্ভিসের নির্দেশনা পরিবর্তন করুন",
      },
      {
        id: "edit_status",
        title: "🔀 স্ট্যাটাস পরিবর্তন",
        description: "সার্ভিস সক্রিয়/নিষ্ক্রিয় করুন",
      },
      {
        id: "edit_fields",
        title: "📋 ফিল্ড ম্যানেজমেন্ট",
        description: "প্রয়োজনীয় ফিল্ডসমূহ ম্যানেজ করুন",
      },
    ];

    await sendListMenu(
      phone,
      `✏️ ${service.name} এডিট করুন`,
      "কি পরিবর্তন করতে চান?\n\nবর্তমান তথ্য:\n• মূল্য: ৳${service.price}\n• স্ট্যাটাস: ${service.isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'}\n• ফিল্ড: ${service.requiredFields?.length || 0}টি\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      editMenuRows,
      "এডিট অপশন",
      "অপশন সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(`Failed to handle edit service selection:`, err);
    await sendTextMessage(phone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminEditServiceOption(
  phone: string,
  optionId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin editing service option: ${optionId}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const serviceId = state?.data?.adminEditService?.serviceId;

    if (!serviceId) {
      await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
      await cancelFlow(phone, true);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);
    if (!service) {
      await sendTextMessage(phone, "❌ সার্ভিস পাওয়া যায়নি!");
      await cancelFlow(phone, true);
      return;
    }

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        ...state.data?.adminEditService,
        editOption: optionId,
        step: 2,
      },
    });

    let message = "";
    switch (optionId) {
      case "edit_name":
        message = `বর্তমান নাম: ${service.name}\n\nনতুন নাম লিখুন:`;
        break;
      case "edit_description":
        message = `বর্তমান বিবরণ: ${service.description}\n\nনতুন বিবরণ লিখুন:`;
        break;
      case "edit_price":
        message = `বর্তমান মূল্য: ৳${service.price}\n\nনতুন মূল্য লিখুন:`;
        break;
      case "edit_instructions":
        message = `বর্তমান নির্দেশনা: ${service.instructions || "নেই"}\n\nনতুন নির্দেশনা লিখুন:\n\nস্কিপ করতে 'skip' লিখুন`;
        break;
      case "edit_status":
        const newStatus = !service.isActive;
        await Service.findByIdAndUpdate(serviceId, { isActive: newStatus });

        await sendTextMessage(
          phone,
          `✅ *স্ট্যাটাস পরিবর্তন করা হয়েছে*\n\nসার্ভিস: ${service.name}\nনতুন স্ট্যাটাস: ${newStatus ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"}\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
        );

        await notifyAdmin(
          `🔀 সার্ভিস স্ট্যাটাস পরিবর্তন\n\nসার্ভিস: ${service.name}\nনতুন স্ট্যাটাস: ${newStatus ? "সক্রিয়" : "নিষ্ক্রিয়"}\nপরিবর্তন করেছেন: ${formattedPhone}`,
        );

        await stateManager.clearUserState(formattedPhone);
        await showMainMenu(phone, true);
        return;
      case "edit_fields":
        await handleAdminEditServiceFields(phone);
        return;
    }

    await sendTextWithCancelButton(phone, message);
  } catch (err) {
    EnhancedLogger.error(`Failed to handle edit service option:`, err);
    await sendTextMessage(phone, "❌ অপশন প্রসেস করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

async function handleAdminEditServiceUpdate(
  phone: string,
  input: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const serviceId = state?.data?.adminEditService?.serviceId;
  const editOption = state?.data?.adminEditService?.editOption;

  if (!serviceId || !editOption) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  EnhancedLogger.info(`Admin updating service ${editOption}`, {
    serviceId,
    editOption,
    input,
  });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);
    if (!service) {
      await sendTextMessage(phone, "❌ সার্ভিস পাওয়া যায়নি!");
      await cancelFlow(phone, true);
      return;
    }

    const updateData: any = {};
    let updateField = "";
    let newValue = "";

    switch (editOption) {
      case "edit_name":
        if (!input.trim()) {
          await sendTextMessage(phone, "❌ দয়া করে একটি নাম লিখুন!");
          return;
        }
        updateData.name = input.trim();
        updateField = "নাম";
        newValue = input.trim();
        break;
      case "edit_description":
        if (!input.trim()) {
          await sendTextMessage(phone, "❌ দয়া করে একটি বিবরণ লিখুন!");
          return;
        }
        updateData.description = input.trim();
        updateField = "বিবরণ";
        newValue = input.trim();
        break;
      case "edit_price":
        const newPrice = parseFloat(input);
        if (isNaN(newPrice) || newPrice <= 0 || newPrice > 1000000) {
          await sendTextMessage(
            phone,
            "❌ দয়া করে ১ থেকে ১০,০০,০০০ এর মধ্যে সঠিক মূল্য লিখুন!",
          );
          return;
        }
        updateData.price = newPrice;
        updateField = "মূল্য";
        newValue = `৳${newPrice}`;
        break;
      case "edit_instructions":
        updateData.instructions =
          input.toLowerCase() === "skip" ? "" : input.trim();
        updateField = "নির্দেশনা";
        newValue =
          input.toLowerCase() === "skip" ? "রিমুভ করা হয়েছে" : input.trim();
        break;
    }

    await Service.findByIdAndUpdate(serviceId, updateData);

    await sendTextMessage(
      phone,
      `✅ *সার্ভিস আপডেট করা হয়েছে*\n\nসার্ভিস: ${service.name}\nফিল্ড: ${updateField}\nনতুন মান: ${newValue}\n\n🎉 পরিবর্তনগুলি সফলভাবে সংরক্ষণ করা হয়েছে!\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
    );

    await notifyAdmin(
      `✏️ সার্ভিস আপডেট করা হয়েছে\n\nসার্ভিস: ${service.name}\nফিল্ড: ${updateField}\nনতুন মান: ${newValue}\nআপডেট করেছেন: ${formattedPhone}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_edit_service", {
      serviceId,
      editOption,
      oldValue: service[editOption.replace("edit_", "") as keyof IService],
      newValue: input,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to update service:`, err);
    await sendTextMessage(phone, "❌ আপডেট করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

async function handleAdminEditServiceFields(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const serviceId = state?.data?.adminEditService?.serviceId;

  if (!serviceId) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  const fieldMenuRows = [
    {
      id: "fields_add",
      title: "➕ নতুন ফিল্ড যোগ করুন",
      description: "সার্ভিসে নতুন ফিল্ড যোগ করুন",
    },
    {
      id: "fields_view",
      title: "👁️ ফিল্ডসমূহ দেখুন",
      description: "সকল ফিল্ড দেখুন",
    },
    {
      id: "fields_remove",
      title: "🗑️ ফিল্ড রিমুভ করুন",
      description: "ফিল্ড রিমুভ করুন",
    },
  ];

  await sendListMenu(
    phone,
    "📋 ফিল্ড ম্যানেজমেন্ট",
    "ফিল্ড ম্যানেজমেন্ট অপশন সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
    fieldMenuRows,
    "ফিল্ড অপশন",
    "অপশন সিলেক্ট করুন",
  );
}

// --- Admin Delete Service ---
async function handleAdminDeleteServiceStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting delete service for ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().sort({ name: 1 }).limit(15);

    if (services.length === 0) {
      await sendTextMessage(phone, "📭 কোন সার্ভিস পাওয়া যায়নি।");
      await showMainMenu(phone, true);
      return;
    }

    const serviceRows = await Promise.all(
      services.map(async (service) => ({
        id: `delete_${service._id}`,
        title: `${service.name} - ৳${service.price}`,
        description: `অর্ডার: ${await Order.countDocuments({ serviceId: service._id })}টি`,
      })),
    );

    await stateManager.setUserState(formattedPhone, {
      currentState: "admin_delete_service_select",
      flowType: "admin_delete_service",
      data: {
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    await sendListMenu(
      phone,
      "🗑️ সার্ভিস ডিলিট করুন",
      "ডিলিট করতে চান এমন সার্ভিস সিলেক্ট করুন:\n\n⚠️ সতর্কতা: সার্ভিস ডিলিট করলে সংশ্লিষ্ট সকল তথ্য চিরতরে মুছে যাবে!\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "সার্ভিসসমূহ",
      "সার্ভিস সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(
      `Failed to start delete service for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminDeleteServiceConfirm(
  phone: string,
  serviceId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const actualServiceId = serviceId.replace("delete_", "");
  EnhancedLogger.info(
    `Admin confirming delete for service: ${actualServiceId}`,
  );

  try {
    await connectDB();
    const service = await Service.findById(actualServiceId);

    if (!service) {
      await sendTextMessage(phone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(phone, true);
      return;
    }

    const orderCount = await Order.countDocuments({
      serviceId: actualServiceId,
    });

    await stateManager.updateStateData(formattedPhone, {
      adminDeleteService: {
        serviceId: actualServiceId,
        serviceName: service.name,
      },
    });

    const warningMessage =
      orderCount > 0
        ? `⚠️ এই সার্ভিসের সাথে ${orderCount}টি অর্ডার জড়িত আছে!\nসার্ভিস ডিলিট করলে এই অর্ডারগুলোর তথ্য হারিয়ে যেতে পারে।\n\n`
        : "";

    await sendQuickReplyMenu(
      phone,
      `⚠️ ডিলিট কনফার্মেশন\n\n${warningMessage}আপনি কি "${service.name}" সার্ভিসটি ডিলিট করতে চান?\n\n💰 মূল্য: ৳${service.price}\n📅 তৈরি: ${new Date(service.createdAt).toLocaleDateString()}\n\nএটি পার্মানেন্টলি ডিলিট হবে!`,
      [
        { id: "confirm_delete", title: "✅ ডিলিট করুন" },
        { id: "cancel_delete", title: "❌ বাতিল করুন" },
      ],
    );
  } catch (err) {
    EnhancedLogger.error(`Failed to confirm delete service:`, err);
    await sendTextMessage(phone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminDeleteServiceExecute(
  phone: string,
  confirm: boolean,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const serviceId = state?.data?.adminDeleteService?.serviceId;
  const serviceName = state?.data?.adminDeleteService?.serviceName;

  if (!serviceId || !serviceName) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  if (!confirm) {
    await sendTextMessage(phone, "🚫 ডিলিট বাতিল করা হয়েছে।");
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);
    return;
  }

  try {
    await connectDB();

    // Check if service has active orders
    const activeOrders = await Order.countDocuments({
      serviceId: serviceId,
      status: { $in: ["pending", "processing"] },
    });

    if (activeOrders > 0) {
      await sendTextMessage(
        phone,
        `❌ *ডিলিট সম্ভব নয়*\n\nএই সার্ভিসের ${activeOrders}টি সক্রিয় অর্ডার আছে।\nঅর্ডারগুলি প্রথমে কমপ্লিট বা ক্যান্সেল করুন।`,
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(phone, true);
      return;
    }

    // Delete the service
    await Service.findByIdAndDelete(serviceId);

    await sendTextMessage(
      phone,
      `✅ *সার্ভিস ডিলিট করা হয়েছে*\n\nসার্ভিস: ${serviceName}\n🆔: ${serviceId}\n\n🗑️ সার্ভিস সফলভাবে ডিলিট করা হয়েছে!\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
    );

    await notifyAdmin(
      `🗑️ সার্ভিস ডিলিট করা হয়েছে\n\nসার্ভিস: ${serviceName}\nআইডি: ${serviceId}\nডিলিট করেছেন: ${formattedPhone}\nসময়: ${new Date().toLocaleString()}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_delete_service", {
      serviceId,
      serviceName,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to delete service:`, err);
    await sendTextMessage(phone, "❌ ডিলিট করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

// --- Admin Toggle Service ---
async function handleAdminToggleServiceStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting toggle service for ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().sort({ name: 1 }).limit(15);

    if (services.length === 0) {
      await sendTextMessage(phone, "📭 কোন সার্ভিস পাওয়া যায়নি।");
      await showMainMenu(phone, true);
      return;
    }

    const serviceRows = services.map((service) => ({
      id: `toggle_${service._id}`,
      title: `${service.isActive ? "✅" : "❌"} ${service.name} - ৳${service.price}`,
      description: service.isActive
        ? "সক্রিয় (নিষ্ক্রিয় করতে ক্লিক করুন)"
        : "নিষ্ক্রিয় (সক্রিয় করতে ক্লিক করুন)",
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "admin_toggle_service_select",
      flowType: "admin_toggle_service",
      data: {
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    await sendListMenu(
      phone,
      "🔀 সার্ভিস স্ট্যাটাস পরিবর্তন",
      "স্ট্যাটাস পরিবর্তন করতে চান এমন সার্ভিস সিলেক্ট করুন:\n\n✅ = সক্রিয়\n❌ = নিষ্ক্রিয়\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "সার্ভিসসমূহ",
      "সার্ভিস সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(
      `Failed to start toggle service for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminToggleServiceExecute(
  phone: string,
  serviceId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const actualServiceId = serviceId.replace("toggle_", "");
  EnhancedLogger.info(`Admin toggling service: ${actualServiceId}`);

  try {
    await connectDB();
    const service = await Service.findById(actualServiceId);

    if (!service) {
      await sendTextMessage(phone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(phone, true);
      return;
    }

    const newStatus = !service.isActive;
    service.isActive = newStatus;
    await service.save();

    await sendTextMessage(
      phone,
      `✅ *সার্ভিস স্ট্যাটাস পরিবর্তন করা হয়েছে*\n\nসার্ভিস: ${service.name}\nনতুন স্ট্যাটাস: ${newStatus ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"}\n\n🎉 পরিবর্তনগুলি সফলভাবে সংরক্ষণ করা হয়েছে!\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
    );

    await notifyAdmin(
      `🔀 সার্ভিস স্ট্যাটাস পরিবর্তন\n\nসার্ভিস: ${service.name}\nআইডি: ${actualServiceId}\nনতুন স্ট্যাটাস: ${newStatus ? "সক্রিয়" : "নিষ্ক্রিয়"}\nপরিবর্তন করেছেন: ${formattedPhone}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_toggle_service", {
      serviceId: actualServiceId,
      serviceName: service.name,
      oldStatus: !newStatus,
      newStatus,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to toggle service:`, err);
    await sendTextMessage(phone, "❌ স্ট্যাটাস পরিবর্তন করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

// --- Admin Order Management ---
async function handleAdminOrders(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin order management for ${formattedPhone}`);

  const orderMenuRows = [
    {
      id: "admin_view_orders",
      title: "👁️ অর্ডার তালিকা দেখুন",
      description: "সকল অর্ডারের তালিকা দেখুন",
    },
    {
      id: "admin_process_order",
      title: "🔄 অর্ডার প্রসেস করুন",
      description: "অর্ডার স্ট্যাটাস পরিবর্তন করুন",
    },
    {
      id: "admin_search_order",
      title: "🔍 অর্ডার খুঁজুন",
      description: "অর্ডার আইডি দিয়ে খুঁজুন",
    },
    {
      id: "admin_order_stats",
      title: "📊 অর্ডার স্ট্যাটিসটিক্স",
      description: "অর্ডার সম্পর্কিত পরিসংখ্যান",
    },
  ];

  await sendListMenu(
    phone,
    "📋 অর্ডার ম্যানেজমেন্ট",
    "অর্ডার ম্যানেজমেন্ট অপশন সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
    orderMenuRows,
    "অর্ডার অপশন",
    "অপশন দেখুন",
  );
}

// --- Admin View Orders ---
async function handleAdminViewOrders(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin viewing orders for ${formattedPhone}`);

  try {
    await connectDB();
    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("userId", "name whatsapp");

    if (orders.length === 0) {
      await sendTextMessage(phone, "📭 কোন অর্ডার পাওয়া যায়নি।");
      await showMainMenu(phone, true);
      return;
    }

    let message = "📦 *অর্ডার তালিকা:*\n\n";

    orders.forEach((order, index) => {
      const statusMap = {
        pending: "⏳",
        processing: "🔄",
        completed: "✅",
        failed: "❌",
        cancelled: "🚫",
      };
      const statusEmoji =
        statusMap[order.status as keyof typeof statusMap] || "📝";
      const user = order.userId as any;

      message += `${index + 1}. ${statusEmoji} ${order.serviceName}\n`;
      message += `   🆔: ${order._id}\n`;
      message += `   👤: ${user?.name || "N/A"} (${user?.whatsapp || "N/A"})\n`;
      message += `   💰: ৳${order.totalPrice}\n`;
      message += `   📅: ${new Date(order.placedAt).toLocaleDateString()}\n`;
      //add file or text info
      order.serviceData.forEach((item: any, index: number) => {
        if (item.type === "file") {
          const publicUrl = `${process.env.NEXT_PUBLIC_URL}/order-file/${order._id}/${index}`;
          message += `      📁 ${publicUrl}: [ফাইল সংযুক্ত]\n`;
        } else {
          message += `      📝 ${item.fieldName}: ${item.value}\n`;
        }
      });

      message += `\n`;
    });

    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: "pending" });
    const totalRevenue = await Order.aggregate([
      { $group: { _id: null, total: { $sum: "$totalPrice" } } },
    ]);
    const revenue = totalRevenue[0]?.total || 0;

    message += `📊 *স্ট্যাটিসটিক্স:*\n`;
    message += `• মোট অর্ডার: ${totalOrders}\n`;
    message += `• পেন্ডিং অর্ডার: ${pendingOrders}\n`;
    message += `• মোট আয়: ৳${revenue}\n\n`;
    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, message);
    await showMainMenu(phone, true);

    EnhancedLogger.info(`Admin orders view sent to ${formattedPhone}`, {
      orderCount: orders.length,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show orders to admin ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ অর্ডার লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

// --- Admin Process Order ---
async function handleAdminProcessOrderStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting process order for ${formattedPhone}`);

  try {
    await connectDB();
    const orders = await Order.find({
      status: { $in: ["pending", "processing"] },
    })
      .sort({ createdAt: 1 })
      .limit(10)
      .populate("userId", "name whatsapp");

    if (orders.length === 0) {
      await sendTextMessage(
        phone,
        "📭 কোন পেন্ডিং বা প্রসেসিং অর্ডার পাওয়া যায়নি।",
      );
      await showMainMenu(phone, true);
      return;
    }

    const orderRows = orders.map((order) => ({
      id: `process_${order._id}`,
      title: `🆔 ${order._id.toString().slice(-8)} - ৳${order.totalPrice}`,
      description: `${order.serviceName || "Unknown Service"} - ${(order.userId as any)?.name || "N/A"} (${order.status})`,
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "admin_process_order_select",
      flowType: "admin_process_order",
      data: {
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    await sendListMenu(
      phone,
      "🔄 অর্ডার প্রসেস করুন",
      "প্রসেস করতে চান এমন অর্ডার সিলেক্ট করুন:\n\n⏳ = পেন্ডিং\n🔄 = প্রসেসিং\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      orderRows,
      "অর্ডারসমূহ",
      "অর্ডার সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(
      `Failed to start process order for ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ অর্ডার লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminProcessOrderStatus(
  phone: string,
  orderId: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const actualOrderId = orderId.replace("process_", "");
  EnhancedLogger.info(`Admin processing order: ${actualOrderId}`);

  try {
    await connectDB();
    const order = await Order.findById(actualOrderId).populate(
      "userId",
      "name whatsapp",
    );

    if (!order) {
      await sendTextMessage(phone, "❌ অর্ডার পাওয়া যায়নি!");
      await showMainMenu(phone, true);
      return;
    }

    // Store order info in state
    await stateManager.setUserState(formattedPhone, {
      currentState: "admin_process_order_status",
      flowType: "admin_process_order",
      data: {
        adminProcessOrder: {
          orderId: actualOrderId,
          order: {
            _id: order._id,
            serviceName: order.serviceName,
            totalPrice: order.totalPrice,
            status: order.status,
            userId: {
              _id: (order.userId as any)?._id,
              name: (order.userId as any)?.name || "User",
              whatsapp: (order.userId as any)?.whatsapp,
            },
          },
          step: 1,
        },
        lastActivity: Date.now(),
        sessionId: Date.now().toString(36),
      },
    });

    const statusRows = [
      {
        id: "status_completed",
        title: "✅ কমপ্লিটেড",
        description: "ফাইল/টেক্সট পাঠিয়ে অর্ডারটি কমপ্লিট করুন",
      },
      {
        id: "status_failed",
        title: "❌ ফেইলড",
        description: "কারণ লিখে অর্ডারটি ব্যর্থ ঘোষণা করুন",
      },
      {
        id: "status_cancelled",
        title: "🚫 ক্যান্সেলড",
        description: "কারণ লিখে অর্ডারটি বাতিল করুন",
      },
    ];

    await sendListMenu(
      phone,
      `🔄 অর্ডার স্ট্যাটাস পরিবর্তন`,
      `অর্ডার আইডি: ${actualOrderId.slice(-8)}\nসার্ভিস: ${order.serviceName || "Unknown Service"}\nইউজার: ${(order.userId as any)?.name || "User"}\nবর্তমান স্ট্যাটাস: ${order.status}\nমূল্য: ৳${order.totalPrice}\n\nনতুন স্ট্যাটাস সিলেক্ট করুন:`,
      statusRows,
      "স্ট্যাটাস অপশন",
      "স্ট্যাটাস সিলেক্ট করুন",
    );
  } catch (err) {
    EnhancedLogger.error(`Failed to process order status:`, err);
    await sendTextMessage(phone, "❌ অর্ডার লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminProcessOrderUpdate(
  phone: string,
  statusId: string,
  input?: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const orderId = state?.data?.adminProcessOrder?.orderId;
  const order = state?.data?.adminProcessOrder?.order;
  const step = state?.data?.adminProcessOrder?.step || 1;
  const currentState = state?.currentState;

  if (!orderId || !order) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  EnhancedLogger.info(`Admin processing order update: ${statusId}`, {
    step,
    currentState,
    orderId,
    input: input?.substring(0, 50),
  });

  try {
    // Handle status selection (completed, failed, cancelled)
    if (statusId.startsWith("status_")) {
      const newStatus = statusId.replace("status_", "");

      if (newStatus === "completed") {
        if (step === 1) {
          // Ask for delivery type selection
          await stateManager.setUserState(formattedPhone, {
            currentState: "admin_process_order_delivery_type",
            flowType: "admin_process_order",
            data: {
              adminProcessOrder: {
                ...state.data?.adminProcessOrder,
                step: 2,
              },
              lastActivity: Date.now(),
              sessionId: Date.now().toString(36),
            },
          });

          await sendQuickReplyMenu(
            phone,
            `📦 ডেলিভারি টাইপ\n\nঅর্ডার: ${orderId.slice(-8)}\nইউজার: ${order.userId?.name || "User"}\nসার্ভিস: ${order.serviceName || "Unknown Service"}\n\nকিভাবে ডেলিভারি করতে চান?`,
            [
              { id: "delivery_text", title: "📝 শুধু টেক্সট" },
              { id: "delivery_file", title: "📁 শুধু ফাইল" },
              { id: "delivery_both", title: "📝📁 টেক্সট ও ফাইল" },
            ],
          );
        }
      } else if (newStatus === "failed" || newStatus === "cancelled") {
        if (step === 1) {
          await stateManager.setUserState(formattedPhone, {
            currentState: "admin_process_order_reason_input",
            flowType: "admin_process_order",
            data: {
              adminProcessOrder: {
                ...state.data?.adminProcessOrder,
                step: 2,
                status: newStatus, // Store status separately
              },
              lastActivity: Date.now(),
              sessionId: Date.now().toString(36),
            },
          });

          await sendTextWithCancelButton(
            phone,
            `📝 ${newStatus === "failed" ? "ব্যর্থতার" : "বাতিলের"} কারণ\n\nঅর্ডার: ${orderId.slice(-8)}\nইউজার: ${order.userId?.name || "User"}\n\n${newStatus === "failed" ? "ব্যর্থতার" : "বাতিলের"} কারণ লিখুন:\n\n📌 নোট:\n• কারণটি পরিষ্কার ও বোধগম্য হোক\n• ইউজারকে এই কারণটি দেখানো হবে\n• মিনিমাম ৫ ক্যারেক্টার`,
          );
        } else if (step === 2) {
          if (!input || !input.trim() || input.trim().length < 5) {
            await sendTextMessage(
              phone,
              `❌ দয়া করে কমপক্ষে 5 ক্যারেক্টারের কারণ লিখুন!`,
            );
            return;
          }

          await stateManager.updateStateData(formattedPhone, {
            adminProcessOrder: {
              ...state.data?.adminProcessOrder,
              deliveryData: {
                reason: input.trim(),
              },
              step: 3,
            },
          });

          await completeFailedOrCancelledOrder(phone);
        }
      }
    }
    // Handle delivery type selection
    else if (statusId.startsWith("delivery_")) {
      const deliveryType = statusId.replace("delivery_", "");

      if (step === 2) {
        // Handle delivery type selection from quick reply menu
        await stateManager.updateStateData(formattedPhone, {
          adminProcessOrder: {
            ...state.data?.adminProcessOrder,
            step: 3,
            deliveryType: deliveryType,
          },
        });

        if (deliveryType === "text" || deliveryType === "both") {
          await stateManager.setUserState(formattedPhone, {
            currentState: "admin_process_order_text_input",
            flowType: "admin_process_order",
            data: {
              adminProcessOrder: {
                ...state.data?.adminProcessOrder,
                step: 3,
                deliveryType: deliveryType,
              },
              lastActivity: Date.now(),
              sessionId: Date.now().toString(36),
            },
          });

          await sendTextWithCancelButton(
            phone,
            `📝 ডেলিভারি টেক্সট\n\nঅর্ডার: ${orderId.slice(-8)}\nইউজার: ${order.userId?.name || "User"}\n\nইউজারকে পাঠাতে চান এমন টেক্সট লিখুন:\n\n📌 টিপস:\n• ধন্যবাদ জানান\n• পরবর্তী নির্দেশনা দিন\n• সার্ভিসের ডিটেইলস দিন\n\nস্কিপ করতে 'skip' লিখুন`,
          );
        } else {
          // deliveryType === "file"
          await stateManager.setUserState(formattedPhone, {
            currentState: "admin_process_order_file_upload",
            flowType: "admin_process_order",
            data: {
              adminProcessOrder: {
                ...state.data?.adminProcessOrder,
                step: 3,
                deliveryType: deliveryType,
              },
              lastActivity: Date.now(),
              sessionId: Date.now().toString(36),
            },
          });

          await sendTextWithCancelButton(
            phone,
            `📁 ফাইল আপলোড\n\nঅর্ডার: ${orderId.slice(-8)}\nইউজার: ${order.userId?.name || "User"}\n\nডেলিভারি ফাইল আপলোড করুন:\n\n📌 সমর্থিত ফাইল:\n• ইমেজ (JPG, PNG)\n• PDF\n• ডকুমেন্ট (DOC, DOCX)\n\nফাইল আপলোড করুন...`,
          );
        }
      }
    }
    // Handle text input for text or both delivery types
    else if (
      currentState === "admin_process_order_text_input" &&
      input !== undefined
    ) {
      const deliveryType = state?.data?.adminProcessOrder?.deliveryType;

      if (deliveryType === "text" || deliveryType === "both") {
        const text =
          input && input.toLowerCase() === "skip" ? "" : input.trim();

        await stateManager.updateStateData(formattedPhone, {
          adminProcessOrder: {
            ...state.data?.adminProcessOrder,
            deliveryData: {
              ...state.data?.adminProcessOrder?.deliveryData,
              text: text,
            },
            step: deliveryType === "both" ? 4 : 5,
          },
        });

        if (deliveryType === "both") {
          await stateManager.setUserState(formattedPhone, {
            currentState: "admin_process_order_file_upload",
            flowType: "admin_process_order",
            data: {
              adminProcessOrder: {
                ...state.data?.adminProcessOrder,
                step: 4,
                deliveryType: deliveryType,
                deliveryData: {
                  ...state.data?.adminProcessOrder?.deliveryData,
                  text: text,
                },
              },
              lastActivity: Date.now(),
              sessionId: Date.now().toString(36),
            },
          });

          await sendTextWithCancelButton(
            phone,
            `✅ টেক্সট সংরক্ষণ করা হয়েছে।\n\nএখন ডেলিভারি ফাইল আপলোড করুন:\n\n📌 সমর্থিত ফাইল:\n• ইমেজ (JPG, PNG)\n• PDF\n• ডকুমেন্ট (DOC, DOCX)\n\nফাইল আপলোড করুন...`,
          );
        } else {
          // deliveryType === "text" only
          await completeOrderDelivery(phone);
        }
      }
    }
    // Handle reason input for failed/cancelled orders
    else if (
      currentState === "admin_process_order_reason_input" &&
      input !== undefined
    ) {
      if (!input || !input.trim() || input.trim().length < 5) {
        await sendTextMessage(
          phone,
          `❌ দয়া করে কমপক্ষে 5 ক্যারেক্টারের কারণ লিখুন!`,
        );
        return;
      }

      await stateManager.updateStateData(formattedPhone, {
        adminProcessOrder: {
          ...state.data?.adminProcessOrder,
          deliveryData: {
            reason: input.trim(),
          },
          step: 3,
        },
      });

      await completeFailedOrCancelledOrder(phone);
    }
  } catch (err) {
    EnhancedLogger.error(`Failed to update order status:`, err);
    await sendTextMessage(phone, "❌ স্ট্যাটাস আপডেট করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}
async function completeFailedOrCancelledOrder(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const orderId = state?.data?.adminProcessOrder?.orderId;
  const order = state?.data?.adminProcessOrder?.order;
  const status = state?.data?.adminProcessOrder?.status; // Should be "failed" or "cancelled"
  const deliveryData = state?.data?.adminProcessOrder?.deliveryData;

  if (!orderId || !order || !status) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  try {
    await connectDB();
    const updatedOrder = await Order.findById(orderId);

    if (!updatedOrder) {
      await sendTextMessage(phone, "❌ অর্ডার পাওয়া যায়নি!");
      await cancelFlow(phone, true);
      return;
    }

    // Update order status
    updatedOrder.status = status;

    // Add cancellation data
    updatedOrder.cancellationData = {
      cancelledAt: new Date(),
      reason: deliveryData?.reason || "",
      cancelledBy: formattedPhone,
    };

    updatedOrder.updatedAt = new Date();
    await updatedOrder.save();

    // Notify user
    const user = order.userId as any;
    if (user && user.whatsapp) {
      const statusText = status === "failed" ? "ব্যর্থ" : "বাতিল";
      let notification = `❌ *আপনার অর্ডার ${statusText} হয়েছে*\n\n`;
      notification += `🆔 অর্ডার আইডি: ${orderId.slice(-8)}\n`;
      notification += `📦 সার্ভিস: ${updatedOrder.serviceName || "Unknown Service"}\n`;
      notification += `💰 মূল্য: ৳${updatedOrder.totalPrice}\n`;
      notification += `📅 ${statusText} হয়েছে: ${new Date().toLocaleString()}\n\n`;

      if (deliveryData?.reason) {
        notification += `📝 *কারণ:*\n${deliveryData.reason}\n\n`;
      }

      notification += `😞 দুঃখিত আপনার অর্ডারটি ${statusText} হয়েছে।\n`;
      notification += `📞 বিস্তারিত জানতে সাপোর্টে যোগাযোগ করুন: ${CONFIG.supportNumber}\n`;
      notification += `🔄 নতুন অর্ডার করতে 'সার্ভিস' লিখুন\n\n`;
      notification += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

      await sendTextMessage(user.whatsapp, notification);
    }

    // Send confirmation to admin
    let adminMessage = `✅ *অর্ডার আপডেট সম্পন্ন*\n\n`;
    adminMessage += `🆔 অর্ডার: ${orderId.slice(-8)}\n`;
    adminMessage += `👤 ইউজার: ${order.userId?.name || "User"} (${order.userId?.whatsapp || "N/A"})\n`;
    adminMessage += `📦 সার্ভিস: ${updatedOrder.serviceName || "Unknown Service"}\n`;
    adminMessage += `📊 নতুন স্ট্যাটাস: ${updatedOrder.status}\n`;
    adminMessage += `📝 কারণ: ${deliveryData?.reason || "N/A"}\n`;

    adminMessage += `\n✅ ইউজারকে নোটিফিকেশন পাঠানো হয়েছে।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, adminMessage);

    await notifyAdmin(
      `🔄 অর্ডার আপডেট সম্পন্ন\n\nঅর্ডার: ${orderId}\nসার্ভিস: ${updatedOrder.serviceName || "Unknown Service"}\nইউজার: ${order.userId?.name || "User"} (${order.userId?.whatsapp || "N/A"})\nনতুন স্ট্যাটাস: ${updatedOrder.status}\nআপডেট করেছেন: ${formattedPhone}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_process_order", {
      orderId,
      orderStatus: updatedOrder.status,
      userId: order.userId?._id,
      reason: deliveryData?.reason,
    });
  } catch (err: any) {
    EnhancedLogger.error(`Failed to complete failed/cancelled order:`, {
      error: err?.message || err,
      stack: err?.stack,
      orderId,
      status,
    });
    await sendTextMessage(phone, "❌ অর্ডার আপডেট করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}
export async function sendDeliveryFile(
  to: string,
  fileUrl: string,
  fileName: string,
  fileType: string,
  caption?: string,
): Promise<any> {
  const formattedTo = formatPhoneNumber(to);

  console.log("=== WhatsApp API Debug ===");
  console.log("1. Input Parameters:");
  console.log("- to:", to);
  console.log("- formattedTo:", formattedTo);
  console.log("- fileUrl:", fileUrl);
  console.log("- fileName:", fileName);
  console.log("- fileType:", fileType);
  console.log("- caption:", caption);

  const PHONE_NUMBER_ID = CONFIG.phoneNumberId;
  const ACCESS_TOKEN = CONFIG.accessToken;

  console.log("2. Environment Variables:");
  console.log("- PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? "***SET***" : "MISSING!");
  console.log("- ACCESS_TOKEN:", ACCESS_TOKEN ? "***SET***" : "MISSING!");

  // Validate environment variables
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    const error =
      "Missing WhatsApp API credentials. Check WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN.";
    console.error("3. Validation Error:", error);
    throw new Error(error);
  }

  // Validate phone number
  if (!formattedTo) {
    const error = "Invalid phone number format";
    console.error("3. Validation Error:", error);
    throw new Error(error);
  }

  // Validate file URL
  if (!fileUrl || !fileUrl.startsWith("http")) {
    const error = "Invalid file URL. Must be a valid HTTP/HTTPS URL.";
    console.error("3. Validation Error:", error);
    throw new Error(error);
  }

  const ext = fileName.toLowerCase().split(".").pop() || "";

  let type: "image" | "document" = "document";
  let media: any = {};

  // Check for images
  if (
    fileType.startsWith("image/") ||
    ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)
  ) {
    type = "image";
    media = {
      link: fileUrl,
      caption: caption || undefined,
    };
  } else {
    // For documents
    type = "document";
    media = {
      link: fileUrl,
      filename: fileName,
      caption: caption || undefined,
    };
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: type,
    [type]: media,
  };

  console.log("4. Generated Payload:");
  console.log("- Type:", type);
  console.log("- Payload:", JSON.stringify(payload, null, 2));

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
  console.log("5. API URL:", url);

  try {
    console.log("6. Making API request...");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("7. Response Status:", res.status, res.statusText);

    const data = await res.json();
    console.log("8. Response Data:", JSON.stringify(data, null, 2));

    if (!res.ok) {
      console.error("9. WhatsApp API Error Details:");
      console.error("- Status:", res.status);
      console.error("- Status Text:", res.statusText);
      console.error("- Error:", data.error);
      console.error("- fbtrace_id:", data.error?.fbtrace_id);
      console.error("- Payload sent:", JSON.stringify(payload, null, 2));

      let errorMessage = `WhatsApp API error (${res.status}): `;
      if (data?.error?.message) {
        errorMessage += data.error.message;
      } else if (data?.error?.error_user_msg) {
        errorMessage += data.error.error_user_msg;
      } else {
        errorMessage += "Unknown error";
      }

      throw new Error(errorMessage);
    }

    console.log("10. SUCCESS - Message sent!");
    console.log("- Message ID:", data.messages?.[0]?.id);
    console.log("- Contact WA ID:", data.contacts?.[0]?.wa_id);

    return data;
  } catch (error) {
    console.error("11. CATCH BLOCK - Error occurred:");
    if (error instanceof Error) {
      console.error("- Error message:", error.message);
      console.error("- Stack trace:", error.stack);
      throw error;
    }
    console.error("- Unknown error:", error);
    throw new Error(`Network or unknown error: ${error}`);
  }
}

// Helper function to get file size in readable format
async function getFileSize(fileUrl: string): Promise<string> {
  try {
    const response = await fetch(fileUrl, { method: "HEAD" });
    const contentLength = response.headers.get("content-length");

    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      if (bytes < 1024) return `${bytes} bytes`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    return "Unknown size";
  } catch {
    return "Unknown size";
  }
}

// Helper function to check if URL is accessible
async function isUrlAccessible(fileUrl: string): Promise<boolean> {
  try {
    const response = await fetch(fileUrl, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}
export async function sendOrderDeliveryTemplate(
  to: string,
  productName: string,
  storeName: string,
  invoiceNumber: string,
  documentUrl: string,
  documentFileName: string,
  language = "en_US",
) {
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${CONFIG.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: "purchase_receipt",
          language: { code: language },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: productName },
                { type: "text", text: storeName },
                { type: "text", text: invoiceNumber },
              ],
            },
            {
              type: "header",
              parameters: [
                {
                  type: "document",
                  document: {
                    link: documentUrl,
                    filename: documentFileName,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`WhatsApp Delivery Error: ${JSON.stringify(data)}`);
  }

  return data;
}
// Updated completeOrderDelivery function to use sendDeliveryFile
async function completeOrderDelivery(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const orderId = state?.data?.adminProcessOrder?.orderId;
  const order = state?.data?.adminProcessOrder?.order;
  const deliveryType = state?.data?.adminProcessOrder?.deliveryType;
  const deliveryData = state?.data?.adminProcessOrder?.deliveryData;

  if (!orderId || !order) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  try {
    await connectDB();
    const updatedOrder = await Order.findById(orderId);

    if (!updatedOrder) {
      await sendTextMessage(phone, "❌ অর্ডার পাওয়া যায়নি!");
      await cancelFlow(phone, true);
      return;
    }

    // Always set status to "completed" for successful deliveries
    const newStatus = "completed";

    EnhancedLogger.info(`Updating order status to: ${newStatus}`, {
      orderId,
      deliveryType,
      previousStatus: updatedOrder.status,
    });

    // Update order status
    updatedOrder.status = newStatus;

    // Add delivery data
    updatedOrder.deliveryData = {
      deliveredAt: new Date(),
      deliveryMethod: "whatsapp",
      text: deliveryData?.text || "",
      fileUrl: deliveryData?.fileUrl || "",
      fileName: deliveryData?.fileName || "",
      fileType: deliveryData?.fileType || "",
      deliveryType: deliveryType || "file",
      deliveredBy: formattedPhone,
    };

    updatedOrder.updatedAt = new Date();

    EnhancedLogger.info(`Saving order with delivery data`, {
      deliveryData: updatedOrder.deliveryData,
    });

    await updatedOrder.save();

    EnhancedLogger.info(`Order saved successfully`, {
      orderId,
      newStatus,
    });

    // Notify user
    const user = order.userId as any;
    if (user && user.whatsapp) {
      // Step 1: Send notification message
      let notification = `✅ *আপনার অর্ডার সম্পন্ন হয়েছে!*\n\n`;
      notification += `🆔 অর্ডার আইডি: ${orderId.slice(-8)}\n`;
      notification += `📦 সার্ভিস: ${updatedOrder.serviceName || "Unknown Service"}\n`;
      notification += `💰 মূল্য: ৳${updatedOrder.totalPrice}\n`;
      notification += `📅 সম্পূর্ণ হয়েছে: ${new Date().toLocaleString()}\n\n`;

      if (deliveryData?.text) {
        notification += `📝 *ডেলিভারি নোট:*\n${deliveryData.text}\n\n`;
      }

      await sendTextMessage(user.whatsapp, notification);
      const newData = await Order.findById(orderId);
      // log the newData
      EnhancedLogger.info(`Fetched updated order data for delivery`, {
        orderId,
        newData,
      });
      // Step 2: Send file if available
      if (newData?.deliveryData?.fileUrl) {
        // Check if URL is accessible before trying to send
        const publicUrl = `${process.env.NEXT_PUBLIC_URL}/file/${orderId}`;
        //log the publicUrl
        EnhancedLogger.info(`Preparing to send delivery file`, {
          orderId,
          fileUrl: newData.deliveryData.fileUrl,
          publicUrl,
        });
        const isAccessible = await isUrlAccessible(publicUrl);
        //log the accessibility status
        EnhancedLogger.info(`File URL accessibility check`, {
          orderId,
          isAccessible,
        });

        if (isAccessible) {
          try {
            // Create caption for the file
            const fileCaption = `📦 ${updatedOrder.serviceName || "Service"} - Delivery File\n🆔 Order: ${orderId.slice(-8)}`;

            // Send the file using WhatsApp's media API
            await sendOrderDeliveryTemplate(
              user.whatsapp,
              updatedOrder.serviceName || "Service",
              "Birth Help",
              orderId,
              publicUrl,
              deliveryData.fileName || "delivery_file",
            );

            EnhancedLogger.info(
              `File sent successfully to user ${user.whatsapp}`,
            );
          } catch (fileError: any) {
            EnhancedLogger.error(`Failed to send file via WhatsApp API:`, {
              error: fileError?.message || fileError,
              fileUrl: deliveryData.fileUrl,
            });

            // Fallback: Send download link
            const downloadMessage =
              `📁 *ডেলিভারি ফাইল:*\n\n` +
              `ফাইল: ${deliveryData.fileName}\n` +
              `📎 ডাউনলোড লিঙ্ক: ${publicUrl}\n\n` +
              `ফাইলটি ডাউনলোড করতে উপরের লিঙ্কে ক্লিক করুন।`;

            await sendTextMessage(user.whatsapp, downloadMessage);
          }
        } else {
          // URL not accessible, send direct link
          const inaccessibleMessage =
            `📁 *ডেলিভারি ফাইল:*\n\n` +
            `ফাইল: ${deliveryData.fileName}\n` +
            `📎 ডাউনলোড লিঙ্ক: ${publicUrl}\n\n` +
            `ফাইলটি ডাউনলোড করতে উপরের লিঙ্কে ক্লিক করুন।`;

          await sendTextMessage(user.whatsapp, inaccessibleMessage);
        }
      }

      // Step 3: Send final message
      const finalMessage =
        `🎉 আপনার অর্ডার সফলভাবে সম্পন্ন হয়েছে!\n` +
        `📞 আরও সাহায্যের জন্য সাপোর্টে যোগাযোগ করুন: ${CONFIG.supportNumber}\n\n` +
        `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

      await sendTextMessage(user.whatsapp, finalMessage);
    }

    // Send confirmation to admin
    let adminMessage = `✅ *অর্ডার আপডেট সম্পন্ন*\n\n`;
    adminMessage += `🆔 অর্ডার: ${orderId.slice(-8)}\n`;
    adminMessage += `👤 ইউজার: ${order.userId?.name || "User"} (${order.userId?.whatsapp || "N/A"})\n`;
    adminMessage += `📦 সার্ভিস: ${updatedOrder.serviceName || "Unknown Service"}\n`;
    adminMessage += `📊 নতুন স্ট্যাটাস: ${updatedOrder.status}\n`;
    adminMessage += `📦 ডেলিভারি টাইপ: ${deliveryType === "text" ? "শুধু টেক্সট" : deliveryType === "file" ? "শুধু ফাইল" : "টেক্সট ও ফাইল"}\n`;

    if (deliveryType === "text" || deliveryType === "both") {
      adminMessage += `📝 টেক্সট পাঠানো: ${deliveryData?.text ? "✅ হ্যাঁ" : "❌ না"}\n`;
    }

    if (deliveryType === "file" || deliveryType === "both") {
      adminMessage += `📁 ফাইল পাঠানো: ${deliveryData?.fileName ? "✅ হ্যাঁ" : "❌ না"}\n`;
    }

    adminMessage += `\n✅ ইউজারকে নোটিফিকেশন পাঠানো হয়েছে।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, adminMessage);

    await notifyAdmin(
      `🔄 অর্ডার আপডেট সম্পন্ন\n\nঅর্ডার: ${orderId}\nসার্ভিস: ${updatedOrder.serviceName || "Unknown Service"}\nইউজার: ${order.userId?.name || "User"} (${order.userId?.whatsapp || "N/A"})\nনতুন স্ট্যাটাস: ${updatedOrder.status}\nডেলিভারি টাইপ: ${deliveryType}\nআপডেট করেছেন: ${formattedPhone}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_process_order", {
      orderId,
      orderStatus: updatedOrder.status,
      userId: order.userId?._id,
      deliveryType,
      hasText: !!deliveryData?.text,
      hasFile: !!deliveryData?.fileUrl,
    });
  } catch (err: any) {
    EnhancedLogger.error(`Failed to complete order delivery:`, {
      error: err?.message || err,
      stack: err?.stack,
      orderId,
      deliveryType,
    });
    await sendTextMessage(phone, "❌ অর্ডার আপডেট করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

// Handle file upload for order delivery
async function handleAdminFileUpload(
  phone: string,
  message: WhatsAppMessage,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const orderId = state?.data?.adminProcessOrder?.orderId;
  const deliveryType = state?.data?.adminProcessOrder?.deliveryType;

  if (!orderId || !deliveryType) {
    await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
    await cancelFlow(phone, true);
    return;
  }

  EnhancedLogger.info(`Admin file upload for order: ${orderId}`, {
    messageType: message.type,
    deliveryType,
  });

  try {
    if (message.type === "image" || message.type === "document") {
      await sendTextMessage(
        phone,
        "⏳ *ফাইল আপলোড হচ্ছে...*\n\nদয়া করে অপেক্ষা করুন।",
      );

      const mediaId =
        message.type === "image" ? message.image?.id : message.document?.id;
      const fileName =
        message.type === "image"
          ? `delivery_${orderId}_${Date.now()}.jpg`
          : message.document?.filename ||
            `delivery_${orderId}_${Date.now()}.pdf`;

      if (!mediaId) {
        await sendTextMessage(phone, "❌ ফাইল আইডি পাওয়া যায়নি!");
        return;
      }

      EnhancedLogger.info(`Downloading admin media: ${mediaId}`);

      // Download media from WhatsApp
      const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);

      // Check file size
      if (buffer.length > CONFIG.maxFileSize) {
        await sendTextMessage(
          phone,
          `❌ ফাইল সাইজ খুব বড়! সর্বোচ্চ সাইজ: ${CONFIG.maxFileSize / 1024 / 1024}MB`,
        );
        return;
      }

      EnhancedLogger.info(`Admin media downloaded, uploading to server`, {
        fileName,
        fileSize: buffer.length,
        mimeType,
      });

      // Create order-specific upload directory
      const orderUploadsDir = path.join(
        process.cwd(),
        "uploads",
        "orders",
        orderId,
      );

      if (!fs.existsSync(orderUploadsDir)) {
        EnhancedLogger.info(
          `Creating order upload directory: ${orderUploadsDir}`,
        );
        fs.mkdirSync(orderUploadsDir, { recursive: true });
      }

      // Generate unique filename
      const fileExt =
        path.extname(fileName) ||
        (mimeType.includes("image") ? ".jpg" : ".bin");
      const uniqueFileName = `${Date.now()}_delivery${fileExt}`;
      const filePath = path.join(orderUploadsDir, uniqueFileName);

      EnhancedLogger.info(`Saving admin file to: ${filePath}`);

      // Save file to disk
      fs.writeFileSync(filePath, buffer);

      // Verify file was saved
      if (!fs.existsSync(filePath)) {
        throw new Error(`Failed to save file to ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      const fileSize = formatFileSize(stats.size);

      EnhancedLogger.info(`Admin file saved successfully`, {
        filePath,
        fileSize: stats.size,
        savedSize: buffer.length,
      });

      // Create public URL for the file
      const publicUrl = filePath;

      // Update state with file info
      await stateManager.updateStateData(formattedPhone, {
        adminProcessOrder: {
          ...state.data?.adminProcessOrder,
          deliveryData: {
            ...state.data?.adminProcessOrder?.deliveryData,
            fileUrl: publicUrl,
            fileName: uniqueFileName,
            fileType: mimeType,
            fileSize: fileSize,
          },
          step: 5, // Always go to step 5 after file upload for completed orders
        },
      });

      await sendTextMessage(
        phone,
        `✅ *ফাইল আপলোড সফল*\n\n📁 ফাইল: ${uniqueFileName}\n📊 সাইজ: ${fileSize}\n📄 টাইপ: ${mimeType}\n\nফাইল সফলভাবে আপলোড হয়েছে!`,
      );

      // Continue with order completion
      await completeOrderDelivery(phone);
    } else {
      await sendTextMessage(
        phone,
        "❌ দয়া করে একটি ইমেজ বা ডকুমেন্ট ফাইল আপলোড করুন!",
      );
    }
  } catch (err: any) {
    EnhancedLogger.error(`Failed to handle admin file upload:`, {
      error: err?.message || err,
      stack: err?.stack,
    });
    await sendTextMessage(phone, "❌ ফাইল আপলোড করতে সমস্যা হয়েছে!");
  }
}

// --- Admin Broadcast ---
async function handleAdminBroadcast(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin broadcast for ${formattedPhone}`);

  await stateManager.setUserState(formattedPhone, {
    currentState: "admin_broadcast_message",
    flowType: "admin_broadcast",
    data: {
      adminBroadcast: {
        step: 1,
      },
      lastActivity: Date.now(),
      sessionId: Date.now().toString(36),
    },
  });

  await sendTextWithCancelButton(
    phone,
    "📢 *ব্রডকাস্ট মেসেজ*\n\nসকল ব্যবহারকারীকে পাঠাতে চান এমন মেসেজ লিখুন:\n\n💡 টিপস:\n• *বোল্ড* টেক্সট: *বোল্ড*\n• _ইটালিক_ টেক্সট: _ইটালিক_\n• `কোড` টেক্সট: `কোড`\n• লিংক: https://example.com\n\n📌 মেসেজটি পরিষ্কার ও বোধগম্য হোক",
  );
}

async function handleAdminBroadcastMessage(
  phone: string,
  message: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin setting broadcast message for ${formattedPhone}`, {
    messageLength: message.length,
  });

  if (!message.trim()) {
    await sendTextMessage(phone, "❌ দয়া করে একটি মেসেজ লিখুন!");
    return;
  }

  if (message.length > 1000) {
    await sendTextMessage(
      phone,
      "❌ মেসেজটি খুব দীর্ঘ! দয়া করে ১০০০ ক্যারেক্টারের কম লিখুন।",
    );
    return;
  }

  await stateManager.updateStateData(formattedPhone, {
    adminBroadcast: {
      message: message.trim(),
      step: 2,
    },
  });

  await sendQuickReplyMenu(
    phone,
    "👥 টার্গেট ইউজার\n\nকোন ধরনের ইউজারদের মেসেজ পাঠাতে চান?\n\n💡 মেসেজ প্রিভিউ:\n" +
      message.substring(0, 200) +
      (message.length > 200 ? "..." : ""),
    [
      { id: "broadcast_all", title: "👥 সকল ইউজার" },
      { id: "broadcast_active", title: "✅ একটিভ ইউজার" },
      { id: "broadcast_new", title: "🆕 নতুন ইউজার" },
    ],
  );
}

async function handleAdminBroadcastSend(
  phone: string,
  userType: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const state = await stateManager.getUserState(formattedPhone);
  const broadcastData = state?.data?.adminBroadcast as
    | AdminBroadcastStateData
    | undefined;
  const message = broadcastData?.message;

  if (!message) {
    await sendTextMessage(phone, "❌ মেসেজ পাওয়া যায়নি!");
    await cancelFlow(phone, true);
    return;
  }

  EnhancedLogger.info(`Admin sending broadcast to ${userType} users`, {
    messageLength: message.length,
  });

  try {
    await connectDB();

    const filter: any = {};
    let userTypeText = "";

    switch (userType) {
      case "broadcast_active":
        // Users active in last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filter.whatsappLastActive = { $gte: thirtyDaysAgo };
        userTypeText = "একটিভ ইউজার";
        break;
      case "broadcast_new":
        // Users created in last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        filter.createdAt = { $gte: sevenDaysAgo };
        userTypeText = "নতুন ইউজার";
        break;
      default:
        userTypeText = "সকল ইউজার";
      // For "broadcast_all", no filter
    }

    // Get total users count first
    const totalUsers = await User.countDocuments(filter);

    if (totalUsers === 0) {
      await sendTextMessage(phone, `📭 ${userTypeText} পাওয়া যায়নি।`);
      await cancelFlow(phone, true);
      return;
    }

    // Limit broadcast to prevent rate limiting
    const limit = Math.min(totalUsers, CONFIG.maxBroadcastUsers);

    await sendTextMessage(
      phone,
      `⏳ *ব্রডকাস্ট শুরু হচ্ছে*\n\nটার্গেট: ${userTypeText}\nমোট ইউজার: ${totalUsers}\nপ্রেরণ করা হবে: ${limit}\n\n⚡ প্রসেস চলছে... দয়া করে অপেক্ষা করুন।`,
    );

    const users = await User.find(filter).select("whatsapp name").limit(limit);

    let successCount = 0;
    let failCount = 0;
    const failedUsers: string[] = [];

    // Send messages in batches to avoid rate limiting
    const batchSize = 5;
    const delayBetweenBatches = 2000; // 2 seconds

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const batchPromises = batch.map(async (user) => {
        try {
          await sendTextMessage(
            user.whatsapp,
            `📢 *Birth Help নোটিফিকেশন*\n\n${message}\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন\n📞 সাপোর্ট: ${CONFIG.supportNumber}`,
          );
          successCount++;
          EnhancedLogger.debug(`Broadcast sent to ${user.whatsapp}`);
        } catch (err) {
          failCount++;
          failedUsers.push(user.whatsapp);
          EnhancedLogger.error(
            `Failed to send broadcast to ${user.whatsapp}:`,
            err,
          );
        }
      });

      await Promise.all(batchPromises);

      // Update progress
      if (i + batchSize < users.length) {
        const progress = Math.round(((i + batchSize) / users.length) * 100);
        await sendTextMessage(
          phone,
          `⏳ প্রোগ্রেস: ${progress}%\nসফল: ${successCount}\nব্যর্থ: ${failCount}`,
        );
      }

      // Delay between batches
      if (i + batchSize < users.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, delayBetweenBatches),
        );
      }
    }

    let resultMessage =
      `✅ *ব্রডকাস্ট সম্পন্ন*\n\n` +
      `টার্গেট: ${userTypeText}\n` +
      `সফল: ${successCount}\n` +
      `ব্যর্থ: ${failCount}\n` +
      `মোট: ${totalUsers}\n\n`;

    if (failCount > 0) {
      resultMessage += `❌ ব্যর্থ ইউজার: ${failedUsers.slice(0, 5).join(", ")}${failedUsers.length > 5 ? "..." : ""}\n\n`;
    }

    resultMessage += `🎉 ব্রডকাস্ট মেসেজ সফলভাবে পাঠানো হয়েছে!\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, resultMessage);

    await notifyAdmin(
      `📢 ব্রডকাস্ট সম্পন্ন\n\nটার্গেট: ${userTypeText}\nমোট: ${totalUsers}\nসফল: ${successCount}\nব্যর্থ: ${failCount}\nপ্রেরক: ${formattedPhone}\nসময়: ${new Date().toLocaleString()}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_broadcast", {
      userType,
      totalUsers,
      successCount,
      failCount,
      messageLength: message.length,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to send broadcast:`, err);
    await sendTextMessage(phone, "❌ ব্রডকাস্ট পাঠাতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

// --- Admin Statistics ---
async function handleAdminStats(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin stats for ${formattedPhone}`);

  try {
    await connectDB();

    // Get all stats
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      whatsappLastActive: {
        $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });
    const newUsers = await User.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });
    const bannedUsers = await User.countDocuments({ isBanned: true });

    const totalServices = await Service.countDocuments();
    const activeServices = await Service.countDocuments({ isActive: true });

    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: "pending" });
    const processingOrders = await Order.countDocuments({
      status: "processing",
    });
    const completedOrders = await Order.countDocuments({ status: "completed" });
    const cancelledOrders = await Order.countDocuments({ status: "cancelled" });

    const totalTransactions = await Transaction.countDocuments();

    const revenueStats = await Transaction.aggregate([
      { $match: { method: "bkash", status: "SUCCESS" } },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
          count: { $sum: 1 },
          avg: { $avg: "$amount" },
        },
      },
    ]);

    const serviceSalesStats = await Transaction.aggregate([
      { $match: { method: "balance", status: "SUCCESS" } },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
          count: { $sum: 1 },
          avg: { $avg: "$amount" },
        },
      },
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayRevenue = await Transaction.aggregate([
      {
        $match: {
          method: "bkash",
          status: "SUCCESS",
          createdAt: { $gte: today },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const todayServiceSales = await Transaction.aggregate([
      {
        $match: {
          method: "balance",
          status: "SUCCESS",
          createdAt: { $gte: today },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const revenue = revenueStats[0]?.total || 0;
    const revenueCount = revenueStats[0]?.count || 0;
    const revenueAvg = revenueStats[0]?.avg || 0;

    const serviceSales = serviceSalesStats[0]?.total || 0;
    const serviceSalesCount = serviceSalesStats[0]?.count || 0;
    const serviceSalesAvg = serviceSalesStats[0]?.avg || 0;

    const todayRevenueTotal = todayRevenue[0]?.total || 0;
    const todayServiceSalesTotal = todayServiceSales[0]?.total || 0;

    const message =
      `📊 *সিস্টেম স্ট্যাটিসটিক্স*\n\n` +
      `👥 *ইউজার স্ট্যাটস:*\n` +
      `• মোট ইউজার: ${totalUsers}\n` +
      `• একটিভ ইউজার: ${activeUsers}\n` +
      `• নতুন ইউজার: ${newUsers}\n` +
      `• ব্যান্ড ইউজার: ${bannedUsers}\n\n` +
      `📦 *সার্ভিস স্ট্যাটস:*\n` +
      `• মোট সার্ভিস: ${totalServices}\n` +
      `• সক্রিয় সার্ভিস: ${activeServices}\n\n` +
      `🛒 *অর্ডার স্ট্যাটস:*\n` +
      `• মোট অর্ডার: ${totalOrders}\n` +
      `• পেন্ডিং: ${pendingOrders}\n` +
      `• প্রসেসিং: ${processingOrders}\n` +
      `• কমপ্লিটেড: ${completedOrders}\n` +
      `• ক্যান্সেলড: ${cancelledOrders}\n\n` +
      `💰 *ফাইনান্স স্ট্যাটস:*\n` +
      `• মোট ট্রান্সাকশন: ${totalTransactions}\n` +
      `• মোট রেভিনিউ: ৳${revenue}\n` +
      `• রেভিনিউ ট্রান্সাকশন: ${revenueCount}\n` +
      `• গড় রেভিনিউ: ৳${revenueAvg.toFixed(2)}\n` +
      `• সার্ভিস সেলস: ৳${serviceSales}\n` +
      `• সার্ভিস ট্রান্সাকশন: ${serviceSalesCount}\n` +
      `• গড় সার্ভিস মূল্য: ৳${serviceSalesAvg.toFixed(2)}\n\n` +
      `📈 *আজকের পারফরমেন্স:*\n` +
      `• আজকের রেভিনিউ: ৳${todayRevenueTotal}\n` +
      `• আজকের সার্ভিস সেলস: ৳${todayServiceSalesTotal}\n\n` +
      `📅 রিপোর্ট সময়: ${new Date().toLocaleString()}`;

    await sendTextMessage(phone, message);
    await showMainMenu(phone, true);

    EnhancedLogger.info(`Admin stats sent to ${formattedPhone}`, {
      totalUsers,
      totalOrders,
      revenue,
      serviceSales,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to get stats for admin ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ স্ট্যাটিসটিক্স লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

// --- Admin User Management ---
async function handleAdminUsers(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin user management for ${formattedPhone}`);

  const userMenuRows = [
    {
      id: "admin_view_users",
      title: "👁️ ইউজার তালিকা দেখুন",
      description: "সকল ইউজারের তালিকা দেখুন",
    },
    {
      id: "admin_search_user",
      title: "🔍 ইউজার খুঁজুন",
      description: "ফোন নম্বর দিয়ে ইউজার খুঁজুন",
    },
    {
      id: "admin_user_details",
      title: "📋 ইউজার ডিটেইলস",
      description: "ইউজারের বিস্তারিত তথ্য দেখুন",
    },
    {
      id: "admin_user_stats",
      title: "📊 ইউজার স্ট্যাটিসটিক্স",
      description: "ইউজার সম্পর্কিত পরিসংখ্যান",
    },
  ];

  await sendListMenu(
    phone,
    "👥 ইউজার ম্যানেজমেন্ট",
    "ইউজার ম্যানেজমেন্ট অপশন সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
    userMenuRows,
    "ইউজার অপশন",
    "অপশন দেখুন",
  );
}

async function handleAdminViewUsers(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin viewing users for ${formattedPhone}`);

  try {
    await connectDB();
    const users = await User.find().sort({ createdAt: -1 }).limit(10);

    if (users.length === 0) {
      await sendTextMessage(phone, "📭 কোন ইউজার পাওয়া যায়নি।");
      await showMainMenu(phone, true);
      return;
    }

    let message = "👥 *ইউজার তালিকা:*\n\n";

    users.forEach((user, index) => {
      const status = user.isBanned ? "🚫" : "✅";
      const lastActive = user.whatsappLastActive
        ? new Date(user.whatsappLastActive).toLocaleDateString()
        : "কখনো না";

      message += `${index + 1}. ${status} ${user.name}\n`;
      message += `   📱: ${user.whatsapp}\n`;
      message += `   💰: ৳${user.balance}\n`;
      message += `   📊: ${user.whatsappMessageCount} মেসেজ\n`;
      message += `   📅: ${new Date(user.createdAt).toLocaleDateString()}\n`;
      message += `   ⏰: ${lastActive}\n\n`;
    });

    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      whatsappLastActive: {
        $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
    const totalBalance = await User.aggregate([
      { $group: { _id: null, total: { $sum: "$balance" } } },
    ]);
    const totalBalanceAmount = totalBalance[0]?.total || 0;

    message += `📊 *স্ট্যাটিসটিক্স:*\n`;
    message += `• মোট ইউজার: ${totalUsers}\n`;
    message += `• সক্রিয় ইউজার: ${activeUsers}\n`;
    message += `• মোট ব্যালেন্স: ৳${totalBalanceAmount}\n`;
    message += `• গড় ব্যালেন্স: ৳${(totalBalanceAmount / totalUsers).toFixed(2)}\n\n`;
    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, message);
    await showMainMenu(phone, true);
  } catch (err) {
    EnhancedLogger.error(
      `Failed to show users to admin ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ ইউজার লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

async function handleAdminUserSearchStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting user search for ${formattedPhone}`);

  await stateManager.setUserState(formattedPhone, {
    currentState: "admin_search_user_input",
    flowType: "admin_user_search",
    data: {
      lastActivity: Date.now(),
      sessionId: Date.now().toString(36),
    },
  });

  await sendTextWithCancelButton(
    phone,
    "🔍 *ইউজার খুঁজুন*\n\nখুঁজতে চান এমন ইউজারের ফোন নম্বর লিখুন:\n\nফরম্যাট:\n• 017XXXXXXXX\n• 88017XXXXXXXX\n• +88017XXXXXXXX\n\n📌 নোট: ইউজারটি সিস্টেমে থাকতে হবে",
  );
}

async function handleAdminUserSearch(
  phone: string,
  userPhone: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin searching for user: ${userPhone}`);

  try {
    const formattedUserPhone = formatPhoneNumber(userPhone);

    await connectDB();
    const user = await User.findOne({ whatsapp: formattedUserPhone });

    if (!user) {
      await sendTextMessage(
        phone,
        `❌ ইউজার পাওয়া যায়নি: ${formattedUserPhone}\n\nদয়া করে সঠিক ফোন নম্বর দিন।`,
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(phone, true);
      return;
    }

    // Get user stats
    const totalOrders = await Order.countDocuments({ userId: user._id });
    const totalSpentResult = await Order.aggregate([
      { $match: { userId: user._id } },
      { $group: { _id: null, total: { $sum: "$totalPrice" } } },
    ]);
    const totalSpent = totalSpentResult[0]?.total || 0;

    const recentOrders = await Order.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(3);

    let message = `📋 *ইউজার ডিটেইলস*\n\n`;
    message += `📛 নাম: ${user.name}\n`;
    message += `📱 ফোন: ${user.whatsapp}\n`;
    message += `💰 ব্যালেন্স: ৳${user.balance}\n`;
    message += `📊 মোট মেসেজ: ${user.whatsappMessageCount}\n`;
    message += `🚫 ব্যান্ড স্ট্যাটাস: ${user.isBanned ? "হ্যাঁ" : "না"}\n`;
    message += `📅 যোগদান: ${new Date(user.createdAt).toLocaleDateString()}\n`;
    message += `⏰ সর্বশেষ একটিভ: ${user.whatsappLastActive ? new Date(user.whatsappLastActive).toLocaleString() : "কখনো না"}\n\n`;

    message += `📊 *ইউজার স্ট্যাটস:*\n`;
    message += `• মোট অর্ডার: ${totalOrders}\n`;
    message += `• মোট খরচ: ৳${totalSpent}\n`;
    message += `• গড় অর্ডার মূল্য: ৳${totalOrders > 0 ? (totalSpent / totalOrders).toFixed(2) : "0.00"}\n\n`;

    if (recentOrders.length > 0) {
      message += `📦 *সাম্প্রতিক অর্ডার:*\n`;
      recentOrders.forEach((order, index) => {
        message += `${index + 1}. ${order.serviceName}\n`;
        message += `   🆔: ${order._id}\n`;
        message += `   💰: ৳${order.totalPrice}\n`;
        message += `   📊: ${order.status}\n`;
        message += `   📅: ${new Date(order.placedAt).toLocaleDateString()}\n\n`;
      });
    }

    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, message);
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.info(`User details sent to admin ${formattedPhone}`, {
      userId: user._id,
      userPhone: formattedUserPhone,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to search for user:`, err);
    await sendTextMessage(phone, "❌ ইউজার খুঁজতে সমস্যা হয়েছে!");
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);
  }
}

async function handleAdminUserDetails(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin viewing user details for ${formattedPhone}`);

  try {
    await connectDB();

    // Get top users by balance
    const topUsersByBalance = await User.find()
      .sort({ balance: -1 })
      .limit(5)
      .select("name whatsapp balance whatsappLastActive");

    // Get top users by orders
    const topUsersByOrders = await User.aggregate([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          as: "orders",
        },
      },
      {
        $addFields: {
          orderCount: { $size: "$orders" },
          totalSpent: { $sum: "$orders.totalPrice" },
        },
      },
      { $sort: { orderCount: -1 } },
      { $limit: 5 },
      {
        $project: {
          name: 1,
          whatsapp: 1,
          balance: 1,
          orderCount: 1,
          totalSpent: 1,
        },
      },
    ]);

    // Get recent new users
    const recentNewUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name whatsapp balance createdAt");

    let message = `📊 *ইউজার স্ট্যাটিসটিক্স*\n\n`;

    // Total user stats
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      whatsappLastActive: {
        $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
    const newUsers = await User.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });
    const bannedUsers = await User.countDocuments({ isBanned: true });

    message += `📈 *সারাংশ:*\n`;
    message += `• মোট ইউজার: ${totalUsers}\n`;
    message += `• সক্রিয় ইউজার: ${activeUsers}\n`;
    message += `• নতুন ইউজার: ${newUsers}\n`;
    message += `• ব্যান্ড ইউজার: ${bannedUsers}\n\n`;

    // Top users by balance
    if (topUsersByBalance.length > 0) {
      message += `💰 *টপ ৫ ইউজার (ব্যালেন্স):*\n`;
      topUsersByBalance.forEach((user, index) => {
        message += `${index + 1}. ${user.name} (${user.whatsapp})\n`;
        message += `   ব্যালেন্স: ৳${user.balance}\n\n`;
      });
    }

    // Top users by orders
    if (topUsersByOrders.length > 0) {
      message += `🛒 *টপ ৫ ইউজার (অর্ডার):*\n`;
      topUsersByOrders.forEach((user, index) => {
        message += `${index + 1}. ${user.name} (${user.whatsapp})\n`;
        message += `   অর্ডার: ${user.orderCount}টি\n`;
        message += `   খরচ: ৳${user.totalSpent || 0}\n\n`;
      });
    }

    // Recent new users
    if (recentNewUsers.length > 0) {
      message += `🆕 *সাম্প্রতিক নতুন ইউজার:*\n`;
      recentNewUsers.forEach((user, index) => {
        const joinDate = new Date(user.createdAt).toLocaleDateString();
        message += `${index + 1}. ${user.name} (${user.whatsapp})\n`;
        message += `   ব্যালেন্স: ৳${user.balance}\n`;
        message += `   যোগদান: ${joinDate}\n\n`;
      });
    }

    message += `📅 রিপোর্ট সময়: ${new Date().toLocaleString()}\n\n`;
    message += `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, message);
    await showMainMenu(phone, true);

    EnhancedLogger.info(`User statistics sent to admin ${formattedPhone}`, {
      totalUsers,
      activeUsers,
      newUsers,
    });
  } catch (err) {
    EnhancedLogger.error(
      `Failed to get user statistics for admin ${formattedPhone}:`,
      err,
    );
    await sendTextMessage(phone, "❌ ইউজার স্ট্যাটস লোড করতে সমস্যা হয়েছে!");
    await showMainMenu(phone, true);
  }
}

// --- Admin Add Balance ---
async function handleAdminAddBalanceStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting add balance for ${formattedPhone}`);

  await stateManager.setUserState(formattedPhone, {
    currentState: "admin_add_balance_phone",
    flowType: "admin_add_balance",
    data: {
      adminAddBalance: {
        step: 1,
      },
      lastActivity: Date.now(),
      sessionId: Date.now().toString(36),
    },
  });

  await sendTextWithCancelButton(
    phone,
    "💰 *ইউজারকে ব্যালেন্স যোগ করুন*\n\nপ্রথমে ইউজারের ফোন নম্বর লিখুন:\n\nফরম্যাট:\n• 017XXXXXXXX\n• 88017XXXXXXXX\n• +88017XXXXXXXX\n\n📌 নোট: ইউজারটি সিস্টেমে থাকতে হবে",
  );
}

async function handleAdminAddBalancePhone(
  phone: string,
  userPhone: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin adding balance to user: ${userPhone}`);

  try {
    const formattedUserPhone = formatPhoneNumber(userPhone);

    await connectDB();
    const user = await User.findOne({ whatsapp: formattedUserPhone });

    if (!user) {
      await sendTextMessage(
        phone,
        `❌ ইউজার পাওয়া যায়নি: ${formattedUserPhone}\n\nদয়া করে সঠিক ফোন নম্বর দিন।`,
      );
      return;
    }

    await stateManager.updateStateData(formattedPhone, {
      adminAddBalance: {
        phone: formattedUserPhone,
        step: 2,
      },
    });

    await sendTextWithCancelButton(
      phone,
      `✅ *ইউজার নিশ্চিত করা হয়েছে*\n\nনাম: ${user.name}\nফোন: ${formattedUserPhone}\nবর্তমান ব্যালেন্স: ৳${user.balance}\nযোগদান: ${new Date(user.createdAt).toLocaleDateString()}\n\nযোগ করতে চান এমন পরিমাণ লিখুন:\n\nউদাহরণ: 100\n\n📌 শুধু সংখ্যা লিখুন (দশমিক চিহ্ন ছাড়া)`,
    );
  } catch (err) {
    EnhancedLogger.error(`Failed to process add balance phone:`, err);
    await sendTextMessage(phone, "❌ ইউজার খুঁজতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

async function handleAdminAddBalanceAmount(
  phone: string,
  amountStr: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin adding balance amount: ${amountStr}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const userPhone = state?.data?.adminAddBalance?.phone;

    if (!userPhone) {
      await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
      await cancelFlow(phone, true);
      return;
    }

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0 || amount > 1000000) {
      await sendTextMessage(
        phone,
        "❌ দয়া করে ১ থেকে ১০,০০,০০০ এর মধ্যে সঠিক পরিমাণ লিখুন!",
      );
      return;
    }

    await stateManager.updateStateData(formattedPhone, {
      adminAddBalance: {
        phone: userPhone,
        amount: amount,
        step: 3,
      },
    });

    await sendTextWithCancelButton(
      phone,
      `💰 *ব্যালেন্স যোগ করার কারণ লিখুন*\n\nযোগ করার পরিমাণ: ৳${amount}\n\nকারণ লিখুন:\n\nউদাহরণ:\n• রিফান্ড\n• প্রচারণা বোনাস\n• সমস্যা সমাধান\n• প্রিমিয়াম সুবিধা\n\n📌 কারণটি পরিষ্কার ও বর্ণনামূলক হোক`,
    );
  } catch (err) {
    EnhancedLogger.error(`Failed to process add balance amount:`, err);
    await sendTextMessage(phone, "❌ পরিমাণ প্রসেস করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

async function handleAdminAddBalanceReason(
  phone: string,
  reason: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin adding balance with reason: ${reason}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const userData = state?.data?.adminAddBalance as
      | AdminAddBalanceStateData
      | undefined;
    const userPhone = userData?.phone;
    const amount = userData?.amount;

    if (!userPhone || !amount) {
      await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
      await cancelFlow(phone, true);
      return;
    }

    if (!reason.trim() || reason.trim().length < 3) {
      await sendTextMessage(
        phone,
        "❌ দয়া করে কমপক্ষে 3 ক্যারেক্টারের কারণ লিখুন!",
      );
      return;
    }

    await connectDB();
    const user = await User.findOne({ whatsapp: userPhone });

    if (!user) {
      await sendTextMessage(phone, "❌ ইউজার পাওয়া যায়নি!");
      await cancelFlow(phone, true);
      return;
    }

    // Add balance
    user.balance += amount;
    await user.save();

    // Create transaction record
    const transaction = await Transaction.create({
      trxId: `ADMIN-ADD-${Date.now()}`,
      amount: amount,
      method: "admin_add",
      status: "SUCCESS",
      number: userPhone,
      user: user._id,
      metadata: {
        reason: reason.trim(),
        addedBy: formattedPhone,
        addedAt: new Date().toISOString(),
      },
      createdAt: new Date(),
    });

    // Notify user
    const notificationMessage =
      `💰 *ব্যালেন্স যোগ করা হয়েছে*\n\n` +
      `যোগ করা পরিমাণ: +৳${amount}\n` +
      `কারণ: ${reason.trim()}\n` +
      `নতুন ব্যালেন্স: ৳${user.balance}\n` +
      `📅 সময়: ${new Date().toLocaleString()}\n\n` +
      `🎉 আপনার অ্যাকাউন্টে ব্যালেন্স যোগ করা হয়েছে!\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(userPhone, notificationMessage);

    // Send confirmation to admin
    const confirmMessage =
      `✅ *ব্যালেন্স যোগ সম্পন্ন*\n\n` +
      `ইউজার: ${user.name} (${userPhone})\n` +
      `যোগ করা পরিমাণ: +৳${amount}\n` +
      `পূর্ববর্তী ব্যালেন্স: ৳${user.balance - amount}\n` +
      `নতুন ব্যালেন্স: ৳${user.balance}\n` +
      `কারণ: ${reason.trim()}\n` +
      `ট্রান্সাকশন আইডি: ${transaction._id}\n\n` +
      `✅ ইউজারকে নোটিফিকেশন পাঠানো হয়েছে।\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, confirmMessage);

    await notifyAdmin(
      `💰 ব্যালেন্স যোগ করা হয়েছে\n\nইউজার: ${user.name} (${userPhone})\nপরিমাণ: +৳${amount}\nকারণ: ${reason.trim()}\nনতুন ব্যালেন্স: ৳${user.balance}\nযোগ করেছেন: ${formattedPhone}\nসময়: ${new Date().toLocaleString()}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_add_balance", {
      userPhone,
      amount,
      reason: reason.trim(),
      transactionId: transaction._id,
      newBalance: user.balance,
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to add balance:`, err);
    await sendTextMessage(phone, "❌ ব্যালেন্স যোগ করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

// --- Admin Ban User ---
async function handleAdminBanUserStart(phone: string): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin starting ban user for ${formattedPhone}`);

  await stateManager.setUserState(formattedPhone, {
    currentState: "admin_ban_user_phone",
    flowType: "admin_ban_user",
    data: {
      adminBanUser: {
        step: 1,
      },
      lastActivity: Date.now(),
      sessionId: Date.now().toString(36),
    },
  });

  await sendTextWithCancelButton(
    phone,
    "🚫 *ইউজার ব্যান করুন*\n\nব্যান করতে চান এমন ইউজারের ফোন নম্বর লিখুন:\n\nফরম্যাট:\n• 017XXXXXXXX\n• 88017XXXXXXXX\n• +88017XXXXXXXX\n\n⚠️ সতর্কতা: এটি পার্মানেন্ট অ্যাকশন!",
  );
}

async function handleAdminBanUserPhone(
  phone: string,
  userPhone: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin banning user: ${userPhone}`);

  try {
    const formattedUserPhone = formatPhoneNumber(userPhone);

    await connectDB();
    const user = await User.findOne({ whatsapp: formattedUserPhone });

    if (!user) {
      await sendTextMessage(
        phone,
        `❌ ইউজার পাওয়া যায়নি: ${formattedUserPhone}\n\nদয়া করে সঠিক ফোন নম্বর দিন।`,
      );
      return;
    }

    if (user.isBanned) {
      await sendTextMessage(
        phone,
        `⚠️ এই ইউজার ইতিমধ্যে ব্যান করা আছে।\n\nফোন: ${formattedUserPhone}\nনাম: ${user.name}\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`,
      );
      await cancelFlow(phone, true);
      return;
    }

    await stateManager.updateStateData(formattedPhone, {
      adminBanUser: {
        phone: formattedUserPhone,
        userId: user._id.toString(),
        step: 2,
      },
    });

    await sendTextWithCancelButton(
      phone,
      `✅ *ইউজার নিশ্চিত করা হয়েছে*\n\nনাম: ${user.name}\nফোন: ${formattedUserPhone}\nব্যালেন্স: ৳${user.balance}\nযোগদান: ${new Date(user.createdAt).toLocaleDateString()}\n\nব্যান করার কারণ লিখুন:\n\nউদাহরণ:\n• জালিয়াতি\n• শর্তভঙ্গ\n• অপব্যবহার\n• সন্দেহজনক কার্যকলাপ\n\n⚠️ এটি ইউজারকে সিস্টেম থেকে চিরতরে বাদ দেবে!`,
    );
  } catch (err) {
    EnhancedLogger.error(`Failed to process ban user phone:`, err);
    await sendTextMessage(phone, "❌ ইউজার খুঁজতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

async function handleAdminBanUserConfirm(
  phone: string,
  reason: string,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  EnhancedLogger.info(`Admin banning user with reason: ${reason}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const banData = state?.data?.adminBanUser as
      | AdminBanUserStateData
      | undefined;
    const userPhone = banData?.phone;
    const userId = banData?.userId;

    if (!userPhone || !userId) {
      await sendTextMessage(phone, "❌ সেশন শেষ হয়েছে!");
      await cancelFlow(phone, true);
      return;
    }

    if (!reason.trim() || reason.trim().length < 3) {
      await sendTextMessage(
        phone,
        "❌ দয়া করে কমপক্ষে 3 ক্যারেক্টারের কারণ লিখুন!",
      );
      return;
    }

    await connectDB();
    const user = await User.findByIdAndUpdate(
      userId,
      {
        isBanned: true,
        banReason: reason.trim(),
        bannedAt: new Date(),
        bannedBy: formattedPhone,
      },
      { new: true },
    );

    if (!user) {
      await sendTextMessage(phone, "❌ ইউজার পাওয়া যায়নি!");
      await cancelFlow(phone, true);
      return;
    }

    // Notify banned user
    const banNotification =
      `🚫 *আপনার অ্যাকাউন্ট ব্যান করা হয়েছে*\n\n` +
      `কারণ: ${reason.trim()}\n` +
      `ব্যান করা হয়েছে: ${new Date().toLocaleString()}\n\n` +
      `❌ আপনার Birth Help অ্যাকাউন্ট অ্যাক্সেস বন্ধ করা হয়েছে।\n` +
      `📞 এপিল করতে সাপোর্টে যোগাযোগ করুন: ${CONFIG.supportNumber}`;

    try {
      await sendTextMessage(userPhone, banNotification);
    } catch (notifyErr) {
      EnhancedLogger.error(`Failed to notify banned user:`, notifyErr);
    }

    // Send confirmation to admin
    const confirmMessage =
      `✅ *ইউজার ব্যান সম্পন্ন*\n\n` +
      `ইউজার: ${user.name}\n` +
      `ফোন: ${userPhone}\n` +
      `কারণ: ${reason.trim()}\n` +
      `ব্যান করা হয়েছে: ${new Date().toLocaleString()}\n\n` +
      `🚫 ইউজারকে নোটিফিকেশন পাঠানো হয়েছে।\n` +
      `এই ইউজার এখন সিস্টেম ব্যবহার করতে পারবে না।\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(phone, confirmMessage);

    await notifyAdmin(
      `🚫 ইউজার ব্যান করা হয়েছে\n\nইউজার: ${user.name} (${userPhone})\nকারণ: ${reason.trim()}\nব্যান করেছেন: ${formattedPhone}\nসময়: ${new Date().toLocaleString()}`,
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(phone, true);

    EnhancedLogger.logFlowCompletion(formattedPhone, "admin_ban_user", {
      userId,
      userPhone,
      reason: reason.trim(),
      bannedAt: new Date(),
    });
  } catch (err) {
    EnhancedLogger.error(`Failed to ban user:`, err);
    await sendTextMessage(phone, "❌ ইউজার ব্যান করতে সমস্যা হয়েছে!");
    await cancelFlow(phone, true);
  }
}

// --- Main Message Handler ---
async function handleUserMessage(
  phone: string,
  name: string,
  message: WhatsAppMessage,
  isAdmin: boolean,
): Promise<void> {
  const formattedPhone = formatPhoneNumber(phone);
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).substr(2);

  EnhancedLogger.logRequest(formattedPhone, message, requestId);

  try {
    // Check rate limit
    const rateLimitCheck = await checkRateLimit(formattedPhone);
    if (!rateLimitCheck.allowed) {
      await sendTextMessage(formattedPhone, rateLimitCheck.message!);
      return;
    }

    // Validate session
    const sessionValid = await validateSession(formattedPhone);
    if (!sessionValid) {
      await sendTextMessage(
        formattedPhone,
        "⏳ *সেশন শেষ হয়েছে*\n\nআপনার সেশন শেষ হয়ে গেছে। দয়া করে আবার 'Menu' লিখুন।",
      );
      return;
    }

    // Check if user is banned
    try {
      await connectDB();
      const userCheck = await User.findOne({ whatsapp: formattedPhone });
      if (userCheck?.isBanned) {
        await sendTextMessage(
          formattedPhone,
          "🚫 *আপনার অ্যাকাউন্ট ব্যান্ড করা হয়েছে*\n\nআপনার Birth Help অ্যাকাউন্টটি সাময়িকভাবে বন্ধ করা হয়েছে।\n\n📞 বিস্তারিত জানতে সাপোর্টে যোগাযোগ করুন: " +
            CONFIG.supportNumber,
        );
        return;
      }
    } catch (banCheckErr) {
      EnhancedLogger.error(
        `Error checking ban status for ${formattedPhone}:`,
        banCheckErr,
      );
    }

    const user = await getOrCreateUser(formattedPhone, name);
    EnhancedLogger.info(`[${requestId}] User processed`, {
      userId: user._id,
      isAdmin,
      phone: formattedPhone,
      userName: user.name,
    });

    const userState = await stateManager.getUserState(formattedPhone);
    const currentState = userState?.currentState;
    const flowType = userState?.flowType;

    EnhancedLogger.debug(`[${requestId}] User state`, {
      currentState,
      flowType,
    });

    if (message.type === "text") {
      const userText = message.text?.body.trim().toLowerCase() || "";
      EnhancedLogger.info(
        `[${requestId}] Text message received: "${userText}"`,
        {
          currentState,
        },
      );

      // Cancel handler for all flows
      if (
        userText === "cancel" ||
        userText === "বাতিল" ||
        userText === "c" ||
        userText === "cancel all" ||
        userText === "stop"
      ) {
        EnhancedLogger.info(`[${requestId}] Cancelling flow for user`);
        await cancelFlow(formattedPhone, isAdmin);
        return;
      }

      // ========================================
      // USER STATE HANDLERS
      // ========================================

      if (currentState === "awaiting_trx_id") {
        const trxId = userText.trim().toUpperCase();
        if (trxId) {
          EnhancedLogger.info(`[${requestId}] Processing TRX ID`);
          await handleTrxIdInput(formattedPhone, trxId);
        } else {
          await sendTextMessage(
            formattedPhone,
            "❌ দয়া করে সঠিক টিআরএক্স আইডি পাঠান। ফরম্যাট: `YOUR_TRANSACTION_ID`\n\n🚫 বাতিল করতে 'cancel' লিখুন",
          );
        }
        return;
      }

      if (currentState === "awaiting_ubrn_number") {
        EnhancedLogger.info(`[${requestId}] Processing UBRN input`);
        await handleUbrnInput(formattedPhone, userText);
        return;
      }

      if (currentState === "awaiting_instant_input") {
        EnhancedLogger.info(`[${requestId}] Processing instant service input`);
        await handleInstantServiceInput(formattedPhone, userText);
        return;
      }

      if (currentState === "awaiting_service_data") {
        EnhancedLogger.info(`[${requestId}] Processing service field input`);
        await handleServiceFieldInput(formattedPhone, userText);
        return;
      }

      if (currentState === "awaiting_service_data_edit") {
        EnhancedLogger.info(
          `[${requestId}] Processing edited service field input`,
        );
        await handleServiceFieldInput(formattedPhone, userText);
        return;
      }

      if (currentState === "awaiting_service_confirmation") {
        // Don't process text for confirmation - only use buttons
        await sendTextMessage(
          formattedPhone,
          "ℹ️ দয়া করে উপরের বাটনগুলো ব্যবহার করুন।\n\n✅ কনফার্ম করতে '✅ কনফার্ম করুন' বাটন ক্লিক করুন\n✏️ এডিট করতে '✏️ এডিট করুন' বাটন ক্লিক করুন\n🚫 বাতিল করতে '🚫 বাতিল করুন' বাটন ক্লিক করুন",
        );
        // Resend the confirmation menu
        const state = await stateManager.getUserState(formattedPhone);
        const serviceOrderData = state?.data
          ?.serviceOrder as ServiceOrderStateData;
        if (serviceOrderData?.serviceId) {
          await connectDB();
          const service = await Service.findById(serviceOrderData.serviceId);
          if (service) {
            await askForServiceConfirmation(formattedPhone, service);
          }
        }
        return;
      }

      // ========================================
      // ADMIN STATE HANDLERS
      // ========================================

      // Admin Add Service
      if (currentState?.startsWith("admin_add_service_")) {
        EnhancedLogger.info(`[${requestId}] Admin add service step`);
        await handleAdminAddServiceStep(formattedPhone, userText);
        return;
      }

      // Admin Edit Service
      if (currentState === "admin_edit_service_select") {
        EnhancedLogger.info(`[${requestId}] Admin edit service selection`);
        await handleAdminEditServiceSelection(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_edit_service_option") {
        EnhancedLogger.info(`[${requestId}] Admin edit service option`);
        await handleAdminEditServiceOption(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_edit_service_input") {
        EnhancedLogger.info(`[${requestId}] Admin edit service input`);
        await handleAdminEditServiceUpdate(formattedPhone, userText);
        return;
      }

      // Admin Delete Service
      if (currentState === "admin_delete_service_select") {
        EnhancedLogger.info(`[${requestId}] Admin delete service selection`);
        await handleAdminDeleteServiceConfirm(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_delete_service_confirm") {
        EnhancedLogger.info(`[${requestId}] Admin delete service confirmation`);
        await handleAdminDeleteServiceExecute(
          formattedPhone,
          userText === "confirm_delete",
        );
        return;
      }

      // Admin Toggle Service
      if (currentState === "admin_toggle_service_select") {
        EnhancedLogger.info(`[${requestId}] Admin toggle service selection`);
        await handleAdminToggleServiceExecute(formattedPhone, userText);
        return;
      }

      // Admin Process Order - Text Input States
      if (currentState === "admin_process_order_select") {
        EnhancedLogger.info(`[${requestId}] Admin process order selection`);
        await handleAdminProcessOrderStatus(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_process_order_status") {
        EnhancedLogger.info(`[${requestId}] Admin process order status update`);
        await handleAdminProcessOrderUpdate(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_process_order_delivery_type") {
        EnhancedLogger.info(
          `[${requestId}] Admin process order delivery type (text)`,
        );
        await handleAdminProcessOrderUpdate(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_process_order_text_input") {
        EnhancedLogger.info(`[${requestId}] Admin process order text input`);
        await handleAdminProcessOrderUpdate(formattedPhone, "", userText);
        return;
      }

      if (currentState === "admin_process_order_reason_input") {
        EnhancedLogger.info(`[${requestId}] Admin process order reason input`);
        await handleAdminProcessOrderUpdate(formattedPhone, "", userText);
        return;
      }

      // Admin Broadcast
      if (currentState === "admin_broadcast_message") {
        EnhancedLogger.info(`[${requestId}] Admin broadcast message`);
        await handleAdminBroadcastMessage(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_broadcast_type") {
        EnhancedLogger.info(`[${requestId}] Admin broadcast type`);
        await handleAdminBroadcastSend(formattedPhone, userText);
        return;
      }

      // Admin Add Balance
      if (currentState === "admin_add_balance_phone") {
        EnhancedLogger.info(`[${requestId}] Admin add balance phone`);
        await handleAdminAddBalancePhone(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_add_balance_amount") {
        EnhancedLogger.info(`[${requestId}] Admin add balance amount`);
        await handleAdminAddBalanceAmount(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_add_balance_reason") {
        EnhancedLogger.info(`[${requestId}] Admin add balance reason`);
        await handleAdminAddBalanceReason(formattedPhone, userText);
        return;
      }

      // Admin Ban User
      if (currentState === "admin_ban_user_phone") {
        EnhancedLogger.info(`[${requestId}] Admin ban user phone`);
        await handleAdminBanUserPhone(formattedPhone, userText);
        return;
      }

      if (currentState === "admin_ban_user_confirm") {
        EnhancedLogger.info(`[${requestId}] Admin ban user confirm`);
        await handleAdminBanUserConfirm(formattedPhone, userText);
        return;
      }

      // Admin User Search
      if (currentState === "admin_search_user_input") {
        EnhancedLogger.info(`[${requestId}] Admin user search`);
        await handleAdminUserSearch(formattedPhone, userText);
        return;
      }

      // ========================================
      // MENU COMMANDS (works anytime)
      // ========================================

      if (
        [
          "menu",
          "মেনু",
          "hi",
          "hello",
          "হ্যালো",
          "হাই",
          "hlw",
          "start",
          "শুরু",
          "home",
          "মেইন",
          "back",
          "ব্য়াক",
          "হোম",
        ].includes(userText)
      ) {
        EnhancedLogger.info(`[${requestId}] Showing main menu`);
        await showMainMenu(formattedPhone, isAdmin);
        return;
      }

      // Handle main commands (only if not in a flow)
      if (!currentState) {
        // User commands
        if (
          userText.includes("রিচার্জ") ||
          userText === "recharge" ||
          userText === "balance" ||
          userText.includes("ব্যালেন্স")
        ) {
          EnhancedLogger.info(`[${requestId}] Starting recharge flow`);
          await handleRechargeStart(formattedPhone);
          return;
        }

        if (
          userText.includes("সার্ভিস") ||
          userText === "services" ||
          userText === "service" ||
          userText.includes("সেবা")
        ) {
          EnhancedLogger.info(`[${requestId}] Showing regular services`);
          await showRegularServices(formattedPhone);
          return;
        }

        if (
          userText.includes("ইন্সট্যান্ট") ||
          userText === "instant" ||
          userText === "instantservice" ||
          userText.includes("তাত্ক্ষণিক")
        ) {
          EnhancedLogger.info(`[${requestId}] Showing instant services`);
          await showInstantServices(formattedPhone);
          return;
        }

        if (
          userText.includes("অর্ডার") ||
          userText === "orders" ||
          userText === "order" ||
          userText.includes("আদেশ")
        ) {
          EnhancedLogger.info(`[${requestId}] Showing order history`);
          await showOrderHistory(formattedPhone);
          return;
        }

        if (
          userText.includes("হিস্টরি") ||
          userText === "history" ||
          userText === "transactions" ||
          userText.includes("ইতিহাস")
        ) {
          EnhancedLogger.info(`[${requestId}] Showing transaction history`);
          await showTransactionHistory(formattedPhone);
          return;
        }

        if (
          userText.includes("অ্যাকাউন্ট") ||
          userText === "account" ||
          userText === "info" ||
          userText.includes("প্রোফাইল")
        ) {
          EnhancedLogger.info(`[${requestId}] Showing account info`);
          await showAccountInfo(formattedPhone);
          return;
        }

        if (
          userText.includes("সাপোর্ট") ||
          userText.includes("হেল্প") ||
          userText === "support" ||
          userText === "help" ||
          userText === "contact"
        ) {
          EnhancedLogger.info(`[${requestId}] Showing support info`);
          await showSupport(formattedPhone);
          return;
        }

        // Admin commands
        if (isAdmin) {
          if (
            userText.includes("সার্ভিস ম্যানেজ") ||
            userText === "manage services" ||
            userText === "services"
          ) {
            EnhancedLogger.info(
              `[${requestId}] Admin selected service management`,
            );
            await handleAdminServices(formattedPhone);
            return;
          }

          if (
            userText.includes("অর্ডার ম্যানেজ") ||
            userText === "manage orders" ||
            userText === "orders"
          ) {
            EnhancedLogger.info(
              `[${requestId}] Admin selected order management`,
            );
            await handleAdminOrders(formattedPhone);
            return;
          }

          if (
            userText.includes("ইউজার ম্যানেজ") ||
            userText === "manage users" ||
            userText === "users"
          ) {
            EnhancedLogger.info(
              `[${requestId}] Admin selected user management`,
            );
            await handleAdminUsers(formattedPhone);
            return;
          }

          if (
            userText.includes("ব্রডকাস্ট") ||
            userText === "broadcast" ||
            userText === "notification"
          ) {
            EnhancedLogger.info(`[${requestId}] Admin selected broadcast`);
            await handleAdminBroadcast(formattedPhone);
            return;
          }

          if (
            userText.includes("স্ট্যাটস") ||
            userText === "stats" ||
            userText === "statistics" ||
            userText === "report"
          ) {
            EnhancedLogger.info(`[${requestId}] Admin selected statistics`);
            await handleAdminStats(formattedPhone);
            return;
          }

          if (
            userText.includes("ব্যালেন্স যোগ") ||
            userText === "add balance" ||
            userText === "balance add"
          ) {
            EnhancedLogger.info(`[${requestId}] Admin selected add balance`);
            await handleAdminAddBalanceStart(formattedPhone);
            return;
          }

          if (
            userText.includes("ইউজার ব্যান") ||
            userText === "ban user" ||
            userText === "user ban"
          ) {
            EnhancedLogger.info(`[${requestId}] Admin selected ban user`);
            await handleAdminBanUserStart(formattedPhone);
            return;
          }
        }

        // Default response for unrecognized messages
        EnhancedLogger.info(`[${requestId}] Sending default welcome message`);
        await sendTextMessage(
          formattedPhone,
          "👋 *নমস্কার! Birth Help তে আপনাকে স্বাগতম!*\n\nআমাদের সার্ভিস সম্পর্কে জানতে 'Menu' লিখুন।\n\n📌 *দ্রুত গাইড:*\n• রিচার্জ করতে: 'রিচার্জ'\n• সার্ভিস দেখতে: 'সার্ভিস'\n• অর্ডার দেখতে: 'অর্ডার'\n• অ্যাকাউন্ট দেখতে: 'অ্যাকাউন্ট'\n• সাপোর্ট পেতে: 'সাপোর্ট'\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
        );
        await showMainMenu(formattedPhone, isAdmin);
      } else {
        // If in a flow but received unrecognized command
        EnhancedLogger.warn(
          `[${requestId}] Unrecognized command in flow state`,
          {
            currentState,
            userText,
          },
        );
        await sendTextMessage(
          formattedPhone,
          "❌ এই কমান্ড এখন গ্রহণযোগ্য নয়।\n\n🚫 বাতিল করতে 'cancel' লিখুন\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
        );
      }
    } else if (message.type === "interactive") {
      EnhancedLogger.info(`[${requestId}] Interactive message received`, {
        interactiveType: message.interactive?.type,
      });

      if (message.interactive?.type === "list_reply") {
        const selectedId = message.interactive?.list_reply?.id || "";
        const selectedTitle = message.interactive?.list_reply?.title || "";

        EnhancedLogger.info(`[${requestId}] List reply received`, {
          selectedId,
          selectedTitle,
        });

        // Handle user menu options
        if (selectedId.startsWith("user_")) {
          // Clear state for user menu interactions
          if (
            !currentState ||
            ![
              "awaiting_trx_id",
              "awaiting_service_confirmation",
              "awaiting_ubrn_number",
              "awaiting_instant_input",
              "awaiting_service_data",
              "awaiting_service_data_edit",
            ].includes(currentState)
          ) {
            await stateManager.clearUserState(formattedPhone);
          }

          switch (selectedId) {
            case "user_recharge":
              EnhancedLogger.info(`[${requestId}] User selected recharge`);
              await handleRechargeStart(formattedPhone);
              break;
            case "user_services":
              EnhancedLogger.info(
                `[${requestId}] User selected regular services`,
              );
              await showRegularServices(formattedPhone);
              break;
            case "user_instant":
              EnhancedLogger.info(
                `[${requestId}] User selected instant services`,
              );
              await showInstantServices(formattedPhone);
              break;
            case "user_orders":
              EnhancedLogger.info(`[${requestId}] User selected order history`);
              await showOrderHistory(formattedPhone);
              break;
            case "user_history":
              EnhancedLogger.info(
                `[${requestId}] User selected transaction history`,
              );
              await showTransactionHistory(formattedPhone);
              break;
            case "user_account":
              EnhancedLogger.info(`[${requestId}] User selected account info`);
              await showAccountInfo(formattedPhone);
              break;
            case "user_support":
              EnhancedLogger.info(`[${requestId}] User selected support`);
              await showSupport(formattedPhone);
              break;
            default:
              EnhancedLogger.warn(
                `[${requestId}] Unknown user option selected`,
                {
                  selectedId,
                },
              );
              await sendTextMessage(
                formattedPhone,
                "❌ অজানা অপশন। দয়া করে আবার চেষ্টা করুন।",
              );
              await showMainMenu(formattedPhone, isAdmin);
          }
        }
        // Handle admin menu options
        else if (selectedId.startsWith("admin_")) {
          // Clear state for admin menu interactions
          await stateManager.clearUserState(formattedPhone);

          switch (selectedId) {
            case "admin_services":
              EnhancedLogger.info(
                `[${requestId}] Admin selected service management`,
              );
              await handleAdminServices(formattedPhone);
              break;
            case "admin_orders":
              EnhancedLogger.info(
                `[${requestId}] Admin selected order management`,
              );
              await handleAdminOrders(formattedPhone);
              break;
            case "admin_users":
              EnhancedLogger.info(
                `[${requestId}] Admin selected user management`,
              );
              await handleAdminUsers(formattedPhone);
              break;
            case "admin_broadcast":
              EnhancedLogger.info(`[${requestId}] Admin selected broadcast`);
              await handleAdminBroadcast(formattedPhone);
              break;
            case "admin_stats":
              EnhancedLogger.info(`[${requestId}] Admin selected statistics`);
              await handleAdminStats(formattedPhone);
              break;
            case "admin_settings":
              EnhancedLogger.info(`[${requestId}] Admin selected settings`);
              await sendTextMessage(
                formattedPhone,
                "⚙️ *সিস্টেম সেটিংস*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
              );
              await showMainMenu(formattedPhone, true);
              break;
            // Admin Service Management
            case "admin_add_service":
              EnhancedLogger.info(`[${requestId}] Admin selected add service`);
              await handleAdminAddServiceStart(formattedPhone);
              break;
            case "admin_edit_service":
              EnhancedLogger.info(`[${requestId}] Admin selected edit service`);
              await handleAdminEditServiceStart(formattedPhone);
              break;
            case "admin_delete_service":
              EnhancedLogger.info(
                `[${requestId}] Admin selected delete service`,
              );
              await handleAdminDeleteServiceStart(formattedPhone);
              break;
            case "admin_view_services":
              EnhancedLogger.info(
                `[${requestId}] Admin selected view services`,
              );
              await handleAdminViewServices(formattedPhone);
              break;
            case "admin_toggle_service":
              EnhancedLogger.info(
                `[${requestId}] Admin selected toggle service`,
              );
              await handleAdminToggleServiceStart(formattedPhone);
              break;
            case "admin_service_stats":
              EnhancedLogger.info(
                `[${requestId}] Admin selected service stats`,
              );
              await sendTextMessage(
                formattedPhone,
                "📊 *সার্ভিস স্ট্যাটিসটিক্স*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
              );
              await showMainMenu(formattedPhone, true);
              break;
            // Admin Order Management
            case "admin_view_orders":
              EnhancedLogger.info(`[${requestId}] Admin selected view orders`);
              await handleAdminViewOrders(formattedPhone);
              break;
            case "admin_process_order":
              EnhancedLogger.info(
                `[${requestId}] Admin selected process order`,
              );
              await handleAdminProcessOrderStart(formattedPhone);
              break;
            case "admin_search_order":
              EnhancedLogger.info(`[${requestId}] Admin selected search order`);
              await sendTextMessage(
                formattedPhone,
                "🔍 *অর্ডার খুঁজুন*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
              );
              await showMainMenu(formattedPhone, true);
              break;
            case "admin_order_stats":
              EnhancedLogger.info(`[${requestId}] Admin selected order stats`);
              await sendTextMessage(
                formattedPhone,
                "📊 *অর্ডার স্ট্যাটিসটিক্স*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
              );
              await showMainMenu(formattedPhone, true);
              break;
            // Admin User Management
            case "admin_view_users":
              EnhancedLogger.info(`[${requestId}] Admin selected view users`);
              await handleAdminViewUsers(formattedPhone);
              break;
            case "admin_search_user":
              EnhancedLogger.info(`[${requestId}] Admin selected search user`);
              await handleAdminUserSearchStart(formattedPhone);
              break;
            case "admin_user_details":
              EnhancedLogger.info(`[${requestId}] Admin selected user details`);
              await handleAdminUserDetails(formattedPhone);
              break;
            case "admin_user_stats":
              EnhancedLogger.info(`[${requestId}] Admin selected user stats`);
              await sendTextMessage(
                formattedPhone,
                "📊 *ইউজার স্ট্যাটিসটিক্স*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
              );
              await showMainMenu(formattedPhone, true);
              break;
            default:
              // Handle service selection
              if (selectedId.startsWith("instant_")) {
                EnhancedLogger.info(
                  `[${requestId}] User selected instant service`,
                  {
                    selectedId,
                  },
                );
                await handleInstantServiceSelection(formattedPhone, selectedId);
              } else if (selectedId.startsWith("service_")) {
                EnhancedLogger.info(
                  `[${requestId}] User selected regular service`,
                  {
                    selectedId,
                  },
                );
                await handleRegularServiceSelection(formattedPhone, selectedId);
              } else if (selectedId.startsWith("edit_")) {
                EnhancedLogger.info(
                  `[${requestId}] Admin selected edit service`,
                  {
                    selectedId,
                  },
                );
                await stateManager.updateStateData(formattedPhone, {
                  adminEditService: {
                    serviceId: selectedId.replace("edit_", ""),
                    step: 1,
                  },
                  currentState: "admin_edit_service_option",
                });
                await handleAdminEditServiceOption(formattedPhone, selectedId);
              } else if (selectedId.startsWith("delete_")) {
                EnhancedLogger.info(
                  `[${requestId}] Admin selected delete service`,
                  {
                    selectedId,
                  },
                );
                await stateManager.updateStateData(formattedPhone, {
                  currentState: "admin_delete_service_confirm",
                });
                await handleAdminDeleteServiceConfirm(
                  formattedPhone,
                  selectedId,
                );
              } else if (selectedId.startsWith("toggle_")) {
                EnhancedLogger.info(
                  `[${requestId}] Admin selected toggle service`,
                  {
                    selectedId,
                  },
                );
                await handleAdminToggleServiceExecute(
                  formattedPhone,
                  selectedId,
                );
              } else if (selectedId.startsWith("process_")) {
                EnhancedLogger.info(
                  `[${requestId}] Admin selected process order`,
                  {
                    selectedId,
                  },
                );
                await stateManager.updateStateData(formattedPhone, {
                  currentState: "admin_process_order_status",
                });
                await handleAdminProcessOrderStatus(formattedPhone, selectedId);
              } else if (selectedId.startsWith("status_")) {
                EnhancedLogger.info(
                  `[${requestId}] Admin selected status update`,
                  {
                    selectedId,
                  },
                );
                await handleAdminProcessOrderUpdate(formattedPhone, selectedId);
              } else if (selectedId === "cancel_flow") {
                EnhancedLogger.info(`[${requestId}] User cancelled flow`);
                await cancelFlow(formattedPhone, isAdmin);
              }
              // Handle field editing options - ADDED HERE
              else if (
                selectedId.startsWith("edit_field_") ||
                selectedId === "edit_all_fields"
              ) {
                EnhancedLogger.info(`[${requestId}] User selected field edit`, {
                  selectedId,
                });

                const state = await stateManager.getUserState(formattedPhone);
                const serviceOrderData = state?.data
                  ?.serviceOrder as ServiceOrderStateData;

                if (selectedId === "edit_all_fields") {
                  // Reset to first field
                  await stateManager.updateStateData(formattedPhone, {
                    serviceOrder: {
                      ...serviceOrderData,
                      fieldIndex: 0,
                    },
                    currentState: "awaiting_service_data",
                  });
                } else {
                  // Edit specific field
                  const fieldIndex = parseInt(
                    selectedId.replace("edit_field_", ""),
                  );
                  await stateManager.updateStateData(formattedPhone, {
                    serviceOrder: {
                      ...serviceOrderData,
                      fieldIndex: fieldIndex,
                    },
                    currentState: "awaiting_service_data",
                  });
                }

                // Get service info
                await connectDB();
                const service = await Service.findById(
                  serviceOrderData?.serviceId,
                );
                if (service) {
                  if (selectedId === "edit_all_fields") {
                    await askForServiceField(formattedPhone, service, 0);
                  } else {
                    const fieldIndex = parseInt(
                      selectedId.replace("edit_field_", ""),
                    );
                    await askForServiceField(
                      formattedPhone,
                      service,
                      fieldIndex,
                    );
                  }
                }
              } else {
                EnhancedLogger.warn(`[${requestId}] Unknown option selected`, {
                  selectedId,
                });
                await sendTextMessage(
                  formattedPhone,
                  "❌ অজানা অপশন। দয়া করে আবার চেষ্টা করুন।",
                );
                await showMainMenu(formattedPhone, isAdmin);
              }
          }
        } else {
          // Handle other list replies
          if (selectedId.startsWith("instant_")) {
            EnhancedLogger.info(
              `[${requestId}] User selected instant service`,
              {
                selectedId,
              },
            );
            await handleInstantServiceSelection(formattedPhone, selectedId);
          } else if (selectedId.startsWith("service_")) {
            EnhancedLogger.info(
              `[${requestId}] User selected regular service`,
              {
                selectedId,
              },
            );
            await handleRegularServiceSelection(formattedPhone, selectedId);
          } else if (selectedId.startsWith("edit_")) {
            EnhancedLogger.info(`[${requestId}] Admin selected edit service`, {
              selectedId,
            });
            await stateManager.updateStateData(formattedPhone, {
              adminEditService: {
                serviceId: selectedId.replace("edit_", ""),
                step: 1,
              },
              currentState: "admin_edit_service_option",
            });
            await handleAdminEditServiceOption(formattedPhone, selectedId);
          } else if (selectedId.startsWith("delete_")) {
            EnhancedLogger.info(
              `[${requestId}] Admin selected delete service`,
              {
                selectedId,
              },
            );
            await stateManager.updateStateData(formattedPhone, {
              currentState: "admin_delete_service_confirm",
            });
            await handleAdminDeleteServiceConfirm(formattedPhone, selectedId);
          } else if (selectedId.startsWith("toggle_")) {
            EnhancedLogger.info(
              `[${requestId}] Admin selected toggle service`,
              {
                selectedId,
              },
            );
            await handleAdminToggleServiceExecute(formattedPhone, selectedId);
          } else if (selectedId.startsWith("process_")) {
            EnhancedLogger.info(`[${requestId}] Admin selected process order`, {
              selectedId,
            });
            await stateManager.updateStateData(formattedPhone, {
              currentState: "admin_process_order_status",
            });
            await handleAdminProcessOrderStatus(formattedPhone, selectedId);
          } else if (selectedId.startsWith("status_")) {
            EnhancedLogger.info(`[${requestId}] Admin selected status update`, {
              selectedId,
            });
            await handleAdminProcessOrderUpdate(formattedPhone, selectedId);
          } else if (selectedId === "cancel_flow") {
            EnhancedLogger.info(`[${requestId}] User cancelled flow`);
            await cancelFlow(formattedPhone, isAdmin);
          }
          // Handle field editing options - ALSO ADDED HERE FOR NON-ADMIN/USER CONTEXTS
          else if (
            selectedId.startsWith("edit_field_") ||
            selectedId === "edit_all_fields"
          ) {
            EnhancedLogger.info(`[${requestId}] User selected field edit`, {
              selectedId,
            });

            const state = await stateManager.getUserState(formattedPhone);
            const serviceOrderData = state?.data
              ?.serviceOrder as ServiceOrderStateData;

            if (selectedId === "edit_all_fields") {
              // Reset to first field
              await stateManager.updateStateData(formattedPhone, {
                serviceOrder: {
                  ...serviceOrderData,
                  fieldIndex: 0,
                },
                currentState: "awaiting_service_data",
              });
            } else {
              // Edit specific field
              const fieldIndex = parseInt(
                selectedId.replace("edit_field_", ""),
              );
              await stateManager.updateStateData(formattedPhone, {
                serviceOrder: {
                  ...serviceOrderData,
                  fieldIndex: fieldIndex,
                },
                currentState: "awaiting_service_data",
              });
            }

            // Get service info
            await connectDB();
            const service = await Service.findById(serviceOrderData?.serviceId);
            if (service) {
              if (selectedId === "edit_all_fields") {
                await askForServiceField(formattedPhone, service, 0);
              } else {
                const fieldIndex = parseInt(
                  selectedId.replace("edit_field_", ""),
                );
                await askForServiceField(formattedPhone, service, fieldIndex);
              }
            }
          } else {
            EnhancedLogger.warn(`[${requestId}] Unknown option selected`, {
              selectedId,
            });
            await sendTextMessage(
              formattedPhone,
              "❌ অজানা অপশন। দয়া করে আবার চেষ্টা করুন।",
            );
            await showMainMenu(formattedPhone, isAdmin);
          }
        }
      } else if (message.interactive?.type === "button_reply") {
        const selectedId = message.interactive?.button_reply?.id || "";

        EnhancedLogger.info(`[${requestId}] Button reply received`, {
          selectedId,
        });

        if (selectedId === "cancel_flow" || selectedId === "order_cancel") {
          EnhancedLogger.info(`[${requestId}] User cancelled flow via button`);
          await cancelFlow(formattedPhone, isAdmin);
        } else if (selectedId === "order_confirm") {
          EnhancedLogger.info(`[${requestId}] User confirmed order via button`);
          await confirmServiceOrder(formattedPhone);
        } else if (selectedId === "order_edit") {
          EnhancedLogger.info(`[${requestId}] User wants to edit order`);
          await handleEditServiceData(formattedPhone);
        } else if (selectedId.startsWith("status_")) {
          EnhancedLogger.info(`[${requestId}] Admin selected status`, {
            selectedId,
          });
          await handleAdminProcessOrderUpdate(formattedPhone, selectedId);
        } else if (selectedId.startsWith("delivery_")) {
          EnhancedLogger.info(`[${requestId}] Admin selected delivery type`, {
            selectedId,
          });
          // Call the update function with delivery type
          await handleAdminProcessOrderUpdate(formattedPhone, selectedId);
        } else if (selectedId.startsWith("field_type_")) {
          // Handle field type selection
          await handleAdminAddServiceStep(formattedPhone, selectedId);
        } else if (selectedId.startsWith("field_required_")) {
          // Handle required field selection
          await handleAdminAddServiceStep(formattedPhone, selectedId);
        } else if (selectedId.startsWith("add_fields_")) {
          // Handle add fields decision
          await handleAdminAddServiceStep(formattedPhone, selectedId);
        } else if (
          selectedId.startsWith("add_more_") ||
          selectedId.startsWith("finish_")
        ) {
          // Handle more fields or finish
          await handleAdminAddServiceStep(formattedPhone, selectedId);
        } else if (selectedId.startsWith("confirm_")) {
          // Handle confirm actions
          if (selectedId === "confirm_delete") {
            await handleAdminDeleteServiceExecute(formattedPhone, true);
          } else if (selectedId.startsWith("confirm_")) {
            await handleAdminBanUserConfirm(formattedPhone, selectedId);
          }
        } else if (
          selectedId === "cancel_action" ||
          selectedId === "cancel_delete"
        ) {
          await handleAdminDeleteServiceExecute(formattedPhone, false);
        } else if (selectedId.startsWith("broadcast_")) {
          await handleAdminBroadcastSend(formattedPhone, selectedId);
        } else if (selectedId.startsWith("edit_")) {
          await handleAdminEditServiceOption(formattedPhone, selectedId);
        } else {
          EnhancedLogger.warn(`[${requestId}] Unknown button selected`, {
            selectedId,
          });
          await sendTextMessage(
            formattedPhone,
            "ℹ️ দয়া করে লিস্ট মেনু ব্যবহার করুন। 'Menu' লিখুন।",
          );
          await showMainMenu(formattedPhone, isAdmin);
        }
      }
    } else if (message.type === "image" || message.type === "document") {
      // Handle file uploads for both user service fields and admin order delivery
      const state = await stateManager.getUserState(formattedPhone);
      const currentState = state?.currentState;
      const flowType = state?.flowType;

      EnhancedLogger.info(`[${requestId}] File/media received`, {
        messageType: message.type,
        currentState,
        flowType,
      });

      // Check if we're in file upload state for user service fields
      if (
        flowType === "service_order" &&
        (currentState === "awaiting_service_data" ||
          currentState === "awaiting_service_data_edit")
      ) {
        const serviceOrderData = state?.data
          ?.serviceOrder as ServiceOrderStateData;
        const serviceId = serviceOrderData?.serviceId;

        if (serviceId) {
          await connectDB();
          const service = await Service.findById(serviceId);

          if (service && service.requiredFields) {
            const fieldIndex = serviceOrderData?.fieldIndex || 0;
            const field = service.requiredFields[fieldIndex];

            if (field && field.type === "file") {
              EnhancedLogger.info(
                `[${requestId}] Handling file upload for service field`,
                { fieldName: field.name, fieldLabel: field.label },
              );

              // Process file upload for service field
              await handleServiceFieldInput(formattedPhone, "", message);
              return;
            }
          }
        }
      }

      // Check if we're in file upload state for admin order delivery
      if (
        flowType === "admin_process_order" &&
        (currentState === "admin_process_order_file_upload" ||
          state?.data?.adminProcessOrder?.deliveryType === "file" ||
          state?.data?.adminProcessOrder?.deliveryType === "both")
      ) {
        EnhancedLogger.info(
          `[${requestId}] Handling file upload for order delivery`,
        );
        await handleAdminFileUpload(formattedPhone, message);
      } else {
        EnhancedLogger.warn(`[${requestId}] File received in wrong state`, {
          currentState,
          flowType,
        });
        await sendTextMessage(
          formattedPhone,
          "❌ এই ধরনের মেসেজ এখন গ্রহণযোগ্য নয়।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
        );
        await showMainMenu(formattedPhone, isAdmin);
      }
    } else if (message.type === "audio" || message.type === "video") {
      EnhancedLogger.warn(`[${requestId}] Unsupported media type`, {
        messageType: message.type,
      });
      await sendTextMessage(
        formattedPhone,
        "❌ অডিও/ভিডিও ফাইল সমর্থিত নয়। দয়া করে ইমেজ বা ডকুমেন্ট ফাইল পাঠান।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
    } else {
      EnhancedLogger.warn(`[${requestId}] Unhandled message type`, {
        type: message.type,
      });
      await sendTextMessage(
        formattedPhone,
        "❌ এই ধরনের মেসেজ সমর্থিত নয়। দয়া করে টেক্সট মেসেজ পাঠান।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
      await showMainMenu(formattedPhone, isAdmin);
    }
  } catch (handlerError) {
    EnhancedLogger.error(
      `[${requestId}] Error handling message from ${formattedPhone}:`,
      handlerError,
    );

    // Try to send error message to user
    try {
      await sendTextMessage(
        formattedPhone,
        "❌ সিস্টেমে ত্রুটি হয়েছে। দয়া পরে চেষ্টা করুন।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন",
      );
    } catch (sendError) {
      EnhancedLogger.error(
        `[${requestId}] Failed to send error message:`,
        sendError,
      );
    }

    // Clear state and show menu
    try {
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
    } catch (stateError) {
      EnhancedLogger.error(`[${requestId}] Failed to clear state:`, stateError);
    }
  }
}

// --- Main Webhook Handler ---
export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).substr(2);
  EnhancedLogger.info(`[${requestId}] Webhook POST request received`, {
    url: req.url,
    method: "POST",
    timestamp: new Date().toISOString(),
  });

  try {
    sessionMonitor.start();

    if (!CONFIG.accessToken || !CONFIG.phoneNumberId) {
      EnhancedLogger.error(`[${requestId}] Missing WhatsApp configuration`, {
        hasAccessToken: !!CONFIG.accessToken,
        hasPhoneNumberId: !!CONFIG.phoneNumberId,
        hasAdminId: !!CONFIG.adminId,
      });
      return new NextResponse("Server configuration error", { status: 500 });
    }

    const body: WebhookBody = await req.json();
    EnhancedLogger.debug(`[${requestId}] Webhook body received`, {
      object: body.object,
      entryCount: body.entry?.length || 0,
    });

    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      const inboundPhoneNumberId =
        body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

      const allowed = new Set([
        process.env.WA_PHONE_NUMBER_ID, // number B (Next bot handles)
      ]);

      if (inboundPhoneNumberId && !allowed.has(inboundPhoneNumberId)) {
        return NextResponse.json({ status: "EVENT_RECEIVED" }); // ✅ ignore
      }

      if (value?.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const from = message.from;
        const userName = value.contacts?.[0]?.profile?.name || "Unknown";
        const isAdmin = from === CONFIG.adminId;

        EnhancedLogger.info(`[${requestId}] Processing message from ${from}`, {
          isAdmin,
          messageId: message.id,
          messageType: message.type,
          timestamp: message.timestamp,
        });

        // Handle message asynchronously but don't wait for it
        handleUserMessage(from, userName, message, isAdmin).catch((err) => {
          EnhancedLogger.error(
            `[${requestId}] Async message handling error:`,
            err,
          );
        });

        // Return immediate response to WhatsApp
        EnhancedLogger.info(
          `[${requestId}] Webhook processed successfully, returning 200 OK`,
        );
        return NextResponse.json({ status: "EVENT_RECEIVED" });
      } else if (value?.statuses) {
        EnhancedLogger.debug(`[${requestId}] Status update received`, {
          statuses: value.statuses,
        });
        return NextResponse.json({ status: "STATUS_RECEIVED" });
      } else {
        EnhancedLogger.warn(
          `[${requestId}] No messages or statuses in webhook`,
        );
        return NextResponse.json({ status: "NO_MESSAGES" });
      }
    } else {
      EnhancedLogger.warn(`[${requestId}] Invalid object type in webhook`, {
        object: body.object,
      });
      return new NextResponse("Not Found", { status: 404 });
    }
  } catch (e: unknown) {
    EnhancedLogger.error(`[${requestId}] Webhook processing error:`, {
      error: e instanceof Error ? e.message : "Unknown error",
      stack: e instanceof Error ? e.stack : undefined,
    });
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).substring(2);
  EnhancedLogger.info(`[${requestId}] Webhook verification request received`, {
    url: req.url,
    method: "GET",
  });

  const searchParams = req.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  EnhancedLogger.debug(`[${requestId}] Webhook verification parameters`, {
    mode,
    token,
    challenge,
  });

  if (mode && token) {
    if (mode === "subscribe" && token === CONFIG.verifyToken) {
      EnhancedLogger.info(`[${requestId}] WEBHOOK_VERIFIED successfully`);
      return new NextResponse(challenge);
    } else {
      EnhancedLogger.warn(`[${requestId}] Webhook verification failed`, {
        mode,
        token,
        expectedToken: CONFIG.verifyToken,
      });
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  EnhancedLogger.warn(`[${requestId}] Invalid verification request`, {
    mode,
    token,
  });
  return new NextResponse("Method Not Allowed", { status: 405 });
}
