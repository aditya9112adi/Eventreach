import { useState, useEffect } from 'react';
import { Save, Shield, Globe, Building2, Key, CheckCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { Button } from '../components/ui/Button';

/**
 * The server's WhatsApp connection, as GET /settings reports it: whether each
 * credential is present, never its value. Credentials live in the server
 * environment and are not edited on this page.
 */
interface WhatsAppConnectionStatus {
  mode: 'live' | 'simulated';
  configured: { accessToken: boolean; phoneNumberId: boolean; wabaId: boolean; appSecret: boolean; verifyToken: boolean };
  apiVersion: string;
  phoneNumberIdHint: string | null;
  wabaIdHint: string | null;
  legacyStoredSettings: string[];
}

const CONNECTION_ROWS: { key: keyof WhatsAppConnectionStatus['configured']; label: string }[] = [
  { key: 'accessToken', label: 'Access token' },
  { key: 'phoneNumberId', label: 'Sender Phone Number ID' },
  { key: 'wabaId', label: 'WhatsApp Business Account ID' },
  { key: 'appSecret', label: 'App secret (webhook signatures)' },
  { key: 'verifyToken', label: 'Webhook verify token' },
];

/** The webhook is served by the API, not by this site. */
const webhookUrl = (): string => {
  const base = String(api.defaults.baseURL || '');
  return /^https?:\/\//.test(base) ? `${base.replace(/\/$/, '')}/webhooks/whatsapp` : `${window.location.origin}/api/webhooks/whatsapp`;
};

const Settings = () => {
  const [settings, setSettings] = useState<Record<string, string>>({
    default_country_code: '',
    company_name: '',
  });
  const [connection, setConnection] = useState<WhatsAppConnectionStatus | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await api.get('/settings');
        const { whatsappConnection, ...editable } = response.data ?? {};
        setSettings(prev => ({ ...prev, ...editable }));
        setConnection(whatsappConnection ?? null);
      } catch (error) {
        console.error('Failed to fetch settings', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.put('/settings', settings);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (error) {
      console.error('Failed to save settings', error);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto animate-pulse">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <div className="h-5 bg-slate-200 rounded w-48 mb-4"></div>
            <div className="space-y-3">
              <div className="h-10 bg-slate-100 rounded"></div>
              <div className="h-10 bg-slate-100 rounded"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-slate-900">Settings</h2>
        <div className="flex items-center space-x-3">
          {showSuccess && (
            <span className="flex items-center text-sm text-green-600 font-medium animate-fade-in">
              <CheckCircle className="w-4 h-4 mr-1" /> Saved
            </span>
          )}
          <Button onClick={handleSave} isLoading={isSaving}>
            <Save className="w-4 h-4 mr-2" /> Save Settings
          </Button>
        </div>
      </div>

      {/* Company Settings */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center mb-4">
          <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center mr-3">
            <Building2 className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Company</h3>
            <p className="text-sm text-slate-500">Your organization details</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Company Name</label>
            <input
              type="text"
              value={settings.company_name}
              onChange={(e) => handleChange('company_name', e.target.value)}
              placeholder="e.g. Elite Events"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-primary outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Default Country Code</label>
            <input
              type="text"
              value={settings.default_country_code}
              onChange={(e) => handleChange('default_country_code', e.target.value)}
              placeholder="e.g. IN, US, UK"
              className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-primary outline-none"
            />
            <p className="mt-1 text-xs text-slate-400">Used as fallback when parsing phone numbers without a country prefix.</p>
          </div>
        </div>
      </div>

      {/* WhatsApp connection: read-only. Credentials are set in the server environment. */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center mb-4">
          <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center mr-3">
            <Shield className="w-5 h-5 text-green-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">WhatsApp Business API</h3>
            <p className="text-sm text-slate-500">
              Connection status. Credentials are configured on the server and are never shown or edited here.
            </p>
          </div>
        </div>
        {connection ? (
          <div className="space-y-4">
            <p className="text-sm">
              <span className="font-medium text-slate-700">Mode: </span>
              {connection.mode === 'live' ? (
                <span className="text-green-700 font-medium">Live</span>
              ) : (
                <span className="text-amber-700 font-medium">Simulated: messages are not really sent</span>
              )}
              <span className="text-slate-400"> · Graph API {connection.apiVersion}</span>
            </p>
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {CONNECTION_ROWS.map((row) => (
                <li key={row.key} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-700">{row.label}</span>
                  <span className={connection.configured[row.key] ? 'text-green-700' : 'text-red-600'}>
                    {connection.configured[row.key] ? 'Configured' : 'Not configured'}
                    {row.key === 'phoneNumberId' && connection.phoneNumberIdHint ? ` (${connection.phoneNumberIdHint})` : ''}
                    {row.key === 'wabaId' && connection.wabaIdHint ? ` (${connection.wabaIdHint})` : ''}
                  </span>
                </li>
              ))}
            </ul>
            {connection.legacyStoredSettings.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                Credentials entered on this page in the past are still stored in the database. They were never
                used to send messages. Ask the deployment administrator to remove them and rotate any token that
                was entered.
              </p>
            )}
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <div className="flex items-start">
                <Globe className="w-5 h-5 text-slate-400 mr-2 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-slate-600 font-medium">Webhook URL</p>
                  <p className="text-xs text-slate-400 mt-1 font-mono break-all">{webhookUrl()}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Configure this URL in your Meta App's WhatsApp webhook settings to receive delivery status updates.
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Connection status is unavailable.</p>
        )}
      </div>

      {/* Security — account password management for the signed-in Super Admin. */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center mb-4">
          <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center mr-3">
            <Shield className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Security</h3>
            <p className="text-sm text-slate-500">Manage your own sign-in credentials</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div>
              <p className="text-sm font-medium text-slate-700">Change Password</p>
              <p className="text-xs text-slate-500 mt-1">
                Requires your current password. All other signed-in sessions are signed out.
              </p>
            </div>
            <Link
              to="/change-password"
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
            >
              <Key className="w-4 h-4" /> Change Password
            </Link>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-700">Resetting someone else's password</p>
            <p className="text-xs text-slate-500 mt-1">
              A locked-out Admin or User is recovered from{' '}
              <Link to="/admin/just-access" className="font-semibold text-slate-700 underline">
                Just Access
              </Link>
              . This application does not send password emails, so verify who you are speaking to
              before resetting an account. Another Super Admin cannot be reset here.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
