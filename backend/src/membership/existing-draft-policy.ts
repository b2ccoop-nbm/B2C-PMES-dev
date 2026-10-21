/** C1: public create never resumes, emails, or leaks an existing application. */
export const EXISTING_APPLICATION_MESSAGE =
  "An application with this email is already in progress. Continue on the device where you started it, or sign in if you already submitted.";

export function publicCreateForExistingApplication(_status: string): {
  rotateToken: false;
  returnPii: false;
  issueContinue: false;
  message: string;
} {
  return {
    rotateToken: false,
    returnPii: false,
    issueContinue: false,
    message: EXISTING_APPLICATION_MESSAGE,
  };
}
