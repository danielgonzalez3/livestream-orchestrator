import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export class RedisService {
  private client: RedisClientType;
  private subscriber: RedisClientType;
  private publisher: RedisClientType;
  private connected: boolean = false;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.subscriber = createClient({ url: redisUrl });
    this.publisher = createClient({ url: redisUrl });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    [this.client, this.subscriber, this.publisher].forEach(client => {
      client.on('error', (err: Error) => {
        logger.error('Redis client error', { error: err });
        this.connected = false;
      });

      client.on('connect', () => {
        logger.info('Redis client connecting...');
      });

      client.on('ready', () => {
        if (!this.connected) {
          this.connected = true;
          logger.info('Redis client ready');
        }
      });

      client.on('end', () => {
        this.connected = false;
        logger.info('Redis client connection ended');
      });
    });
  }

  async connect(): Promise<void> {
    try {
      await Promise.all([
        this.client.connect(),
        this.subscriber.connect(),
        this.publisher.connect()
      ]);
      logger.info('All Redis clients connected');
    } catch (error) {
      logger.error('Failed to connect Redis clients', { error });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await Promise.all([
        this.client.quit(),
        this.subscriber.quit(),
        this.publisher.quit()
      ]);
      logger.info('All Redis clients disconnected');
    } catch (error) {
      logger.error('Error disconnecting Redis clients', { error });
    }
  }

  async publish(channel: string, message: string): Promise<void> {
    try {
      if (this.connected) {
        await this.publisher.publish(channel, message);
      }
    } catch (error) {
      logger.error('Redis publish error', { error, channel });
    }
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    try {
      await this.subscriber.subscribe(channel, callback);
      logger.info(`Subscribed to Redis channel: ${channel}`);
    } catch (error) {
      logger.error('Redis subscribe error', { error, channel });
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    try {
      await this.subscriber.unsubscribe(channel);
      logger.info(`Unsubscribed from Redis channel: ${channel}`);
    } catch (error) {
      logger.error('Redis unsubscribe error', { error, channel });
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      if (this.connected) {
        return await this.client.get(key);
      }
      return null;
    } catch (error) {
      logger.error('Redis get error', { error, key });
      return null;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      if (this.connected) {
        if (ttl) {
          await this.client.setEx(key, ttl, value);
        } else {
          await this.client.set(key, value);
        }
      }
    } catch (error) {
      logger.error('Redis set error', { error, key });
    }
  }

  async del(key: string): Promise<void> {
    try {
      if (this.connected) {
        await this.client.del(key);
      }
    } catch (error) {
      logger.error('Redis delete error', { error, key });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async acquireLock(key: string, ownerId: string, ttl: number = 10): Promise<boolean> {
    try {
      if (!this.connected) {
        return false;
      }
      // atomic SET NX EX to avoid race condition between setNX and expire
      const result = await this.client.set(`lock:${key}`, ownerId, {
        NX: true,
        EX: ttl
      });
      return result === 'OK';
    } catch (error) {
      logger.error('Redis lock acquire error', { error, key, ownerId });
      return false;
    }
  }

  async releaseLock(key: string, ownerId: string): Promise<void> {
    try {
      if (this.connected) {
        // release if we own the lock (value matches ownerId)
        const lockValue = await this.client.get(`lock:${key}`);
        if (lockValue === ownerId) {
          await this.client.del(`lock:${key}`);
        } else {
          logger.warn('Attempted to release lock not owned by this instance', { key, ownerId, lockValue });
        }
      }
    } catch (error) {
      logger.error('Redis lock release error', { error, key, ownerId });
    }
  }

  async getSet(key: string, value: string): Promise<string | null> {
    try {
      if (this.connected) {
        return await this.client.getSet(key, value);
      }
      return null;
    } catch (error) {
      logger.error('Redis getSet error', { error, key });
      return null;
    }
  }
}

