# Admin Access UI Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the frontend UI to display event filters for Admin users and hide the Settings tab from everyone except SuperAdmins.

**Architecture:** Update boolean checks in `Dashboard.tsx` and `DashboardLayout.tsx` based on `user?.role`.

**Tech Stack:** React, TypeScript, Tailwind CSS

## Global Constraints

- No new npm dependencies.
- Changes must be purely visual/routing conditions, not affecting API structure.

---

### Task 1: Update Dashboard Event Filters Visibility

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

---

### Task 2: Hide Settings Tab from Admin Access

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.tsx`

**Interfaces:**
- Consumes: `navItems` array rendering logic.

- [ ] **Step 1: Move Settings tab into SuperAdmin block**

In `frontend/src/layouts/DashboardLayout.tsx`, find the line `navItems.push({ name: 'Settings', to: '/settings', icon: Settings });`. 
Move it inside the `if (isSuperAdmin) { ... }` block so it looks like this:

```tsx
  if (isSuperAdmin) {
    navItems.push({ name: 'Approvals', to: '/admin/approvals', icon: UserCheck });
    navItems.push({ name: 'Just Access', to: '/admin/access', icon: Key });
    navItems.push({ name: 'Audit Logs', to: '/admin/audit-logs', icon: Shield });
    navItems.push({ name: 'Settings', to: '/settings', icon: Settings });
  }

  return (
```

- [ ] **Step 2: Verify Build**

Run: `npm run build` in the `frontend` directory.
Expected: Build succeeds.

- [ ] **Step 3: Commit changes**

```bash
git add frontend/src/layouts/DashboardLayout.tsx
git commit -m "feat(ui): restrict settings tab to superadmin role only"
```
