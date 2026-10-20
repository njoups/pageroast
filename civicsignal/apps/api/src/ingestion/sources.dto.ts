import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const PERMITTED_FIELDS = ['title', 'url', 'published_at', 'excerpt', 'author', 'categories', 'metrics'] as const;
export const AUTH_STATUSES = ['unverified', 'authorized', 'restricted', 'revoked'] as const;

export class SourceFieldsDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ description: 'RSS/Atom feed URL (feed connectors only)' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2048) feedUrl?: string;
  @ApiPropertyOptional({ enum: ['rss', 'atom'] }) @IsOptional() @IsIn(['rss', 'atom']) format?: 'rss' | 'atom';
  @ApiPropertyOptional({ description: 'Connector-specific settings, e.g. GDELT {query, timespan, maxRecords}' }) @IsOptional() @IsObject() connectorConfig?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(60) category?: string;
  @ApiPropertyOptional({ enum: AUTH_STATUSES }) @IsOptional() @IsIn(AUTH_STATUSES as unknown as string[]) authorizationStatus?: (typeof AUTH_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) authorizationBasis?: string;
  @ApiPropertyOptional({ enum: PERMITTED_FIELDS, isArray: true }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(PERMITTED_FIELDS as unknown as string[], { each: true }) permittedFields?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() permitsFullText?: boolean;
  @ApiPropertyOptional({ minimum: 300 }) @IsOptional() @Type(() => Number) @IsInt() @Min(300) @Max(86400) refreshIntervalSeconds?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(600) rateLimitPerMinute?: number | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) quotaPerDay?: number | null;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(4000) licenseTerms?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) usageRestrictions?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) redistributionRestrictions?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) retentionDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) attributionRequirement?: string;
}

export class CreateSourceDto extends SourceFieldsDto {
  @ApiProperty({ enum: ['feed', 'gdelt'] }) @IsIn(['feed', 'gdelt']) kind: 'feed' | 'gdelt';
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) declare name: string;
}
export class UpdateSourceDto extends SourceFieldsDto {}

export class CredentialsDto {
  @ApiProperty({ description: 'API key or token. Stored encrypted; never returned.' }) @IsString() @MinLength(8) @MaxLength(4000) secret: string;
}
export class RunsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
