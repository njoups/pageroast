import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { AppConfig, CONFIG } from './config';

async function bootstrap() {
  const app = await createApp();
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(CONFIG);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`API listening on :${config.port} (docs at /api/docs)`);
}
void bootstrap();
