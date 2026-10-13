import React from 'react';
import { Navigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../store/authStore';
import { canSeeTemplatesPage } from '../utils/whatsappTemplates';

/**
 * Route guard for the WhatsApp template pages: a Super Admin, or an Admin a
 * Super Admin has granted template management to.
 *
 * Like RoleRoute, this is for a clear message on a direct visit, not
 * security: the API decides every request from the database, so a stale
 * session that still shows the page is refused there.
 */
export const TemplateAccessRoute = ({ children }: { children: React.ReactNode }) => {
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

  if (!canSeeTemplatesPage(user)) {
    return (
      <div className="max-w-md mx-auto my-16 p-8 text-center bg-surface border border-border rounded-xl shadow-2xl space-y-4 animate-scale-in">
        <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Access Denied</h2>
        <p className="text-sm text-foreground/60 leading-relaxed">
          You do not have permission to manage WhatsApp templates. A Super Admin can grant it.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export default TemplateAccessRoute;
