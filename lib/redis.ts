// lib/redis.ts
import Redis from "ioredis";

class RedisClient {
  private static instance: Redis;
  private static isConnected = false;
  private static connectionAttempts = 0;
  private static maxReconnects = 5;

  static getInstance(): Redis {
    if (!RedisClient.instance) {
      RedisClient.instance = new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        retryStrategy: (times: number) => {
          if (times > this.maxReconnects) {
            console.log("Max reconnection attempts reached");
            return null;
          }
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10000,
        lazyConnect: true,
        // For production with SSL
        tls: process.env.REDIS_SSL === "true" ? {} : undefined,
      });

      this.setupEventListeners();
    }

    return RedisClient.instance;
  }

  private static setupEventListeners() {
    const redis = this.instance;

    redis.on("connect", () => {
      console.log("✅ Redis connected successfully");
      this.isConnected = true;
      this.connectionAttempts = 0;
    });

    redis.on("error", (err: Error) => {
      console.error("❌ Redis error:", err.message);
      this.isConnected = false;
    });

    redis.on("reconnecting", () => {
      this.connectionAttempts++;
      console.log(`🔄 Redis reconnecting... Attempt ${this.connectionAttempts}`);
    });

    redis.on("close", () => {
      console.log("🔌 Redis connection closed");
      this.isConnected = false;
    });

    redis.on("end", () => {
      console.log("🛑 Redis connection ended");
      this.isConnected = false;
    });
  }

  static async testConnection(): Promise<boolean> {
    try {
      const redis = this.getInstance();
      await redis.ping();
      return true;
    } catch (error) {
      console.error("Redis connection test failed:", error);
      return false;
    }
  }

  static async getStatus() {
    return {
      connected: this.isConnected,
      attempts: this.connectionAttempts,
      maxReconnects: this.maxReconnects,
    };
  }

  static async disconnect(): Promise<void> {
    if (this.instance) {
      await this.instance.quit();
      this.isConnected = false;
    }
  }
}

export default RedisClient;