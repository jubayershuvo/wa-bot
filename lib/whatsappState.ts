// lib/whatsappState.ts
import RedisClient from "./redis";
import Redis from "ioredis";

export interface UserState {
  phone: string;
  currentState: string;
  data: Record<string, any>;
  expiresAt: number;
  createdAt: number;
  lastActivity: number;
  flowType: string;
}

export class RedisStateManager {
  private prefix = "whatsapp:state:";
  private defaultTTL = 1800; // 30 minutes in seconds
  private redis: Redis;

  constructor() {
    this.redis = RedisClient.getInstance();
  }

  async getUserState(phone: string): Promise<UserState | null> {
    try {
      const key = `${this.prefix}${phone}`;
      const data = await this.redis.get(key);
      
      if (!data) return null;
      
      const state = JSON.parse(data) as UserState;
      
      // Check if expired
      if (state.expiresAt < Date.now()) {
        await this.clearUserState(phone);
        return null;
      }
      
      // Update last activity
      state.lastActivity = Date.now();
      await this.redis.setex(
        key,
        this.defaultTTL,
        JSON.stringify(state)
      );
      
      return state;
    } catch (error) {
      console.error("Redis get state error:", error);
      return null;
    }
  }

  async setUserState(phone: string, state: Partial<UserState>): Promise<void> {
    try {
      const key = `${this.prefix}${phone}`;
      const existing = await this.getUserState(phone);
      
      const newState: UserState = {
        phone,
        currentState: state.currentState || existing?.currentState || "idle",
        data: { ...existing?.data, ...state.data },
        expiresAt: Date.now() + (this.defaultTTL * 1000),
        createdAt: existing?.createdAt || Date.now(),
        lastActivity: Date.now(),
        flowType: state.flowType || existing?.flowType || "general"
      };
      
      await this.redis.setex(
        key,
        this.defaultTTL,
        JSON.stringify(newState)
      );
      
      // Store in session set for tracking
      await this.redis.sadd("whatsapp:active_sessions", phone);
    } catch (error) {
      console.error("Redis set state error:", error);
    }
  }

  async clearUserState(phone: string): Promise<void> {
    try {
      const key = `${this.prefix}${phone}`;
      await this.redis.del(key);
      await this.redis.srem("whatsapp:active_sessions", phone);
    } catch (error) {
      console.error("Redis clear state error:", error);
    }
  }

  async updateStateData(phone: string, data: Record<string, string | number | boolean | Date | object | Array<unknown>>): Promise<void> {
    const state = await this.getUserState(phone);
    if (state) {
      state.data = { ...state.data, ...data };
      await this.setUserState(phone, state);
    }
  }

  async isStateActive(phone: string, state: string): Promise<boolean> {
    const userState = await this.getUserState(phone);
    return userState?.currentState === state;
  }

  async getAllActiveSessions(): Promise<Array<{phone: string; state: UserState}>> {
    try {
      const phones = await this.redis.smembers("whatsapp:active_sessions");
      const sessions: Array<{phone: string; state: UserState}> = [];
      
      for (const phone of phones) {
        const state = await this.getUserState(phone);
        if (state) {
          sessions.push({ phone, state });
        }
      }
      
      return sessions;
    } catch (error) {
      console.error("Get all sessions error:", error);
      return [];
    }
  }

  async getSessionStats(): Promise<{
    total: number;
    byState: Record<string, number>;
    byFlow: Record<string, number>;
  }> {
    const sessions = await this.getAllActiveSessions();
    const byState: Record<string, number> = {};
    const byFlow: Record<string, number> = {};
    
    sessions.forEach(({ state }) => {
      byState[state.currentState] = (byState[state.currentState] || 0) + 1;
      byFlow[state.flowType] = (byFlow[state.flowType] || 0) + 1;
    });
    
    return {
      total: sessions.length,
      byState,
      byFlow
    };
  }

  async cleanupExpiredSessions(): Promise<number> {
    try {
      const phones = await this.redis.smembers("whatsapp:active_sessions");
      let cleaned = 0;
      
      for (const phone of phones) {
        const state = await this.getUserState(phone);
        if (!state) {
          await this.redis.srem("whatsapp:active_sessions", phone);
          cleaned++;
        }
      }
      
      return cleaned;
    } catch (error) {
      console.error("Cleanup error:", error);
      return 0;
    }
  }

  async getSessionInfo(phone: string) {
    const state = await this.getUserState(phone);
    if (!state) return null;
    
    return {
      state: state.currentState,
      data: state.data,
      createdAt: new Date(state.createdAt),
      lastActivity: new Date(state.lastActivity),
      expiresAt: new Date(state.expiresAt),
      timeLeft: Math.max(0, state.expiresAt - Date.now()),
      flowType: state.flowType
    };
  }
}

// Singleton instance
const stateManager = new RedisStateManager();
export default stateManager;