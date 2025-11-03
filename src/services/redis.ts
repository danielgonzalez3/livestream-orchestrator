import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { getMetricsService } from './metrics';

export class RedisService {
  private client: RedisClientType;
  private subscriber: RedisClientType;
  private publisher: RedisClientType;
  private connected: boolean = false;
  private metrics = getMetricsService();

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
          this.metrics.redisConnected.set(1);
          logger.info('Redis client ready');
        }
      });

      client.on('end', () => {
        this.connected = false;
        this.metrics.redisConnected.set(0);
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
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'publish' });
    try {
      if (this.connected) {
        await this.publisher.publish(channel, message);
        this.metrics.redisOperationsTotal.inc({ operation: 'publish', status: 'success' });
        this.metrics.redisOperationsByType.inc({ operation_type: 'publish' });
      }
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'publish', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'publish' });
      logger.error('Redis publish error', { error, channel });
    } finally {
      timer();
    }
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'subscribe' });
    try {
      await this.subscriber.subscribe(channel, callback);
      this.metrics.redisOperationsTotal.inc({ operation: 'subscribe', status: 'success' });
      this.metrics.redisOperationsByType.inc({ operation_type: 'subscribe' });
      logger.info(`Subscribed to Redis channel: ${channel}`);
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'subscribe', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'subscribe' });
      logger.error('Redis subscribe error', { error, channel });
    } finally {
      timer();
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
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'get' });
    try {
      if (this.connected) {
        const result = await this.client.get(key);
        this.metrics.redisOperationsTotal.inc({ operation: 'get', status: 'success' });
        this.metrics.redisOperationsByType.inc({ operation_type: 'get' });
        timer();
        return result;
      }
      timer();
      return null;
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'get', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'get' });
      timer();
      logger.error('Redis get error', { error, key });
      return null;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'set' });
    try {
      if (this.connected) {
        if (ttl) {
          await this.client.setEx(key, ttl, value);
        } else {
          await this.client.set(key, value);
        }
        this.metrics.redisOperationsTotal.inc({ operation: 'set', status: 'success' });
        this.metrics.redisOperationsByType.inc({ operation_type: 'set' });
      }
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'set', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'set' });
      logger.error('Redis set error', { error, key });
    } finally {
      timer();
    }
  }

  async del(key: string): Promise<void> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'del' });
    try {
      if (this.connected) {
        await this.client.del(key);
        this.metrics.redisOperationsTotal.inc({ operation: 'del', status: 'success' });
        this.metrics.redisOperationsByType.inc({ operation_type: 'del' });
      }
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'del', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'del' });
      logger.error('Redis delete error', { error, key });
    } finally {
      timer();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async acquireLock(key: string, ownerId: string, ttl: number = 10): Promise<boolean> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'acquireLock' });
    try {
      if (!this.connected) {
        timer();
        return false;
      }
      // atomic SET NX EX to avoid race condition between setNX and expire
      const result = await this.client.set(`lock:${key}`, ownerId, {
        NX: true,
        EX: ttl
      });
      const success = result === 'OK';
      this.metrics.redisOperationsTotal.inc({ operation: 'acquireLock', status: success ? 'success' : 'failed' });
      this.metrics.redisOperationsByType.inc({ operation_type: 'acquireLock' });
      timer();
      return success;
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'acquireLock', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'acquireLock' });
      timer();
      logger.error('Redis lock acquire error', { error, key, ownerId });
      return false;
    }
  }

  async releaseLock(key: string, ownerId: string): Promise<void> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'releaseLock' });
    try {
      if (this.connected) {
        // release if we own the lock (value matches ownerId)
        const lockValue = await this.client.get(`lock:${key}`);
        if (lockValue === ownerId) {
          await this.client.del(`lock:${key}`);
          this.metrics.redisOperationsTotal.inc({ operation: 'releaseLock', status: 'success' });
          this.metrics.redisOperationsByType.inc({ operation_type: 'releaseLock' });
        } else {
          logger.warn('Attempted to release lock not owned by this instance', { key, ownerId, lockValue });
          this.metrics.redisOperationsTotal.inc({ operation: 'releaseLock', status: 'failed' });
        }
      }
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'releaseLock', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'releaseLock' });
      logger.error('Redis lock release error', { error, key, ownerId });
    } finally {
      timer();
    }
  }

  async getSet(key: string, value: string): Promise<string | null> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'getSet' });
    try {
      if (this.connected) {
        const result = await this.client.getSet(key, value);
        this.metrics.redisOperationsTotal.inc({ operation: 'getSet', status: 'success' });
        this.metrics.redisOperationsByType.inc({ operation_type: 'getSet' });
        timer();
        return result;
      }
      timer();
      return null;
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'getSet', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'getSet' });
      timer();
      logger.error('Redis getSet error', { error, key });
      return null;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    const timer = this.metrics.redisOperationsDuration.startTimer({ operation: 'keys' });
    try {
      if (this.connected) {
        const result = await this.client.keys(pattern);
        this.metrics.redisOperationsTotal.inc({ operation: 'keys', status: 'success' });
        this.metrics.redisOperationsByType.inc({ operation_type: 'keys' });
        timer();
        return result;
      }
      timer();
      return [];
    } catch (error) {
      this.metrics.redisOperationsTotal.inc({ operation: 'keys', status: 'error' });
      this.metrics.redisOperationsErrors.inc({ operation: 'keys' });
      timer();
      logger.error('Redis keys error', { error, pattern });
      return [];
    }
  }
}

