import React, { useEffect, useState } from 'react';
import type { User } from '@eventreach/shared';
import api from '../../services/api';
import { Check, X, Loader2, Users } from 'lucide-react';

const UserApprovals = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = async () => {
    try {
      const response = await api.get('/admin/users/pending');
      setUsers(response.data);
    } catch (error) {
      console.error('Failed to fetch pending users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleApprove = async (id: string, type: string) => {
    try {
      await api.put(`/admin/users/${id}/approve?type=${type}`);
      setUsers(users.filter(u => u.id !== id && (u as any)._id !== id));
      window.alert('User approved successfully!');
    } catch (error) {
      console.error('Failed to approve user', error);
      window.alert('Failed to approve user.');
    }
  };

  const handleReject = async (id: string, type: string) => {
    try {
      await api.put(`/admin/users/${id}/reject?type=${type}`);
      setUsers(users.filter(u => u.id !== id && (u as any)._id !== id));
      window.alert('User rejected successfully!');
    } catch (error) {
      console.error('Failed to reject user', error);
      window.alert('Failed to reject user.');
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
          <h1 className="text-2xl font-bold">User Approvals</h1>
          <p className="text-foreground/60">Manage pending registration requests</p>
        </div>
        <div className="p-3 bg-accent/20 rounded-full">
          <Users className="w-6 h-6 text-accent" />
        </div>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden">
        {users.length === 0 ? (
          <div className="p-8 text-center text-foreground/60">
            No pending users to approve.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-white/5 border-b border-white/10">
                <tr>
                  <th className="px-6 py-4">Name</th>
                  <th className="px-6 py-4">Email</th>
                  <th className="px-6 py-4">Requested Role</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {users.map((user: any) => (
                  <tr key={user._id} className="hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4 font-medium">{user.name}</td>
                    <td className="px-6 py-4">{user.email}</td>
                    <td className="px-6 py-4">
                      <span className="px-2.5 py-1 text-xs font-medium bg-blue-500/20 text-blue-400 rounded-full">
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <button
                        onClick={() => handleApprove(user._id, user.type)}
                        className="inline-flex items-center px-3 py-1.5 bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg transition-colors"
                      >
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </button>
                      <button
                        onClick={() => handleReject(user._id, user.type)}
                        className="inline-flex items-center px-3 py-1.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors"
                      >
                        <X className="w-4 h-4 mr-1" /> Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserApprovals;
