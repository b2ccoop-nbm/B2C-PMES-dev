import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateMembershipApplicationDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsBoolean()
  dpaConsent!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  captchaToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  referralCode?: string;
}
