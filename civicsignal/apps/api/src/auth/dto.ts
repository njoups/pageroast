import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @ApiProperty({ minLength: 12 }) @IsString() @MinLength(12) @MaxLength(128) password: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) displayName: string;
}
export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) password: string;
}
export class ChangePasswordDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) currentPassword: string;
  @ApiProperty({ minLength: 12 }) @IsString() @MinLength(12) @MaxLength(128) newPassword: string;
}
