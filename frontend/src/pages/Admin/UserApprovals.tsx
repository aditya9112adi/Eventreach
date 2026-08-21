import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { User } from '@eventreach/shared';
import api from '../../services/api';
import { Check, X, Loader2, Users } from 'lucide-react';
import { useLoader } from '../../components/ui/FullScreenLoader';

const UserApprovals = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  
  // Access configuration state
  const [startDate, setStartDate] = useState('');
  const [durationDays, setDurationDays] = useState<number>(30);

  const { showLoader, showSuccess, showError, hideLoader } = useLoader();

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

  const getLocalISOString = (d: Date) => {
    const tzoffset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzoffset).toISOString().slice(0, 16);
  };

  const openModal = (user: any) => {
    setSelectedUser(user);
    setStartDate(getLocalISOString(new Date()));
    setDurationDays(30);
    setModalOpen(true);
  };

  const calculateExpiry = () => {
    if (!startDate) return '';
    const start = new Date(startDate);
    start.setDate(start.getDate() + durationDays);
    return getLocalISOString(start);
  };

  const handleApproveSubmit = async () => {
    if (!selectedUser) return;
    showLoader('Granting access...');
    try {
      const expiryDate = new Date(calculateExpiry()).toISOString();
      const startIso = new Date(startDate).toISOString();
      
      await api.put(`/admin/users/${selectedUser._id}/approve?type=${selectedUser.type}`, {
        accessStartDate: startIso,
        accessDurationDays: durationDays,
        accessExpiryDate: expiryDate
      });
      
      setUsers(users.filter((u: any) => u._id !== selectedUser._id));
      setModalOpen(false);
      setSelectedUser(null);
      await showSuccess('Access granted successfully');
    } catch (error) {
      console.error('Failed to approve user', error);
      await showError('Failed to grant access');
    }
  };

  const handleReject = async (id: string, type: string) => {
    if (!window.confirm('Are you sure you want to reject this request?')) return;
    showLoader('Rejecting user...');
    try {
      await api.put(`/admin/users/${id}/reject?type=${type}`);
      setUsers(users.filter((u: any) => u._id !== id));
      await showSuccess('User rejected');
    } catch (error) {
      console.error('Failed to reject user', error);
      await showError('Failed to reject user');
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
    <div className="space-y-6 animate-fade-in relative">
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
          <div className="p-8 text-center text-foreground/60 font-medium">
            No pending registration requests.
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
                    <td className="px-6 py-4 text-foreground/80">{user.email}</td>
                    <td className="px-6 py-4">
                      <span className="px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-accent/20 text-accent rounded-sm">
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <button
                        onClick={() => openModal(user)}
                        className="inline-flex items-center px-3 py-1.5 bg-green-500/20 text-green-500 hover:bg-green-500/30 font-bold uppercase tracking-wide text-xs rounded transition-colors"
                      >
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </button>
                      <button
                        onClick={() => handleReject(user._id, user.type)}
                        className="inline-flex items-center px-3 py-1.5 bg-red-500/20 text-red-500 hover:bg-red-500/30 font-bold uppercase tracking-wide text-xs rounded transition-colors"
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

      {/* Approval Modal */}
      {modalOpen && selectedUser && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md animate-scale-in flex flex-col">
                <div className="p-6 border-b border-border">
                  <h2 className="text-xl font-bold uppercase tracking-wide text-foreground">Configure Access</h2>
                  <p className="text-sm text-foreground/60 mt-1">
                    Granting access for <span className="text-accent font-bold">{selectedUser.name}</span>
                  </p>
                </div>
                
                <div className="p-6 space-y-5">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-foreground/80 mb-2">
                      Access Start Date & Time
                    </label>
                    <input
                      type="datetime-local"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full bg-background border border-border text-foreground px-4 py-2.5 rounded focus:outline-none focus:border-accent transition-colors"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-foreground/80 mb-2">
                      Access Duration (Days)
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={durationDays}
                      onChange={(e) => setDurationDays(parseInt(e.target.value) || 1)}
                      className="w-full bg-background border border-border text-foreground px-4 py-2.5 rounded focus:outline-none focus:border-accent transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-foreground/80 mb-2">
                      Access Expiry Date & Time
                    </label>
                    <input
                      type="datetime-local"
                      value={calculateExpiry()}
                      disabled
                      className="w-full bg-background/50 border border-border/50 text-foreground/60 px-4 py-2.5 rounded cursor-not-allowed"
                    />
                    <p className="text-xs text-foreground/50 mt-2">Automatically calculated based on duration.</p>
                  </div>
                </div>

                <div className="p-6 border-t border-border flex justify-end space-x-3 bg-white/5 rounded-b-xl">
                  <button
                    onClick={() => setModalOpen(false)}
                    className="px-4 py-2 text-sm font-bold uppercase tracking-wide text-foreground/60 hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleApproveSubmit}
                    className="px-4 py-2 bg-accent text-white text-sm font-bold uppercase tracking-wide hover:bg-accent/90 rounded transition-colors"
                  >
                    Approve & Grant Access
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
};

export default UserApprovals;
