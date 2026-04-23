/* Mini App runtime config.
 * Edit API_BASE to point to the VPS that runs src/app.js (the backend).
 * Must be HTTPS (Telegram Mini Apps refuse to load HTTP origins).
 *
 * For local dev leave it empty — fetch will use same-origin (/api/users/...).
 */
window.__APP_CONFIG__ = {
    API_BASE: 'https://valid-murmuring-enticing.ngrok-free.dev'
};
