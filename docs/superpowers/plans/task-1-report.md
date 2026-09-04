# Task 1 Report: Update Registration Logic in Auth Controller

## Summary
Updated `backend/src/controllers/authController.ts` to allow users and admins who were previously rejected (`status === 'Rejected'`) to re-register instead of being blocked with a 400 "Email already registered" error.

## Implementation Details

### 1. Updated Email Check Logic
- Modified the initial check against `Admin` and `User` collections to only block registration if an existing account has `status !== 'Rejected'`.
- Added `isRecreated` flag detection based on whether an existing record has status `Rejected`.

### 2. Overwrite and Role-Switching Handling
- **Same Role**: Uses `findOneAndUpdate` with `$unset: { rejectionReason: 1 }` to preserve the original `_id`, reset status to `Pending`, update credentials and pending access dates (for Admins), and clear rejection reason.
- **Cross-Role Switching**: Detects if an existing rejected record exists in the opposite collection and deletes it with `deleteOne({ email })` before creating a new record in the requested role's collection.
- **Admin Date Validation**: Retained before database checks.

### 3. Audit Logging
- Configured audit action dynamically:
  - `ADMIN_RECREATED` / `ADMIN_CREATED` for Admin role.
  - `USER_RECREATED` / `USER_CREATED` for User role.
- Updated audit log description to indicate re-registration after previous rejection when `isRecreated` is true.

## Files Modified
- `backend/src/controllers/authController.ts`

## Status & Verification
- **Status**: DONE_WITH_CONCERNS
- **Test / Build Verification**: Terminal command execution (`run_command`) timed out waiting for interactive user permission prompt. Manual code inspection confirms syntax and logic adhere strictly to `task-1-brief.md` requirements and Mongoose/TypeScript schemas.
- **Git Commit**: Ready to be committed:
  ```bash
  git add backend/src/controllers/authController.ts ; git commit -m "feat(auth): allow rejected users to re-register by overwriting previous record"
  ```
