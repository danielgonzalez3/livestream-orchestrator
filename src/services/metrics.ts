import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export class MetricsService {
  private register: Registry;

  // TODO: Find Existing Util to use for metrics
  public grpcRequestsTotal: Counter<string>;
  public grpcRequestsDuration: Histogram<string>;
  public grpcRequestsErrors: Counter<string>;
  public grpcActiveConnections: Gauge<string>;
  public grpcEventsBroadcasted: Counter<string>;

  public redisOperationsTotal: Counter<string>;
  public redisOperationsDuration: Histogram<string>;
  public redisOperationsErrors: Counter<string>;
  public redisConnected: Gauge<string>;
  public redisOperationsByType: Counter<string>;

  constructor() {
    this.register = new Registry();

    // Register default metrics (CPU, memory, etc.)
    const { collectDefaultMetrics } = require('prom-client');
    collectDefaultMetrics({ register: this.register });

    this.grpcRequestsTotal = new Counter({
      name: 'grpc_requests_total',
      help: 'Total number of gRPC requests',
      labelNames: ['method', 'status'],
      registers: [this.register]
    });

    this.grpcRequestsDuration = new Histogram({
      name: 'grpc_request_duration_seconds',
      help: 'Duration of gRPC requests in seconds',
      labelNames: ['method'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.register]
    });

    this.grpcRequestsErrors = new Counter({
      name: 'grpc_requests_errors_total',
      help: 'Total number of gRPC request errors',
      labelNames: ['method', 'error_code'],
      registers: [this.register]
    });

    this.grpcActiveConnections = new Gauge({
      name: 'grpc_active_connections',
      help: 'Number of active gRPC connections',
      registers: [this.register]
    });

    this.grpcEventsBroadcasted = new Counter({
      name: 'grpc_events_broadcasted_total',
      help: 'Total number of events broadcasted via gRPC',
      labelNames: ['event_type'],
      registers: [this.register]
    });

    this.redisOperationsTotal = new Counter({
      name: 'redis_operations_total',
      help: 'Total number of Redis operations',
      labelNames: ['operation', 'status'],
      registers: [this.register]
    });

    this.redisOperationsDuration = new Histogram({
      name: 'redis_operation_duration_seconds',
      help: 'Duration of Redis operations in seconds',
      labelNames: ['operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.register]
    });

    this.redisOperationsErrors = new Counter({
      name: 'redis_operations_errors_total',
      help: 'Total number of Redis operation errors',
      labelNames: ['operation'],
      registers: [this.register]
    });

    this.redisConnected = new Gauge({
      name: 'redis_connected',
      help: 'Redis connection status (1 = connected, 0 = disconnected)',
      registers: [this.register]
    });

    this.redisOperationsByType = new Counter({
      name: 'redis_operations_by_type_total',
      help: 'Total number of Redis operations by type',
      labelNames: ['operation_type'],
      registers: [this.register]
    });
  }

  public getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  public getRegister(): Registry {
    return this.register;
  }
}

// Singleton instance
let metricsServiceInstance: MetricsService | null = null;

export function getMetricsService(): MetricsService {
  if (!metricsServiceInstance) {
    metricsServiceInstance = new MetricsService();
  }
  return metricsServiceInstance;
}

