import dotenv from 'dotenv';
import { LiveKitConfig } from '../types';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  grpcPort: process.env.GRPC_PORT ? parseInt(process.env.GRPC_PORT, 10) : undefined,
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || ''
  } as LiveKitConfig,
  env: process.env.NODE_ENV || 'development'
};

