import { NextRequest, NextResponse } from 'next/server';
import User from '@/models/User';
import Service from '@/models/Service';
import Order from '@/models/Order';
import Transaction from '@/models/Transaction';
import stateManager from '@/lib/whatsappState';
import { sessionMonitor } from '@/lib/sessionMonitor';
import { connectDB } from '@/lib/mongodb-bot';

// --- Logging Configuration ---
const LOG_CONFIG = {
  debug: process.env.NODE_ENV === 'development',
  logLevel: process.env.LOG_LEVEL || 'INFO',
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
    log('DEBUG', message, data);
  }
}

function info(message: string, data?: unknown) {
  log('INFO', message, data);
}

function warn(message: string, data?: unknown) {
  log('WARN', message, data);
}

function error(message: string, data?: unknown) {
  log('ERROR', message, data);
}

// --- Configuration ---
const CONFIG = {
  accessToken: process.env.WA_ACCESS_TOKEN || '',
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
  verifyToken: process.env.WA_VERIFY_TOKEN || '',
  apiVersion: process.env.WA_API_VERSION || 'v22.0',
  baseUrl: process.env.WA_API_BASE_URL || 'https://graph.facebook.com',
  adminId: process.env.ADMIN_WA_ID || '',
  bkashNumber: process.env.BKASH_NUMBER || '017XXXXXXXX',
  supportNumber: process.env.SUPPORT_NUMBER || '+8801XXXXXXXXX',
  supportTelegram: process.env.SUPPORT_TELEGRAM || 't.me/signcopy',
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

// --- WhatsApp API Helper Functions ---
function formatPhoneNumber(phone: string): string {
  // Remove any non-digit characters
  const cleaned = phone.replace(/\D/g, '');
  
  // Bangladesh numbers
  if (cleaned.startsWith('880')) {
    return cleaned;
  }
  
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    // Local Bangladesh number (0XXXXXXXXXX)
    return '880' + cleaned.substring(1);
  }
  
  if (!cleaned.startsWith('880') && cleaned.length === 10) {
    // Bangladesh number without country code (XXXXXXXXXX)
    return '880' + cleaned;
  }
  
  // India numbers
  if (cleaned.startsWith('91')) {
    return cleaned;
  }
  
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    // Local India number (0XXXXXXXXX)
    return '91' + cleaned.substring(1);
  }
  
  if (!cleaned.startsWith('91') && cleaned.length === 10) {
    // India number without country code (XXXXXXXXX)
    return '91' + cleaned;
  }
  
  // Default: return as-is if already in correct format
  return cleaned;
}

async function callWhatsAppApi(endpoint: string, payload: object) {
  const url = `${CONFIG.baseUrl}/${CONFIG.apiVersion}/${CONFIG.phoneNumberId}/${endpoint}`;
  debug(`Calling WhatsApp API: ${endpoint}`, { payload: JSON.stringify(payload).substring(0, 500) });
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      error(`WhatsApp API error for ${endpoint}:`, {
        status: response.status,
        statusText: response.statusText,
        error: result,
        payload: JSON.stringify(payload)
      });
      
      // Log specific error details
      if (result.error?.message) {
        error(`WhatsApp API Error Message: ${result.error.message}`);
      }
      if (result.error?.error_data?.details) {
        error(`WhatsApp API Error Details: ${JSON.stringify(result.error.error_data.details)}`);
      }
    } else {
      debug(`WhatsApp API success for ${endpoint}:`, { messageId: result?.messages?.[0]?.id });
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
      body: text 
    },
  };
  
  debug(`Text message payload:`, payload);
  
  try {
    const result = await callWhatsAppApi('messages', payload);
    return result;
  } catch (err) {
    error(`Failed to send text message to ${formattedTo}:`, err);
    throw err;
  }
}

