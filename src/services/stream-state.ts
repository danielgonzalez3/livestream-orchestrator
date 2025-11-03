import { v4 as uuidv4 } from 'uuid';
import { Stream, StreamStatus, Participant, StreamEvent } from '../types';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { RedisService } from './redis';

// NOTE: Catch all TTL
const STREAM_EVENTS_CHANNEL = 'stream_events';
const IDEMPOTENCY_TTL = 30;

export class StreamStateService extends EventEmitter {
  private streamEvents: StreamEvent[] = [];
  private readonly MAX_EVENTS = 1000;
  private redisService?: RedisService;
  private instanceId: string;
  private isInitialized: boolean = false;
  private readonly STREAM_KEY_PREFIX = 'stream:';

  constructor(redisService?: RedisService) {
    super();
    this.redisService = redisService;
    this.instanceId = uuidv4();
    this.initializeRedis();
  }

  private async initializeRedis(): Promise<void> {
    if (!this.redisService) {
      this.isInitialized = true;
      return;
    }

    try {
      if (!this.redisService.isConnected()) {
        await this.redisService.connect();
      }

      await this.redisService.subscribe(STREAM_EVENTS_CHANNEL, (message) => {
        try {
          const event: StreamEvent & { instanceId?: string } = JSON.parse(message);
          if (event.instanceId !== this.instanceId) {
            this.emit('stream_event', event);
            logger.info('Received event from Redis', { eventType: event.type, streamId: event.streamId });
          }
        } catch (error) {
          logger.error('Failed to parse Redis message', { error, message });
        }
      });

      this.isInitialized = true;
      logger.info('StreamStateService initialized with Redis');
    } catch (error) {
      logger.error('Failed to initialize Redis', { error });
      this.isInitialized = true;
    }
  }

  private serializeStream(stream: Stream): string {
    return JSON.stringify(stream);
  }

  private deserializeStream(json: string): Stream {
    const parsed = JSON.parse(json);
    // convert date strings back to Date objects
    if (parsed.createdAt) parsed.createdAt = new Date(parsed.createdAt);
    if (parsed.updatedAt) parsed.updatedAt = new Date(parsed.updatedAt);
    if (parsed.stoppedAt) parsed.stoppedAt = new Date(parsed.stoppedAt);
    if (parsed.participants) {
      parsed.participants = parsed.participants.map((p: any) => ({
        ...p,
        joinedAt: p.joinedAt ? new Date(p.joinedAt) : undefined,
        leftAt: p.leftAt ? new Date(p.leftAt) : undefined
      }));
    }
    return parsed as Stream;
  }

  private async saveStream(stream: Stream): Promise<void> {
    if (!this.redisService || !this.isInitialized) {
      throw new Error('Redis not available - streams require Redis');
    }
    await this.redisService.set(`${this.STREAM_KEY_PREFIX}${stream.id}`, this.serializeStream(stream));
  }

  private async loadStream(streamId: string): Promise<Stream | null> {
    if (!this.redisService || !this.isInitialized) {
      return null;
    }
    const json = await this.redisService.get(`${this.STREAM_KEY_PREFIX}${streamId}`);
    if (!json) {
      return null;
    }
    try {
      return this.deserializeStream(json);
    } catch (error) {
      logger.error('Failed to deserialize stream', { error, streamId });
      return null;
    }
  }

  async createStream(roomName?: string, metadata?: Record<string, any>, idempotencyKey?: string): Promise<Stream> {
    // check idempotency key if provided
    if (idempotencyKey && this.redisService && this.isInitialized) {
      const existingId = await this.redisService.get(`idempotency:stream:${idempotencyKey}`);
      if (existingId) {
        const existing = await this.getStream(existingId);
        if (existing) {
          logger.info('Stream created via idempotency key', { idempotencyKey, streamId: existingId });
          return existing;
        } else {
          logger.warn('Stream not found for idempotency key', { idempotencyKey, existingId });
        }
      }
    }

    const streamId = uuidv4();
    const stream: Stream = {
      id: streamId,
      roomName: roomName || `room-${streamId}`,
      status: StreamStatus.CREATING,
      createdAt: new Date(),
      updatedAt: new Date(),
      participants: [],
      metadata,
      version: 1
    };

    await this.saveStream(stream);
    
    // store idempotency key mapping if provided
    if (idempotencyKey && this.redisService && this.isInitialized) {
      await this.redisService.set(`idempotency:stream:${idempotencyKey}`, streamId, IDEMPOTENCY_TTL);
    }
    
    this.emitStreamEvent('stream_created', streamId, stream);
    logger.info(`Created stream: ${streamId}`, { streamId, roomName: stream.roomName });

    return stream;
  }

