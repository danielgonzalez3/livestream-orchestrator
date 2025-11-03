import { RoomServiceClient, Room, ParticipantInfo, AccessToken } from 'livekit-server-sdk';
import { LiveKitConfig } from '../types';
import { logger } from '../utils/logger';

export class LiveKitService {
  private client: RoomServiceClient;
  private config: LiveKitConfig;

  constructor(config: LiveKitConfig) {
    this.config = config;
    this.client = new RoomServiceClient(config.url, config.apiKey, config.apiSecret);
  }

  async createRoom(roomName: string, metadata?: Record<string, any>): Promise<Room> {
    try {
      const room = await this.client.createRoom({
        name: roomName,
        emptyTimeout: 300, // 5 minutes
        maxParticipants: 100,
        metadata: metadata ? JSON.stringify(metadata) : undefined
      });

      logger.info(`Created LiveKit room: ${roomName}`, { roomName, sid: room.sid });
      return room;
    } catch (error) {
      logger.error(`Failed to create LiveKit room: ${roomName}`, { error, roomName });
      throw new Error(`Failed to create room: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getRoom(roomName: string): Promise<Room | null> {
    try {
      const rooms = await this.client.listRooms([roomName]);
      return rooms.length > 0 ? rooms[0] : null;
    } catch (error) {
      logger.error(`Failed to get LiveKit room: ${roomName}`, { error, roomName });
      return null;
    }
  }

  async listRooms(): Promise<Room[]> {
    try {
      return await this.client.listRooms();
    } catch (error) {
      logger.error('Failed to list LiveKit rooms', { error });
      return [];
    }
  }

  async deleteRoom(roomName: string): Promise<void> {
    try {
      await this.client.deleteRoom(roomName);
      logger.info(`Deleted LiveKit room: ${roomName}`, { roomName });
    } catch (error) {
      logger.error(`Failed to delete LiveKit room: ${roomName}`, { error, roomName });
      throw new Error(`Failed to delete room: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getParticipants(roomName: string): Promise<ParticipantInfo[]> {
    try {
      return await this.client.listParticipants(roomName);
    } catch (error) {
      logger.error(`Failed to get participants for room: ${roomName}`, { error, roomName });
      return [];
    }
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    try {
      await this.client.removeParticipant(roomName, identity);
      logger.info(`Removed participant from room: ${roomName}`, { roomName, identity });
    } catch (error) {
      logger.error(`Failed to remove participant from room: ${roomName}`, { error, roomName, identity });
      throw new Error(`Failed to remove participant: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async generateAccessToken(roomName: string, participantName: string, metadata?: Record<string, any>): Promise<string> {
    const at = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: participantName
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true
    });

    if (metadata) {
      at.metadata = JSON.stringify(metadata);
    }

    return await at.toJwt();
  }
}

