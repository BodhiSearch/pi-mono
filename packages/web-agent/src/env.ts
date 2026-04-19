// Environment variables with build-time validation

const AUTH_CLIENT_ID = import.meta.env.VITE_BODHI_APP_CLIENT_ID;
const AUTH_SERVER_URL = import.meta.env.VITE_BODHI_AUTH_SERVER_URL || undefined;

if (!AUTH_CLIENT_ID) {
  throw new Error(
    'VITE_BODHI_APP_CLIENT_ID environment variable is required. ' +
      'Register your app on https://developer.getbodhi.app to receive app client id, ' +
      'and set it by copying .env.example to .env and updating VITE_BODHI_APP_CLIENT_ID value'
  );
}

export { AUTH_CLIENT_ID, AUTH_SERVER_URL };
