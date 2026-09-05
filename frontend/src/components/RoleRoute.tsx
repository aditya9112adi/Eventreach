import React from 'react';
import { Navigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../store/authStore';

type Role = 'SuperAdmin' | 'Admin' | 'User';

/**
 * Route guard for role-restricted pages.
 *
 * The API is the authoritative check; this exists so a user who navigates
 * directly to a privileged URL gets a clear message instead of a page that
 * renders and then fails every request. Roles come from the server-validated
 * session in authStore, not from raw localStorage.
 */
export const RoleRoute = ({
  allow,
  children,
}: {
  allow: Role[];
  children: React.ReactNode;
}) => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!allow.includes(user.role as Role)) {
    return (
      <div className="max-w-md mx-auto my-16 p-8 text-center bg-surface border border-border rounded-xl shadow-2xl space-y-4 animate-scale-in">
        <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Access Denied</h2>
        <p className="text-sm text-foreground/60 leading-relaxed">
          You do not have permission to view this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export default RoleRoute;
