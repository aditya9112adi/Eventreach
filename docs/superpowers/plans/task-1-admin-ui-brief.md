# Task 1 Brief

**Global Constraints:**
- No new npm dependencies.
- Changes must be purely visual/routing conditions, not affecting API structure.

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: The `useAuth` hook provides `user.role`.

- [ ] **Step 1: Update role check variable**

In `frontend/src/pages/Dashboard.tsx`, find `const isSuperAdmin = user?.role === 'SuperAdmin';` and add a new variable below it:

```tsx
  const isSuperAdmin = user?.role === 'SuperAdmin';
  const isSuperAdminOrAdmin = user?.role === 'SuperAdmin' || user?.role === 'Admin';
```

- [ ] **Step 2: Apply the new variable to the filters block**

Find the block `{isSuperAdmin && (` that wraps the Event Status and Select Event dropdowns (around line 142) and change it to:

```tsx
        {isSuperAdminOrAdmin && (
          <div className='flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50'>
```

- [ ] **Step 3: Commit changes**

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat(ui): display event filters for admin users"
```
