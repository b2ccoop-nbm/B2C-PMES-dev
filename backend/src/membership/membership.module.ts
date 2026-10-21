import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MEMBERSHIP_FIREBASE, MembershipService } from "./membership.service";
import { MembershipController } from "./membership.controller";
import type { FirebaseAccountsPort } from "./firebase-accounts";

const firebaseFactory = {
  provide: MEMBERSHIP_FIREBASE,
  useFactory: (): FirebaseAccountsPort | null => {
    if (String(process.env.MEMBERSHIP_FIREBASE_MOCK ?? "").trim() === "1") {
      return {
        lookupByEmail: async () => null,
        signUp: async (email) => ({ localId: `mock-${email}`, email }),
        sendPasswordResetEmail: async () => undefined,
      };
    }
    return null;
  },
};

@Module({
  imports: [AuthModule, IntegrationsModule],
  controllers: [MembershipController],
  providers: [firebaseFactory, MembershipService],
  exports: [MembershipService],
})
export class MembershipModule {}
