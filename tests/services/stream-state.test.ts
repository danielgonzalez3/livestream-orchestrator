import { StreamStateService } from '../../src/services/stream-state';
import { RedisService } from '../../src/services/redis';
import { StreamStatus, Participant } from '../../src/types';

// Mock RedisService
class MockRedisService implements Partial<RedisService> {
  private data: Map<string, string> = new Map();
  private locks: Map<string, string> = new Map();
  private subscribers: Map<string, ((message: string) => void)[]> = new Map();
  connected: boolean = true;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, _ttl?: number): Promise<void> {
    this.data.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async acquireLock(key: string, value: string, _ttl: number): Promise<boolean> {
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.set(key, value);
    return true;
  }

  async releaseLock(key: string, value: string): Promise<void> {
    if (this.locks.get(key) === value) {
      this.locks.delete(key);
    }
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)!.push(callback);
  }

  async publish(channel: string, message: string): Promise<void> {
    const callbacks = this.subscribers.get(channel) || [];
    callbacks.forEach(cb => cb(message));
  }
}

describe('StreamStateService', () => {
  let service: StreamStateService;
  let mockRedis: MockRedisService;

  beforeEach(async () => {
    mockRedis = new MockRedisService();
    service = new StreamStateService(mockRedis as any);
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createStream', () => {
    it('should create a new stream', async () => {
      const stream = await service.createStream('test-room', { title: 'Test' });

      expect(stream.id).toBeDefined();
      expect(stream.roomName).toBe('test-room');
      expect(stream.status).toBe(StreamStatus.CREATING);
      expect(stream.metadata).toEqual({ title: 'Test' });
      expect(stream.version).toBe(1);
      expect(stream.participants).toEqual([]);
    });

    it('should generate room name if not provided', async () => {
      const stream = await service.createStream();

      expect(stream.roomName).toContain('room-');
      expect(stream.id).toBeDefined();
    });

    it('should handle idempotency key', async () => {
      const idempotencyKey = 'test-key-123';
      const stream1 = await service.createStream('test-room', {}, idempotencyKey);
      const stream2 = await service.createStream('test-room', {}, idempotencyKey);

      expect(stream1.id).toBe(stream2.id);
    });

    it('should emit stream_created event', (done) => {
      service.on('stream_event', (event) => {
        if (event.type === 'stream_created') {
          expect(event.streamId).toBeDefined();
          expect(event.data).toBeDefined();
          done();
        }
      });

      service.createStream('test-room');
    });
  });

  describe('getStream', () => {
    it('should return stream by id', async () => {
      const created = await service.createStream('test-room');
      const retrieved = await service.getStream(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.roomName).toBe('test-room');
    });

    it('should return undefined for non-existent stream', async () => {
      const retrieved = await service.getStream('non-existent-id');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAllStreams', () => {
    it('should return all streams', async () => {
      const stream1 = await service.createStream('room-1');
      const stream2 = await service.createStream('room-2');

      const streams = await service.getAllStreams();

      expect(streams.length).toBeGreaterThanOrEqual(2);
      expect(streams.find(s => s.id === stream1.id)).toBeDefined();
      expect(streams.find(s => s.id === stream2.id)).toBeDefined();
    });

    it('should return empty array when no streams exist', async () => {
      const streams = await service.getAllStreams();
      expect(streams).toEqual([]);
    });
  });

  describe('updateStreamStatus', () => {
    it('should update stream status', async () => {
      const stream = await service.createStream('test-room');
      const updated = await service.updateStreamStatus(stream.id, StreamStatus.ACTIVE);

      expect(updated).toBeDefined();
      expect(updated?.status).toBe(StreamStatus.ACTIVE);
      expect(updated?.version).toBe(2);
    });

    it('should set stoppedAt when status is STOPPED', async () => {
      const stream = await service.createStream('test-room');
      const updated = await service.updateStreamStatus(stream.id, StreamStatus.STOPPED);

      expect(updated?.stoppedAt).toBeDefined();
      expect(updated?.status).toBe(StreamStatus.STOPPED);
    });

    it('should emit stream_stopped event when status changes to STOPPED', (done) => {
      service.createStream('test-room').then((stream) => {
        service.on('stream_event', (event) => {
          if (event.type === 'stream_stopped') {
            expect(event.streamId).toBe(stream.id);
            done();
          }
        });

        service.updateStreamStatus(stream.id, StreamStatus.STOPPED);
      });
    });

    it('should emit stream_updated event for other status changes', (done) => {
      service.createStream('test-room').then((stream) => {
        service.on('stream_event', (event) => {
          if (event.type === 'stream_updated' && event.streamId === stream.id) {
            expect(event.data.status).toBe(StreamStatus.ACTIVE);
            done();
          }
        });

        service.updateStreamStatus(stream.id, StreamStatus.ACTIVE);
      });
    });

    it('should reject update if version mismatch', async () => {
      const stream = await service.createStream('test-room');
      const result = await service.updateStreamStatus(stream.id, StreamStatus.ACTIVE, 999);

      expect(result).toBeNull();
    });

    it('should accept update if version matches', async () => {
      const stream = await service.createStream('test-room');
      const updated = await service.updateStreamStatus(stream.id, StreamStatus.ACTIVE, 1);

      expect(updated).toBeDefined();
      expect(updated?.status).toBe(StreamStatus.ACTIVE);
    });

    it('should return null for non-existent stream', async () => {
      const result = await service.updateStreamStatus('non-existent', StreamStatus.ACTIVE);

      expect(result).toBeNull();
    });
  });

  describe('updateStreamMetadata', () => {
    it('should update stream metadata', async () => {
      const stream = await service.createStream('test-room', { title: 'Old' });
      const updated = await service.updateStreamMetadata(stream.id, { title: 'New', description: 'Test' });

      expect(updated?.metadata).toEqual({ title: 'New', description: 'Test' });
      expect(updated?.version).toBe(2);
    });

    it('should merge with existing metadata', async () => {
      const stream = await service.createStream('test-room', { title: 'Old' });
      const updated = await service.updateStreamMetadata(stream.id, { description: 'New' });

      expect(updated?.metadata).toEqual({ title: 'Old', description: 'New' });
    });

    it('should emit stream_updated event', (done) => {
      service.createStream('test-room').then((stream) => {
        service.on('stream_event', (event) => {
          if (event.type === 'stream_updated' && event.streamId === stream.id) {
            expect(event.data.metadata).toBeDefined();
            done();
          }
        });

        service.updateStreamMetadata(stream.id, { title: 'New' });
      });
    });

    it('should return null for non-existent stream', async () => {
      const result = await service.updateStreamMetadata('non-existent', { title: 'New' });

      expect(result).toBeNull();
    });
  });

  describe('addParticipant', () => {
    it('should add participant to stream', async () => {
      const stream = await service.createStream('test-room');
      const participant: Participant = {
        id: 'participant-1',
        identity: 'user-1',
        joinedAt: new Date(),
        metadata: { role: 'viewer' }
      };

      const updated = await service.addParticipant(stream.id, participant);

      expect(updated?.participants.length).toBe(1);
      expect(updated?.participants[0].id).toBe('participant-1');
      expect(updated?.version).toBe(2);
    });

    it('should be idempotent - update existing participant', async () => {
      const stream = await service.createStream('test-room');
      const participant: Participant = {
        id: 'participant-1',
        identity: 'user-1',
        joinedAt: new Date()
      };

      await service.addParticipant(stream.id, participant);
      const updated = await service.addParticipant(stream.id, { ...participant, metadata: { role: 'viewer' } });

      expect(updated?.participants.length).toBe(1);
      expect(updated?.participants[0].metadata?.role).toBe('viewer');
    });

    it('should allow re-joining after leaving', async () => {
      const stream = await service.createStream('test-room');
      const participant: Participant = {
        id: 'participant-1',
        identity: 'user-1',
        joinedAt: new Date()
      };

      await service.addParticipant(stream.id, participant);
      await service.removeParticipant(stream.id, participant.id);
      
      const updated = await service.addParticipant(stream.id, participant);

      expect(updated?.participants.length).toBe(1);
      expect(updated?.participants[0].leftAt).toBeUndefined();
    });

    it('should emit participant_joined event', (done) => {
      service.createStream('test-room').then((stream) => {
        service.on('stream_event', (event) => {
          if (event.type === 'participant_joined') {
            expect(event.streamId).toBe(stream.id);
            expect(event.data.participant).toBeDefined();
            done();
          }
        });

        const participant: Participant = {
          id: 'participant-1',
          identity: 'user-1',
          joinedAt: new Date()
        };
        service.addParticipant(stream.id, participant);
      });
    });

    it('should return null for non-existent stream', async () => {
      const participant: Participant = {
        id: 'participant-1',
        identity: 'user-1',
        joinedAt: new Date()
      };

      const result = await service.addParticipant('non-existent', participant);

      expect(result).toBeNull();
    });
  });

  describe('removeParticipant', () => {
    it('should remove participant from stream', async () => {
      const stream = await service.createStream('test-room');
      const participant: Participant = {
        id: 'participant-1',
        identity: 'user-1',
        joinedAt: new Date()
      };

      await service.addParticipant(stream.id, participant);
      const updated = await service.removeParticipant(stream.id, participant.id);

      expect(updated?.participants[0].leftAt).toBeDefined();
      expect(updated?.version).toBe(3);
    });

    it('should be idempotent - do nothing if already left', async () => {
      const stream = await service.createStream('test-room');
      const participant: Participant = {
        id: 'participant-1',
        identity: 'user-1',
        joinedAt: new Date()
      };

      await service.addParticipant(stream.id, participant);
      await service.removeParticipant(stream.id, participant.id);
      const beforeVersion = (await service.getStream(stream.id))!.version!;
      
      await service.removeParticipant(stream.id, participant.id);
      const afterVersion = (await service.getStream(stream.id))!.version!;

      expect(afterVersion).toBe(beforeVersion);
    });

    it('should emit participant_left event', (done) => {
      service.createStream('test-room').then(async (stream) => {
        const participant: Participant = {
          id: 'participant-1',
          identity: 'user-1',
          joinedAt: new Date()
        };
        await service.addParticipant(stream.id, participant);

        service.on('stream_event', (event) => {
          if (event.type === 'participant_left') {
            expect(event.streamId).toBe(stream.id);
            expect(event.data.participant.id).toBe(participant.id);
            done();
          }
        });

        await service.removeParticipant(stream.id, participant.id);
      });
    });

    it('should return null for non-existent stream', async () => {
      const result = await service.removeParticipant('non-existent', 'participant-1');

      expect(result).toBeNull();
    });
  });

  describe('deleteStream', () => {
    it('should delete stream', async () => {
      const stream = await service.createStream('test-room');
      const result = await service.deleteStream(stream.id);

      expect(result).toBe(true);
      const retrieved = await service.getStream(stream.id);
      expect(retrieved).toBeUndefined();
    });

    it('should emit stream_stopped event', (done) => {
      service.createStream('test-room').then((stream) => {
        service.on('stream_event', (event) => {
          if (event.type === 'stream_stopped' && event.streamId === stream.id) {
            done();
          }
        });

        service.deleteStream(stream.id);
      });
    });

    it('should return false for non-existent stream', async () => {
      const result = await service.deleteStream('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('version management', () => {
    it('should increment version on each update', async () => {
      const stream = await service.createStream('test-room');
      expect(stream.version).toBe(1);

      await service.updateStreamStatus(stream.id, StreamStatus.ACTIVE);
      const updated1 = await service.getStream(stream.id);
      expect(updated1?.version).toBe(2);

      await service.updateStreamMetadata(stream.id, { title: 'New' });
      const updated2 = await service.getStream(stream.id);
      expect(updated2?.version).toBe(3);
    });
  });
});

