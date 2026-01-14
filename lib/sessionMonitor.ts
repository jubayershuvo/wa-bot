// lib/sessionMonitor.ts

import { sendMessage } from "./whatsappApi";
import stateManager from "./whatsappState";

interface UserState {
  currentState: string;
  lastActivity: number;
  expiresAt: number;
  lastReminderSent?: number;
}

export class SessionMonitor {
  private checkInterval = 60000; // 1 minute
  private timeoutThreshold = 15 * 60 * 1000; // 15 minutes
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.intervalId = setInterval(() => this.checkSessions(), this.checkInterval);
    
    console.log("🔄 Session monitor started");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("🛑 Session monitor stopped");
  }

  private async checkSessions() {
    try {
      const sessions = await stateManager.getAllActiveSessions();
      const now = Date.now();
      
      for (const { phone, state } of sessions) {
        const inactiveTime = now - state.lastActivity;
        
        // If session inactive for too long, send reminder
        if (inactiveTime > this.timeoutThreshold / 2 && inactiveTime < this.timeoutThreshold) {
          await this.sendReminder(phone, state);
        }
        
        // If session expired, clear it
        if (now > state.expiresAt) {
          await this.expireSession(phone, state);
        }
      }
      
      // Cleanup orphaned sessions
      await stateManager.cleanupExpiredSessions();
      
    } catch (error) {
      console.error("Session check error:", error);
    }
  }

  private async sendReminder(phone: string, state: UserState) {
    try {
      let message = "";
      
      switch (state.currentState) {
        case "awaiting_trx_id":
          message = `⏰ *Session Reminder*\n\nYou were in the middle of a recharge.\nPlease send: \`trxid YOUR_TRANSACTION_ID\`\n\nOr type \`cancel\` to exit.`;
          break;
        case "awaiting_amount":
          message = `⏰ *Session Reminder*\n\nPlease enter the recharge amount.\nExample: \`500\`\n\nOr type \`cancel\` to exit.`;
          break;
        default:
          return;
      }
      
      await sendMessage(phone, message);
      
      // Update last activity to avoid spam
      await stateManager.updateStateData(phone, {
        lastReminderSent: Date.now()
      });
      
    } catch (error) {
      console.error("Reminder send error:", error);
    }
  }

  private async expireSession(phone: string, state: UserState) {
    try {
      let message = "";
      
      switch (state.currentState) {
        case "awaiting_trx_id":
          message = "⏰ *Session Expired*\n\nYour recharge session has expired. Please start again.";
          break;
        case "awaiting_amount":
          message = "⏰ *Session Expired*\n\nYour session has expired. Please start again.";
          break;
        default:
          message = "⏰ *Session Expired*\n\nYour previous session has expired.";
      }
      
      await sendMessage(phone, `${message}\n\nType \`menu\` for main menu.`);
      await stateManager.clearUserState(phone);
      
    } catch (error) {
      console.error("Expire session error:", error);
    }
  }

  async getStats() {
    return await stateManager.getSessionStats();
  }
}

export const sessionMonitor = new SessionMonitor();