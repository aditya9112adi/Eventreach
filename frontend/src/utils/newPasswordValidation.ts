import { z } from 'zod';
import { validatePassword } from '@eventreach/shared';

/**
 * Shared "new password + confirm password" validation for any flow that sets
 * a password without needing the current one (self-service reset via a
 * verified token). Reuses the same policy the backend enforces
 * (validatePassword) so the two can never drift, exactly like ChangePassword
 * and the Super Admin reset dialog already do for their own forms.
 */
export const newPasswordSchema = z
  .object({
    newPassword: z.string().superRefine((value, ctx) => {
      const problem = validatePassword(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export type NewPasswordFormValues = z.infer<typeof newPasswordSchema>;
