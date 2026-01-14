// app/api/whatsapp/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Types, Document } from "mongoose";
import User, { IUser } from "@/models/User";
import Transaction, { ITransaction } from "@/models/Transaction";
import Service, { IService } from "@/models/Service";
import Order, { IOrder } from "@/models/Order";
import stateManager, {
  UserState as StateManagerUserState,
} from "@/lib/whatsappState";
import { sendMessage, sendButtons, sendList } from "@/lib/whatsappApi";
import { connectDB } from "@/lib/mongodb-bot";

// Define all types locally
interface WhatsAppMessage {
  from: string;
  text?: { body: string };
  type: string;
  button?: { text: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  timestamp: string;
}

interface WhatsAppWebhookPayload {
  entry: Array<{
    changes: Array<{
      value: {
        messages?: WhatsAppMessage[];
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
      };
    }>;
  }>;
}

interface ServiceField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "file";
  options?: string[];
  required: boolean;
}

interface RechargeStateData {
  amount?: number;
}

interface OrderStateData {
  serviceId?: string;
  serviceName?: string;
  servicePrice?: number;
  quantity?: number;
  totalPrice?: number;
  requiredFields?: ServiceField[];
  currentFieldIndex?: number;
  collectedData?: Record<string, string>;
}

interface ServiceForList {
  _id: Types.ObjectId;
  name: string;
  category: string;
  price: number;
  description: string;
  minQuantity?: number;
  maxQuantity?: number;
}

interface PopulatedOrder extends Omit<IOrder, "serviceId"> {
  serviceId: {
    _id: Types.ObjectId;
    name: string;
  };
}

interface PopulatedTransaction extends Omit<ITransaction, "serviceId"> {
  serviceId: {
    _id: Types.ObjectId;
    name: string;
  } | null;
}

interface TransactionLean {
  amount: number;
  trxId: string;
  createdAt: Date;
}

const STATES = {
  IDLE: "idle",
  AWAITING_TRX_ID: "awaiting_trx_id",
  AWAITING_AMOUNT: "awaiting_amount",
  AWAITING_SERVICE_CHOICE: "awaiting_service_choice",
  AWAITING_SERVICE_DATA: "awaiting_service_data",
  AWAITING_ORDER_CONFIRM: "awaiting_order_confirm",
  VIEWING_SERVICES: "viewing_services",
  VIEWING_SERVICE_DETAILS: "viewing_service_details",
} as const;

// Helper function to safely convert OrderStateData to Record<string, unknown>
function orderStateDataToRecord(data: OrderStateData): Record<string, unknown> {
  return {
    serviceId: data.serviceId,
    serviceName: data.serviceName,
    servicePrice: data.servicePrice,
    quantity: data.quantity,
    totalPrice: data.totalPrice,
    requiredFields: data.requiredFields,
    currentFieldIndex: data.currentFieldIndex,
    collectedData: data.collectedData,
  };
}

// Helper function to safely convert RechargeStateData to Record<string, unknown>
function rechargeStateDataToRecord(
  data: RechargeStateData
): Record<string, unknown> {
  return {
    amount: data.amount,
  };
}

// Helper function to safely parse OrderStateData from Record<string, unknown>
function parseOrderStateData(data: Record<string, unknown>): OrderStateData {
  return {
    serviceId: typeof data.serviceId === "string" ? data.serviceId : undefined,
    serviceName:
      typeof data.serviceName === "string" ? data.serviceName : undefined,
    servicePrice:
      typeof data.servicePrice === "number" ? data.servicePrice : undefined,
    quantity: typeof data.quantity === "number" ? data.quantity : undefined,
    totalPrice:
      typeof data.totalPrice === "number" ? data.totalPrice : undefined,
    requiredFields: Array.isArray(data.requiredFields)
      ? (data.requiredFields as ServiceField[])
      : undefined,
    currentFieldIndex:
      typeof data.currentFieldIndex === "number"
        ? data.currentFieldIndex
        : undefined,
    collectedData:
      data.collectedData &&
      typeof data.collectedData === "object" &&
      !Array.isArray(data.collectedData)
        ? (data.collectedData as Record<string, string>)
        : undefined,
  };
}

