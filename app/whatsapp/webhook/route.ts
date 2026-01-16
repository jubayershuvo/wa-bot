import { NextRequest, NextResponse } from "next/server";
import User from "@/models/User";
import Service, { IService, ServiceField } from "@/models/Service";
import Order, { IOrder } from "@/models/Order";
import Transaction from "@/models/Transaction";
import stateManager from "@/lib/whatsappState";
import { sessionMonitor } from "@/lib/sessionMonitor";
import { connectDB } from "@/lib/mongodb-bot";
import axios from "axios";

// --- Logging Configuration ---
const LOG_CONFIG = {
  debug: process.env.NODE_ENV === "development",
  logLevel: process.env.LOG_LEVEL || "INFO",
};

function log(level: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;

  if (data) {
    console.log(logMessage, data);
  } else {
    console.log(logMessage);
  }
}

function debug(message: string, data?: unknown) {
  if (LOG_CONFIG.debug) {
    log("DEBUG", message, data);
  }
}

function info(message: string, data?: unknown) {
  log("INFO", message, data);
}

function warn(message: string, data?: unknown) {
  log("WARN", message, data);
}

function error(message: string, data?: unknown) {
  log("ERROR", message, data);
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
  supportTelegram: process.env.SUPPORT_TELEGRAM || "t.me/signcopy",
  ubrnApiUrl: process.env.UBRN_API_URL || "https://17.fortest.top/api/search",
  ubrnServicePrice: 10, // 10 Taka for UBRN verification
  fileUploadUrl: process.env.FILE_UPLOAD_URL || "/api/upload",
  maxFileSize: 10 * 1024 * 1024, // 10MB
};

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
    changes: Array<{
      value: {
        messages?: WhatsAppMessage[];
        statuses?: string[];
      };
    }>;
  }>;
}

// --- State Data Interfaces ---
interface RechargeStateData {
  trxId?: string;
  amount?: number;
}

interface ServiceOrderStateData {
  serviceId?: string;
  price?: number;
  serviceName?: string;
  fieldIndex?: number;
  collectedData?: Record<string, string | Buffer>;
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
    isInstant?: boolean;
  };
}

interface AdminEditServiceStateData {
  serviceId?: string;
  serviceData?: Partial<IService>;
  editOption?: string;
  newField?: Partial<ServiceField>;
  fieldsAction?: string;
  fields?: ServiceField[];
  fieldIndex?: number;
}

interface AdminDeleteServiceStateData {
  serviceId?: string;
  serviceName?: string;
}

interface AdminProcessOrderStateData {
  orderId?: string;
  order?: IOrder;
  step?: number;
  fileType?: string;
  fileId?: string;
  fileName?: string;
}

interface AdminFileDeliveryStateData {
  orderId?: string;
  fileType?: string;
  fileId?: string;
  fileName?: string;
  caption?: string;
}

interface UserStateData {
  recharge?: RechargeStateData;
  serviceOrder?: ServiceOrderStateData;
  ubrn?: UbrnStateData;
  adminAddService?: AdminAddServiceStateData;
  adminEditService?: AdminEditServiceStateData;
  adminDeleteService?: AdminDeleteServiceStateData;
  adminProcessOrder?: AdminProcessOrderStateData;
  adminFileDelivery?: AdminFileDeliveryStateData;
  [key: string]: unknown;
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

async function callWhatsAppApi(endpoint: string, payload: object) {
  const url = `${CONFIG.baseUrl}/${CONFIG.apiVersion}/${CONFIG.phoneNumberId}/${endpoint}`;
  debug(`Calling WhatsApp API: ${endpoint}`, {
    payload: JSON.stringify(payload).substring(0, 500),
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      error(`WhatsApp API error for ${endpoint}:`, {
        status: response.status,
        statusText: response.statusText,
        error: result,
        payload: JSON.stringify(payload),
      });

      if (result.error?.message) {
        error(`WhatsApp API Error Message: ${result.error.message}`);
      }
      if (result.error?.error_data?.details) {
        error(
          `WhatsApp API Error Details: ${JSON.stringify(
            result.error.error_data.details
          )}`
        );
      }
    } else {
      debug(`WhatsApp API success for ${endpoint}:`, {
        messageId: result?.messages?.[0]?.id,
      });
    }

    return result;
  } catch (apiError) {
    error(`Network error calling ${endpoint}:`, apiError);
    throw apiError;
  }
}

async function sendTextMessage(to: string, text: string) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending text message to ${formattedTo}`, { textLength: text.length });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "text",
    text: {
      preview_url: false,
      body: text,
    },
  };

  debug(`Text message payload:`, payload);

  try {
    const result = await callWhatsAppApi("messages", payload);
    return result;
  } catch (err) {
    error(`Failed to send text message to ${formattedTo}:`, err);
    throw err;
  }
}

async function sendButtonMenu(
  to: string,
  headerText: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending button menu to ${formattedTo}`, {
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

  debug(`Button menu payload:`, payload);

  try {
    const result = await callWhatsAppApi("messages", payload);
    return result;
  } catch (err) {
    error(`Failed to send button menu to ${formattedTo}:`, err);
    await sendTextMessage(
      formattedTo,
      `${headerText}\n\n${bodyText}\n\nPlease use text commands or list menu.`
    );
    throw err;
  }
}

async function sendTextWithCancelButton(to: string, text: string) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending text with cancel button to ${formattedTo}`);

  try {
    await sendButtonMenu(formattedTo, "Action Required", text, [
      { id: "cancel_flow", title: "❌ বাতিল করুন" },
    ]);
  } catch (err) {
    error(`Failed to send text with cancel button to ${formattedTo}:`, err);
    await sendTextMessage(
      formattedTo,
      `${text}\n\n🚫 বাতিল করতে 'cancel' লিখুন।`
    );
  }
}

async function sendListMenu(
  to: string,
  header: string,
  body: string,
  rows: Array<{ id: string; title: string; description?: string }>,
  sectionTitle: string,
  buttonText: string = "অপশন দেখুন"
) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending list menu to ${formattedTo}`, { header, rows: rows.length });

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
        text: "Powered by SignCopy",
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

  debug(`List menu payload:`, payload);

  try {
    const result = await callWhatsAppApi("messages", payload);
    return result;
  } catch (err) {
    error(`Failed to send list menu to ${formattedTo}:`, err);
    let textMenu = `${header}\n\n${body}\n\n`;
    rows.forEach((row, index) => {
      textMenu += `${index + 1}. ${row.title}\n`;
    });
    textMenu += `\nএকটি অপশন সিলেক্ট করতে সংখ্যা লিখুন (1-${rows.length})\n🚫 বাতিল করতে 'cancel' লিখুন`;
    await sendTextMessage(formattedTo, textMenu);
    throw err;
  }
}

