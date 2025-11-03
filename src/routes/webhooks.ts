import { Router, Request, Response, NextFunction } from 'express';
import { StreamOrchestratorService } from '../services/stream-orchestrator';
import { StreamStateService } from '../services/stream-state';
import { logger } from '../utils/logger';

export function createWebhooksRouter(
  orchestrator: StreamOrchestratorService,
  stateService: StreamStateService
): Router {
  const router = Router();

  router.post('/livekit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = req.body;

      logger.info('Received LiveKit webhook', { eventType: event.event, roomId: event.room?.id });

      switch (event.event) {
        case 'participant_joined':
          await handleParticipantJoined(orchestrator, stateService, event);
          break;

        case 'participant_left':
          await handleParticipantLeft(orchestrator, stateService, event);
          break;

        case 'room_finished':
          await handleRoomFinished(orchestrator, stateService, event);
          break;

        case 'room_started':
          await handleRoomStarted(orchestrator, stateService, event);
          break;

        default:
          logger.info('Unhandled LiveKit webhook event', { eventType: event.event });
      }

      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('Error handling LiveKit webhook', { error });
      next(error);
    }
  });

  return router;
}

async function handleParticipantJoined(
  orchestrator: StreamOrchestratorService,
  stateService: StreamStateService,
  event: any
): Promise<void> {
  const roomId = event.room?.id;
  if (!roomId) return;

  const stream = await stateService.getStream(roomId);
  if (!stream) {
    logger.warn(`Received participant_joined webhook for unknown room: ${roomId}`);
    return;
  }

  const participant = event.participant;
  if (participant?.identity) {
    let metadata;
    if (participant.metadata) {
      try {
        metadata = JSON.parse(participant.metadata);
      } catch (error) {
        logger.error('Failed to parse participant metadata', { error, metadata: participant.metadata });
      }
    }
    await orchestrator.handleParticipantJoined(
      stream.id,
      participant.identity,
      metadata
    );
  }
}

async function handleParticipantLeft(
  orchestrator: StreamOrchestratorService,
  stateService: StreamStateService,
  event: any
): Promise<void> {
  const roomId = event.room?.id;
  if (!roomId) return;

  const stream = await stateService.getStream(roomId);
  if (!stream) {
    logger.warn(`Received participant_left webhook for unknown room: ${roomId}`);
    return;
  }

  const participant = event.participant;
  if (participant?.identity) {
    await orchestrator.handleParticipantLeft(stream.id, participant.identity);
  }
}

async function handleRoomFinished(
  _orchestrator: StreamOrchestratorService,
  stateService: StreamStateService,
  event: any
): Promise<void> {
  const roomId = event.room?.id;
  if (!roomId) return;

  const stream = await stateService.getStream(roomId);
  if (!stream) {
    logger.warn(`Received room_finished webhook for unknown room: ${roomId}`);
    return;
  }

  logger.info(`Room finished, updating stream status: ${stream.id}`, { streamId: stream.id, roomId });
  await stateService.updateStreamStatus(stream.id, 'stopped' as any);
}

async function handleRoomStarted(
  _orchestrator: StreamOrchestratorService,
  stateService: StreamStateService,
  event: any
): Promise<void> {
  const roomId = event.room?.id;
  if (!roomId) return;

  const stream = await stateService.getStream(roomId);
  if (!stream) {
    logger.warn(`Received room_started webhook for unknown room: ${roomId}`);
    return;
  }

  logger.info(`Room started, updating stream status: ${stream.id}`, { streamId: stream.id, roomId });
  await stateService.updateStreamStatus(stream.id, 'active' as any);
}