// Helper function to safely parse RechargeStateData from Record<string, unknown>
function parseRechargeStateData(
  data: Record<string, unknown>
): RechargeStateData {
  return {
    amount: typeof data.amount === "number" ? data.amount : undefined,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body: WhatsAppWebhookPayload = await req.json();
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return NextResponse.json({ status: "ignored" });
    }

    const from = message.from;
    const text = message.text?.body?.trim() || "";
    const buttonText = message.button?.text;
    const interactive = message.interactive;

    // Handle button clicks and interactive messages
    let userInput = text;
    if (buttonText) {
      userInput = buttonText.toLowerCase();
    } else if (interactive?.button_reply) {
      userInput = interactive.button_reply.title.toLowerCase();
    } else if (interactive?.list_reply) {
      userInput = interactive.list_reply.title.toLowerCase();
    }

    console.log(`📱 [${from}] ${userInput}`);
    await connectDB();
    let user = await User.findOne({ whatsapp: from });
    if (!user) {
      user = await User.create({ whatsapp: from });
    }

    user.whatsappLastActive = new Date();
    user.whatsappMessageCount += 1;
    await user.save();

    const userState = await stateManager.getUserState(from);
    const currentState = userState?.currentState || STATES.IDLE;

    if (userInput.toLowerCase() === "cancel") {
      await stateManager.clearUserState(from);
      await sendMessage(from, "❌ Operation cancelled.");
      await sendMainMenuButtons(from);
      return NextResponse.json({ status: "cancelled" });
    } else if (
      userInput.toLowerCase() === "menu" ||
      userInput.toLowerCase() === "start"
    ) {
      await stateManager.clearUserState(from);
      await sendMainMenuButtons(from);
      return NextResponse.json({ status: "menu_sent" });
    } else if (currentState === STATES.IDLE) {
      await handleIdleState(from, userInput, user);
    } else if (currentState === STATES.AWAITING_AMOUNT) {
      const response = await handleAwaitingAmount(from, userInput, user);
      if (response) await sendMessage(from, response);
    } else if (currentState === STATES.AWAITING_TRX_ID) {
      const response = await handleAwaitingTrxId(from, userInput, user);
      if (response) await sendMessage(from, response);
    } else if (currentState === STATES.AWAITING_SERVICE_CHOICE) {
      const response = await handleAwaitingServiceChoice(
        from,
        userInput,
        user,
        userState
      );
      if (response) await sendMessage(from, response);
    } else if (currentState === STATES.AWAITING_SERVICE_DATA) {
      const response = await handleAwaitingServiceData(
        from,
        userInput,
        user,
        userState
      );
      if (response) await sendMessage(from, response);
    } else if (currentState === STATES.AWAITING_ORDER_CONFIRM) {
      const response = await handleAwaitingOrderConfirm(
        from,
        userInput,
        user,
        userState
      );
      if (response) await sendMessage(from, response);
    } else if (currentState === STATES.VIEWING_SERVICES) {
      await handleViewingServices(from, userInput, user, userState);
    } else if (currentState === STATES.VIEWING_SERVICE_DETAILS) {
      await handleViewingServiceDetails(from, userInput, user, userState);
    } else {
      await sendMessage(from, "❌ Invalid state. Type *menu* for main menu.");
    }

    return NextResponse.json({
      status: "ok",
      state: currentState,
      userId: user._id,
    });
  } catch (error: unknown) {
    console.error("Webhook error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Webhook processing failed", details: errorMessage },
      { status: 500 }
    );
  }
}

async function sendMainMenuButtons(phone: string): Promise<void> {
  const buttons = [
    {
      type: "reply",
      reply: {
        id: "btn_account",
        title: "👤 Account",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_balance",
        title: "💰 Balance",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_recharge",
        title: "💳 Recharge",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_services",
        title: "📋 Services",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_orders",
        title: "📦 Orders",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_support",
        title: "🆘 Support",
      },
    },
  ];

  await sendButtons(
    phone,
    "📱 *WELCOME TO OUR WHATSAPP BOT*\n\nWhat would you like to do?",
    buttons
  );
}

async function handleIdleState(
  phone: string,
  text: string,
  user: IUser & Document
): Promise<void> {
  const command = text.toLowerCase().trim();

  switch (command) {
    case "👤 account":
    case "account":
    case "1":
      await sendAccountInfo(phone, user);
      break;

    case "💰 balance":
    case "balance":
    case "2":
      await sendBalanceInfo(phone, user);
      break;

    case "💳 recharge":
    case "recharge":
    case "3":
      await stateManager.setUserState(phone, {
        currentState: STATES.AWAITING_AMOUNT,
        flowType: "recharge",
        data: rechargeStateDataToRecord({}),
      });
      await sendQuickRechargeButtons(phone);
      break;

    case "📋 services":
    case "services":
    case "4":
      await showServicesCategories(phone, user);
      break;

    case "📦 orders":
    case "orders":
    case "5":
      await sendMyOrders(phone, user._id);
      break;

    case "🆘 support":
    case "support":
    case "8":
      await sendSupportInfo(phone);
      break;

    case "🛒 order now":
      const userState = await stateManager.getUserState(phone);
      const userStateData = userState?.data as {
        selectedServiceId?: string;
        selectedServiceName?: string;
        selectedServicePrice?: number;
      };

      if (userStateData?.selectedServiceId) {
        const service = await Service.findById(userStateData.selectedServiceId);
        if (service) {
          await startOrderProcess(phone, user, service);
        } else {
          await sendMessage(
            phone,
            "❌ Service not found. Please select a service again."
          );
          await showServicesCategories(phone, user);
        }
      } else {
        await sendMessage(
          phone,
          "❌ No service selected. Please select a service first."
        );
        await showServicesCategories(phone, user);
      }
      break;

    case "🔙 categories":
      await showServicesCategories(phone, user);
      break;

    case "📱 main menu":
      await sendMainMenuButtons(phone);
      break;

    default:
      if (command.startsWith("service")) {
        await handleServiceSelection(phone, text, user);
      } else {
        await sendMessage(
          phone,
          `🤖 I didn't understand that.\n\nType *menu* for main menu or choose from buttons.`
        );
        await sendMainMenuButtons(phone);
      }
  }
}

