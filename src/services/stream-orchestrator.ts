import { LiveKitService } from './livekit';
import { StreamStateService } from './stream-state';
import { Stream, StreamStatus, Participant } from '../types';
import { logger } from '../utils/logger';

export class StreamOrchestratorService {
  constructor(
    private livekitService: LiveKitService,
    private stateService: StreamStateService
  ) {}

  async createStream(roomName?: string, metadata?: Record<string, any>, idempotencyKey?: string): Promise<Stream> {
    const stream = await this.stateService.createStream(roomName, metadata, idempotencyKey);

    try {
      await this.livekitService.createRoom(stream.roomName, metadata);
      await this.stateService.updateStreamStatus(stream.id, StreamStatus.ACTIVE);
      logger.info(`Stream created successfully: ${stream.id}`, { streamId: stream.id, roomName: stream.roomName });
      return this.stateService.getStream(stream.id)!;
    } catch (error) {
      await this.stateService.updateStreamStatus(stream.id, StreamStatus.ERROR);
      logger.error(`Failed to create LiveKit room for stream: ${stream.id}`, { error, streamId: stream.id });
      throw error;
    }
  }

  async getStream(streamId: string): Promise<Stream | null> {
    const stream = this.stateService.getStream(streamId);
    if (!stream) {
      return null;
    }

    try {
      const room = await this.livekitService.getRoom(stream.roomName);
      if (!room) {
        // room doesn't exist in LiveKit, update status
        if (stream.status === StreamStatus.ACTIVE) {
          await this.stateService.updateStreamStatus(streamId, StreamStatus.STOPPED);
        }
      } else {
        const participants = await this.livekitService.getParticipants(stream.roomName);
        await this.syncParticipants(streamId, participants);
      }
    } catch (error) {
      logger.error(`Failed to sync stream with LiveKit: ${streamId}`, { error, streamId });
    }

    return this.stateService.getStream(streamId) || null;
  }

  async stopStream(streamId: string): Promise<Stream | null> {
    const stream = this.stateService.getStream(streamId);
    if (!stream) {
      return null;
    }

    await this.stateService.updateStreamStatus(streamId, StreamStatus.STOPPING);

    try {
      await this.livekitService.deleteRoom(stream.roomName);
      await this.stateService.updateStreamStatus(streamId, StreamStatus.STOPPED);
      logger.info(`Stream stopped successfully: ${streamId}`, { streamId });
      return this.stateService.getStream(streamId) || null;
    } catch (error) {
      await this.stateService.updateStreamStatus(streamId, StreamStatus.ERROR);
      logger.error(`Failed to stop LiveKit room for stream: ${streamId}`, { error, streamId });
      throw error;
    }
  }

  async handleParticipantJoined(streamId: string, identity: string, metadata?: Record<string, any>): Promise<void> {
    const participant: Participant = {
      id: identity,
      identity,
      joinedAt: new Date(),
      metadata
    };

    await this.stateService.addParticipant(streamId, participant);
    logger.info(`Participant joined stream: ${streamId}`, { streamId, identity });
  }

  async handleParticipantLeft(streamId: string, identity: string): Promise<void> {
    await this.stateService.removeParticipant(streamId, identity);
    logger.info(`Participant left stream: ${streamId}`, { streamId, identity });
  }

  private async syncParticipants(streamId: string, livekitParticipants: any[]): Promise<void> {
    const stream = this.stateService.getStream(streamId);
    if (!stream) return;

    const currentParticipantIds = new Set(stream.participants.map((p: Participant) => p.id));

    for (const participant of livekitParticipants) {
      if (!currentParticipantIds.has(participant.identity)) {
        let metadata;
        if (participant.metadata) {
          try {
            metadata = JSON.parse(participant.metadata);
          } catch (error) {
            logger.error('Failed to parse participant metadata', { error, metadata: participant.metadata });
          }
        }
        await this.handleParticipantJoined(
          streamId,
          participant.identity,
          metadata
        );
      }
    }

    const livekitParticipantIds = new Set(livekitParticipants.map(p => p.identity));
    for (const participant of stream.participants) {
      if (!livekitParticipantIds.has(participant.id) && !participant.leftAt) {
        await this.handleParticipantLeft(streamId, participant.id);
      }
    }
  }

  async generateAccessToken(streamId: string, participantName: string, metadata?: Record<string, any>): Promise<string | null> {
    const stream = this.stateService.getStream(streamId);
    if (!stream) {
      return null;
    }

    return await this.livekitService.generateAccessToken(stream.roomName, participantName, metadata);
  }
}

