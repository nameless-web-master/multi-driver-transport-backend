import { z } from "zod";
import { PUBLIC_USER_ROLES } from "../models/userRole.model";

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

const phoneSchema = z
  .string({ required_error: "phone is required" })
  .trim()
  .min(5, "phone is too short")
  .max(32, "phone is too long");

const addressSchema = z.string().trim().max(300).optional().default("");
const latSchema = z.number({ invalid_type_error: "lat must be a number" }).min(-90).max(90).optional().nullable();
const lngSchema = z.number({ invalid_type_error: "lng must be a number" }).min(-180).max(180).optional().nullable();

const roleSchema = z.enum(PUBLIC_USER_ROLES);

/** Normalise missing / null company_name to "" so senders/receivers need not send the field. */
const companyNameSchema = z.preprocess(
  (val) => (val === undefined || val === null ? "" : String(val)),
  z.string().trim().max(120)
);

export const registerSchema = z
  .object({
    full_name: z.string().trim().min(1, "full_name is required").max(120),
    role: roleSchema,
    company_name: companyNameSchema.optional(),
    phone: phoneSchema,
    address: addressSchema,
    lat: latSchema,
    lng: lngSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .transform((data) => ({
    ...data,
    company_name: data.company_name ?? "",
  }))
  .superRefine((data, ctx) => {
    if (data.role === "driver" && !data.company_name.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["company_name"],
        message: "company_name is required for drivers",
      });
    }
    if ((data.role === "sender" || data.role === "receiver") && !data.address.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: "address is required",
      });
    }
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
