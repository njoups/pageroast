import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AnalysisCoreModule } from '../analysis/analysis-queue';
import { AppConfig, CONFIG } from '../config';
import { createQueue, createRedis, DLQ, KEY_PREFIX, redisConnection, type Redis } from './queue';
import { CREDENTIAL_CIPHER, IngestionPipeline, SAFE_HTTP, type CollectJob } from './pipeline.service';
import { SafeHttpClient } from './safe-http';
import { CredentialCipher } from './secrets';

export const INGESTION_QUEUE = Symbol('INGESTION_QUEUE');
export const REDIS = Symbol('REDIS');
export const INGESTION_DLQ = Symbol('INGESTION_DLQ');

@Injectable()
class QueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(INGESTION_QUEUE) private readonly queue: Queue<CollectJob> | null, @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(INGESTION_DLQ) private readonly dlq: Queue | null) {}
  async onModuleDestroy() {
    await this.queue?.close();
    await this.dlq?.close();
    this.redis?.disconnect();
  }
}

/** Shared by the API (producer side) and the worker process. Queue/Redis are null when REDIS_URL is not configured. */
@Module({
  imports: [AnalysisCoreModule],
  providers: [
    {
      provide: SAFE_HTTP, inject: [CONFIG],
      useFactory: (c: AppConfig) => new SafeHttpClient({
        userAgent: c.ingestion.userAgent, allowPrivateHosts: c.ingestion.allowPrivateHosts, timeoutMs: c.ingestion.httpTimeoutMs,
        maxBytes: c.ingestion.maxResponseBytes, maxRedirects: c.ingestion.maxRedirects,
      }),
    },
    { provide: CREDENTIAL_CIPHER, inject: [CONFIG], useFactory: (c: AppConfig) => CredentialCipher.fromBase64(c.credentialsKey ?? undefined) },
    { provide: INGESTION_QUEUE, inject: [CONFIG], useFactory: (c: AppConfig) => (c.redisUrl ? createQueue(c) : null) },
    { provide: REDIS, inject: [CONFIG], useFactory: (c: AppConfig) => (c.redisUrl ? createRedis(c.redisUrl) : null) },
    { provide: INGESTION_DLQ, inject: [CONFIG], useFactory: (c: AppConfig) => (c.redisUrl ? new Queue(DLQ, { connection: redisConnection(c.redisUrl), prefix: KEY_PREFIX }) : null) },
    IngestionPipeline, QueueLifecycle,
  ],
  exports: [SAFE_HTTP, CREDENTIAL_CIPHER, INGESTION_QUEUE, INGESTION_DLQ, REDIS, IngestionPipeline, AnalysisCoreModule],
})
export class IngestionCoreModule {}
