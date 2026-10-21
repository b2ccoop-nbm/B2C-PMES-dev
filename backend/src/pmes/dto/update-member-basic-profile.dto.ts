import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

/** Member self-service: core `Participant` fields from the simple registration / portal profile screen. */
export class UpdateMemberBasicProfileDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  gender?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  mailingAddress?: string;

  /** 9–12 digits when present; clears tinMissingFlaggedAt. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  tinNo?: string;
}
