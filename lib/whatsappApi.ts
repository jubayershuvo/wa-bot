// lib/whatsappApi.ts
export async function sendMessage(to: string, text: string): Promise<void> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: text },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("WhatsApp API error:", error);
    }
  } catch (error) {
    console.error("Failed to send WhatsApp message:", error);
  }
}

export async function sendButtons(
  to: string,
  text: string,
  buttons: Array<{ type: string; reply: { id: string; title: string } }>
): Promise<void> {
  try {
    // Truncate text if too long
    const truncatedText = text.length > 1024 ? text.substring(0, 1021) + "..." : text;
    
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: truncatedText },
            action: {
              buttons: buttons.slice(0, 3), // WhatsApp allows max 3 buttons
            },
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("WhatsApp buttons error:", error);
      // Fallback to regular message
      await sendMessage(to, truncatedText);
    }
  } catch (error) {
    console.error("Failed to send WhatsApp buttons:", error);
    await sendMessage(to, text.substring(0, 4096)); // Truncate for fallback
  }
}

export async function sendList(
  to: string,
  header: string,
  body: string,
  buttonText: string,
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>
): Promise<void> {
  try {
    // WhatsApp API has character limits
    const truncatedHeader = header.length > 60 ? header.substring(0, 57) + "..." : header;
    const truncatedBody = body.length > 1024 ? body.substring(0, 1021) + "..." : body;
    const truncatedButtonText = buttonText.length > 20 ? buttonText.substring(0, 17) + "..." : buttonText;

    // Truncate section titles and rows
    const truncatedSections = sections.slice(0, 10).map(section => ({
      title: section.title.length > 24 ? section.title.substring(0, 21) + "..." : section.title,
      rows: section.rows.slice(0, 10).map(row => ({
        id: row.id.length > 200 ? row.id.substring(0, 197) + "..." : row.id,
        title: row.title.length > 24 ? row.title.substring(0, 21) + "..." : row.title,
        description: row.description && row.description.length > 72 
          ? row.description.substring(0, 69) + "..." 
          : row.description,
      })),
    }));

    const response = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "list",
            header: { 
              type: "text", 
              text: truncatedHeader 
            },
            body: { 
              text: truncatedBody 
            },
            footer: { 
              text: "Select an option" 
            },
            action: {
              button: truncatedButtonText,
              sections: truncatedSections,
            },
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("WhatsApp list error:", error);
      
      // Fallback to text message
      let fallbackText = `${header}\n\n${body}\n\n`;
      sections.forEach((section, sectionIndex) => {
        fallbackText += `*${section.title}:*\n`;
        section.rows.forEach((row, rowIndex) => {
          const globalIndex = (sectionIndex * 10) + rowIndex + 1;
          fallbackText += `${globalIndex}. ${row.title}\n`;
          if (row.description) {
            fallbackText += `   ${row.description}\n`;
          }
        });
        fallbackText += "\n";
      });
      fallbackText += "\nReply with the service number (e.g., '1') to select.";
      
      await sendMessage(to, fallbackText);
      
      throw new Error("WhatsApp list failed, fell back to text");
    }
  } catch (error) {
    console.error("Failed to send WhatsApp list:", error);
    throw error; // Re-throw so calling function knows list failed
  }
}

export async function sendQuickReply(
  to: string,
  text: string,
  quickReplies: string[]
): Promise<void> {
  try {
    const truncatedText = text.length > 1024 ? text.substring(0, 1021) + "..." : text;
    
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: truncatedText },
            action: {
              buttons: quickReplies.slice(0, 3).map((reply, index) => ({
                type: "reply",
                reply: {
                  id: `qr_${index}`,
                  title: reply.length > 20 ? reply.substring(0, 17) + "..." : reply,
                },
              })),
            },
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("WhatsApp quick reply error:", error);
      // Fallback to regular message
      await sendMessage(to, truncatedText);
    }
  } catch (error) {
    console.error("Failed to send WhatsApp quick reply:", error);
    await sendMessage(to, text);
  }
}