import { Module } from '@nestjs/common';
import { AnalysisApiService, AnalysisController } from './analysis/analysis-api';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { SessionGuard } from './auth/session.guard';
import { TenantGuard } from './authz/guards';
import { FailureThrottle, RateLimitGuard } from './common/rate-limit';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { IngestionCoreModule } from './ingestion/ingestion-core.module';
import { MentionsController, MentionsService } from './ingestion/mentions';
import { QueriesController, QueriesService } from './ingestion/queries';
import { SourcesController } from './ingestion/sources.controller';
import { SourcesService } from './ingestion/sources.service';
import { IDENTITY_PROVIDER } from './identity/identity.provider';
import { LocalIdentityProvider } from './identity/local-identity.provider';
import { InvitationsController, OrganizationsController } from './organizations/organizations.controller';
import { OrganizationsService } from './organizations/organizations.service';
import { PlatformController } from './platform.controller';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';

@Module({
  imports: [DatabaseModule, IngestionCoreModule],
  controllers: [AuthController, OrganizationsController, InvitationsController, ProjectsController, AuditController, HealthController, PlatformController,
    SourcesController, QueriesController, MentionsController, AnalysisController],
  providers: [
    { provide: IDENTITY_PROVIDER, useClass: LocalIdentityProvider },
    AuditService, OrganizationsService, ProjectsService, SessionGuard, TenantGuard, RateLimitGuard, FailureThrottle,
    SourcesService, QueriesService, MentionsService, AnalysisApiService,
  ],
})
export class AppModule {}
