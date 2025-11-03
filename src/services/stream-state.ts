import { v4 as uuidv4 } from 'uuid';
import { Stream, StreamStatus, Participant, StreamEvent } from '../types';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { RedisService } from './redis';

// NOTE: Catch all TTL
const STREAM_EVENTS_CHANNEL = 'stream_events';
const IDEMPOTENCY_TTL = 3600;

export class StreamStateService extends EventEmitter {
  private streams: Map<string, Stream> = new Map();
  private streamEvents: StreamEvent[] = [];
  private readonly MAX_EVENTS = 1000;
  private redisService?: RedisService;
  private instanceId: string;
  private isInitialized: boolean = false;

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

  async createStream(roomName?: string, metadata?: Record<string, any>, idempotencyKey?: string): Promise<Stream> {
    // check idempotency key if provided
    if (idempotencyKey && this.redisService && this.isInitialized) {
      const existingId = await this.redisService.get(`idempotency:stream:${idempotencyKey}`);
      if (existingId) {
        const existing = this.getStream(existingId);
        if (existing) {
          logger.info('Stream created via idempotency key', { idempotencyKey, streamId: existingId });
          return existing;
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

    this.streams.set(streamId, stream);
    
    // store idempotency key mapping if provided
    if (idempotencyKey && this.redisService && this.isInitialized) {
      await this.redisService.set(`idempotency:stream:${idempotencyKey}`, streamId, IDEMPOTENCY_TTL);
    }
    
    this.emitStreamEvent('stream_created', streamId, stream);
    logger.info(`Created stream: ${streamId}`, { streamId, roomName: stream.roomName });

    return stream;
  }

  getStream(streamId: string): Stream | undefined {
    return this.streams.get(streamId);
  }

  getStreamByRoomName(roomName: string): Stream | undefined {
    for (const stream of this.streams.values()) {
      if (stream.roomName === roomName) {
        return stream;
      }
    }
    return undefined;
  }

  getAllStreams(): Stream[] {
    return Array.from(this.streams.values());
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
      const stream = this.streams.get(streamId);
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

      this.streams.set(streamId, stream);
      this.emitStreamEvent('stream_updated', streamId, { ...stream, previousStatus: oldStatus });
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
      const stream = this.streams.get(streamId);
      if (!stream) {
        logger.warn(`Attempted to update metadata for non-existent stream: ${streamId}`);
        return null;
      }

      stream.metadata = { ...stream.metadata, ...metadata };
      stream.updatedAt = new Date();
      if (stream.version !== undefined) {
        stream.version = (stream.version || 0) + 1;
      }
      this.streams.set(streamId, stream);
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
      const stream = this.streams.get(streamId);
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
          this.streams.set(streamId, stream);
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
      this.streams.set(streamId, stream);
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
      const stream = this.streams.get(streamId);
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
        this.streams.set(streamId, stream);
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

  deleteStream(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return false;
    }

    this.streams.delete(streamId);
    this.emitStreamEvent('stream_stopped', streamId, stream);
    logger.info(`Deleted stream: ${streamId}`, { streamId });
    return true;
  }

  // NOTE: only used for testing, storage is in memory
  getStreamEvents(streamId?: string, limit: number = 100): StreamEvent[] {
    let events = this.streamEvents;
    if (streamId) {
      events = events.filter(e => e.streamId === streamId);
    }
    return events.slice(-limit);
  }

  private emitStreamEvent(type: StreamEvent['type'], streamId: string, data: any): void {
    const event: StreamEvent = {
      type,
      streamId,
      data,
      timestamp: new Date(),
      instanceId: this.instanceId
    };

    this.streamEvents.push(event);
    if (this.streamEvents.length > this.MAX_EVENTS) {
      this.streamEvents = this.streamEvents.slice(-this.MAX_EVENTS);
    }

    this.emit('stream_event', event);

    if (this.redisService && this.isInitialized) {
      this.redisService.publish(STREAM_EVENTS_CHANNEL, JSON.stringify(event)).catch(error => {
        logger.error('Failed to publish event to Redis', { error, eventType: type });
      });
    }
  }

  onStreamEvent(callback: (event: StreamEvent) => void): () => void {
    this.on('stream_event', callback);
    return () => this.off('stream_event', callback);
  }
}

