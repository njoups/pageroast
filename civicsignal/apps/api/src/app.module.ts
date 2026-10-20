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
import { SocialAnalyticsService } from './social/social-analytics';
import { SocialController } from './social/social.controller';
import { SocialService } from './social/social.service';
import { AppConfig, CONFIG } from './config';
import { BillingController, BillingService } from './commercial/billing-api';
import { BILLING_PROVIDER, createBillingProvider } from './commercial/billing-provider';
import { PlatformCommercialController, PlatformCommercialService } from './commercial/platform-commercial';
import { BillingWebhookController, BillingWebhookService } from './commercial/webhooks';

@Module({
  imports: [DatabaseModule, IngestionCoreModule, AlertsCoreModule, ReportsCoreModule],
  controllers: [AuthController, OrganizationsController, InvitationsController, ProjectsController, AuditController, HealthController, PlatformController,
    SourcesController, QueriesController, MentionsController, AnalysisController, IssuesController, AlertRulesController, AnalyticsController, ReportsController, GovernanceController, SocialController,
    BillingController, PlatformCommercialController, BillingWebhookController],
  providers: [
    { provide: IDENTITY_PROVIDER, useClass: LocalIdentityProvider },
    AuditService, OrganizationsService, ProjectsService, SessionGuard, TenantGuard, RateLimitGuard, FailureThrottle, CounterStore,
    SourcesService, QueriesService, MentionsService, AnalysisApiService, IssuesService, RulesService, AnalyticsService, ReportsService, GovernanceService, RetentionService,
    SocialService, SocialAnalyticsService,
    { provide: BILLING_PROVIDER, inject: [CONFIG], useFactory: (c: AppConfig) => createBillingProvider(c.billing, c.appBaseUrl) },
    BillingService, PlatformCommercialService, BillingWebhookService,
  ],
})
export class AppModule {}