async function sendButtonMenu(to: string, headerText: string, bodyText: string, buttons: Array<{ id: string, title: string }>) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending button menu to ${formattedTo}`, { header: headerText, buttons: buttons.length });
  
  // WhatsApp has specific requirements for button menus:
  // - Max 3 buttons for interactive buttons
  // - Button titles: 1-20 characters
  // - Header: max 60 characters
  // - Body: max 1024 characters
  
  const validatedButtons = buttons.slice(0, 3).map(b => ({
    type: "reply" as const,
    reply: { 
      id: b.id.substring(0, 256), // Max 256 chars for ID
      title: b.title.substring(0, 20) // Max 20 chars for title
    }
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
        text: headerText.substring(0, 60)
      },
      body: { 
        text: bodyText.substring(0, 1024)
      },
      action: { 
        buttons: validatedButtons
      }
    }
  };
  
  debug(`Button menu payload:`, payload);
  
  try {
    const result = await callWhatsAppApi('messages', payload);
    return result;
  } catch (err) {
    error(`Failed to send button menu to ${formattedTo}:`, err);
    // Fallback to text message
    await sendTextMessage(formattedTo, `${headerText}\n\n${bodyText}\n\nPlease use text commands or list menu.`);
    throw err;
  }
}

// Helper function to send text with cancel button
async function sendTextWithCancelButton(to: string, text: string) {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending text with cancel button to ${formattedTo}`);
  
  try {
    // Send button menu with cancel option
    await sendButtonMenu(
      formattedTo,
      "Action Required",
      text,
      [
        { id: "cancel_flow", title: "❌ বাতিল করুন" }
      ]
    );
  } catch (err) {
    error(`Failed to send text with cancel button to ${formattedTo}:`, err);
    // Fallback: send text with cancel instruction
    await sendTextMessage(formattedTo, `${text}\n\n🚫 বাতিল করতে 'cancel' লিখুন।`);
  }
}

async function sendListMenu(to: string, header: string, body: string, rows: Array<{ id: string, title: string, description?: string }>, sectionTitle: string, buttonText: string = "অপশন দেখুন") {
  const formattedTo = formatPhoneNumber(to);
  info(`Sending list menu to ${formattedTo}`, { header, rows: rows.length });
  
  // WhatsApp list requirements:
  // - Max 10 rows
  // - Row title: max 24 chars
  // - Row description: max 72 chars
  // - Section title: max 24 chars
  // - Header: max 60 chars
  // - Body: max 1024 chars
  // - Button text: max 20 chars
  
  const validatedRows = rows.slice(0, 10).map(row => ({
    id: row.id.substring(0, 200),
    title: row.title.substring(0, 24),
    description: (row.description || '').substring(0, 72)
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
        text: header.substring(0, 60)
      },
      body: { 
        text: body.substring(0, 1024)
      },
      footer: { 
        text: "Powered by BirthHelp AI" 
      },
      action: {
        button: buttonText.substring(0, 20),
        sections: [
          {
            title: sectionTitle.substring(0, 24),
            rows: validatedRows
          }
        ]
      }
    }
  };
  
  debug(`List menu payload:`, payload);
  
  try {
    const result = await callWhatsAppApi('messages', payload);
    return result;
  } catch (err) {
    error(`Failed to send list menu to ${formattedTo}:`, err);
    // Fallback to text menu
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
        createdAt: new Date()
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
      await sendTextMessage(CONFIG.adminId, `🔔 *ADMIN NOTIFICATION*\n\n${message}`);
    } catch (err) {
      error(`Failed to send admin notification:`, err);
    }
  }
}

// --- Main Menu Handler (Using List Menu) ---
async function showMainMenu(phone: string, isAdmin: boolean) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing main menu to ${formattedPhone}`, { isAdmin });
  
  try {
    // Clear any existing state when showing main menu
    await stateManager.clearUserState(formattedPhone);
    
    if (isAdmin) {
      // Admin menu as list (can show all options)
      const adminMenuRows = [
        { id: "admin_services", title: "📦 সার্ভিস ম্যানেজমেন্ট", description: "সার্ভিস এডিট/এড/রিমুভ" },
        { id: "admin_orders", title: "📋 অর্ডার ম্যানেজমেন্ট", description: "অর্ডার ভিউ ও আপডেট" },
        { id: "admin_broadcast", title: "📢 ব্রডকাস্ট মেসেজ", description: "সকল ইউজারকে মেসেজ পাঠান" },
        { id: "admin_stats", title: "📊 সিস্টেম স্ট্যাটিসটিক্স", description: "সিস্টেম তথ্য ও রিপোর্ট" },
        { id: "admin_users", title: "👥 ইউজার ম্যানেজমেন্ট", description: "ইউজার তালিকা ও ম্যানেজ" },
        { id: "admin_settings", title: "⚙️ সিস্টেম সেটিংস", description: "সিস্টেম কনফিগারেশন" }
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
      // User menu as list (shows all 6 options at once)
      const userMenuRows = [
        { id: "user_recharge", title: "💵 ব্যালেন্স রিচার্জ", description: "ব্যালেন্স রিচার্জ করুন বিকাশের মাধ্যমে" },
        { id: "user_services", title: "🛒 সার্ভিস কিনুন", description: "আমাদের সব সার্ভিস দেখুন ও কিনুন" },
        { id: "user_orders", title: "📦 আমার অর্ডারসমূহ", description: "আপনার সকল অর্ডারের তালিকা" },
        { id: "user_history", title: "📜 ট্রান্সাকশন হিস্টরি", description: "সমস্ত ট্রান্সাকশনের ইতিহাস" },
        { id: "user_account", title: "👤 আমার অ্যাকাউন্ট", description: "আপনার অ্যাকাউন্টের তথ্য ও ডিটেইলস" },
        { id: "user_support", title: "🎧 সাপোর্ট / হেল্প", description: "সাপোর্ট টিমের সাথে যোগাযোগ করুন" }
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
    // Fallback to text message
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
    // Clear user state
    await stateManager.clearUserState(formattedPhone);
    
    // Send cancellation confirmation
    await sendTextMessage(formattedPhone, "🚫 অপারেশন বাতিল করা হয়েছে।");
    
    // Always show main menu after cancellation
    await showMainMenu(formattedPhone, isAdmin);
  } catch (err) {
    error(`Failed to cancel flow for ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ বাতিল করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
  }
}

