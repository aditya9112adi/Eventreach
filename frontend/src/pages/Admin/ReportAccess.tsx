import React, { useEffect, useState } from 'react';
import type { User } from '@eventreach/shared';
import api from '../../services/api';
import { Loader2, ShieldAlert, Check } from 'lucide-react';
import { useToast } from '../../components/ui/Toast';

const ReportAccess = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  const fetchUsers = async () => {
    try {
      const response = await api.get('/admin/users/active');
      setUsers(response.data);
    } catch (error) {
      console.error('Failed to fetch active users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleGrantAccess = async (id: string, type: string) => {
    const daysStr = window.prompt('Enter number of days for report access:', '7');
    if (!daysStr) return;
    const days = parseInt(daysStr, 10);
    if (isNaN(days) || days <= 0) {
      showToast('error', 'Invalid number of days.');
      return;
    }

    try {
      await api.put(`/admin/users/${id}/grant-report-access?type=${type}`, { days });
      showToast('success', `Granted report access for ${days} days!`);
      fetchUsers();
    } catch (error) {
      console.error('Failed to grant access', error);
      showToast('error', 'Failed to grant access.');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Report Generation Access</h1>
          <p className="text-foreground/60">Manage temporary access for admins and users</p>
        </div>
        <div className="p-3 bg-accent/20 rounded-full">
          <ShieldAlert className="w-6 h-6 text-accent" />
        </div>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden">
        {users.length === 0 ? (
          <div className="p-8 text-center text-foreground/60">
            No active users found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-surfaceHover border-b border-border">
                <tr>
                  <th className="px-6 py-4">Name</th>
                  <th className="px-6 py-4">Email</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4">Report Access Expires</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user: any) => {
                  const hasAccess = user.reportAccessExpiry && new Date(user.reportAccessExpiry) > new Date();
                  return (
                    <tr key={user._id} className="hover:bg-surfaceHover transition-colors">
                      <td className="px-6 py-4 font-medium">{user.name}</td>
                      <td className="px-6 py-4">{user.email}</td>
                      <td className="px-6 py-4">
                        <span className="px-2.5 py-1 text-xs font-medium bg-blue-500/10 text-blue-500 rounded-full">
                          {user.role}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {hasAccess ? (
                          <span className="text-emerald-500">
                            {new Date(user.reportAccessExpiry).toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="text-foreground/40">No Access</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => handleGrantAccess(user._id, user.type)}
                          className="inline-flex items-center px-3 py-1.5 bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors"
                        >
                          <Check className="w-4 h-4 mr-1" /> Grant Access
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReportAccess;

