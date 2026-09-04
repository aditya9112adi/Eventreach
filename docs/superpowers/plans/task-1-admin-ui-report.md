# Task 1 Report: Update Dashboard Event Filters Visibility

## Summary
Updated `frontend/src/pages/Dashboard.tsx` to display event filters (Event Status dropdown and Event Search dropdown) for both `SuperAdmin` and `Admin` users, allowing Admins to filter dashboard statistics by event status and specific events.

## Implementation Details

### 1. Role Check Variable Added
- Added `isSuperAdminOrAdmin` helper variable below `isSuperAdmin`:
  ```tsx
  const isSuperAdmin = user?.role === 'SuperAdmin';
  const isSuperAdminOrAdmin = user?.role === 'SuperAdmin' || user?.role === 'Admin';
  ```

### 2. Event Filters Block Condition Updated
- Replaced `{isSuperAdmin && (` wrapping the filter controls with `{isSuperAdminOrAdmin && (`:
  ```tsx
  {isSuperAdminOrAdmin && (
    <div className='flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50'>
      {/* FILTER 1: Status Dropdown */}
      ...
      {/* FILTER 2: Event Search dropdown */}
      ...
    </div>
  )}
  ```

## Files Modified
- `frontend/src/pages/Dashboard.tsx`

## Status & Verification
- **Status**: DONE_WITH_CONCERNS
- **Test / Build Verification**: Changes verified via code inspection. TypeScript types and JSX structure match all requirements verbatim. Terminal command execution (`run_command`) timed out on user permission check in this non-interactive environment, so automated build/commit could not be run directly from subagent terminal.
- **Git Commit Ready**:
  ```bash
  git add frontend/src/pages/Dashboard.tsx ; git commit -m "feat(ui): display event filters for admin users"
  ```

## Concerns / Notes
1. **Terminal Command Permission**: `run_command` timed out waiting for user confirmation; the git commit command above should be run by the parent agent or user.
2. **Active Filter Indicator (Line 134)**: The active filter indicator (`Showing: [eventName / status]`) at line 134 is currently wrapped with `{isSuperAdmin && (selectedEvent || statusFilter) && (...) }`. Per the brief instructions, only the dropdown filter block was updated to `isSuperAdminOrAdmin`. If Admins should also see the active filter text indicator, that condition can also be updated to `isSuperAdminOrAdmin`.
