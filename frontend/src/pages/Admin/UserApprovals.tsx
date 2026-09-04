import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { User } from '@eventreach/shared';
import api from '../../services/api';
import { Check, X, Users, Calendar, AlertTriangle } from 'lucide-react';
import { useLoader } from '../../components/ui/FullScreenLoader';

const fmt = (d?: string | Date) => {
  if (!d) return 'N/A';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
};

const UserApprovals = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Approve modal
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [assignEventId, setAssignEventId] = useState<string>('');

  // Reject modal
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectingUser, setRejectingUser] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState('');

  const { showLoader, showSuccess, showError } = useLoader();

  const fetchUsers = async () => {
    try {
      const [usersRes, eventsRes] = await Promise.all([
        api.get('/admin/users/pending'),
        api.get('/events')
      ]);
      setUsers(usersRes.data);
      setEvents(eventsRes.data);
    } catch (error) {
      console.error('Failed to fetch pending users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const openApproveModal = (user: any) => {
    setSelectedUser(user);
    setAssignEventId('');
    setApproveModalOpen(true);
  };

  const openRejectModal = (user: any) => {
    setRejectingUser(user);
    setRejectReason('');
    setRejectError('');
    setRejectModalOpen(true);
  };

  const handleApproveSubmit = async () => {
    if (!selectedUser) return;
    showLoader('Approving request...');
    try {
      await api.put(`/admin/users/${selectedUser._id}/approve?type=${selectedUser.type}`, {
        assignedEventId: assignEventId || undefined
      });
      setUsers(users.filter((u: any) => u._id !== selectedUser._id));
      setApproveModalOpen(false);
      setSelectedUser(null);
      await showSuccess('Access approved successfully');
    } catch (error: any) {
      console.error('Failed to approve user', error);
      await showError(error?.response?.data?.error || 'Failed to approve request');
    }
  };

  const handleRejectSubmit = async () => {
    if (!rejectingUser) return;
    if (!rejectReason.trim()) {
      setRejectError('Please enter a reason for rejection.');
      return;
    }
    showLoader('Rejecting request...');
    try {
      await api.put(`/admin/users/${rejectingUser._id}/reject?type=${rejectingUser.type}`, { reason: rejectReason.trim() });
      setUsers(users.filter((u: any) => u._id !== rejectingUser._id));
      setRejectModalOpen(false);
      setRejectingUser(null);
      await showSuccess('Request rejected');
    } catch (error: any) {
      console.error('Failed to reject user', error);
      await showError(error?.response?.data?.error || 'Failed to reject request');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
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
                  <th className="px-6 py-4">Requested Access Period</th>
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
                    <td className="px-6 py-4 text-xs text-foreground/70 min-w-[200px]">
                      {user.role === 'Admin' && user.pendingAccessStartDate ? (
                        <div className="flex flex-col gap-1.5 bg-background/50 p-2.5 rounded-md border border-white/5">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-bold text-foreground/50 uppercase tracking-wider text-[10px]">From</span> 
                            <span className="font-medium whitespace-nowrap">{fmt(user.pendingAccessStartDate)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-bold text-foreground/50 uppercase tracking-wider text-[10px]">To</span> 
                            <span className="font-medium whitespace-nowrap">{fmt(user.pendingAccessEndDate)}</span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-foreground/40 italic">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col sm:flex-row gap-2 justify-end">
                        <button
                          onClick={() => openApproveModal(user)}
                          className="inline-flex items-center justify-center px-4 py-2 bg-green-500/10 text-green-500 hover:bg-green-500/20 font-bold uppercase tracking-wide text-[11px] rounded-md transition-all duration-200 border border-green-500/20 shadow-sm whitespace-nowrap"
                        >
                          <Check className="w-3.5 h-3.5 mr-1.5" /> Approve
                        </button>
                        <button
                          onClick={() => openRejectModal(user)}
                          className="inline-flex items-center justify-center px-4 py-2 bg-red-500/10 text-red-500 hover:bg-red-500/20 font-bold uppercase tracking-wide text-[11px] rounded-md transition-all duration-200 border border-red-500/20 shadow-sm whitespace-nowrap"
                        >
                          <X className="w-3.5 h-3.5 mr-1.5" /> Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== APPROVE CONFIRMATION MODAL ===== */}
      {approveModalOpen && selectedUser && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md animate-scale-in flex flex-col">
                <div className="p-6 border-b border-border">
                  <h2 className="text-xl font-bold uppercase tracking-wide text-foreground">Confirm Approval</h2>
                  <p className="text-sm text-foreground/60 mt-1">
                    Approving registration for <span className="text-accent font-bold">{selectedUser.name}</span>
                  </p>
                </div>

                <div className="p-6 space-y-4">
                  <div className="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground/60">
                      <Calendar className="w-4 h-4" /> Requested Access Period
                    </div>
                    {selectedUser.pendingAccessStartDate ? (
                      <div className="space-y-1.5 text-sm">
                        <div className="flex justify-between">
                          <span className="text-foreground/60">Start:</span>
                          <span className="font-semibold text-foreground">{fmt(selectedUser.pendingAccessStartDate)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-foreground/60">End:</span>
                          <span className="font-semibold text-foreground">{fmt(selectedUser.pendingAccessEndDate)}</span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-foreground/50 italic">No specific access period requested (User role).</p>
                    )}
                  </div>

                  {selectedUser.type === 'User' && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-foreground/60 block">
                        Assign Event (Optional)
                      </label>
                      <select
                        value={assignEventId}
                        onChange={(e) => setAssignEventId(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
                      >
                        <option value="">No Event Assigned</option>
                        {events.map((ev) => (
                          <option key={ev._id} value={ev._id}>
                            {ev.eventName} ({ev.eventType} - {ev.eventDate})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <p className="text-xs text-foreground/50">
                    Clicking <strong>Approve</strong> will grant access immediately.
                  </p>
                </div>

                <div className="p-6 border-t border-border flex justify-end space-x-3 bg-white/5 rounded-b-xl">
                  <button
                    onClick={() => { setApproveModalOpen(false); setSelectedUser(null); }}
                    className="px-4 py-2 text-sm font-bold uppercase tracking-wide text-foreground/60 hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleApproveSubmit}
                    className="px-4 py-2 bg-green-600 text-white text-sm font-bold uppercase tracking-wide hover:bg-green-700 rounded transition-colors"
                  >
                    Approve
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {/* ===== REJECT WITH REASON MODAL ===== */}
      {rejectModalOpen && rejectingUser && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md animate-scale-in flex flex-col">
                <div className="p-6 border-b border-border">
                  <h2 className="text-xl font-bold uppercase tracking-wide text-foreground text-red-400">Reject Request</h2>
                  <p className="text-sm text-foreground/60 mt-1">
                    Rejecting registration for <span className="text-red-400 font-bold">{rejectingUser.name}</span>
                  </p>
                </div>

                <div className="p-6 space-y-4">
                  {rejectError && (
                    <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/30 text-destructive rounded-lg px-4 py-3 text-sm">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      {rejectError}
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-bold text-foreground mb-2">
                      Reason for Rejection <span className="text-destructive">*</span>
                    </label>
                    <textarea
                      value={rejectReason}
                      onChange={(e) => { setRejectReason(e.target.value); setRejectError(''); }}
                      rows={4}
                      className="w-full bg-background border border-border text-foreground px-4 py-2.5 rounded-lg focus:outline-none focus:border-destructive resize-none transition-colors text-sm"
                      placeholder="Explain why this registration request is being rejected..."
                    />
                    <p className="text-xs text-foreground/50 mt-1">This reason may be communicated to the applicant.</p>
                  </div>
                </div>

                <div className="p-6 border-t border-border flex justify-end space-x-3 bg-white/5 rounded-b-xl">
                  <button
                    onClick={() => { setRejectModalOpen(false); setRejectingUser(null); }}
                    className="px-4 py-2 text-sm font-bold uppercase tracking-wide text-foreground/60 hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRejectSubmit}
                    className="px-4 py-2 bg-red-600 text-white text-sm font-bold uppercase tracking-wide hover:bg-red-700 rounded transition-colors"
                  >
                    Reject Request
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
