# Rejected User Re-registration Design

## Purpose
Currently, when a Super Admin rejects a registration request, the user's status is set to `Rejected` but their record remains in the database. If they try to register again, the `/auth/register` endpoint blocks them with an "Email already registered" error. This feature allows rejected users to re-register.

## Architecture & Data Flow
1. **Registration Check**:
   - The `/auth/register` endpoint queries both the `admins` and `users` collections for the provided email.
   - If an existing record is found and its `status` is `Pending` or `Active`, the request is blocked with a 400 error ("Email already registered").
   - If the existing record's `status` is `Rejected`, the registration is allowed to proceed.

2. **Database Overwrite/Recreation**:
   - **Same Role**: If the user re-registers for the same role (e.g., Rejected Admin -> Admin), the system updates the existing document with the new `name`, hashed `password`, `pendingAccessStartDate` (if applicable), and sets `status` back to `Pending`. This preserves the original MongoDB `_id` and audit trail.
   - **Different Role**: If the user re-registers for a different role (e.g., Rejected User -> Admin), the system deletes the old rejected document from the original collection and creates a new document in the correct collection. 

3. **Audit Logging**:
   - The system logs a `USER_RECREATED` or `ADMIN_RECREATED` action in the `AuditLogs` collection when an overwriting/recreation event occurs, explicitly describing that a previously rejected user has re-applied.

## Edge Cases Handled
- **Cross-collection conflicts**: Handled by strictly deleting the old record if the user attempts to switch roles between `User` and `Admin`.
- **Admin Date Validation**: Admin date validation (start date < end date) still applies to re-registration.

## Testing Strategy
- Manual test: Register a user -> Reject them via Super Admin -> Register them again with the same email -> Verify success.
- Verify that trying to register a `Pending` or `Active` user still returns an error.
