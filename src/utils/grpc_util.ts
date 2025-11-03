import { join } from 'path';
import { existsSync } from 'fs';
import { StreamStatus, Participant, StreamEvent } from '../types';

export function getProtoPath(): string {
  if (typeof __dirname !== 'undefined') {
    const path = join(__dirname, '../../proto/streams.proto');
    if (existsSync(path)) return path;
  }
  return join(process.cwd(), 'proto/streams.proto');
}

export function convertEventToGrpc(event: StreamEvent): any {
  const result: any = {
    event_type: convertEventTypeToGrpc(event.type),
    stream_id: event.streamId,
    timestamp: event.timestamp.getTime()
  };

  const stream = event.data?.stream || event.data;
  const participant = event.data?.participant;

  switch (event.type) {
    case 'stream_created':
      result.stream_created = {
        room_name: stream?.roomName || '',
        metadata: stream?.metadata ? convertMetadata(stream.metadata) : {}
      };
      break;
    case 'stream_updated':
      result.stream_updated = {
        previous_status: stream?.previousStatus 
          ? convertStatusToGrpc(stream.previousStatus) 
          : 0,
        current_status: stream?.status 
          ? convertStatusToGrpc(stream.status) 
          : 0,
        metadata: stream?.metadata ? convertMetadata(stream.metadata) : {}
      };
      break;
    case 'stream_stopped':
      result.stream_stopped = {
        room_name: stream?.roomName || ''
      };
      break;
    case 'participant_joined':
      if (participant) {
        result.participant_joined = {
          participant: convertParticipantToGrpc(participant)
        };
      }
      break;
    case 'participant_left':
      if (participant) {
        result.participant_left = {
          participant: convertParticipantToGrpc(participant)
        };
      }
      break;
  }

  return result;
}

export function convertParticipantToGrpc(participant: Participant): any {
  return {
    id: participant.id,
    identity: participant.identity,
    joined_at: participant.joinedAt.getTime(),
    left_at: participant.leftAt ? participant.leftAt.getTime() : 0,
    metadata: participant.metadata ? convertMetadata(participant.metadata) : {}
  };
}

export function convertStatusToGrpc(status: StreamStatus): number {
  const statusMap: Record<StreamStatus, number> = {
    'creating': 1,
    'active': 2,
    'stopping': 3,
    'stopped': 4,
    'error': 5
  };
  return statusMap[status] || 0;
}

export function convertEventTypeToGrpc(type: StreamEvent['type']): number {
  const typeMap: Record<StreamEvent['type'], number> = {
    'stream_created': 1,
    'stream_updated': 2,
    'stream_stopped': 3,
    'participant_joined': 4,
    'participant_left': 5
  };
  return typeMap[type] || 0;
}

export function convertMetadata(metadata: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = String(value);
  }
  return result;
}