async function sendAccountInfo(
  phone: string,
  user: IUser & Document
): Promise<void> {
  const accountInfo = `👤 *ACCOUNT INFORMATION*\n\n📛 Name: ${
    user.name || "Not set"
  }\n📱 WhatsApp: ${user.whatsapp}\n💰 Balance: ${
    user.balance
  } BDT\n📅 Joined: ${new Date(user.createdAt).toLocaleDateString()}`;

  await sendMessage(phone, accountInfo);
  await sendMainMenuButtons(phone);
}

async function sendBalanceInfo(
  phone: string,
  user: IUser & Document
): Promise<void> {
  const recentTx = await Transaction.find({
    userId: user._id,
    type: "recharge",
    status: "completed",
  })
    .sort({ createdAt: -1 })
    .limit(3)
    .select("amount trxId createdAt")
    .lean<TransactionLean[]>();

  let recentText = "";
  if (recentTx.length > 0) {
    recentText = "\n\n💳 *Recent Recharges:*\n";
    recentTx.forEach((tx: TransactionLean, i: number) => {
      const date = new Date(tx.createdAt).toLocaleDateString();
      recentText += `${i + 1}. +${tx.amount} BDT (${date})\n`;
    });
  }

  const balanceInfo = `💰 *BALANCE*\n\nCurrent Balance: *${user.balance} BDT*${recentText}`;

  await sendMessage(phone, balanceInfo);

  if (user.balance < 100) {
    const lowBalanceButtons = [
      {
        type: "reply",
        reply: {
          id: "btn_recharge_now",
          title: "💳 Recharge Now",
        },
      },
      {
        type: "reply",
        reply: {
          id: "btn_menu",
          title: "📱 Main Menu",
        },
      },
    ];
    await sendButtons(
      phone,
      "⚠️ *Low Balance Alert!*\nYour balance is below 100 BDT. Recharge now to continue ordering services.",
      lowBalanceButtons
    );
  } else {
    await sendMainMenuButtons(phone);
  }
}

async function sendQuickRechargeButtons(phone: string): Promise<void> {
  const buttons = [
    {
      type: "reply",
      reply: {
        id: "btn_100",
        title: "100 BDT",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_500",
        title: "500 BDT",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_1000",
        title: "1000 BDT",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_custom",
        title: "Custom Amount",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_cancel",
        title: "❌ Cancel",
      },
    },
  ];

  await sendButtons(
    phone,
    `💳 *QUICK RECHARGE*\n\nSelect an amount or enter custom amount:\n\nMinimum: 100 BDT`,
    buttons
  );
}

async function handleAwaitingAmount(
  phone: string,
  text: string,
  user: IUser & Document
): Promise<string> {
  let amount: number;

  if (text.includes("bdt")) {
    amount = parseFloat(text.replace("bdt", "").trim());
  } else if (text === "100 bdt") {
    amount = 100;
  } else if (text === "500 bdt") {
    amount = 500;
  } else if (text === "1000 bdt") {
    amount = 1000;
  } else if (text === "custom amount") {
    return "💳 *CUSTOM RECHARGE*\n\nEnter your desired amount (minimum 100 BDT):\n\nExample: *250*";
  } else {
    amount = parseFloat(text);
  }

  if (isNaN(amount) || amount < 100) {
    return "❌ Invalid amount. Minimum recharge is 100 BDT.\n\nPlease select from buttons or enter a valid amount.";
  }

  const pendingRecharge = await Transaction.findOne({
    userId: user._id,
    type: "recharge",
    status: "pending",
    createdAt: { $gt: new Date(Date.now() - 30 * 60 * 1000) },
  });

  if (pendingRecharge) {
    return `⚠️ You have a pending recharge:\nAmount: ${pendingRecharge.amount} BDT\nTrxID: ${pendingRecharge.trxId}\n\nPlease complete that first or contact support.`;
  }

  await stateManager.setUserState(phone, {
    currentState: STATES.AWAITING_TRX_ID,
    flowType: "recharge",
    data: rechargeStateDataToRecord({ amount }),
  });

  const bkashNumber = process.env.BKASH_NUMBER || "017XXXXXXXX";

  const paymentButtons = [
    {
      type: "reply",
      reply: {
        id: "btn_paid",
        title: "✅ I've Paid",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_cancel",
        title: "❌ Cancel",
      },
    },
  ];

  await sendButtons(
    phone,
    `💳 *PAYMENT INSTRUCTIONS*\n\n1️⃣ Send *${amount} BDT* to:\n📱 Bkash: *${bkashNumber}*\n(Personal Payment)\n\n2️⃣ After payment, click "I've Paid" button below or send:\n\`trxid YOUR_TRANSACTION_ID\`\n\n⏰ Complete within 30 minutes.`,
    paymentButtons
  );

  return ""; // Message already sent via buttons
}