// --- Recharge Flow ---
async function handleRechargeStart(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting recharge flow for ${formattedPhone}`);
  
  try {
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_trx_id",
      flowType: "recharge"
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
      trxId: trxId,
      amount: 0
    });

    // In production, implement actual bkash verification here
    const payment = await fetch(
        `https://api.bdx.kg/bkash/submit.php?trxid=${trxId}`
      );

      if (!payment.ok) {
        await sendTextMessage(formattedPhone, "❌ রিচার্জ যাচাই করতে ব্যর্থ। দয়া পরে চেষ্টা করুন।");
        await showMainMenu(formattedPhone, false);
        return;
      }

      const paymentData = await payment.json();
      if (paymentData.error) {
        await sendTextMessage(formattedPhone, `❌ রিচার্জ যাচাই করতে ব্যর্থ: ${paymentData.error}`);
        await showMainMenu(formattedPhone, false);
        return;
      }

      if (!paymentData.amount || !paymentData.payerAccount) {
        await sendTextMessage(formattedPhone, "❌ অবৈধ ট্রান্সাকশন আইডি বা পরিমাণ। দয়া করে সঠিক তথ্য প্রদান করুন।");
        await showMainMenu(formattedPhone, false);
        return;
      }
    const verifiedAmount = Number(paymentData.amount); 
    
    await sendTextMessage(formattedPhone, `✅ *ট্রান্সাকশন ভেরিফাইড*\n\n🔢 টিআরএক্স আইডি: ${trxId}\n💰 পরিমাণ: ৳${verifiedAmount}\n📅 সময়: ${new Date().toLocaleString()}`);
    
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
        createdAt: new Date()
      });
      
      await sendTextMessage(formattedPhone, `💰 *রিচার্জ সফল*\n\nনতুন ব্যালেন্স: ৳${user.balance}\n\nধন্যবাদ!`);
      
      await notifyAdmin(`💰 নতুন রিচার্জ\n\nব্যবহারকারী: ${formattedPhone}\nপরিমাণ: ৳${verifiedAmount}\nটিআরএক্স: ${trxId}`);
    }
    
    // Always show main menu after completion
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
    info(`Recharge completed for ${formattedPhone}`);
  } catch (err) {
    error(`Failed to process TRX ID for ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ রিচার্জ প্রক্রিয়া সম্পূর্ণ করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
    // Show main menu even on error
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
      await sendTextMessage(formattedPhone, "📭 কোন সার্ভিস পাওয়া যায়নি। দয়া পরে চেষ্টা করুন।");
      return;
    }
    
    const serviceRows = services.map((service) => ({
      id: `service_${service._id}`,
      title: `${service.name} - ৳${service.price}`,
      description: service.description.substring(0, 50) + '...'
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
    await sendTextMessage(formattedPhone, "❌ সার্ভিস লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
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
      await sendTextMessage(formattedPhone, "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }
    
    if (user.balance < service.price) {
      await sendTextMessage(formattedPhone, `❌ *অপর্যাপ্ত ব্যালেন্স*\n\nসার্ভিস মূল্য: ৳${service.price}\nআপনার ব্যালেন্স: ৳${user.balance}\n\n💵 ব্যালেন্স রিচার্জ করতে 'রিচার্জ' লিখুন।`);
      await showMainMenu(formattedPhone, false);
      return;
    }
    
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_service_confirmation",
      flowType: "service_order",
      data: { 
        serviceId: serviceId, 
        price: service.price,
        serviceName: service.name 
      }
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
    await sendTextMessage(formattedPhone, "❌ সার্ভিস সিলেক্ট করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
    await showMainMenu(formattedPhone, false);
  }
}

async function confirmServiceOrder(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Confirming service order for ${formattedPhone}`);
  
  try {
    const state = await stateManager.getUserState(formattedPhone);
    if (!state || state.flowType !== "service_order") {
      await sendTextMessage(formattedPhone, "❌ কোন একটিভ অর্ডার পাওয়া যায়নি!");
      await showMainMenu(formattedPhone, false);
      return;
    }
    
    await connectDB();
    const service = await Service.findById(state.data.serviceId);
    const user = await User.findOne({ whatsapp: formattedPhone });
    
    if (!service || !user) {
      await sendTextMessage(formattedPhone, "❌ সার্ভিস বা ইউজার পাওয়া যায়নি!");
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }
    
    if (user.balance < Number(state.data.price)) {
      await sendTextMessage(formattedPhone, `❌ অপর্যাপ্ত ব্যালেন্স!`);
      await stateManager.clearUserState(formattedPhone);
      await showMainMenu(formattedPhone, false);
      return;
    }
    
    // Deduct balance
    user.balance -= Number(state.data.price);
    await user.save();
    
    // Create transaction
    const transaction = await Transaction.create({
      trxId: `ORDER-${Date.now()}`,
      amount: state.data.price,
      method: "balance",
      status: "SUCCESS",
      number: formattedPhone,
      user: user._id,
      createdAt: new Date()
    });
    
    // Create order
    const order = await Order.create({
      orderId: `ORD-${Date.now()}`,
      userId: user._id,
      serviceId: service._id,
      quantity: 1,
      unitPrice: state.data.price,
      totalPrice: state.data.price,
      serviceData: {},
      status: "pending",
      transactionId: transaction._id,
      placedAt: new Date(),
      createdAt: new Date()
    });
    
    await sendTextMessage(formattedPhone, `✅ *অর্ডার সফল*\n\n📦 অর্ডার আইডি: ${order.orderId}\n💰 খরচ: ৳${state.data.price}\n🆕 ব্যালেন্স: ৳${user.balance}\n\nআমাদের সাপোর্ট টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে।`);
    
    await notifyAdmin(`🛒 নতুন অর্ডার\n\nব্যবহারকারী: ${formattedPhone}\nঅর্ডার আইডি: ${order.orderId}\nসার্ভিস: ${service.name}\nমূল্য: ৳${state.data.price}`);
    
    // Always show main menu after completion
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, false);
    info(`Service order completed for ${formattedPhone}`, { orderId: order.orderId });
  } catch (err) {
    error(`Failed to confirm service order for ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ অর্ডার কনফার্ম করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
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
      .populate('service');
    
    if (orders.length === 0) {
      await sendTextMessage(formattedPhone, "📭 আপনার কোন অর্ডার নেই।");
      await showMainMenu(formattedPhone, false);
      return;
    }
    
    let message = "📦 *আপনার অর্ডারসমূহ:*\n\n";
    
    orders.forEach((order, index) => {
      const serviceName = order.service?.name || "Unknown Service";
      const statusMap = {
        'pending': '⏳',
        'processing': '🔄',
        'completed': '✅',
        'failed': '❌',
        'cancelled': '🚫'
      };
      const statusEmoji = statusMap[order.status as keyof typeof statusMap] || '📝';
      
      message += `${index + 1}. ${statusEmoji} ${serviceName}\n   🆔: ${order.orderId}\n   💰: ৳${order.totalPrice}\n   📅: ${new Date(order.placedAt).toLocaleDateString()}\n\n`;
    });
    
    message += `\n📊 মোট অর্ডার: ${orders.length}\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;
    
    await sendTextMessage(formattedPhone, message);
    info(`Order history sent to ${formattedPhone}`, { count: orders.length });
  } catch (err) {
    error(`Failed to show order history for ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ অর্ডার হিস্টরি লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
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
    await sendTextMessage(formattedPhone, "❌ অ্যাকাউন্ট তথ্য লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
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
      const type = trx.method === 'balance' ? '🛒 সার্ভিস' : '💵 রিচার্জ';
      const sign = trx.method === 'balance' ? '-' : '+';
      message += `${index + 1}. ${type}\n   💰: ${sign}৳${trx.amount}\n   🆔: ${trx.trxId}\n   📅: ${new Date(trx.createdAt).toLocaleDateString()}\n\n`;
    });
    
   
    
    await sendTextMessage(formattedPhone, message);
    await showMainMenu(formattedPhone, false);
    info(`Transaction history sent to ${formattedPhone}`, { count: transactions.length });
  } catch (err) {
    error(`Failed to show transaction history for ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ ট্রান্সাকশন হিস্টরি লোড করতে সমস্যা হয়েছে। দয়া পরে চেষ্টা করুন।");
    await showMainMenu(formattedPhone, false);
  }
}

// --- Admin Handlers ---
async function handleAdminServices(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing admin services menu to ${formattedPhone}`);
  
  try {
    const serviceMenuRows = [
      { id: "admin_service_list", title: "📋 সার্ভিস তালিকা", description: "সমস্ত সার্ভিস দেখুন" },
      { id: "admin_service_add", title: "➕ নতুন সার্ভিস যোগ", description: "নতুন সার্ভিস তৈরি করুন" },
      { id: "admin_service_edit", title: "✏️ সার্ভিস এডিট", description: "সার্ভিস তথ্য পরিবর্তন করুন" },
      { id: "admin_service_toggle", title: "⚡ স্ট্যাটাস পরিবর্তন", description: "সার্ভিস সক্রিয়/নিষ্ক্রিয় করুন" },
      { id: "admin_service_delete", title: "🗑️ সার্ভিস ডিলিট", description: "সার্ভিস মুছে ফেলুন" }
    ];
    
    await sendListMenu(
      formattedPhone,
      "📦 সার্ভিস ম্যানেজমেন্ট",
      "সার্ভিস ম্যানেজমেন্ট অপশন সিলেক্ট করুন:\n\n🚫 বাতিল করতে 'cancel' লিখুন",
      serviceMenuRows,
      "সার্ভিস অপশন",
      "সার্ভিস অপশন"
    );
  } catch (err) {
    error(`Failed to show admin services menu to ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function handleAdminOrders(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing admin orders menu to ${formattedPhone}`);
  
  try {
    await connectDB();
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    const totalOrders = await Order.countDocuments();
    
    const orderMenuRows = [
      { id: "admin_order_pending", title: "⏳ পেন্ডিং অর্ডার", description: `অপেক্ষমান: ${pendingOrders}` },
      { id: "admin_order_processing", title: "🔄 প্রসেসিং অর্ডার", description: "চলমান অর্ডারসমূহ" },
      { id: "admin_order_completed", title: "✅ কমপ্লিটেড অর্ডার", description: "সম্পন্ন অর্ডারসমূহ" },
      { id: "admin_order_all", title: "📊 সকল অর্ডার", description: `মোট অর্ডার: ${totalOrders}` },
      { id: "admin_order_update", title: "🔄 অর্ডার স্ট্যাটাস", description: "অর্ডার স্ট্যাটাস পরিবর্তন" },
      { id: "admin_order_search", title: "🔍 অর্ডার সার্চ", description: "অর্ডার আইডি বা ইউজার অনুসন্ধান" }
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
    const orders = await Order.find({ status: 'pending' })
      .populate('user')
      .populate('service')
      .limit(5);
    
    if (orders.length === 0) {
      await sendTextMessage(formattedPhone, "✅ কোন পেন্ডিং অর্ডার নেই!");
      await showMainMenu(formattedPhone, true);
      return;
    }
    
    let message = "⏳ *পেন্ডিং অর্ডারসমূহ:*\n\n";
    
    orders.forEach((order, index) => {
      message += `${index + 1}. 🆔: ${order.orderId}\n   👤: ${order.user?.whatsapp || 'N/A'}\n   📦: ${order.service?.name || 'N/A'}\n   💰: ৳${order.totalPrice}\n\n`;
    });
    
    message += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;
    
    await sendTextMessage(formattedPhone, message);
  } catch (err) {
    error(`Failed to show pending orders to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function handleBroadcast(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting broadcast flow for admin ${formattedPhone}`);
  
  try {
    await stateManager.setUserState(formattedPhone, {
      currentState: "awaiting_broadcast_message",
      flowType: "admin_broadcast"
    });
    
    const message = "📢 *ব্রডকাস্ট মেসেজ*\n\nসকল ইউজারকে পাঠাতে চান এমন মেসেজ টাইপ করুন:\n\n🚫 বাতিল করতে নিচের বাটন ক্লিক করুন";
    
    await sendTextWithCancelButton(formattedPhone, message);
  } catch (err) {
    error(`Failed to start broadcast flow for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function sendBroadcast(phone: string, message: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Sending broadcast from admin ${formattedPhone}`, { messageLength: message.length });
  
  try {
    await connectDB();
    const users = await User.find({}).select('whatsapp');
    const totalUsers = users.length;
    
    await sendTextMessage(formattedPhone, `📢 ব্রডকাস্ট শুরু হচ্ছে...\n\nইউজার: ${totalUsers} জন`);
    
    let success = 0;
    let failed = 0;
    
    // Send in batches to avoid rate limiting
    const BATCH_SIZE = 5;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const promises = batch.map(user => 
        sendTextMessage(user.whatsapp, `📢 *ব্রডকাস্ট মেসেজ*\n\n${message}`)
          .then(() => success++)
          .catch(() => failed++)
      );
      
      await Promise.all(promises);
      // Wait between batches to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await sendTextMessage(formattedPhone, `✅ ব্রডকাস্ট সম্পন্ন\n\nসফল: ${success}\nব্যর্থ: ${failed}`);
    
    // Always show main menu after completion
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
    info(`Broadcast completed from admin ${formattedPhone}`, { success, failed });
  } catch (err) {
    error(`Failed to send broadcast from admin ${formattedPhone}:`, err);
    await sendTextMessage(formattedPhone, "❌ ব্রডকাস্ট পাঠাতে সমস্যা হয়েছে।");
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, true);
  }
}

// --- Message Handler ---
async function handleUserMessage(phone: string, message: WhatsAppMessage, isAdmin: boolean) {
  const formattedPhone = formatPhoneNumber(phone);
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  
  info(`[${requestId}] Handling message from ${formattedPhone}`, {
    type: message.type,
    isAdmin,
    messageId: message.id
  });
  
  try {
    // Get or create user
    const user = await getOrCreateUser(formattedPhone);
    info(`[${requestId}] User processed`, { userId: user._id, isAdmin });
    
    // Get current state
    const userState = await stateManager.getUserState(formattedPhone);
    const currentState = userState?.currentState;
    const flowType = userState?.flowType;
    
    debug(`[${requestId}] User state`, { currentState, flowType });
    
    if (message.type === "text") {
      const userText = message.text?.body.trim().toLowerCase() || '';
      info(`[${requestId}] Text message: "${userText}"`, { currentState });
      
      // Check for cancel command (works in any state)
      if (userText === 'cancel' || userText === 'বাতিল' || userText === 'c' || userText === 'cancel all') {
        await cancelFlow(formattedPhone, isAdmin);
        return;
      }
      
      // Handle state-based responses
      if (currentState === "awaiting_trx_id") {
          const trxId = userText.trim().toUpperCase();
          if (trxId) {
            await handleTrxIdInput(formattedPhone, trxId);
          } else {
            await sendTextMessage(formattedPhone, "❌ দয়া করে সঠিক টিআরএক্স আইডি পাঠান। ফরম্যাট: `YOUR_TRANSACTION_ID`\n\n🚫 বাতিল করতে 'cancel' লিখুন");
          }
        return;
      }
      
      if (currentState === "awaiting_service_confirmation" && userText === 'confirm') {
        await confirmServiceOrder(formattedPhone);
        return;
      }
      
      if (currentState === "awaiting_broadcast_message") {
        await sendBroadcast(formattedPhone, message.text?.body || "");
        return;
      }
      
      // Handle menu command (always works)
      if (['menu', 'মেনু', 'hi', 'hello', 'হ্যালো', 'হাই', 'hlw', 'start', 'শুরু', 'home', 'মেইন'].includes(userText)) {
        await showMainMenu(formattedPhone, isAdmin);
        return;
      }
      
      // Handle main commands (only if not in a flow)
      if (!currentState) {
        if (userText.includes('রিচার্জ') || userText === 'recharge') {
          await handleRechargeStart(formattedPhone);
          return;
        }
        
        if (userText.includes('সার্ভিস') || userText === 'services' || userText === 'service') {
          await showServices(formattedPhone);
          return;
        }
        
        if (userText.includes('অর্ডার') || userText === 'orders' || userText === 'order') {
          await showOrderHistory(formattedPhone);
          return;
        }
        
        if (userText.includes('হিস্টরি') || userText === 'history' || userText === 'transactions') {
          await showTransactionHistory(formattedPhone);
          return;
        }
        
        if (userText.includes('অ্যাকাউন্ট') || userText === 'account' || userText === 'info') {
          await showAccountInfo(formattedPhone);
          return;
        }
        
        if (userText.includes('সাপোর্ট') || userText.includes('হেল্প') || userText === 'support' || userText === 'help') {
          await showSupport(formattedPhone);
          return;
        }
        
        // Default response for unrecognized messages
        await sendTextMessage(formattedPhone, "👋 নমস্কার! SignCopy তে আপনাকে স্বাগতম!\n\nআমাদের সার্ভিস সম্পর্কে জানতে 'Menu' লিখুন।\n\n🚫 যেকোন সময় বাতিল করতে 'cancel' লিখুন");
        await showMainMenu(formattedPhone, isAdmin);
      } else {
        // If in a flow but received unrecognized command
        await sendTextMessage(formattedPhone, "❌ এই কমান্ড এখন গ্রহণযোগ্য নয়।\n\n🚫 বাতিল করতে 'cancel' লিখুন\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন");
      }
      
    } else if (message.type === "interactive") {
      info(`[${requestId}] Interactive message received`, { interactiveType: message.interactive?.type });
      
      if (message.interactive?.type === "list_reply") {
        const selectedId = message.interactive?.list_reply?.id || '';
        const selectedTitle = message.interactive?.list_reply?.title || '';
        
        info(`[${requestId}] List reply: "${selectedTitle}" (${selectedId})`);
        
        // Clear any existing state for list interactions (unless we're in a flow)
        if (!currentState || !['awaiting_trx_id', 'awaiting_service_confirmation', 'awaiting_broadcast_message'].includes(currentState)) {
          await stateManager.clearUserState(formattedPhone);
        }
        
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
          case "admin_services":
            await handleAdminServices(formattedPhone);
            break;
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
          // Admin sub-menu options
          case "admin_service_list":
            await showAllServices(formattedPhone);
            break;
          case "admin_service_add":
            await addNewService(formattedPhone);
            break;
          case "admin_service_toggle":
            await toggleServiceStatus(formattedPhone);
            break;
          // Service selection
          default:
            if (selectedId.startsWith("service_")) {
              const serviceId = selectedId.replace('service_', '');
              await handleServiceSelection(formattedPhone, serviceId);
            } else if (selectedId === "cancel_flow") {
              // Handle cancel button from interactive messages
              await cancelFlow(formattedPhone, isAdmin);
            } else {
              await sendTextMessage(formattedPhone, "❌ অজানা অপশন। দয়া করে আবার চেষ্টা করুন।");
              await showMainMenu(formattedPhone, isAdmin);
            }
        }
        
      } else if (message.interactive?.type === "button_reply") {
        // Handle button replies (for cancel button)
        const selectedId = message.interactive?.button_reply?.id || '';
        const selectedTitle = message.interactive?.button_reply?.title || '';
        
        info(`[${requestId}] Button reply: "${selectedTitle}" (${selectedId})`);
        
        if (selectedId === "cancel_flow") {
          await cancelFlow(formattedPhone, isAdmin);
        } else {
          await sendTextMessage(formattedPhone, "ℹ️ দয়া করে লিস্ট মেনু ব্যবহার করুন। 'Menu' লিখুন।");
          await showMainMenu(formattedPhone, isAdmin);
        }
      }
    } else {
      info(`[${requestId}] Unhandled message type: ${message.type}`);
      await sendTextMessage(formattedPhone, "❌ এই ধরনের মেসেজ সমর্থিত নয়। দয়া করে টেক্সট মেসেজ পাঠান।\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন");
      await showMainMenu(formattedPhone, isAdmin);
    }
    
  } catch (handlerError) {
    error(`[${requestId}] Error handling message from ${formattedPhone}:`, handlerError);
    await sendTextMessage(formattedPhone, "❌ সিস্টেমে ত্রুটি হয়েছে। দয়া পরে চেষ্টা করুন।");
    // Clear state and show main menu on error
    await stateManager.clearUserState(formattedPhone);
    await showMainMenu(formattedPhone, isAdmin);
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
    const todayUsers = await User.countDocuments({ createdAt: { $gte: today } });
    const todayOrders = await Order.countDocuments({ createdAt: { $gte: today } });
    
    const message = `📊 *সিস্টেম স্ট্যাটিসটিক্স*\n\n` +
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
    await sendTextMessage(formattedPhone, "❌ স্ট্যাটিসটিক্স লোড করতে সমস্যা হয়েছে।");
    await showMainMenu(formattedPhone, true);
  }
}

async function showUserManagement(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing user management to admin ${formattedPhone}`);
  
  try {
    await sendTextMessage(formattedPhone, "👥 *ইউজার ম্যানেজমেন্ট*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন");
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
    await sendTextMessage(formattedPhone, "⚙️ *সিস্টেম সেটিংস*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন");
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to show system settings to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function showAllServices(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Showing all services to admin ${formattedPhone}`);
  
  try {
    await connectDB();
    const services = await Service.find().limit(10);
    
    if (services.length === 0) {
      await sendTextMessage(formattedPhone, "📭 কোন সার্ভিস নেই।");
      await showMainMenu(formattedPhone, true);
      return;
    }
    
    let message = "📋 *সকল সার্ভিস:*\n\n";
    
    services.forEach((service, index) => {
      const status = service.isActive ? "✅ সক্রিয়" : "❌ নিষ্ক্রিয়";
      message += `${index + 1}. ${service.name}\n   💰: ৳${service.price}\n   📊: ${status}\n   🆔: ${service._id}\n\n`;
    });
    
    message += `\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন`;
    
    await sendTextMessage(formattedPhone, message);
  } catch (err) {
    error(`Failed to show all services to admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function addNewService(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting add new service flow for admin ${formattedPhone}`);
  
  try {
    await sendTextMessage(formattedPhone, "➕ *নতুন সার্ভিস যোগ করুন*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন");
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to start add new service flow for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

async function toggleServiceStatus(phone: string) {
  const formattedPhone = formatPhoneNumber(phone);
  info(`Starting toggle service status flow for admin ${formattedPhone}`);
  
  try {
    await sendTextMessage(formattedPhone, "⚡ *সার্ভিস স্ট্যাটাস পরিবর্তন*\n\nএই ফিচারটি শীঘ্রই আসছে...\n\n🏠 মেনুতে ফিরে যেতে 'Menu' লিখুন");
    await showMainMenu(formattedPhone, true);
  } catch (err) {
    error(`Failed to start toggle service status flow for admin ${formattedPhone}:`, err);
    await showMainMenu(formattedPhone, true);
  }
}

// --- Main Webhook Handler ---
export async function POST(req: NextRequest) {
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  info(`[${requestId}] Webhook POST request received`);
  
  try {
    // Start session monitor
    sessionMonitor.start();
    
    // Validate environment variables
    if (!CONFIG.accessToken || !CONFIG.phoneNumberId) {
      error(`[${requestId}] Missing WhatsApp configuration`, {
        hasAccessToken: !!CONFIG.accessToken,
        hasPhoneNumberId: !!CONFIG.phoneNumberId
      });
      return new NextResponse('Server configuration error', { status: 500 });
    }
    
    const body: WebhookBody = await req.json();
    debug(`[${requestId}] Webhook body received`, { 
      object: body.object,
      entryCount: body.entry?.length || 0 
    });
    
    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      
      if (value?.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const from = message.from;
        const isAdmin = (from === CONFIG.adminId);
        
        // Handle message asynchronously without blocking response
        handleUserMessage(from, message, isAdmin).catch(err => {
          error(`[${requestId}] Async message handling error:`, err);
        });
        
      } else if (value?.statuses) {
        debug(`[${requestId}] Status update received`, value.statuses);
      }
      
      info(`[${requestId}] Webhook processed successfully`);
      return NextResponse.json({ status: 'EVENT_RECEIVED' });
      
    } else {
      warn(`[${requestId}] Invalid object type in webhook: ${body.object}`);
      return new NextResponse('Not Found', { status: 404 });
    }
    
  } catch (e) {
    error(`[${requestId}] Webhook processing error:`, e);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  info('Webhook verification request received');
  
  const searchParams = req.nextUrl.searchParams;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');
  
  debug('Webhook verification parameters', { mode, token, challenge });
  
  if (mode && token) {
    if (mode === 'subscribe' && token === CONFIG.verifyToken) {
      info('WEBHOOK_VERIFIED successfully');
      return new NextResponse(challenge);
    } else {
      warn('Webhook verification failed', { mode, token, expectedToken: CONFIG.verifyToken });
      return new NextResponse('Forbidden', { status: 403 });
    }
  }
  
  warn('Invalid verification request', { mode, token });
  return new NextResponse('Method Not Allowed', { status: 405 });
}