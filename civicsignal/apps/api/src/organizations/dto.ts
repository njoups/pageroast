import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ROLES, Role } from '../authz/permissions';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
export const INVITABLE_ROLES = ['admin', 'project_manager', 'analyst', 'report_viewer'] as const;

export class CreateOrgDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @Matches(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/) slug?: string;
}
export class UpdateOrgDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ description: 'Display settings only: brandColor, timezone, locale' })
  @IsOptional() @IsObject() settings?: { brandColor?: string; timezone?: string; locale?: string };
}
export class UpdateRoleDto {
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES as unknown as string[]) role: Role;
}
export class InviteDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) @IsIn(INVITABLE_ROLES as unknown as string[]) role: (typeof INVITABLE_ROLES)[number];
}
export class AcceptInvitationDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token: string;
}