async function handleAwaitingTrxId(
  phone: string,
  text: string,
  user: IUser & Document
): Promise<string> {
  let trxId = "";

  if (
    text.toLowerCase() === "✅ i've paid" ||
    text.toLowerCase() === "i've paid"
  ) {
    return "📝 *TRANSACTION ID*\n\nPlease enter your Bkash transaction ID:\n\nFormat: *trxid A1B2C3D4*\n\nOr type *cancel* to exit.";
  }

  if (!text.toLowerCase().startsWith("trxid")) {
    return "❌ Please send transaction ID in format:\n`trxid YOUR_TRANSACTION_ID`\n\nExample: `trxid A1B2C3D4`\n\nOr type *cancel* to exit.";
  }

  const parts = text.split(" ");
  if (parts.length < 2) {
    return "❌ Please include transaction ID.\nFormat: `trxid YOUR_TRANSACTION_ID`";
  }

  trxId = parts[1].toUpperCase();
  const userState = await stateManager.getUserState(phone);
  const data = userState ? parseRechargeStateData(userState.data) : {};
  const amount = data.amount;

  if (!amount) {
    await stateManager.clearUserState(phone);
    return "❌ Session expired. Please start recharge again.";
  }

  const result = await processRecharge(user, trxId, amount);
  await stateManager.clearUserState(phone);

  // After recharge, show main menu
  await sendMainMenuButtons(phone);

  return result;
}

async function processRecharge(
  user: IUser & Document,
  trxId: string,
  amount: number
): Promise<string> {
  try {
    const existing = await Transaction.findOne({ trxId });
    if (existing) {
      return `❌ Transaction ID *${trxId}* already used.\nContact support if this is a mistake.`;
    }

    const transaction = await Transaction.create({
      userId: user._id,
      type: "recharge",
      amount,
      method: "bkash",
      trxId,
      status: "pending",
      balanceBefore: user.balance,
      balanceAfter: user.balance,
      metadata: {
        sender: user.whatsapp,
        verifiedBy: "auto",
        notes: "Pending verification",
      },
    });

    const adminPhone = process.env.ADMIN_WHATSAPP;
    if (adminPhone) {
      await sendMessage(
        adminPhone,
        `🔄 New Recharge Request\nUser: ${
          user.name || user.whatsapp
        }\nAmount: ${amount} BDT\nTrxID: ${trxId}\nWhatsApp: ${
          user.whatsapp
        }\n\nTo approve: /approve ${transaction._id}`
      );
    }

    return `✅ *RECHARGE REQUEST SUBMITTED*\n\n💰 Amount: ${amount} BDT\n📋 Transaction ID: ${trxId}\n🔄 Status: Pending Verification\n\nWe will verify your payment and update your balance shortly. You'll receive a confirmation message.`;
  } catch (error: unknown) {
    console.error("Recharge error:", error);
    return "❌ Recharge failed. Please try again or contact support.";
  }
}

async function showServicesCategories(
  phone: string,
  user: IUser & Document
): Promise<void> {
  const categories = await Service.find({
    isActive: true,
  });

  if (categories.length === 0) {
    await sendMessage(phone, "📭 No services available at the moment.");
    await sendMainMenuButtons(phone);
    return;
  }

  const categoryButtons = categories.slice(0, 10).map((category, index) => ({
    type: "reply",
    reply: {
      id: `cat_${index}`,
      title: category,
    },
  }));

  // Add back button
  categoryButtons.push({
    type: "reply",
    reply: {
      id: "btn_back",
      title: "🔙 Back",
    },
  });

  await stateManager.setUserState(phone, {
    currentState: STATES.VIEWING_SERVICES,
    data: { categories },
  });

  await sendButtons(
    phone,
    "📋 *SERVICE CATEGORIES*\n\nSelect a category to view services:",
    categoryButtons
  );
}

