import { z } from "zod";

export const Email = z.string().trim().toLowerCase().email().max(254);
// bcrypt only uses the first 72 bytes, so cap the password there.
export const Password = z.string().min(8).max(72);

export const RegisterBody = z.object({ email: Email, password: Password, name: z.string().trim().min(1).max(100) });
export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(72) });
export const CreateDocBody = z.object({ name: z.string().trim().min(1).max(100) });

export interface PublicUser { id: string; email: string; name: string }
export interface DocSummary { id: string; name: string; role: "owner" | "editor" | "viewer"; createdAt: string }
