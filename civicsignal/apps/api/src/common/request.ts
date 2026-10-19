import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../authz/permissions';

export interface AuthContext { userId: string; sessionId: string; email: string; displayName: string; isPlatformAdmin: boolean }
export interface TenantContext { orgId: string; role: Role }
export interface AppRequest extends Request {
  requestId: string;
  auth?: AuthContext;
  tenant?: TenantContext;
}

export const Auth = createParamDecorator((_d, ctx: ExecutionContext): AuthContext =>
  ctx.switchToHttp().getRequest<AppRequest>().auth!);
export const Tenant = createParamDecorator((_d, ctx: ExecutionContext): TenantContext =>
  ctx.switchToHttp().getRequest<AppRequest>().tenant!);
export const Meta = createParamDecorator((_d, ctx: ExecutionContext) => {
  const r = ctx.switchToHttp().getRequest<AppRequest>();
  return { ip: r.ip ?? null, requestId: r.requestId, userAgent: r.get('user-agent') ?? null };
});
export type RequestMeta = { ip: string | null; requestId: string; userAgent: string | null };
