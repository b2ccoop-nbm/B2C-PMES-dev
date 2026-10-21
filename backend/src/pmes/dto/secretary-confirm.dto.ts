import { IsBoolean, IsOptional, IsUUID } from "class-validator";

export class SecretaryConfirmDto {
  @IsUUID()
  participantId!: string;

  /** Superuser only: bypass the PMES-passed gate. Logged when used. */
  @IsOptional()
  @IsBoolean()
  forcePmesOverride?: boolean;
}
