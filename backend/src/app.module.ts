import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { envValidationSchema } from "./config/env.validation";
import { HealthModule } from "./health/health.module";
import { PrismaModule } from "./prisma/prisma.module";
import { PmesModule } from "./pmes/pmes.module";
import { StoreModule } from "./store/store.module";
import { MembersModule } from "./members/members.module";
import { MembershipModule } from "./membership/membership.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 120,
      },
    ]),
    PrismaModule,
    AuthModule,
    HealthModule,
    AiModule,
    PmesModule,
    StoreModule,
    MembersModule,
    MembershipModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