  async getStream(streamId: string): Promise<Stream | undefined> {
    const stream = await this.loadStream(streamId);
    return stream || undefined;
  }

  async getAllStreams(): Promise<Stream[]> {
    if (!this.redisService || !this.isInitialized) {
      return [];
    }
    try {
      // get all stream keys
      const keys = await this.redisService.keys(`${this.STREAM_KEY_PREFIX}*`);
      const streams: Stream[] = [];
      for (const key of keys) {
        const json = await this.redisService.get(key);
        if (json) {
          try {
            streams.push(this.deserializeStream(json));
          } catch (error) {
            logger.error('Failed to deserialize stream', { error, key });
          }
        }
      }
      return streams;
    } catch (error) {
      logger.error('Failed to get all streams from Redis', { error });
      return [];
    }
  }

  async updateStreamStatus(streamId: string, status: StreamStatus, expectedVersion?: number): Promise<Stream | null> {
    const lockKey = `stream:update:${streamId}`;
    let locked = false;

    if (this.redisService && this.isInitialized) {
      locked = await this.redisService.acquireLock(lockKey, this.instanceId, 5);
      if (!locked) {
        logger.warn(`Failed to acquire lock for stream update: ${streamId}`);
        return null;
      }
    }

    try {
      const stream = await this.loadStream(streamId);
      if (!stream) {
        logger.warn(`Attempted to update non-existent stream: ${streamId}`);
        return null;
      }

      // locking check
      if (expectedVersion !== undefined && stream.version !== undefined && stream.version !== expectedVersion) {
        logger.warn(`Stream version mismatch: ${streamId}`, { 
          expected: expectedVersion, 
          actual: stream.version 
        });
        return null;
      }

      const oldStatus = stream.status;
      stream.status = status;
      stream.updatedAt = new Date();
      if (stream.version !== undefined) {
        stream.version = (stream.version || 0) + 1;
      }

      if (status === StreamStatus.STOPPED) {
        stream.stoppedAt = new Date();
      }

      await this.saveStream(stream);
      
      // emit stream_stopped event when status changes to stopped
      if (status === StreamStatus.STOPPED) {
        this.emitStreamEvent('stream_stopped', streamId, { ...stream, previousStatus: oldStatus });
      } else {
        this.emitStreamEvent('stream_updated', streamId, { ...stream, previousStatus: oldStatus });
      }
      
      logger.info(`Updated stream status: ${streamId}`, { streamId, oldStatus, newStatus: status });

      return stream;
    } finally {
      if (locked && this.redisService && this.isInitialized) {
        await this.redisService.releaseLock(lockKey, this.instanceId);
      }
    }
  }

  async updateStreamMetadata(streamId: string, metadata: Record<string, any>): Promise<Stream | null> {
    const lockKey = `stream:update:${streamId}`;
    let locked = false;

    if (this.redisService && this.isInitialized) {
      locked = await this.redisService.acquireLock(lockKey, this.instanceId, 5);
      if (!locked) {
        logger.warn(`Failed to acquire lock for metadata update: ${streamId}`);
        return null;
      }
    }

    try {
      const stream = await this.loadStream(streamId);
      if (!stream) {
        logger.warn(`Attempted to update metadata for non-existent stream: ${streamId}`);
        return null;
      }

      stream.metadata = { ...stream.metadata, ...metadata };
      stream.updatedAt = new Date();
      if (stream.version !== undefined) {
        stream.version = (stream.version || 0) + 1;
      }
      await this.saveStream(stream);
      this.emitStreamEvent('stream_updated', streamId, stream);

      return stream;
    } finally {
      if (locked && this.redisService && this.isInitialized) {
        await this.redisService.releaseLock(lockKey, this.instanceId);
      }
    }
  }

