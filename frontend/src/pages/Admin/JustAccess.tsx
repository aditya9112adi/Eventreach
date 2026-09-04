import React, { useEffect, useState, useMemo } from 'react';
import type { User, Event } from '@eventreach/shared';
import api from '../../services/api';
import { ShieldAlert, Trash2, Clock, CalendarDays, Key, Download, Search, Filter, Edit3, Calendar } from 'lucide-react';
import { useLoader } from '../../components/ui/FullScreenLoader';
import { useAuth } from '../../store/authStore';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const JustAccess = () => {
  const { user: currentAuthUser } = useAuth();
  const [records, setRecords] = useState<User[]>([]);
  const [allEvents, setAllEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [userToRemove, setUserToRemove] = useState<{ id: string, type: string } | null>(null);
  const [assigningUser, setAssigningUser] = useState<any | null>(null);
  const [selectedEventToAssign, setSelectedEventToAssign] = useState<string>('');
  const [, setTick] = useState(0);
  const { showLoader, showSuccess, showError } = useLoader();

  // Filters
  const [statusFilter, setStatusFilter] = useState('All');
  const [roleFilter, setRoleFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchAccessRecords = async () => {
    try {
      const [recordsRes, eventsRes] = await Promise.all([
        api.get('/admin/users/access-records'),
        api.get('/events'),
      ]);
      setRecords(recordsRes.data);
      setAllEvents(eventsRes.data);
    } catch (error) {
      console.error('Failed to fetch access records:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccessRecords();
  }, []);

  // Re-render every 10s so status badges and remaining time update live
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 10000);
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

  const openAssignModal = (userItem: any) => {
    setAssigningUser(userItem);
    setSelectedEventToAssign(userItem.assignedEventId || '');
  };

  const handleSaveAssignment = async () => {
    if (!assigningUser) return;
    showLoader('Updating event assignment...');
    try {
      const res = await api.put(`/admin/users/${assigningUser._id || assigningUser.id}/assign-event`, {
        eventId: selectedEventToAssign || null
      });

      setRecords(records.map((r: any) => {
        if ((r._id || r.id) === (assigningUser._id || assigningUser.id)) {
          return {
            ...r,
            assignedEventId: res.data.assignedEventId,
            assignedEventName: res.data.assignedEventName,
          };
        }
        return r;
      }));

      setAssigningUser(null);
      await showSuccess('Event assignment updated successfully');
    } catch (err: any) {
      console.error('Failed to assign event', err);
      await showError(err.response?.data?.error || 'Failed to assign event');
    }
  };

  const getStatus = (record: any) => {
    if (record.status === 'Rejected') return 'Rejected';
    if (record.isAccessCancelled) return 'Cancelled';
    const now = new Date();
    if (record.accessStartDate && now < new Date(record.accessStartDate)) return 'Scheduled';
    if (record.accessExpiryDate && now > new Date(record.accessExpiryDate)) return 'Expired';
    return 'Active';
  };

  const getTimeRemaining = (record: any) => {
    const status = getStatus(record);
    if (status === 'Cancelled' || status === 'Expired' || status === 'Rejected') return '—';
    
    if (!record.accessExpiryDate) return 'N/A';
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
    return diffTime > 0 && diffTime < 1000 * 60 * 60 * 24;
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  // Filtered records
  const filteredRecords = useMemo(() => {
    return records.filter((record: any) => {
      const status = getStatus(record);
      if (statusFilter !== 'All' && status !== statusFilter) return false;
      if (roleFilter !== 'All' && record.role !== roleFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = record.name?.toLowerCase().includes(q);
        const emailMatch = record.email?.toLowerCase().includes(q);
        const eventMatch = record.assignedEventName?.toLowerCase().includes(q);
        if (!nameMatch && !emailMatch && !eventMatch) return false;
      }
      return true;
    });
  }, [records, statusFilter, roleFilter, searchQuery]);

  // PDF Download
  const handleDownloadPDF = () => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(18);
    doc.text('Just Access - Access Records', 14, 22);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()} | Filters: Status=${statusFilter}, Role=${roleFilter}${searchQuery ? `, Search="${searchQuery}"` : ''}`, 14, 30);

    const tableData = filteredRecords.map((record: any) => [
      record.name || '',
      record.email || '',
      record.role || '',
      record.role === 'User' ? (record.assignedEventName || 'None') : 'All in Scope',
      formatDate(record.accessGrantedOn || record.createdAt),
      formatDate(record.accessStartDate),
      formatDate(record.accessExpiryDate),
      getStatus(record),
      getTimeRemaining(record),
    ]);

    autoTable(doc, {
      startY: 36,
      head: [['Name', 'Email', 'Role', 'Assigned Event', 'Granted On', 'Start', 'End', 'Status', 'Remaining']],
      body: tableData,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [41, 128, 185] },
    });

    doc.save('access-records.pdf');
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
      case 'Rejected':
        return <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-orange-500/20 text-orange-500 rounded-sm">Rejected</span>;
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
          <p className="text-foreground/60">Monitor and manage time-bound system access and event assignments</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleDownloadPDF}
            className="inline-flex items-center px-4 py-2 bg-accent/10 text-accent hover:bg-accent/20 font-bold uppercase tracking-wide text-[10px] rounded-lg transition-colors"
          >
            <Download className="w-4 h-4 mr-2" /> Download PDF
          </button>
          <div className="p-3 bg-accent/20 rounded-full">
            <Key className="w-6 h-6 text-accent" />
          </div>
        </div>
      </div>

      {/* Filters Row */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Status Filter */}
        <div className="flex flex-col">
          <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/50 mb-1">Select Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
          >
            <option value="All">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Scheduled">Scheduled</option>
            <option value="Expired">Expired</option>
            <option value="Cancelled">Cancelled</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>

        {/* Role Filter */}
        <div className="flex flex-col">
          <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/50 mb-1">Select Role</label>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
          >
            <option value="All">All Roles</option>
            <option value="Admin">Admin</option>
            <option value="User">User</option>
          </select>
        </div>

        {/* Name Search */}
        <div className="flex flex-col flex-1 min-w-[200px]">
          <label className="text-[10px] font-bold uppercase tracking-widest text-foreground/50 mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, email, or event..."
              className="w-full pl-10 pr-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
        </div>
      </div>

      {/* Showing count */}
      <p className="text-xs text-foreground/50">
        Showing <span className="font-bold text-foreground">{filteredRecords.length}</span> of {records.length} records
      </p>

      <div className="glass-panel rounded-xl overflow-hidden">
        {filteredRecords.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-foreground/50">
            <ShieldAlert className="w-12 h-12 mb-4 opacity-50" />
            <p className="font-medium">No records match your filters.</p>
            <p className="text-sm mt-1">Try adjusting your search or filter criteria.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-[10px] font-bold uppercase tracking-widest bg-white/5 border-b border-white/10 text-foreground/60">
                <tr>
                  <th className="px-6 py-4">User</th>
                  <th className="px-6 py-4">Assigned Event</th>
                  <th className="px-6 py-4">Granted On</th>
                  <th className="px-6 py-4">Access Period</th>
                  <th className="px-6 py-4 text-center">Duration</th>
                  <th className="px-6 py-4 text-center">Remaining</th>
                  <th className="px-6 py-4 text-center">Status</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredRecords.map((record: any) => {
                  const status = getStatus(record);
                  const isUserRole = record.role === 'User';
                  return (
                    <tr key={record._id} className="hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-bold text-foreground">{record.name}</div>
                        <div className="text-xs text-foreground/60">{record.email}</div>
                        <div className="text-[10px] uppercase font-bold text-accent mt-1">{record.role}</div>
                      </td>

                      {/* Assigned Event Column */}
                      <td className="px-6 py-4">
                        {isUserRole ? (
                          <div className="flex items-center gap-2">
                            <span className={`text-xs ${record.assignedEventName ? 'font-semibold text-accent' : 'text-foreground/40 italic'}`}>
                              {record.assignedEventName || 'No Event Assigned'}
                            </span>
                            {(currentAuthUser?.role === 'SuperAdmin' || currentAuthUser?.role === 'Admin') && (
                              <button
                                onClick={() => openAssignModal(record)}
                                className="p-1 hover:bg-white/10 rounded text-foreground/50 hover:text-foreground transition-colors"
                                title="Change Assigned Event"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-foreground/40 italic">All in Scope</span>
                        )}
                      </td>

                      <td className="px-6 py-4 text-foreground/80 text-xs">
                        {formatDate(record.accessGrantedOn || record.createdAt)}
                      </td>
                      <td className="px-6 py-4 text-xs text-foreground/80 space-y-1">
                        {status === 'Rejected' ? (
                          <span className="text-foreground/40 italic">N/A</span>
                        ) : (
                          <>
                            <div className="flex items-center">
                              <CalendarDays className="w-3 h-3 mr-1.5 opacity-50" />
                              <span className="opacity-70 mr-1">Start:</span> {formatDate(record.accessStartDate)}
                            </div>
                            <div className="flex items-center">
                              <Clock className="w-3 h-3 mr-1.5 opacity-50" />
                              <span className="opacity-70 mr-1">End:</span> {formatDate(record.accessExpiryDate)}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center font-medium">
                        {status === 'Rejected' ? '—' : (record.accessDurationValue 
                          ? `${record.accessDurationValue} ${record.accessDurationUnit ? record.accessDurationUnit.charAt(0).toUpperCase() + record.accessDurationUnit.slice(1) : 'Days'}` 
                          : 'N/A')}
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
                        <div className="flex items-center justify-end gap-2">
                          {isUserRole && (
                            <button
                              onClick={() => openAssignModal(record)}
                              className="inline-flex items-center px-2.5 py-1.5 bg-accent/10 text-accent hover:bg-accent/20 font-bold uppercase tracking-wide text-[10px] rounded transition-colors"
                            >
                              <Calendar className="w-3 h-3 mr-1" /> Assign Event
                            </button>
                          )}
                          {status === 'Active' || status === 'Scheduled' ? (
                            <button
                              onClick={() => handleRevokeAccess(record._id, record.type)}
                              className="inline-flex items-center px-3 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 font-bold uppercase tracking-wide text-[10px] rounded transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Remove Access
                            </button>
                          ) : (
                            !isUserRole && <span className="text-xs text-foreground/40 italic">No actions</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Remove Access Confirmation Modal */}
      {userToRemove && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-spring-up">
            <h3 className="text-xl font-bold mb-3 text-foreground flex items-center">
              <ShieldAlert className="w-5 h-5 mr-2 text-red-500" /> Remove Access?
            </h3>
            <p className="text-foreground/70 mb-8 leading-relaxed">
              Are you sure you want to permanently revoke access for this account? They will immediately be logged out and lose access to restricted features.
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

      {/* Assign Event Modal */}
      {assigningUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-spring-up">
            <h3 className="text-xl font-bold mb-2 text-foreground flex items-center">
              <Calendar className="w-5 h-5 mr-2 text-accent" /> Assign Event to User
            </h3>
            <p className="text-sm text-foreground/70 mb-5">
              Select the event that <span className="font-bold text-accent">{assigningUser.name}</span> ({assigningUser.email}) should have access to.
            </p>

            <div className="space-y-4 mb-6">
              <label className="text-xs font-bold uppercase tracking-wider text-foreground/60 block">
                Select Event
              </label>
              <select
                value={selectedEventToAssign}
                onChange={(e) => setSelectedEventToAssign(e.target.value)}
                className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
              >
                <option value="">None (Unassigned)</option>
                {allEvents.map((ev) => (
                  <option key={ev._id} value={ev._id}>
                    {ev.eventName} ({ev.eventType} - {ev.eventDate})
                  </option>
                ))}
              </select>
              <p className="text-xs text-foreground/50">
                The user will immediately gain real-time access to this event and lose access to any other event.
              </p>
            </div>

            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setAssigningUser(null)} 
                className="px-5 py-2.5 rounded-lg bg-foreground/5 hover:bg-foreground/10 text-foreground font-medium transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSaveAssignment} 
                className="px-5 py-2.5 rounded-lg bg-accent text-accent-foreground font-medium hover:opacity-90 shadow-lg shadow-accent/20 transition-all flex items-center"
              >
                Save Assignment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default JustAccess;
