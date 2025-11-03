import { StreamOrchestratorService } from '../../src/services/stream-orchestrator';
import { LiveKitService } from '../../src/services/livekit';
import { StreamStateService } from '../../src/services/stream-state';
import { StreamStatus, Stream } from '../../src/types';

describe('StreamOrchestratorService', () => {
  let orchestrator: StreamOrchestratorService;
  let mockLiveKit: jest.Mocked<LiveKitService>;
  let mockState: jest.Mocked<StreamStateService>;

  beforeEach(() => {
    mockLiveKit = {
      createRoom: jest.fn(),
      deleteRoom: jest.fn(),
      getRoom: jest.fn(),
      getParticipants: jest.fn(),
      generateAccessToken: jest.fn()
    } as any;

    mockState = {
      createStream: jest.fn(),
      getStream: jest.fn(),
      updateStreamStatus: jest.fn(),
      addParticipant: jest.fn(),
      removeParticipant: jest.fn()
    } as any;

    orchestrator = new StreamOrchestratorService(mockLiveKit, mockState);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createStream', () => {
    it('should create stream and activate it', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.CREATING,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const activeStream: Stream = {
        ...mockStream,
        status: StreamStatus.ACTIVE,
        version: 2
      };

      mockState.createStream.mockResolvedValue(mockStream);
      mockLiveKit.createRoom.mockResolvedValue({ name: 'test-room' } as any);
      mockState.updateStreamStatus.mockResolvedValue(activeStream);
      mockState.getStream.mockResolvedValue(activeStream);

      const result = await orchestrator.createStream('test-room', { title: 'Test' });

      expect(mockState.createStream).toHaveBeenCalledWith('test-room', { title: 'Test' }, undefined);
      expect(mockLiveKit.createRoom).toHaveBeenCalledWith('test-room', { title: 'Test' });
      expect(mockState.updateStreamStatus).toHaveBeenCalledWith('stream-1', StreamStatus.ACTIVE);
      expect(result.status).toBe(StreamStatus.ACTIVE);
    });

    it('should handle idempotency key', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.CREATING,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const activeStream: Stream = {
        ...mockStream,
        status: StreamStatus.ACTIVE,
        version: 2
      };

      mockState.createStream.mockResolvedValue(mockStream);
      mockLiveKit.createRoom.mockResolvedValue({ name: 'test-room' } as any);
      mockState.updateStreamStatus.mockResolvedValue(activeStream);
      mockState.getStream.mockResolvedValue(activeStream);

      await orchestrator.createStream('test-room', {}, 'idempotency-key');

      expect(mockState.createStream).toHaveBeenCalledWith('test-room', {}, 'idempotency-key');
    });

    it('should set status to ERROR on LiveKit failure', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.CREATING,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const errorStream: Stream = {
        ...mockStream,
        status: StreamStatus.ERROR,
        version: 2
      };

      mockState.createStream.mockResolvedValue(mockStream);
      mockLiveKit.createRoom.mockRejectedValue(new Error('LiveKit error'));
      mockState.updateStreamStatus.mockResolvedValue(errorStream);

      await expect(orchestrator.createStream('test-room')).rejects.toThrow('LiveKit error');
      expect(mockState.updateStreamStatus).toHaveBeenCalledWith('stream-1', StreamStatus.ERROR);
    });
  });

  describe('getStream', () => {
    it('should return stream if exists', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      mockState.getStream.mockResolvedValue(mockStream);
      mockLiveKit.getRoom.mockResolvedValue({ name: 'test-room' } as any);
      mockLiveKit.getParticipants.mockResolvedValue([]);

      const result = await orchestrator.getStream('stream-1');

      expect(result).toBeDefined();
      expect(result?.id).toBe('stream-1');
      expect(mockLiveKit.getRoom).toHaveBeenCalledWith('test-room');
    });

    it('should return null if stream does not exist', async () => {
      mockState.getStream.mockResolvedValue(undefined);

      const result = await orchestrator.getStream('non-existent');

      expect(result).toBeNull();
      expect(mockLiveKit.getRoom).not.toHaveBeenCalled();
    });

    it('should update status to STOPPED if room does not exist in LiveKit', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const stoppedStream: Stream = {
        ...mockStream,
        status: StreamStatus.STOPPED,
        version: 2
      };

      mockState.getStream.mockResolvedValue(mockStream);
      mockLiveKit.getRoom.mockResolvedValue(null);
      mockState.updateStreamStatus.mockResolvedValue(stoppedStream);
      mockState.getStream.mockResolvedValueOnce(mockStream).mockResolvedValueOnce(stoppedStream);

      const result = await orchestrator.getStream('stream-1');

      expect(mockState.updateStreamStatus).toHaveBeenCalledWith('stream-1', StreamStatus.STOPPED);
      expect(result?.status).toBe(StreamStatus.STOPPED);
    });

    it('should sync participants with LiveKit', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const livekitParticipants = [
        { identity: 'user-1', metadata: '{"role":"viewer"}' },
        { identity: 'user-2', metadata: null }
      ];

      mockState.getStream.mockResolvedValue(mockStream);
      mockLiveKit.getRoom.mockResolvedValue({ name: 'test-room' } as any);
      mockLiveKit.getParticipants.mockResolvedValue(livekitParticipants as any);
      mockState.addParticipant.mockResolvedValue(mockStream);

      await orchestrator.getStream('stream-1');

      expect(mockLiveKit.getParticipants).toHaveBeenCalledWith('test-room');
      expect(mockState.addParticipant).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      mockState.getStream.mockResolvedValue(mockStream);
      mockLiveKit.getRoom.mockRejectedValue(new Error('LiveKit error'));

      const result = await orchestrator.getStream('stream-1');

      expect(result).toBeDefined();
    });
  });

  describe('stopStream', () => {
    it('should stop stream successfully', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const stoppingStream: Stream = {
        ...mockStream,
        status: StreamStatus.STOPPING,
        version: 2
      };

      const stoppedStream: Stream = {
        ...mockStream,
        status: StreamStatus.STOPPED,
        version: 3,
        stoppedAt: new Date()
      };

      mockState.getStream.mockResolvedValue(mockStream);
      mockState.updateStreamStatus
        .mockResolvedValueOnce(stoppingStream)
        .mockResolvedValueOnce(stoppedStream);
      mockLiveKit.deleteRoom.mockResolvedValue(undefined as any);
      mockState.getStream.mockResolvedValueOnce(mockStream).mockResolvedValueOnce(stoppedStream);

      const result = await orchestrator.stopStream('stream-1');

      expect(mockState.updateStreamStatus).toHaveBeenCalledWith('stream-1', StreamStatus.STOPPING);
      expect(mockLiveKit.deleteRoom).toHaveBeenCalledWith('test-room');
      expect(mockState.updateStreamStatus).toHaveBeenCalledWith('stream-1', StreamStatus.STOPPED);
      expect(result?.status).toBe(StreamStatus.STOPPED);
    });

    it('should return null if stream does not exist', async () => {
      mockState.getStream.mockResolvedValue(undefined);

      const result = await orchestrator.stopStream('non-existent');

      expect(result).toBeNull();
      expect(mockLiveKit.deleteRoom).not.toHaveBeenCalled();
    });

    it('should set status to ERROR on LiveKit failure', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      const stoppingStream: Stream = {
        ...mockStream,
        status: StreamStatus.STOPPING,
        version: 2
      };

      const errorStream: Stream = {
        ...mockStream,
        status: StreamStatus.ERROR,
        version: 3
      };

      mockState.getStream.mockResolvedValue(mockStream);
      mockState.updateStreamStatus
        .mockResolvedValueOnce(stoppingStream)
        .mockResolvedValueOnce(errorStream);
      mockLiveKit.deleteRoom.mockRejectedValue(new Error('LiveKit error'));

      await expect(orchestrator.stopStream('stream-1')).rejects.toThrow('LiveKit error');
      expect(mockState.updateStreamStatus).toHaveBeenCalledWith('stream-1', StreamStatus.ERROR);
    });
  });

  describe('handleParticipantJoined', () => {
    it('should add participant to stream', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      mockState.addParticipant.mockResolvedValue(mockStream);

      await orchestrator.handleParticipantJoined('stream-1', 'user-1', { role: 'viewer' });

      expect(mockState.addParticipant).toHaveBeenCalledWith('stream-1', {
        id: 'user-1',
        identity: 'user-1',
        joinedAt: expect.any(Date),
        metadata: { role: 'viewer' }
      });
    });

    it('should handle participant without metadata', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      mockState.addParticipant.mockResolvedValue(mockStream);

      await orchestrator.handleParticipantJoined('stream-1', 'user-1');

      expect(mockState.addParticipant).toHaveBeenCalledWith('stream-1', {
        id: 'user-1',
        identity: 'user-1',
        joinedAt: expect.any(Date),
        metadata: undefined
      });
    });
  });

  describe('handleParticipantLeft', () => {
    it('should remove participant from stream', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      mockState.removeParticipant.mockResolvedValue(mockStream);

      await orchestrator.handleParticipantLeft('stream-1', 'user-1');

      expect(mockState.removeParticipant).toHaveBeenCalledWith('stream-1', 'user-1');
    });
  });

  describe('generateAccessToken', () => {
    it('should generate access token for valid stream', async () => {
      const mockStream: Stream = {
        id: 'stream-1',
        roomName: 'test-room',
        status: StreamStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        participants: [],
        version: 1
      };

      mockState.getStream.mockResolvedValue(mockStream);
      mockLiveKit.generateAccessToken.mockResolvedValue('token-123');

      const token = await orchestrator.generateAccessToken('stream-1', 'user-1', { role: 'viewer' });

      expect(token).toBe('token-123');
      expect(mockLiveKit.generateAccessToken).toHaveBeenCalledWith('test-room', 'user-1', { role: 'viewer' });
    });

    it('should return null for non-existent stream', async () => {
      mockState.getStream.mockResolvedValue(undefined);

      const token = await orchestrator.generateAccessToken('non-existent', 'user-1');

      expect(token).toBeNull();
      expect(mockLiveKit.generateAccessToken).not.toHaveBeenCalled();
    });
  });
});

