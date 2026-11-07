import { z } from "zod";

export const authCredentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
}).strict();

export const externalUrlSchema = z.string().url().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username && !url.password &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}, "External links must use a public HTTPS URL.");