async function handleViewingServices(
  phone: string,
  text: string,
  user: IUser & Document,
  userState: StateManagerUserState | null
): Promise<void> {
  if (text.toLowerCase() === "🔙 back" || text.toLowerCase() === "back") {
    await stateManager.clearUserState(phone);
    await sendMainMenuButtons(phone);
    return;
  }

  const services = await Service.find({
    category: text,
    isActive: true,
    isAvailable: true,
  })
    .sort({ price: 1 })
    .limit(30)
    .select("name price description minQuantity maxQuantity")
    .lean<ServiceForList[]>();

  if (services.length === 0) {
    await sendMessage(phone, `📭 No services found in "${text}" category.`);
    await showServicesCategories(phone, user);
    return;
  }

  // Create sections properly for WhatsApp list
  const sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }> = [];

  // If we have many services, split them into multiple sections
  if (services.length > 10) {
    const maxRowsPerSection = 10;
    const numSections = Math.ceil(services.length / maxRowsPerSection);

    for (let i = 0; i < numSections; i++) {
      const startIndex = i * maxRowsPerSection;
      const endIndex = startIndex + maxRowsPerSection;
      const serviceChunk = services.slice(startIndex, endIndex);

      const sectionRows = serviceChunk.map((service, index) => ({
        id: `srv_${service._id}_${i}_${index}`,
        title: `${service.name} - ${service.price} BDT`,
        description: service.description.substring(0, 72),
      }));

      sections.push({
        title: `${text} (${i + 1}/${numSections})`,
        rows: sectionRows,
      });
    }
  } else {
    // Single section for small number of services
    const rows = services.map((service, index) => ({
      id: `srv_${service._id}_${index}`,
      title: `${service.name} - ${service.price} BDT`,
      description: service.description.substring(0, 72),
    }));

    sections.push({
      title: text,
      rows: rows,
    });
  }

  try {
    // Send the list with sections
    await sendList(
      phone,
      `📋 *${text.toUpperCase()} SERVICES*`,
      `Select a service (Total: ${services.length}):`,
      "Browse Services",
      sections
    );

    await stateManager.setUserState(phone, {
      currentState: STATES.VIEWING_SERVICE_DETAILS,
      data: {
        category: text,
        services: services.map((s) => s._id.toString()),
        serviceNames: services.map((s) => s.name),
      },
    });
  } catch (error) {
    // Fallback to buttons if list fails
    console.error("List failed, falling back to buttons:", error);
    await sendServiceListAsButtons(phone, services, text, user);
  }
}

async function sendServiceListAsButtons(
  phone: string,
  services: ServiceForList[],
  category: string,
  user: IUser & Document
): Promise<void> {
  let message = `📋 *${category.toUpperCase()} SERVICES*\n\n`;

  services.slice(0, 10).forEach((service, index) => {
    message += `${index + 1}. ${service.name}\n`;
    message += `   💰 ${service.price} BDT\n`;
    message += `   📝 ${service.description.substring(0, 40)}...\n\n`;
  });

  if (services.length > 10) {
    message += `... and ${services.length - 10} more services\n\n`;
  }

  message += `Reply with service number (1-${Math.min(
    services.length,
    10
  )}) to select.`;

  await sendMessage(phone, message);

  await stateManager.setUserState(phone, {
    currentState: STATES.VIEWING_SERVICE_DETAILS,
    data: {
      category,
      services: services.map((s) => s._id.toString()),
      serviceNames: services.map((s) => s.name),
    },
  });
}

async function handleViewingServiceDetails(
  phone: string,
  text: string,
  user: IUser & Document,
  userState: StateManagerUserState | null
): Promise<void> {
  if (text.toLowerCase() === "🔙 back" || text.toLowerCase() === "back") {
    await showServicesCategories(phone, user);
    return;
  }

  const userStateData = userState?.data as {
    services?: string[];
    serviceNames?: string[];
    category?: string;
  };

  let service: IService | null = null;

  // Try to match the service from the list selection
  // Format: "Service Name - 100 BDT"
  const match = text.match(/^(.*?) - (\d+) BDT$/);

  if (match) {
    const [, serviceName] = match;
    service = await Service.findOne({
      name: serviceName.trim(),
      isActive: true,
      isAvailable: true,
    });
  } else if (userStateData?.serviceNames) {
    // Try to match by index (for fallback text mode)
    const index = parseInt(text);
    if (
      !isNaN(index) &&
      index > 0 &&
      index <= userStateData.serviceNames.length
    ) {
      const serviceName = userStateData.serviceNames[index - 1];
      service = await Service.findOne({
        name: serviceName,
        isActive: true,
        isAvailable: true,
      });
    }
  }

  if (!service) {
    await sendMessage(
      phone,
      "❌ Service not found. Please select from the list."
    );
    await showServicesCategories(phone, user);
    return;
  }

  await showServiceDetails(phone, user, service);
}

