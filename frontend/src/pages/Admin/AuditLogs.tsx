import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion } from 'framer-motion';
import api from '../../services/api';
import { Search, Eye, Shield, Activity, Server, FileText } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';
import { PaginationControls } from '../../components/ui/PaginationControls';

interface AuditLog {
  _id: string;
  timestamp: string;
  action: string;
  collectionName: string;
  documentId: string;
  bulkOperationId: string;
  requestId: string;
  description: string;
  success: boolean;
  actor: {
    name: string;
    email: string;
    role: string;
  };
  bulk: {
    isBulk: boolean;
    operationType?: string;
    totalRecords: number;
    successfulRecords: number;
    failedRecords: number;
  };
  changes: {
    before: any;
    after: any;
    changedFields: string[];
  };
}

export const AuditLogs = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<any>(null);

  // Filters
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [actionFilter, setActionFilter] = useState('');
  const [collectionFilter, setCollectionFilter] = useState('');
  const [search, setSearch] = useState('');

  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [currentPage, rowsPerPage, actionFilter, collectionFilter, search]);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [actionFilter, collectionFilter, search, rowsPerPage]);

  const fetchStats = async () => {
    try {
      const res = await api.get('/audit/statistics');
      setStats(res.data);
    } catch (error) {
      console.error('Failed to fetch stats', error);
    }
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: rowsPerPage.toString(),
      });
      if (actionFilter) params.append('action', actionFilter);
      if (collectionFilter) params.append('collectionName', collectionFilter);
      if (search) params.append('search', search);

      const res = await api.get(`/audit?${params.toString()}`);
      setLogs(res.data.logs);
      // Use totalCount if provided, else derive from totalPages * limit
      const pagination = res.data.pagination;
      setTotalItems(
        pagination.totalCount ??
        pagination.total ??
        (pagination.totalPages * rowsPerPage)
      );
    } catch (error) {
      console.error('Failed to fetch logs', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center animate-fade-in">
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider flex items-center gap-3">
          <Shield className="h-7 w-7 text-accent" />
          Audit Logs
        </h2>
      </div>

      {/* Stats Cards */}
      {stats && (
        <motion.div
          className="grid grid-cols-1 md:grid-cols-4 gap-4"
          initial="hidden"
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
        >
          {[
            { label: 'Total Events', value: stats.totalEvents, icon: Activity, color: 'text-blue-500', bg: 'bg-blue-500/10' },
            { label: "Today's Events", value: stats.todayEvents, icon: Activity, color: 'text-green-500', bg: 'bg-green-500/10' },
            { label: 'Bulk Operations', value: stats.bulkOperations, icon: Server, color: 'text-purple-500', bg: 'bg-purple-500/10' },
            { label: 'Failed Actions', value: stats.failedOperations, icon: FileText, color: 'text-rose-500', bg: 'bg-rose-500/10' },
          ].map((stat, idx) => (
            <motion.div
              key={idx}
              variants={{
                hidden: { opacity: 0, y: 16 },
                visible: { opacity: 1, y: 0, transition: { duration: 0.28, ease: 'easeOut' } },
              }}
              className="glass-panel rounded-2xl p-5 flex items-center gap-4 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div className={`w-11 h-11 rounded-full flex items-center justify-center ${stat.bg} ${stat.color}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground/60">{stat.label}</p>
                <p className="text-2xl font-bold text-foreground">{stat.value?.toLocaleString()}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* Logs Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border-b border-border gap-3">
          <h2 className="text-lg font-semibold text-foreground">System Activity</h2>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/40" />
              <Input
                placeholder="Search description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 w-56"
              />
            </div>
            <select
              className="rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-white/20 transition-all"
              value={collectionFilter}
              onChange={(e) => setCollectionFilter(e.target.value)}
            >
              <option value="">All Collections</option>
              <option value="users">Users</option>
              <option value="admins">Admins</option>
              <option value="contacts">Contacts</option>
              <option value="campaigns">Campaigns</option>
              <option value="events">Events</option>
              <option value="messagelogs">MessageLogs</option>
              <option value="settings">Settings</option>
            </select>
            <select
              className="rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-white/20 transition-all"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
            >
              <option value="">All Actions</option>
              <option value="LOGIN_SUCCESS">Login Success</option>
              <option value="BULK_CONTACT_IMPORTED">Bulk Import Contacts</option>
              <option value="BULK_MESSAGE_COMPLETED">Bulk Message Sent</option>
              <option value="CONTACT_CREATED">Create Contact</option>
              <option value="CONTACT_UPDATED">Update Contact</option>
              <option value="CONTACT_DELETED">Delete Contact</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surfaceHover text-foreground/60 font-medium border-b border-border uppercase tracking-wide text-xs">
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Collection</th>
                <th className="py-3 px-4">Description</th>
                <th className="py-3 px-4 text-right">Details</th>
              </tr>
            </thead>
            {loading ? (
              <tbody>
                <tr>
                  <td colSpan={6} className="py-12 text-center text-foreground/50">
                    <div className="flex items-center justify-center gap-2">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent" />
                      Loading audit logs...
                    </div>
                  </td>
                </tr>
              </tbody>
            ) : logs.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={6} className="py-12 text-center text-foreground/50">
                    No audit logs found.
                  </td>
                </tr>
              </tbody>
            ) : (
              <motion.tbody
                className="divide-y divide-border"
                initial="hidden"
                animate="visible"
                variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
              >
                {logs.map((log) => (
                  <motion.tr
                    key={log._id}
                    variants={{
                      hidden: { opacity: 0, y: 10 },
                      visible: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
                    }}
                    className="hover:bg-surfaceHover transition-colors"
                  >
                    <td className="py-3 px-4 text-sm text-foreground/60 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-sm text-foreground">{log.actor?.name || 'System'}</div>
                      <div className="text-xs text-foreground/50">{log.actor?.email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={log.success ? 'success' : 'error'}>
                        {log.action}
                      </Badge>
                      {log.bulk?.isBulk && (
                        <div className="mt-1 text-xs text-accent font-medium">BULK</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm text-foreground/70">{log.collectionName}</td>
                    <td className="py-3 px-4 text-sm text-foreground/70 max-w-xs truncate">
                      {log.description}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="flex items-center gap-1 ml-auto text-accent hover:text-accent/80 text-sm transition-colors"
                      >
                        <Eye className="h-4 w-4" /> View
                      </button>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            )}
          </table>
        </div>

        {/* Pagination — same component as Guests tab */}
        <PaginationControls
          currentPage={currentPage}
          rowsPerPage={rowsPerPage}
          totalItems={totalItems}
          onPageChange={setCurrentPage}
          onRowsChange={setRowsPerPage}
        />
      </div>

      {/* Detail Modal */}
      {selectedLog && ReactDOM.createPortal(
        <div className="fixed top-0 left-0 w-screen h-screen bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-surface border border-border rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto animate-spring-up">
            <div className="p-6 border-b border-border flex justify-between items-center sticky top-0 bg-surface z-10">
              <h2 className="text-lg font-bold text-foreground uppercase tracking-wider">Audit Log Details</h2>
              <button
                onClick={() => setSelectedLog(null)}
                className="text-foreground/50 hover:text-foreground transition-colors text-xl leading-none"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Action</h3>
                  <Badge variant={selectedLog.success ? 'success' : 'error'}>
                    {selectedLog.action}
                  </Badge>
                </div>
                <div>
                  <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Timestamp</h3>
                  <p className="text-sm text-foreground">{new Date(selectedLog.timestamp).toLocaleString()}</p>
                </div>
                <div>
                  <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Actor</h3>
                  <p className="text-sm text-foreground">{selectedLog.actor?.name || 'System'}</p>
                  <p className="text-xs text-foreground/50">{selectedLog.actor?.email} ({selectedLog.actor?.role})</p>
                </div>
                <div>
                  <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Collection / Document</h3>
                  <p className="text-sm text-foreground">{selectedLog.collectionName}</p>
                  <p className="text-xs text-foreground/50">{selectedLog.documentId || 'N/A'}</p>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Description</h3>
                <p className="text-sm text-foreground p-3 bg-surfaceHover rounded-lg border border-border">
                  {selectedLog.description}
                </p>
              </div>

              {selectedLog.bulk?.isBulk && (
                <div>
                  <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Bulk Operation Data</h3>
                  <div className="bg-accent/5 border border-accent/20 p-4 rounded-lg text-sm grid grid-cols-2 gap-2">
                    <div><span className="font-medium text-foreground/70">Operation ID:</span> <span className="text-foreground">{selectedLog.bulkOperationId}</span></div>
                    <div><span className="font-medium text-foreground/70">Type:</span> <span className="text-foreground">{selectedLog.bulk.operationType}</span></div>
                    <div><span className="font-medium text-foreground/70">Total Records:</span> <span className="text-foreground">{selectedLog.bulk.totalRecords}</span></div>
                    <div><span className="font-medium text-foreground/70">Successful:</span> <span className="text-success">{selectedLog.bulk.successfulRecords}</span></div>
                    <div><span className="font-medium text-foreground/70">Failed:</span> <span className="text-destructive">{selectedLog.bulk.failedRecords}</span></div>
                  </div>
                </div>
              )}

              {selectedLog.changes?.changedFields?.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-foreground/50 uppercase tracking-wider mb-2">Changed Fields</h3>
                  <div className="border border-border rounded-lg overflow-hidden">
                    <table className="w-full text-sm text-left">
                      <thead>
                        <tr className="bg-surfaceHover text-foreground/60 text-xs uppercase tracking-wider">
                          <th className="px-4 py-2">Field</th>
                          <th className="px-4 py-2">Before</th>
                          <th className="px-4 py-2">After</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {selectedLog.changes.changedFields.map(field => (
                          <tr key={field}>
                            <td className="px-4 py-2 font-medium text-foreground">{field}</td>
                            <td className="px-4 py-2 text-rose-500 bg-rose-500/5 break-all">{JSON.stringify(selectedLog.changes.before?.[field] ?? 'null')}</td>
                            <td className="px-4 py-2 text-emerald-500 bg-emerald-500/5 break-all">{JSON.stringify(selectedLog.changes.after?.[field] ?? 'null')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-border flex justify-end">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-5 py-2 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-surfaceHover transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default AuditLogs;
