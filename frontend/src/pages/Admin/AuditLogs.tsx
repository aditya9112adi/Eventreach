import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import { Search, Eye, Filter, Server, Shield, Activity, Users, FileText } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';

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
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [collectionFilter, setCollectionFilter] = useState('');
  const [search, setSearch] = useState('');
  
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [page, actionFilter, collectionFilter, search]);

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
        page: page.toString(),
        limit: '50',
      });
      if (actionFilter) params.append('action', actionFilter);
      if (collectionFilter) params.append('collectionName', collectionFilter);
      if (search) params.append('search', search);

      const res = await api.get(`/audit?${params.toString()}`);
      setLogs(res.data.logs);
      setTotalPages(res.data.pagination.totalPages);
    } catch (error) {
      console.error('Failed to fetch logs', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Shield className="h-6 w-6 text-indigo-600" />
          Audit Logs
        </h1>
      </div>

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center gap-4">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Activity className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Total Events</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.totalEvents.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <Activity className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Today's Events</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.todayEvents.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center gap-4">
            <div className="p-3 bg-purple-100 rounded-lg">
              <Server className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Bulk Operations</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.bulkOperations.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center gap-4">
            <div className="p-3 bg-red-100 rounded-lg">
              <FileText className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Failed Actions</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.failedOperations.toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="flex flex-row items-center justify-between p-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">System Activity</h2>
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 w-64"
              />
            </div>
            <select
              className="border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-gray-900"
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
              className="border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-gray-900"
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 text-gray-700 uppercase">
              <tr>
                <th className="px-6 py-3">Timestamp</th>
                <th className="px-6 py-3">User</th>
                <th className="px-6 py-3">Action</th>
                <th className="px-6 py-3">Collection</th>
                <th className="px-6 py-3">Description</th>
                <th className="px-6 py-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                    Loading audit logs...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                    No audit logs found.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log._id} className="border-b hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-medium text-gray-900">{log.actor?.name || 'System'}</div>
                      <div className="text-xs text-gray-500">{log.actor?.email}</div>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={log.success ? 'success' : 'error'}>
                        {log.action}
                      </Badge>
                      {log.bulk?.isBulk && (
                        <div className="mt-1 text-xs text-indigo-600 font-medium">BULK</div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-gray-600">{log.collectionName}</td>
                    <td className="px-6 py-4 text-gray-600 max-w-xs truncate">
                      {log.description}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="text-indigo-600 hover:text-indigo-900 flex items-center gap-1 justify-end w-full"
                      >
                        <Eye className="h-4 w-4" /> View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        {/* Pagination */}
        <div className="p-4 border-t flex justify-between items-center">
          <span className="text-sm text-gray-500">
            Page {page} of {totalPages}
          </span>
          <div className="space-x-2">
            <button 
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1 border rounded disabled:opacity-50 bg-white text-gray-700"
            >
              Previous
            </button>
            <button 
              disabled={page === totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1 border rounded disabled:opacity-50 bg-white text-gray-700"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedLog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center sticky top-0 bg-white">
              <h2 className="text-lg font-semibold text-gray-900">Audit Log Details</h2>
              <button 
                onClick={() => setSelectedLog(null)}
                className="text-gray-400 hover:text-gray-500"
              >
                ~O
              </button>
            </div>
            
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">Action</h3>
                  <Badge variant={selectedLog.success ? 'success' : 'error'}>
                    {selectedLog.action}
                  </Badge>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">Timestamp</h3>
                  <p className="text-sm text-gray-900">{new Date(selectedLog.timestamp).toLocaleString()}</p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">Actor</h3>
                  <p className="text-sm text-gray-900">{selectedLog.actor?.name || 'System'}</p>
                  <p className="text-xs text-gray-500">{selectedLog.actor?.email} ({selectedLog.actor?.role})</p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">Collection / Document</h3>
                  <p className="text-sm text-gray-900">{selectedLog.collectionName}</p>
                  <p className="text-xs text-gray-500">{selectedLog.documentId || 'N/A'}</p>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Description</h3>
                <p className="text-sm text-gray-900 p-3 bg-gray-50 rounded-md">
                  {selectedLog.description}
                </p>
              </div>

              {selectedLog.bulk?.isBulk && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Bulk Operation Data</h3>
                  <div className="bg-indigo-50 p-4 rounded-md text-sm grid grid-cols-2 gap-2">
                    <div><span className="font-medium">Operation ID:</span> {selectedLog.bulkOperationId}</div>
                    <div><span className="font-medium">Type:</span> {selectedLog.bulk.operationType}</div>
                    <div><span className="font-medium">Total Records:</span> {selectedLog.bulk.totalRecords}</div>
                    <div><span className="font-medium">Successful:</span> <span className="text-green-600">{selectedLog.bulk.successfulRecords}</span></div>
                    <div><span className="font-medium">Failed:</span> <span className="text-red-600">{selectedLog.bulk.failedRecords}</span></div>
                  </div>
                </div>
              )}

              {selectedLog.changes?.changedFields?.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Changed Fields</h3>
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2">Field</th>
                          <th className="px-4 py-2">Before</th>
                          <th className="px-4 py-2">After</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {selectedLog.changes.changedFields.map(field => (
                          <tr key={field}>
                            <td className="px-4 py-2 font-medium text-gray-700">{field}</td>
                            <td className="px-4 py-2 text-red-600 bg-red-50/50 break-all">{JSON.stringify(selectedLog.changes.before?.[field] ?? 'null')}</td>
                            <td className="px-4 py-2 text-green-600 bg-green-50/50 break-all">{JSON.stringify(selectedLog.changes.after?.[field] ?? 'null')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            
            <div className="p-6 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-2 bg-white border rounded-md text-sm font-medium hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuditLogs;