async function sendImage(to: string, imageUrl: string, caption?: string) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending image to ${formattedTo}`, { imageUrl, caption });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "image",
    image: {
      link: imageUrl,
      caption: caption?.substring(0, 1024),
    },
  };

  try {
    const result = await callWhatsAppApi("messages", payload);
    return result;
  } catch (err) {
    error(`Failed to send image to ${formattedTo}:`, err);
    throw err;
  }
}

async function sendDocument(
  to: string,
  documentUrl: string,
  filename: string,
  caption?: string
) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending document to ${formattedTo}`, { filename, caption });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formattedTo,
    type: "document",
    document: {
      link: documentUrl,
      filename: filename.substring(0, 240),
      caption: caption?.substring(0, 1024),
    },
  };

  try {
    const result = await callWhatsAppApi("messages", payload);
    return result;
  } catch (err) {
    error(`Failed to send document to ${formattedTo}:`, err);
    throw err;
  }
}

// --- User Management ---
async function getOrCreateUser(phone: string, name?: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Getting/creating user for ${formattedPhone}`);

  try {
    await connectDB();

    let user = await User.findOne({ whatsapp: formattedPhone });
    if (!user) {
      info(`Creating new user for ${formattedPhone}`);
      user = new User({
        name: name || "User",
        whatsapp: formattedPhone,
        whatsappLastActive: new Date(),
        whatsappMessageCount: 1,
        balance: 0,
        createdAt: new Date(),
      });
      await user.save();
      info(`Created new user with ID: ${user._id}`);
    } else {
      debug(`Found existing user: ${user._id}`);
      user.whatsappLastActive = new Date();
      user.whatsappMessageCount += 1;
      await user.save();
    }

    return user;
  } catch (err) {
    error(`Error in getOrCreateUser for ${formattedPhone}:`, err);
    throw err;
  }
}

async function notifyAdmin(message: string) {
  if (CONFIG.adminId) {
    info(`Sending admin notification to ${CONFIG.adminId}`);
    try {
      await sendTextMessage(
        CONFIG.adminId,
        `🔔 *ADMIN NOTIFICATION*\n\n${message}`
      );
    } catch (err) {
      error(`Failed to send admin notification:`, err);
    }
  }
}

// --- Main Menu Handler ---
async function showMainMenu(phone: string, isAdmin: boolean) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing main menu to ${formattedPhone}`, { isAdmin });

  try {
    await stateManager.clearUserState(formattedPhone);

    if (isAdmin) {
      await showAdminMainMenu(formattedPhone);
    } else {
      await showUserMainMenu(formattedPhone);
    }
  } catch (err) {
    error(`Failed to show main menu to ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      `🏠 *SignCopy Main Menu*\n\n` +
        `1. 💵 ব্যালেন্স রিচার্জ - 'রিচার্জ' লিখুন\n` +
        `2. 🛒 রেগুলার সার্ভিস - 'সার্ভিস' লিখুন\n` +
        `3. ⚡ ইন্সট্যান্ট সার্ভিস - 'ইন্সট্যান্ট' লিখুন\n` +
        `4. 📦 আমার অর্ডারসমূহ - 'অর্ডার' লিখুন\n` +
        `5. 📜 ট্রান্সাকশন হিস্টরি - 'হিস্টরি' লিখুন\n` +
        `6. 👤 অ্যাকাউন্ট তথ্য - 'অ্যাকাউন্ট' লিখুন\n` +
        `7. 🎧 সাপোর্ট / হেল্প - 'সাপোর্ট' লিখুন\n\n` +
        `অথবা 'Menu' লিখুন পুনরায় মেনু দেখার জন্য।`
    );
  }
}

async function showAdminMainMenu(phone: string) {
  const adminMenuRows = [
    {
      id: "admin_services",
      title: "📦 সার্ভিস ম্যানেজমেন্ট",
      description: "সার্ভিস এডিট/এড/রিমুভ",
    },
    {
      id: "admin_orders",
      title: "📋 অর্ডার ম্যানেজমেন্ট",
      description: "অর্ডার ভিউ ও প্রসেস",
    },
    {
      id: "admin_deliveries",
      title: "📤 ডেলিভারি ম্যানেজমেন্ট",
      description: "ফাইল/টেক্সট ডেলিভারি",
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
      id: "admin_users",
      title: "👥 ইউজার ম্যানেজমেন্ট",
      description: "ইউজার তালিকা ও ম্যানেজ",
    },
  ];

  await sendListMenu(
    phone,
    "⚙️ অ্যাডমিন প্যানেল",
    "অ্যাডমিন অপশনগুলো থেকে সিলেক্ট করুন:",
    adminMenuRows,
    "অ্যাডমিন মেনু",
    "অ্যাডমিন অপশন"
  );
}

async function showUserMainMenu(phone: string) {
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
  ];

  await sendListMenu(
    phone,
    "🏠 SignCopy - Main Menu",
    "আপনার প্রয়োজন অনুযায়ী নিচের অপশন সিলেক্ট করুন:",
    userMenuRows,
    "মেনু অপশনসমূহ",
    "মেনু দেখুন"
  );
}

// --- Cancel Flow Handler ---
async function cancelFlow(phone: string, isAdmin: boolean = false) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Canceling flow for ${formattedPhone}`);

  try {
    await stateManager.clearUserState(formattedPhone);
    await sendTextMessage(formattedPhone, "🚫 অপারেশন বাতিল করা হয়েছে।");
    await showMainMenu(formattedPhone, isAdmin);
  } catch (err) {
    error(`Failed to cancel flow for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ বাতিল করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
  }
}

// --- Recharge Flow ---
async function handleRechargeStart(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting recharge flow for ${formattedPhone}`);

  try {
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_trx_id",
      flowType: "recharge",
    });

    const message = `💳 *রিচার্জ করুন*\n\n📱 আমাদের বিকাশ নম্বর: *${CONFIG.bkashNumber}*\n\nবিকাশে পেমেন্ট করার পর *Transaction ID* পাঠান:\n\`TRX_ID\`\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন:`;

    await sendTextWithCancelButton(formattedPhone, message);
    info(`Recharge instructions sent to ${formattedPhone}`);
  } catch (err) {
    error(`Failed to start recharge flow for ${phone}:`, err);
    throw err;
  }
}

