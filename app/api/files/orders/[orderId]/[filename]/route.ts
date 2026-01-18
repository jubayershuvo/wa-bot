// app/api/files/orders/[orderId]/[filename]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string; filename: string }> }
) {
  try {
    // Await the params promise (required in Next.js 15)
    const { orderId, filename } = await params;
    
    // Security check: Validate filename
    if (!filename.match(/^[a-zA-Z0-9_\-\.]+$/)) {
      return new NextResponse('Invalid filename', { status: 400 });
    }

    // Construct the file path
    const filePath = path.join(
      process.cwd(), 
      'uploads', 
      'orders', 
      filename
    );

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return new NextResponse('File not found', { status: 404 });
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    
    // Read file
    const fileBuffer = fs.readFileSync(filePath);
    
    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    const contentType = getContentType(ext);
    
    // Set headers for download
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Length', stats.size.toString());
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    
    return new NextResponse(fileBuffer, {
      status: 200,
      headers,
    });
    
  } catch (error) {
    console.error('Error serving file:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}

function getContentType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
}