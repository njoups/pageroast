import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig, CONFIG } from './config';
import { AppError } from './common/errors';
import { ErrorEnvelopeFilter } from './common/http-exception.filter';
import { originCheck, requestId } from './common/security.middleware';
import { requestMetrics } from './health/metrics';

export async function createApp(opts: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: opts.logger ?? ['error', 'warn', 'log'],
    bodyParser: false, // JSON only: form-encoded (classic CSRF) bodies are never parsed
  });
  const config = app.get<AppConfig>(CONFIG);
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestId);
  app.use(requestMetrics({ accessLog: config.nodeEnv !== 'test' }));
  app.use(cookieParser());
  app.use(originCheck(config.appOrigins));
  app.useBodyParser('json', { limit: '100kb' });
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'metrics'] });
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: (errors) => new AppError(400, 'validation_failed', 'Request validation failed',
      errors.map((e) => ({ field: e.property, problems: Object.values(e.constraints ?? {}) }))),
  }));
  if (config.apiDocsEnabled) {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle('CivicSignal Intelligence API').setVersion('v1').addCookieAuth('cs_session').build());
    SwaggerModule.setup('api/docs', app, doc);
  }
  return app;
}
