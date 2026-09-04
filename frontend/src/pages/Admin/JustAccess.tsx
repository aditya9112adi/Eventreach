import React, { useEffect, useState } from 'react';
import type { User } from '@eventreach/shared';
import api from '../../services/api';
import { Loader2, ShieldAlert, Trash2, Clock, CalendarDays, Key } from 'lucide-react';
import { useLoader } from '../../components/ui/FullScreenLoader';

const JustAccess = () => {
  const [records, setRecords] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [userToRemove, setUserToRemove] = useState<{ id: string, type: string } | null>(null);
  const [, setTick] = useState(0);
  const { showLoader, showSuccess, showError, hideLoader } = useLoader();

  const fetchAccessRecords = async () => {
    try {
      const response = await api.get('/admin/users/access-records');
      setRecords(response.data);
    } catch (error) {
      console.error('Failed to fetch access records:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccessRecords();
  }, []);

  // Re-render every 30s so status badges and remaining time update live
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRevokeAccess = (id: string, type: string) => {
    setUserToRemove({ id, type });
  };

  const confirmRevokeAccess = async () => {
    if (!userToRemove) return;
    const { id, type } = userToRemove;
    setUserToRemove(null);
    
    showLoader('Revoking access...');
    try {
      await api.put(`/admin/users/${id}/revoke-access?type=${type}`);
      setRecords(records.map((r: any) => 
        (r._id === id || r.id === id) ? { ...r, isAccessCancelled: true } : r
      ));
      await showSuccess('Access revoked successfully');
    } catch (error) {
      console.error('Failed to revoke access', error);
      await showError('Failed to revoke access');
    }
  };

  const getStatus = (record: any) => {
    if (record.isAccessCancelled) return 'Cancelled';
    const now = new Date();
    if (record.accessStartDate && now < new Date(record.accessStartDate)) return 'Scheduled';
    if (record.accessExpiryDate && now > new Date(record.accessExpiryDate)) return 'Expired';
    return 'Active';
  };

  const getTimeRemaining = (record: any) => {
    const status = getStatus(record);
    if (status === 'Cancelled' || status === 'Expired') return '0m';
    
    const now = new Date();
    const expiry = new Date(record.accessExpiryDate);
    const diffTime = Math.max(0, expiry.getTime() - now.getTime());
    
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMins = Math.floor((diffTime % (1000 * 60 * 60)) / (1000 * 60));
    
    if (diffDays > 0) return `${diffDays}d ${diffHours}h`;
    if (diffHours > 0) return `${diffHours}h ${diffMins}m`;
    return `${diffMins}m`;
  };

  const isEndingSoon = (record: any) => {
    if (getStatus(record) !== 'Active') return false;
    const now = new Date();
    const expiry = new Date(record.accessExpiryDate);
    const diffTime = expiry.getTime() - now.getTime();
    // Ending soon if < 24 hours
    return diffTime > 0 && diffTime < 1000 * 60 * 60 * 24;
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  const StatusBadge = ({ status }: { status: string }) => {
    switch (status) {
      case 'Active':
        return <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-500 rounded-sm">Active</span>;
      case 'Scheduled':
        return <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-500 rounded-sm">Scheduled</span>;
      case 'Expired':
        return <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-foreground/10 text-foreground/50 rounded-sm">Expired</span>;
      case 'Cancelled':
        return <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-red-500/20 text-red-500 rounded-sm">Cancelled</span>;
      default:
        return null;
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
    <div className="space-y-6 animate-fade-in">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Just Access</h1>
          <p className="text-foreground/60">Monitor and manage time-bound system access</p>
        </div>
        <div className="p-3 bg-accent/20 rounded-full">
          <Key className="w-6 h-6 text-accent" />
        </div>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden">
        {records.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-foreground/50">
            <ShieldAlert className="w-12 h-12 mb-4 opacity-50" />
            <p className="font-medium">No access records found.</p>
            <p className="text-sm mt-1">Users approved via the Approvals tab will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-[10px] font-bold uppercase tracking-widest bg-white/5 border-b border-white/10 text-foreground/60">
                <tr>
                  <th className="px-6 py-4">User</th>
                  <th className="px-6 py-4">Granted On</th>
                  <th className="px-6 py-4">Access Period</th>
                  <th className="px-6 py-4 text-center">Duration</th>
                  <th className="px-6 py-4 text-center">Remaining</th>
                  <th className="px-6 py-4 text-center">Status</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {records.map((record: any) => {
                  const status = getStatus(record);
                  return (
                    <tr key={record._id} className="hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-bold text-foreground">{record.name}</div>
                        <div className="text-xs text-foreground/60">{record.email}</div>
                        <div className="text-[10px] uppercase font-bold text-accent mt-1">{record.role}</div>
                      </td>
                      <td className="px-6 py-4 text-foreground/80 text-xs">
                        {formatDate(record.accessGrantedOn || record.createdAt)}
                      </td>
                      <td className="px-6 py-4 text-xs text-foreground/80 space-y-1">
                        <div className="flex items-center">
                          <CalendarDays className="w-3 h-3 mr-1.5 opacity-50" />
                          <span className="opacity-70 mr-1">Start:</span> {formatDate(record.accessStartDate)}
                        </div>
                        <div className="flex items-center">
                          <Clock className="w-3 h-3 mr-1.5 opacity-50" />
                          <span className="opacity-70 mr-1">End:</span> {formatDate(record.accessExpiryDate)}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center font-medium">
                        {record.accessDurationValue 
                          ? `${record.accessDurationValue} ${record.accessDurationUnit ? record.accessDurationUnit.charAt(0).toUpperCase() + record.accessDurationUnit.slice(1) : 'Days'}` 
                          : 'N/A'}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`font-bold ${isEndingSoon(record) ? 'text-red-400' : 'text-foreground'}`}>
                          {getTimeRemaining(record)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-6 py-4 text-right">
                        {status === 'Active' || status === 'Scheduled' ? (
                          <button
                            onClick={() => handleRevokeAccess(record._id, record.type)}
                            className="inline-flex items-center px-3 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 font-bold uppercase tracking-wide text-[10px] rounded transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Remove Access
                          </button>
                        ) : (
                          <span className="text-xs text-foreground/40 italic">No actions available</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {userToRemove && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-spring-up">
            <h3 className="text-xl font-bold mb-3 text-foreground flex items-center">
              <ShieldAlert className="w-5 h-5 mr-2 text-red-500" /> Remove Admin Access?
            </h3>
            <p className="text-foreground/70 mb-8 leading-relaxed">
              Are you sure you want to permanently revoke access for this Admin? They will immediately be logged out and lose access to restricted features.
            </p>
            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setUserToRemove(null)} 
                className="px-5 py-2.5 rounded-lg bg-foreground/5 hover:bg-foreground/10 text-foreground font-medium transition-colors"
              >
                No, Cancel
              </button>
              <button 
                onClick={confirmRevokeAccess} 
                className="px-5 py-2.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 shadow-lg shadow-red-500/20 transition-colors flex items-center"
              >
                <Trash2 className="w-4 h-4 mr-2" /> Yes, Remove Access
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default JustAccess;
