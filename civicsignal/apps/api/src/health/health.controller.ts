import { Controller, Get, HttpException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Database } from '../database/database.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get('live') live() { return { status: 'ok' }; }

  @Get('ready')
  async ready() {
    try { await this.db.ping(); } catch { throw new HttpException({ status: 'unavailable', checks: { database: 'down' } }, 503); }
    return { status: 'ok', checks: { database: 'up' } };
  }
}