  async addParticipant(streamId: string, participant: Participant): Promise<Stream | null> {
    const lockKey = `stream:participant:${streamId}:${participant.id}`;
    let locked = false;

    if (this.redisService && this.isInitialized) {
      locked = await this.redisService.acquireLock(lockKey, this.instanceId, 5);
      if (!locked) {
        logger.info(`Failed to acquire lock for participant add: ${streamId}:${participant.id}`);
      }
    }

    try {
      const stream = await this.loadStream(streamId);
      if (!stream) {
        logger.warn(`Attempted to add participant to non-existent stream: ${streamId}`);
        return null;
      }

      const existingIndex = stream.participants.findIndex(p => p.id === participant.id);
      
      // if participant already exists and hasn't left, just update metadata
      if (existingIndex >= 0) {
        const existing = stream.participants[existingIndex];
        if (!existing.leftAt) {
          // participant already active, update metadata if provided
          stream.participants[existingIndex] = { 
            ...existing, 
            ...participant,
            joinedAt: existing.joinedAt // preserve original join time
          };
          stream.updatedAt = new Date();
          if (stream.version !== undefined) {
            stream.version = (stream.version || 0) + 1;
          }
          await this.saveStream(stream);
          logger.info(`Participant already in stream (idempotent): ${streamId}`, { 
            streamId, 
            participantId: participant.id 
          });
          return stream; // return existing state
        } else {
          // participant previously left, re-join them
          stream.participants[existingIndex] = {
            ...participant,
            joinedAt: new Date() // new join time
          };
        }
      } else {
        stream.participants.push(participant);
      }

      stream.updatedAt = new Date();
      if (stream.version !== undefined) {
        stream.version = (stream.version || 0) + 1;
      }
      await this.saveStream(stream);
      this.emitStreamEvent('participant_joined', streamId, { participant, stream });
      logger.info(`Added participant to stream: ${streamId}`, { streamId, participantId: participant.id });

      return stream;
    } finally {
      if (locked && this.redisService && this.isInitialized) {
        await this.redisService.releaseLock(lockKey, this.instanceId);
      }
    }
  }

  async removeParticipant(streamId: string, participantId: string): Promise<Stream | null> {
    const lockKey = `stream:participant:${streamId}:${participantId}`;
    let locked = false;

    if (this.redisService && this.isInitialized) {
      locked = await this.redisService.acquireLock(lockKey, this.instanceId, 5);
      if (!locked) {
        logger.info(`Failed to acquire lock for participant remove: ${streamId}:${participantId}`);
      }
    }

    try {
      const stream = await this.loadStream(streamId);
      if (!stream) {
        logger.warn(`Attempted to remove participant from non-existent stream: ${streamId}`);
        return null;
      }

      const participantIndex = stream.participants.findIndex(p => p.id === participantId);
      if (participantIndex >= 0) {
        const participant = stream.participants[participantIndex];
        
        // Idempotent: if already left, do nothing
        if (participant.leftAt) {
          logger.info(`Participant already left (idempotent): ${streamId}`, { 
            streamId, 
            participantId 
          });
          return stream;
        }

        participant.leftAt = new Date();
        stream.participants[participantIndex] = participant;
        stream.updatedAt = new Date();
        if (stream.version !== undefined) {
          stream.version = (stream.version || 0) + 1;
        }
        await this.saveStream(stream);
        this.emitStreamEvent('participant_left', streamId, { participant, stream });
        logger.info(`Removed participant from stream: ${streamId}`, { streamId, participantId });
      }

      return stream;
    } finally {
      if (locked && this.redisService && this.isInitialized) {
        await this.redisService.releaseLock(lockKey, this.instanceId);
      }
    }
  }

  async deleteStream(streamId: string): Promise<boolean> {
    if (!this.redisService || !this.isInitialized) {
      return false;
    }
    const stream = await this.loadStream(streamId);
    if (!stream) {
      return false;
    }

    await this.redisService.del(`${this.STREAM_KEY_PREFIX}${streamId}`);
    this.emitStreamEvent('stream_stopped', streamId, stream);
    logger.info(`Deleted stream: ${streamId}`, { streamId });
    return true;
  }

  private emitStreamEvent(type: StreamEvent['type'], streamId: string, data: any): void {
    const event: StreamEvent = {
      type,
      streamId,
      data,
      timestamp: new Date(),
      instanceId: this.instanceId
    };

    // store in memory for fast access
    this.streamEvents.push(event);
    if (this.streamEvents.length > this.MAX_EVENTS) {
      this.streamEvents = this.streamEvents.slice(-this.MAX_EVENTS);
    }

    // publish to Redis for cross-instance event distribution
    if (this.redisService && this.isInitialized) {
      const eventJson = JSON.stringify(event);
      this.redisService.publish(STREAM_EVENTS_CHANNEL, eventJson).catch(error => {
        logger.error('Failed to publish event to Redis', { error, eventType: type });
      });
    }

    this.emit('stream_event', event);
  }

  onStreamEvent(callback: (event: StreamEvent) => void): () => void {
    this.on('stream_event', callback);
    return () => this.off('stream_event', callback);
  }
}

