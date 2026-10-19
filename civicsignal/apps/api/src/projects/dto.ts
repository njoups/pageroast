import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateProjectDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) objective?: string;
  @ApiPropertyOptional({ example: ['id', 'en'] }) @IsOptional() @IsArray() @ArrayMaxSize(20)
  @Matches(/^[a-z]{2,3}$/, { each: true }) languages?: string[];
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsISO8601({ strict: true }) dateRangeStart?: string | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsISO8601({ strict: true }) dateRangeEnd?: string | null;
}
export class UpdateProjectDto extends CreateProjectDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) declare name: string;
}
export class ListProjectsQuery {
  @IsOptional() @IsIn(['active', 'archived', 'all']) status?: 'active' | 'archived' | 'all';
}
export class AddProjectMemberDto {
  @ApiProperty() @IsUUID() userId: string;
}
