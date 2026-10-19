import { Global, Module } from '@nestjs/common';
import { AppConfig, CONFIG, loadConfig } from '../config';
import { Database } from './database.service';

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: (): AppConfig => loadConfig() }, Database],
  exports: [CONFIG, Database],
})
export class DatabaseModule {}
