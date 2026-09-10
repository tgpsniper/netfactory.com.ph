// ============================================================
// NETFACTORY — Local IP Detection & Audit Header Interceptor
// ============================================================
// Include this script in both the CRM and Customer Portal.
// It detects the client's local/private IP via WebRTC STUN
// and injects it as X-Local-IP header on every API request.
//
// Add to HTML: <script src="/js/audit-ip.js"></script>
// Must load BEFORE any fetch interceptor or API calls.
// ============================================================

(function() {
  'use strict';

  const STORAGE_KEY = 'j2_local_ip';
  let localIP = sessionStorage.getItem(STORAGE_KEY) || null;

  /**
   * Detect local IP via WebRTC STUN request.
   * Works in Chrome, Firefox, Edge. May not work in Safari/iOS.
   */
  async function detectLocalIP() {
    return new Promise((resolve) => {
      try {
        // Check if WebRTC is available
        const RTCPeerConnection = window.RTCPeerConnection ||
                                   window.webkitRTCPeerConnection ||
                                   window.mozRTCPeerConnection;

        if (!RTCPeerConnection) {
          console.log('[AUDIT-IP] WebRTC not available');
          resolve(null);
          return;
        }

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            pc.close();
            resolve(null);
          }
        }, 3000); // 3 second timeout

        pc.onicecandidate = (event) => {
          if (resolved) return;

          if (event.candidate && event.candidate.candidate) {
            const candidate = event.candidate.candidate;
            // Look for IPv4 private addresses
            const ipMatch = candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);

            if (ipMatch) {
              const ip = ipMatch[1];
              // Check if it's a private IP range
              if (ip.startsWith('10.') ||
                  ip.startsWith('192.168.') ||
                  ip.match(/^172\.(1[6-9]|2[0-9]|3[01])\./)) {
                resolved = true;
                clearTimeout(timeout);
                pc.close();
                resolve(ip);
                return;
              }
            }
          }

          // End of candidates
          if (!event.candidate && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            pc.close();
            resolve(null);
          }
        };

        // Create a data channel to trigger ICE gathering
        pc.createDataChannel('');
        pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .catch(() => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              pc.close();
              resolve(null);
            }
          });

      } catch (err) {
        console.log('[AUDIT-IP] Detection failed:', err.message);
        resolve(null);
      }
    });
  }

  /**
   * Initialize: detect IP and store it.
   */
  async function init() {
    if (!localIP) {
      localIP = await detectLocalIP();
      if (localIP) {
        sessionStorage.setItem(STORAGE_KEY, localIP);
        console.log('[AUDIT-IP] Local IP detected:', localIP);
      } else {
        console.log('[AUDIT-IP] Could not detect local IP');
      }
    }
  }

  /**
   * Patch the global fetch to inject X-Local-IP header.
   * This works alongside your existing CSRF interceptor.
   */
  const originalFetch = window.fetch;
  window.fetch = function(url, options = {}) {
    // Only add header to API calls
    const urlStr = typeof url === 'string' ? url : url.url || '';
    if (urlStr.includes('/api/')) {
      options.headers = options.headers || {};

      // If headers is a Headers object, convert to plain object
      if (options.headers instanceof Headers) {
        const plainHeaders = {};
        options.headers.forEach((value, key) => {
          plainHeaders[key] = value;
        });
        options.headers = plainHeaders;
      }

      // Inject local IP if available
      if (localIP) {
        options.headers['X-Local-IP'] = localIP;
      }
    }

    return originalFetch.call(this, url, options);
  };

  // Run detection on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for manual access if needed
  window.J2AuditIP = {
    getLocalIP: () => localIP,
    refresh: async () => {
      sessionStorage.removeItem(STORAGE_KEY);
      localIP = null;
      await init();
      return localIP;
    },
  };

})();
