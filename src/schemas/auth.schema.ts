import { z } from "zod";

const emailSchema = z
  .string({ required_error: "email is required" })
  .trim()
  .toLowerCase()
  .email("email must be a valid address")
  .max(254);

const passwordSchema = z
  .string({ required_error: "password is required" })
  .min(8, "password must be at least 8 characters")
  .max(128, "password is too long");

export const registerSchema = z
  .object({
    full_name: z.string().trim().min(1, "full_name is required").max(120),
    company_name: z.string().trim().min(1, "company_name is required").max(120),
    email: emailSchema,
    password: passwordSchema,
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "password is required").max(128),
  remember_me: z.boolean().optional(),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, "refresh_token is required"),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "token is required"),
  password: passwordSchema,
});

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
