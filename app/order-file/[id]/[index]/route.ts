import { connectDB } from "@/lib/mongodb-bot";
import PostFile from "@/models/Order";
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  try {
    await connectDB();
    const { id, index } = await params;
    if (!id) {
      return NextResponse.json({ error: "Id not found" }, { status: 404 });
    }

    // 1. Fetch record
    const record = await PostFile.findById(id);
    if (!record) {
      return NextResponse.json(
        { error: "File record not found" },
        { status: 404 },
      );
    }

    const data = record.serviceData[Number(index)]?.data;
    const filePathFromPwd =
      typeof data === "object" && data !== null && "filePath" in data
        ? data.filePath
        : null;
    const filePath = filePathFromPwd
      ? path.resolve(process.cwd(), filePathFromPwd)
      : null;
    if (!filePath) {
      return NextResponse.json(
        { error: "File path not found" },
        { status: 404 },
      );
    }

    // 2. Check file exists
    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: "File not found on server" },
        { status: 404 },
      );
    }

    // 3. Extract filename & extension from local file
    const parsed = path.parse(filePath);
    const safeFileName = parsed.name.replace(/[^a-zA-Z0-9]/g, "_");
    const finalFileName = `${safeFileName}${parsed.ext}`;

    // 4. Read file
    const fileBuffer = fs.readFileSync(filePath);

    // 5. Headers
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${finalFileName}"`,
    });

    return new Response(fileBuffer, { headers });
  } catch (error) {
    console.error("File download error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