async function showServiceDetails(
  phone: string,
  user: IUser & Document,
  service: IService
): Promise<void> {
  const buttons = [
    {
      type: "reply",
      reply: {
        id: `order_${service._id}`,
        title: "🛒 Order Now",
      },
    },
    {
      type: "reply",
      reply: {
        id: "back_cat",
        title: "🔙 Categories",
      },
    },
    {
      type: "reply",
      reply: {
        id: "main_menu",
        title: "📱 Main Menu",
      },
    },
  ];

  let serviceDetails = `📋 *${service.name.toUpperCase()}*\n\n`;
  serviceDetails += `💰 *Price:* ${service.price} BDT\n`;
  serviceDetails += `📝 *Description:* ${service.description}\n`;

  if (service.instructions) {
    serviceDetails += `📋 *Instructions:* ${service.instructions}\n`;
  }

  serviceDetails += `\n💳 *Your Balance:* ${user.balance} BDT`;

  await sendButtons(phone, serviceDetails, buttons);

  await stateManager.setUserState(phone, {
    currentState: STATES.IDLE,
    data: {
      selectedServiceId: service._id.toString(),
      selectedServiceName: service.name,
      selectedServicePrice: service.price,
    },
  });
}

async function handleServiceSelection(
  phone: string,
  text: string,
  user: IUser & Document
): Promise<void> {
  const parts = text.split(" ");
  const serviceNum = parseInt(parts[1]);

  if (isNaN(serviceNum) || serviceNum < 1) {
    await sendMessage(phone, "❌ Invalid service number.");
    await sendMainMenuButtons(phone);
    return;
  }

  const services = await Service.find({
    isActive: true,
    isAvailable: true,
  })
    .sort({ category: 1, name: 1 })
    .lean<IService[]>();

  if (serviceNum > services.length) {
    await sendMessage(phone, "❌ Service not found.");
    await sendMainMenuButtons(phone);
    return;
  }

  const service = services[serviceNum - 1];

  if (user.balance < service.price) {
    const buttons = [
      {
        type: "reply",
        reply: {
          id: "btn_recharge",
          title: "💳 Recharge",
        },
      },
      {
        type: "reply",
        reply: {
          id: "btn_menu",
          title: "📱 Main Menu",
        },
      },
    ];

    await sendButtons(
      phone,
      `❌ *Insufficient Balance!*\n\nService price: ${service.price} BDT\nYour balance: ${user.balance} BDT\n\nPlease recharge first.`,
      buttons
    );
    return;
  }

  await startOrderProcess(phone, user, service);
}

async function startOrderProcess(
  phone: string,
  user: IUser & Document,
  service: IService
): Promise<void> {
  const orderData: OrderStateData = {
    serviceId: service._id.toString(),
    serviceName: service.name,
    servicePrice: service.price,
    requiredFields: service.requiredFields || [],
    currentFieldIndex: 0,
    collectedData: {},
  };

  await stateManager.setUserState(phone, {
    currentState: STATES.AWAITING_SERVICE_DATA,
    flowType: "order",
    data: orderStateDataToRecord(orderData),
  });

  const fields = service.requiredFields || [];
  if (fields.length > 0) {
    const firstField = fields[0];
    await askForField(phone, service, firstField, 1, fields.length);
  } else {
    await confirmOrder(phone, user, orderData);
  }
}

async function handleAwaitingServiceChoice(
  phone: string,
  text: string,
  user: IUser & Document,
  userState: StateManagerUserState | null
): Promise<string> {
  const quantity = parseInt(text);

  if (isNaN(quantity) || quantity < 1) {
    return "❌ Invalid quantity. Please enter a number (minimum 1).\n\nOr type *cancel* to exit.";
  }

  const data = userState ? parseOrderStateData(userState.data) : {};
  const servicePrice = data.servicePrice;

  if (!servicePrice) {
    await stateManager.clearUserState(phone);
    return "❌ Session expired. Please start again.";
  }

  const totalPrice = servicePrice * quantity;

  if (user.balance < totalPrice) {
    return `❌ Insufficient balance!\n\nTotal amount: ${totalPrice} BDT\nYour balance: ${user.balance} BDT\n\nPlease recharge first or adjust quantity.`;
  }

  const updatedData: OrderStateData = {
    ...data,
    quantity,
    totalPrice,
    currentFieldIndex: 0,
  };

  await stateManager.setUserState(phone, {
    currentState: STATES.AWAITING_SERVICE_DATA,
    data: orderStateDataToRecord(updatedData),
  });

  const fields = data.requiredFields || [];

  if (fields.length > 0) {
    const firstField = fields[0];
    const serviceName = data.serviceName || "Service";
    await askForField(
      phone,
      { name: serviceName } as IService,
      firstField,
      1,
      fields.length
    );
    return `🛒 *ORDER DETAILS*\n\nService: ${serviceName}\nQuantity: ${quantity}\nTotal: ${totalPrice} BDT`;
  } else {
    await confirmOrder(phone, user, updatedData);
    return "";
  }
}

