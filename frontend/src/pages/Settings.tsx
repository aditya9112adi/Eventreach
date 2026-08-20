import { useState, useEffect } from 'react';
import { Save, Shield, Globe, Building2, Key, CheckCircle } from 'lucide-react';
import api from '../services/api';
import { Button } from '../components/ui/Button';

const Settings = () => {
  const [settings, setSettings] = useState<Record<string, string>>({
    whatsapp_token: '',
    whatsapp_phone_id: '',
    default_country_code: '',
    company_name: '',
    webhook_verify_token: ''
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await api.get('/settings');
        setSettings(prev => ({ ...prev, ...response.data }));
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

      {/* WhatsApp API Settings */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center mb-4">
          <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center mr-3">
            <Shield className="w-5 h-5 text-green-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">WhatsApp Business API</h3>
            <p className="text-sm text-slate-500">Connect to the official WhatsApp Cloud API</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Access Token</label>
            <input
              type="password"
              value={settings.whatsapp_token}
              onChange={(e) => handleChange('whatsapp_token', e.target.value)}
              placeholder="Enter your WhatsApp Cloud API access token"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-primary outline-none font-mono"
            />
            <p className="mt-1 text-xs text-slate-400">
              Get this from{' '}
              <a href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer" className="text-indigo-500 underline">
                Meta for Developers
              </a>
              {' '}→ Your App → WhatsApp → API Setup.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Phone Number ID</label>
            <input
              type="text"
              value={settings.whatsapp_phone_id}
              onChange={(e) => handleChange('whatsapp_phone_id', e.target.value)}
              placeholder="e.g. 123456789012345"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-primary outline-none font-mono"
            />
          </div>
        </div>
      </div>

      {/* Webhook Settings */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center mr-3">
            <Key className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Webhook (Optional)</h3>
            <p className="text-sm text-slate-500">For receiving delivery status callbacks</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Verify Token</label>
            <input
              type="text"
              value={settings.webhook_verify_token}
              onChange={(e) => handleChange('webhook_verify_token', e.target.value)}
              placeholder="A custom token for webhook verification"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-primary outline-none font-mono"
            />
          </div>
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
            <div className="flex items-start">
              <Globe className="w-5 h-5 text-slate-400 mr-2 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-slate-600 font-medium">Webhook URL</p>
                <p className="text-xs text-slate-400 mt-1 font-mono break-all">
                  {window.location.origin}/api/webhooks/whatsapp
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Configure this URL in your Meta App's WhatsApp webhook settings to receive delivery status updates.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
