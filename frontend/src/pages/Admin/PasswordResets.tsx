import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../services/api';
import { KeyRound, Link2, X, Copy, Check, ShieldAlert, AlertTriangle } from 'lucide-react';
import { useLoader } from '../../components/ui/FullScreenLoader';
import { useSocket } from '../../contexts/SocketContext';
import { formatDate, formatTime } from '../../utils/datetime';

interface ResetRequest {
  _id: string;
  name: string;
  email: string;
  role: string;
  accountModel: 'Admin' | 'User';
  requestedAt: string;
}

interface IssuedLink {
  resetUrl: string;
  expiresInMinutes: number;
  account: { name: string; email: string };
}

/**
 * Super Admin queue for password reset requests.
 *
 * This app does not email reset links, so a human authorises each reset: the
 * Super Admin issues a one-time link here and passes it to the person out of
 * band. The link is shown exactly once — only its hash is stored server-side.
 */
const PasswordResets = () => {
  const [requests, setRequests] = useState<ResetRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissing, setDismissing] = useState<ResetRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { showLoader, showSuccess, showError } = useLoader();
  const { socket } = useSocket();

  const fetchRequests = async () => {
    try {
      const res = await api.get('/admin/password-reset-requests');
      setRequests(res.data);
    } catch (error) {
      console.error('Failed to fetch password reset requests', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  // Keep the queue live so a new request appears without a refresh.
  useEffect(() => {
    if (!socket) return;
    const handler = () => fetchRequests();
    socket.on('PASSWORD_RESET_REQUESTS_CHANGED', handler);
    return () => {
      socket.off('PASSWORD_RESET_REQUESTS_CHANGED', handler);
    };
  }, [socket]);

  const handleIssue = async (request: ResetRequest) => {
    setBusyId(request._id);
    try {
      const res = await api.post(`/admin/password-reset-requests/${request._id}/issue-link`);
      setIssued(res.data);
      setCopied(false);
      setRequests((prev) => prev.filter((r) => r._id !== request._id));
    } catch (error: any) {
      await showError(error?.response?.data?.error || 'Failed to generate reset link');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDismiss = async () => {
    if (!dismissing) return;
    const target = dismissing;
    setDismissing(null);
    showLoader('Dismissing request...');
    try {
      await api.post(`/admin/password-reset-requests/${target._id}/dismiss`);
      setRequests((prev) => prev.filter((r) => r._id !== target._id));
      await showSuccess('Request dismissed');
    } catch (error: any) {
      await showError(error?.response?.data?.error || 'Failed to dismiss request');
    }
  };

  const copyLink = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.resetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard can be blocked; the link stays selectable on screen.
      setCopied(false);
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
          <h1 className="text-2xl font-bold">Password Resets</h1>
          <p className="text-foreground/60">
            Issue one-time reset links to users who cannot sign in
          </p>
        </div>
        <div className="p-3 bg-accent/20 rounded-full">
          <KeyRound className="w-6 h-6 text-accent" />
        </div>
      </div>

      <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-xl px-5 py-4">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <p className="text-sm">
          Links are shown <strong>once</strong> and are never stored in readable form. Send the link
          to the person directly, and only after you are satisfied the request is genuine.
        </p>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden">
        {requests.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-foreground/50">
            <ShieldAlert className="w-12 h-12 mb-4 opacity-50" />
            <p className="font-medium">No pending password reset requests.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-[10px] font-bold uppercase tracking-widest bg-white/5 border-b border-white/10 text-foreground/60">
                <tr>
                  <th className="px-6 py-4">User</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4">Requested</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {requests.map((request) => (
                  <tr key={request._id} className="hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-bold text-foreground">{request.name}</div>
                      <div className="text-xs text-foreground/60">{request.email}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-accent/20 text-accent rounded-sm">
                        {request.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs whitespace-nowrap">
                      <div className="font-medium text-foreground">{formatDate(request.requestedAt)}</div>
                      <div className="text-foreground/60 mt-0.5">{formatTime(request.requestedAt)}</div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleIssue(request)}
                          disabled={busyId === request._id}
                          className="inline-flex items-center px-3 py-1.5 bg-accent/10 text-accent hover:bg-accent/20 font-bold uppercase tracking-wide text-[10px] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Link2 className="w-3.5 h-3.5 mr-1.5" />
                          {busyId === request._id ? 'Generating…' : 'Generate Link'}
                        </button>
                        <button
                          onClick={() => setDismissing(request)}
                          disabled={busyId === request._id}
                          className="inline-flex items-center px-3 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 font-bold uppercase tracking-wide text-[10px] rounded transition-colors disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5 mr-1.5" /> Dismiss
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

      {/* Issued link — shown once */}
      {issued && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-xl animate-scale-in">
                <div className="p-6 border-b border-border">
                  <h2 className="text-xl font-bold uppercase tracking-wide text-foreground flex items-center">
                    <Link2 className="w-5 h-5 mr-2 text-accent" /> Reset link ready
                  </h2>
                  <p className="text-sm text-foreground/60 mt-1">
                    For <span className="text-accent font-bold">{issued.account.name}</span> ({issued.account.email})
                  </p>
                </div>

                <div className="p-6 space-y-4">
                  <div className="rounded-lg border border-border bg-background/50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-foreground/50 mb-2">
                      One-time link
                    </p>
                    <p className="text-xs font-mono break-all text-foreground select-all">{issued.resetUrl}</p>
                  </div>

                  <button
                    onClick={copyLink}
                    className="w-full inline-flex items-center justify-center px-4 py-2.5 bg-accent text-accent-foreground rounded-lg font-bold text-sm hover:opacity-90 transition-all"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4 mr-2" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4 mr-2" /> Copy link
                      </>
                    )}
                  </button>

                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                    <p className="text-xs text-amber-400">
                      Expires in <strong>{issued.expiresInMinutes} minutes</strong> and works only once.
                      This is the only time it will be shown — if you lose it, generate a new one.
                    </p>
                  </div>
                </div>

                <div className="p-6 border-t border-border flex justify-end bg-white/5 rounded-b-xl">
                  <button
                    onClick={() => setIssued(null)}
                    className="px-4 py-2 bg-foreground/5 hover:bg-foreground/10 text-foreground text-sm font-bold uppercase tracking-wide rounded transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {/* Dismiss confirmation */}
      {dismissing && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full animate-spring-up">
                <h3 className="text-xl font-bold mb-3 text-foreground flex items-center">
                  <ShieldAlert className="w-5 h-5 mr-2 text-red-500" /> Dismiss request?
                </h3>
                <p className="text-foreground/70 mb-8 leading-relaxed text-sm">
                  No reset link will be issued to{' '}
                  <span className="font-bold text-foreground">{dismissing.name}</span>. They can request
                  another reset at any time.
                </p>
                <div className="flex gap-3 justify-end">
                  <button
                    onClick={() => setDismissing(null)}
                    className="px-5 py-2.5 rounded-lg bg-foreground/5 hover:bg-foreground/10 text-foreground font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDismiss}
                    className="px-5 py-2.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors"
                  >
                    Dismiss
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

export default PasswordResets;