async function askForField(
  phone: string,
  service: { name: string },
  field: ServiceField,
  current: number,
  total: number
): Promise<void> {
  let message = `📝 *${service.name} - Field ${current} of ${total}*\n\n`;
  message += `*${field.label}*${field.required ? " (Required)" : ""}\n`;

  if (field.type === "select" && field.options) {
    message += `\nOptions: ${field.options.join(", ")}`;
  } else if (field.type === "number") {
    message += `\nEnter a number:`;
  } else if (field.type === "file") {
    message += `\nPlease send the file or document:`;
  } else {
    message += `\nEnter text:`;
  }

  await sendMessage(phone, message);
}

async function handleAwaitingServiceData(
  phone: string,
  text: string,
  user: IUser & Document,
  userState: StateManagerUserState | null
): Promise<string> {
  if (!userState) {
    await stateManager.clearUserState(phone);
    return "❌ Session expired. Please start again.";
  }

  const data = parseOrderStateData(userState.data);
  const fields = data.requiredFields || [];

  const currentIndex = data.currentFieldIndex || 0;

  if (currentIndex >= fields.length) {
    await confirmOrder(phone, user, data);
    return "";
  }

  const currentField = fields[currentIndex];

  let isValid = true;
  let validationError = "";

  if (currentField.required && (!text || text.trim() === "")) {
    isValid = false;
    validationError = "This field is required.";
  } else if (currentField.type === "number") {
    const num = parseFloat(text);
    if (isNaN(num)) {
      isValid = false;
      validationError = "Please enter a valid number.";
    }
  } else if (currentField.type === "select" && currentField.options) {
    if (!currentField.options.includes(text)) {
      isValid = false;
      validationError = `Please choose from: ${currentField.options.join(
        ", "
      )}`;
    }
  }

  if (!isValid) {
    return `❌ Invalid input: ${validationError}\n\nPlease provide:\n*${
      currentField.label
    }*${currentField.required ? " (Required)" : ""}\n\nType *cancel* to exit.`;
  }

  const collectedData = { ...(data.collectedData || {}) };
  collectedData[currentField.name] = text;

  const nextIndex = currentIndex + 1;
  const updatedData: OrderStateData = {
    ...data,
    currentFieldIndex: nextIndex,
    collectedData,
  };

  if (nextIndex < fields.length) {
    await stateManager.setUserState(phone, {
      currentState: STATES.AWAITING_SERVICE_DATA,
      data: orderStateDataToRecord(updatedData),
    });

    const nextField = fields[nextIndex];
    await askForField(
      phone,
      { name: data.serviceName || "Service" } as IService,
      nextField,
      nextIndex + 1,
      fields.length
    );
    return `✅ ${currentField.label}: ${text}`;
  } else {
    await confirmOrder(phone, user, updatedData);
    return "✅ All information collected!";
  }
}

async function confirmOrder(
  phone: string,
  user: IUser & Document,
  orderData: OrderStateData
): Promise<void> {
  await stateManager.setUserState(phone, {
    currentState: STATES.AWAITING_ORDER_CONFIRM,
    data: orderStateDataToRecord(orderData),
  });

  const serviceName = orderData.serviceName || "Service";
  const quantity = orderData.quantity || 1;
  const totalPrice = orderData.totalPrice || orderData.servicePrice || 0;

  const buttons = [
    {
      type: "reply",
      reply: {
        id: "btn_confirm",
        title: "✅ Confirm Order",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_cancel",
        title: "❌ Cancel",
      },
    },
  ];

  await sendButtons(
    phone,
    `🛒 *ORDER CONFIRMATION*\n\nService: ${serviceName}\nQuantity: ${quantity}\nTotal: ${totalPrice} BDT\nYour balance: ${user.balance} BDT\n\nConfirm to place order?`,
    buttons
  );
}

