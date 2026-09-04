# Rejected User Re-registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the backend registration logic to allow users whose status is `Rejected` to successfully re-register without encountering an "Email already registered" error.

**Architecture:** We will update `authController.ts` to check if existing email records have a `Rejected` status. If so, we bypass the error, hash the new password, and either overwrite the existing record (if the role is the same) or delete the old record and create a new one (if the role changed), while clearing the rejection reason. We will log the `*_RECREATED` event in the audit trail.

**Tech Stack:** Node.js, Express, Mongoose (MongoDB)

## Global Constraints

- Preserve original `_id` and audit trail if registering for the same role.
- Handle cross-collection conflicts by deleting the old record if they switch roles.
- Ensure admin date validation still applies.

---

### Task 1: Update Registration Logic in Auth Controller

**Files:**
- Modify: `backend/src/controllers/authController.ts`

**Interfaces:**
- Consumes: The `register` endpoint receives standard registration payload.
- Produces: Updates database and sends `201 Created` with success message instead of `400 Bad Request` if user was previously rejected.

- [ ] **Step 1: Replace existing email check logic**

In `backend/src/controllers/authController.ts`, find the registration function and replace the `existingAdmin` and `existingUser` checks to allow `Rejected` statuses:

```typescript
    const existingAdmin = await Admin.findOne({ email });
    const existingUser = await User.findOne({ email });
    
    if (existingAdmin && existingAdmin.status !== 'Rejected') {
      return res.status(400).json({ error: 'Email already registered' });
    }
    if (existingUser && existingUser.status !== 'Rejected') {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const status = 'Pending';
    
    let createdUser;
    const isRecreated = (existingAdmin && existingAdmin.status === 'Rejected') || 
                        (existingUser && existingUser.status === 'Rejected');
```

- [ ] **Step 2: Implement overwrite/recreate logic**

Replace the existing `if (role === 'Admin') { ... } else { ... }` block with this updated logic that handles overwriting and role-switching:

```typescript
    if (role === 'Admin') {
      if (existingUser && existingUser.status === 'Rejected') {
        await User.deleteOne({ email });
      }
      
      if (existingAdmin && existingAdmin.status === 'Rejected') {
        createdUser = await Admin.findOneAndUpdate(
          { email },
          {
            name,
            passwordHash,
            status: 'Pending',
            pendingAccessStartDate: new Date(accessStartDate!),
            pendingAccessEndDate: new Date(accessEndDate!),
            $unset: { rejectionReason: 1 } 
          },
          { new: true }
        );
        sendApprovalEmail(name, email);
      } else {
        createdUser = await Admin.create({
          name,
          email,
          passwordHash,
          role: 'Admin',
          status,
          pendingAccessStartDate: new Date(accessStartDate!),
          pendingAccessEndDate: new Date(accessEndDate!),
        });
        sendApprovalEmail(name, email);
      }
    } else {
      if (existingAdmin && existingAdmin.status === 'Rejected') {
        await Admin.deleteOne({ email });
      }

      if (existingUser && existingUser.status === 'Rejected') {
        createdUser = await User.findOneAndUpdate(
          { email },
          {
            name,
            passwordHash,
            status: 'Pending',
            $unset: { rejectionReason: 1 }
          },
          { new: true }
        );
      } else {
        createdUser = await User.create({
          name,
          email,
          passwordHash,
          status,
        });
      }
    }
```

- [ ] **Step 3: Update Audit Logging for Recreated Users**

Replace the existing `AuditService.log` block at the end of the `register` function to use the `isRecreated` flag for action names and descriptions:

```typescript
    await AuditService.log({
      action: role === 'Admin' ? (isRecreated ? 'ADMIN_RECREATED' : 'ADMIN_CREATED') : (isRecreated ? 'USER_RECREATED' : 'USER_CREATED'),
      collectionName: role === 'Admin' ? 'admins' : 'users',
      documentId: createdUser._id.toString(),
      request: AuditService.getRequestInfo(req),
      after: createdUser,
      description: isRecreated ? `${role} re-registered after previous rejection` : `New ${role} registration pending approval`
    });
```

- [ ] **Step 4: Build backend to verify types**

Run: `npm run build` in the `backend` directory.
Expected: Build succeeds without TypeScript errors.

- [ ] **Step 5: Commit changes**

```bash
git add backend/src/controllers/authController.ts
git commit -m "feat(auth): allow rejected users to re-register by overwriting previous record"
```
