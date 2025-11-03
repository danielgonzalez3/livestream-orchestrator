export enum StreamStatus {
  CREATING = 'creating',
  ACTIVE = 'active',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error'
}

export interface Stream {
  id: string;
  roomName: string;
  status: StreamStatus;
  createdAt: Date;
  updatedAt: Date;
  stoppedAt?: Date;
  participants: Participant[];
  metadata?: Record<string, any>;
  version?: number;
}

export interface Participant {
  id: string;
  identity: string;
  joinedAt: Date;
  leftAt?: Date;
  metadata?: Record<string, any>;
}

export interface CreateStreamRequest {
  roomName?: string;
  metadata?: Record<string, any>;
}

export interface UpdateStreamRequest {
  status?: StreamStatus;
  metadata?: Record<string, any>;
}

export interface StreamEvent {
  type: 'stream_created' | 'stream_updated' | 'stream_stopped' | 'participant_joined' | 'participant_left';
  streamId: string;
  data: any;
  timestamp: Date;
  instanceId?: string;
}

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

