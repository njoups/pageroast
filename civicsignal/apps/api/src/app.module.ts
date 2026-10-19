import { Module } from '@nestjs/common';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { SessionGuard } from './auth/session.guard';
import { TenantGuard } from './authz/guards';
import { FailureThrottle, RateLimitGuard } from './common/rate-limit';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { IDENTITY_PROVIDER } from './identity/identity.provider';
import { LocalIdentityProvider } from './identity/local-identity.provider';
import { InvitationsController, OrganizationsController } from './organizations/organizations.controller';
import { OrganizationsService } from './organizations/organizations.service';
import { PlatformController } from './platform.controller';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController, OrganizationsController, InvitationsController, ProjectsController, AuditController, HealthController, PlatformController],
  providers: [
    { provide: IDENTITY_PROVIDER, useClass: LocalIdentityProvider },
    AuditService, OrganizationsService, ProjectsService, SessionGuard, TenantGuard, RateLimitGuard, FailureThrottle,
  ],
})
export class AppModule {}