async function handleTrxIdInput(phone: string, trxId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing TRX ID for ${formattedPhone}`, { trxId });

  try {
    await stateManager.updateStateData(formattedPhone, {
      recharge: {
        trxId: trxId,
        amount: 0,
      },
    });

    const payment = await fetch(
      `https://api.bdx.kg/bkash/submit.php?trxid=${trxId}`
    );

    if (!payment.ok) {
      await sendTextMessage(
        formattedPhone,
        "❌ রিচার্জ যাচাই করতে ব্যর্থ। দয়া পরে চেষ্টা করুন।"
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    const paymentData = await payment.json();
    if (paymentData.error) {
      await sendTextMessage(
        formattedPhone,
        `❌ রিচার্জ যাচাই করতে ব্যর্থ: ${paymentData.error}`
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (!paymentData.amount || !paymentData.payerAccount) {
      await sendTextMessage(
        formattedPhone,
        "❌ অবৈধ ট্রান্সাকশন আইডি বা পরিমাণ। দয়া করে সঠিক তথ্য প্রদান করুন।"
      );
      await showMainMenu(formattedPhone, false);
      return;
    }
    const verifiedAmount = Number(paymentData.amount);

    await sendTextMessage(
      formattedPhone,
      `✅ *ট্রান্সাকশন ভেরিফাইড*\n\n🔢 টিআরএক্স আইডি: ${trxId}\n💰 পরিমাণ: ৳${verifiedAmount}\n📅 সময়: ${new Date().toLocaleString()}`
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
      createdAt: new Date(),
    });

    await sendTextMessage(
      formattedPhone,
      `💰 *রিচার্জ সফল*\n\nনতুন ব্যালেন্স: ৳${user.balance}\n\nধন্যবাদ!`
    );

    await notifyAdmin(
      `💰 নতুন রিচার্জ\n\nব্যবহারকারী: ${formattedPhone}\nপরিমাণ: ৳${verifiedAmount}\nটিআরএক্স: ${trxId}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
    info(`Recharge completed for ${formattedPhone}`);
  } catch (err) {
    error(`Failed to process TRX ID for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ রিচার্জ প্রক্রিয়া সম্পূর্ণ করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Instant Services Section ---
async function showInstantServices(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing instant services to ${formattedPhone}`);

  try {
    await connectDB();
    const instantServices = await Service.find({ 
      isActive: true, 
      isInstant: true 
    }).limit(10);

    // Always include UBRN verification as an instant service
    const serviceRows = [
      {
        id: "instant_ubrn_verification",
        title: "🔍 UBRN ভেরিফিকেশন - ৳10",
        description: "UBRN নাম্বার দিয়ে তথ্য যাচাই করুন",
      },
      ...instantServices.map((service) => ({
        id: `instant_${service._id}`,
        title: `${service.name} - ৳${service.price}`,
        description: service.description.substring(0, 50) + "...",
      })),
    ];

    if (serviceRows.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "⚡ *ইন্সট্যান্ট সার্ভিস*\n\nদুঃখিত, এখন কোন ইন্সট্যান্ট সার্ভিস উপলব্ধ নেই।\n\nরেগুলার সার্ভিস দেখতে 'সার্ভিস' লিখুন।"
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    await sendListMenu(
      formattedPhone,
      "⚡ ইন্সট্যান্ট সার্ভিস",
      "তাত্ক্ষণিক রেজাল্ট পাওয়ার জন্য সার্ভিস সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "ইন্সট্যান্ট সার্ভিস",
      "সার্ভিস দেখুন"
    );
    info(`Instant services list sent to ${formattedPhone}`, { 
      count: serviceRows.length 
    });
  } catch (err) {
    error(`Failed to show instant services to ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ইন্সট্যান্ট সার্ভিস লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleInstantServiceSelection(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Handling instant service selection for ${formattedPhone}`, { serviceId });

  try {
    if (serviceId === "instant_ubrn_verification") {
      // Handle UBRN verification
      await handleUbrnVerificationStart(phone);
      return;
    }

    // Handle other instant services from database
    const actualServiceId = serviceId.replace("instant_", "");
    await connectDB();
    const service = await Service.findById(actualServiceId);
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!service || !user) {
      await sendTextMessage(
        formattedPhone,
        "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!"
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < service.price) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${service.price}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।`
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_instant_service_data",
      flowType: "instant_service",
      data: {
        serviceOrder: {
          serviceId: actualServiceId,
          price: service.price,
          serviceName: service.name,
          fieldIndex: 0,
          collectedData: {},
        },
      },
    });

    // Check if service has required fields
    if (service.requiredFields && service.requiredFields.length > 0) {
      await askForServiceField(formattedPhone, service, 0);
    } else {
      // No fields required, process immediately
      await processInstantService(phone);
    }
  } catch (err) {
    error(`Failed to handle instant service selection for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস সিলেক্ট করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleUbrnVerificationStart(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting UBRN verification for ${formattedPhone}`);

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
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${CONFIG.ubrnServicePrice}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।`
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
      },
    });

    const message = `🔍 *UBRN ভেরিফিকেশন*\n\n💰 মূল্য: ৳${CONFIG.ubrnServicePrice}\n\nদয়া করে UBRN নম্বরটি পাঠান:\n(উদাহরণ: 19862692537094068)\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন`;

    await sendTextWithCancelButton(formattedPhone, message);
    info(`UBRN verification started for ${formattedPhone}`);
  } catch (err) {
    error(`Failed to start UBRN verification for ${phone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ UBRN সার্ভিস শুরু করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleUbrnInput(phone: string, ubrn: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing UBRN for ${formattedPhone}`, { ubrn });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    const ubrnData = state?.data?.ubrn as UbrnStateData | undefined;
    const attempt = (ubrnData?.attempt || 0) + 1;

    await stateManager.updateStateData(formattedPhone, {
      ubrn: {
        ubrn: ubrn.trim(),
        attempt: attempt,
      },
    });

    await sendTextMessage(
      formattedPhone,
      `⏳ UBRN তথ্য যাচাই করা হচ্ছে...\n\nUBRN: ${ubrn}\nপ্রয়াস: ${attempt}`
    );

    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < CONFIG.ubrnServicePrice) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${CONFIG.ubrnServicePrice}\nআপনার ব্যালেন্স: ৳${user.balance}`
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Call UBRN API
    let ubrnDataResult;
    try {
      const response = await axios.get(CONFIG.ubrnApiUrl, {
        params: { ubrn: ubrn.trim() },
        timeout: 30000,
      });
      ubrnDataResult = response.data;
    } catch (apiError) {
      error(`UBRN API error for ${ubrn}:`, apiError);
      await sendTextMessage(
        formattedPhone,
        `❌ UBRN API তে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।\n\nইরর: ${'Unknown error'}`
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Deduct balance
    user.balance -= CONFIG.ubrnServicePrice;
    await user.save();

    // Create transaction record only (NO ORDER CREATION)
    await Transaction.create({
      trxId: `UBRN-${Date.now()}`,
      amount: CONFIG.ubrnServicePrice,
      method: "balance",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      metadata: {
        ubrn: ubrn.trim(),
        apiResponse: ubrnDataResult,
      },
      createdAt: new Date(),
    });

    // Format and send result - NO ORDER ID INCLUDED
    let resultMessage = `✅ *UBRN ভেরিফিকেশন সম্পন্ন*\n\n`;
    resultMessage += `🔢 UBRN: ${ubrn}\n`;
    resultMessage += `💰 খরচ: ৳${CONFIG.ubrnServicePrice}\n`;
    resultMessage += `🆕 ব্যালেন্স: ৳${user.balance}\n\n`;

    if (ubrnDataResult && typeof ubrnDataResult === 'object') {
      resultMessage += `📊 *রেজাল্ট:*\n`;
      Object.entries(ubrnDataResult).forEach(([key, value]) => {
        if (value && typeof value === 'object') {
          resultMessage += `${key}:\n`;
          Object.entries(value).forEach(([subKey, subValue]) => {
            resultMessage += `  ${subKey}: ${subValue}\n`;
          });
        } else {
          resultMessage += `${key}: ${value}\n`;
        }
      });
    } else {
      resultMessage += `📊 রেজাল্ট: ${JSON.stringify(ubrnDataResult, null, 2)}\n`;
    }

    resultMessage += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, resultMessage);

    // Notify admin
    await notifyAdmin(
      `🔍 UBRN ভেরিফিকেশন সম্পন্ন\n\nব্যবহারকারী: ${formattedPhone}\nUBRN: ${ubrn}\nমূল্য: ৳${CONFIG.ubrnServicePrice}`
    );

    await stateManager.clearUserState(formattedPhone);
    info(`UBRN verification completed for ${formattedPhone}`, {
      ubrn: ubrn,
    });
  } catch (err) {
    error(`Failed to process UBRN for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ UBRN ভেরিফিকেশন করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
  }
}

async function askForServiceField(phone: string, service: IService, fieldIndex: number) {
  const formattedPhone = formatPhoneNumber(phone);
  
  if (!service.requiredFields || fieldIndex >= service.requiredFields.length) {
    // All fields collected, process service
    await processInstantService(phone);
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

  if (field.options && field.options.length > 0) {
    message += `অপশনসমূহ:\n`;
    field.options.forEach((option, index) => {
      message += `${index + 1}. ${option}\n`;
    });
    message += `\nঅপশন নম্বর লিখুন বা সরাসরি মান লিখুন:\n`;
  } else {
    message += `মান লিখুন:\n`;
  }

  message += `\n🚫 বাতিল করতে 'cancel' লিখুন`;

  await sendTextWithCancelButton(formattedPhone, message);
}

async function handleInstantServiceFieldInput(phone: string, input: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing instant service field input for ${formattedPhone}`, { input });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state || state.flowType !== "instant_service") {
      await sendTextMessage(formattedPhone, "❌ কোন একটিভ সার্ভিস পাওয়া যায়নি!");
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
      await sendTextMessage(formattedPhone, "❌ সার্ভিস বা ফিল্ড পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    const field = service.requiredFields[fieldIndex];
    let fieldValue = input.trim();

    // Handle option selection
    if (field.options && field.options.length > 0) {
      const optionIndex = parseInt(fieldValue) - 1;
      if (optionIndex >= 0 && optionIndex < field.options.length) {
        fieldValue = field.options[optionIndex];
      }
    }

    // Store collected data
    const collectedData = serviceOrderData.collectedData || {};
    collectedData[field.name] = fieldValue;

    // Update state
    fieldIndex++;
    await stateManager.updateStateData(formattedPhone, {
      serviceOrder: {
        ...serviceOrderData,
        fieldIndex: fieldIndex,
        collectedData: collectedData,
      },
    });

    if (fieldIndex < service.requiredFields.length) {
      // Ask for next field
      await askForServiceField(phone, service, fieldIndex);
    } else {
      // All fields collected, process service
      await processInstantService(phone);
    }
  } catch (err) {
    error(`Failed to process instant service field input for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ইনপুট প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function processInstantService(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing instant service for ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state || state.flowType !== "instant_service") {
      await sendTextMessage(formattedPhone, "❌ কোন একটিভ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    const serviceOrderData = state.data?.serviceOrder as ServiceOrderStateData;
    const serviceId = serviceOrderData?.serviceId;
    const price = serviceOrderData?.price;
    const serviceName = serviceOrderData?.serviceName;
    const collectedData = serviceOrderData?.collectedData || {};

    if (!serviceId || !price) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য অসম্পূর্ণ!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!service || !user) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < price) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${price}\nআপনার ব্যালেন্স: ৳${user.balance}`
      );
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }

    // Deduct balance
    user.balance -= price;
    await user.save();

    // Create transaction record only (NO ORDER CREATION)
    await Transaction.create({
      trxId: `INST-${Date.now()}`,
      amount: price,
      method: "balance",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      metadata: {
        serviceId: serviceId,
        serviceName: serviceName,
        collectedData: collectedData,
      },
      createdAt: new Date(),
    });

    // Process the instant service based on service type
    let resultMessage = `✅ *${serviceName} সম্পন্ন*\n\n`;
    resultMessage += `💰 খরচ: ৳${price}\n`;
    resultMessage += `🆕 ব্যালেন্স: ৳${user.balance}\n\n`;

    // Add collected data to result
    if (Object.keys(collectedData).length > 0) {
      resultMessage += `📝 প্রোভাইডেড ডেটা:\n`;
      Object.entries(collectedData).forEach(([key, value]) => {
        resultMessage += `• ${key}: ${value}\n`;
      });
      resultMessage += `\n`;
    }

    // TODO: Add specific instant service processing logic here
    // For now, just send success message
    resultMessage += `✅ আপনার রিকোয়েস্ট প্রসেস করা হয়েছে।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, resultMessage);

    // Notify admin
    await notifyAdmin(
      `⚡ ইন্সট্যান্ট সার্ভিস সম্পন্ন\n\nব্যবহারকারী: ${formattedPhone}\nসার্ভিস: ${serviceName}\nমূল্য: ৳${price}`
    );

    await stateManager.clearUserState(formattedPhone);
    info(`Instant service completed for ${formattedPhone}`, {
      serviceName: serviceName,
      price: price,
    });
  } catch (err) {
    error(`Failed to process instant service for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ইন্সট্যান্ট সার্ভিস প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
  }
}

// --- Regular Services Flow ---
async function showRegularServices(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing regular services to ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find({ 
      isActive: true, 
      isInstant: { $ne: true } 
    }).limit(10);

    if (services.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "📭 কোন রেগুলার সার্ভিস পাওয়া যায়নি।\n\n⚡ ইন্সট্যান্ট সার্ভিস দেখতে 'ইন্সট্যান্ট' লিখুন।"
      );
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
      "সার্ভিস সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "সার্ভিস লিস্ট",
      "সার্ভিস দেখুন"
    );
    info(`Regular services list sent to ${formattedPhone}`, { count: services.length });
  } catch (err) {
    error(`Failed to show regular services to ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleRegularServiceSelection(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Handling regular service selection for ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!service || !user) {
      await sendTextMessage(
        formattedPhone,
        "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!"
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    if (user.balance < service.price) {
      await sendTextMessage(
        formattedPhone,
        `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${service.price}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।`
      );
      await showMainMenu(formattedPhone, false);
      return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_confirmation",
      flowType: "service_order",
      data: {
        serviceOrder: {
          serviceId: serviceId,
          price: service.price,
          serviceName: service.name,
        },
      },
    });

    let message = `🛒 *অর্ডার কনফার্মেশন*\n\n📦 সার্ভিস: ${service.name}\n💰 মূল্য: ৳${service.price}\n\n`;

    if (service.instructions) {
      message += `📝 নির্দেশনা: ${service.instructions}\n\n`;
    }

    message += `✅ অর্ডার কনফার্ম করতে 'confirm' লিখুন\n`;

    await sendTextWithCancelButton(formattedPhone, message);
    info(`Service order confirmation sent to ${formattedPhone}`);
  } catch (err) {
    error(`Failed to handle regular service selection for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস সিলেক্ট করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function confirmServiceOrder(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Confirming service order for ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state || state.flowType !== "service_order") {
      await sendTextMessage(
        formattedPhone,
        "❌ কোন একটিভ অর্ডার পাওয়া যায়নি!"
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
        "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!"
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

    user.balance -= Number(serviceOrderData.price);
    await user.save();

    const transaction = await Transaction.create({
      trxId: `ORDER-${Date.now()}`,
      amount: serviceOrderData.price,
      method: "balance",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      createdAt: new Date(),
    });

    // CREATE ORDER FOR REGULAR SERVICE
    const order = await Order.create({
      orderId: `ORD-${Date.now()}`,
      userId: user._id,
      serviceId: service._id,
      serviceName: service.name,
      quantity: 1,
      unitPrice: serviceOrderData.price,
      totalPrice: serviceOrderData.price,
      serviceData: {},
      status: "pending",
      transactionId: transaction._id,
      placedAt: new Date(),
      createdAt: new Date(),
    });

    await sendTextMessage(
      formattedPhone,
      `✅ *অর্ডার সফল*\n\n📦 সার্ভিস: ${service.name}\n🆔 অর্ডার আইডি: ${order.orderId}\n💰 খরচ: ৳${serviceOrderData.price}\n🆕 ব্যালেন্স: ৳${user.balance}\n\nআমাদের সাপোর্ট টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে।`
    );

    await notifyAdmin(
      `🛒 নতুন অর্ডার\n\nব্যবহারকারী: ${formattedPhone}\nঅর্ডার আইডি: ${order.orderId}\nসার্ভিস: ${service.name}\nমূল্য: ৳${serviceOrderData.price}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
    info(`Service order completed for ${formattedPhone}`, {
      orderId: order.orderId,
    });
  } catch (err) {
    error(`Failed to confirm service order for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ অর্ডার কনফার্ম করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Order History ---
async function showOrderHistory(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing order history for ${formattedPhone}`);

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
      .limit(5);

    if (orders.length === 0) {
      await sendTextMessage(formattedPhone, "📭 আপনার কোন অর্ডার নেই।");
      await showMainMenu(formattedPhone, false);
      return;
    }

    let message = "📦 *আপনার অর্ডারসমূহ:*\n\n";

    orders.forEach((order, index) => {
      const serviceName = order.serviceName || "Unknown Service";
      const statusMap = {
        pending: "⏳",
        processing: "🔄",
        completed: "✅",
        failed: "❌",
        cancelled: "🚫",
      };
      const statusEmoji = statusMap[order.status as keyof typeof statusMap] || "📝";

      message += `${index + 1}. ${statusEmoji} ${serviceName}\n   🆔: ${order.orderId}\n   💰: ৳${order.totalPrice}\n   📅: ${new Date(order.placedAt).toLocaleDateString()}\n\n`;
    });

    message += `\n📊 মোট অর্ডার: ${orders.length}\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    info(`Order history sent to ${formattedPhone}`, { count: orders.length });
  } catch (err) {
    error(`Failed to show order history for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ অর্ডার হিস্টরি লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Account Info ---
async function showAccountInfo(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing account info for ${formattedPhone}`);

  try {
    await connectDB();
    const user = await User.findOne({ whatsapp: formattedPhone });

    if (!user) {
      await sendTextMessage(formattedPhone, "❌ ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }

    const message = `👤 *আপনার অ্যাকাউন্ট তথ্য*\n\n📛 নাম: ${user.name}\n📱 নম্বর: ${user.whatsapp}\n💰 ব্যালেন্স: ৳${user.balance}\n📅 যোগদান: ${new Date(user.createdAt).toLocaleDateString()}\n📊 মোট মেসেজ: ${user.whatsappMessageCount}\n\n📞 সাপোর্ট: ${CONFIG.supportNumber}`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);
    info(`Account info sent to ${formattedPhone}`);
  } catch (err) {
    error(`Failed to show account info for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ অ্যাকাউন্ট তথ্য লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Support ---
async function showSupport(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing support info to ${formattedPhone}`);

  try {
    const message = `🎧 *সাপোর্ট ও হেল্প*\n\nআমরা আপনার সার্ভিস সম্পর্কিত যে কোন সমস্যায় সাহায্য করতে প্রস্তুত।\n\n📞 হোয়াটসঅ্যাপ: ${CONFIG.supportNumber}\n📱 টেলিগ্রাম: ${CONFIG.supportTelegram}\n⏰ সময়: সকাল ৯টা - রাত ১১টা\n\nপ্রয়োজনে সরাসরি মেসেজ করুন।`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);
    info(`Support info sent to ${formattedPhone}`);
  } catch (err) {
    error(`Failed to show support info to ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, false);
  }
}

// --- Transaction History ---
async function showTransactionHistory(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing transaction history for ${formattedPhone}`);

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
      .limit(5);

    if (transactions.length === 0) {
      await sendTextMessage(formattedPhone, "📭 আপনার কোন ট্রান্সাকশন নেই।");
      await showMainMenu(formattedPhone, false);
      return;
    }

    let message = "📜 *ট্রান্সাকশন হিস্টরি:*\n\n";

    transactions.forEach((trx, index) => {
      const type = trx.method === "balance" ? "🛒 সার্ভিস" : "💵 রিচার্জ";
      const sign = trx.method === "balance" ? "-" : "+";
      message += `${index + 1}. ${type}\n   💰: ${sign}৳${trx.amount}\n   🆔: ${trx.trxId}\n   📅: ${new Date(trx.createdAt).toLocaleDateString()}\n\n`;
    });

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);
    info(`Transaction history sent to ${formattedPhone}`, {
      count: transactions.length,
    });
  } catch (err) {
    error(`Failed to show transaction history for ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ট্রান্সাকশন হিস্টরি লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

// --- Message Handler ---
async function handleUserMessage(
  phone: string,
  message: WhatsAppMessage,
  isAdmin: boolean
) {
  const formattedPhone = formatPhoneNumber(phone);
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);

  info(`[${requestId}] Handling message from ${formattedPhone}`, {
    type: message.type,
    isAdmin,
    messageId: message.id,
  });

  try {
    const user = await getOrCreateUser(formattedPhone);
    info(`[${requestId}] User processed`, { userId: user._id, isAdmin });

    const userState = await stateManager.getUserState(formattedPhone);
    const currentState = userState?.currentState;
    const flowType = userState?.flowType;

    debug(`[${requestId}] User state`, { currentState, flowType });

    if (message.type === "text") {
      const userText = message.text?.body.trim().toLowerCase() || "";
      info(`[${requestId}] Text message: "${userText}"`, { currentState });

      if (
        userText === "cancel" ||
        userText === "বাতিল" ||
        userText === "c" ||
        userText === "cancel all"
      ) {
        await cancelFlow(formattedPhone, isAdmin);
        return;
      }

      // ========================================
      // INSTANT SERVICES STATE HANDLERS
      // ========================================

      if (currentState === "awaiting_ubrn_number") {
        await handleUbrnInput(formattedPhone, userText);
        return;
      }

      if (currentState === "awaiting_instant_service_data") {
        await handleInstantServiceFieldInput(formattedPhone, userText);
        return;
      }

      // ========================================
      // REGULAR SERVICES STATE HANDLERS
      // ========================================

      if (currentState === "awaiting_trx_id") {
        const trxId = userText.trim().toUpperCase();
        if (trxId) {
          await handleTrxIdInput(formattedPhone, trxId);
        } else {
          await sendTextMessage(
            formattedPhone,
            "❌ দয়া করে সঠিক টিআরএক্স আইডি পাঠান। ফরম্যাট: `YOUR_TRANSACTION_ID`\n\n🚫 বাতিল করতে 'cancel' লিখুন"
          );
        }
        return;
      }

      if (
        currentState === "awaiting_service_confirmation" &&
        userText === "confirm"
      ) {
        await confirmServiceOrder(formattedPhone);
        return;
      }

      // Handle menu command (always works)
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
        ].includes(userText)
      ) {
        await showMainMenu(formattedPhone, isAdmin);
        return;
      }

      // Handle main commands (only if not in a flow)
      if (!currentState) {
        if (userText.includes("রিচার্জ") || userText === "recharge") {
          await handleRechargeStart(formattedPhone);
          return;
        }

        if (
          userText.includes("সার্ভিস") ||
          userText === "services" ||
          userText === "service"
        ) {
          await showRegularServices(formattedPhone);
          return;
        }

        if (
          userText.includes("ইন্সট্যান্ট") ||
          userText === "instant" ||
          userText === "instantservice"
        ) {
          await showInstantServices(formattedPhone);
          return;
        }

        if (
          userText.includes("অর্ডার") ||
          userText === "orders" ||
          userText === "order"
        ) {
          await showOrderHistory(formattedPhone);
          return;
        }

        if (
          userText.includes("হিস্টরি") ||
          userText === "history" ||
          userText === "transactions"
        ) {
          await showTransactionHistory(formattedPhone);
          return;
        }

        if (
          userText.includes("অ্যাকাউন্ট") ||
          userText === "account" ||
          userText === "info"
        ) {
          await showAccountInfo(formattedPhone);
          return;
        }

        if (
          userText.includes("সাপোর্ট") ||
          userText.includes("হেল্প") ||
          userText === "support" ||
          userText === "help"
        ) {
          await showSupport(formattedPhone);
          return;
        }

        // Default response for unrecognized messages
        await sendTextMessage(
          formattedPhone,
          "👋 নমস্কার! SignCopy তে আপনাকে স্বাগতম!\n\nআমাদের সার্ভিস সম্পর্কে জানতে 'Menu' লিখুন।\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন"
        );
        await showMainMenu(formattedPhone, isAdmin);
      } else {
        // If in a flow but received unrecognized command
        await sendTextMessage(
          formattedPhone,
          "❌ এই কমান্ড এখন গ্রহণযোগ্য নয়।\n\n🚫 বাতিল করতে 'cancel' লিখুন\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন"
        );
      }
    } else if (message.type === "interactive") {
      info(`[${requestId}] Interactive message received`, {
        interactiveType: message.interactive?.type,
      });

      if (message.interactive?.type === "list_reply") {
        const selectedId = message.interactive?.list_reply?.id || "";
        const selectedTitle = message.interactive?.list_reply?.title || "";

        info(`[${requestId}] List reply: "${selectedTitle}" (${selectedId})`);

        // Clear any existing state for list interactions (unless we're in a flow)
        if (
          !currentState ||
          ![
            "awaiting_trx_id",
            "awaiting_service_confirmation",
            "awaiting_ubrn_number",
            "awaiting_instant_service_data",
          ].includes(currentState)
        ) {
          await stateManager.clearUserState(formattedPhone);
        }

        // Handle user menu options
        switch (selectedId) {
          case "user_recharge":
            await handleRechargeStart(formattedPhone);
            break;
          case "user_services":
            await showRegularServices(formattedPhone);
            break;
          case "user_instant":
            await showInstantServices(formattedPhone);
            break;
          case "user_orders":
            await showOrderHistory(formattedPhone);
            break;
          case "user_history":
            await showTransactionHistory(formattedPhone);
            break;
          case "user_account":
            await showAccountInfo(formattedPhone);
            break;
          // Admin menu options (simplified)
          case "admin_services":
            await sendTextMessage(
              formattedPhone,
              "📦 *সার্ভিস ম্যানেজমেন্ট*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন"
            );
            await showMainMenu(formattedPhone, true);
            break;
          // Service selection
          default:
            if (selectedId.startsWith("instant_")) {
              await handleInstantServiceSelection(formattedPhone, selectedId);
            } else if (selectedId.startsWith("service_")) {
              const serviceId = selectedId.replace("service_", "");
              await handleRegularServiceSelection(formattedPhone, serviceId);
            } else if (selectedId === "cancel_flow") {
              await cancelFlow(formattedPhone, isAdmin);
            } else {
              await sendTextMessage(
                formattedPhone,
                "❌ অজানা অপশন। দয়া করে আবার চেষ্টা করুন।"
              );
              await showMainMenu(formattedPhone, isAdmin);
            }
        }
      } else if (message.interactive?.type === "button_reply") {
        const selectedId = message.interactive?.button_reply?.id || "";

        info(`[${requestId}] Button reply: "${selectedId}"`);

        if (selectedId === "cancel_flow") {
          await cancelFlow(formattedPhone, isAdmin);
        } else {
          await sendTextMessage(
            formattedPhone,
            "ℹ️ দয়া করে লিস্ট মেনু ব্যবহার করুন। 'Menu' লিখুন।"
          );
          await showMainMenu(formattedPhone, isAdmin);
        }
      }
    } else {
      info(`[${requestId}] Unhandled message type: ${message.type}`);
      await sendTextMessage(
        formattedPhone,
        "❌ এই ধরনের মেসেজ সমর্থিত নয়। দয়া করে টেক্সট মেসেজ পাঠান।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন"
      );
      await showMainMenu(formattedPhone, isAdmin);
    }
  } catch (handlerError) {
    error(
      `[${requestId}] Error handling message from ${formattedPhone}:`,
      handlerError
    );
    await sendTextMessage(
      formattedPhone,
      "❌ সিস্টেমে ত্রুটি হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, isAdmin);
  }
}

// --- Main Webhook Handler ---
export async function POST(req: NextRequest) {
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  info(`[${requestId}] Webhook POST request received`);

  try {
    sessionMonitor.start();

    if (!CONFIG.accessToken || !CONFIG.phoneNumberId) {
      error(`[${requestId}] Missing WhatsApp configuration`, {
        hasAccessToken: !!CONFIG.accessToken,
        hasPhoneNumberId: !!CONFIG.phoneNumberId,
      });
      return new NextResponse("Server configuration error", { status: 500 });
    }

    const body: WebhookBody = await req.json();
    debug(`[${requestId}] Webhook body received`, {
      object: body.object,
      entryCount: body.entry?.length || 0,
    });

    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (value?.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const from = message.from;
        const isAdmin = from === CONFIG.adminId;

        handleUserMessage(from, message, isAdmin).catch((err) => {
          error(`[${requestId}] Async message handling error:`, err);
        });
      } else if (value?.statuses) {
        debug(`[${requestId}] Status update received`, value.statuses);
      }

      info(`[${requestId}] Webhook processed successfully`);
      return NextResponse.json({ status: "EVENT_RECEIVED" });
    } else {
      warn(`[${requestId}] Invalid object type in webhook: ${body.object}`);
      return new NextResponse("Not Found", { status: 404 });
    }
  } catch (e) {
    error(`[${requestId}] Webhook processing error:`, e);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  info("Webhook verification request received");

  const searchParams = req.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  debug("Webhook verification parameters", { mode, token, challenge });

  if (mode && token) {
    if (mode === "subscribe" && token === CONFIG.verifyToken) {
      info("WEBHOOK_VERIFIED successfully");
      return new NextResponse(challenge);
    } else {
      warn("Webhook verification failed", {
        mode,
        token,
        expectedToken: CONFIG.verifyToken,
      });
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  warn("Invalid verification request", { mode, token });
  return new NextResponse("Method Not Allowed", { status: 405 });
}