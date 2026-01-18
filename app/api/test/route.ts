import { sendDeliveryFile } from "@/app/whatsapp/webhook/route";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    await sendDeliveryFile(
      "8801964753086",
      "https://bot.birthhelp.top/file/696cb880c29562b732d816a3",
      "1768740870924_delivery.jpg",
      "image/jpeg",
      "Your delivery file is ready!",
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    });
  }
}
