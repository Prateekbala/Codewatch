import { createHmac, timingSafeEqual } from "node:crypto";

export const verifyGitHubSignature = (
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean => {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expected = `sha256=${digest}`;
  if (expected.length !== signatureHeader.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
};
