import { NextRequest, NextResponse } from "next/server";
import User from "@/models/User";
import Service, { IService, ServiceField } from "@/models/Service";
import Order from "@/models/Order";
import Transaction from "@/models/Transaction";
import stateManager from "@/lib/whatsappState";
import { sessionMonitor } from "@/lib/sessionMonitor";
import { connectDB } from "@/lib/mongodb-bot";

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
}

interface AdminAddServiceStateData {
  step?: number;
  serviceData?: {
    name?: string;
    description?: string;
    price?: number;
    instructions?: string;
    requiredFields?: ServiceField[];
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

interface UserStateData {
  // Recharge flow
  recharge?: RechargeStateData;
  // Service order flow
  serviceOrder?: ServiceOrderStateData;
  // Admin service management
  adminAddService?: AdminAddServiceStateData;
  adminEditService?: AdminEditServiceStateData;
  adminDeleteService?: AdminDeleteServiceStateData;
  // Generic fields
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
        text: "Powered by BirthHelp AI",
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
      const adminMenuRows = [
        {
          id: "admin_services",
          title: "📦 সার্ভিস ম্যানেজমেন্ট",
          description: "সার্ভিস এডিট/এড/রিমুভ",
        },
        {
          id: "admin_orders",
          title: "📋 অর্ডার ম্যানেজমেন্ট",
          description: "অর্ডার ভিউ ও আপডেট",
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
        {
          id: "admin_settings",
          title: "⚙️ সিস্টেম সেটিংস",
          description: "সিস্টেম কনফিগারেশন",
        },
      ];

      await sendListMenu(
        formattedPhone,
        "⚙️ অ্যাডমিন প্যানেল",
        "অ্যাডমিন অপশনগুলো থেকে সিলেক্ট করুন:",
        adminMenuRows,
        "অ্যাডমিন মেনু",
        "অ্যাডমিন অপশন"
      );
    } else {
      const userMenuRows = [
        {
          id: "user_recharge",
          title: "💵 ব্যালেন্স রিচার্জ",
          description: "ব্যালেন্স রিচার্জ করুন বিকাশের মাধ্যমে",
        },
        {
          id: "user_services",
          title: "🛒 সার্ভিস কিনুন",
          description: "আমাদের সব সার্ভিস দেখুন ও কিনুন",
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
          description: "সাপোর্ট টিমের সাথে যোগাযোগ করুন",
        },
      ];

      await sendListMenu(
        formattedPhone,
        "🏠 BirthHelp - Main Menu",
        "আপনার প্রয়োজন অনুযায়ী নিচের অপশন সিলেক্ট করুন:",
        userMenuRows,
        "মেনু অপশনসমূহ",
        "মেনু দেখুন"
      );
    }
    info(`Main menu sent successfully to ${formattedPhone}`);
  } catch (err) {
    error(`Failed to show main menu to ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      `🏠 *SignCopy Main Menu*\n\n` +
        `1. 💵 ব্যালেন্স রিচার্জ - 'রিচার্জ' লিখুন\n` +
        `2. 🛒 সার্ভিস কিনুন - 'সার্ভিস' লিখুন\n` +
        `3. 📦 আমার অর্ডারসমূহ - 'অর্ডার' লিখুন\n` +
        `4. 📜 ট্রান্সাকশন হিস্টরি - 'হিস্টরি' লিখুন\n` +
        `5. 👤 অ্যাকাউন্ট তথ্য - 'অ্যাকাউন্ট' লিখুন\n` +
        `6. 🎧 সাপোর্ট / হেল্প - 'সাপোর্ট' লিখুন\n\n` +
        `অথবা 'Menu' লিখুন পুনরায় মেনু দেখার জন্য।`
    );
  }
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

    const message = `💳 *রিচার্জ করুন (Under Constuction don't use)*\n\n📱 আমাদের বিকাশ নম্বর (Payment): *${CONFIG.bkashNumber}*\nবিকাশে পেমেন্ট করার পর *Transaction ID* পাঠান:\n\`TRX_ID\`\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন:`;

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
    if (user) {
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
    }

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

// --- Services Flow ---
async function showServices(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing services to ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find({ isActive: true }).limit(10);

    if (services.length === 0) {
      await sendTextMessage(
        formattedPhone,
        "📭 কোন সার্ভিস পাওয়া যায়নি। দয়া পরে চেষ্টা করুন।"
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
      "🛍️ সার্ভিসসমূহ",
      "সার্ভিস সিলেক্ট করুন:\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন",
      serviceRows,
      "সার্ভিস লিস্ট",
      "সার্ভিস দেখুন"
    );
    info(`Services list sent to ${formattedPhone}`, { count: services.length });
  } catch (err) {
    error(`Failed to show services to ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, false);
  }
}

async function handleServiceSelection(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Handling service selection for ${formattedPhone}`, { serviceId });

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
    error(`Failed to handle service selection for ${formattedPhone}:`, err);
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

    const serviceOrderData = state.data?.serviceOrder as
      | ServiceOrderStateData
      | undefined;

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

    const order = await Order.create({
      orderId: `ORD-${Date.now()}`,
      userId: user._id,
      serviceId: service._id,
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
      `✅ *অর্ডার সফল*\n\n📦 অর্ডার আইডি: ${order.orderId}\n💰 খরচ: ৳${serviceOrderData.price}\n🆕 ব্যালেন্স: ৳${user.balance}\n\nআমাদের সাপোর্ট টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে।`
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
      .limit(5)
      .populate("service");

    if (orders.length === 0) {
      await sendTextMessage(formattedPhone, "📭 আপনার কোন অর্ডার নেই।");
      await showMainMenu(formattedPhone, false);
      return;
    }

    let message = "📦 *আপনার অর্ডারসমূহ:*\n\n";

    orders.forEach((order, index) => {
      const serviceName = order.service?.name || "Unknown Service";
      const statusMap = {
        pending: "⏳",
        processing: "🔄",
        completed: "✅",
        failed: "❌",
        cancelled: "🚫",
      };
      const statusEmoji =
        statusMap[order.status as keyof typeof statusMap] || "📝";

      message += `${index + 1}. ${statusEmoji} ${serviceName}\n   🆔: ${
        order.orderId
      }\n   💰: ৳${order.totalPrice}\n   📅: ${new Date(
        order.placedAt
      ).toLocaleDateString()}\n\n`;
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

    const message = `👤 *আপনার অ্যাকাউন্ট তথ্য*\n\n📛 নাম: ${
      user.name
    }\n📱 নম্বর: ${user.whatsapp}\n💰 ব্যালেন্স: ৳${
      user.balance
    }\n📅 যোগদান: ${new Date(
      user.createdAt
    ).toLocaleDateString()}\n📊 মোট মেসেজ: ${
      user.whatsappMessageCount
    }\n\n📞 সাপোর্ট: ${CONFIG.supportNumber}`;

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
      message += `${index + 1}. ${type}\n   💰: ${sign}৳${trx.amount}\n   🆔: ${
        trx.trxId
      }\n   📅: ${new Date(trx.createdAt).toLocaleDateString()}\n\n`;
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

// ============================================================
// ADMIN SERVICE MANAGEMENT - COMPLETE IMPLEMENTATION
// ============================================================

// --- Admin Service List ---
async function showAllServices(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing all services to admin ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().limit(10).sort({ createdAt: -1 });

    if (services.length === 0) {
      await sendTextMessage(formattedPhone, "📭 কোন সার্ভিস নেই।");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const serviceRows = services.map((service, index) => ({
      id: `admin_service_detail_${service._id}`,
      title: `${index + 1}. ${service.name}`,
      description: `৳${service.price} | ${service.isActive ? "✅" : "❌"} | ${
        service.requiredFields?.length || 0
      } ফিল্ড`,
    }));

    await sendListMenu(
      formattedPhone,
      "📋 সকল সার্ভিস",
      `মোট সার্ভিস: ${services.length}\nসক্রিয়: ${
        services.filter((s) => s.isActive).length
      }\n\nএকটি সার্ভিস সিলেক্ট করুন:`,
      serviceRows,
      "সার্ভিস তালিকা",
      "সার্ভিস দেখুন"
    );
  } catch (err) {
    error(`Failed to show all services to admin ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে।");
    await showMainMenu(formattedPhone, true);
  }
}

// --- Add New Service - Step by Step ---
async function addNewService(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting add new service flow for admin ${formattedPhone}`);

  try {
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_name",
      flowType: "admin_add_service",
      data: {
        adminAddService: {
          step: 1,
          serviceData: {},
        },
      },
    });

    const message =
      "➕ *নতুন সার্ভিস যোগ করুন*\n\nস্টেপ 1/5: সার্ভিসের নাম লিখুন\n\nউদাহরণ: Facebook Page Creation\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন";

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(
      `Failed to start add new service flow for admin ${formattedPhone}:`,
      err
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleServiceNameInput(phone: string, name: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing service name for admin ${formattedPhone}`, { name });

  try {
    await stateManager.updateStateData(formattedPhone, {
      adminAddService: {
        serviceData: { name: name.trim() },
        step: 2,
      },
    });

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_description",
      flowType: "admin_add_service",
    });

    const message =
      "➕ *নতুন সার্ভিস যোগ করুন*\n\nস্টেপ 2/5: সার্ভিসের বিস্তারিত বর্ণনা লিখুন\n\nউদাহরণ: আমরা আপনার জন্য প্রফেশনাল Facebook Page তৈরি করে দেবো।\n\n🚫 বাতিল করতে 'cancel' লিখুন";

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to process service name for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ নাম প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleServiceDescriptionInput(
  phone: string,
  description: string
) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing service description for admin ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    const adminAddServiceData = state.data?.adminAddService as
      | AdminAddServiceStateData
      | undefined;

    await stateManager.updateStateData(formattedPhone, {
      adminAddService: {
        ...adminAddServiceData,
        serviceData: {
          ...adminAddServiceData?.serviceData,
          description: description.trim(),
        },
        step: 3,
      },
    });

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_price",
      flowType: "admin_add_service",
    });

    const message =
      "➕ *নতুন সার্ভিস যোগ করুন*\n\nস্টেপ 3/5: সার্ভিসের মূল্য লিখুন (টাকায়)\n\nউদাহরণ: 500\n\n🚫 বাতিল করতে 'cancel' লিখুন";

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(
      `Failed to process service description for admin ${formattedPhone}:`,
      err
    );
    await sendTextMessage(
      formattedPhone,
      "❌ বর্ণনা প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleServicePriceInput(phone: string, priceText: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing service price for admin ${formattedPhone}`, { priceText });

  try {
    const price = parseFloat(priceText.trim());
    if (isNaN(price) || price <= 0) {
      await sendTextMessage(
        formattedPhone,
        "❌ অবৈধ মূল্য। দয়া করে সঠিক সংখ্যা লিখুন (যেমন: 500)"
      );
      return;
    }

    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    const adminAddServiceData = state.data?.adminAddService as
      | AdminAddServiceStateData
      | undefined;

    await stateManager.updateStateData(formattedPhone, {
      adminAddService: {
        ...adminAddServiceData,
        serviceData: {
          ...adminAddServiceData?.serviceData,
          price: price,
        },
        step: 4,
      },
    });

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_instructions",
      flowType: "admin_add_service",
    });

    const message =
      "➕ *নতুন সার্ভিস যোগ করুন*\n\nস্টেপ 4/5: সার্ভিসের নির্দেশনা লিখুন (ঐচ্ছিক)\n\nউদাহরণ: অর্ডার দেওয়ার পর আপনার Facebook login details প্রয়োজন হবে।\n\n📝 নির্দেশনা ছাড়া এগিয়ে যেতে 'skip' লিখুন\n🚫 বাতিল করতে 'cancel' লিখুন";

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to process service price for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ মূল্য প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleServiceInstructionsInput(
  phone: string,
  instructions: string
) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing service instructions for admin ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    const adminAddServiceData = state.data?.adminAddService as
      | AdminAddServiceStateData
      | undefined;
    const serviceData = adminAddServiceData?.serviceData || {};

    // Update instructions if not skipping
    if (instructions.toLowerCase() !== "skip") {
      serviceData.instructions = instructions.trim();
    }

    await stateManager.updateStateData(formattedPhone, {
      adminAddService: {
        ...adminAddServiceData,
        serviceData: serviceData,
        step: 5,
      },
    });

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_fields_confirmation",
      flowType: "admin_add_service",
    });

    const message = `➕ *নতুন সার্ভিস যোগ করুন*\n\nস্টেপ 5/5: সার্ভিস ডেটা প্রস্তুত\n\n📛 নাম: ${
      serviceData.name
    }\n📝 বর্ণনা: ${serviceData.description?.substring(
      0,
      100
    )}...\n💰 মূল্য: ৳${serviceData.price}\n📋 নির্দেশনা: ${
      serviceData.instructions || "না"
    }\n\n✅ সার্ভিস তৈরি করতে 'confirm' লিখুন\n🔧 ফিল্ড যোগ করতে 'add fields' লিখুন\n🚫 বাতিল করতে 'cancel' লিখুন`;

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(
      `Failed to process service instructions for admin ${formattedPhone}:`,
      err
    );
    await sendTextMessage(
      formattedPhone,
      "❌ নির্দেশনা প্রসেস করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function confirmServiceCreation(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Confirming service creation for admin ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস ডেটা পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminAddServiceData = state.data?.adminAddService as
      | AdminAddServiceStateData
      | undefined;
    const serviceData = adminAddServiceData?.serviceData;

    if (!serviceData?.name || !serviceData.description || !serviceData.price) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস ডেটা অসম্পূর্ণ!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await connectDB();

    // Generate service ID from name
    const serviceId = serviceData.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const newService = new Service({
      id: serviceId,
      name: serviceData.name,
      description: serviceData.description,
      price: serviceData.price,
      instructions: serviceData.instructions || undefined,
      requiredFields: serviceData.requiredFields || [],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await newService.save();

    await sendTextMessage(
      formattedPhone,
      `✅ *সার্ভিস তৈরি সফল*\n\n📛 নাম: ${newService.name}\n💰 মূল্য: ৳${newService.price}\n🆔 সার্ভিস আইডি: ${newService._id}\n\nসার্ভিসটি সফলভাবে তৈরি হয়েছে এবং ইউজারদের জন্য উপলব্ধ।`
    );

    await notifyAdmin(
      `➕ নতুন সার্ভিস তৈরি\n\nসার্ভিস: ${newService.name}\nমূল্য: ৳${newService.price}\nতৈরিকারী: ${formattedPhone}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
    info(`Service created successfully by admin ${formattedPhone}`, {
      serviceId: newService._id,
    });
  } catch (err) {
    error(`Failed to create service for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস তৈরি করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

// --- Edit Service ---
async function handleAdminServiceEdit(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting service edit flow for admin ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().limit(10).sort({ name: 1 });

    if (services.length === 0) {
      await sendTextMessage(formattedPhone, "📭 কোন সার্ভিস নেই।");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const serviceRows = services.map((service) => ({
      id: `admin_edit_service_${service._id}`,
      title: service.name,
      description: `৳${service.price} | ${service.isActive ? "✅" : "❌"}`,
    }));

    await sendListMenu(
      formattedPhone,
      "✏️ সার্ভিস এডিট করুন",
      "এডিট করতে চান এমন সার্ভিস সিলেক্ট করুন:",
      serviceRows,
      "সার্ভিস তালিকা",
      "সার্ভিস সিলেক্ট করুন"
    );
  } catch (err) {
    error(
      `Failed to start service edit flow for admin ${formattedPhone}:`,
      err
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleServiceSelectionForEdit(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Handling service selection for edit by admin ${formattedPhone}`, {
    serviceId,
  });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_edit_option",
      flowType: "admin_edit_service",
      data: {
        adminEditService: {
          serviceId: serviceId,
          serviceData: service.toObject(),
        },
      },
    });

    const editRows = [
      {
        id: "edit_service_name",
        title: "📛 নাম পরিবর্তন",
        description: "সার্ভিসের নাম পরিবর্তন করুন",
      },
      {
        id: "edit_service_description",
        title: "📝 বর্ণনা পরিবর্তন",
        description: "সার্ভিস বর্ণনা পরিবর্তন করুন",
      },
      {
        id: "edit_service_price",
        title: "💰 মূল্য পরিবর্তন",
        description: "সার্ভিস মূল্য পরিবর্তন করুন",
      },
      {
        id: "edit_service_instructions",
        title: "📋 নির্দেশনা পরিবর্তন",
        description: "সার্ভিস নির্দেশনা পরিবর্তন করুন",
      },
      {
        id: "edit_service_status",
        title: "⚡ স্ট্যাটাস পরিবর্তন",
        description: "সক্রিয়/নিষ্ক্রিয় করুন",
      },
      {
        id: "edit_service_fields",
        title: "🔧 ফিল্ড ম্যানেজমেন্ট",
        description: "সার্ভিস ফিল্ড যোগ/এডিট করুন",
      },
    ];

    await sendListMenu(
      formattedPhone,
      `✏️ এডিট: ${service.name}`,
      `বর্তমান তথ্য:\n💰 মূল্য: ৳${service.price}\n📊 স্ট্যাটাস: ${
        service.isActive ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"
      }\n\nকি পরিবর্তন করতে চান?`,
      editRows,
      "এডিট অপশন",
      "এডিট অপশন"
    );
  } catch (err) {
    error(
      `Failed to handle service selection for edit by admin ${formattedPhone}:`,
      err
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleServiceEditOption(
  phone: string,
  option: string,
  serviceId: string
) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Handling service edit option for admin ${formattedPhone}`, {
    option,
    serviceId,
  });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        ...(state.data?.adminEditService || {}),
        editOption: option,
      },
    });

    let nextState = "";
    let message = "";

    switch (option) {
      case "edit_service_name":
        nextState = "awaiting_new_service_name";
        message =
          "✏️ *সার্ভিস নাম পরিবর্তন*\n\nনতুন নাম লিখুন:\n\n🚫 বাতিল করতে 'cancel' লিখুন";
        break;
      case "edit_service_description":
        nextState = "awaiting_new_service_description";
        message =
          "✏️ *সার্ভিস বর্ণনা পরিবর্তন*\n\nনতুন বর্ণনা লিখুন:\n\n🚫 বাতিল করতে 'cancel' লিখুন";
        break;
      case "edit_service_price":
        nextState = "awaiting_new_service_price";
        message =
          "✏️ *সার্ভিস মূল্য পরিবর্তন*\n\nনতুন মূল্য লিখুন (টাকায়):\n\n🚫 বাতিল করতে 'cancel' লিখুন";
        break;
      case "edit_service_instructions":
        nextState = "awaiting_new_service_instructions";
        message =
          "✏️ *সার্ভিস নির্দেশনা পরিবর্তন*\n\nনতুন নির্দেশনা লিখুন:\n\n📝 নির্দেশনা মুছে ফেলতে 'remove' লিখুন\n🚫 বাতিল করতে 'cancel' লিখুন";
        break;
      case "edit_service_status":
        await toggleServiceStatusNow(phone, serviceId);
        return;
      case "edit_service_fields":
        await manageServiceFields(phone, serviceId);
        return;
      default:
        await sendTextMessage(formattedPhone, "❌ অজানা অপশন।");
        await showMainMenu(formattedPhone, true);
        return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: nextState,
      flowType: "admin_edit_service",
    });

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(
      `Failed to handle service edit option for admin ${formattedPhone}:`,
      err
    );
    await sendTextMessage(formattedPhone, "❌ অপশন প্রসেস করতে সমস্যা হয়েছে।");
    await showMainMenu(formattedPhone, true);
  }
}

async function toggleServiceStatusNow(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Toggling service status for admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    service.isActive = !service.isActive;
    await service.save();

    await sendTextMessage(
      formattedPhone,
      `✅ *সার্ভিস স্ট্যাটাস পরিবর্তন সফল*\n\n📛 সার্ভিস: ${
        service.name
      }\n🔄 নতুন স্ট্যাটাস: ${
        service.isActive ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"
      }\n\nসার্ভিসটি এখন ${
        service.isActive ? "ইউজারদের জন্য উপলব্ধ" : "অপ্রাপ্য"
      }`
    );

    await notifyAdmin(
      `⚡ সার্ভিস স্ট্যাটাস পরিবর্তন\n\nসার্ভিস: ${
        service.name
      }\nনতুন স্ট্যাটাস: ${
        service.isActive ? "সক্রিয়" : "নিষ্ক্রিয়"
      }\nতৈরিকারী: ${formattedPhone}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to toggle service status for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ স্ট্যাটাস পরিবর্তন করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function updateServiceField(
  phone: string,
  fieldName: string,
  newValue: string
) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Updating service field for admin ${formattedPhone}`, {
    fieldName,
    newValue,
  });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;
    const serviceId = adminEditServiceData?.serviceId;
    const editOption = adminEditServiceData?.editOption;

    if (!serviceId) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস আইডি পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    let updateField = "";
    let updateValue: string | number = newValue.trim();

    switch (editOption) {
      case "edit_service_name":
        updateField = "নাম";
        service.name = updateValue;
        break;
      case "edit_service_description":
        updateField = "বর্ণনা";
        service.description = updateValue;
        break;
      case "edit_service_price":
        const price = parseFloat(updateValue);
        if (isNaN(price) || price <= 0) {
          await sendTextMessage(
            formattedPhone,
            "❌ অবৈধ মূল্য। দয়া করে সঠিক সংখ্যা লিখুন।"
          );
          return;
        }
        updateField = "মূল্য";
        service.price = price;
        updateValue = `৳${price}`;
        break;
      case "edit_service_instructions":
        updateField = "নির্দেশনা";
        if (newValue.toLowerCase() === "remove") {
          service.instructions = undefined;
          updateValue = "মুছে ফেলা হয়েছে";
        } else {
          service.instructions = updateValue;
        }
        break;
      default:
        await sendTextMessage(formattedPhone, "❌ অজানা ফিল্ড।");
        await showMainMenu(formattedPhone, true);
        return;
    }

    service.updatedAt = new Date();
    await service.save();

    await sendTextMessage(
      formattedPhone,
      `✅ *সার্ভিস আপডেট সফল*\n\n📛 সার্ভিস: ${service.name}\n🔄 ${updateField}: ${updateValue}\n\nসার্ভিস তথ্য সফলভাবে আপডেট হয়েছে।`
    );

    await notifyAdmin(
      `✏️ সার্ভিস আপডেট\n\nসার্ভিস: ${service.name}\n${updateField}: ${updateValue}\nতৈরিকারী: ${formattedPhone}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to update service field for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ সার্ভিস আপডেট করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

// --- Manage Service Fields ---
async function manageServiceFields(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Managing service fields for admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_fields_action",
      flowType: "admin_manage_fields",
      data: {
        adminEditService: {
          serviceId: serviceId,
        },
      },
    });

    const fieldRows = [
      {
        id: "add_new_field",
        title: "➕ নতুন ফিল্ড যোগ",
        description: "সার্ভিসে নতুন ফিল্ড যোগ করুন",
      },
      {
        id: "view_fields",
        title: "👁️ ফিল্ডসমূহ দেখুন",
        description: "সকল ফিল্ডের তালিকা",
      },
      {
        id: "edit_field",
        title: "✏️ ফিল্ড এডিট",
        description: "বিদ্যমান ফিল্ড এডিট করুন",
      },
      {
        id: "delete_field",
        title: "🗑️ ফিল্ড ডিলিট",
        description: "ফিল্ড মুছে ফেলুন",
      },
    ];

    await sendListMenu(
      formattedPhone,
      `🔧 ফিল্ড ম্যানেজমেন্ট: ${service.name}`,
      `বর্তমান ফিল্ড: ${service.requiredFields?.length || 0}টি\n\nকি করতে চান?`,
      fieldRows,
      "ফিল্ড অপশন",
      "অপশন সিলেক্ট"
    );
  } catch (err) {
    error(`Failed to manage service fields for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function handleFieldsAction(phone: string, action: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Handling fields action for admin ${formattedPhone}`, { action });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;
    const serviceId = adminEditServiceData?.serviceId;

    if (!serviceId) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস আইডি পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        ...adminEditServiceData,
        fieldsAction: action,
      },
    });

    let message = "";

    switch (action) {
      case "add_new_field":
        await stateManager.setUserState(formattedPhone, {
          currentState: "awaiting_field_name",
          flowType: "admin_manage_fields",
        });
        message =
          "➕ *নতুন ফিল্ড যোগ করুন*\n\nস্টেপ 1/4: ফিল্ডের নাম লিখুন (ইংরেজিতে)\n\nউদাহরণ: page_name\n\n🚫 বাতিল করতে 'cancel' লিখুন";
        break;
      case "view_fields":
        await viewServiceFields(formattedPhone, serviceId);
        return;
      case "edit_field":
        await showFieldsForEdit(formattedPhone, serviceId);
        return;
      case "delete_field":
        await showFieldsForDelete(formattedPhone, serviceId);
        return;
      default:
        await sendTextMessage(formattedPhone, "❌ অজানা অপশন।");
        await showMainMenu(formattedPhone, true);
        return;
    }

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to handle fields action for admin ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ অপশন প্রসেস করতে সমস্যা হয়েছে।");
    await showMainMenu(formattedPhone, true);
  }
}

async function viewServiceFields(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Viewing service fields for admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fields = service.requiredFields || [];

    if (fields.length === 0) {
      await sendTextMessage(
        formattedPhone,
        `📭 '${service.name}' সার্ভিসে কোন ফিল্ড নেই।`
      );
      await showMainMenu(formattedPhone, true);
      return;
    }

    let message = `📋 *ফিল্ড তালিকা: ${service.name}*\n\n`;

    fields.forEach((field: ServiceField, index: number) => {
      const typeMap = {
        text: "📝 টেক্সট",
        number: "🔢 নাম্বার",
        select: "📑 সিলেক্ট",
        file: "📁 ফাইল",
      };

      message += `${index + 1}. ${field.name}\n`;
      message += `   লেবেল: ${field.label}\n`;
      message += `   টাইপ: ${
        typeMap[field.type as keyof typeof typeMap] || field.type
      }\n`;
      message += `   প্রয়োজনীয়: ${field.required ? "✅ হ্যাঁ" : "❌ না"}\n`;

      if (field.options && field.options.length > 0) {
        message += `   অপশন: ${field.options.slice(0, 3).join(", ")}${
          field.options.length > 3 ? "..." : ""
        }\n`;
      }

      message += `\n`;
    });

    message += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to view service fields for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function handleFieldNameInput(phone: string, fieldName: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing field name for admin ${formattedPhone}`, { fieldName });

  try {
    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        newField: {
          name: fieldName.toLowerCase().replace(/\s+/g, "_"),
          type: "text",
          required: true,
        },
      },
    });

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_field_label",
      flowType: "admin_manage_fields",
    });

    const message =
      "➕ *নতুন ফিল্ড যোগ করুন*\n\nস্টেপ 2/4: ফিল্ডের লেবেল লিখুন (বাংলায়)\n\nউদাহরণ: পেজের নাম\n\n🚫 বাতিল করতে 'cancel' লিখুন";

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to process field name for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ফিল্ড নাম প্রসেস করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleFieldLabelInput(phone: string, label: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing field label for admin ${formattedPhone}`, { label });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        ...adminEditServiceData,
        newField: {
          ...adminEditServiceData?.newField,
          label: label.trim(),
        },
      },
    });

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_field_type",
      flowType: "admin_manage_fields",
    });

    const typeRows = [
      {
        id: "field_type_text",
        title: "📝 টেক্সট",
        description: "সাধারণ টেক্সট ইনপুট",
      },
      {
        id: "field_type_number",
        title: "🔢 নাম্বার",
        description: "সংখ্যা ইনপুট",
      },
      {
        id: "field_type_select",
        title: "📑 সিলেক্ট",
        description: "ড্রপডাউন অপশন",
      },
      { id: "field_type_file", title: "📁 ফাইল", description: "ফাইল আপলোড" },
    ];

    await sendListMenu(
      formattedPhone,
      "➕ *নতুন ফিল্ড যোগ করুন*",
      "স্টেপ 3/4: ফিল্ড টাইপ সিলেক্ট করুন\n\nবর্তমান ফিল্ড:\nনাম: " +
        (adminEditServiceData?.newField?.name || "") +
        "\nলেবেল: " +
        label,
      typeRows,
      "ফিল্ড টাইপ",
      "টাইপ সিলেক্ট"
    );
  } catch (err) {
    error(`Failed to process field label for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ফিল্ড লেবেল প্রসেস করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleFieldTypeSelection(phone: string, fieldType: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing field type for admin ${formattedPhone}`, { fieldType });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;

    const typeMap: Record<string, string> = {
      field_type_text: "text",
      field_type_number: "number",
      field_type_select: "select",
      field_type_file: "file",
    };

    const actualType = typeMap[fieldType] || "text";

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        ...adminEditServiceData,
        newField: {
          ...adminEditServiceData?.newField,
          type: actualType,
        },
      },
    });

    if (actualType === "select") {
      await stateManager.setUserState(formattedPhone, {
        currentState: "awaiting_field_options",
        flowType: "admin_manage_fields",
      });

      const message =
        "➕ *নতুন ফিল্ড যোগ করুন*\n\nস্টেপ 4/4: সিলেক্ট অপশনসমূহ লিখুন\n\nফরম্যাট: অপশন1, অপশন2, অপশন3\nউদাহরণ: ছোট, মাঝারি, বড়\n\n🚫 বাতিল করতে 'cancel' লিখুন";

      await sendTextWithCancelButton(formattedPhone, message);
    } else {
      await confirmNewField(phone);
    }
  } catch (err) {
    error(`Failed to process field type for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ফিল্ড টাইপ প্রসেস করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function handleFieldOptionsInput(phone: string, optionsText: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Processing field options for admin ${formattedPhone}`, { optionsText });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) throw new Error("No state found");

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;

    const options = optionsText
      .split(",")
      .map((opt) => opt.trim())
      .filter((opt) => opt.length > 0);

    await stateManager.updateStateData(formattedPhone, {
      adminEditService: {
        ...adminEditServiceData,
        newField: {
          ...adminEditServiceData?.newField,
          options: options,
        },
      },
    });

    await confirmNewField(phone);
  } catch (err) {
    error(`Failed to process field options for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ফিল্ড অপশন প্রসেস করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function confirmNewField(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Confirming new field for admin ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ ফিল্ড তথ্য পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;
    const newField = adminEditServiceData?.newField;
    const serviceId = adminEditServiceData?.serviceId;

    if (!newField?.name || !newField.label || !serviceId) {
      await sendTextMessage(formattedPhone, "❌ ফিল্ড তথ্য অসম্পূর্ণ!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const typeMap: Record<string, string> = {
      text: "📝 টেক্সট",
      number: "🔢 নাম্বার",
      select: "📑 সিলেক্ট",
      file: "📁 ফাইল",
    };

    let message = `✅ *নতুন ফিল্ড কনফার্মেশন*\n\n`;
    message += `📛 নাম: ${newField.name}\n`;
    message += `🏷️ লেবেল: ${newField.label}\n`;
    message += `📋 টাইপ: ${
      typeMap[newField.type as string] || newField.type
    }\n`;
    message += `⚠️ প্রয়োজনীয়: ${newField.required ? "✅ হ্যাঁ" : "❌ না"}\n`;

    if (newField.options && newField.options.length > 0) {
      message += `📑 অপশন: ${newField.options.join(", ")}\n`;
    }

    message += `\n✅ ফিল্ড যোগ করতে 'confirm' লিখুন\n🚫 বাতিল করতে 'cancel' লিখুন`;

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_field_confirmation",
      flowType: "admin_manage_fields",
    });

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to confirm new field for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ফিল্ড কনফার্মেশন দেখাতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function saveNewField(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Saving new field for admin ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ ফিল্ড তথ্য পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;
    const newField = adminEditServiceData?.newField;
    const serviceId = adminEditServiceData?.serviceId;

    if (!newField?.name || !newField.label || !serviceId) {
      await sendTextMessage(formattedPhone, "❌ ফিল্ড তথ্য অসম্পূর্ণ!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fieldToAdd: ServiceField = {
      id: `field_${Date.now()}`,
      name: newField.name,
      label: newField.label,
      type: newField.type as "text" | "number" | "select" | "file",
      required: newField.required ?? true,
      options: newField.options,
    };

    if (!service.requiredFields) {
      service.requiredFields = [];
    }

    service.requiredFields.push(fieldToAdd);
    service.updatedAt = new Date();
    await service.save();

    await sendTextMessage(
      formattedPhone,
      `✅ *ফিল্ড যোগ সফল*\n\n📛 ফিল্ড: ${fieldToAdd.label}\n📋 টাইপ: ${fieldToAdd.type}\n📦 সার্ভিস: ${service.name}\n\nফিল্ডটি সফলভাবে যোগ করা হয়েছে।`
    );

    await notifyAdmin(
      `🔧 নতুন ফিল্ড যোগ\n\nসার্ভিস: ${service.name}\nফিল্ড: ${fieldToAdd.label}\nতৈরিকারী: ${formattedPhone}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to save new field for admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ ফিল্ড সংরক্ষণ করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function showFieldsForEdit(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing fields for edit for admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fields = service.requiredFields || [];

    if (fields.length === 0) {
      await sendTextMessage(
        formattedPhone,
        `📭 '${service.name}' সার্ভিসে কোন ফিল্ড নেই।`
      );
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fieldRows = fields.map((field: ServiceField, index: number) => ({
      id: `edit_field_${index}`,
      title: field.label,
      description: `${field.type} | ${
        field.required ? "প্রয়োজনীয়" : "ঐচ্ছিক"
      }`,
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_field_selection_for_edit",
      flowType: "admin_edit_field",
      data: {
        adminEditService: {
          serviceId: serviceId,
          fields: fields,
        },
      },
    });

    await sendListMenu(
      formattedPhone,
      `✏️ ফিল্ড এডিট: ${service.name}`,
      `মোট ফিল্ড: ${fields.length}টি\n\nএডিট করতে চান এমন ফিল্ড সিলেক্ট করুন:`,
      fieldRows,
      "ফিল্ড তালিকা",
      "ফিল্ড সিলেক্ট"
    );
  } catch (err) {
    error(`Failed to show fields for edit for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function showFieldsForDelete(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing fields for delete for admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fields = service.requiredFields || [];

    if (fields.length === 0) {
      await sendTextMessage(
        formattedPhone,
        `📭 '${service.name}' সার্ভিসে কোন ফিল্ড নেই।`
      );
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fieldRows = fields.map((field: ServiceField, index: number) => ({
      id: `delete_field_${index}`,
      title: field.label,
      description: `${field.type} | ${
        field.required ? "প্রয়োজনীয়" : "ঐচ্ছিক"
      }`,
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_field_selection_for_delete",
      flowType: "admin_delete_field",
      data: {
        adminEditService: {
          serviceId: serviceId,
          fields: fields,
        },
      },
    });

    await sendListMenu(
      formattedPhone,
      `🗑️ ফিল্ড ডিলিট: ${service.name}`,
      `মোট ফিল্ড: ${fields.length}টি\n\nমুছতে চান এমন ফিল্ড সিলেক্ট করুন:`,
      fieldRows,
      "ফিল্ড তালিকা",
      "ফিল্ড সিলেক্ট"
    );
  } catch (err) {
    error(`Failed to show fields for delete for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function deleteField(phone: string, fieldIndex: number) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Deleting field for admin ${formattedPhone}`, { fieldIndex });

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ ফিল্ড তথ্য পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminEditServiceData = state.data?.adminEditService as
      | AdminEditServiceStateData
      | undefined;
    const fields = adminEditServiceData?.fields;
    const serviceId = adminEditServiceData?.serviceId;

    if (!fields || !serviceId) {
      await sendTextMessage(formattedPhone, "❌ ফিল্ড তথ্য অসম্পূর্ণ!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    if (fieldIndex < 0 || fieldIndex >= fields.length) {
      await sendTextMessage(formattedPhone, "❌ অবৈধ ফিল্ড সিলেকশন!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fieldToDelete = fields[fieldIndex];

    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    if (!service.requiredFields) {
      service.requiredFields = [];
    }

    service.requiredFields = service.requiredFields.filter(
      (_: unknown, index: number) => index !== fieldIndex
    );
    service.updatedAt = new Date();
    await service.save();

    await sendTextMessage(
      formattedPhone,
      `✅ *ফিল্ড ডিলিট সফল*\n\n🗑️ ফিল্ড: ${fieldToDelete.label}\n📦 সার্ভিস: ${service.name}\n\nফিল্ডটি সফলভাবে মুছে ফেলা হয়েছে।`
    );

    await notifyAdmin(
      `🗑️ ফিল্ড ডিলিট\n\nসার্ভিস: ${service.name}\nফিল্ড: ${fieldToDelete.label}\nতৈরিকারী: ${formattedPhone}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to delete field for admin ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ ফিল্ড মুছতে সমস্যা হয়েছে।");
    await showMainMenu(formattedPhone, true);
  }
}

// --- Toggle Service Status ---
async function toggleServiceStatus(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting toggle service status flow for admin ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().limit(10).sort({ name: 1 });

    if (services.length === 0) {
      await sendTextMessage(formattedPhone, "📭 কোন সার্ভিস নেই।");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const serviceRows = services.map((service) => ({
      id: `toggle_service_${service._id}`,
      title: service.name,
      description: `৳${service.price} | ${
        service.isActive ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"
      }`,
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_selection_for_toggle",
      flowType: "admin_toggle_service",
    });

    await sendListMenu(
      formattedPhone,
      "⚡ সার্ভিস স্ট্যাটাস পরিবর্তন",
      "স্ট্যাটাস পরিবর্তন করতে চান এমন সার্ভিস সিলেক্ট করুন:",
      serviceRows,
      "সার্ভিস তালিকা",
      "সার্ভিস সিলেক্ট"
    );
  } catch (err) {
    error(
      `Failed to start toggle service status flow for admin ${formattedPhone}:`,
      err
    );
    await showMainMenu(formattedPhone, true);
  }
}

// --- Delete Service ---
async function deleteService(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting delete service flow for admin ${formattedPhone}`);

  try {
    await connectDB();
    const services = await Service.find().limit(10).sort({ name: 1 });

    if (services.length === 0) {
      await sendTextMessage(formattedPhone, "📭 কোন সার্ভিস নেই।");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const serviceRows = services.map((service) => ({
      id: `delete_service_${service._id}`,
      title: service.name,
      description: `৳${service.price} | ${service.isActive ? "✅" : "❌"} | ${
        service.requiredFields?.length || 0
      } ফিল্ড`,
    }));

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_selection_for_delete",
      flowType: "admin_delete_service",
      data: {
        adminDeleteService: {},
      },
    });

    await sendListMenu(
      formattedPhone,
      "🗑️ সার্ভিস ডিলিট করুন",
      "⚠️ সতর্কতা: সার্ভিস ডিলিট করলে সমস্ত সংশ্লিষ্ট ডেটা মুছে যাবে!\n\nডিলিট করতে চান এমন সার্ভিস সিলেক্ট করুন:",
      serviceRows,
      "সার্ভিস তালিকা",
      "সার্ভিস সিলেক্ট"
    );
  } catch (err) {
    error(
      `Failed to start delete service flow for admin ${formattedPhone}:`,
      err
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function confirmDeleteService(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Confirming delete service for admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_delete_confirmation",
      flowType: "admin_delete_service",
      data: {
        adminDeleteService: {
          serviceId: serviceId,
          serviceName: service.name,
        },
      },
    });

    const message = `🗑️ *সার্ভিস ডিলিট কনফার্মেশন*\n\n⚠️ সতর্কতা: আপনি নিচের সার্ভিসটি মুছতে যাচ্ছেন:\n\n📛 নাম: ${
      service.name
    }\n💰 মূল্য: ৳${service.price}\n📊 স্ট্যাটাস: ${
      service.isActive ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"
    }\n🔧 ফিল্ড: ${
      service.requiredFields?.length || 0
    }টি\n\n❌ এই সার্ভিস মুছে ফেললে:\n• সকল অর্ডার থেকে সার্ভিস তথ্য হারিয়ে যাবে\n• রিপোর্টে অসঙ্গতি দেখা দিতে পারে\n• এই একশনটি পূর্বাবস্থায় ফেরানো যাবে না\n\n✅ ডিলিট করতে 'confirm delete' লিখুন\n🚫 বাতিল করতে 'cancel' লিখুন`;

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to confirm delete service for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function executeDeleteService(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Executing delete service for admin ${formattedPhone}`);

  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস তথ্য পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const adminDeleteServiceData = state.data?.adminDeleteService as
      | AdminDeleteServiceStateData
      | undefined;
    const serviceId = adminDeleteServiceData?.serviceId;

    if (!serviceId) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস আইডি পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const serviceName = service.name;

    await Service.findByIdAndDelete(serviceId);

    await sendTextMessage(
      formattedPhone,
      `✅ *সার্ভিস ডিলিট সফল*\n\n🗑️ সার্ভিস: ${serviceName}\n\nসার্ভিসটি সফলভাবে মুছে ফেলা হয়েছে।`
    );

    await notifyAdmin(
      `🗑️ সার্ভিস ডিলিট\n\nসার্ভিস: ${serviceName}\nতৈরিকারী: ${formattedPhone}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to execute delete service for admin ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ সার্ভিস মুছতে সমস্যা হয়েছে।");
    await showMainMenu(formattedPhone, true);
  }
}

// --- Admin Orders Management ---
async function handleAdminOrders(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing admin orders menu to ${formattedPhone}`);

  try {
    await connectDB();
    const pendingOrders = await Order.countDocuments({ status: "pending" });
    const totalOrders = await Order.countDocuments();

    const orderMenuRows = [
      {
        id: "admin_order_pending",
        title: "⏳ পেন্ডিং অর্ডার",
        description: `অপেক্ষমান: ${pendingOrders}`,
      },
      {
        id: "admin_order_processing",
        title: "🔄 প্রসেসিং অর্ডার",
        description: "চলমান অর্ডারসমূহ",
      },
      {
        id: "admin_order_completed",
        title: "✅ কমপ্লিটেড অর্ডার",
        description: "সম্পন্ন অর্ডারসমূহ",
      },
      {
        id: "admin_order_all",
        title: "📊 সকল অর্ডার",
        description: `মোট অর্ডার: ${totalOrders}`,
      },
      {
        id: "admin_order_update",
        title: "🔄 অর্ডার স্ট্যাটাস",
        description: "অর্ডার স্ট্যাটাস পরিবর্তন",
      },
      {
        id: "admin_order_search",
        title: "🔍 অর্ডার সার্চ",
        description: "অর্ডার আইডি বা ইউজার অনুসন্ধান",
      },
    ];

    await sendListMenu(
      formattedPhone,
      "📋 অর্ডার ম্যানেজমেন্ট",
      `অপেক্ষমান অর্ডার: ${pendingOrders}\nমোট অর্ডার: ${totalOrders}\n\n🚫 বাতিল করতে 'cancel' লিখুন`,
      orderMenuRows,
      "অর্ডার অপশন",
      "অর্ডার অপশন"
    );
  } catch (err) {
    error(`Failed to show admin orders menu to ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function showPendingOrders(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing pending orders to admin ${formattedPhone}`);

  try {
    await connectDB();
    const orders = await Order.find({ status: "pending" })
      .populate("user")
      .populate("service")
      .limit(5);

    if (orders.length === 0) {
      await sendTextMessage(formattedPhone, "✅ কোন পেন্ডিং অর্ডার নেই!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    let message = "⏳ *পেন্ডিং অর্ডারসমূহ:*\n\n";

    orders.forEach((order, index) => {
      message += `${index + 1}. 🆔: ${order.orderId}\n   👤: ${
        order.user?.whatsapp || "N/A"
      }\n   📦: ${order.service?.name || "N/A"}\n   💰: ৳${
        order.totalPrice
      }\n\n`;
    });

    message += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
  } catch (err) {
    error(`Failed to show pending orders to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

// --- Broadcast ---
async function handleBroadcast(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting broadcast flow for admin ${formattedPhone}`);

  try {
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_broadcast_message",
      flowType: "admin_broadcast",
    });

    const message =
      "📢 *ব্রডকাস্ট মেসেজ*\n\nসকল ইউজারকে পাঠাতে চান এমন মেসেজ টাইপ করুন:\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন";

    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to start broadcast flow for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function sendBroadcast(phone: string, message: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Sending broadcast from admin ${formattedPhone}`, {
    messageLength: message.length,
  });

  try {
    await connectDB();
    const users = await User.find({}).select("whatsapp");
    const totalUsers = users.length;

    await sendTextMessage(
      formattedPhone,
      `📢 ব্রডকাস্ট শুরু হচ্ছে...\n\nইউজার: ${totalUsers} জন`
    );

    let success = 0;
    let failed = 0;

    const BATCH_SIZE = 5;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const promises = batch.map((user) =>
        sendTextMessage(user.whatsapp, `📢 *ব্রডকাস্ট মেসেজ*\n\n${message}`)
          .then(() => success++)
          .catch(() => failed++)
      );

      await Promise.all(promises);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await sendTextMessage(
      formattedPhone,
      `✅ ব্রডকাস্ট সম্পন্ন\n\nসফল: ${success}\nব্যর্থ: ${failed}`
    );

    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
    info(`Broadcast completed from admin ${formattedPhone}`, {
      success,
      failed,
    });
  } catch (err) {
    error(`Failed to send broadcast from admin ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ ব্রডকাস্ট পাঠাতে সমস্যা হয়েছে।");
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  }
}

// --- Message Handler ---
async function handleUserMessage(
  phone: string,
  message: WhatsAppMessage,
  isAdmin: boolean
) {
  const formattedPhone = formatPhoneNumber(phone);
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).substr(2);

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
      // ADMIN SERVICE MANAGEMENT STATE HANDLERS
      // ========================================

      // Add Service Flow
      if (currentState === "awaiting_service_name") {
        await handleServiceNameInput(formattedPhone, message.text?.body || "");
        return;
      }

      if (currentState === "awaiting_service_description") {
        await handleServiceDescriptionInput(
          formattedPhone,
          message.text?.body || ""
        );
        return;
      }

      if (currentState === "awaiting_service_price") {
        await handleServicePriceInput(formattedPhone, message.text?.body || "");
        return;
      }

      if (currentState === "awaiting_service_instructions") {
        await handleServiceInstructionsInput(
          formattedPhone,
          message.text?.body || ""
        );
        return;
      }

      if (currentState === "awaiting_service_fields_confirmation") {
        if (userText === "confirm") {
          await confirmServiceCreation(formattedPhone);
          return;
        } else if (userText === "add fields" || userText === "add field") {
          // Skip fields for now, can be implemented later
          await confirmServiceCreation(formattedPhone);
          return;
        }
      }

      // Edit Service Flow
      if (currentState === "awaiting_new_service_name") {
        await updateServiceField(
          formattedPhone,
          "name",
          message.text?.body || ""
        );
        return;
      }

      if (currentState === "awaiting_new_service_description") {
        await updateServiceField(
          formattedPhone,
          "description",
          message.text?.body || ""
        );
        return;
      }

      if (currentState === "awaiting_new_service_price") {
        await updateServiceField(
          formattedPhone,
          "price",
          message.text?.body || ""
        );
        return;
      }

      if (currentState === "awaiting_new_service_instructions") {
        await updateServiceField(
          formattedPhone,
          "instructions",
          message.text?.body || ""
        );
        return;
      }

      // Field Management Flow
      if (currentState === "awaiting_field_name") {
        await handleFieldNameInput(formattedPhone, message.text?.body || "");
        return;
      }

      if (currentState === "awaiting_field_label") {
        await handleFieldLabelInput(formattedPhone, message.text?.body || "");
        return;
      }

      if (currentState === "awaiting_field_options") {
        await handleFieldOptionsInput(formattedPhone, message.text?.body || "");
        return;
      }

      if (
        currentState === "awaiting_field_confirmation" &&
        userText === "confirm"
      ) {
        await saveNewField(formattedPhone);
        return;
      }

      // Delete Service Flow
      if (
        currentState === "awaiting_delete_confirmation" &&
        userText === "confirm delete"
      ) {
        await executeDeleteService(formattedPhone);
        return;
      }

      // ========================================
      // EXISTING STATE HANDLERS
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

      if (currentState === "awaiting_broadcast_message") {
        await sendBroadcast(formattedPhone, message.text?.body || "");
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
          await showServices(formattedPhone);
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
            "awaiting_broadcast_message",
          ].includes(currentState)
        ) {
          await stateManager.clearUserState(formattedPhone);
        }

        // ========================================
        // ADMIN SERVICE MANAGEMENT LIST HANDLERS
        // ========================================

        // Admin Service Management Menu
        if (selectedId === "admin_services") {
          const adminServiceRows = [
            {
              id: "admin_service_list",
              title: "📋 সার্ভিস তালিকা",
              description: "সমস্ত সার্ভিস দেখুন",
            },
            {
              id: "admin_service_add",
              title: "➕ নতুন সার্ভিস যোগ",
              description: "নতুন সার্ভিস তৈরি করুন",
            },
            {
              id: "admin_service_edit",
              title: "✏️ সার্ভিস এডিট",
              description: "সার্ভিস তথ্য পরিবর্তন করুন",
            },
            {
              id: "admin_service_toggle",
              title: "⚡ স্ট্যাটাস পরিবর্তন",
              description: "সার্ভিস সক্রিয়/নিষ্ক্রিয় করুন",
            },
            {
              id: "admin_service_delete",
              title: "🗑️ সার্ভিস ডিলিট",
              description: "সার্ভিস মুছে ফেলুন",
            },
          ];

          await sendListMenu(
            formattedPhone,
            "📦 সার্ভিস ম্যানেজমেন্ট",
            "সার্ভিস ম্যানেজমেন্ট অপশন সিলেক্ট করুন:\n\n🚫 বাতিল করতে 'cancel' লিখুন",
            adminServiceRows,
            "সার্ভিস অপশন",
            "সার্ভিস অপশন"
          );
          return;
        }

        if (selectedId === "admin_service_list") {
          await showAllServices(formattedPhone);
          return;
        }

        if (selectedId === "admin_service_add") {
          await addNewService(formattedPhone);
          return;
        }

        if (selectedId === "admin_service_edit") {
          await handleAdminServiceEdit(formattedPhone);
          return;
        }

        if (selectedId === "admin_service_toggle") {
          await toggleServiceStatus(formattedPhone);
          return;
        }

        if (selectedId === "admin_service_delete") {
          await deleteService(formattedPhone);
          return;
        }

        // Service Detail Selection
        if (selectedId.startsWith("admin_service_detail_")) {
          const serviceId = selectedId.replace("admin_service_detail_", "");
          await showServiceDetails(formattedPhone, serviceId);
          return;
        }

        // Edit Service Options
        if (selectedId.startsWith("admin_edit_service_")) {
          const serviceId = selectedId.replace("admin_edit_service_", "");
          await handleServiceSelectionForEdit(formattedPhone, serviceId);
          return;
        }

        if (selectedId.startsWith("edit_service_")) {
          const state = await stateManager.getUserState(formattedPhone);
          const adminEditServiceData = state?.data?.adminEditService as
            | AdminEditServiceStateData
            | undefined;
          if (adminEditServiceData?.serviceId) {
            await handleServiceEditOption(
              formattedPhone,
              selectedId,
              adminEditServiceData.serviceId
            );
          }
          return;
        }

        // Toggle Service Status
        if (selectedId.startsWith("toggle_service_")) {
          const serviceId = selectedId.replace("toggle_service_", "");
          await toggleServiceStatusNow(formattedPhone, serviceId);
          return;
        }

        // Delete Service
        if (selectedId.startsWith("delete_service_")) {
          const serviceId = selectedId.replace("delete_service_", "");
          await confirmDeleteService(formattedPhone, serviceId);
          return;
        }

        // Field Type Selection
        if (selectedId.startsWith("field_type_")) {
          await handleFieldTypeSelection(formattedPhone, selectedId);
          return;
        }

        // Fields Action
        if (
          selectedId === "add_new_field" ||
          selectedId === "view_fields" ||
          selectedId === "edit_field" ||
          selectedId === "delete_field"
        ) {
          await handleFieldsAction(formattedPhone, selectedId);
          return;
        }

        // Edit Field Selection
        if (selectedId.startsWith("edit_field_")) {
          const fieldIndex = parseInt(selectedId.replace("edit_field_", ""));
          await sendTextMessage(formattedPhone, "✏️ ফিল্ড এডিট শীঘ্রই আসছে...");
          await showMainMenu(formattedPhone, true);
          return;
        }

        // Delete Field Selection
        if (selectedId.startsWith("delete_field_")) {
          const fieldIndex = parseInt(selectedId.replace("delete_field_", ""));
          await deleteField(formattedPhone, fieldIndex);
          return;
        }

        // ========================================
        // EXISTING LIST HANDLERS
        // ========================================

        // Handle user menu options
        switch (selectedId) {
          case "user_recharge":
            await handleRechargeStart(formattedPhone);
            break;
          case "user_services":
            await showServices(formattedPhone);
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
          case "user_support":
            await showSupport(formattedPhone);
            break;
          // Admin menu options
          case "admin_orders":
            await handleAdminOrders(formattedPhone);
            break;
          case "admin_order_pending":
            await showPendingOrders(formattedPhone);
            break;
          case "admin_broadcast":
            await handleBroadcast(formattedPhone);
            break;
          case "admin_stats":
            await showSystemStats(formattedPhone);
            break;
          case "admin_users":
            await showUserManagement(formattedPhone);
            break;
          case "admin_settings":
            await showSystemSettings(formattedPhone);
            break;
          // Service selection
          default:
            if (selectedId.startsWith("service_")) {
              const serviceId = selectedId.replace("service_", "");
              await handleServiceSelection(formattedPhone, serviceId);
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

// --- Helper Functions ---
async function showServiceDetails(phone: string, serviceId: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing service details to admin ${formattedPhone}`, { serviceId });

  try {
    await connectDB();
    const service = await Service.findById(serviceId);

    if (!service) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, true);
      return;
    }

    const fieldsCount = service.requiredFields?.length || 0;
    const activeOrders = await Order.countDocuments({
      serviceId: service._id,
      status: { $in: ["pending", "processing"] },
    });
    const totalOrders = await Order.countDocuments({ serviceId: service._id });

    let message = `📋 *সার্ভিস ডিটেইলস*\n\n`;
    message += `📛 নাম: ${service.name}\n`;
    message += `💰 মূল্য: ৳${service.price}\n`;
    message += `📊 স্ট্যাটাস: ${
      service.isActive ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়"
    }\n`;
    message += `🔧 ফিল্ড: ${fieldsCount}টি\n`;
    message += `📦 অর্ডার: ${activeOrders} সক্রিয় / ${totalOrders} মোট\n\n`;
    message += `📝 বর্ণনা: ${service.description}\n\n`;

    if (service.instructions) {
      message += `📋 নির্দেশনা: ${service.instructions}\n\n`;
    }

    if (fieldsCount > 0) {
      message += `📋 ফিল্ডসমূহ:\n`;
      service.requiredFields?.forEach((field:ServiceField, index: number) => {
        const typeMap = {
          text: "📝 টেক্সট",
          number: "🔢 নাম্বার",
          select: "📑 সিলেক্ট",
          file: "📁 ফাইল",
        };
        message += `${index + 1}. ${field.label} (${
          typeMap[field.type as keyof typeof typeMap] || field.type
        }) ${field.required ? "✅" : "❌"}\n`;
      });
    }

    message += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to show service details to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

// --- Additional Admin Functions ---
async function showSystemStats(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing system stats to admin ${formattedPhone}`);

  try {
    await connectDB();
    const totalUsers = await User.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalServices = await Service.countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayUsers = await User.countDocuments({
      createdAt: { $gte: today },
    });
    const todayOrders = await Order.countDocuments({
      createdAt: { $gte: today },
    });

    const message =
      `📊 *সিস্টেম স্ট্যাটিসটিক্স*\n\n` +
      `👥 মোট ইউজার: ${totalUsers}\n` +
      `🛒 মোট অর্ডার: ${totalOrders}\n` +
      `📦 মোট সার্ভিস: ${totalServices}\n` +
      `💳 মোট ট্রান্সাকশন: ${totalTransactions}\n\n` +
      `📅 আজকের তথ্য:\n` +
      `• নতুন ইউজার: ${todayUsers}\n` +
      `• নতুন অর্ডার: ${todayOrders}\n\n` +
      `⏱️ সর্বশেষ আপডেট: ${new Date().toLocaleString()}\n\n` +
      `🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;

    await sendTextMessage(formattedPhone, message);
  } catch (err) {
    error(`Failed to show system stats to admin ${formattedPhone}:`, err);
    await sendTextMessage(
      formattedPhone,
      "❌ স্ট্যাটিসটিক্স লোড করতে সমস্যা হয়েছে।"
    );
    await showMainMenu(formattedPhone, true);
  }
}

async function showUserManagement(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing user management to admin ${formattedPhone}`);

  try {
    await sendTextMessage(
      formattedPhone,
      "👥 *ইউজার ম্যানেজমেন্ট*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন"
    );
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to show user management to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function showSystemSettings(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing system settings to admin ${formattedPhone}`);

  try {
    await sendTextMessage(
      formattedPhone,
      "⚙️ *সিস্টেম সেটিংস*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন"
    );
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to show system settings to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

// --- Main Webhook Handler ---
export async function POST(req: NextRequest) {
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).substr(2);
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
