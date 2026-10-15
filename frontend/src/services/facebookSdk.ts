/**
 * Loads Meta's JavaScript SDK once, on demand - only on the page that connects
 * a WhatsApp number, never globally. Initialised with the public app id and
 * Graph API version the server reports (GET /whatsapp-onboarding/config); no
 * secret is ever in the browser.
 *
 * SDK URL and FB.init options per Meta's JavaScript SDK documentation.
 */

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
let loading: Promise<any> | null = null;

export const loadFacebookSdk = (appId: string, version: string): Promise<any> => {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
    return Promise.resolve(window.FB);
  }
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      reject(new Error('Meta\'s sign-in could not be loaded. Check that nothing is blocking connect.facebook.net and try again.'));
    };
    document.body.appendChild(script);
  });
  return loading;
};
