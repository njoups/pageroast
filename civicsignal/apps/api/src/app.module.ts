import { Module } from '@nestjs/common';
import { AnalysisApiService, AnalysisController } from './analysis/analysis-api';
import { AlertsCoreModule } from './alerts/alerts-queue';
import { AnalyticsController, AnalyticsService } from './analytics/analytics-api';
import { ReportsController, ReportsService } from './reports/reports-api';
import { GovernanceController, GovernanceService } from './governance/governance-api';
import { RetentionService } from './governance/retention.service';
import { ReportsCoreModule } from './reports/reports-queue';
import { IssuesController, IssuesService } from './alerts/issues-api';
import { AlertRulesController, RulesService } from './alerts/rules-api';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { SessionGuard } from './auth/session.guard';
import { TenantGuard } from './authz/guards';
import { CounterStore, FailureThrottle, RateLimitGuard } from './common/rate-limit';
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
  imports: [DatabaseModule, IngestionCoreModule, AlertsCoreModule, ReportsCoreModule],
  controllers: [AuthController, OrganizationsController, InvitationsController, ProjectsController, AuditController, HealthController, PlatformController,
    SourcesController, QueriesController, MentionsController, AnalysisController, IssuesController, AlertRulesController, AnalyticsController, ReportsController, GovernanceController],
  providers: [
    { provide: IDENTITY_PROVIDER, useClass: LocalIdentityProvider },
    AuditService, OrganizationsService, ProjectsService, SessionGuard, TenantGuard, RateLimitGuard, FailureThrottle, CounterStore,
    SourcesService, QueriesService, MentionsService, AnalysisApiService, IssuesService, RulesService, AnalyticsService, ReportsService, GovernanceService, RetentionService,
  ],
})
export class AppModule {}
