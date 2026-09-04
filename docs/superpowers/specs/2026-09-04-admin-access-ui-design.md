# Admin Access UI Updates Design

## Purpose
The user requested two UI changes to differentiate access controls for the Admin role vs the SuperAdmin and User roles:
1. Show the Event Filters ("Select Event Status" and "Select Event") on the Dashboard for the `Admin` role.
2. Hide the "Settings" tab in the sidebar for the `Admin` role.

## Architecture & Data Flow

### 1. Dashboard Filters (`frontend/src/pages/Dashboard.tsx`)
Currently, the event filters are wrapped in an `isSuperAdmin` check:
```tsx
const isSuperAdmin = user?.role === 'SuperAdmin';
// ...
{isSuperAdmin && (
  <div className='flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50'>
    {/* Filters */}
  </div>
)}
```
**Change:** We will expand this check to evaluate if the user is either a `SuperAdmin` or an `Admin`.
```tsx
const isSuperAdminOrAdmin = user?.role === 'SuperAdmin' || user?.role === 'Admin';
// ...
{isSuperAdminOrAdmin && (
  <div className='flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50'>
    {/* Filters */}
  </div>
)}
```

### 2. Settings Tab (`frontend/src/layouts/DashboardLayout.tsx`)
Currently, the Settings tab is pushed to the `navItems` array for all users, unconditionally:
```tsx
navItems.push({ name: 'Settings', to: '/settings', icon: Settings });
```
**Change:** We will move this push into the existing `isSuperAdmin` block so that it is only visible to Super Admins.
```tsx
if (isSuperAdmin) {
  // ... existing admin tabs
  navItems.push({ name: 'Settings', to: '/settings', icon: Settings });
}
```

## Testing Strategy
- Log in as a `SuperAdmin`: Ensure filters are visible and the Settings tab is visible.
- Log in as an `Admin`: Ensure filters are visible and the Settings tab is HIDDEN.
- Log in as a `User`: Ensure filters are HIDDEN and the Settings tab is HIDDEN.
