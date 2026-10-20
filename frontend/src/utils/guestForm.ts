import { z } from 'zod';
import { validateMobileForSave } from './mobileDigits';

/**
 * The rules of the Add Guest form, as the Contacts page applies them to a main event's guest
 * (pages/Contacts/ContactList.tsx): a name of at most 50 characters, exactly the ten digits
 * shown beside IN (+91) that pass the shared Indian mobile rule, and an optional @gmail.com
 * address. The Sub-Event dialog uses this same schema, so a guest is accepted or refused by
 * the same words wherever it is added.
 */
export const GUEST_NAME_MAX = 50;
export const GUEST_EMAIL_MAX = 60; // 50 for the name part + 10 for "@gmail.com"

export const guestSchema = z.object({
  fullName: z.string().min(1, 'Name is required').max(GUEST_NAME_MAX, 'Full name must be at most 50 characters'),
  phoneNumber: z.string().superRefine((value, ctx) => {
    const problem = validateMobileForSave(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  countryCode: z.string().min(1, 'Code required'),
  email: z
    .string()
    .optional()
    .or(z.literal(''))
    .refine((val) => !val || /^[^@]{1,50}@gmail\.com$/.test(val), { message: 'Only @gmail.com emails allowed' }),
});

export type GuestForm = z.infer<typeof guestSchema>;