async function handleAwaitingOrderConfirm(
  phone: string,
  text: string,
  user: IUser & Document,
  userState: StateManagerUserState | null
): Promise<string> {
  if (
    text.toLowerCase() !== "✅ confirm order" &&
    text.toLowerCase() !== "yes"
  ) {
    await stateManager.clearUserState(phone);
    await sendMessage(phone, "❌ Order cancelled.");
    await sendMainMenuButtons(phone);
    return "";
  }

  if (!userState) {
    await stateManager.clearUserState(phone);
    return "❌ Session expired. Please start again.";
  }

  const data = parseOrderStateData(userState.data);

  if (!data.serviceId || !data.serviceName || !data.totalPrice) {
    await stateManager.clearUserState(phone);
    return "❌ Invalid order data. Please try again.";
  }

  try {
    const transaction = await Transaction.create({
      userId: user._id,
      type: "service_payment",
      amount: data.totalPrice,
      method: "system",
      trxId: `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      status: "completed",
      serviceId: new Types.ObjectId(data.serviceId),
      serviceName: data.serviceName,
      balanceBefore: user.balance,
      balanceAfter: user.balance - data.totalPrice,
      metadata: {
        orderedVia: "whatsapp",
        serviceData: data.collectedData || {},
      },
    });

    user.balance -= data.totalPrice;
    await user.save();

    const order = await Order.create({
      userId: user._id,
      serviceId: new Types.ObjectId(data.serviceId),
      quantity: data.quantity || 1,
      unitPrice: data.servicePrice || data.totalPrice,
      totalPrice: data.totalPrice,
      serviceData: data.collectedData || {},
      status: "pending",
      transactionId: transaction._id,
      placedAt: new Date(),
    });

    await stateManager.clearUserState(phone);

    const adminPhone = process.env.ADMIN_WHATSAPP;
    if (adminPhone) {
      await sendMessage(
        adminPhone,
        `🛒 New Order\nUser: ${user.name || user.whatsapp}\nService: ${
          data.serviceName
        }\nAmount: ${data.totalPrice} BDT\nOrder ID: ${
          order.orderId
        }\nWhatsApp: ${user.whatsapp}`
      );
    }

    await sendMessage(
      phone,
      `✅ *ORDER PLACED SUCCESSFULLY!*\n\n📦 Order ID: ${order.orderId}\n🛒 Service: ${data.serviceName}\n💰 Amount: ${data.totalPrice} BDT\n💳 Paid from balance\n📈 New Balance: ${user.balance} BDT\n\nWe'll process your order shortly. You'll receive updates here.`
    );

    await sendMainMenuButtons(phone);
    return "";
  } catch (error: unknown) {
    console.error("Order creation error:", error);
    await stateManager.clearUserState(phone);
    return "❌ Order failed. Please try again or contact support.";
  }
}

async function sendMyOrders(
  phone: string,
  userId: Types.ObjectId
): Promise<void> {
  const orders = await Order.find({ userId })
    .populate("serviceId", "name")
    .sort({ createdAt: -1 })
    .limit(5)
    .lean<PopulatedOrder[]>();

  if (orders.length === 0) {
    await sendMessage(
      phone,
      "📭 No orders found. Use *Services* to place an order."
    );
    await sendMainMenuButtons(phone);
    return;
  }

  let response = "📦 *MY RECENT ORDERS*\n\n";

  orders.forEach((order: PopulatedOrder, index: number) => {
    const serviceName = order.serviceId?.name || "Unknown Service";
    const date = new Date(order.createdAt).toLocaleDateString();
    const statusEmoji = getOrderStatusEmoji(order.status);

    response += `${index + 1}. ${statusEmoji} ${serviceName}\n`;
    response += `   ID: ${order.orderId}\n`;
    response += `   Amount: ${order.totalPrice} BDT\n`;
    response += `   Status: ${order.status}\n`;
    response += `   Date: ${date}\n\n`;
  });

  response += "📊 For detailed order history, visit our website.";

  await sendMessage(phone, response);
  await sendMainMenuButtons(phone);
}

async function sendSupportInfo(phone: string): Promise<void> {
  const supportPhone = process.env.SUPPORT_PHONE || "Not Available";
  const supportEmail = process.env.SUPPORT_EMAIL || "Not Available";
  const appUrl = process.env.APP_URL || "Not Available";

  const supportButtons = [
    {
      type: "reply",
      reply: {
        id: "btn_call",
        title: "📞 Call Support",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_email",
        title: "📧 Email",
      },
    },
    {
      type: "reply",
      reply: {
        id: "btn_menu",
        title: "📱 Main Menu",
      },
    },
  ];

  await sendButtons(
    phone,
    `🆘 *SUPPORT*\n\n📞 Contact: ${supportPhone}\n📧 Email: ${supportEmail}\n🌐 Website: ${appUrl}\n\nFor urgent issues, please call or message our support team.`,
    supportButtons
  );
}

function getOrderStatusEmoji(status: string): string {
  const emojis: Record<string, string> = {
    pending: "⏳",
    processing: "🔄",
    completed: "✅",
    failed: "❌",
    refunded: "↩️",
    cancelled: "🚫",
  };
  return emojis[status] || "📦";
}
