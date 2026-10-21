/** C1: public create never resumes or leaks an existing application. */
export function publicCreateForExistingApplication(status: string): {
  rotateToken: false;
  returnPii: false;
  emailContinue: boolean;
  message: string;
} {
  return {
    rotateToken: false,
    returnPii: false,
    emailContinue: status === "DRAFT",
    message: "Check your email to continue.",
  };
}
