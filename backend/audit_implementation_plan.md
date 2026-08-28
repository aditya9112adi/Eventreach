# Audit Implementation Plan

## 1. Existing MongoDB Architecture & Models
The application relies on MongoDB accessed via Mongoose. The 7 core collections are:
- `admins` (Admin schema)
- `campaigns` (Campaign schema)
- `contacts` (Contact schema)
- `events` (Event schema)
- `messagelogs` (MessageLog schema)
- `settings` (Settings schema)
- `users` (User schema)

## 2. Existing Authentication & Authorization
- **Auth**: Handled by `src/middleware/authMiddleware.ts` via JWT (`Bearer` token). Decodes to `req.user` (`id`, `email`, `role`).
- **Authorization**: `src/middleware/roleMiddleware.ts` uses `requireRole(['SuperAdmin', etc])`.

## 3. Existing CRUD Locations
- `authController.ts`: Login, register (USERS/ADMINS).
- `eventController.ts`: Events CRUD.
- `contactController.ts`: Contacts CRUD + Bulk Import.
- `campaignController.ts`: Campaigns CRUD + Send operations.
- `settingsController.ts`: Settings updates.
- `adminController.ts`: Admin/User management.

## 4. Bulk Logic
- **Contacts**: `bulkImportContacts` in `contactController.ts` uses `Contact.insertMany`. Needs operation-level auditing here.
- **Messages**: `sendCampaign` delegates to `QueueService.ts` (`processCampaign`). Needs to pass user/audit info down to the queue.

## 5. Integration Points
1. Create `requestMiddleware.ts` to attach `req.requestId = crypto.randomUUID()`.
2. Create `AuditLog.ts` schema/model.
3. Create `AuditService.ts` with `log()` utility (calculates diffs, strips secrets like `password`).
4. Wrap every major mutation (save, findByIdAndUpdate, insertMany, deleteOne) with `AuditService.log()`.
5. Expose `/api/audit` and `/api/audit/statistics` for the frontend.

## 6. Required Files
**Modify**:
- `src/server.ts`
- `src/controllers/*.ts` (all 6 controllers)
- `src/services/QueueService.ts`
- `frontend/src/App.tsx` (add route)
- `frontend/src/layouts/DashboardLayout.tsx` (add nav link)

**New**:
- `src/models/AuditLog.ts`
- `src/services/AuditService.ts`
- `src/middleware/requestMiddleware.ts`
- `src/controllers/auditController.ts`
- `src/routes/auditRoutes.ts`
- `frontend/src/pages/Admin/AuditLogs.tsx`

## 7. Performance Constraints
- **MessageLogs**: `sendCampaign` can trigger 1000s of messages. We will log one `BULK_MESSAGE_SENT` event at the campaign level, NOT 10,000 separate message creations.
- **Contacts**: `insertMany` will log one `CONTACT_IMPORTED` bulk event containing `importedCount`.
- **Diffing**: Before/after will only store `changedFields`. Passwords/tokens explicitly filtered.
- **Indexes**: Will add `timestamp`, `actor.userId`, `collectionName`, `action`, `bulkOperationId`, and `requestId`.
